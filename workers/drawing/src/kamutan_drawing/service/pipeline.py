"""`process_sheet_version`: one ingest job (Pub/Sub topic ``ingest``) end to end.

The orchestrator holds the identity (Storage/Firestore) and never parses: every parser call
goes through :func:`kamutan_drawing.sandbox.runner.run_task` (SEC-17) on a local copy of the
upload in a fresh temporary directory.

Flow (docs/agents/SPRINT1_BRIEF.md):

1. ``jobs/{jobId}`` must exist and belong to the job's org/project (else ``invalid_payload``,
   nothing is written). A succeeded job with the same sha256 is a redelivery: re-assert
   ``ready`` and return (idempotent).
2. Download ``storagePath`` (≤ 100 MB), verify sha256, re-check magic bytes against ``fileKind``.
3. ``probe`` (sandbox): page list (DWG → DXF via ``dwg2dxf`` when installed, else
   ``unsupported_kind``).
4. Initial mode: create ``sheets/{sheetSetId}-p{i}`` + ``versions/{versionId}`` (queued) for all
   pages first, so the UI shows every page at once. Reprocess mode: only ``pageIndex``.
5. Per page, ``page`` (sandbox): tiles + thumbnail + primitives + text + classification +
   regions; outputs are uploaded to
   ``orgs/{o}/projects/{p}/sheets/{s}/versions/{v}/`` and the version/sheet docs are written.
   A version that is already ``ready`` for the same sha256 + versionId + worker is skipped.
6. Progress: version ``progress {stage, pct}`` per page; job ``progress`` over all pages;
   statuses queued → processing → ready | failed (version), queued → running → succeeded |
   failed (job). Errors are ``{code, message}`` (:mod:`kamutan_drawing.errors`).

Title-block PII (client name, address, project name) never leaves the sandbox result:
only discipline/floors/title/scale/confidence/level/reasons are written.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import shutil
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from .. import __version__
from .. import errors as E
from ..errors import IngestError
from ..formats import CONTENT_TYPES, compatible, detect_kind
from ..ocr.shapes import GlyphStore, StoreDelta
from ..pipeline.artifacts import glyph_store_path, version_prefix
from ..sandbox.runner import Limits, run_task, safe_output_path
from ..stores.base import SERVER_TIMESTAMP, BlobNotFound, BlobStore, DocStore
from .contracts import IngestSheetVersionJob

log = logging.getLogger(__name__)

WORKER_VERSION = f"kamutan-drawing/{__version__}"
MAX_SOURCE_BYTES = 100 * 1024 * 1024  # SEC-14
MAX_ATTEMPTS = 5  # = Pub/Sub --max-delivery-attempts (infra/IAM.md §2)
IMMUTABLE = "private, max-age=31536000, immutable"  # artifacts of a version never change
STAGES = ("ingest", "render", "ocr", "classify", "scale", "legend", "detect", "rooms", "done")
SHEET_FIELDS_CONFIRMED = ("discipline", "floors", "scaleDenominator")


@dataclass(frozen=True)
class Options:
    ocr: bool = True
    dpi: int = 300
    tiles: bool = True
    limits: Limits = field(default_factory=Limits)
    workdir_root: str | None = None
    max_attempts: int = MAX_ATTEMPTS
    glyph_store: bool = True
    # Sprint 2 understanding stage (legend → detect → rooms); KAMUTAN_UNDERSTAND=0 turns it off
    understand: bool = field(default_factory=lambda: os.environ.get("KAMUTAN_UNDERSTAND", "1") != "0")
    understand_rooms: bool = True
    # LLM gateway for low-confidence legend labels; None = built from the environment (disabled by default)
    llm: Any = None
    llm_max_labels: int = 12


@dataclass
class PageOutcome:
    index: int
    sheet_id: str
    status: str  # ready | failed | skipped
    error: dict[str, str] | None = None
    tiles: int = 0
    seconds: float = 0.0
    result: dict[str, Any] | None = None


@dataclass
class JobOutcome:
    status: str  # succeeded | failed | skipped
    pages: list[PageOutcome]
    kind: str | None = None
    error: dict[str, str] | None = None


class _Paths:
    def __init__(self, job: IngestSheetVersionJob) -> None:
        self.job = job
        p = job.project_path
        self.job_doc = f"jobs/{job.jobId}"
        self.sheet_set = f"{p}/sheetSets/{job.sheetSetId}"

    def sheet(self, sid: str) -> str:
        return f"{self.job.project_path}/sheets/{sid}"

    def version(self, sid: str) -> str:
        return f"{self.sheet(sid)}/versions/{self.job.versionId}"

    def artifacts(self, sid: str) -> str:
        return version_prefix(self.job.orgId, self.job.projectId, sid, self.job.versionId)


def _err(e: IngestError) -> dict[str, str]:
    return e.to_doc()


class _Recorded(IngestError):
    """A failure whose docs are already written (per-page failures); not recorded again."""


def _clean_classification(c: dict[str, Any]) -> dict[str, Any]:
    """Clamp to contracts ``SheetClassification`` (sizes) — defensive, the sandbox output is untrusted."""
    level = c.get("level") if c.get("level") in ("green", "yellow", "red") else "red"
    disc = c.get("discipline")
    return {
        "discipline": disc if isinstance(disc, str) and disc.isascii() and 0 < len(disc) <= 40 else None,
        "floors": [str(f)[:32] for f in (c.get("floors") or []) if str(f).strip()][:16],
        "sheetTitle": (str(c["sheetTitle"])[:300] or None) if c.get("sheetTitle") else None,
        "scaleText": (str(c["scaleText"])[:100] or None) if c.get("scaleText") else None,
        "confidence": max(0.0, min(1.0, float(c.get("confidence") or 0.0))),
        "level": level,
        "reasons": [str(r)[:200] for r in (c.get("reasons") or [])][:32],
    }


def _scale(v: Any) -> int | None:
    return int(v) if isinstance(v, int | float) and 1 <= int(v) <= 10_000 else None


class _Progress:
    """Throttled progress writes (version + job docs). Never moves backwards."""

    def __init__(self, docs: DocStore, paths: _Paths, n_pages: int) -> None:
        self.docs, self.paths, self.n = docs, paths, max(1, n_pages)
        self.last: dict[str, tuple[str, int]] = {}
        self.last_t = 0.0

    def page(self, done_before: int, sid: str, stage: str, pct: int) -> None:
        stage = stage if stage in STAGES else "ingest"
        pct = max(0, min(100, int(pct)))
        prev = self.last.get(sid)
        if prev is not None and (
            prev == (stage, pct) or (prev[0] == stage and pct - prev[1] < 10 and time.monotonic() - self.last_t < 2)
        ):
            return
        self.last[sid] = (stage, pct)
        self.last_t = time.monotonic()
        self.docs.set(
            self.paths.version(sid),
            {"status": "processing", "progress": {"stage": stage, "pct": pct}, "updatedAt": SERVER_TIMESTAMP},
        )
        overall = round(100 * (done_before + pct / 100) / self.n)
        self.docs.set(self.paths.job_doc, {"progress": {"stage": stage, "pct": min(99, overall)}, "updatedAt": SERVER_TIMESTAMP})


def process_sheet_version(
    job: IngestSheetVersionJob,
    blobs: BlobStore,
    docs: DocStore,
    options: Options | None = None,
    *,
    on_page: Callable[[PageOutcome], None] | None = None,
) -> JobOutcome:
    """Run the job. Returns the outcome; raises :class:`IngestError` when the job failed
    (``retryable`` tells the push handler whether Pub/Sub should redeliver)."""
    opts = options or Options()
    paths = _Paths(job)

    # ---- 1. job doc: ownership + idempotency (nothing is written for a foreign/missing job)
    jd = docs.get(paths.job_doc)
    if jd is None:
        raise IngestError(E.INVALID_PAYLOAD, "job document not found", retryable=False)
    if jd.get("orgId") != job.orgId or jd.get("projectId", job.projectId) != job.projectId:
        raise IngestError(E.INVALID_PAYLOAD, "job does not belong to this org/project", retryable=False)
    done = jd.get("result") if isinstance(jd.get("result"), dict) else None
    if jd.get("status") == "succeeded" and done and done.get("sha256") == job.sha256 and done.get("versionId") == job.versionId:
        return _reassert_ready(job, docs, paths, done)

    attempts = int(jd.get("attempts") or 0) + 1
    docs.set(
        paths.job_doc,
        {
            "status": "running",
            "attempts": attempts,
            "progress": {"stage": "ingest", "pct": 0},
            "error": None,
            "updatedAt": SERVER_TIMESTAMP,
        },
    )
    known_pages: list[int] = [job.pageIndex] if job.pageIndex is not None else []
    workdir = tempfile.mkdtemp(prefix="kamutan-ingest-", dir=opts.workdir_root)
    try:
        try:
            return _run(job, blobs, docs, opts, paths, workdir, known_pages, on_page)
        except IngestError:
            raise
        except BlobNotFound as e:
            raise IngestError(E.STORAGE_UNAVAILABLE, "artifact storage object vanished") from e
        except Exception as e:  # unexpected: record a short message (no drawing content), let Pub/Sub retry
            log.exception("job %s crashed", job.jobId)
            raise IngestError(E.INTERNAL, f"internal error ({type(e).__name__})", retryable=True) from e
    except _Recorded as e:
        raise IngestError(e.code, e.message, retryable=False) from None
    except IngestError as e:
        if e.retryable and attempts >= opts.max_attempts:
            e = IngestError(e.code, f"{e.message} (gave up after {attempts} attempts)", retryable=False)
        _record_failure(job, docs, paths, e, known_pages)
        raise e from None
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def _record_failure(job: IngestSheetVersionJob, docs: DocStore, paths: _Paths, e: IngestError, pages: list[int]) -> None:
    log.warning("job %s failed: %s %s (retryable=%s)", job.jobId, e.code, e.message, e.retryable)
    err = _err(e)
    # a retryable failure goes back to "queued" (Pub/Sub redelivers); otherwise it is final
    status = "queued" if e.retryable else "failed"
    docs.set(paths.job_doc, {"status": status, "error": err, "updatedAt": SERVER_TIMESTAMP})
    for i in pages:
        vpath = paths.version(job.sheet_id(i))
        cur = docs.get(vpath)
        if cur is not None and cur.get("status") == "ready" and cur.get("sourceSha256") == job.sha256:
            continue
        docs.set(vpath, {"status": "queued" if e.retryable else "failed", "error": err, "updatedAt": SERVER_TIMESTAMP})
    if not job.is_reprocess and not e.retryable:
        docs.set(paths.sheet_set, {"status": "failed", "error": err, "updatedAt": SERVER_TIMESTAMP})


def _reassert_ready(job: IngestSheetVersionJob, docs: DocStore, paths: _Paths, done: dict[str, Any]) -> JobOutcome:
    outcomes = []
    for i in done.get("pages") or []:
        sid = job.sheet_id(int(i))
        v = docs.get(paths.version(sid))
        if v is not None and v.get("artifacts", {}).get("tiles") and v.get("sourceSha256") == job.sha256:
            docs.set(paths.version(sid), {"status": "ready", "progress": {"stage": "done", "pct": 100}, "error": None})
            outcomes.append(PageOutcome(int(i), sid, "skipped"))
    docs.set(paths.job_doc, {"status": "succeeded", "progress": {"stage": "done", "pct": 100}, "updatedAt": SERVER_TIMESTAMP})
    return JobOutcome("skipped", outcomes)


def _fetch(job: IngestSheetVersionJob, blobs: BlobStore) -> tuple[bytes, str]:
    try:
        data = blobs.read(job.storagePath)
    except BlobNotFound:
        raise IngestError(E.SOURCE_NOT_FOUND, "uploaded file not found") from None
    if len(data) > MAX_SOURCE_BYTES:
        raise IngestError(E.TOO_LARGE, "file exceeds 100 MB")
    if hashlib.sha256(data).hexdigest() != job.sha256:
        raise IngestError(E.SHA256_MISMATCH, "file content does not match the uploaded sha256")
    kind = detect_kind(data[:4096])
    if kind is None:
        raise IngestError(E.UNSUPPORTED_FORMAT, "file type is not PDF, DXF, DWG, PNG or JPEG")
    if not compatible(job.fileKind, kind):
        raise IngestError(E.FILE_TYPE_MISMATCH, f"file content is {kind}, not {job.fileKind}")
    return data, kind


def _ensure_docs(job: IngestSheetVersionJob, docs: DocStore, paths: _Paths, index: int, page: dict[str, Any] | None) -> str:
    sid = job.sheet_id(index)
    spath = paths.sheet(sid)
    if docs.get(spath) is None:
        docs.set(
            spath,
            {
                "sheetSetId": job.sheetSetId,
                "pageIndex": index,
                "title": None,
                "discipline": None,
                "floors": [],
                "scaleDenominator": None,
                "classification": None,
                "confirmed": False,
                "currentVersionId": job.versionId,
                "updatedAt": SERVER_TIMESTAMP,
            },
            merge=False,
        )
    elif not job.is_reprocess:
        docs.set(spath, {"currentVersionId": job.versionId, "updatedAt": SERVER_TIMESTAMP})
    vpath = paths.version(sid)
    v = docs.get(vpath)
    if v is None:
        docs.set(
            vpath,
            {
                "sheetId": sid,
                "versionNo": 1,
                "status": "queued",
                "progress": {"stage": "ingest", "pct": 0},
                "error": None,
                "page": page,
                "artifacts": {},
                "regions": [],
                "stats": None,
                "workerVersion": None,
                "jobId": job.jobId,
                "createdAt": SERVER_TIMESTAMP,
                "updatedAt": SERVER_TIMESTAMP,
            },
            merge=False,
        )
    elif v.get("status") != "ready":
        docs.set(vpath, {"jobId": job.jobId, "page": page or v.get("page"), "updatedAt": SERVER_TIMESTAMP})
    return sid


def _run(
    job: IngestSheetVersionJob,
    blobs: BlobStore,
    docs: DocStore,
    opts: Options,
    paths: _Paths,
    workdir: str,
    known_pages: list[int],
    on_page: Callable[[PageOutcome], None] | None,
) -> JobOutcome:
    data, kind = _fetch(job, blobs)
    src = Path(workdir) / f"source.{kind}"
    src.write_bytes(data)
    del data
    if not job.is_reprocess:
        docs.set(paths.sheet_set, {"status": "splitting", "updatedAt": SERVER_TIMESTAMP})

    lim = opts.limits
    probe = run_task(
        "probe", {"kind": kind, "path": src.name}, workdir=workdir, limits=replace(lim, wall_s=min(lim.wall_s, 180.0))
    )
    pages: list[dict[str, Any]] = list(probe["pages"])
    page_kind = str(probe["kind"])
    page_path = str(probe["path"])
    safe_output_path(workdir, page_path)
    if job.pageIndex is not None:
        if job.pageIndex >= len(pages):
            raise IngestError(E.FILE_UNREADABLE, f"page {job.pageIndex} does not exist (file has {len(pages)})")
        todo = [job.pageIndex]
    else:
        todo = list(range(len(pages)))
        known_pages[:] = todo
        docs.set(paths.sheet_set, {"pageCount": len(pages), "updatedAt": SERVER_TIMESTAMP})

    def geometry(i: int) -> dict[str, Any] | None:
        p = pages[i]
        if "widthMm" not in p:
            return None
        return {"widthMm": p["widthMm"], "heightMm": p["heightMm"], "rotation": int(p.get("rotation", 0)) % 360}

    for i in todo:
        _ensure_docs(job, docs, paths, i, geometry(i))

    prog = _Progress(docs, paths, len(todo))
    outcomes: list[PageOutcome] = []
    for n_done, i in enumerate(todo):
        sid = job.sheet_id(i)
        t0 = time.monotonic()
        v = docs.get(paths.version(sid)) or {}
        if v.get("status") == "ready" and v.get("sourceSha256") == job.sha256 and v.get("workerVersion") == WORKER_VERSION:
            outcomes.append(PageOutcome(i, sid, "skipped"))
            continue
        try:
            out = _process_page(job, blobs, docs, opts, paths, workdir, page_kind, page_path, i, sid, prog, n_done, v)
            out.seconds = round(time.monotonic() - t0, 2)
        except IngestError as e:
            if e.retryable:
                raise
            log.warning("job %s page %d failed: %s", job.jobId, i, e.code)
            docs.set(paths.version(sid), {"status": "failed", "error": _err(e), "updatedAt": SERVER_TIMESTAMP})
            out = PageOutcome(i, sid, "failed", error=_err(e), seconds=round(time.monotonic() - t0, 2))
        outcomes.append(out)
        if on_page is not None:
            on_page(out)

    ok = [o for o in outcomes if o.status in ("ready", "skipped")]
    failed = [o for o in outcomes if o.status == "failed"]
    if not job.is_reprocess:
        docs.set(paths.sheet_set, {"status": "ready" if ok else "failed", "pageCount": len(pages), "updatedAt": SERVER_TIMESTAMP})
    if failed:
        first = failed[0].error or {"code": E.INTERNAL, "message": ""}
        msg = f"{len(failed)} of {len(outcomes)} pages failed: {first['message']}"[:300]
        err = _Recorded(first["code"], msg, retryable=False)
        docs.set(
            paths.job_doc,
            {
                "status": "failed",
                "error": err.to_doc(),
                "progress": {"stage": "done", "pct": 100},
                "result": _result(job, outcomes),
                "updatedAt": SERVER_TIMESTAMP,
            },
        )
        raise err
    docs.set(
        paths.job_doc,
        {
            "status": "succeeded",
            "error": None,
            "progress": {"stage": "done", "pct": 100},
            "result": _result(job, outcomes),
            "updatedAt": SERVER_TIMESTAMP,
        },
    )
    return JobOutcome("succeeded", outcomes, kind=page_kind)


def _result(job: IngestSheetVersionJob, outcomes: list[PageOutcome]) -> dict[str, Any]:
    return {
        "sha256": job.sha256,
        "versionId": job.versionId,
        "pages": [o.index for o in outcomes if o.status in ("ready", "skipped")],
        "failedPages": [o.index for o in outcomes if o.status == "failed"],
        "workerVersion": WORKER_VERSION,
    }


def _load_glyph_store(blobs: BlobStore, org_id: str) -> bytes | None:
    data, _ = blobs.read_versioned(glyph_store_path(org_id))
    return data


def _merge_glyph_delta(blobs: BlobStore, org_id: str, delta_obj: dict[str, Any] | None) -> None:
    """Merge one page's contribution into the org glyph store (optimistic concurrency, idempotent)."""
    if not delta_obj:
        return
    delta = StoreDelta.from_obj(delta_obj)
    path = glyph_store_path(org_id)
    for _ in range(5):
        data, token = blobs.read_versioned(path)
        store = GlyphStore.from_bytes(data)
        store.apply(delta)
        if blobs.write_if(path, store.to_bytes(), "application/gzip", expected=token):
            return
    log.warning("glyph store merge lost 5 races; contribution %s dropped", delta.contribution)


