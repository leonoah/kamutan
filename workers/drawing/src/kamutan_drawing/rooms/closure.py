"""Sprint 11 (Worker-Rooms): wall evidence the fill / heavy-pen rules miss on villa plans.

Measured on the Achituv / Yahav / Rubel plans (rendered and read, see NOTES "Sprint 11 Worker-Rooms"):

* **Hatched walls** — a concrete shelter (ממ"ד) is drawn as two thin outline lines with a 45° / 135° cross hatch
  between them and no fill; the hatch strokes are short and regular, so the SHX reader lists them as text strokes
  and the wall pass never saw them. :func:`hatched_walls` returns the cross-hatched regions that are wall-thick.
* **Glazing bands** — a sliding vitrine is drawn as two or three staggered leaf rectangles (5 cm × 1.7 m each), a
  fixed window as a frame line broken at every mullion: no single polyline runs from jamb to jamb, and a full-width
  vitrine ends at a *perpendicular* wall, so the jamb test of ``walls._add_windows`` fails too. The whole ground floor
  then leaks to the garden and no room is built. :func:`glazing_bands` finds bundles of ≥ 2 parallel straight strokes
  at most ``BAND_MAX_M`` apart that together run from one wall piece to another.

Both are pure geometry on the vector primitives (paper mm) and never look at a specific project.
"""

from __future__ import annotations

import numpy as np
from shapely.geometry import Polygon, box
from shapely.geometry.base import BaseGeometry

from ..ingest.pdf_vector import VectorSheet

HATCH_STROKE_MM = (1.5, 40.0)  # hatch stroke length, paper mm
HATCH_WALL_T_M = (0.08, 0.45)  # thickness of a hatched wall, real metres
HATCH_WALL_MIN_LEN_M = 0.6
HATCH_MAX_SEGS = 60000
PIER_MAX_M2 = 1.0

BAND_PX_PER_MM = 4.0
BAND_MIN_LEN_M = 0.5  # shortest glazing band
BAND_MAX_LEN_M = 9.0
BAND_MAX_M = 0.2  # the leaves / frame lines of one glazing lie within this width
BAND_TOTAL_M = 0.4  # … and the whole bundle (sills at both wall faces) within this
BAND_STROKE_MIN_M = 0.3  # a stroke shorter than this is not a frame line
BAND_REACH_M = 0.12  # a band end this close to a wall touches it
BAND_MAX_PX = 60_000_000


def _poly_parts(g: BaseGeometry) -> list[Polygon]:
    if g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    return [p for p in getattr(g, "geoms", []) if isinstance(p, Polygon)]


