"""Sprint 7 raster symbol spike (``raster_symbols/``, behind ``KAMUTAN_RASTER_SYMBOLS=1``) on the synthetic legend sheet."""

from __future__ import annotations

import math
import shutil

import numpy as np
import pytest

from kamutan_drawing.raster_symbols import detect_raster_symbols, enabled, method
from kamutan_drawing.raster_symbols.image import load_page, strip_structure
from kamutan_drawing.raster_symbols.match import Candidate, nms, rotate_mask

from .synth_legend import PLACED, legend_sheet_pdf

needs_tess = pytest.mark.skipif(shutil.which("tesseract") is None, reason="tesseract not installed")


def test_flag_is_off_by_default():
    assert enabled({}) is False
    assert enabled({"KAMUTAN_RASTER_SYMBOLS": "1"}) is True
    assert enabled({"KAMUTAN_RASTER_SYMBOLS": "true"}) is False
    assert method({}) == "blobs"
    assert method({"KAMUTAN_RASTER_SYMBOLS_METHOD": "template"}) == "template"
    assert method({"KAMUTAN_RASTER_SYMBOLS_METHOD": "rm -rf"}) == "blobs"


def test_sandbox_passes_the_flags_but_no_secrets():
    from kamutan_drawing.sandbox.runner import ENV_ALLOW

    assert "KAMUTAN_RASTER_SYMBOLS" in ENV_ALLOW
    assert not [k for k in ENV_ALLOW if "KEY" in k or "TOKEN" in k or "SECRET" in k]


def test_rotate_mask_keeps_ink_and_turns_the_shape():
    m = np.zeros((10, 30), bool)
    m[4:6, :] = True
    r = rotate_mask(m, 90, 1.0)
    assert r.shape[0] > r.shape[1]  # a horizontal bar becomes vertical
    assert r.sum() > 0.5 * m.sum()


def test_nms_keeps_best_and_records_the_runner_up():
    from kamutan_drawing.legend.parse import LegendEntry
    from kamutan_drawing.raster_symbols.legend import Exemplar

    def ex(cls: str) -> Exemplar:
        return Exemplar(LegendEntry(0, "lg0", "symbol", (0, 0, 1, 1), None, "", 1.0, suggested_class=cls), np.ones((4, 4), bool))

    exs = [ex("socket_single"), ex("switch_single")]
    a = Candidate(0, 0.9, (10.0, 10.0), (4.0, 4.0), 0)
    b = Candidate(1, 0.8, (10.5, 10.0), (4.0, 4.0), 0)
    c = Candidate(1, 0.7, (30.0, 10.0), (4.0, 4.0), 0)
    kept = nms([b, c, a], exs)
    assert [k.score for k in kept] == [0.9, 0.7]
    assert kept[0].runner_up == pytest.approx(0.8)


def test_strip_structure_removes_long_lines_but_keeps_small_symbols():
    ink = np.zeros((200, 200), bool)
    ink[100, :] = True  # a wall line
    yy, xx = np.mgrid[:200, :200]
    ring = np.abs(np.hypot(yy - 50, xx - 50) - 12) < 1.0  # a 3 mm circle at 8 px/mm
    ink |= ring
    out = strip_structure(ink, 8.0)
    assert not out[100, 150]
    assert out[ring].mean() > 0.8


@needs_tess
@pytest.mark.parametrize("how", ["blobs", "template"])
def test_synthetic_sheet_symbols_found_and_capped_yellow(tmp_path, how):
    from kamutan_drawing.raster_symbols.match import cv2_module
    from kamutan_drawing.render.raster import render_page

    if how == "template" and cv2_module() is None:
        pytest.skip("scipy fallback: ~75 s per sheet; the blobs case covers the shared stages")

    p = tmp_path / "s.pdf"
    p.write_bytes(legend_sheet_pdf())
    img = render_page(str(p), 0, dpi=200)
    page = load_page(img, 420.0)
    assert abs(page.width_mm - 420.0) < 0.5
    res = detect_raster_symbols(img, width_mm=420.0, how=how, read_marks=False)
    assert res.legend is not None
    classes = {e.suggested_class for e in res.legend.entries}
    assert {"socket_power", "luminaire_ceiling", "switch_single"} <= classes
    assert res.detections, res.stats
    # every raster item stays capped: never green, always "גיליון רסטר"
    assert all(d.level != "green" and "גיליון רסטר" in d.reasons and d.source == "raster" for d in res.detections)
    hits = sum(
        any(math.hypot(d.center[0] - pl.x, d.center[1] - pl.y) < 3.0 and d.cls == pl.cls for d in res.detections) for pl in PLACED
    )
    assert hits >= 5, [(d.cls, d.center) for d in res.detections]
    assert res.stats["method"] == how and "seconds" in res.stats