def _process_page(
    job: IngestSheetVersionJob,
    blobs: BlobStore,
    docs: DocStore,
    opts: Options,
    paths: _Paths,
    workdir: str,
    kind: str,
    src: str,
    index: int,
    sid: str,
    prog: _Progress,
    n_done: int,
    vdoc: dict[str, Any],
) -> PageOutcome:
    prog.page(n_done, sid, "ingest", 0)
    out_rel = f"out/p{index}"
    args: dict[str, Any] = {
        "kind": kind,
        "path": src,
        "index": index,
        "outDir": out_rel,
        "dpi": opts.dpi,
        "ocr": opts.ocr,
        "tiles": opts.tiles,
        "sheet": sid,
        "contribution": f"{job.versionId}:{sid}",
        "glyphStore": _load_glyph_store(blobs, job.orgId) if (opts.glyph_store and kind == "pdf") else None,
    }
    res = run_task("page", args, workdir=workdir, limits=opts.limits, on_progress=lambda st, pct: prog.page(n_done, sid, st, pct))
    # outputs: validate every child-reported path (regular file inside the workdir), then upload
    pre = paths.artifacts(sid)
    out_dir = str(res["outDir"])
    files: list[tuple[str, str, str]] = []
    for rel in res.get("tileFiles") or []:
        files.append((f"{out_dir}/{rel}", pre + rel, "image/webp"))
    files.append((f"{out_dir}/{res['thumbnail']}", pre + "thumbnail.webp", "image/webp"))
    files.append((f"{out_dir}/primitives.msgpack.gz", pre + "primitives.msgpack.gz", "application/gzip"))
    files.append((f"{out_dir}/text.json.gz", pre + "text.json.gz", "application/gzip"))
    for rel, dest, ctype in files:
        if not (dest.startswith(pre) and dest.endswith((".webp", ".gz"))):
            raise IngestError(E.PARSE_CRASHED, "parser reported an invalid artifact name")
        blobs.write(dest, Path(safe_output_path(workdir, rel)).read_bytes(), ctype, cache_control=IMMUTABLE)
    if opts.glyph_store:
        _merge_glyph_delta(blobs, job.orgId, res.get("glyphDelta"))

    understanding: dict[str, Any] | None = None
    if opts.understand:
        regions_for = (
            list(vdoc.get("regions") or []) if (job.is_reprocess and vdoc.get("regions")) else list(res.get("regions") or [])
        )
        understanding = _understand(job, blobs, docs, opts, paths, workdir, kind, src, index, sid, prog, n_done, res, regions_for)

    tiles_meta = dict(res["tiles"])
    tiles = {
        "prefix": pre + "tiles/",
        **{k: tiles_meta[k] for k in ("format", "tileSize", "dpi", "levels", "widthPx", "heightPx")},
    }
    page = res["page"]
    stats: dict[str, Any] = {k: int(res["stats"].get(k, 0)) for k in ("paths", "segments", "textLines", "glyphs")}
    vfields: dict[str, Any] = {
        "status": "ready",
        "progress": {"stage": "done", "pct": 100},
        "error": None,
        "page": {"widthMm": page["widthMm"], "heightMm": page["heightMm"], "rotation": int(page.get("rotation", 0)) % 360},
        "artifacts": {
            "tiles": tiles,
            "thumbnail": pre + "thumbnail.webp",
            "primitives": pre + "primitives.msgpack.gz",
            "text": pre + "text.json.gz",
        },
        "stats": stats,
        "workerVersion": WORKER_VERSION,
        "sourceSha256": job.sha256,
        "jobId": job.jobId,
        "updatedAt": SERVER_TIMESTAMP,
    }
    region_floors: dict[str, str] = {}
    if understanding is not None:
        vfields["artifacts"].update(understanding["artifacts"])
        stats.update(understanding["stats"])
        region_floors = understanding.get("regionFloors") or {}
    # reprocess: the API copied the user's regions from the previous version — keep them
    if not (job.is_reprocess and vdoc.get("regions")):
        vfields["regions"] = [
            {**r, "floor": region_floors.get(str(r.get("id")), r.get("floor"))} for r in list(res.get("regions") or [])[:8]
        ]
    docs.set(paths.version(sid), vfields)

    cls = _clean_classification(res["classification"])  # discipline/floors/title/scale/confidence/level/reasons (no PII)
    sheet = docs.get(paths.sheet(sid)) or {}
    sfields: dict[str, Any] = {"classification": cls, "updatedAt": SERVER_TIMESTAMP}
    if not job.is_reprocess or sheet.get("currentVersionId") in (None, job.versionId):
        sfields["currentVersionId"] = job.versionId
    if not sheet.get("confirmed"):  # the worker never overwrites a user's confirmation
        floors = list(cls["floors"])
        if region_floors and vfields.get("regions"):
            # Sprint 4: floors inferred from the construction plans' walls (still "קומה לא ודאית" until confirmed)
            floors = list(dict.fromkeys(str(r["floor"]) for r in vfields["regions"] if r.get("floor"))) or floors
        sfields.update(
            {
                "title": cls["sheetTitle"],
                "discipline": cls["discipline"],
                "floors": floors[:16],
                "scaleDenominator": _scale(res.get("scaleDenominator")),
            }
        )
    docs.set(paths.sheet(sid), sfields)
    log.info(
        "job %s page %d ready: %s %s 1:%s %s (%d tiles, %s)",
        job.jobId,
        index,
        res.get("discipline"),
        res.get("floors"),
        res.get("scaleDenominator"),
        cls.get("level"),
        len(res.get("tileFiles") or []),
        res.get("timings"),
    )
    if understanding is not None:
        res["understanding"] = understanding["summary"]
    return PageOutcome(index, sid, "ready", tiles=len(res.get("tileFiles") or []), result=res)


