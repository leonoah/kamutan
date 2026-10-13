"""Local ingest CLI: run the real worker pipeline (sandbox included) against local-disk stores.

    python -m kamutan_drawing.cli ingest FILE [FILE ...] --out DIR [--org O --project P --set S --version V]
                                             [--dpi 300] [--no-ocr] [--no-tiles]

``DIR`` gets exactly the Storage/Firestore layout of production (``stores.local``):

* blobs: ``DIR/orgs/{o}/projects/{p}/sheets/{s}/versions/{v}/tiles/{z}/{x}_{y}.webp`` …
* docs:  ``DIR/_firestore/{document path}.json``
* plus, per sheet, ``DIR/{sheetId}/sheet.json`` + ``version.json`` (the two docs, for the golden
  runner ``benchmark/tests/golden/golden.py`` and humans).

The uploaded file itself is **not** copied: the upload path is served from the original file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .errors import IngestError
from .formats import detect_kind
from .service.contracts import IngestSheetVersionJob
from .service.pipeline import JobOutcome, Options, PageOutcome, process_sheet_version
from .stores.base import SERVER_TIMESTAMP, BlobNotFound
from .stores.local import LocalBlobStore, LocalDocStore

_SAFE = re.compile(r"[^A-Za-z0-9_-]+")


class SourceOverlay(LocalBlobStore):
    """LocalBlobStore that serves one object path from a file outside the root (no copy)."""

    def __init__(self, root: str | Path, sources: dict[str, Path]) -> None:
        super().__init__(root)
        self.sources = dict(sources)

    def read(self, path: str) -> bytes:
        src = self.sources.get(path)
        if src is not None:
            try:
                return src.read_bytes()
            except FileNotFoundError:
                raise BlobNotFound(path) from None
        return super().read(path)


@dataclass
class IngestResult:
    file: Path
    sheet_set_id: str
    outcome: JobOutcome | None
    error: dict[str, str] | None
    seconds: float
    sheets: list[dict[str, Any]] = field(default_factory=list)  # [{sheetId, sheet, version}]


def safe_id(s: str, max_len: int = 100) -> str:
    return _SAFE.sub("-", s).strip("-")[:max_len] or "file"


def ingest_file(
    path: str | Path,
    root: str | Path,
    *,
    org: str = "org-local",
    project: str = "p-local",
    sheet_set_id: str | None = None,
    version_id: str = "v1",
    options: Options | None = None,
    on_page: Any = None,
) -> IngestResult:
    """Ingest one local file into ``root`` the way the Cloud Run worker would."""
    p = Path(path)
    data = p.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    kind = detect_kind(data[:4096])
    file_kind = {"jpg": "png", None: p.suffix.lower().lstrip(".") or "pdf"}.get(kind, kind)
    set_id = sheet_set_id or safe_id(p.stem)
    job_id = safe_id(f"ingest-{set_id}-{version_id}", 128)
    upload = f"orgs/{org}/projects/{project}/uploads/{set_id}/source.{file_kind}"
    blobs = SourceOverlay(root, {upload: p})
    docs = LocalDocStore(root)
    job_doc = docs.get(f"jobs/{job_id}")
    if job_doc is None or job_doc.get("result", {}).get("sha256") != sha:
        docs.set(
            f"jobs/{job_id}",
            {
                "orgId": org,
                "projectId": project,
                "sheetSetId": set_id,
                "sheetId": None,
                "versionId": version_id,
                "type": "ingest.sheet_version",
                "status": "queued",
                "progress": {"stage": "ingest", "pct": 0},
                "attempts": 0,
                "error": None,
                "createdAt": SERVER_TIMESTAMP,
                "updatedAt": SERVER_TIMESTAMP,
            },
            merge=False,
        )
    docs.set(
        f"orgs/{org}/projects/{project}/sheetSets/{set_id}",
        {
            "orgId": org,
            "projectId": project,
            "fileKind": file_kind,
            "sha256": sha,
            "storagePath": upload,
            "status": "queued",
            "name": p.name,
            "uploadedBy": "local-cli",
            "sizeBytes": len(data),
            "ingestJobId": job_id,
            "versionId": version_id,
            "createdAt": SERVER_TIMESTAMP,
        },
    )
    del data
    job = IngestSheetVersionJob.model_validate(
        {
            "schemaVersion": 3,
            "type": "ingest.sheet_version",
            "jobId": job_id,
            "orgId": org,
            "projectId": project,
            "sheetSetId": set_id,
            "sheetId": None,
            "pageIndex": None,
            "versionId": version_id,
            "storagePath": upload,
            "sha256": sha,
            "fileKind": file_kind,
            "traceparent": None,
        }
    )
    t0 = time.monotonic()
    outcome: JobOutcome | None = None
    error: dict[str, str] | None = None
    try:
        outcome = process_sheet_version(job, blobs, docs, options, on_page=on_page)
    except IngestError as e:
        error = e.to_doc()
    res = IngestResult(p, set_id, outcome, error, round(time.monotonic() - t0, 2))
    jd = docs.get(f"jobs/{job_id}") or {}
    pages = list((jd.get("result") or {}).get("pages") or []) + list((jd.get("result") or {}).get("failedPages") or [])
    for i in sorted(set(pages)):
        sid = job.sheet_id(int(i))
        res.sheets.append(
            {
                "sheetId": sid,
                "sheet": docs.get(f"orgs/{org}/projects/{project}/sheets/{sid}") or {},
                "version": docs.get(f"orgs/{org}/projects/{project}/sheets/{sid}/versions/{version_id}") or {},
            }
        )
    return res


def write_sheet_docs(res: IngestResult, out: Path) -> None:
    for s in res.sheets:
        d = out / s["sheetId"]
        d.mkdir(parents=True, exist_ok=True)
        (d / "sheet.json").write_text(json.dumps(s["sheet"], ensure_ascii=False, indent=1))
        (d / "version.json").write_text(json.dumps(s["version"], ensure_ascii=False, indent=1))


def _page_line(o: PageOutcome) -> str:
    if o.status != "ready" or o.result is None:
        return f"  p{o.index}: {o.status} {o.error or ''} {o.seconds}s"
    r = o.result
    c = r["classification"]
    return (
        f"  p{o.index}: {r.get('discipline')} {r.get('floors')} 1:{r.get('scaleDenominator')} {c['level']} "
        f"conf={c['confidence']} regions={len(r.get('regions') or [])} tiles={o.tiles} {o.seconds}s"
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="kamutan_drawing.cli")
    sub = ap.add_subparsers(dest="cmd", required=True)
    ing = sub.add_parser("ingest", help="ingest local files into a local artifacts root")
    ing.add_argument("files", nargs="+", type=Path)
    ing.add_argument("--out", type=Path, required=True)
    ing.add_argument("--org", default="org-local")
    ing.add_argument("--project", default="p-local")
    ing.add_argument("--set", dest="sheet_set", default=None, help="sheetSetId (default: file stem); only with one file")
    ing.add_argument("--version", default="v1")
    ing.add_argument("--dpi", type=int, default=300)
    ing.add_argument("--no-ocr", action="store_true")
    ing.add_argument("--no-tiles", action="store_true")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    if a.sheet_set and len(a.files) > 1:
        ap.error("--set needs exactly one file")
    opts = Options(ocr=not a.no_ocr, dpi=a.dpi, tiles=not a.no_tiles)
    rc = 0
    for f in a.files:
        res = ingest_file(f, a.out, org=a.org, project=a.project, sheet_set_id=a.sheet_set, version_id=a.version, options=opts)
        write_sheet_docs(res, a.out)
        status = res.outcome.status if res.outcome else "failed"
        print(f"{f.name}: {status} in {res.seconds}s {res.error or ''}")
        for o in res.outcome.pages if res.outcome else []:
            print(_page_line(o))
        rc = rc or (0 if res.error is None else 1)
    return rc


if __name__ == "__main__":
    sys.exit(main())
