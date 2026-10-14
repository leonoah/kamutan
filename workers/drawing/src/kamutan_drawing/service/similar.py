"""Job ``symbols.find_similar`` ("learn from correction"): orchestrator side.

Payload (topic ``ingest``, contracts ``FindSimilarJob``)::

    {schemaVersion: 1, type: "symbols.find_similar", jobId, orgId, projectId, searchId,
     exemplar: {sheetId, versionId, bboxMm {x,y,w,h}, class|null}, scope: "sheet"|"project",
     maxCandidates (1..500), traceparent}

Flow (identity here, every byte of drawing data is read in the parser sandbox — task ``find_similar``,
:func:`kamutan_drawing.symbols.similar.run`):

1. ``jobs/{jobId}`` and ``similarSearches/{searchId}`` (created ``queued`` by the API) must exist and
   belong to the org/project (else ``invalid_payload``, nothing written); a search already ``succeeded``
   → redelivery no-op.
2. The exemplar's sheet + version must exist and be ``ready`` with ``artifacts.primitives`` (else
   ``invalid_payload``). Targets: ``scope == "sheet"`` → the exemplar's version; ``"project"`` → the
   exemplar's version + the current ``ready`` version of every other sheet of the project.
3. Per target, the stored worker artifacts (``primitives``, ``text``, ``legend``, ``detections``; paths
   must lie under the version's own prefix) are copied into a fresh workdir and the sandbox searches.
4. Crops → ``orgs/{o}/projects/{p}/similar/{searchId}/{candidateId}.webp`` (contracts
   ``storagePaths.similarThumb``); the worker fills the contract fields of ``SimilarSearch`` only:
   ``status`` running → succeeded | failed, ``candidates [{id "c_{rank}", sheetId, versionId, centerMm,
   bboxMm, score, alreadyDetected, currentClass, thumb "{id}.webp"|null}]`` (score desc), ``thumbs`` (number
   of crops written), ``finishedAt``, ``error``. Search statistics go to the job doc's ``result``.

Errors follow the ingest semantics (retryable → job back to ``queued`` and HTTP 500 until
:data:`MAX_ATTEMPTS`; non-retryable → ``failed``, HTTP 200). An exemplar box without strokes is not an
error: the search succeeds with no candidates and ``stats.reason = "empty_exemplar"``.
"""

from __future__ import annotations

import logging
import re
import shutil
import tempfile
import time
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .. import errors as E
from ..errors import IngestError
from ..pipeline.artifacts import version_prefix
from ..sandbox.runner import Limits, run_task, safe_output_path
from ..stores.base import SERVER_TIMESTAMP, BlobNotFound, BlobStore, DocStore

log = logging.getLogger(__name__)

FIND_SIMILAR_TYPE = "symbols.find_similar"
MAX_ATTEMPTS = 5
MAX_TARGETS = 200
MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
ARTIFACT_FILES = {
    "primitives": "primitives.msgpack.gz",
    "text": "text.json.gz",
    "legend": "legend.json.gz",
    "detections": "detections.json.gz",
}
THUMB_CACHE = "private, max-age=31536000, immutable"
_THUMB_NAME = re.compile(r"^c_[0-9]{1,4}\.webp$")
DOC_ID = r"^[A-Za-z0-9_-]+$"
DocId = Field(min_length=1, max_length=128, pattern=DOC_ID)
Traceparent = Annotated[str, Field(pattern=r"^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$")] | None


