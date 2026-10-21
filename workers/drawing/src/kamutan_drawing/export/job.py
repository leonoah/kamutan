"""Job ``export.marked_pdf`` (FR-29, E2E-13): orchestrator side (identity, docs, storage — no parsing here).

Flow:

1. ``jobs/{jobId}`` and the export doc ``orgs/{o}/projects/{p}/exports/{exportId}`` (created ``queued`` by the
   API, ``kind == 'marked_pdf'``) must exist and belong to the org / project (else ``invalid_payload``,
   nothing written); an export already ``ready`` → redelivery no-op.
2. Export doc + job → ``running``. Inputs: the latest BOQ build (project ``boq.latestBuildId`` → build doc
   ``succeeded`` → ``evidenceRef`` under ``…/boq/``), ``boqLines``, ``corrections`` (manual geometry), and per
   exported sheet (``sheetIds``, or every sheet with evidence; ``versionIds[sheetId]`` or the current version,
   ``ready``) the version's worker JSON artifacts
   ``detections`` / ``links`` / ``rooms`` (paths must lie under the version prefix) → :func:`plan.build_plan`.
3. Background per page: the sheet set's upload (``uploads/{setId}/source.pdf``) when the set is a PDF and its
   sha256 equals the version's ``sourceSha256``; otherwise the stored tile level closest to
   :data:`TILE_DPI` (PNG/JPEG/DXF sheets, or a PDF whose source vanished / changed). With ``hideTitleBlock``
   the stored ``primitives`` + ``text`` go along for the title-block search.
4. Sandbox task ``export_marked`` (:mod:`.render`): chunks of :data:`PAGES_PER_CALL` pages → parts, then one
   ``assemble`` call (parts + legend). The output (``%PDF``, ≤ :data:`MAX_OUTPUT_BYTES`) is uploaded to
   ``orgs/{o}/projects/{p}/exports/{exportId}/marked.pdf`` (= ``job.storagePath``); export doc ``ready``
   {storagePath, pageCount, sizeBytes, versionIds, finishedAt};
   job ``succeeded`` + ``result`` (stats).

Errors follow the ingest semantics (retryable → export + job back to ``queued``, HTTP 500 until
:data:`MAX_ATTEMPTS`; non-retryable → ``failed`` with ``error {code, message}``, HTTP 200).
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import math
import re
import shutil
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .. import errors as E
from ..errors import IngestError
from ..pipeline.artifacts import version_prefix
from ..sandbox.runner import Limits, run_task, safe_output_path
from ..stores.base import SERVER_TIMESTAMP, BlobNotFound, BlobStore, DocStore
from .contracts import MarkedPdfJob, export_doc_path
from .plan import SheetArtifacts, build_plan

log = logging.getLogger(__name__)

MAX_ATTEMPTS = 5
TITLE_BLOCK_NOT_FOUND = "title_block_not_found"  # non-retryable (export doc error.code)
PAGES_PER_CALL = 8
TILE_DPI = 150
MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
MAX_SOURCE_BYTES = 100 * 1024 * 1024
MAX_OUTPUT_BYTES = 512 * 1024 * 1024
MAX_TILES = 4000
OUTPUT_CACHE = "private, max-age=31536000, immutable"
DOC_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def _list(docs: DocStore, collection: str) -> list[tuple[str, dict[str, Any]]]:
    lister = getattr(docs, "list_docs", None)
    if lister is None:
        return []
    out: list[tuple[str, dict[str, Any]]] = lister(collection)
    return out


def _gz_json(blobs: BlobStore, path: str) -> Any | None:
    try:
        data = blobs.read(path)
    except BlobNotFound:
        return None
    if len(data) > MAX_ARTIFACT_BYTES:
        raise IngestError(E.TOO_LARGE, "stored artifact too large", retryable=False)
    try:
        return json.loads(gzip.decompress(data))
    except (OSError, ValueError):
        log.warning("export: unreadable artifact skipped")
        return None


def _artifact_path(arts: dict[str, Any], key: str, pre: str, name: str) -> str | None:
    p = arts.get(key)
    path = p if isinstance(p, str) else pre + name
    return path if path.startswith(pre) and ".." not in path else None


def _by_id(items: Any) -> dict[str, dict[str, Any]]:
    return {str(x["id"]): x for x in items or [] if isinstance(x, dict) and isinstance(x.get("id"), str)}


def _title_block(v: dict[str, Any]) -> tuple[float, float, float, float] | None:
    """Title-block box when the version doc carries one (``titleBlock.bboxMm`` [x0,y0,x1,y1] or {x,y,w,h};
    requested additive field, see NOTES); otherwise the sandbox searches it on the stored artifacts."""
    holders = (v.get("titleBlock"), {"bboxMm": v.get("titleBlockMm")}, (v.get("classification") or {}).get("titleBlock"))
    for holder in holders:
        b = holder.get("bboxMm") if isinstance(holder, dict) else None
        try:
            r: tuple[float, float, float, float] | None = None
            if isinstance(b, list | tuple) and len(b) == 4:
                r = (float(b[0]), float(b[1]), float(b[2]), float(b[3]))
            elif isinstance(b, dict):
                x, y, w, h = float(b["x"]), float(b["y"]), float(b["w"]), float(b["h"])
                r = (x, y, x + w, y + h)
            if r is not None and all(math.isfinite(c) for c in r) and r[2] - r[0] > 1 and r[3] - r[1] > 1:
                return r
        except (KeyError, TypeError, ValueError):
            continue
    return None


def load_sheets(
    job: MarkedPdfJob, blobs: BlobStore, docs: DocStore, with_evidence: set[str] | None = None
) -> tuple[list[SheetArtifacts], dict[str, dict[str, Any]], dict[str, str]]:
    """Ready versions of the exported sheets → (artifacts, raw sheet+version docs, skipped reasons).

    ``sheetIds`` null = every sheet with BOQ evidence (``with_evidence``); the version is ``versionIds[sheetId]``
    when pinned (share links), else the sheet's current version."""
    proj = job.project_path
    wanted = set(job.sheetIds) if job.sheetIds else None
    pins = dict(job.versionIds or {})
    out: list[SheetArtifacts] = []
    raw: dict[str, dict[str, Any]] = {}
    skipped: dict[str, str] = {}
    listed = {sid: s for sid, s in _list(docs, f"{proj}/sheets") if isinstance(s, dict)}
    if wanted is not None:
        for sid in wanted - set(listed):
            s = docs.get(f"{proj}/sheets/{sid}")
            if isinstance(s, dict):
                listed[sid] = s
            else:
                skipped[sid] = "not_found"
    for sid in sorted(listed):
        if wanted is not None and sid not in wanted:
            continue
        if wanted is None and with_evidence is not None and sid not in with_evidence:
            continue
        s = listed[sid]
        vid = pins.get(sid) or s.get("currentVersionId")
        if not isinstance(vid, str) or not DOC_ID.match(vid):
            skipped[sid] = "no_version"
            continue
        v = docs.get(f"{proj}/sheets/{sid}/versions/{vid}") or {}
        if v.get("status") != "ready":
            skipped[sid] = "not_ready"
            continue
        page = v.get("page") or {}
        try:
            w, h = float(page.get("widthMm") or 0), float(page.get("heightMm") or 0)
        except (TypeError, ValueError):
            w = h = 0.0
        if not (1 <= w <= 5000 and 1 <= h <= 5000):
            skipped[sid] = "no_page_size"
            continue
        arts = v.get("artifacts") or {}
        pre = version_prefix(job.orgId, job.projectId, sid, vid)
        det = links = rooms = None
        if p := _artifact_path(arts, "detections", pre, "detections.json.gz"):
            det = _gz_json(blobs, p)
        if p := _artifact_path(arts, "links", pre, "links.json.gz"):
            links = _gz_json(blobs, p)
        if p := _artifact_path(arts, "rooms", pre, "rooms.json.gz"):
            rooms = _gz_json(blobs, p)
        disc = s.get("discipline")
        floors = [str(f) for f in (s.get("floors") or []) if isinstance(f, str | int)]
        out.append(
            SheetArtifacts(
                sheet_id=sid,
                version_id=vid,
                title=str(s.get("title") or (s.get("classification") or {}).get("sheetTitle") or "")[:200],
                discipline=str(disc) if isinstance(disc, str) else "",
                floors=floors,
                width_mm=w,
                height_mm=h,
                regions=[r for r in (v.get("regions") or []) if isinstance(r, dict)],
                detections=_by_id((det or {}).get("detections") if isinstance(det, dict) else None),
                rooms=_by_id((rooms or {}).get("rooms") if isinstance(rooms, dict) else None),
                links=_by_id((links or {}).get("groups") if isinstance(links, dict) else None),
                title_block_mm=_title_block(v),
            )
        )
        raw[sid] = {"sheet": s, "version": v, "prefix": pre, "artifacts": arts}
    return out, raw, skipped


