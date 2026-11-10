"""``boq.build`` job: aggregate every current, ready electrical / lighting sheet version of a project into
``boqLines`` + an evidence file. Deterministic and idempotent (same inputs → same lines, same evidence bytes).

Inputs (all read by the orchestrator; artifacts are worker-made JSON, no parsing of user files here):
``sheets/*`` (current version, discipline / floors / scale — the user's when ``confirmed``), the version doc
(``status == ready``, ``regions``, ``artifacts.detections``, ``artifacts.links`` or ``links.json.gz`` next to
it), ``legendEntries`` (confirmed classes / item codes win, ignored entries drop), ``orgs/{o}/symbolMappings``
(class / itemCode / ``ignored``), ``boqRules`` (seeded with the defaults when empty), ``itemLibrary``.

Outputs:
* ``orgs/{o}/projects/{p}/boq/{buildId}/evidence.json.gz`` (``kamutan.boq-evidence/1``);
* Sprint 8: ``orgs/{o}/projects/{p}/boq/{buildId}/lines.json.gz`` (``kamutan.boq-lines/1``, :mod:`.snapshot`): the
  lines as the build left them (effective description / qty, price when known, byFloor, per-version attribution);
  path in the build doc's ``linesRef``;
* ``boqLines/{lineId}`` upserted. Fields in :data:`PRESERVED` (status + review / approval stamps, qtyOverride +
  reason/by/at, descriptionOverride + by/at/reason, priceOverride + by/at/reason, note, locked) are never overwritten, and re-read right before
  each line is written (a PATCH landing during the build survives). A line whose computed qty differs from the qty it had when
  it was approved keeps its status but gets the chip ``הכמות השתנתה מאז האישור`` and level red (worker
  bookkeeping ``approvedQty`` / ``approvedQtyAt``; cleared on re-approval or when the qty returns).
  Obsolete worker lines (not produced by this build) are deleted only when ``draft`` without qty / description
  override, note or lock; otherwise they are kept with qty 0, red, ``הסעיף לא נמצא בבנייה האחרונה``. Lines the worker
  did not create (no ``computedAt``: manual lines) are never touched.
* ``boqBuilds/{buildId}`` ``queued → running → succeeded | failed`` (+ ``stats``, ``evidenceRef``) and the
  project doc ``boq {latestBuildId, builtAt, stale: false, pendingBuildId: null}``; ``jobs/{jobId}`` status.
"""

from __future__ import annotations

import gzip
import json
import logging
import time
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any

from .. import errors as E
from ..calibration import RASTER_REASONS, clean_green_threshold, default_table
from ..errors import IngestError
from ..pipeline.artifacts import version_prefix
from ..pipeline.ceiling import cap_document
from ..service.gone import JobDropped, ensure_alive, log_dropped
from ..stores.base import SERVER_TIMESTAMP, BlobNotFound, BlobStore, DocStore
from .aggregate import Line, Result, SheetInput, aggregate
from .contracts import EVIDENCE_SCHEMA, BoqBuildJob, parse_links
from .corrections import Correction, OldDetections, parse_corrections
from .coverage import coverage
from .rules import FIXTURE_CLASSES, LABEL_RECLASS, R_OBSOLETE, R_QTY_CHANGED, Library, Rule, load_rules, seed_rules
from .snapshot import build_snapshot, lines_path, snapshot_bytes
from .textitems import legend_boxes, parse_text_items

log = logging.getLogger(__name__)

