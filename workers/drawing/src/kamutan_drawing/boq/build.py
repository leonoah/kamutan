"""``boq.build`` job: aggregate every current, ready electrical / lighting sheet version of a project into
``boqLines`` + an evidence file. Deterministic and idempotent (same inputs → same lines, same evidence bytes).

Inputs (all read by the orchestrator; artifacts are worker-made JSON, no parsing of user files here):
``sheets/*`` (current version, discipline / floors / scale — the user's when ``confirmed``), the version doc
(``status == ready``, ``regions``, ``artifacts.detections``, ``artifacts.links`` or ``links.json.gz`` next to
it), ``legendEntries`` (confirmed classes / item codes win, ignored entries drop), ``orgs/{o}/symbolMappings``
(class / itemCode / ``ignored``), ``boqRules`` (seeded with the defaults when empty), ``itemLibrary``.

Outputs:
* ``orgs/{o}/projects/{p}/boq/{buildId}/evidence.json.gz`` (``kamutan.boq-evidence/1``);
* ``boqLines/{lineId}`` upserted. Fields in :data:`PRESERVED` (status + review / approval stamps, qtyOverride +
  reason/by/at, note, locked) are never overwritten. A line whose computed qty differs from the qty it had when
  it was approved keeps its status but gets the chip ``הכמות השתנתה מאז האישור`` and level red (worker
  bookkeeping ``approvedQty`` / ``approvedQtyAt``; cleared on re-approval or when the qty returns).
  Obsolete worker lines (not produced by this build) are deleted only when ``draft`` without override and
  without note; otherwise they are kept with qty 0, red, ``הסעיף לא נמצא בבנייה האחרונה``. Lines the worker
  did not create (no ``computedAt``: manual lines) are never touched.
* ``boqBuilds/{buildId}`` ``queued → running → succeeded | failed`` (+ ``stats``, ``evidenceRef``) and the
  project doc ``boq {latestBuildId, builtAt, stale: false, pendingBuildId: null}``; ``jobs/{jobId}`` status.
"""

from __future__ import annotations

import gzip
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from .. import errors as E
from ..errors import IngestError
from ..pipeline.artifacts import version_prefix
from ..stores.base import SERVER_TIMESTAMP, BlobNotFound, BlobStore, DocStore
from .aggregate import Line, Result, SheetInput, aggregate
from .contracts import EVIDENCE_SCHEMA, BoqBuildJob, parse_links
from .rules import LABEL_RECLASS, R_OBSOLETE, R_QTY_CHANGED, Library, Rule, load_rules, seed_rules

log = logging.getLogger(__name__)

BUILD_DISCIPLINES = ("electrical", "lighting")
RECLASS_SOURCES = frozenset(r[0] for r in LABEL_RECLASS)
PRESERVED = (
    "status",
    "reviewedBy",
    "reviewedAt",
    "approvedBy",
    "approvedAt",
    "note",
    "qtyOverride",
    "qtyOverrideReason",
    "qtyOverrideBy",
    "qtyOverrideAt",
    "locked",
)
MAX_ATTEMPTS = 5


@dataclass
class Inputs:
    sheets: list[SheetInput]
    rules: list[Rule]
    library: Library
    entries: dict[str, dict[str, Any]]
    mappings: dict[str, dict[str, Any]]
    skipped_sheets: dict[str, str] = field(default_factory=dict)


@dataclass
class BuildOutcome:
    status: str  # succeeded | skipped
    result: Result | None = None
    stats: dict[str, Any] = field(default_factory=dict)
    evidence_ref: str | None = None
    lines: dict[str, dict[str, Any]] = field(default_factory=dict)


def _list(docs: DocStore, collection: str) -> list[tuple[str, dict[str, Any]]]:
    lister = getattr(docs, "list_docs", None)
    if lister is None:
        return []
    out: list[tuple[str, dict[str, Any]]] = lister(collection)
    return out


def _gz_json(blobs: BlobStore, path: str) -> Any | None:
    try:
        return json.loads(gzip.decompress(blobs.read(path)))
    except BlobNotFound:
        return None