def load_boq(
    job: MarkedPdfJob, blobs: BlobStore, docs: DocStore
) -> tuple[str, dict[str, Any], dict[str, list[dict[str, Any]]], bool]:
    """(buildId, lines, evidence, stale) of the latest succeeded BOQ build."""
    proj = job.project_path
    pdoc = docs.get(proj) or {}
    boq: dict[str, Any] = pdoc["boq"] if isinstance(pdoc.get("boq"), dict) else {}
    build_id = boq.get("latestBuildId")
    if not isinstance(build_id, str) or not DOC_ID.match(build_id):
        raise IngestError(E.INVALID_PAYLOAD, "project has no BOQ build yet", retryable=False)
    bd = docs.get(f"{proj}/boqBuilds/{build_id}") or {}
    if bd.get("status") not in (None, "succeeded"):
        raise IngestError(E.INVALID_PAYLOAD, "latest BOQ build did not succeed", retryable=False)
    ref = bd.get("evidenceRef") or f"{proj}/boq/{build_id}/evidence.json.gz"
    if not isinstance(ref, str) or not ref.startswith(f"{proj}/boq/") or ".." in ref:
        raise IngestError(E.INVALID_PAYLOAD, "evidence reference outside the project", retryable=False)
    ev = _gz_json(blobs, ref)
    if not isinstance(ev, dict) or not isinstance(ev.get("lines"), dict):
        raise IngestError(E.SOURCE_NOT_FOUND, "BOQ evidence file missing", retryable=False)
    evidence = {str(k): [x for x in v if isinstance(x, dict)] for k, v in ev["lines"].items() if isinstance(v, list)}
    lines = {lid: d for lid, d in _list(docs, f"{proj}/boqLines") if isinstance(d, dict)}
    return build_id, lines, evidence, bool(boq.get("stale"))