BUILD_DISCIPLINES = ("electrical", "lighting", "plumbing")  # every detection counts
# plans: rooms (tiling) + plumbing fixtures drawn on them (de-duplicated against the plumbing sheet)
PLAN_DISCIPLINES = ("construction", "architecture", "architecture_master")
PLAN_CLASSES = frozenset(FIXTURE_CLASSES)
# other disciplines (demolition, …): no automatic detections, only manual corrections + rooms
DEBOUNCE_MAX_WAIT_S = 60.0  # contracts BOQ_REBUILD_MAX_WAIT_MS
AFTER_BUILD_WAIT_S = 60.0
POLL_S = 2.0
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
    # Sprint 7: a line renamed by a user ("לעדכן שם של שורה"). The worker never writes or clears these: it keeps
    # writing the computed `description` (from the library item / rule) and the API shows the override on top.
    "descriptionOverride",
    "descriptionOverrideBy",
    "descriptionOverrideAt",
    "descriptionOverrideReason",
    # Sprint 8: the project's unit price of the line (API PATCH, editor+). Never written or cleared by the worker.
    "priceOverride",
    "priceOverrideBy",
    "priceOverrideAt",
    "priceOverrideReason",
    "locked",
)
# Sprint 8: preserved fields the published contracts (BOQ_LINE_PRESERVED_FIELDS) may not list yet — the mirror test
# tolerates exactly these until packages/contracts publishes them (then it is strict again).
PENDING_CONTRACT_FIELDS = ("priceOverride", "priceOverrideBy", "priceOverrideAt", "priceOverrideReason")
MAX_ATTEMPTS = 5
TEXT_ITEMS_FILE = "text_items.json.gz"  # Worker-Text (Sprint 6), under the version prefix
GEOMETRY_FILE = "geometry.json.gz"  # Worker-Geometry (Sprint 6), under the version prefix
CIRCUITS_FILE = "circuits.json.gz"  # Worker-Lighting (Sprint 10), under the version prefix (lighting sheets)


@dataclass
class Inputs:
    sheets: list[SheetInput]
    rules: list[Rule]
    library: Library
    entries: dict[str, dict[str, Any]]
    mappings: dict[str, dict[str, Any]]
    skipped_sheets: dict[str, str] = field(default_factory=dict)
    corrections: list[Correction] = field(default_factory=list)
    correction_counts: dict[str, int] = field(default_factory=dict)
    room_settings: dict[str, dict[str, Any]] = field(default_factory=dict)
    old_detections: OldDetections | None = None
    capped: dict[str, int] = field(default_factory=dict)  # stored greens lowered by the current calibration table
    library_rows: list[tuple[str, dict[str, Any]]] = field(default_factory=list)  # Sprint 8: raw docs (prices)