# ----------------------------------------------------------------------------- Sprint 2
_UNDERSTAND_FILE = re.compile(
    r"^(legend\.json\.gz|detections\.json\.gz|rooms\.json\.gz|legend/le_[A-Za-z0-9_-]{1,120}\.webp|unknown/u_[A-Za-z0-9_-]{1,120}\.webp)$"
)
_SIG = re.compile(r"^[A-Za-z0-9_-]{8,128}$")


def _list_docs(docs: DocStore, collection: str) -> list[tuple[str, dict[str, Any]]]:
    lister = getattr(docs, "list_docs", None)
    if lister is None:
        return []
    try:
        out: list[tuple[str, dict[str, Any]]] = lister(collection)
        return out
    except Exception:  # memory: never fail a page for the "learn once" lookup
        log.warning("listing %s failed", collection, exc_info=True)
        return []


def load_mappings(docs: DocStore, org_id: str, project_id: str) -> dict[str, dict[str, Any]]:
    """signature → remembered decision: the org's ``symbolMappings`` ("learn once, reuse"), overridden
    by this project's confirmed / ignored legend entries (which the worker links to)."""
    out: dict[str, dict[str, Any]] = {}
    for sig, m in _list_docs(docs, f"orgs/{org_id}/symbolMappings"):
        if _SIG.match(sig) and isinstance(m, dict) and m.get("class"):
            out[sig] = {
                "class": str(m["class"]),
                "itemCode": m.get("itemCode"),
                "label": str(m.get("label") or "")[:300],
                "status": "mapping",
            }
    for eid, e in _list_docs(docs, f"orgs/{org_id}/projects/{project_id}/legendEntries"):
        st = e.get("status") if isinstance(e, dict) else None
        esig = e.get("signature") if isinstance(e, dict) else None
        if st in ("confirmed", "ignored") and isinstance(esig, str) and _SIG.match(esig):
            out[esig] = {
                "class": e.get("class") if st == "confirmed" else None,
                "itemCode": e.get("itemCode"),
                "label": str(e.get("label") or "")[:300],
                "status": st,
                "entryId": eid,
            }
    return out


