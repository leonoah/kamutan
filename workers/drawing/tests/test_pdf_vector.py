import numpy as np
import pytest
from reportlab.lib.colors import Color
from reportlab.lib.pagesizes import A3, landscape

from kamutan_drawing.ingest.pdf_vector import (
    SEG_BEZIER,
    SEG_LINE,
    extract_pdf,
    paper_size_name,
    save_npz,
)

from .synth import MM, make_pdf, stroke_line, to_pdf_xy


def _one_line(c, ps):
    stroke_line(c, (10, 20), (110, 20), ps, width_mm=0.5, rgb=(1, 0, 0))


def test_line_is_in_paper_mm_y_down():
    vs = extract_pdf(make_pdf(_one_line))[0]
    assert vs.stats["paper"] == "A3"
    assert vs.width_mm == pytest.approx(420, abs=0.5)
    assert vs.height_mm == pytest.approx(297, abs=0.5)
    assert vs.n_paths == 1 and vs.n_segs == 1
    np.testing.assert_allclose(vs.segs[0], [10, 20, 110, 20], atol=0.01)
    assert tuple(vs.path_stroke_rgba[0][:3]) == (255, 0, 0)
    assert vs.path_width_mm[0] == pytest.approx(0.5, abs=0.01)
    assert vs.seg_kind[0] == SEG_LINE
    assert vs.path_dash[0] == ()


def test_bezier_kept_and_flattened():
    def draw(c, ps):
        c.setStrokeColor(Color(0, 0, 1))
        x0, y0 = to_pdf_xy(50, 50, ps)
        x3, y3 = to_pdf_xy(90, 50, ps)
        p = c.beginPath()
        p.moveTo(x0, y0)
        p.curveTo(x0, y0 + 20 * MM, x3, y3 + 20 * MM, x3, y3)
        c.drawPath(p, stroke=1, fill=0)

    vs = extract_pdf(make_pdf(draw))[0]
    assert vs.curves.shape == (1, 8)
    np.testing.assert_allclose(vs.curves[0][[0, 1, 6, 7]], [50, 50, 90, 50], atol=0.01)
    assert (vs.seg_kind == SEG_BEZIER).sum() == 8
    # curve bulges upward on paper (smaller y)
    assert vs.path_bbox[0][1] < 50 - 10


def test_dash_fill_and_close():
    def draw(c, ps):
        stroke_line(c, (10, 10), (60, 10), ps, dash=([3 * MM, 1.5 * MM], 0))
        c.setDash([], 0)
        c.setFillColor(Color(0, 1, 0))
        x, y = to_pdf_xy(100, 100, ps)
        c.rect(x, y, 20 * MM, 10 * MM, stroke=1, fill=1)

    vs = extract_pdf(make_pdf(draw))[0]
    assert vs.path_dash[0] == pytest.approx((3.0, 1.5), abs=0.01)
    assert vs.stats["n_dashed_paths"] == 1
    assert vs.path_fill_mode[1] > 0 and vs.path_closed[1]
    assert tuple(vs.path_fill_rgba[1][:3]) == (0, 255, 0)
    assert vs.path_seg_count[1] == 4  # closed rectangle -> 4 sides


@pytest.mark.parametrize("rot", [0, 90, 180, 270])
def test_rotated_page_matches_renderer(rot):
    """/Rotate is applied like a viewer does: mm coordinates must agree with
    where pdfium's renderer (which honours /Rotate) puts the ink."""
    from kamutan_drawing.render.raster import render_page

    ps = landscape(A3)

    def draw(c, ps_):
        stroke_line(c, (30, 40), (130, 40), ps_, width_mm=1.0)  # horizontal on media

    pdf = make_pdf(draw, pagesize=ps, rotate=rot)
    vs = extract_pdf(pdf)[0]
    img = np.asarray(render_page(pdf, 0, dpi=50, grayscale=True))
    assert img.shape[1] == pytest.approx(vs.width_mm / 25.4 * 50, abs=2)
    assert img.shape[0] == pytest.approx(vs.height_mm / 25.4 * 50, abs=2)
    ys, xs = np.nonzero(img < 128)
    ink_mm = np.array([xs.min(), ys.min(), xs.max(), ys.max()]) * 25.4 / 50
    seg = vs.segs[0]
    bbox = [min(seg[0], seg[2]), min(seg[1], seg[3]), max(seg[0], seg[2]), max(seg[1], seg[3])]
    np.testing.assert_allclose(ink_mm, bbox, atol=1.2)
    assert np.hypot(seg[2] - seg[0], seg[3] - seg[1]) == pytest.approx(100, abs=0.01)


def test_save_npz_roundtrip(tmp_path):
    vs = extract_pdf(make_pdf(_one_line))[0]
    p = tmp_path / "p.npz"
    save_npz(vs, p)
    z = np.load(p)
    np.testing.assert_allclose(z["segs"], vs.segs)
    assert z["meta"][1] == pytest.approx(vs.width_mm)


def test_paper_names():
    assert paper_size_name(841, 1189) == "A0"
    assert paper_size_name(297.04, 420.16) == "A3"
    assert paper_size_name(100, 50) == "100x50mm"


def test_sample_sheets_are_vector_a3(sample_dir):
    for f in sorted(sample_dir.glob("sheet_*.pdf")):
        vs = extract_pdf(f)[0]
        assert vs.stats["paper"] == "A3", f.name
        assert vs.stats["has_text_layer"] is False
        assert vs.n_paths > 1000
        assert vs.segs[:, [0, 2]].min() >= -1 and vs.segs[:, [0, 2]].max() <= vs.width_mm + 1
        assert vs.segs[:, [1, 3]].min() >= -1 and vs.segs[:, [1, 3]].max() <= vs.height_mm + 1