@dataclass
class BuildOutcome:
    status: str  # succeeded | skipped
    result: Result | None = None
    stats: dict[str, Any] = field(default_factory=dict)
    evidence_ref: str | None = None
    lines: dict[str, dict[str, Any]] = field(default_factory=dict)
    lines_ref: str | None = None  # Sprint 8: boq/{buildId}/lines.json.gz
    snapshot: dict[str, Any] | None = None


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
    library_rows = _list(docs, f"orgs/{org_id}/itemLibrary")
    library = Library.from_docs(library_rows)
    entries = {eid: e for eid, e in _list(docs, f"{proj}/legendEntries") if isinstance(e, dict)}
    mappings = {sig: m for sig, m in _list(docs, f"orgs/{org_id}/symbolMappings") if isinstance(m, dict)}
    sheets: list[SheetInput] = []
    skipped: dict[str, str] = {}
    # Stage 10 (A-LIVE-03, Worker-Accuracy request): stored artifacts of older versions (possibly ingested before
    # calibration existed, or by another image) are re-capped with THIS worker's table — only ever lowered; human
    # acceptances ("אושר ידנית") kept; corrections are applied later, in aggregate, and may still make items green.
    table = default_table()
    org_settings = (docs.get(f"orgs/{org_id}") or {}).get("settings")
    threshold = clean_green_threshold(org_settings.get("greenThreshold")) if isinstance(org_settings, dict) else None
    capped: dict[str, int] = {"detections": 0, "links": 0, "rooms": 0}

    def cap(kind: str, doc: Any, raster: bool) -> None:
        if isinstance(doc, dict):
            capped[kind] += cap_document(kind, doc, table, raster=raster, green_threshold=threshold)

    want_text = any(r.kind == "one_off_suggestion" and r.match.get("textPatterns") for r in rules)
    # Sprint 6: text items / text-triggered suggestions read every sheet's text (+ legend boxes for the scope);
    # area / length items read Worker-Geometry's geometry.json.gz
    want_text_items = any(
        r.kind == "text_item" or (r.kind == "suggested_item" and (r.match.get("trigger") or {}).get("kind") == "text")
        for r in rules
    )
    want_text = want_text or want_text_items
    want_geo = any(r.kind in ("area_item", "length_item") for r in rules)
    superseded: dict[str, str | None] = {}
    for sid, s in sorted(_list(docs, f"{proj}/sheets")):
        if s.get("superseded") is True:  # a revised upload replaced it (A-API-05); `supersededBy` may be null
            sb = s.get("supersededBy")
            superseded[sid] = str(sb) if isinstance(sb, str) and sb else None
            skipped[sid] = "superseded"
            continue
        disc = s.get("discipline")
        if not isinstance(disc, str) or not disc:
            continue
        # Sprint 10 (Worker-Classify) — keep: an all-floors sheet repeating the per-floor sheets (classify.project) is
        # not counted; the sheet stays listed with its reason
        if isinstance(s.get("coverage"), dict) and s["coverage"].get("status") == "overview":
            skipped[sid] = "overview"
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
            if disc in BUILD_DISCIPLINES:
                skipped[sid] = "no_detections"
                continue
            det = {}
        links_path = arts.get("links") or pre + "links.json.gz"
        links_obj = _gz_json(blobs, str(links_path)) if str(links_path).startswith(pre) else None
        raster = any(r in RASTER_REASONS for r in ((s.get("classification") or {}).get("reasons") or []))
        cap("detections", det, raster)
        cap("links", links_obj, raster)
        dets = [d for d in (det.get("detections") or []) if isinstance(d, dict)]
        if disc in PLAN_DISCIPLINES:
            dets = [d for d in dets if d.get("class") in PLAN_CLASSES]
        elif disc not in BUILD_DISCIPLINES:
            dets = []
        texts: list[dict[str, Any]] = []
        # label / suggestion rules need the text; plans: level marks (ceiling heights for the tiling defaults)
        if want_text or disc in PLAN_DISCIPLINES or any(d.get("class") in RECLASS_SOURCES for d in dets):
            tp = arts.get("text") or pre + "text.json.gz"
            tobj = _gz_json(blobs, str(tp)) if str(tp).startswith(pre) else None
            texts = [t for t in ((tobj or {}).get("lines") or []) if isinstance(t, dict)]
        text_items: list[dict[str, Any]] | None = None
        legends: list[tuple[float, float, float, float]] = []
        if want_text_items:
            tip = arts.get("textItems") or arts.get("text_items") or pre + TEXT_ITEMS_FILE
            text_items = parse_text_items(_gz_json(blobs, str(tip))) if str(tip).startswith(pre) else None
            if text_items is None:
                lp = arts.get("legend") or pre + "legend.json.gz"
                legends = legend_boxes(_gz_json(blobs, str(lp)) if str(lp).startswith(pre) else None)
        geometry: Any = None
        if want_geo:
            gp = arts.get("geometry") or pre + GEOMETRY_FILE
            geometry = _gz_json(blobs, str(gp)) if str(gp).startswith(pre) else None
        circuits: Any = None  # Sprint 10 (Worker-Lighting) — keep: circuits.json.gz of lighting sheets
        if disc == "lighting":
            cp = arts.get("circuits") or pre + CIRCUITS_FILE
            circuits = _gz_json(blobs, str(cp)) if str(cp).startswith(pre) else None
            if not isinstance(circuits, dict):
                circuits = None
        if s.get("floorCheck"):  # Sprint 10 (Worker-Classify) — keep: the worker moved the sheet to another floor
            from ..classify.project import remap_floors

            dets, circuits = remap_floors(s, dets, circuits)
        rp = arts.get("rooms") or pre + "rooms.json.gz"
        robj = _gz_json(blobs, str(rp)) if str(rp).startswith(pre) else None
        cap("rooms", robj, raster)
        room_docs = [r for r in ((robj or {}).get("rooms") or []) if isinstance(r, dict)]
        rooms = {str(r.get("id")): str(r.get("name") or "") for r in room_docs}
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
                room_docs,
                text_items,
                legends,
                geometry,
                circuits,
            )
        )
    corrections, ccounts = parse_corrections(_list(docs, f"{proj}/corrections"))
    corrections = retarget_superseded(corrections, superseded, {x.sheet_id for x in sheets})
    corrections = bind_to_lines(corrections, {lid: d for lid, d in _list(docs, f"{proj}/boqLines") if isinstance(d, dict)})
    settings = {k: v for k, v in _list(docs, f"{proj}/roomSettings") if isinstance(v, dict)}
    cache: dict[tuple[str, str], list[dict[str, Any]] | None] = {}

    def old_detections(sheet_id: str, version_id: str) -> list[dict[str, Any]] | None:
        """Detections of an older version of a sheet (correction re-matching); only under that version prefix."""
        if (sheet_id, version_id) not in cache:
            pre = version_prefix(org_id, project_id, sheet_id, version_id)
            vdoc = docs.get(f"{proj}/sheets/{sheet_id}/versions/{version_id}") or {}
            path = str((vdoc.get("artifacts") or {}).get("detections") or pre + "detections.json.gz")
            obj = _gz_json(blobs, path) if path.startswith(pre) else None
            cache[(sheet_id, version_id)] = (
                [d for d in obj.get("detections") or [] if isinstance(d, dict)] if isinstance(obj, dict) else None
            )
        return cache[(sheet_id, version_id)]

    return Inputs(sheets, rules, library, entries, mappings, skipped, corrections, ccounts, settings, old_detections, capped,
                  library_rows)  # fmt: skip


