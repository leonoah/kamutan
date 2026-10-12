"""Integration on the real sample sheets (skipped without KAMUTAN_DATA_DIR data)."""

import hashlib
import shutil

import pytest

from kamutan_drawing.ingest.pdf_vector import extract_pdf
from kamutan_drawing.ocr.glyphs import extract_text_lines
from kamutan_drawing.service.contracts import IngestSheetVersionJob
from kamutan_drawing.service.pipeline import process_sheet_version
from kamutan_drawing.service.ports import InMemoryStorage, InMemoryStore


def test_glyph_lines_on_electrical_sheet(sample_dir):
    vs = extract_pdf(sample_dir / "sheet_c054fd3a.pdf")[0]
    lines = extract_text_lines(vs, "c054fd3a")
    glyphs = [g for ln in lines for g in ln.glyphs]
    assert len(lines) > 200 and len(glyphs) > 1200
    # title block row "שם הפרויקט:" = 10 glyphs (ש ם ה פ ר ו י ק ט :) on one line
    tb = [ln for ln in lines if ln.bbox[1] > 394 and ln.bbox[0] > 265 and ln.bbox[3] < 400]
    assert any(len(ln.glyphs) == 10 for ln in tb)


@pytest.mark.parametrize(
    "sid,disc,floors",
    [("eb8be8a3", "electrical", ["ground"]), ("2a308827", "plumbing", ["first"])],
)
def test_pipeline_classifies_sheet(sample_dir, sid, disc, floors):
    if not shutil.which("tesseract"):
        pytest.skip("tesseract not installed")
    data = (sample_dir / f"sheet_{sid}.pdf").read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    job = IngestSheetVersionJob.model_validate(
        {
            "schemaVersion": 2,
            "type": "ingest.sheet_version",
            "jobId": "j",
            "orgId": "o",
            "projectId": "p",
            "sheetSetId": "s",
            "sheetId": sid,
            "versionId": "v",
            "storagePath": f"orgs/o/projects/p/sources/{sha}.pdf",
            "sha256": sha,
            "fileKind": "pdf",
            "traceparent": None,
        }
    )
    st, store = InMemoryStorage(), InMemoryStore()
    st.write_bytes(job.storagePath, data, "application/pdf")
    res = process_sheet_version(job, st, store, ocr=True)
    cl = res["stats"]["classification"]
    assert cl["disciplines"] == [disc]
    assert cl["floors"] == floors
    assert cl["scale_den"] == 50