def _tile_level(tiles: dict[str, Any]) -> tuple[int, int, int] | None:
    """(z, widthPx, heightPx) of the level closest to TILE_DPI (never above the max level)."""
    try:
        levels, dpi = int(tiles["levels"]), float(tiles.get("dpi") or 300)
        fw, fh = int(tiles["widthPx"]), int(tiles["heightPx"])
    except (KeyError, TypeError, ValueError):
        return None
    if not (1 <= levels <= 20 and 0 < fw <= 200_000 and 0 < fh <= 200_000 and dpi > 0):
        return None
    down = max(0, min(levels - 1, round(math.log2(dpi / TILE_DPI)) if dpi > TILE_DPI else 0))
    while down < levels - 1 and math.ceil(fw / 2**down) * math.ceil(fh / 2**down) > 60_000_000:
        down += 1
    z = levels - 1 - down
    return z, math.ceil(fw / 2**down), math.ceil(fh / 2**down)


def prepare_inputs(
    job: MarkedPdfJob, plan: dict[str, Any], raw: dict[str, dict[str, Any]], blobs: BlobStore, docs: DocStore, wd: Path
) -> dict[str, int]:
    """Download page backgrounds (+ title-block inputs) into the workdir and set ``page.source`` / ``tbDir``."""
    proj = job.project_path
    sources: dict[str, str | None] = {}  # sheetSetId → workdir file (or None when unusable)
    counts = {"pdf": 0, "tiles": 0, "blank": 0, "sourceMismatch": 0}
    for i, page in enumerate(plan["pages"]):
        r = raw[page["sheetId"]]
        s, v, pre, arts = r["sheet"], r["version"], r["prefix"], r["artifacts"]
        src: dict[str, Any] = {"kind": "none"}
        set_id = s.get("sheetSetId")
        if isinstance(set_id, str) and DOC_ID.match(set_id):
            if set_id not in sources:
                sources[set_id] = None
                sset = docs.get(f"{proj}/sheetSets/{set_id}") or {}
                kind = sset.get("fileKind")
                sp = sset.get("storagePath")
                if kind == "pdf" and sp == f"{proj}/uploads/{set_id}/source.pdf":
                    try:
                        data = blobs.read(sp)
                    except BlobNotFound:
                        data = b""
                    if 0 < len(data) <= MAX_SOURCE_BYTES:
                        f = wd / "in" / f"src_{len(sources)}.pdf"
                        f.parent.mkdir(parents=True, exist_ok=True)
                        f.write_bytes(data)
                        sources[set_id] = f"{f.relative_to(wd)}|{hashlib.sha256(data).hexdigest()}"
            entry = sources[set_id]
            pidx = s.get("pageIndex")
            if entry is not None and isinstance(pidx, int) and 0 <= pidx < 10_000:
                fname, sha = entry.split("|", 1)
                if not v.get("sourceSha256") or v.get("sourceSha256") == sha:
                    src = {"kind": "pdf", "file": fname, "pageIndex": pidx}
                else:
                    counts["sourceMismatch"] += 1
        if src["kind"] == "none":
            tiles = arts.get("tiles") if isinstance(arts.get("tiles"), dict) else None
            lvl = _tile_level(tiles) if tiles else None
            tprefix = str((tiles or {}).get("prefix") or "")
            if lvl is not None and tprefix.startswith(pre) and ".." not in tprefix:
                z, wpx, hpx = lvl
                tile = int((tiles or {}).get("tileSize") or 256)
                fmt = str((tiles or {}).get("format") or "webp")
                if fmt not in ("webp", "png", "jpg"):
                    fmt = "webp"
                d = wd / "in" / f"tiles_{i}"
                d.mkdir(parents=True, exist_ok=True)
                n = 0
                base = tprefix if tprefix.endswith("/") else tprefix + "/"
                for ty in range(math.ceil(hpx / tile)):
                    for tx in range(math.ceil(wpx / tile)):
                        if n >= MAX_TILES:
                            break
                        try:
                            data = blobs.read(f"{base}{z}/{tx}_{ty}.{fmt}")
                        except BlobNotFound:
                            continue
                        (d / f"{tx}_{ty}.{fmt}").write_bytes(data)
                        n += 1
                if n:
                    src = {"kind": "tiles", "dir": str(d.relative_to(wd)), "widthPx": wpx, "heightPx": hpx, "tileSize": tile,
                           "format": fmt}  # fmt: skip
        counts["pdf" if src["kind"] == "pdf" else ("tiles" if src["kind"] == "tiles" else "blank")] += 1
        page["source"] = src
        if plan["options"].get("hideTitleBlock") and not page.get("titleBlockMm"):
            prim = _artifact_path(arts, "primitives", pre, "primitives.msgpack.gz")
            text = _artifact_path(arts, "text", pre, "text.json.gz")
            if prim:
                d = wd / "in" / f"tb_{i}"
                d.mkdir(parents=True, exist_ok=True)
                try:
                    data = blobs.read(prim)
                    if len(data) <= MAX_ARTIFACT_BYTES:
                        (d / "primitives.msgpack.gz").write_bytes(data)
                        if text:
                            try:
                                (d / "text.json.gz").write_bytes(blobs.read(text))
                            except BlobNotFound:
                                pass
                        page["tbDir"] = str(d.relative_to(wd))
                except BlobNotFound:
                    pass
    return counts