def retarget_superseded(corrections: list[Correction], superseded: dict[str, str | None], loaded: set[str]) -> list[Correction]:
    """Corrections made on a superseded sheet apply to the sheet that replaced it (following a chain of revisions),
    re-matched by anchor against its current version (E2E-12 cross-version rule). No replacement (``supersededBy``
    null) or a replacement not in this build → left as is: reported unmatched (``הגיליון לא נכלל בבנייה``)."""
    out: list[Correction] = []
    for c in corrections:
        if c.sheet_id not in superseded:
            out.append(c)
            continue
        cur: str | None = c.sheet_id
        for _ in range(8):
            if cur is None or cur not in superseded:
                break
            cur = superseded[cur]
        if cur is not None and cur in loaded and cur not in superseded:
            out.append(replace(c, sheet_id=cur, origin_sheet_id=c.origin_sheet_id or c.sheet_id))
        else:
            out.append(c)
    return out


def bind_to_lines(corrections: list[Correction], lines: dict[str, dict[str, Any]]) -> list[Correction]:
    """Sprint 6 (contracts "Corrections"): an active correction with ``lineId`` contributes to that line — its
    ``itemCode`` is the line's code (measure m² / m', count clicks). An ``accept`` bound to a *suggested* line by
    ``lineId`` alone is the confirmed quantity (``quantity``, else the line's current estimate): a manual quantity, so
    the suggestion is replaced and the line is no longer ``needsInput``. On computed lines bound measures / counts add
    to the computed quantity (Sprint 4 semantics). A line that no longer exists leaves the correction as it is."""
    out: list[Correction] = []
    for c in corrections:
        ln = lines.get(c.line_id) if c.line_id else None
        if ln is None or not isinstance(ln.get("code"), str):
            out.append(c)
            continue
        if c.item_code is None and c.kind in ("measure", "count", "accept"):
            c = replace(c, item_code=str(ln["code"]))
        bound_accept = c.kind == "accept" and not (c.detection_id or c.link_group_id or c.room_id)
        if bound_accept and (ln.get("origin") == "suggested" or ln.get("needsInput")):
            q = c.quantity
            if q is None and not ln.get("needsInput") and isinstance(ln.get("qty"), int | float):
                q = float(ln["qty"])
            if q is not None:
                c = replace(c, kind="measure", quantity=q, unit=c.unit or (str(ln.get("unit")) if ln.get("unit") else None))
        out.append(c)
    return out


def evidence_path(org_id: str, project_id: str, build_id: str) -> str:
    return f"orgs/{org_id}/projects/{project_id}/boq/{build_id}/evidence.json.gz"