def load_inputs(org_id: str, project_id: str, blobs: BlobStore, docs: DocStore, *, seed: bool = True) -> Inputs:
    proj = f"orgs/{org_id}/projects/{project_id}"
    if seed:
        seed_rules(docs, org_id)
    rules = load_rules(docs, org_id)
    library = Library.from_docs(_list(docs, f"orgs/{org_id}/itemLibrary"))
    entries = {eid: e for eid, e in _list(docs, f"{proj}/legendEntries") if isinstance(e, dict)}
    mappings = {sig: m for sig, m in _list(docs, f"orgs/{org_id}/symbolMappings") if isinstance(m, dict)}
    sheets: list[SheetInput] = []
    skipped: dict[str, str] = {}
    for sid, s in sorted(_list(docs, f"{proj}/sheets")):
        disc = s.get("discipline")
        if disc not in BUILD_DISCIPLINES:
            continue
        vid = s.get("currentVersionId")
        if not vid:
            skipped[sid] = "no_version"
            continue
        v = docs.get(f"{proj}/sheets/{sid}/versions/{vid}") or {}
        if v.get("status") != "ready":
            skipped[sid] = "not_ready"
            continue
        arts = v.get("artifacts") or {}
        pre = version_prefix(org_id, project_id, sid, str(vid))
        det_path = arts.get("detections") or pre + "detections.json.gz"
        if not str(det_path).startswith(pre):
            skipped[sid] = "foreign_artifact"
            continue
        det = _gz_json(blobs, str(det_path))
        if not isinstance(det, dict):
            skipped[sid] = "no_detections"
            continue
        links_path = arts.get("links") or pre + "links.json.gz"
        links_obj = _gz_json(blobs, str(links_path)) if str(links_path).startswith(pre) else None
        dets = [d for d in (det.get("detections") or []) if isinstance(d, dict)]
        texts: list[dict[str, Any]] = []
        if any(d.get("class") in RECLASS_SOURCES for d in dets):  # label rules need the sheet text
            tp = arts.get("text") or pre + "text.json.gz"
            tobj = _gz_json(blobs, str(tp)) if str(tp).startswith(pre) else None
            texts = [t for t in ((tobj or {}).get("lines") or []) if isinstance(t, dict)]
        rp = arts.get("rooms") or pre + "rooms.json.gz"
        robj = _gz_json(blobs, str(rp)) if str(rp).startswith(pre) else None
        rooms = {str(r.get("id")): str(r.get("name") or "") for r in ((robj or {}).get("rooms") or []) if isinstance(r, dict)}
        regions = [r for r in (v.get("regions") or []) if isinstance(r, dict)]
        floors = [str(f) for f in (s.get("floors") or [])] or sorted({str(r["floor"]) for r in regions if r.get("floor")})
        page = v.get("page") or {}
        scale = s.get("scaleDenominator")
        sheets.append(
            SheetInput(
                sid,
                str(vid),
                str(disc),
                int(scale) if isinstance(scale, int | float) and scale > 0 else None,
                floors,
                (
                    round(float(page.get("widthMm") or 0), 1),
                    round(float(page.get("heightMm") or 0), 1),
                    int(page.get("rotation") or 0),
                ),
                dets,
                parse_links(links_obj) if links_obj is not None else None,
                bool(s.get("confirmed")),
                regions,
                texts,
                rooms,
            )
        )
    return Inputs(sheets, rules, library, entries, mappings, skipped)


def evidence_path(org_id: str, project_id: str, build_id: str) -> str:
    return f"orgs/{org_id}/projects/{project_id}/boq/{build_id}/evidence.json.gz"


def evidence_bytes(lines: list[Line], build_id: str) -> bytes:
    obj = {"schema": EVIDENCE_SCHEMA, "buildId": build_id, "lines": {ln.id: ln.evidence for ln in lines}}
    return gzip.compress(json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode(), mtime=0)