def _clean_rect(v: Any) -> list[float] | None:
    if not isinstance(v, list) or len(v) != 4:
        return None
    try:
        r = [round(float(x), 2) for x in v]
    except (TypeError, ValueError):
        return None
    return r if all(-1 <= x <= 1e4 for x in r) else None


def render_export(
    job: MarkedPdfJob,
    blobs: BlobStore,
    docs: DocStore,
    *,
    limits: Limits | None = None,
    workdir_root: str | None = None,
    on_progress: Any = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Plan, render in the sandbox, upload. Returns ``{pageCount, storagePath, stats}``."""
    t0 = time.monotonic()
    build_id, lines, evidence, stale = load_boq(job, blobs, docs)
    with_ev = {str(it.get("sheetId")) for items in evidence.values() for it in items}
    sheets, raw, skipped = load_sheets(job, blobs, docs, with_ev)
    if not sheets:
        raise IngestError(E.INVALID_PAYLOAD, "no ready sheet to export", retryable=False)
    corrections = {cid: c for cid, c in _list(docs, f"{job.project_path}/corrections") if isinstance(c, dict)}
    when = (now or datetime.now(UTC)).astimezone(UTC)
    plan = build_plan(
        sheets,
        lines,
        evidence,
        corrections,
        options=job.options.model_dump(),
        meta={"buildId": build_id, "date": when.strftime("%d.%m.%Y %H:%M") + " UTC", "stale": stale},
    )
    if job.options.hideTitleBlock or job.options.watermark:
        for pg in plan["pages"]:  # the sheet title is read from the title block: never on share / hidden PDFs (F-3)
            pg["title"] = ""
    lim = limits or Limits()
    wd = Path(tempfile.mkdtemp(prefix="kamutan-export-", dir=workdir_root))
    try:
        backgrounds = prepare_inputs(job, plan, raw, blobs, docs, wd)
        (wd / "plan.json").write_text(json.dumps(plan, ensure_ascii=False, separators=(",", ":")))
        parts: list[str] = []
        mask_src: dict[str, str] = {}
        bg_kinds: dict[str, int] = {}
        masked: dict[str, bool] = {}
        page_bytes: dict[str, int] = {}
        n_pages = len(plan["pages"])
        chunks = [list(range(i, min(n_pages, i + PAGES_PER_CALL))) for i in range(0, n_pages, PAGES_PER_CALL)]
        for k, idx in enumerate(chunks):

            def prog(stage: str, pct: int, k: int = k) -> None:
                if on_progress is not None:
                    on_progress("export", int(5 + 85 * (k + pct / 100) / max(1, len(chunks))))

            res = run_task("export_marked", {"mode": "pages", "plan": "plan.json", "pages": idx, "out": f"out/part_{k}.pdf"},
                           workdir=str(wd), limits=lim, on_progress=prog)  # fmt: skip
            if not isinstance(res, dict):
                raise IngestError(E.PARSE_CRASHED, "export task returned no result")
            safe_output_path(str(wd), f"out/part_{k}.pdf")
            parts.append(f"out/part_{k}.pdf")
            for key, val in (res.get("maskSource") or {}).items():
                if str(key).isdigit() and int(key) < n_pages and val in ("plan", "detected", "none"):
                    mask_src[plan["pages"][int(key)]["sheetId"]] = str(val)
            for key, val in (res.get("titleBlockMasked") or {}).items():
                if str(key).isdigit() and int(key) < n_pages and isinstance(val, bool):
                    masked[plan["pages"][int(key)]["sheetId"]] = val
            for key, val in (res.get("pageBytes") or {}).items():
                if str(key).isdigit() and int(key) < n_pages and isinstance(val, int):
                    page_bytes[plan["pages"][int(key)]["sheetId"]] = val
            for val in (res.get("background") or {}).values():
                if val in ("vector", "raster", "tiles", "blank"):
                    bg_kinds[str(val)] = bg_kinds.get(str(val), 0) + 1
            for key, val in (res.get("titleBlocks") or {}).items():
                if str(key).isdigit() and int(key) < n_pages:
                    _clean_rect(val)  # validated, informational only
        if job.options.hideTitleBlock:
            # fail closed: every page must report a mask; a page without one was refused by the sandbox (F-3)
            masked = {pg["sheetId"]: masked.get(pg["sheetId"]) is True for pg in plan["pages"]}
            if not any(masked.values()):
                raise TitleBlockRefused(masked)
        omitted = sum(1 for v in masked.values() if not v)
        res = run_task("export_marked", {"mode": "assemble", "plan": "plan.json", "parts": parts, "out": "out/marked.pdf",
                                         "omitted": omitted}, workdir=str(wd), limits=lim)  # fmt: skip
        if not isinstance(res, dict):
            raise IngestError(E.PARSE_CRASHED, "export task returned no result")
        data = Path(safe_output_path(str(wd), "out/marked.pdf")).read_bytes()
        if not data.startswith(b"%PDF-") or len(data) > MAX_OUTPUT_BYTES:
            raise IngestError(E.PARSE_CRASHED, "export task produced an invalid PDF")
        try:
            page_count = int(res.get("pageCount"))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            raise IngestError(E.PARSE_CRASHED, "export task reported no page count") from None
        if not 1 <= page_count <= n_pages - omitted + 200:
            raise IngestError(E.PARSE_CRASHED, "export task reported an invalid page count")
    finally:
        shutil.rmtree(wd, ignore_errors=True)
    path = job.storagePath
    blobs.write(path, data, "application/pdf", cache_control=OUTPUT_CACHE)
    stats = {
        "buildId": build_id,
        "sheets": n_pages,
        "skippedSheets": skipped,
        "pages": page_count,
        "bytes": len(data),
        **plan["stats"],
        "backgrounds": backgrounds,
        "rendered": bg_kinds,
        "titleBlock": mask_src if job.options.hideTitleBlock else {},
        "titleBlockMasked": masked if job.options.hideTitleBlock else {},
        "omittedSheets": sorted(k for k, v in masked.items() if not v),
        "share": bool(job.options.watermark),
        "pageBytes": page_bytes,
        "durationMs": int((time.monotonic() - t0) * 1000),
    }
    return {"pageCount": page_count, "storagePath": path, "sizeBytes": len(data), "stats": stats,
            "versionIds": {s.sheet_id: s.version_id for s in sheets if masked.get(s.sheet_id, True)},
            "titleBlockMasked": (all(masked.values()) if job.options.hideTitleBlock else None),
            "titleBlockBySheet": masked if job.options.hideTitleBlock else None}  # fmt: skip


class TitleBlockRefused(IngestError):
    """``hideTitleBlock`` and no sheet has a known title block: nothing may be emitted (sec gate F-3)."""

    def __init__(self, by_sheet: dict[str, bool]) -> None:
        super().__init__(TITLE_BLOCK_NOT_FOUND, "title block not found on any sheet; cannot hide it", retryable=False)
        self.by_sheet = by_sheet


def run_marked_pdf(
    job: MarkedPdfJob,
    blobs: BlobStore,
    docs: DocStore,
    *,
    limits: Limits | None = None,
    workdir_root: str | None = None,
) -> dict[str, Any]:
    job_path = f"jobs/{job.jobId}"
    xp = export_doc_path(job)
    jd = docs.get(job_path)
    if jd is None:
        raise IngestError(E.INVALID_PAYLOAD, "job document not found", retryable=False)
    if jd.get("orgId") != job.orgId or jd.get("projectId", job.projectId) != job.projectId:
        raise IngestError(E.INVALID_PAYLOAD, "job does not belong to this org/project", retryable=False)
    xd = docs.get(xp)
    if xd is None:
        raise IngestError(E.INVALID_PAYLOAD, "export document not found", retryable=False)
    if xd.get("kind", "marked_pdf") != "marked_pdf":
        raise IngestError(E.INVALID_PAYLOAD, "export document is not a marked PDF", retryable=False)
    if xd.get("status") in ("ready", "succeeded"):
        docs.set(job_path, {"status": "succeeded", "progress": {"stage": "done", "pct": 100}, "updatedAt": SERVER_TIMESTAMP})
        return {"status": "skipped"}
    attempts = int(jd.get("attempts") or 0) + 1
    docs.set(
        job_path,
        {"status": "running", "attempts": attempts, "progress": {"stage": "export", "pct": 5}, "error": None,
         "updatedAt": SERVER_TIMESTAMP},
    )  # fmt: skip
    docs.set(xp, {"status": "running", "startedAt": SERVER_TIMESTAMP, "error": None})
    last = [0.0]

    def prog(stage: str, pct: int) -> None:
        now = time.monotonic()
        if now - last[0] >= 2.0:
            last[0] = now
            docs.set(job_path, {"progress": {"stage": "export", "pct": max(5, min(99, int(pct)))}, "updatedAt": SERVER_TIMESTAMP})

    try:
        out = render_export(job, blobs, docs, limits=limits, workdir_root=workdir_root, on_progress=prog)
    except Exception as e:
        if isinstance(e, IngestError):
            err = e
        elif isinstance(e, BlobNotFound):
            err = IngestError(E.STORAGE_UNAVAILABLE, "artifact storage object vanished")
        else:
            log.exception("export %s crashed", job.exportId)
            err = IngestError(E.INTERNAL, f"internal error ({type(e).__name__})", retryable=True)
        if err.retryable and attempts >= MAX_ATTEMPTS:
            err = IngestError(err.code, f"{err.message} (gave up after {attempts} attempts)", retryable=False)
        final = not err.retryable
        docs.set(job_path, {"status": "failed" if final else "queued", "error": err.to_doc(), "updatedAt": SERVER_TIMESTAMP})
        fail: dict[str, Any] = {"status": "failed" if final else "queued", "error": err.to_doc(),
                                "finishedAt": SERVER_TIMESTAMP if final else None}  # fmt: skip
        if isinstance(err, TitleBlockRefused):
            fail.update({"titleBlockMasked": False, "titleBlockBySheet": err.by_sheet})
            docs.set(job_path, {"result": {"exportId": job.exportId, "titleBlockMasked": err.by_sheet}})
        docs.set(xp, fail)
        raise err from None
    docs.set(
        xp,
        {"status": "ready", "storagePath": out["storagePath"], "pageCount": out["pageCount"], "sizeBytes": out["sizeBytes"],
         "versionIds": out["versionIds"], "titleBlockMasked": out["titleBlockMasked"],
         "titleBlockBySheet": out["titleBlockBySheet"], "error": None, "finishedAt": SERVER_TIMESTAMP},
    )  # fmt: skip
    docs.set(
        job_path,
        {"status": "succeeded", "error": None, "progress": {"stage": "done", "pct": 100},
         "result": {"exportId": job.exportId, **out["stats"]}, "updatedAt": SERVER_TIMESTAMP},
    )  # fmt: skip
    return {"status": "succeeded", **out}


__all__ = ["MAX_ATTEMPTS", "load_boq", "load_sheets", "render_export", "run_marked_pdf"]
