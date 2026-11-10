"""Sprint 10 (Perf): memory of the page task on heavy sheets — the Rubel ground floors.

Two causes of ``parse_memory_limit`` on real customer sheets, both in the SHX text stage:

* a row of zero-height strokes (ticks, hatch dashes) became a "text line" of height 0.001 mm, rendered for OCR
  at 40 px per line height → a 1–3 GB image (every Rubel sheet with a site-survey underlay);
* ``_link_lines`` held ~8 M candidate pairs as a Python list of tuples (~1 GB) per pass.

The golden digests (``tests/golden/page_digests.json``, written by ``scripts/perf_page_digests.py`` from the
pre-Sprint-10 code) pin ``primitives.msgpack.gz`` of the page task on the Noah sheets and the synthetic sample10
sheets; ``text.json.gz`` only with ``KAMUTAN_PERF_GOLDEN_TEXT=1`` and the same Tesseract (other workers change the
text layer on purpose). Both golden tests skip when the data or the golden file is absent.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from kamutan_drawing.ingest.pdf_vector import extract_pdf
from kamutan_drawing.ocr import dictionary as D
from kamutan_drawing.ocr.glyphs import MIN_LINE_HEIGHT_MM, TextLine, extract_text_lines
from kamutan_drawing.ocr.tess import MAX_LINE_RENDER_PX, render_line

from .synth import draw_word, make_pdf, stroke_line

GOLDEN = Path(__file__).parent / "golden" / "page_digests.json"


def _sheet(draw):
    return extract_pdf(make_pdf(draw))[0]


# ----------------------------------------------------------------------------------------------- degenerate lines
def test_zero_height_tick_row_is_not_a_text_line():
    def draw(c, ps):
        draw_word(c, ps, ["he", "box", "vav"], 50, 50, 3.0)  # one real word
        for k in range(16):  # a row of 1 mm horizontal ticks: the hatch / survey pattern that blew up OCR
            x = 120 + k * 1.1
            stroke_line(c, (x, 80.0), (x + 0.8, 80.0), ps)

    lines = extract_text_lines(_sheet(draw), "s")
    assert all(ln.height >= MIN_LINE_HEIGHT_MM for ln in lines)
    assert len(lines) == 1 and len(lines[0].glyphs) == 3
    for ln in lines:
        img, _ = render_line(ln)
        assert img is not None and img.size[0] * img.size[1] < 2_000_000


def test_render_line_refuses_a_giant_image():
    class G:
        bbox = np.array([0.0, 99.999, 17.0, 100.0])
        segs = np.array([[0.0, 100.0, 17.0, 100.0]])

    ln = TextLine(sheet="s", glyphs=[G()], bbox=G.bbox, baseline=100.0, topline=99.999, height=0.001, rotation=0, style=())
    img, to_px = render_line(ln)  # 17 mm / 0.001 mm * 160 px = 2.7 M px wide: ~1 GB before this cap
    assert img is None
    assert to_px(0.0) < to_px(17.0)  # the mapping stays usable
    assert MAX_LINE_RENDER_PX <= 64_000_000


def test_collect_votes_splits_an_oversized_canvas(monkeypatch):
    """One very wide line must not size the whole batch canvas (max width x sum of heights)."""
    calls: list[tuple[int, int]] = []

    def fake_ocr_boxes(img, lang="heb", psm=6):
        calls.append(img.size)
        return []

    monkeypatch.setattr(D, "ocr_boxes", fake_ocr_boxes)
    monkeypatch.setattr(D, "MAX_CANVAS_PX", 400_000)

    class G:
        bbox = np.array([0.0, 0.0, 1.0, 1.0])
        cluster = -1

    lines = [
        TextLine(sheet="s", glyphs=[G()], bbox=G.bbox, baseline=1.0, topline=0.0, height=1.0, rotation=0, style=())
        for _ in range(8)
    ]
    sizes = [(5000, 50)] + [(100, 50)] * 7  # 5000 x (8 * 80 + 30) = 3.3 MP as one canvas
    imgs = iter(sizes)
    gd = D.GlyphDictionary([], {})
    gd.collect_votes(lines, image_fn=lambda ln: (Image.new("L", next(imgs), 255), lambda x: x), batch=30)
    assert len(calls) >= 2  # the batch was split
    assert max(w * h for w, h in calls) < 3_000_000  # never the 3.3 MP single canvas


def test_link_lines_same_groups_on_the_set_path_and_the_array_path(monkeypatch):
    """Over PAIRS_SET_MAX the pairs stay a numpy array; the line groups are the same as on the historic set path."""
    from kamutan_drawing.ocr import glyphs

    def draw(c, ps):
        for row in range(6):
            draw_word(c, ps, ["he", "box", "vav", "he", "colon"], 40, 40 + row * 6.0, 3.0)
            draw_word(c, ps, ["box", "tick", "he"], 120, 40 + row * 6.0, 2.0)

    vs = _sheet(draw)

    def groups() -> list[list[int]]:
        return sorted(sorted(p for g in ln.glyphs for p in g.paths) for ln in extract_text_lines(vs, "s"))

    set_path = groups()
    monkeypatch.setattr(glyphs, "PAIRS_SET_MAX", 0)
    assert groups() == set_path and len(set_path) == 12


# ----------------------------------------------------------------------------------------------- image summary
def test_pdf_image_summary_counts_embedded_rasters(tmp_path):
    from reportlab.lib.utils import ImageReader

    from kamutan_drawing.parse.pdf import PdfPageSource

    png = tmp_path / "u.png"
    Image.new("RGB", (200, 100), (200, 200, 200)).save(png)

    def draw(c, ps):
        draw_word(c, ps, ["he", "box"], 50, 50, 3.0)
        for k in range(3):
            c.drawImage(ImageReader(str(png)), 100 + 60 * k, 100, width=50, height=25)

    pdf = tmp_path / "s.pdf"
    pdf.write_bytes(make_pdf(draw))
    src = PdfPageSource.open(str(pdf), 0)
    try:
        s = src.image_summary()
    finally:
        src.close()
    assert s["count"] == 3 and s["megapixels"] == pytest.approx(0.06, abs=0.001)
    x0, y0, x1, y1 = s["bboxMm"]
    assert x1 - x0 == pytest.approx((60 * 2 + 50) / 72 * 25.4, abs=0.5)
    assert y1 - y0 == pytest.approx(25 / 72 * 25.4, abs=0.5)
    assert s["dpiMedian"] is not None and s["dpiMedian"] > 0

    src = PdfPageSource.open(str(pdf), 0)
    try:
        assert src.image_summary()["count"] == 3  # idempotent (objects are re-enumerated, nothing cached)
    finally:
        src.close()


def test_page_task_reports_images(tmp_path, monkeypatch):
    from kamutan_drawing.parse.page import process_page

    pdf = tmp_path / "source.pdf"
    pdf.write_bytes(make_pdf(lambda c, ps: draw_word(c, ps, ["he", "box"], 50, 50, 3.0)))
    monkeypatch.chdir(tmp_path)
    res = process_page(
        {"kind": "pdf", "path": "source.pdf", "index": 0, "outDir": "out", "dpi": 36, "ocr": False, "tiles": False},
        lambda s, p: None,
    )
    assert res["stats"]["images"] == 0
    assert res["images"] == {"count": 0, "megapixels": 0.0, "bboxMm": None, "dpiMedian": None}


# ----------------------------------------------------------------------------------------------- golden digests
def page_digests(pdf: Path, workdir: Path) -> tuple[str, str]:
    """sha256 of primitives.msgpack.gz and text.json.gz of the page task (OCR on, tiles off, cold glyph store)."""
    from kamutan_drawing.parse.page import process_page

    wd = workdir / pdf.stem
    wd.mkdir()
    shutil.copy(pdf, wd / "source.pdf")
    cwd = os.getcwd()
    os.chdir(wd)
    try:
        process_page(
            {
                "kind": "pdf",
                "path": "source.pdf",
                "index": 0,
                "outDir": "out",
                "dpi": 300,
                "ocr": True,
                "tiles": False,
                "sheet": pdf.stem,
                "contribution": "c",
            },
            lambda s, p: None,
        )
    finally:
        os.chdir(cwd)
    return (
        hashlib.sha256((wd / "out/primitives.msgpack.gz").read_bytes()).hexdigest(),
        hashlib.sha256((wd / "out/text.json.gz").read_bytes()).hexdigest(),
    )


def tesseract_version() -> str:
    if not shutil.which("tesseract"):
        return ""
    r = subprocess.run(["tesseract", "--version"], capture_output=True, text=True, check=False)
    out = r.stdout or r.stderr
    return out.splitlines()[0].strip() if out else ""


def _golden() -> dict:
    if not GOLDEN.is_file():
        pytest.skip("no golden digests recorded (scripts/perf_page_digests.py)")
    return json.loads(GOLDEN.read_text())


def _check(pdf: Path, tmp_path: Path, g: dict) -> None:
    exp = g["sheets"].get(pdf.name)
    if exp is None:
        pytest.skip(f"{pdf.name} not in the golden file")
    prim, txt = page_digests(pdf, tmp_path)
    assert prim == exp["primitives"], f"{pdf.name}: primitives.msgpack.gz changed"
    # text.json.gz also moves with legitimate text work of other workers (Sprint 10: ToUnicode repair, "src" tags),
    # so it is pinned only on request, for a before/after A/B of one change (scripts/perf_page_digests.py)
    if os.environ.get("KAMUTAN_PERF_GOLDEN_TEXT") == "1" and tesseract_version() == g.get("tesseract"):
        assert txt == exp["text"], f"{pdf.name}: text.json.gz changed (same Tesseract)"


@pytest.mark.parametrize("sid", ["08222cb2", "c054fd3a", "2a308827"])
def test_noah_page_output_is_unchanged(sample_dir, tmp_path, sid):
    _check(sample_dir / f"sheet_{sid}.pdf", tmp_path, _golden())


def test_sample10_page_output_is_unchanged(tmp_path):
    g = _golden()
    root = Path(os.environ.get("KAMUTAN_DATA_DIR", "/home/claude/kamutan-data"))
    root = root if (root / "synth").is_dir() else root.parent
    pdfs = sorted((root / "synth" / "sample10" / "sheets").glob("*/syn*.pdf"))
    if not pdfs:
        pytest.skip("synthetic sample10 not available")
    for pdf in pdfs[:3]:
        _check(pdf, tmp_path, g)


# ----------------------------------------------------------------------------------------------- understand CPU
def test_spot_vetoes_before_the_reverse_fit_with_the_same_detections(monkeypatch):
    """Sprint 10 (Perf): ``accept`` runs before ``reverse`` / ``fill_difference``; the detections equal the old order
    (fit every pose, filter, NMS) and rejected poses are never reverse-fitted."""
    from kamutan_drawing.symbols import detect as D
    from kamutan_drawing.symbols import match as MA

    from .test_sprint10_accuracy import ORANGE, YELLOW, Sheet, _entry, _plain_template, _square

    s = Sheet()
    _square(s, 20.0, 20.0, YELLOW)  # legend drawing
    for k in range(6):
        _square(s, 60.0 + 30 * k, 100.0, YELLOW if k % 2 == 0 else ORANGE)
    vs = s.build()
    t = _plain_template(vs, [0], "wall")
    t.entries = [_entry(0, "גוף תאורה מהקיר", vs, [0], "luminaire_wall")]
    cols = D.template_colours(t, vs)
    scene = MA.build_scene(vs, [])

    def accept(c):
        return D.colour_share(c, scene, vs, cols) >= D.COLOUR_MIN_SHARE

    old = MA._nms([c for c in MA.spot_template(t, scene, 1.0) if accept(c)], 0.45)
    calls = []
    real = MA.reverse

    def counting(tpl, sc, center, mat, scale):
        calls.append(tuple(center))
        return real(tpl, sc, center, mat, scale)

    monkeypatch.setattr(MA, "reverse", counting)
    new = MA.spot([t], scene, accept=accept).detections
    key = [(c.tpl.id, c.center, round(c.quality, 12), c.runner_up, c.runner_up_id) for c in old]
    assert key == [(c.tpl.id, c.center, round(c.quality, 12), c.runner_up, c.runner_up_id) for c in new]
    assert sorted(round(c.center[0]) for c in new if c.quality >= 0.6) == [20, 60, 120, 180]  # legend + 3 yellow
    assert calls and all(round(x) not in (90, 150, 210) for x, _ in calls)  # orange poses: no reverse fit
