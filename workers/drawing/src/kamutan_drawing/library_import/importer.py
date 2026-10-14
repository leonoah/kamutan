"""``library.import`` job: a past BOQ (.xls/.xlsx) → ``orgs/{o}/itemLibrary`` (+ a template when the org has none).

Orchestrator side (holds the identity, never parses): the workbook is parsed only in the sandbox
(task ``boq_parse``, :mod:`kamutan_drawing.library_import.parse`).

* ``jobs/{jobId}`` must exist and belong to the org (else ``invalid_payload``, nothing written); a succeeded job
  for the same ``importId`` is a redelivery → no-op.
* download ``storagePath`` (= ``orgs/{orgId}/imports/{importId}.{sourceKind}``, ≤ 20 MB) · magic bytes vs
  ``sourceKind`` (the API checked them too; the file is still untrusted).
* items → ``itemLibrary/{itemId}`` with contracts ``itemIdFor(code, description)`` =
  ``it_{code, [^A-Za-z0-9_-] → "-"}_{sha256(code + "\\n" + normalizeDescription(description))[:16]}``: the same
  item (from this or any other file) always maps to the same doc → **idempotent**, no duplicates. An existing
  ``manual`` item is never overwritten; ``active`` / ``tags`` are set on create only (a user's deactivation
  survives re-imports).
* ``boqTemplates/tpl_default`` (contracts ``BoqTemplate``, ``source: import``) from the file's structure when the
  org has no template (the API normally seeds the sample's template at bootstrap).
* ``libraryImports/{importId}`` (API-created) gets ``status`` / ``stats {items, created, updated, templates}`` /
  ``error``; ``jobs/{jobId}`` gets status / progress / result.
"""

from __future__ import annotations

import hashlib
import logging
import re
import shutil
import tempfile
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from .. import errors as E
from ..boq.contracts import LibraryImportJob
from ..errors import IngestError
from ..sandbox.runner import Limits, run_task
from ..stores.base import SERVER_TIMESTAMP, BlobNotFound, BlobStore, DocStore
from .parse import norm
from .readers import sniff

log = logging.getLogger(__name__)

MAX_IMPORT_BYTES = 20 * 1024 * 1024  # contracts MAX_LIBRARY_IMPORT_BYTES
MAX_ITEMS = 5000
MAX_ATTEMPTS = 5
DEFAULT_TEMPLATE_ID = "tpl_default"
DEFAULT_TEMPLATE_NAME = "תבנית ברירת מחדל (לפי כתב הכמויות לדוגמה)"
DEFAULT_VAT = 0.18
DEFAULT_UNIT = "יחידה"
COLUMN_KEYS = ("code", "description", "unit", "qty", "unitPrice", "total")
_CODE_RE = re.compile(r"^[0-9A-Za-z.\-/]{1,32}$")


@dataclass
class ImportOutcome:
    status: str  # succeeded | skipped
    items: int = 0
    created: int = 0
    updated: int = 0
    skipped: int = 0
    template_id: str | None = None
    template_name: str | None = None
    ambiguous_codes: list[str] = field(default_factory=list)
    flags: list[str] = field(default_factory=list)
    sha256: str | None = None
    parsed: dict[str, Any] | None = None

    def stats(self) -> dict[str, Any]:
        return {
            "items": self.items,
            "created": self.created,
            "updated": self.updated,
            "templates": int(self.template_id is not None),
            "skipped": self.skipped,
            "ambiguousCodes": self.ambiguous_codes[:1000],
            "templateName": self.template_name,
        }


def item_id(code: str, description: str) -> str:
    """contracts ``itemIdFor`` (byte-identical; tested against the TS implementation's output)."""
    slug = re.sub(r"[^A-Za-z0-9_-]", "-", code.strip())
    h = hashlib.sha256(f"{code.strip()}\n{norm(description)}".encode()).hexdigest()[:16]
    return f"it_{slug}_{h}"


def _list(docs: DocStore, collection: str) -> list[tuple[str, dict[str, Any]]]:
    lister = getattr(docs, "list_docs", None)
    if lister is None:
        return []
    out: list[tuple[str, dict[str, Any]]] = lister(collection)
    return out