def hatched_walls(
    vs: VectorSheet, bx: tuple[float, float, float, float], mm_per_m: float, piers: list[Polygon] | None = None
) -> list[Polygon]:
    """Wall-thick regions filled with a diagonal cross hatch (concrete walls drawn without a fill) inside ``bx``.

    ``piers`` (out): rectangular, wall-thick regions of at most ``PIER_MAX_M2`` with a *one-way* diagonal hatch — the
    wall ends / columns between the windows of a facade (Yahav ground floor); the caller keeps the ones that touch a
    filled wall."""
    from ..geometry.hatches import hatch_families, hatch_regions
    from ..geometry.prims import stroked_segments

    segs = stroked_segments(vs, min_len=HATCH_STROKE_MM[0], box_mm=bx)
    if len(segs.xy) < 10:
        return []
    # diagonal strokes only: an axis-parallel "hatch" is a stair, a tile grid or a louvre, never a wall
    diag = (np.abs((segs.angle % 90.0) - 45.0) <= 12.0) & (segs.length <= HATCH_STROKE_MM[1])
    out: list[Polygon] = []
    # the neutral pen only: a cross hatch in a highlight colour marks a work item (a lining, a new ceiling), not concrete
    for cc in ("neutral",):
        sel = diag & (segs.cclass == cc)
        if not (10 <= int(sel.sum()) <= HATCH_MAX_SEGS):
            continue
        for reg in hatch_regions(hatch_families(segs, sel)):
            if reg.pattern != "cross":
                if piers is not None and reg.pattern == "lines":
                    # a pier / wall end drawn with a one-way diagonal hatch (kept only where it touches a filled wall)
                    g = reg.poly.buffer(-0.25 * float(reg.spacing or 0.0), join_style="mitre")
                    for p in _poly_parts(g):
                        t = 2.0 * p.area / max(p.length, 1e-6)
                        rect = p.minimum_rotated_rectangle
                        if (
                            HATCH_WALL_T_M[0] * mm_per_m <= t <= HATCH_WALL_T_M[1] * mm_per_m
                            and p.area <= PIER_MAX_M2 * mm_per_m**2
                            and rect.area > 0
                            and p.area / rect.area >= 0.8
                        ):
                            piers.append(rect if isinstance(rect, Polygon) else p)
                continue
            # the outline lies half a hatch spacing outside the strokes' ends: back to the wall faces
            g = reg.poly.buffer(-0.25 * float(reg.spacing or 0.0), join_style="mitre")
            for p in _poly_parts(g):
                t = 2.0 * p.area / max(p.length, 1e-6)
                if not (HATCH_WALL_T_M[0] * mm_per_m <= t <= HATCH_WALL_T_M[1] * mm_per_m):
                    continue
                if p.length / 2.0 < HATCH_WALL_MIN_LEN_M * mm_per_m:
                    continue
                # the hatch outline is a saw-tooth of hundreds of vertices: a few straight edges do (and keep the
                # later buffers of the wall union fast)
                q = p.simplify(0.3, preserve_topology=True)
                out.append(q if isinstance(q, Polygon) and not q.is_empty else p)
    return out


def _bands_h(lines: np.ndarray, walls: np.ndarray, px_per_m: float) -> list[tuple[int, int, int, int]]:
    """Horizontal glazing bands ``(x0, y0, x1, y1)`` (pixel box, exclusive ends) of a horizontal-stroke raster."""
    from scipy import ndimage

    h, w = lines.shape
    gap = max(2, round(BAND_MAX_M * px_per_m))
    reach = max(2, round(BAND_REACH_M * px_per_m))
    # the outline strokes of the walls themselves are not glazing: without them a band ends where its opening ends
    lines = lines & ~ndimage.binary_dilation(walls, structure=np.ones((3, 3), bool))
    # strokes closer than the band width (across) merge into one blob; along the band small breaks (mullions) close
    blob = ndimage.binary_closing(np.pad(lines, gap), structure=np.ones((gap, 1), bool))[gap:-gap, gap:-gap]
    blob = ndimage.binary_closing(np.pad(blob, reach), structure=np.ones((1, reach), bool))[reach:-reach, reach:-reach]
    lab, n = ndimage.label(blob, structure=np.ones((3, 3), bool))
    out: list[tuple[int, int, int, int]] = []
    if n == 0:
        return out
    for k, sl in enumerate(ndimage.find_objects(lab), start=1):
        if sl is None:
            continue
        ys, xs = sl
        y0, y1, x0, x1 = ys.start, ys.stop, xs.start, xs.stop
        ln = x1 - x0
        if not (BAND_MIN_LEN_M * px_per_m <= ln <= BAND_MAX_LEN_M * px_per_m):
            continue
        if not (2 <= y1 - y0 <= round(BAND_TOTAL_M * px_per_m) + 2):
            continue
        comp = lab[y0:y1, x0:x1] == k
        rows = (lines[y0:y1, x0:x1] & comp).sum(axis=1)
        strong = rows >= 0.3 * ln  # rows that carry a stroke along a good part of the band
        if int(strong.sum()) < 2 or int(np.ptp(np.where(strong)[0])) < 1:
            continue  # a single line: a furniture edge, a dimension line
        if comp.any(axis=0).mean() < 0.85:
            continue
        # both ends reach a wall
        ya, yb = max(0, y0 - 1), min(h, y1 + 1)
        left = walls[ya:yb, max(0, x0 - reach) : x0 + 1].any()
        right = walls[ya:yb, x1 - 1 : min(w, x1 + reach)].any()
        if not (left and right):
            continue
        if walls[y0:y1, x0:x1].mean() > 0.5:
            continue  # runs inside a wall: its outline, not an opening
        out.append((x0 - reach, y0, x1 + reach, y1))
    return out