def _understand(
    job: IngestSheetVersionJob,
    blobs: BlobStore,
    docs: DocStore,
    opts: Options,
    paths: _Paths,
    workdir: str,
    kind: str,
    src: str,
    index: int,
    sid: str,
    prog: _Progress,
    n_done: int,
    page_res: dict[str, Any],
    regions: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """legend → detect → rooms in the sandbox; upload the artifacts; write ``legendEntries``.

    Best effort: a failure of this stage leaves the page ``ready`` without understanding artifacts
    (logged); only storage errors are retried."""
    prog.page(n_done, sid, "legend", 88)
    sheet = docs.get(paths.sheet(sid)) or {}
    cls = _clean_classification(page_res.get("classification") or {})
    discipline = sheet.get("discipline") if sheet.get("confirmed") else cls.get("discipline")
    scale = _scale(sheet.get("scaleDenominator")) if sheet.get("confirmed") else _scale(page_res.get("scaleDenominator"))
    out_rel = f"out/u{index}"
    args: dict[str, Any] = {
        "kind": kind,
        "path": src,
        "index": index,
        "pageDir": str(page_res["outDir"]),
        "outDir": out_rel,
        "sheet": sid,
        "discipline": discipline,
        "scaleDenominator": scale,
        "regions": regions,
        "mappings": load_mappings(docs, job.orgId, job.projectId),
        "detect": True,
        "rooms": opts.understand_rooms,
        # Sprint 3: the owner's confirmation makes the regions' floors authoritative (no "קומה לא ודאית")
        "floorsConfirmed": bool(sheet.get("confirmed")),
        # Sprint 4: walls of the project's construction / architecture plans (wall borrowing + floor inference)
        "referenceWalls": _reference_walls_files(job, blobs, docs, sid, discipline, workdir, f"refs/u{index}"),
    }
    try:
        res = run_task(
            "understand", args, workdir=workdir, limits=opts.limits, on_progress=lambda st, pct: prog.page(n_done, sid, st, pct)
        )
    except IngestError as e:
        if e.retryable:
            raise
        log.warning("job %s page %d: understanding failed (%s); page kept without it", job.jobId, index, e.code)
        return None
    pre = paths.artifacts(sid)
    out_dir = str(res["outDir"])
    for f in res.get("files") or []:
        rel = str(f.get("path", ""))
        if not _UNDERSTAND_FILE.match(rel):
            raise IngestError(E.PARSE_CRASHED, "understanding reported an invalid artifact name")
        ctype = "image/webp" if rel.endswith(".webp") else "application/gzip"
        blobs.write(pre + rel, Path(safe_output_path(workdir, f"{out_dir}/{rel}")).read_bytes(), ctype, cache_control=IMMUTABLE)
    legend = res.get("legend") or {}
    if _refine_labels(job, blobs, docs, opts, pre, legend):
        blobs.write(pre + "legend.json.gz", _gz_json(legend), "application/gzip", cache_control=IMMUTABLE)
    links: dict[str, str] = {str(k): str(v) for k, v in (res.get("legendLinks") or {}).items()}
    _write_legend_entries(job, docs, sid, pre, legend.get("entries") or [], links, args["mappings"])
    stats: dict[str, Any] = {
        "detections": _clean_det_stats(res.get("detectionStats") or {}),
        "rooms": max(0, int(res.get("rooms") or 0)),
        "legendEntries": max(0, int(res.get("legendEntries") or 0)),
    }
    artifacts = {"legend": pre + "legend.json.gz", "detections": pre + "detections.json.gz", "rooms": pre + "rooms.json.gz"}
    # Sprint 3 (Worker-A): switch↔luminaire link graph, reported under its own key on lighting sheets
    links_file = res.get("linksFile")
    if links_file is not None:
        if links_file != LINKS_FILE:
            raise IngestError(E.PARSE_CRASHED, "understanding reported an invalid links artifact name")
        data = Path(safe_output_path(workdir, f"{out_dir}/{LINKS_FILE}")).read_bytes()
        blobs.write(pre + LINKS_FILE, data, "application/gzip", cache_control=IMMUTABLE)
        artifacts["links"] = pre + LINKS_FILE
        stats["links"] = _clean_link_stats(res.get("linkStats") or {})
    # Sprint 4 (Worker-A/B): extended fixture records next to detections.json.gz (not in the strict
    # SheetVersion.artifacts yet: readers find it by name under the version prefix)
    fx_file = res.get("fixturesFile")
    if fx_file is not None:
        if fx_file != FIXTURES_FILE:
            raise IngestError(E.PARSE_CRASHED, "understanding reported an invalid fixtures artifact name")
        data = Path(safe_output_path(workdir, f"{out_dir}/{FIXTURES_FILE}")).read_bytes()
        blobs.write(pre + FIXTURES_FILE, data, "application/gzip", cache_control=IMMUTABLE)
        if FIXTURES_IN_ARTIFACTS:
            artifacts["fixtures"] = pre + FIXTURES_FILE
    # Sprint 4 (Worker-B's rooms.reference): walls of construction / architecture plans, borrowed by later sheets
    walls_file = res.get("wallsFile")
    if walls_file is not None:
        if walls_file != WALLS_FILE:
            raise IngestError(E.PARSE_CRASHED, "understanding reported an invalid walls artifact name")
        data = Path(safe_output_path(workdir, f"{out_dir}/{WALLS_FILE}")).read_bytes()
        blobs.write(pre + WALLS_FILE, data, "application/gzip", cache_control=IMMUTABLE)
        if FIXTURES_IN_ARTIFACTS:
            artifacts["walls"] = pre + WALLS_FILE
    region_floors = _clean_region_floors(res.get("regionFloors"), regions)
    return {
        "regionFloors": region_floors,
        "artifacts": artifacts,
        "stats": stats,
        "summary": {
            "legendEntries": stats["legendEntries"],
            "labels": [str(e.get("label", ""))[:80] for e in (legend.get("entries") or [])][:200],
            "detections": stats["detections"],
            "rooms": stats["rooms"],
            "timings": res.get("timings"),
            "detected": bool(res.get("detected")),
        },
    }


LLM_LABEL_BELOW = 0.6
LLM_LABEL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"label": {"type": "string", "minLength": 1, "maxLength": 200}},
    "required": ["label"],
    "additionalProperties": False,
}