def upsert_lines(
    docs: DocStore, proj: str, lines: list[Line], build_id: str, evidence_ref: str
) -> tuple[dict[str, dict[str, Any]], dict[str, int]]:
    """Write the computed lines, preserving human fields; handle obsolete lines. Returns (docs written, counts)."""
    coll = f"{proj}/boqLines"
    existing = {lid: d for lid, d in _list(docs, coll) if isinstance(d, dict)}
    written: dict[str, dict[str, Any]] = {}
    counts = {"created": 0, "updated": 0, "deleted": 0, "kept": 0, "qtyChanged": 0}
    for ln in lines:
        cur = existing.get(ln.id)
        computed = {**ln.computed_fields(), "evidenceRef": evidence_ref, "buildId": build_id, "computedAt": SERVER_TIMESTAMP}
        if cur is None:
            doc = {**computed, "status": "draft", "qtyOverride": None, "note": None, "updatedAt": SERVER_TIMESTAMP}
            counts["created"] += 1
        else:
            doc = {**cur, **computed, **{k: cur[k] for k in PRESERVED if k in cur}, "updatedAt": SERVER_TIMESTAMP}
            _approval_check(cur, doc)
            counts["updated"] += 1
            counts["qtyChanged"] += int(R_QTY_CHANGED in doc["reasons"])
        docs.set(f"{coll}/{ln.id}", doc, merge=False)
        written[ln.id] = doc
    computed_ids = {ln.id for ln in lines}
    for lid in sorted(set(existing) - computed_ids):
        cur = existing[lid]
        if not cur.get("computedAt"):
            continue  # manual line: not ours
        if (
            cur.get("status", "draft") == "draft"
            and cur.get("qtyOverride") is None
            and not cur.get("note")
            and not cur.get("locked")
        ):
            deleter = getattr(docs, "delete", None)
            if deleter is not None:
                deleter(f"{coll}/{lid}")
                counts["deleted"] += 1
                continue
        doc = {
            **cur,
            "qty": 0.0,
            "byFloor": {},
            "evidenceCount": 0,
            "sourceVersions": [],
            "level": "red",
            "reasons": [R_OBSOLETE],
            "evidenceRef": evidence_ref,
            "buildId": build_id,
            "computedAt": SERVER_TIMESTAMP,
            "updatedAt": SERVER_TIMESTAMP,
        }
        _approval_check(cur, doc)
        docs.set(f"{coll}/{lid}", doc, merge=False)
        written[lid] = doc
        counts["kept"] += 1
    return written, counts


def _approval_check(cur: dict[str, Any], doc: dict[str, Any]) -> None:
    """Approved line whose computed qty moved: keep the status, flag it red (documented in NOTES)."""
    if cur.get("status") != "approved":
        doc.pop("approvedQty", None)
        doc.pop("approvedQtyAt", None)
        return
    at = cur.get("approvedAt")
    base = cur.get("approvedQty") if ("approvedQty" in cur and cur.get("approvedQtyAt") == at) else cur.get("qty")
    doc["approvedQty"] = base
    doc["approvedQtyAt"] = at
    if base is not None and float(doc.get("qty") or 0.0) != float(base):
        doc["reasons"] = [R_QTY_CHANGED, *[r for r in doc.get("reasons") or [] if r != R_QTY_CHANGED]][:32]
        doc["level"] = "red"
    else:
        doc["reasons"] = [r for r in doc.get("reasons") or [] if r != R_QTY_CHANGED]


def build_project(org_id: str, project_id: str, build_id: str, blobs: BlobStore, docs: DocStore) -> BuildOutcome:
    """Aggregate + write evidence + upsert lines (no job/build bookkeeping). Used by the job and the local runner."""
    t0 = time.monotonic()
    proj = f"orgs/{org_id}/projects/{project_id}"
    inp = load_inputs(org_id, project_id, blobs, docs)
    res = aggregate(inp.sheets, inp.rules, inp.library, inp.entries, inp.mappings)
    ev_path = evidence_path(org_id, project_id, build_id)
    blobs.write(
        ev_path, evidence_bytes(res.lines, build_id), "application/gzip", cache_control="private, max-age=31536000, immutable"
    )
    written, counts = upsert_lines(docs, proj, res.lines, build_id, ev_path)
    stats = {
        "lines": len(res.lines),
        "green": sum(1 for d in written.values() if d.get("level") == "green"),
        "yellow": sum(1 for d in written.values() if d.get("level") == "yellow"),
        "red": sum(1 for d in written.values() if d.get("level") == "red"),
        "sheets": len(inp.sheets),
        "evidence": res.stats.get("evidence", 0),
        "duplicatesRemoved": res.stats.get("duplicatesRemoved", 0),
        "unmapped": res.stats.get("unmapped", 0),
        "unlinkedSwitches": res.stats.get("unlinkedSwitches", 0),
        "fallbackSheets": res.stats.get("fallbackSheets", []),
        "skippedSheets": inp.skipped_sheets,
        "writes": counts,
        "durationMs": int((time.monotonic() - t0) * 1000),
    }
    return BuildOutcome("succeeded", res, stats, ev_path, written)


