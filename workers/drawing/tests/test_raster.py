import json
import math

import numpy as np
import pytest

from kamutan_drawing.render.raster import render_page, render_region, render_tiles

from .synth import make_pdf, stroke_line


def _cross(c, ps):
    stroke_line(c, (100, 100), (200, 100), ps, width_mm=1.0)
    stroke_line(c, (150, 50), (150, 150), ps, width_mm=1.0)


def test_render_a3_size():
    img = render_page(make_pdf(_cross), dpi=100)
    assert abs(img.size[0] - 420 / 25.4 * 100) <= 1 and abs(img.size[1] - 297 / 25.4 * 100) <= 1


def test_tiles_a3(tmp_path):
    man = render_tiles(make_pdf(_cross), tmp_path, dpi=100, tile_size=256)
    assert man.cols == math.ceil(man.width_px / 256) and man.rows == math.ceil(man.height_px / 256)
    files = sorted(p.name for p in tmp_path.glob("*.png"))
    assert len(files) == man.cols * man.rows
    m = json.loads((tmp_path / "manifest.json").read_text())
    assert m["mm_per_px"] == pytest.approx(0.254)
    # the edge tile is not padded
    from PIL import Image

    last = Image.open(tmp_path / f"{man.cols - 1}_{man.rows - 1}.png")
    assert last.size == (man.width_px - 256 * (man.cols - 1), man.height_px - 256 * (man.rows - 1))


def test_region_matches_mm():
    img = np.asarray(render_region(make_pdf(_cross), (140, 90, 160, 110), dpi=254))  # 10 px / mm
    assert abs(img.shape[0] - 200) <= 1 and abs(img.shape[1] - 200) <= 1
    ys, xs = np.nonzero(img < 128)
    # the cross centre (150,100) is in the middle of the crop
    assert abs(np.median(xs[np.abs(ys - 100) > 20]) - 100) <= 2
    assert abs(np.median(ys[np.abs(xs - 100) > 20]) - 100) <= 2


def test_sample_tiles(sample_dir, tmp_path):
    f = min(sample_dir.glob("sheet_*.pdf"))
    man = render_tiles(f, tmp_path, dpi=150)
    assert man.width_px == pytest.approx(420 / 25.4 * 150, abs=2) or man.width_px == pytest.approx(297 / 25.4 * 150, abs=2)
    assert len(list(tmp_path.glob("*.png"))) == man.cols * man.rows
