"""Tile pyramid geometry (= contracts tileLevels/levelsFor) and band rendering (A0 is never one bitmap)."""

from __future__ import annotations

import math
from pathlib import Path

import pytest
from PIL import Image

from kamutan_drawing.render import tiles as T
from kamutan_drawing.render.tiles import BAND_BUDGET_PX, TILE, Pyramid, levels_for, write_pyramid, write_thumbnail


def contracts_levels_for(w: int, h: int, tile: int = 256) -> int:
    levels = 1
    while math.ceil(max(w, h) / 2 ** (levels - 1)) > tile:
        levels += 1
    return levels


@pytest.mark.parametrize("size", [(1, 1), (256, 10), (257, 10), (512, 512), (513, 3), (4962, 3508), (14043, 9933), (70000, 5)])
def test_levels_match_contracts(size):
    assert levels_for(*size) == contracts_levels_for(*size)


@pytest.mark.parametrize(
    ("paper", "dpi", "px", "levels"), [((420.0, 297.0), 300, (4961, 3508), 6), ((1189.0, 841.0), 300, (14043, 9933), 7)]
)
def test_pyramid_for_paper(paper, dpi, px, levels):
    p = Pyramid.for_page(*paper, dpi)
    assert (p.width_px, p.height_px) == px and p.levels == levels
    assert max(p.level_size(0)) <= TILE
    assert p.level_size(levels - 1) == px
    assert p.meta() == {"format": "webp", "tileSize": 256, "dpi": dpi, "levels": levels, "widthPx": px[0], "heightPx": px[1]}


def test_a0_is_rendered_in_bands_never_whole(tmp_path: Path, monkeypatch):
    """A0 @ 300 dpi = 139 MP: every render request stays within the band budget (decision #12, SEC-16)."""
    monkeypatch.setattr(T, "_save_webp", lambda img, path: None)
    requests: list[tuple[float, int, int, int, int]] = []

    def render(s: float, x0: int, y0: int, w: int, h: int) -> Image.Image:
        requests.append((s, x0, y0, w, h))
        return Image.new("RGB", (w, h), "white")

    pyr = Pyramid.for_page(1189.0, 841.0, 300)
    files = write_pyramid(render, pyr, tmp_path)
    assert len(files) == pyr.tile_count()
    biggest = max(w * h for *_, w, h in requests)
    assert biggest <= BAND_BUDGET_PX + 14043 * TILE  # one band (whole tile rows) at most
    assert biggest < 0.25 * pyr.width_px * pyr.height_px
    # every level is rendered straight from the source at its own scale (no upscaling from a lower level)
    assert {round(s, 6) for s, *_ in requests} == {round(pyr.px_per_mm(z), 6) for z in range(pyr.levels)}
    write_thumbnail(render, 1189.0, 841.0, tmp_path)
    assert requests[-1][3:] == (512, 362)


def test_edge_tiles_are_cropped_not_padded(tmp_path: Path):
    def render(s: float, x0: int, y0: int, w: int, h: int) -> Image.Image:
        return Image.new("RGB", (w, h), "white")

    pyr = Pyramid.for_page(100.0, 50.0, 100)  # 394 x 197 px, 2 levels
    write_pyramid(render, pyr, tmp_path)
    assert Image.open(tmp_path / "tiles/1/1_0.webp").size == (394 - 256, 197)
    assert Image.open(tmp_path / "tiles/0/0_0.webp").size == (197, 99)
    assert not (tmp_path / "tiles/0/1_0.webp").exists()