def _stale_mark(docs: DocStore, project_path: str) -> Any:
    """``boq.staleAt`` of the project: a change marked by the API *during* the build keeps ``stale: true``."""
    boq = (docs.get(project_path) or {}).get("boq")
    return boq.get("staleAt") if isinstance(boq, dict) else None


def run_boq_build(job: BoqBuildJob, blobs: BlobStore, docs: DocStore) -> BuildOutcome:
    job_path = f"jobs/{job.jobId}"
    build_path = f"{job.project_path}/boqBuilds/{job.buildId}"
    jd = docs.get(job_path)
    if jd is None:
        raise IngestError(E.INVALID_PAYLOAD, "job document not found", retryable=False)
    if jd.get("orgId") != job.orgId or jd.get("projectId", job.projectId) != job.projectId:
        raise IngestError(E.INVALID_PAYLOAD, "job does not belong to this org/project", retryable=False)
    bd = docs.get(build_path)
    if bd is None:
        raise IngestError(E.INVALID_PAYLOAD, "build document not found", retryable=False)
    if bd.get("status") == "succeeded":
        docs.set(job_path, {"status": "succeeded", "progress": {"stage": "done", "pct": 100}, "updatedAt": SERVER_TIMESTAMP})
        return BuildOutcome("skipped", stats=dict(bd.get("stats") or {}), evidence_ref=bd.get("evidenceRef"))
    attempts = int(jd.get("attempts") or 0) + 1
    docs.set(
        job_path,
        {
            "status": "running",
            "attempts": attempts,
            "progress": {"stage": "boq", "pct": 10},
            "error": None,
            "updatedAt": SERVER_TIMESTAMP,
        },
    )
    docs.set(build_path, {"status": "running", "startedAt": SERVER_TIMESTAMP, "error": None})
    stale_mark = _stale_mark(docs, job.project_path)
    try:
        out = build_project(job.orgId, job.projectId, job.buildId, blobs, docs)
    except Exception as e:
        if isinstance(e, IngestError):
            err = e
        elif isinstance(e, BlobNotFound):
            err = IngestError(E.STORAGE_UNAVAILABLE, "artifact storage object vanished")
        else:
            log.exception("boq build %s crashed", job.buildId)
            err = IngestError(E.INTERNAL, f"internal error ({type(e).__name__})", retryable=True)
        if err.retryable and attempts >= MAX_ATTEMPTS:
            err = IngestError(err.code, f"{err.message} (gave up after {attempts} attempts)", retryable=False)
        final = not err.retryable
        docs.set(job_path, {"status": "failed" if final else "queued", "error": err.to_doc(), "updatedAt": SERVER_TIMESTAMP})
        docs.set(
            build_path,
            {"status": "failed" if final else "queued", "error": err.to_doc(), "finishedAt": SERVER_TIMESTAMP if final else None},
        )
        if final:
            docs.set(f"{job.project_path}", {"boq": {"pendingBuildId": None}})
        raise err from None
    stats = {k: v for k, v in out.stats.items() if k not in ("skippedSheets", "fallbackSheets", "writes")}
    stats["fallbackSheets"] = len(out.stats.get("fallbackSheets") or [])
    docs.set(
        build_path,
        {"status": "succeeded", "finishedAt": SERVER_TIMESTAMP, "stats": stats, "error": None, "evidenceRef": out.evidence_ref},
    )
    summary: dict[str, Any] = {"latestBuildId": job.buildId, "builtAt": SERVER_TIMESTAMP, "pendingBuildId": None}
    if _stale_mark(docs, job.project_path) == stale_mark:  # nothing changed while we were building
        summary.update({"stale": False, "staleReason": None})
    docs.set(job.project_path, {"boq": summary})
    docs.set(
        job_path,
        {
            "status": "succeeded",
            "error": None,
            "progress": {"stage": "done", "pct": 100},
            "result": {"buildId": job.buildId, "lines": stats["lines"], "red": stats["red"]},
            "updatedAt": SERVER_TIMESTAMP,
        },
    )
    return out