class BBoxMm(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    x: float
    y: float
    w: float = Field(gt=0)
    h: float = Field(gt=0)


class SimilarExemplar(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    sheetId: str = DocId
    versionId: str = DocId
    bboxMm: BBoxMm
    class_: Annotated[str, Field(max_length=64, pattern=r"^[a-z0-9_]+$")] | None = Field(alias="class")

    @field_validator("bboxMm")
    @classmethod
    def _size(cls, b: BBoxMm) -> BBoxMm:
        if b.w > 200 or b.h > 200:
            raise ValueError("exemplar box larger than 200 mm")
        return b


class FindSimilarJob(BaseModel):
    """Topic ``ingest``, type ``symbols.find_similar`` (mirror of contracts ``FindSimilarJob``)."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schemaVersion: Literal[1]
    type: Literal["symbols.find_similar"]
    jobId: str = DocId
    orgId: str = DocId
    projectId: str = DocId
    searchId: str = DocId
    exemplar: SimilarExemplar
    scope: Literal["sheet", "project"]
    maxCandidates: int = Field(ge=1, le=500)
    traceparent: Traceparent

    @property
    def project_path(self) -> str:
        return f"orgs/{self.orgId}/projects/{self.projectId}"

    @property
    def search_id(self) -> str:
        return self.searchId


def search_doc_path(job: FindSimilarJob) -> str:
    return f"{job.project_path}/similarSearches/{job.search_id}"


def thumbs_prefix(job: FindSimilarJob) -> str:
    return f"{job.project_path}/similar/{job.search_id}/"


def _list(docs: DocStore, collection: str) -> list[tuple[str, dict[str, Any]]]:
    lister = getattr(docs, "list_docs", None)
    if lister is None:
        return []
    out: list[tuple[str, dict[str, Any]]] = lister(collection)
    return out


def _scale(v: Any) -> int | None:
    try:
        k = int(v)
    except (TypeError, ValueError):
        return None
    return k if 1 <= k <= 10_000 else None


def _target(job: FindSimilarJob, docs: DocStore, sheet_id: str, version_id: str, sheet: dict[str, Any]) -> dict[str, Any] | None:
    v = docs.get(f"{job.project_path}/sheets/{sheet_id}/versions/{version_id}")
    if not v or v.get("status") != "ready":
        return None
    arts = v.get("artifacts") or {}
    pre = version_prefix(job.orgId, job.projectId, sheet_id, version_id)
    files: dict[str, str] = {}
    for key, name in ARTIFACT_FILES.items():
        p = arts.get(key)
        if isinstance(p, str) and p.startswith(pre) and ".." not in p:
            files[name] = p
        elif key in ("legend", "detections", "text") and isinstance(arts.get("primitives"), str):
            files[name] = pre + name  # older versions: next to the primitives (optional, may be missing)
    if "primitives.msgpack.gz" not in files:
        return None
    return {
        "sheetId": sheet_id,
        "versionId": version_id,
        "scaleDenominator": _scale(sheet.get("scaleDenominator")),
        "files": files,
    }


def resolve_targets(job: FindSimilarJob, docs: DocStore) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    ex = job.exemplar
    sheet = docs.get(f"{job.project_path}/sheets/{ex.sheetId}")
    if sheet is None:
        raise IngestError(E.INVALID_PAYLOAD, "exemplar sheet not found", retryable=False)
    exemplar = _target(job, docs, ex.sheetId, ex.versionId, sheet)
    if exemplar is None:
        raise IngestError(E.INVALID_PAYLOAD, "exemplar version not found or not ready", retryable=False)
    targets = [exemplar]
    if job.scope == "project":
        for sid, s in sorted(_list(docs, f"{job.project_path}/sheets")):
            if sid == ex.sheetId or not isinstance(s, dict):
                continue
            vid = s.get("currentVersionId")
            if not isinstance(vid, str) or not re.match(DOC_ID, vid):
                continue
            t = _target(job, docs, sid, vid, s)
            if t is not None:
                targets.append(t)
            if len(targets) >= MAX_TARGETS:
                break
    return exemplar, targets


def _download(blobs: BlobStore, targets: list[dict[str, Any]], workdir: Path) -> None:
    for i, t in enumerate(targets):
        d = workdir / "in" / f"t{i}"
        d.mkdir(parents=True, exist_ok=True)
        for name, path in t["files"].items():
            try:
                data = blobs.read(path)
            except BlobNotFound:
                if name == "primitives.msgpack.gz":
                    raise IngestError(E.STORAGE_UNAVAILABLE, "artifact storage object vanished") from None
                continue
            if len(data) > MAX_ARTIFACT_BYTES:
                raise IngestError(E.TOO_LARGE, "stored artifact too large", retryable=False)
            (d / name).write_bytes(data)
        t["dir"] = f"in/t{i}"


def run_search(
    job: FindSimilarJob,
    blobs: BlobStore,
    docs: DocStore,
    *,
    limits: Limits | None = None,
    workdir_root: str | None = None,
    on_progress: Any = None,
) -> dict[str, Any]:
    """Resolve, download, search in the sandbox, upload the thumbs. Returns the result doc fields."""
    t0 = time.monotonic()
    exemplar, targets = resolve_targets(job, docs)
    wd = Path(tempfile.mkdtemp(prefix="kamutan-similar-", dir=workdir_root))
    try:
        _download(blobs, targets, wd)
        b = job.exemplar.bboxMm
        args = {
            "exemplar": {
                **{k: exemplar[k] for k in ("sheetId", "versionId", "scaleDenominator", "dir")},
                "bboxMm": b.model_dump(),
                "class": job.exemplar.class_,
            },
            "targets": [{k: t[k] for k in ("sheetId", "versionId", "scaleDenominator", "dir")} for t in targets],
            "outDir": "out",
            "thumbs": True,
            "maxCandidates": job.maxCandidates,
        }
        res = run_task("find_similar", args, workdir=str(wd), limits=limits or Limits(), on_progress=on_progress)
        if not isinstance(res, dict):
            raise IngestError(E.PARSE_CRASHED, "similarity search returned no result")
        prefix = thumbs_prefix(job)
        names = {str(k): str(v) for k, v in (res.get("thumbs") or {}).items()}
        out_dir = str(res.get("outDir") or "out")
        cands: list[dict[str, Any]] = []
        written = 0
        for n, raw in enumerate((res.get("candidates") or [])[: job.maxCandidates]):
            c = _clean_candidate(raw)
            if c is None:
                continue
            cid = f"c_{len(cands)}"
            c = {"id": cid, **c, "thumb": None}
            name = names.get(str(n))
            if name is not None:
                if not _THUMB_NAME.match(name) or name != f"c_{n}.webp":
                    raise IngestError(E.PARSE_CRASHED, "similarity search reported an invalid thumb name")
                data = Path(safe_output_path(str(wd), f"{out_dir}/{name}")).read_bytes()
                blobs.write(f"{prefix}{cid}.webp", data, "image/webp", cache_control=THUMB_CACHE)
                c["thumb"] = f"{cid}.webp"
                written += 1
            cands.append(c)
    finally:
        shutil.rmtree(wd, ignore_errors=True)
    st = res.get("stats") or {}
    stats = {
        "sheets": len(targets),
        "candidates": len(cands),
        "alreadyDetected": sum(1 for c in cands if c["alreadyDetected"]),
        "truncated": bool(st.get("truncated", False)),
        "searchMs": int(float(st.get("seconds", 0.0)) * 1000),
        "durationMs": int((time.monotonic() - t0) * 1000),
        **({"reason": str(st["reason"])[:64]} if st.get("reason") else {}),
    }
    return {"candidates": cands, "thumbs": written, "stats": stats}


def _num(v: Any, lo: float = -1e5, hi: float = 1e5) -> float:
    x = float(v)
    if not lo <= x <= hi:
        raise ValueError("out of range")
    return x


def _clean_candidate(c: Any) -> dict[str, Any] | None:
    """Child output is untrusted: keep only the contract fields, typed and bounded."""
    try:
        sid, vid = str(c["sheetId"]), str(c["versionId"])
        if not re.match(DOC_ID, sid) or not re.match(DOC_ID, vid):
            return None
        ad = c.get("alreadyDetected")
        cc = c.get("currentClass")
        return {
            "sheetId": sid,
            "versionId": vid,
            "centerMm": {"x": _num(c["centerMm"]["x"]), "y": _num(c["centerMm"]["y"])},
            "bboxMm": {
                "x": _num(c["bboxMm"]["x"]),
                "y": _num(c["bboxMm"]["y"]),
                "w": _num(c["bboxMm"]["w"], 0, 1e4),
                "h": _num(c["bboxMm"]["h"], 0, 1e4),
            },
            "score": round(_num(c["score"], 0, 1), 3),
            "alreadyDetected": str(ad)[:128] if ad is not None else None,
            "currentClass": str(cc)[:64] if cc is not None else None,
        }
    except (KeyError, TypeError, ValueError):
        return None


def run_find_similar(
    job: FindSimilarJob,
    blobs: BlobStore,
    docs: DocStore,
    *,
    limits: Limits | None = None,
    workdir_root: str | None = None,
) -> dict[str, Any]:
    job_path = f"jobs/{job.jobId}"
    sp = search_doc_path(job)
    jd = docs.get(job_path)
    if jd is None:
        raise IngestError(E.INVALID_PAYLOAD, "job document not found", retryable=False)
    if jd.get("orgId") != job.orgId or jd.get("projectId", job.projectId) != job.projectId:
        raise IngestError(E.INVALID_PAYLOAD, "job does not belong to this org/project", retryable=False)
    sd = docs.get(sp)
    if sd is None:
        raise IngestError(E.INVALID_PAYLOAD, "similar-search document not found", retryable=False)
    if sd.get("status") == "succeeded":
        docs.set(job_path, {"status": "succeeded", "progress": {"stage": "done", "pct": 100}, "updatedAt": SERVER_TIMESTAMP})
        return {"status": "skipped"}
    attempts = int(jd.get("attempts") or 0) + 1
    docs.set(
        job_path,
        {
            "status": "running",
            "attempts": attempts,
            "progress": {"stage": "similar", "pct": 5},
            "error": None,
            "updatedAt": SERVER_TIMESTAMP,
        },
    )
    docs.set(sp, {"status": "running", "error": None})
    last = [0.0]

    def prog(stage: str, pct: int) -> None:
        now = time.monotonic()
        if now - last[0] >= 2.0:
            last[0] = now
            docs.set(
                job_path, {"progress": {"stage": "similar", "pct": max(5, min(99, int(pct)))}, "updatedAt": SERVER_TIMESTAMP}
            )

    try:
        out = run_search(job, blobs, docs, limits=limits, workdir_root=workdir_root, on_progress=prog)
    except Exception as e:
        if isinstance(e, IngestError):
            err = e
        elif isinstance(e, BlobNotFound):
            err = IngestError(E.STORAGE_UNAVAILABLE, "artifact storage object vanished")
        else:
            log.exception("find_similar %s crashed", job.jobId)
            err = IngestError(E.INTERNAL, f"internal error ({type(e).__name__})", retryable=True)
        if err.retryable and attempts >= MAX_ATTEMPTS:
            err = IngestError(err.code, f"{err.message} (gave up after {attempts} attempts)", retryable=False)
        final = not err.retryable
        docs.set(job_path, {"status": "failed" if final else "queued", "error": err.to_doc(), "updatedAt": SERVER_TIMESTAMP})
        docs.set(
            sp,
            {"status": "failed" if final else "queued", "error": err.to_doc(), "finishedAt": SERVER_TIMESTAMP if final else None},
        )
        raise err from None
    docs.set(
        sp,
        {
            "status": "succeeded",
            "candidates": out["candidates"],
            "thumbs": out["thumbs"],
            "error": None,
            "finishedAt": SERVER_TIMESTAMP,
        },
        merge=True,
    )
    docs.set(
        job_path,
        {
            "status": "succeeded",
            "error": None,
            "progress": {"stage": "done", "pct": 100},
            "result": {"searchId": job.search_id, **out["stats"]},
            "updatedAt": SERVER_TIMESTAMP,
        },
    )
    return {"status": "succeeded", **out}


__all__ = ["FIND_SIMILAR_TYPE", "FindSimilarJob", "run_find_similar", "run_search", "search_doc_path", "thumbs_prefix"]