def glazing_bands(
    vs: VectorSheet,
    walls: BaseGeometry,
    bx: tuple[float, float, float, float],
    mm_per_m: float,
    exclude_paths: set[int] | None = None,
) -> list[Polygon]:
    """Axis-parallel glazing bands inside ``bx`` (paper mm): closing rectangles between two wall pieces.

    A band = ≥ 2 parallel solid strokes (each ≥ ``BAND_STROKE_MIN_M``) within ``BAND_MAX_M`` of each other that,
    joined across small breaks, cover a run of ``BAND_MIN_LEN_M``–``BAND_MAX_LEN_M`` whose both ends reach a wall and
    that does not lie inside a wall. Stair treads (≥ 25 cm apart), wardrobes (60 cm deep) and single furniture /
    dimension lines do not qualify."""
    from PIL import Image, ImageDraw

    from .align import rasterize

    if walls.is_empty or vs.n_segs == 0:
        return []
    x0, y0, x1, y1 = bx
    ppm = BAND_PX_PER_MM
    w, h = int((x1 - x0) * ppm) + 2, int((y1 - y0) * ppm) + 2
    if w * h > BAND_MAX_PX or w < 8 or h < 8:
        return []
    px_per_m = mm_per_m * ppm
    ok = vs.path_stroked & np.array([len(d) == 0 for d in vs.path_dash], bool)
    if exclude_paths:
        ex = np.zeros(vs.n_paths, bool)
        ex[[i for i in exclude_paths if 0 <= i < vs.n_paths]] = True
        ok &= ~ex
    s = vs.segs.astype(np.float64)
    sel = ok[vs.seg_path]
    cx, cy = (s[:, 0] + s[:, 2]) / 2, (s[:, 1] + s[:, 3]) / 2
    sel &= (cx >= x0) & (cx <= x1) & (cy >= y0) & (cy <= y1)
    dx, dy = np.abs(s[:, 2] - s[:, 0]), np.abs(s[:, 3] - s[:, 1])
    min_len = BAND_STROKE_MIN_M * mm_per_m
    hor = sel & (dx >= min_len) & (dy <= 0.02 * dx + 0.05)
    ver = sel & (dy >= min_len) & (dx <= 0.02 * dy + 0.05)
    wall_mask = rasterize(walls.intersection(box(*bx)), (x0, y0), (h, w), ppm) > 0

    def draw(idx: np.ndarray) -> np.ndarray:
        img = Image.new("L", (w, h), 0)
        d = ImageDraw.Draw(img)
        for a, b, c, e in s[idx]:
            d.line([((a - x0) * ppm, (b - y0) * ppm), ((c - x0) * ppm, (e - y0) * ppm)], fill=255, width=1)
        return np.asarray(img) > 127

    out: list[Polygon] = []
    if hor.any():
        for bx0, by0, bx1, by1 in _bands_h(draw(np.where(hor)[0]), wall_mask, px_per_m):
            out.append(box(x0 + bx0 / ppm, y0 + by0 / ppm, x0 + bx1 / ppm, y0 + by1 / ppm))
    if ver.any():
        for bx0, by0, bx1, by1 in _bands_h(draw(np.where(ver)[0]).T, wall_mask.T, px_per_m):
            out.append(box(x0 + by0 / ppm, y0 + bx0 / ppm, x0 + by1 / ppm, y0 + bx1 / ppm))
    return out


__all__ = ["glazing_bands", "hatched_walls"]