def run_library_import(
    job: LibraryImportJob, blobs: BlobStore, docs: DocStore, *, limits: Limits | None = None, workdir_root: str | None = None
) -> ImportOutcome:
    job_path = f"jobs/{job.jobId}"
    imp_path = f"orgs/{job.orgId}/libraryImports/{job.importId}"
    jd = docs.get(job_path)
    if jd is None:
        raise IngestError(E.INVALID_PAYLOAD, "job document not found", retryable=False)
    if jd.get("orgId") != job.orgId:
        raise IngestError(E.INVALID_PAYLOAD, "job does not belong to this org", retryable=False)
    done = jd.get("result") if isinstance(jd.get("result"), dict) else None
    if jd.get("status") == "succeeded" and done and done.get("importId") == job.importId:
        return ImportOutcome("skipped", items=int(done.get("items") or 0), template_id=done.get("templateId"))
    has_imp = docs.get(imp_path) is not None
    attempts = int(jd.get("attempts") or 0) + 1
    docs.set(
        job_path,
        {
            "status": "running",
            "attempts": attempts,
            "progress": {"stage": "parse", "pct": 10},
            "error": None,
            "updatedAt": SERVER_TIMESTAMP,
        },
    )
    if has_imp:
        docs.set(imp_path, {"status": "running", "error": None})
    try:
        out = _run(job, blobs, docs, limits or Limits(), workdir_root)
    except Exception as e:
        if isinstance(e, IngestError):
            err = e
        else:
            log.exception("library import %s crashed", job.jobId)
            err = IngestError(E.INTERNAL, f"internal error ({type(e).__name__})", retryable=True)
        if err.retryable and attempts >= MAX_ATTEMPTS:
            err = IngestError(err.code, f"{err.message} (gave up after {attempts} attempts)", retryable=False)
        status = "queued" if err.retryable else "failed"
        docs.set(job_path, {"status": status, "error": err.to_doc(), "updatedAt": SERVER_TIMESTAMP})
        if has_imp:
            docs.set(imp_path, {"status": status, "error": err.to_doc()})
        raise err from None
    result = {
        "importId": job.importId,
        "sha256": out.sha256,
        **out.stats(),
        "templateId": out.template_id,
        "flags": out.flags[:50],
    }
    docs.set(
        job_path,
        {
            "status": "succeeded",
            "error": None,
            "progress": {"stage": "done", "pct": 100},
            "result": result,
            "updatedAt": SERVER_TIMESTAMP,
        },
    )
    if has_imp:
        docs.set(imp_path, {"status": "succeeded", "stats": out.stats(), "error": None})
    return out