def _gz_json(obj: Any) -> bytes:
    import gzip
    import json

    return gzip.compress(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode(), mtime=0)


def _gateway(opts: Options, blobs: BlobStore, docs: DocStore) -> Any:
    if opts.llm is not None:
        return opts.llm
    try:
        from ..llm_gateway import docstore_settings_reader, from_env
    except ImportError:  # pragma: no cover
        return None
    return from_env(docstore_settings_reader(docs), blobs=blobs)


def _refine_labels(
    job: IngestSheetVersionJob, blobs: BlobStore, docs: DocStore, opts: Options, pre: str, legend: dict[str, Any]
) -> bool:
    """Low-confidence legend labels → the LLM gateway (purpose ``legend_label``, region ``legend_row``,
    the entry's crop only — never the title block). Works (no-op) when the gateway is disabled.
    LLM-derived labels are capped below green confidence (SEC-33). Returns True when a label changed."""
    from ..legend.classes import suggest_class

    low = [e for e in legend.get("entries") or [] if float(e.get("labelConfidence") or 0) < LLM_LABEL_BELOW and e.get("thumb")]
    if not low:
        return False
    gw = _gateway(opts, blobs, docs)
    if gw is None or not getattr(gw, "globally_enabled", False):
        return False
    changed = False
    for e in low[: opts.llm_max_labels]:
        try:
            img = blobs.read(pre + str(e["thumb"]))
        except BlobNotFound:
            continue
        r = gw.call(
            job.orgId,
            "legend_label",
            [img],
            {"currentReading": str(e.get("label", ""))[:200]},
            LLM_LABEL_SCHEMA,
            region_kind="legend_row",
        )
        if r.status != "ok" or not isinstance(r.data, dict):
            if r.status in ("disabled", "budget_exceeded"):
                break
            continue
        label = str(r.data.get("label", "")).strip()[:300]
        if not label or label == e.get("label"):
            continue
        cls, conf = suggest_class(label, 0.8)
        e["label"] = label
        e["labelConfidence"] = 0.8
        if cls and (e.get("classConfidence") or 0) < 0.95:
            e["suggestedClass"], e["classConfidence"] = cls, min(conf, 0.8)
        changed = True
    return changed