def evidence_bytes(lines: list[Line], build_id: str, corrections: dict[str, Any] | None = None) -> bytes:
    obj: dict[str, Any] = {"schema": EVIDENCE_SCHEMA, "buildId": build_id, "lines": {ln.id: ln.evidence for ln in lines}}
    if corrections is not None:
        obj["corrections"] = corrections
    return gzip.compress(json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode(), mtime=0)


@dataclass
class Upserted:
    written: dict[str, dict[str, Any]]
    counts: dict[str, int]
    invalidated: list[dict[str, Any]] = field(default_factory=list)  # approvals invalidated by this build
    all_lines: dict[str, dict[str, Any]] = field(default_factory=dict)  # every boqLines doc after the build


def upsert_lines(docs: DocStore, proj: str, lines: list[Line], build_id: str, evidence_ref: str) -> Upserted:
    """Write the computed lines, preserving human fields; handle obsolete lines. Returns the docs written, counts and
    the approvals this build invalidated."""
    coll = f"{proj}/boqLines"
    existing = {lid: d for lid, d in _list(docs, coll) if isinstance(d, dict)}
    written: dict[str, dict[str, Any]] = {}
    counts = {"created": 0, "updated": 0, "deleted": 0, "kept": 0, "qtyChanged": 0, "approvalsInvalidated": 0}
    invalidated: list[dict[str, Any]] = []

    def check(lid: str, cur: dict[str, Any], doc: dict[str, Any]) -> None:
        inv = _approval_check(cur, doc, build_id)
        if inv is not None:
            invalidated.append({"lineId": lid, "code": doc.get("code"), "fromQty": inv["fromQty"], "toQty": inv["toQty"]})
            counts["approvalsInvalidated"] += 1

    for ln in lines:
        cur = existing.get(ln.id)
        computed = {**ln.computed_fields(), "evidenceRef": evidence_ref, "buildId": build_id, "computedAt": SERVER_TIMESTAMP}
        if cur is None:
            doc = {**computed, "status": "draft", "qtyOverride": None, "note": None, "updatedAt": SERVER_TIMESTAMP}
            counts["created"] += 1
        else:
            cur = _fresh(docs, f"{coll}/{ln.id}", cur)
            doc = {**cur, **computed, **{k: cur[k] for k in PRESERVED if k in cur}, "updatedAt": SERVER_TIMESTAMP}
            check(ln.id, cur, doc)
            counts["updated"] += 1
            counts["qtyChanged"] += int(any(str(r).startswith(R_QTY_CHANGED) for r in doc["reasons"]))
        docs.set(f"{coll}/{ln.id}", doc, merge=False)
        written[ln.id] = doc
    computed_ids = {ln.id for ln in lines}
    for lid in sorted(set(existing) - computed_ids):
        cur = existing[lid]
        if not cur.get("computedAt"):
            continue  # manual line: not ours
        cur = _fresh(docs, f"{coll}/{lid}", cur)
        if cur.get("status", "draft") == "draft" and not has_human_marks(cur):
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
        check(lid, cur, doc)
        docs.set(f"{coll}/{lid}", doc, merge=False)
        written[lid] = doc
        counts["kept"] += 1
    all_lines = {lid: d for lid, d in existing.items() if lid not in written and not d.get("computedAt")}  # manual
    all_lines.update(written)
    return Upserted(written, counts, invalidated[:500], all_lines)


def has_human_marks(line: dict[str, Any]) -> bool:
    """Human work on a line (an obsolete line with any of it is kept at qty 0, red — never deleted): a qty override
    (0 is a valid override), a renamed description, a price override (Sprint 8), a note or a lock."""
    return (
        line.get("qtyOverride") is not None
        or line.get("descriptionOverride") is not None
        or line.get("priceOverride") is not None
        or bool(line.get("note"))
        or bool(line.get("locked"))
    )


def _fresh(docs: DocStore, path: str, cur: dict[str, Any]) -> dict[str, Any]:
    """The line as it is now, for the human fields: the listing was read before aggregation, and the API may have
    PATCHed the line since (rename, override, approval). Narrows the read-modify-write window to one line (TODO: a
    transaction in the GCP store would close it). A line deleted meanwhile keeps the listed copy."""
    now = docs.get(path)
    return now if isinstance(now, dict) else cur