def _run(job: LibraryImportJob, blobs: BlobStore, docs: DocStore, limits: Limits, workdir_root: str | None) -> ImportOutcome:
    try:
        data = blobs.read(job.storagePath)
    except BlobNotFound:
        raise IngestError(E.SOURCE_NOT_FOUND, "uploaded file not found") from None
    if len(data) > MAX_IMPORT_BYTES:
        raise IngestError(E.TOO_LARGE, "file exceeds 20 MB")
    kind = sniff(data[:8])
    if kind is None:
        raise IngestError(E.UNSUPPORTED_FORMAT, "file is not an Excel workbook (.xls / .xlsx)")
    if kind != job.sourceKind:
        raise IngestError(E.FILE_TYPE_MISMATCH, f"file content is {kind}, not {job.sourceKind}")
    sha = hashlib.sha256(data).hexdigest()
    workdir = tempfile.mkdtemp(prefix="kamutan-import-", dir=workdir_root)
    try:
        src = Path(workdir) / f"source.{kind}"
        src.write_bytes(data)
        del data
        parsed: dict[str, Any] = run_task(
            "boq_parse",
            {"path": src.name, "kind": kind},
            workdir=workdir,
            limits=replace(limits, wall_s=min(limits.wall_s, 120.0)),
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    out = write_library(job.orgId, job.importId, parsed, docs)
    out.sha256 = sha
    return out


def _s(v: Any, n: int) -> str:
    return norm(str(v if v is not None else ""))[:n]


def write_library(org_id: str, source_ref: str, parsed: dict[str, Any], docs: DocStore) -> ImportOutcome:
    """Upsert the parsed items + (maybe) the template. Firestore side only; the parse result is untrusted
    (sandbox output) and is clamped to the contracts sizes here."""
    base = f"orgs/{org_id}/itemLibrary"
    out = ImportOutcome("succeeded", parsed=parsed)
    seen: set[str] = set()
    for it in (parsed.get("items") or [])[:MAX_ITEMS]:
        if not isinstance(it, dict):
            out.skipped += 1
            continue
        code = _s(it.get("code"), 32)
        desc = _s(it.get("description"), 2000)
        chapter = _s(it.get("chapter"), 32)
        if not _CODE_RE.match(code) or not desc or not chapter:
            out.skipped += 1
            continue
        iid = item_id(code, desc)
        if iid in seen:
            out.skipped += 1
            continue
        seen.add(iid)
        flags = [_s(f, 64) for f in (it.get("flags") or [])][:10]
        out.flags.extend(f"{code}:{f}" for f in flags if f.startswith("ambiguous"))
        if "ambiguous_code" in flags:
            out.ambiguous_codes.append(code)
        fields: dict[str, Any] = {
            "code": code,
            "chapter": chapter,
            "chapterTitle": _s(it.get("chapterTitle"), 200),
            "description": desc,
            "unit": _s(it.get("unit"), 32) or DEFAULT_UNIT,
            "source": "import",
            "sourceRef": _s(source_ref, 256),
            "importFlags": flags,
        }
        cur = docs.get(f"{base}/{iid}")
        if cur is None:
            docs.set(f"{base}/{iid}", {**fields, "tags": [], "active": True, "updatedAt": SERVER_TIMESTAMP}, merge=False)
            out.created += 1
        elif cur.get("source") == "manual":
            out.skipped += 1
            continue
        elif any(cur.get(k) != v for k, v in fields.items()):
            docs.set(f"{base}/{iid}", {**fields, "updatedAt": SERVER_TIMESTAMP})
            out.updated += 1
        out.items += 1
    if not _list(docs, f"orgs/{org_id}/boqTemplates"):
        tpl = template_from(parsed, source_ref)
        if tpl is not None:
            docs.set(f"orgs/{org_id}/boqTemplates/{DEFAULT_TEMPLATE_ID}", tpl, merge=False)
            out.template_id = DEFAULT_TEMPLATE_ID
            out.template_name = str(tpl["name"])
    return out


def template_from(parsed: dict[str, Any], source_ref: str) -> dict[str, Any] | None:
    """contracts ``BoqTemplate`` from the file's structure; None when the structure is unusable."""
    items = [i for i in parsed.get("items") or [] if isinstance(i, dict)]
    prefixes: dict[str, set[str]] = {}
    for i in items:
        major = _s(i.get("code"), 32).split(".", 1)[0]
        if re.fullmatch(r"[0-9A-Za-z]{1,8}", major):
            prefixes.setdefault(_s(i.get("chapter"), 32), set()).add(major)
    chapters = []
    seen: set[str] = set()
    for c in (parsed.get("chapters") or [])[:60]:
        code = _s(c.get("code"), 32)
        key = code.lstrip("0").lower() or "0"
        if not code or key in seen:
            continue
        seen.add(key)
        title = _s(c.get("heading") or c.get("title"), 200) or f"פרק {code}"
        ch: dict[str, Any] = {"code": code, "title": title, "notes": [_s(n, 2000) for n in (c.get("notes") or [])][:50]}
        if prefixes.get(code):
            ch["codePrefixes"] = sorted(prefixes[code], key=lambda p: (len(p), p))[:8]
        chapters.append(ch)
    columns: list[dict[str, str]] = []
    for c in parsed.get("columns") or []:
        k = str(c.get("key"))
        if k in COLUMN_KEYS and k not in {x["key"] for x in columns}:
            columns.append({"key": k, "title": _s(c.get("title"), 64) or k})
    if not chapters or not {"code", "qty"} <= {c["key"] for c in columns}:
        return None
    return {
        "name": DEFAULT_TEMPLATE_NAME,
        "chapters": chapters,
        "columns": columns,
        "titleRows": [_s(t, 500) for t in (parsed.get("titleRows") or [])][:10],
        "default": True,
        "source": "import",
        "sourceRef": _s(source_ref, 256),
        "vatRate": DEFAULT_VAT,
        "updatedAt": SERVER_TIMESTAMP,
    }
