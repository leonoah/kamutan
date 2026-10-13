"""Helpers for pipeline tests: synthetic inputs, job payloads, contract-schema validation."""

from __future__ import annotations

import copy
import hashlib
import io
import json
import re
from functools import cache
from pathlib import Path
from typing import Any

import pytest

from kamutan_drawing.sandbox.runner import Limits
from kamutan_drawing.service.contracts import IngestSheetVersionJob
from kamutan_drawing.service.pipeline import Options
from kamutan_drawing.stores import InMemoryBlobStore, InMemoryDocStore

ORG, PROJ, SET, VER = "org_1", "proj-1", "set1", "v1"
CONTRACTS = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "json-schema"
# small render + no OCR: fast enough for unit tests, same code path as production
FAST = Options(ocr=False, dpi=72, limits=Limits(wall_s=120))
TILE_RE = re.compile(r"/tiles/(\d+)/(\d+)_(\d+)\.webp$")
# worker-internal bookkeeping fields stored next to the contract fields (documented in NOTES.md)
INTERNAL_VERSION_FIELDS = ("sourceSha256",)
INTERNAL_JOB_FIELDS = ("result",)


def job_payload(data: bytes, kind: str = "pdf", **over: Any) -> dict[str, Any]:
    sha = hashlib.sha256(data).hexdigest()
    org, proj, sset = over.get("orgId", ORG), over.get("projectId", PROJ), over.get("sheetSetId", SET)
    j: dict[str, Any] = {
        "schemaVersion": 3,
        "type": "ingest.sheet_version",
        "jobId": "job1",
        "orgId": org,
        "projectId": proj,
        "sheetSetId": sset,
        "sheetId": None,
        "pageIndex": None,
        "versionId": VER,
        "storagePath": f"orgs/{org}/projects/{proj}/uploads/{sset}/source.{kind}",
        "sha256": sha,
        "fileKind": kind,
        "traceparent": None,
    }
    j.update(over)
    return j


def seed(
    data: bytes | None,
    payload: dict[str, Any],
    docs: InMemoryDocStore | None = None,
    blobs: InMemoryBlobStore | None = None,
    **job_doc: Any,
):
    """Upload + jobs/{jobId} (as the API creates them) → (job, blobs, docs)."""
    blobs = blobs if blobs is not None else InMemoryBlobStore()
    docs = docs if docs is not None else InMemoryDocStore()
    if data is not None:
        blobs.write(payload["storagePath"], data, "application/octet-stream")
    doc = {
        "orgId": payload["orgId"],
        "projectId": payload["projectId"],
        "sheetSetId": payload["sheetSetId"],
        "sheetId": payload["sheetId"],
        "versionId": payload["versionId"],
        "type": "ingest.sheet_version",
        "status": "queued",
        "progress": {"stage": "ingest", "pct": 0},
        "attempts": 0,
        "error": None,
        "createdAt": "2026-10-13T00:00:00.000Z",
        "updatedAt": "2026-10-13T00:00:00.000Z",
    }
    doc.update(job_doc)
    docs.set(f"jobs/{payload['jobId']}", doc, merge=False)
    return IngestSheetVersionJob.model_validate(payload), blobs, docs


@cache
def _schema(name: str) -> dict[str, Any]:
    p = CONTRACTS / f"{name}.json"
    if not p.exists():
        pytest.skip("packages/contracts json-schema not generated")
    s: dict[str, Any] = json.loads(p.read_text())
    return s


def validate(name: str, obj: dict[str, Any]) -> None:
    import jsonschema

    jsonschema.validate(obj, _schema(name))


def validate_version(doc: dict[str, Any], vid: str, sid: str) -> None:
    d = {k: v for k, v in copy.deepcopy(doc).items() if k not in INTERNAL_VERSION_FIELDS}
    validate("SheetVersion", {**d, "id": vid, "sheetId": sid})


def validate_sheet(doc: dict[str, Any], sid: str) -> None:
    validate("Sheet", {**copy.deepcopy(doc), "id": sid})


def validate_job(doc: dict[str, Any], jid: str) -> None:
    d = {k: v for k, v in copy.deepcopy(doc).items() if k not in INTERNAL_JOB_FIELDS}
    validate("Job", {**d, "id": jid})


# --------------------------------------------------------------------------- synthetic inputs
def multipage_pdf(n: int = 2) -> bytes:
    from reportlab.lib.pagesizes import A3, landscape
    from reportlab.pdfgen import canvas

    from .synth import MM, draw_word, stroke_line

    ps = landscape(A3)
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=ps)
    for i in range(n):
        stroke_line(c, (10, 10), (410, 10), ps)
        stroke_line(c, (10, 10), (10, 287), ps)
        c.rect(40 * MM, 60 * MM, (120 + 20 * i) * MM, 80 * MM, stroke=1, fill=1)
        draw_word(c, ps, ["box", "he", "vav"], 50, 50, 3.0)
        c.showPage()
    c.save()
    return buf.getvalue()


def lighting_dxf() -> bytes:
    """Model-space DXF (mm): two stacked floor plans + real Hebrew TEXT + a symbol block."""
    import ezdxf

    doc = ezdxf.new("R2018", setup=True)
    doc.header["$INSUNITS"] = 4
    msp = doc.modelspace()
    blk = doc.blocks.new("LAMP")
    blk.add_circle((0, 0), 150)
    blk.add_line((-150, 0), (150, 0))

    def plan(y0: float, label: str) -> None:
        msp.add_lwpolyline([(0, y0), (10000, y0), (10000, y0 + 6000), (0, y0 + 6000)], close=True, dxfattribs={"layer": "WALLS"})
        for k in range(1, 5):
            msp.add_line((k * 2000, y0), (k * 2000, y0 + 6000), dxfattribs={"layer": "WALLS"})
        for k in range(4):
            msp.add_blockref("LAMP", (1000 + k * 2000, y0 + 3000), dxfattribs={"layer": "LIGHTING"})
        msp.add_text(label, height=300, dxfattribs={"layer": "TEXT"}).set_placement((3000, y0 - 900))

    plan(9000, "קומת מרתף")  # upper on paper (y up in model space)
    plan(0, "קומת קרקע")
    msp.add_text("ת. תאורה / קומת מרתף / קומת קרקע", height=500, dxfattribs={"layer": "TEXT"}).set_placement((11000, 1000))
    msp.add_text('קנ"מ 1:50', height=300, dxfattribs={"layer": "TEXT"}).set_placement((11000, 300))
    s = io.StringIO()
    doc.write(s)
    return s.getvalue().encode("utf-8")


def raster_png(fmt: str = "PNG", dpi: int = 100) -> bytes:
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (1400, 990), "white")
    d = ImageDraw.Draw(img)
    d.rectangle((50, 50, 1350, 940), outline="black", width=3)
    for k in range(6):
        d.line((100 + 200 * k, 100, 100 + 200 * k, 800), fill="black", width=2)
    buf = io.BytesIO()
    img.save(buf, format=fmt, dpi=(dpi, dpi))
    return buf.getvalue()