LINKS_FILE = "links.json.gz"
FIXTURES_FILE = "fixtures.json.gz"
WALLS_FILE = "walls.json.gz"  # kamutan.walls/1 — SheetVersion.artifacts.walls (readers fall back to the name)
# contracts SheetVersion.artifacts.fixtures / .walls (optional, Sprint 4 integration)
FIXTURES_IN_ARTIFACTS = True
# sheets whose walls the others borrow, best source first (a master plan also shows demolished walls)
WALL_SOURCES = {"construction": 0, "architecture": 1, "architecture_master": 2, "master": 2}
MAX_REFERENCE_SHEETS = 8
_FLOOR = re.compile(r"^[^\x00-\x1f\x7f]{1,32}$")


def _reference_walls_files(
    job: IngestSheetVersionJob, blobs: BlobStore, docs: DocStore, sid: str, discipline: Any, workdir: str, rel_dir: str
) -> list[str]:
    """Copy ``walls.json.gz`` of the project's other current construction / architecture versions into the workdir
    (construction first); returns the relative paths for the ``understand`` task. Construction sheets borrow from
    nobody (they are the plans of record); a master sheet borrows from construction / architecture only."""
    if discipline == "construction":
        return []
    mine = WALL_SOURCES.get(str(discipline))
    cands: list[tuple[int, str, str]] = []
    for osid, s in _list_docs(docs, f"{job.project_path}/sheets"):
        if osid == sid or not isinstance(s, dict):
            continue
        rank = WALL_SOURCES.get(str(s.get("discipline")))
        vid = s.get("currentVersionId")
        if rank is None or not isinstance(vid, str) or not vid or (mine is not None and rank >= mine):
            continue
        cands.append((rank, osid, vid))
    out: list[str] = []
    for _, osid, vid in sorted(cands)[:MAX_REFERENCE_SHEETS]:
        try:
            data = blobs.read(version_prefix(job.orgId, job.projectId, osid, vid) + WALLS_FILE)
        except BlobNotFound:
            continue
        if len(data) > 20 * 1024 * 1024:
            continue
        rel = f"{rel_dir}/{len(out)}.json.gz"
        dest = Path(workdir) / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        out.append(rel)
    return out