def _fmt_qty(q: Any) -> str:
    v = round(float(q or 0.0), 2)
    return str(int(v)) if v == int(v) else f"{v:g}"


def qty_changed_reason(from_qty: Any, to_qty: Any) -> str:
    """``הכמות השתנתה מאז האישור (16 → 17)`` (decision A-pipeline-08 / A-API-06)."""
    return f"{R_QTY_CHANGED} ({_fmt_qty(from_qty)} → {_fmt_qty(to_qty)})"


def _strip_qty_reason(reasons: Any) -> list[str]:
    return [r for r in reasons or [] if not str(r).startswith(R_QTY_CHANGED)]


def _flag_changed(doc: dict[str, Any], from_qty: Any) -> None:
    doc["reasons"] = [qty_changed_reason(from_qty, doc.get("qty")), *_strip_qty_reason(doc.get("reasons"))][:32]
    doc["level"] = "red"


def _approval_check(cur: dict[str, Any], doc: dict[str, Any], build_id: str | None = None) -> dict[str, Any] | None:
    """An approved line whose computed qty moved is no longer approved (decision A-pipeline-08 / A-API-06): it drops
    to ``reviewed`` (approval stamps cleared, as the API's un-approve does), level red, first reason
    ``הכמות השתנתה מאז האישור (X → Y)``, and ``approvalInvalidated`` keeps who / when / from → to until a human
    approves again (or moves it back to draft). A line with a ``qtyOverride`` keeps its approval: the human quantity is
    what was approved and did not change. Returns the invalidation (for the build doc / audit) when it happened now.

    Baseline: ``approvedQty`` / ``approvedQtyAt`` (worker bookkeeping) = the qty at the first rebuild after that
    approval (``approvedAt``), else the line's qty before this rebuild."""
    status = cur.get("status")
    marker = cur.get("approvalInvalidated")
    if status != "approved":
        doc.pop("approvedQty", None)
        doc.pop("approvedQtyAt", None)
        if status == "reviewed" and isinstance(marker, dict):
            doc["approvalInvalidated"] = {**marker, "toQty": doc.get("qty")}
            if float(doc.get("qty") or 0.0) != float(marker.get("fromQty") or 0.0):
                _flag_changed(doc, marker.get("fromQty"))
            else:
                doc["reasons"] = _strip_qty_reason(doc.get("reasons"))
        else:
            doc.pop("approvalInvalidated", None)
            doc["reasons"] = _strip_qty_reason(doc.get("reasons"))
        return None
    doc.pop("approvalInvalidated", None)
    at = cur.get("approvedAt")
    base = cur.get("approvedQty") if ("approvedQty" in cur and cur.get("approvedQtyAt") == at) else cur.get("qty")
    doc["approvedQty"] = base
    doc["approvedQtyAt"] = at
    doc["reasons"] = _strip_qty_reason(doc.get("reasons"))
    if base is None or cur.get("qtyOverride") is not None or float(doc.get("qty") or 0.0) == float(base):
        return None
    inv = {
        "fromQty": float(base),
        "toQty": float(doc.get("qty") or 0.0),
        "approvedBy": cur.get("approvedBy"),
        "approvedAt": at,
        "buildId": build_id,
        "at": SERVER_TIMESTAMP,
    }
    doc.update({"status": "reviewed", "approvedBy": None, "approvedAt": None, "approvalInvalidated": inv})
    doc.pop("approvedQty", None)
    doc.pop("approvedQtyAt", None)
    _flag_changed(doc, base)
    return inv


