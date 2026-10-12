"""`process_sheet_version`: the Sprint 0 ingest job, behind storage/store interfaces.

Stages (each writes artifacts under ``job.derived_prefix``):
  1. fetch source + verify sha256
  2. ingest  -> primitives.npz, ingest_stats.json
  3. render  -> work_150.png, thumb.png, tiles/{c}_{r}.png + tiles/manifest.json
  4. text    -> text_spans.json, glyph_dictionary.json, title_block.json (SHX glyph dictionary
                labelled with local Tesseract; skipped with ocr=False)
Status: jobs/{jobId} (status/progress/stage/error) and the version doc (status, artifacts, stats).
Only PDF is supported in Sprint 0; DWG/DXF/PNG fail with a clear error code.
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import math
import tempfile
from dataclasses import asdict
from pathlib import Path
from typing import Any

from PIL import Image

from ..ingest.pdf_vector import extract_pdf, save_npz
from ..render.raster import TILE_SIZE, render_page
from .contracts import IngestSheetVersionJob
from .ports import BlobStorage, StatusStore

log = logging.getLogger(__name__)

WORK_DPI = 150


class JobError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def _png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _json(obj: Any) -> bytes:
    return json.dumps(obj, ensure_ascii=False, default=str).encode()


def _run_text_stage(pdf_bytes: bytes, vs) -> dict[str, Any]:
    from ..ocr.dictionary import GlyphDictionary, text_spans
    from ..ocr.glyphs import extract_text_lines
    from ..titleblock.classify import classify_sheet, read_title_block

    lines = extract_text_lines(vs, "sheet")
    if not lines:
        return {"n_lines": 0, "spans": [], "dictionary": None, "title_block": None, "classification": None}
    gd = GlyphDictionary.build(lines)
    gd.collect_votes(lines, lang="heb", target="votes")
    gd.collect_votes(lines, lang="eng", target="votes_eng")
    gd.finalize_labels()
    gd.propagate_nearest()
    spans = text_spans(lines, gd)
    tb = read_title_block(spans, vs)
    cls = classify_sheet(tb)
    return {
        "n_lines": len(lines),
        "spans": [asdict(s) for s in spans],
        "dictionary": gd.to_json(),
        "title_block": asdict(tb),
        "classification": asdict(cls),
    }


def process_sheet_version(
    job: IngestSheetVersionJob,
    storage: BlobStorage,
    store: StatusStore,
    *,
    ocr: bool = True,
) -> dict[str, Any]:
    """Run the ingest job. Raises JobError (after recording the failure) on error."""
    vkey = (job.orgId, job.projectId, job.sheetId, job.versionId)
    pre = job.derived_prefix

    def progress(stage: str, pct: int) -> None:
        store.update_job(job.jobId, {"status": "running", "stage": stage, "progress": pct})

    try:
        progress("fetch", 5)
        try:
            data = storage.read_bytes(job.storagePath)
        except KeyError as e:
            raise JobError("source_not_found", f"source missing: {job.storagePath}") from e
        if hashlib.sha256(data).hexdigest() != job.sha256:
            raise JobError("sha256_mismatch", "source bytes do not match job.sha256")
        if job.fileKind != "pdf":
            raise JobError("unsupported_kind", f"{job.fileKind} ingest is not implemented in Sprint 0")

        progress("ingest", 20)
        try:
            sheets = extract_pdf(data, pages=[0])
        except Exception as e:  # pdfium raises PdfiumError on broken/encrypted files
            raise JobError("pdf_unreadable", str(e)) from e
        vs = sheets[0]
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "primitives.npz"
            save_npz(vs, p)
            storage.write_bytes(pre + "primitives.npz", p.read_bytes(), "application/octet-stream")
        stats = {k: v for k, v in vs.stats.items()}
        storage.write_bytes(pre + "ingest_stats.json", _json(stats), "application/json")

        progress("render", 45)
        img = render_page(data, 0, dpi=WORK_DPI)
        storage.write_bytes(pre + f"work_{WORK_DPI}.png", _png(img), "image/png")
        thumb = img.copy()
        thumb.thumbnail((1024, 1024))
        storage.write_bytes(pre + "thumb.png", _png(thumb), "image/png")
        W, H = img.size
        cols, rows = math.ceil(W / TILE_SIZE), math.ceil(H / TILE_SIZE)
        for r in range(rows):
            for c in range(cols):
                box = (c * TILE_SIZE, r * TILE_SIZE, min(W, (c + 1) * TILE_SIZE), min(H, (r + 1) * TILE_SIZE))
                storage.write_bytes(pre + f"tiles/{c}_{r}.png", _png(img.crop(box)), "image/png")
        manifest = {
            "width_px": W,
            "height_px": H,
            "tile_size": TILE_SIZE,
            "dpi": WORK_DPI,
            "mm_per_px": 25.4 / WORK_DPI,
            "cols": cols,
            "rows": rows,
            "fmt": "png",
        }
        storage.write_bytes(pre + "tiles/manifest.json", _json(manifest), "application/json")

        artifacts = {
            "primitives": pre + "primitives.npz",
            "tiles": pre + "tiles/manifest.json",
            "work": pre + f"work_{WORK_DPI}.png",
            "thumb": pre + "thumb.png",
        }
        summary: dict[str, Any] = {
            "widthMm": round(vs.width_mm, 2),
            "heightMm": round(vs.height_mm, 2),
            "paper": stats["paper"],
            "primitiveCount": vs.n_paths,
            "segmentCount": vs.n_segs,
            "hasTextLayer": stats["has_text_layer"],
        }
        if ocr:
            progress("text", 70)
            text = _run_text_stage(data, vs)
            storage.write_bytes(pre + "text_spans.json", _json(text["spans"]), "application/json")
            storage.write_bytes(pre + "glyph_dictionary.json", _json(text["dictionary"]), "application/json")
            storage.write_bytes(
                pre + "title_block.json",
                _json({"title_block": text["title_block"], "classification": text["classification"]}),
                "application/json",
            )
            artifacts["textSpans"] = pre + "text_spans.json"
            artifacts["titleBlock"] = pre + "title_block.json"
            summary["textLines"] = text["n_lines"]
            if text["classification"]:
                cl = text["classification"]
                # title block PII (project name/address) is never copied into Firestore (ADR 0008 / §2 #4)
                summary["classification"] = {k: cl[k] for k in ("disciplines", "floors", "scale_den", "confidence")}

        store.update_version(*vkey, {"status": "ingested", "artifacts": artifacts, "stats": summary})
        store.update_job(job.jobId, {"status": "succeeded", "stage": "done", "progress": 100, "error": None})
        return {"artifacts": artifacts, "stats": summary}
    except JobError as e:
        log.warning("job %s failed: %s %s", job.jobId, e.code, e)
        store.update_job(job.jobId, {"status": "failed", "error": {"code": e.code, "message": str(e)}})
        store.update_version(*vkey, {"status": "failed"})
        raise
    except Exception as e:  # unexpected: record, then let the caller decide on retry
        log.exception("job %s crashed", job.jobId)
        store.update_job(job.jobId, {"status": "failed", "error": {"code": "internal", "message": str(e)[:500]}})
        store.update_version(*vkey, {"status": "failed"})
        raise JobError("internal", str(e), retryable=True) from e
