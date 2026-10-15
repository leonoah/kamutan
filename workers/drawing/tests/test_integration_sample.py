"""Integration on the real sample sheets (skipped without KAMUTAN_DATA_DIR data)."""

import shutil
import time

import pytest

from kamutan_drawing.ingest.pdf_vector import extract_pdf
from kamutan_drawing.ocr.glyphs import extract_text_lines
from kamutan_drawing.service.pipeline import Options, process_sheet_version

from .pipeline_util import job_payload, seed, validate_sheet, validate_version

A3_BUDGET_S = 60.0  # Sprint 1: an A3 sheet in < 60 s on the dev box (cold org glyph store)


def test_glyph_lines_on_electrical_sheet(sample_dir):
    vs = extract_pdf(sample_dir / "sheet_c054fd3a.pdf")[0]
    lines = extract_text_lines(vs, "c054fd3a")
    glyphs = [g for ln in lines for g in ln.glyphs]
    assert len(lines) > 200 and len(glyphs) > 1200
    # title block row "שם הפרויקט:" = 10 glyphs (ש ם ה פ ר ו י ק ט :) on one line
    tb = [ln for ln in lines if ln.bbox[1] > 394 and ln.bbox[0] > 265 and ln.bbox[3] < 400]
    assert any(len(ln.glyphs) == 10 for ln in tb)


@pytest.mark.parametrize(
    ("sid", "disc", "floors", "n_regions"),
    [
        ("eb8be8a3", "electrical", ["ground"], 1),
        ("2a308827", "plumbing", ["first"], 1),
        ("1bbe4113", "lighting", ["basement", "ground"], 2),  # one sheet, two floor plans
    ],
)
def test_pipeline_ingests_sample_sheet(sample_dir, sid, disc, floors, n_regions):
    if not shutil.which("tesseract"):
        pytest.skip("tesseract not installed")
    data = (sample_dir / f"sheet_{sid}.pdf").read_bytes()
    payload = job_payload(data, sheetSetId=f"s-{sid}")
    job, blobs, docs = seed(data, payload)
    t0 = time.monotonic()
    out = process_sheet_version(job, blobs, docs, Options())
    elapsed = time.monotonic() - t0
    assert out.status == "succeeded"
    sheet_id = f"s-{sid}-p0"
    base = f"orgs/{job.orgId}/projects/{job.projectId}/sheets/{sheet_id}"
    s, v = docs.get(base), docs.get(f"{base}/versions/v1")
    validate_sheet(s, sheet_id)
    validate_version(v, "v1", sheet_id)
    assert s["discipline"] == disc and s["floors"] == floors and s["scaleDenominator"] == 50
    assert s["classification"]["level"] in ("green", "yellow")
    assert len(v["regions"]) == n_regions and [r["floor"] for r in v["regions"]] == floors
    t = v["artifacts"]["tiles"]
    assert t["dpi"] == 300 and t["levels"] == 6 and max(t["widthPx"], t["heightPx"]) == 4962
    assert sum(1 for k in blobs.blobs if k.startswith(t["prefix"])) == 379
    # title-block PII never reaches Firestore (project/client name, address live in the title block)
    flat = repr(s) + repr(v)
    assert "שם הפרויקט" not in flat and "כתובת" not in flat
    assert elapsed < A3_BUDGET_S, f"A3 ingest took {elapsed:.1f}s"