def build_project(org_id: str, project_id: str, build_id: str, blobs: BlobStore, docs: DocStore) -> BuildOutcome:
    """Aggregate + write evidence + upsert lines (no job/build bookkeeping). Used by the job and the local runner."""
    t0 = time.monotonic()
    proj = f"orgs/{org_id}/projects/{project_id}"
    inp = load_inputs(org_id, project_id, blobs, docs)
    res = aggregate(
        inp.sheets,
        inp.rules,
        inp.library,
        inp.entries,
        inp.mappings,
        corrections=inp.corrections,
        old_detections=inp.old_detections,
        room_settings=inp.room_settings,
    )
    corr = res.stats.get("corrections") or {}
    corr_ev = {"applied": list(corr.get("appliedIds") or []), "unmatched": list(corr.get("unmatchedList") or [])}
    ensure_alive(docs, proj)  # Sprint 8: a project deleted while aggregating gets no evidence / snapshot / lines
    ev_path = evidence_path(org_id, project_id, build_id)
    blobs.write(
        ev_path,
        evidence_bytes(res.lines, build_id, corr_ev),
        "application/gzip",
        cache_control="private, max-age=31536000, immutable",
    )
    ensure_alive(docs, proj)
    up = upsert_lines(docs, proj, res.lines, build_id, ev_path)
    written, counts = up.written, up.counts
    snap = build_snapshot(project_id, build_id, up.all_lines, res.lines, inp.library_rows, inp.sheets, inp.skipped_sheets)
    snap_raw = snapshot_bytes(snap)
    ln_path = lines_path(org_id, project_id, build_id)
    blobs.write(ln_path, snap_raw, "application/gzip", cache_control="private, max-age=31536000, immutable")
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
        "corrections": {
            "total": inp.correction_counts.get("total", 0),
            "reverted": inp.correction_counts.get("reverted", 0),
            "invalid": inp.correction_counts.get("invalid", 0),
            "applied": int(corr.get("applied", 0)),
            "unmatched": int(corr.get("unmatched", 0)),
            "rematched": int(corr.get("rematched", 0)),
            "manual": int(corr.get("manual", 0)),
        },
        "unmatchedCorrections": corr_ev["unmatched"],
        "plumbing": res.stats.get("plumbing", {}),
        "tiling": res.stats.get("tiling", {}),
        "skippedSheets": inp.skipped_sheets,
        "writes": counts,
        "approvalsInvalidated": counts["approvalsInvalidated"],
        "approvalsInvalidatedList": up.invalidated,
        "library": inp.library.stats(),
        "coverage": coverage(up.all_lines, inp.library),
        "textItems": res.stats.get("textItems", {}),
        "geometry": res.stats.get("geometry", {}),
        "suggested": res.stats.get("suggested", {}),
        "calibrationCapped": dict(inp.capped),
        "durationMs": int((time.monotonic() - t0) * 1000),
        "calibration": default_table().stats(),
        "projectStats": project_line_stats(up.all_lines),
        "linesSnapshot": {"lines": len(snap["lines"]), "bytes": len(snap_raw)},
    }
    return BuildOutcome("succeeded", res, stats, ev_path, written, ln_path, snap)


def project_line_stats(lines: dict[str, dict[str, Any]]) -> dict[str, int]:
    """Project-card counters (A-LIVE-02, contracts ``ProjectStatsSchema`` subset): every BOQ line incl. manual ones."""
    out = {"boqLines": len(lines), "green": 0, "yellow": 0, "red": 0}
    for d in lines.values():
        lv = d.get("level")
        if lv in ("green", "yellow", "red"):
            out[str(lv)] += 1
    return out


def _stale_mark(docs: DocStore, project_path: str) -> Any:
    """``boq.staleAt`` of the project: a change marked by the API *during* the build keeps ``stale: true``."""
    boq = (docs.get(project_path) or {}).get("boq")
    return boq.get("staleAt") if isinstance(boq, dict) else None


# injectable for tests
_sleep = time.sleep
_now = time.time


def _ts(v: Any) -> float | None:
    """Epoch seconds of a Firestore timestamp / datetime / ISO string (contracts TimestampSchema)."""
    if v is None:
        return None
    if isinstance(v, datetime):
        return (v if v.tzinfo else v.replace(tzinfo=UTC)).timestamp()
    if isinstance(v, str):
        try:
            d = datetime.fromisoformat(v)
        except ValueError:
            return None
        return (d if d.tzinfo else d.replace(tzinfo=UTC)).timestamp()
    ts = getattr(v, "timestamp", None)
    if callable(ts):
        out = ts()
        return float(out) if isinstance(out, int | float) else None
    return None