def _clean_region_floors(raw: Any, regions: list[dict[str, Any]]) -> dict[str, str]:
    """``regionFloors`` from the sandbox (untrusted): only known region ids, floor strings like the contracts'."""
    ids = {str(r.get("id")) for r in regions}
    if not isinstance(raw, dict):
        return {}
    return {str(k): str(v) for k, v in raw.items() if str(k) in ids and isinstance(v, str) and _FLOOR.match(v)}


def _clean_link_stats(d: dict[str, Any]) -> dict[str, Any]:
    """``linkStats`` from the sandbox (untrusted): non-negative ints, ``byKind`` limited to the contract kinds."""

    def n(v: Any) -> int:
        return max(0, int(v)) if isinstance(v, int | float) and not isinstance(v, bool) else 0

    out: dict[str, Any] = {
        k: n(d.get(k))
        for k in (
            "groups",
            "green",
            "yellow",
            "red",
            "arcs",
            "danglingEnds",
            "inferredSwitches",
            "unlinkedSwitches",
            "unlinkedLuminaires",
        )
    }
    raw = d.get("byKind")
    by: dict[str, Any] = raw if isinstance(raw, dict) else {}
    out["byKind"] = {k: n(v) for k, v in by.items() if k in ("single", "two_way", "shared", "sensor", "add_to_existing")}
    return out


