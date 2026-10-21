"""Local ``export.marked_pdf`` run over the sample artifacts (dev / demo; never point it at the repo).

Reads the production layout written by ``scripts/ingest_local.py`` + ``scripts/boq_local.py`` under the artifacts
root (docs in ``_firestore/``, artifacts, the latest BOQ build + evidence) and the original uploads from the
sample folder (``{sample}/{sheetSet.name}``; ``ingest_local`` does not copy uploads into the artifacts root).
Nothing is written to the artifacts root: export / job docs and the output go to in-memory overlays; the PDF is
saved to ``--out`` and, with ``--png``, the first pages are rendered next to it for a visual check.

    uv run python scripts/export_local.py [--root DIR] [--sample DIR] [--out FILE] [--sheets id,id]
        [--watermark TEXT] [--hide-title-block] [--floor-split] [--png N]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from kamutan_drawing.export.contracts import MarkedPdfJob, output_path
from kamutan_drawing.export.job import run_marked_pdf
from kamutan_drawing.sandbox.runner import Limits
from kamutan_drawing.stores import InMemoryBlobStore, InMemoryDocStore
from kamutan_drawing.stores.base import BlobNotFound
from kamutan_drawing.stores.local import LocalBlobStore, LocalDocStore

DATA = Path("/home/claude/kamutan-data")
ORG, PROJECT = "org-demo", "p-noah"


class OverlayBlobs:
    """Reads: memory overlay → uploads mapped to the sample folder → the local artifacts root. Writes: memory."""

    def __init__(self, base: LocalBlobStore, uploads: dict[str, Path]) -> None:
        self.base, self.uploads, self.mem = base, uploads, InMemoryBlobStore()

    def read(self, path: str) -> bytes:
        if path in self.mem.blobs:
            return self.mem.read(path)
        if path in self.uploads:
            return self.uploads[path].read_bytes()
        return self.base.read(path)

    def write(self, path: str, data: bytes, content_type: str, *, cache_control: str | None = None) -> None:
        self.mem.write(path, data, content_type, cache_control=cache_control)

    def read_versioned(self, path: str) -> tuple[bytes | None, str | None]:
        try:
            return self.read(path), "0"
        except BlobNotFound:
            return None, None

    def write_if(self, path: str, data: bytes, content_type: str, *, expected: str | None) -> bool:
        self.write(path, data, content_type)
        return True

    def list(self, prefix: str) -> list[str]:
        return sorted(set(self.base.list(prefix)) | set(self.mem.list(prefix)))

    def delete(self, path: str) -> None:
        self.mem.delete(path)


class OverlayDocs:
    def __init__(self, base: LocalDocStore) -> None:
        self.base, self.mem = base, InMemoryDocStore()

    def get(self, path: str) -> dict[str, Any] | None:
        return self.mem.get(path) or self.base.get(path)

    def set(self, path: str, data: dict[str, Any], *, merge: bool = True) -> None:
        cur = self.get(path) if merge else None
        if cur is not None and self.mem.get(path) is None:
            self.mem.set(path, cur, merge=False)
        self.mem.set(path, data, merge=merge)

    def list_docs(self, collection: str, limit: int = 2000) -> list[tuple[str, dict[str, Any]]]:
        out = dict(self.base.list_docs(collection, limit))
        out.update(dict(self.mem.list_docs(collection, limit)))
        return sorted(out.items())


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(DATA / "artifacts"))
    ap.add_argument("--sample", default=str(DATA / "sample-noah"))
    ap.add_argument("--out", default=str(DATA / "debug" / "marked_noah.pdf"))
    ap.add_argument("--sheets", default=None, help="comma-separated sheet ids (default: every sheet with evidence)")
    ap.add_argument("--watermark", default=None)
    ap.add_argument("--hide-title-block", action="store_true")
    ap.add_argument("--floor-split", action="store_true")
    ap.add_argument("--png", type=int, default=0, help="render the first N pages to PNG next to --out")
    a = ap.parse_args(argv)
    root, out = Path(a.root), Path(a.out)
    for p in (root, out.parent):
        if (p / ".git").exists() or (p / "pnpm-workspace.yaml").exists() or ".git" in p.resolve().parts:
            sys.exit("refusing to use a repository directory")
    base_docs = LocalDocStore(root)
    proj = f"orgs/{ORG}/projects/{PROJECT}"
    uploads: dict[str, Path] = {}
    for sid, s in base_docs.list_docs(f"{proj}/sheetSets"):
        f = Path(a.sample) / str(s.get("name") or "")
        if s.get("storagePath") and f.is_file():
            uploads[str(s["storagePath"])] = f
    blobs, docs = OverlayBlobs(LocalBlobStore(root), uploads), OverlayDocs(base_docs)
    export_id, job_id = "local-x1", "export-local-x1"
    docs.set(f"jobs/{job_id}", {"orgId": ORG, "projectId": PROJECT, "type": "export.marked_pdf", "status": "queued"}, merge=False)
    docs.set(f"{proj}/exports/{export_id}", {"kind": "marked_pdf", "status": "queued", "createdBy": "local"}, merge=False)
    job = MarkedPdfJob.model_validate(
        {
            "schemaVersion": 1,
            "type": "export.marked_pdf",
            "jobId": job_id,
            "orgId": ORG,
            "projectId": PROJECT,
            "exportId": export_id,
            "sheetIds": a.sheets.split(",") if a.sheets else None,
            "versionIds": None,
            "options": {
                "legend": True,
                "floorSplit": a.floor_split,
                "watermark": a.watermark,
                "hideTitleBlock": a.hide_title_block,
            },
            "storagePath": output_path(ORG, PROJECT, export_id),
            "traceparent": None,
        }
    )
    t0 = time.monotonic()
    run_marked_pdf(job, blobs, docs, limits=Limits(wall_s=600))  # type: ignore[arg-type]
    pdf = blobs.read(job.storagePath)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(pdf)
    print(json.dumps({"seconds": round(time.monotonic() - t0, 1), "out": str(out), "bytes": len(pdf),
                      "export": docs.get(f"{proj}/exports/{export_id}"), "result": (docs.get(f"jobs/{job_id}") or {}).get("result")},
                     ensure_ascii=False, indent=1, default=str))  # fmt: skip
    if a.png:
        import pypdfium2 as pdfium

        doc = pdfium.PdfDocument(pdf)
        n = len(doc)
        for i in sorted({*range(min(a.png - 1, n)), n - 1}):  # the first pages + the legend page
            img = doc[i].render(scale=110 / 72).to_pil()
            p = out.with_name(f"{out.stem}_p{i + 1}.png")
            img.save(p)
            print("png:", p)
        doc.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