def wait_until_ready(docs: DocStore, job: BoqBuildJob, bd: dict[str, Any]) -> dict[str, Any]:
    """Debounced automatic rebuilds (contracts ``BoqBuild.debounceUntil`` / ``afterBuildId``): sleep until
    ``debounceUntil``, re-read the build doc (further edits push it back) and loop, capped at
    ``createdAt`` + 60 s; then, when ``afterBuildId`` names a build that is not terminal yet, poll it for up to
    60 s and otherwise hand the message back for redelivery (retryable, nothing written)."""
    build_path = f"{job.project_path}/boqBuilds/{job.buildId}"
    created = _ts(bd.get("createdAt")) or _now()
    cap = created + DEBOUNCE_MAX_WAIT_S
    while True:
        until = _ts(bd.get("debounceUntil"))
        now = _now()
        if until is None or now >= until or now >= cap:
            break
        _sleep(max(0.05, min(until, cap) - now))
        bd = docs.get(build_path) or bd
    after = bd.get("afterBuildId")
    if isinstance(after, str) and after and after != job.buildId:
        deadline = _now() + AFTER_BUILD_WAIT_S
        while True:
            other = docs.get(f"{job.project_path}/boqBuilds/{after}")
            if not other or other.get("status") in ("succeeded", "failed"):
                break
            if _now() >= deadline:
                raise IngestError(E.INTERNAL, f"waiting for build {after}", retryable=True)
            _sleep(POLL_S)
    return bd


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
    try:
        ensure_alive(docs, job.project_path)  # Sprint 8: deleted project → dropped quietly (no write at all)
    except JobDropped as e:
        log_dropped("boq.build", e)
        raise
    if bd.get("status") == "succeeded":
        docs.set(job_path, {"status": "succeeded", "progress": {"stage": "done", "pct": 100}, "updatedAt": SERVER_TIMESTAMP})
        return BuildOutcome("skipped", stats=dict(bd.get("stats") or {}), evidence_ref=bd.get("evidenceRef"),
                            lines_ref=bd.get("linesRef"))  # fmt: skip
    bd = wait_until_ready(docs, job, bd)
    try:
        ensure_alive(docs, job.project_path)  # the debounce wait can last a minute
    except JobDropped as e:
        log_dropped("boq.build", e)
        raise
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
        ensure_alive(docs, job.project_path, written=len(out.lines))
    except JobDropped as e:  # deleted meanwhile: no failed build / job doc, no project summary
        log_dropped("boq.build", e)
        raise
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
    drop = ("skippedSheets", "fallbackSheets", "writes", "unmatchedCorrections", "plumbing", "tiling",
            "approvalsInvalidatedList", "projectStats")  # fmt: skip
    stats = {k: v for k, v in out.stats.items() if k not in drop}
    stats["fallbackSheets"] = len(out.stats.get("fallbackSheets") or [])
    docs.set(
        build_path,
        {
            "status": "succeeded",
            "finishedAt": SERVER_TIMESTAMP,
            "stats": stats,
            "error": None,
            "evidenceRef": out.evidence_ref,
            # Sprint 8: the build's lines snapshot (version comparison "מה השתנה")
            "linesRef": out.lines_ref,
            # review queue: "תיקון לא הותאם" (also in the evidence file, contracts `corrections.unmatched`)
            "unmatchedCorrections": out.stats.get("unmatchedCorrections", []),
            # approvals this build invalidated (A-pipeline-08): the API audits them (NOTES Stage 10 request 1c)
            "approvalsInvalidated": out.stats.get("approvalsInvalidatedList", []),
        },
    )
    summary: dict[str, Any] = {"latestBuildId": job.buildId, "builtAt": SERVER_TIMESTAMP, "pendingBuildId": None}
    if _stale_mark(docs, job.project_path) == stale_mark:  # nothing changed while we were building
        summary.update({"stale": False, "staleReason": None})
    docs.set(job.project_path, {"boq": summary, "stats": out.stats.get("projectStats") or {}})
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
