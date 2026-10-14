"""Translation between two drawings of the same floor (paper mm), by FFT cross-correlation of rasterised masks.

Used to borrow walls from the architecture sheet onto an MEP sheet of the same floor and to de-duplicate
fixtures across sheets. Sheets of one project share the scale (1:50) but not the placement on the paper
(a portrait sheet stacks two plans), so only a translation is estimated: masks at ``px_per_mm`` (default 1),
correlation peak → integer shift, refined by a second pass at 4 px/mm in a ±3 mm window. The result carries the
IoU of the two masks after the shift; callers accept it above ~0.5 (walls) / 0.4 (room faces).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw
from scipy.signal import fftconvolve
from shapely import affinity
from shapely.geometry import MultiPolygon, Polygon
from shapely.geometry.base import BaseGeometry


@dataclass(frozen=True)
class Alignment:
    dx: float  # b ≈ a + (dx, dy)
    dy: float
    iou: float

    def apply(self, g: BaseGeometry) -> BaseGeometry:
        """Move a geometry of drawing *a* into the frame of drawing *b*."""
        return affinity.translate(g, self.dx, self.dy)


def _polys(g: BaseGeometry) -> list[Polygon]:
    if g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    if isinstance(g, MultiPolygon):
        return list(g.geoms)
    return [p for p in getattr(g, "geoms", []) if isinstance(p, Polygon)]


def rasterize(g: BaseGeometry, origin: tuple[float, float], shape: tuple[int, int], px_per_mm: float) -> np.ndarray:
    h, w = shape
    img = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(img)
    ox, oy = origin
    for p in _polys(g):
        ext = [((x - ox) * px_per_mm, (y - oy) * px_per_mm) for x, y in p.exterior.coords]
        if len(ext) >= 3:
            d.polygon(ext, fill=255)
        for ring in p.interiors:
            hole = [((x - ox) * px_per_mm, (y - oy) * px_per_mm) for x, y in ring.coords]
            if len(hole) >= 3:
                d.polygon(hole, fill=0)
    return (np.asarray(img) > 127).astype(np.float32)


def _corr_peak(a: np.ndarray, b: np.ndarray) -> tuple[int, int]:
    """Shift (sy, sx) maximising sum(a[y,x] * b[y+sy, x+sx])."""
    c = fftconvolve(b, a[::-1, ::-1], mode="full")
    iy, ix = np.unravel_index(int(np.argmax(c)), c.shape)
    return int(iy - (a.shape[0] - 1)), int(ix - (a.shape[1] - 1))


def align(a: BaseGeometry, b: BaseGeometry, *, px_per_mm: float = 1.0, edges: bool = False) -> Alignment | None:
    """Translation moving geometry ``a`` onto geometry ``b`` (both paper mm), or None when either is empty.

    ``edges=True`` correlates thin outlines (boundaries buffered 0.5 mm) instead of the filled areas — better for
    room faces (large flat areas correlate loosely)."""
    if a.is_empty or b.is_empty:
        return None
    if edges:
        a = a.boundary.buffer(0.5)
        b = b.boundary.buffer(0.5)
    ax0, ay0, ax1, ay1 = a.bounds
    bx0, by0, bx1, by1 = b.bounds
    sa = (int((ay1 - ay0) * px_per_mm) + 2, int((ax1 - ax0) * px_per_mm) + 2)
    sb = (int((by1 - by0) * px_per_mm) + 2, int((bx1 - bx0) * px_per_mm) + 2)
    if max(sa + sb) > 6000:
        return None
    ma = rasterize(a, (ax0, ay0), sa, px_per_mm)
    mb = rasterize(b, (bx0, by0), sb, px_per_mm)
    if ma.sum() == 0 or mb.sum() == 0:
        return None
    sy, sx = _corr_peak(ma, mb)
    dx = bx0 - ax0 + sx / px_per_mm
    dy = by0 - ay0 + sy / px_per_mm
    # refine at 4 px/mm in a small window around the coarse shift
    fine = 4.0
    moved = affinity.translate(a, dx, dy)
    x0, y0 = min(moved.bounds[0], bx0) - 3, min(moved.bounds[1], by0) - 3
    x1, y1 = max(moved.bounds[2], bx1) + 3, max(moved.bounds[3], by1) + 3
    shape = (int((y1 - y0) * fine) + 2, int((x1 - x0) * fine) + 2)
    if max(shape) <= 8000:
        fa = rasterize(moved, (x0, y0), shape, fine)
        fb = rasterize(b, (x0, y0), shape, fine)
        best = (-1.0, 0, 0)
        w = int(3 * fine)
        # coarse-to-fine search on the shifted masks (cheap: products of the cropped overlap)
        for ry in range(-w, w + 1, 2):
            for rx in range(-w, w + 1, 2):
                s = _overlap(fa, fb, ry, rx)
                if s > best[0]:
                    best = (s, ry, rx)
        _, ry, rx = best
        for yy in (ry - 1, ry, ry + 1):
            for xx in (rx - 1, rx, rx + 1):
                s = _overlap(fa, fb, yy, xx)
                if s > best[0]:
                    best = (s, yy, xx)
        dx -= best[2] / fine
        dy -= best[1] / fine
    moved = affinity.translate(a, dx, dy)
    inter = moved.intersection(b).area
    union = moved.union(b).area
    return Alignment(float(dx), float(dy), float(inter / union) if union > 0 else 0.0)


def _overlap(a: np.ndarray, b: np.ndarray, sy: int, sx: int) -> float:
    """sum(a[y, x] * b[y - sy, x - sx]) — overlap after moving b by (sy, sx) in pixels (a fixed)."""
    h, w = a.shape
    ya0, ya1 = max(0, sy), min(h, h + sy)
    xa0, xa1 = max(0, sx), min(w, w + sx)
    if ya1 <= ya0 or xa1 <= xa0:
        return 0.0
    return float((a[ya0:ya1, xa0:xa1] * b[ya0 - sy : ya1 - sy, xa0 - sx : xa1 - sx]).sum())


def align_polygons(a: Sequence[Sequence[tuple[float, float]]], b: Sequence[Sequence[tuple[float, float]]]) -> Alignment | None:
    """:func:`align` for two lists of polygons (e.g. room polygons of two sheets of one floor), on outlines."""
    from shapely import union_all

    pa = [Polygon(p) for p in a if len(p) >= 3]
    pb = [Polygon(p) for p in b if len(p) >= 3]
    if not pa or not pb:
        return None
    return align(union_all([p.buffer(0) for p in pa]), union_all([p.buffer(0) for p in pb]), edges=True)
