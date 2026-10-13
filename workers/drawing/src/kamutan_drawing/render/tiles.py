"""WebP tile pyramid + thumbnail, rendered band by band (decision #12, SEC-16).

Layout (relative to the version artifact prefix)::

    tiles/{z}/{x}_{y}.webp      256 px tiles, z = 0 .. levels-1
    thumbnail.webp              longest side <= 512 px

* ``levels - 1`` is the full-resolution level, rendered at ``dpi`` (default 300); its size is
  ``widthPx x heightPx`` = round(paper mm / 25.4 * dpi).
* Level ``z`` is downscaled by ``2 ** (levels - 1 - z)``: size = ceil(widthPx / 2**k).
  ``z = 0`` is the most zoomed-out level that fits in one 256 px tile.
* Edge tiles are cropped, not padded: tile (x, y) of level z covers pixels
  [x*256, min((x+1)*256, Wz)) x [y*256, min((y+1)*256, Hz)).
* paper mm of a level-z pixel = px * 25.4 / dpi * 2**(levels-1-z) (origin top-left, y down).

Every level is rendered directly from the source at its own resolution, in horizontal
bands of whole tile rows, so peak memory is one band (A0 at 300 dpi: 14,043 px x 1,024 rows
~ 43 MB) and never the 139 MP page.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

TILE = 256
THUMB = 512
MM_PER_INCH = 25.4
BAND_BUDGET_PX = 24_000_000  # max pixels rendered at once
WEBP_QUALITY = 80
WEBP_METHOD = 3

# render(px_per_mm, x0, y0, w, h) -> RGB image of exactly w x h pixels of the page at that scale
BandRenderer = Callable[[float, int, int, int, int], Image.Image]


def levels_for(width_px: int, height_px: int, tile: int = TILE) -> int:
    """Same as contracts ``levelsFor``: the fewest levels so that level 0 fits in one tile."""
    levels = 1
    while math.ceil(max(width_px, height_px) / 2 ** (levels - 1)) > tile:
        levels += 1
    return levels


@dataclass(frozen=True)
class Pyramid:
    dpi: float
    width_px: int
    height_px: int
    levels: int

    @classmethod
    def for_page(cls, width_mm: float, height_mm: float, dpi: float) -> Pyramid:
        w = max(1, round(width_mm / MM_PER_INCH * dpi))
        h = max(1, round(height_mm / MM_PER_INCH * dpi))
        levels = levels_for(w, h)
        return cls(dpi=dpi, width_px=w, height_px=h, levels=levels)

    def level_size(self, z: int) -> tuple[int, int]:
        k = 2 ** (self.levels - 1 - z)
        return math.ceil(self.width_px / k), math.ceil(self.height_px / k)

    def px_per_mm(self, z: int) -> float:
        return self.dpi / MM_PER_INCH / 2 ** (self.levels - 1 - z)

    def tile_count(self) -> int:
        n = 0
        for z in range(self.levels):
            w, h = self.level_size(z)
            n += math.ceil(w / TILE) * math.ceil(h / TILE)
        return n

    def meta(self) -> dict[str, object]:
        return {
            "format": "webp",
            "tileSize": TILE,
            "dpi": round(self.dpi),
            "levels": self.levels,
            "widthPx": self.width_px,
            "heightPx": self.height_px,
        }


def _save_webp(img: Image.Image, path: Path) -> None:
    img.save(path, format="WEBP", quality=WEBP_QUALITY, method=WEBP_METHOD)


def write_pyramid(
    render: BandRenderer,
    pyr: Pyramid,
    out_dir: str | Path,
    *,
    on_level: Callable[[int, int], None] | None = None,
) -> list[str]:
    """Render all levels into ``out_dir/tiles/{z}/{x}_{y}.webp``; returns relative paths."""
    out = Path(out_dir)
    written: list[str] = []
    for z in range(pyr.levels - 1, -1, -1):
        w, h = pyr.level_size(z)
        s = pyr.px_per_mm(z)
        (out / "tiles" / str(z)).mkdir(parents=True, exist_ok=True)
        rows_per_band = max(1, BAND_BUDGET_PX // max(1, w * TILE))
        cols = math.ceil(w / TILE)
        nrows = math.ceil(h / TILE)
        for r0 in range(0, nrows, rows_per_band):
            r1 = min(nrows, r0 + rows_per_band)
            y0 = r0 * TILE
            bh = min(h, r1 * TILE) - y0
            band = render(s, 0, y0, w, bh)
            if band.size != (w, bh):
                raise ValueError("band renderer returned a wrong size")
            for r in range(r0, r1):
                for c in range(cols):
                    box = (c * TILE, r * TILE - y0, min(w, (c + 1) * TILE), min(bh, (r + 1) * TILE - y0))
                    rel = f"tiles/{z}/{c}_{r}.webp"
                    _save_webp(band.crop(box), out / rel)
                    written.append(rel)
            band.close()
        if on_level is not None:
            on_level(pyr.levels - z, pyr.levels)
    return written


def write_thumbnail(render: BandRenderer, width_mm: float, height_mm: float, out_dir: str | Path) -> str:
    s = THUMB / max(width_mm, height_mm)
    w = max(1, min(THUMB, round(width_mm * s)))
    h = max(1, min(THUMB, round(height_mm * s)))
    img = render(s, 0, 0, w, h)
    _save_webp(img, Path(out_dir) / "thumbnail.webp")
    return "thumbnail.webp"