def _clean_det_stats(d: dict[str, Any]) -> dict[str, Any]:
    def n(v: Any) -> int:
        return max(0, int(v)) if isinstance(v, int | float) else 0

    raw = d.get("byClass")
    by: dict[str, Any] = raw if isinstance(raw, dict) else {}
    return {
        "total": n(d.get("total")),
        "green": n(d.get("green")),
        "yellow": n(d.get("yellow")),
        "red": n(d.get("red")),
        "unknown": n(d.get("unknown")),
        "byClass": {str(k)[:64]: n(v) for k, v in list(by.items())[:64]},
    }


def _write_legend_entries(
    job: IngestSheetVersionJob,
    docs: DocStore,
    sid: str,
    pre: str,
    entries: list[dict[str, Any]],
    links: dict[str, str],
    mappings: dict[str, dict[str, Any]],
) -> None:
    """``legendEntries/{entryId}`` as ``suggested``. Never overwrites a confirmed / ignored entry, and
    does not create a new one when a confirmed / ignored entry with the same signature exists (the
    detections link to that entry instead)."""
    base = f"{job.project_path}/legendEntries"
    for e in entries:
        eid = str(e.get("id", ""))
        if not re.match(r"^le_[A-Za-z0-9_-]{1,125}$", eid) or eid in links:
            continue
        sig = str(e.get("signature", ""))
        if not _SIG.match(sig):
            continue
        cur = docs.get(f"{base}/{eid}")
        if cur is not None and cur.get("status") in ("confirmed", "ignored"):
            continue
        m = mappings.get(sig)
        thumb = e.get("thumb")
        docs.set(
            f"{base}/{eid}",
            {
                "sheetId": sid,
                "versionId": job.versionId,
                "label": str(e.get("label", ""))[:300],
                "labelConfidence": max(0.0, min(1.0, float(e.get("labelConfidence") or 0.0))),
                "suggestedClass": e.get("suggestedClass"),
                "class": None,
                "itemCode": (m or {}).get("itemCode") if (m or {}).get("status") == "mapping" else None,
                "signature": sig,
                "thumbPath": (pre + thumb) if isinstance(thumb, str) and _UNDERSTAND_FILE.match(thumb) else None,
                "status": "suggested",
                "updatedAt": SERVER_TIMESTAMP,
            },
            merge=False,
        )


__all__ = ["CONTENT_TYPES", "WORKER_VERSION", "JobOutcome", "Options", "PageOutcome", "process_sheet_version"]
