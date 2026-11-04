"""Wall heights drawn in a section beside the plan (Sprint 7, Worker-Accuracy item 3).

A section ("חתך") draws a new wall as a tall thin highlight strip (red hatch for cast concrete, red fill for a
gypsum lining) between level marks ("+0.00", "+0.65", "-0.50 … -2.57"). Its vertical scale is not written, but the
level marks give it: two marks ``Δv`` metres apart sit ``Δy`` paper mm apart → ``mm_per_m = Δy / Δv`` (all pairs must
agree within ``SCALE_TOL``). The strip's drawn height / ``mm_per_m`` is the wall's height as drawn — for a retaining
wall the whole cast height (top of wall down to the underside of its footing), for a lining floor to ceiling.

:func:`section_walls` finds the strips among the highlight regions *outside* the plan zone (details beside the plan),
reads their scale from the level marks next to them and names them by the note pointing at them (flags as on the
plan). Pure.
"""

from __future__ import annotations

import itertools
from collections.abc import Sequence
from dataclasses import dataclass, field

import numpy as np
from shapely.geometry import LineString, MultiLineString, Polygon
from shapely.geometry.base import BaseGeometry

from . import labels as L

COLUMN_STEP_MM = 0.25
STRIP_FRACTION = 0.9  # columns at ≥ 90 % of the tallest vertical extent form the strip
MIN_STRIP_MM = 15.0
MIN_ASPECT = 4.0
LEVEL_DX_MM = 250.0  # level marks of the section: within this horizontal distance of the strip
LEVEL_DY_MM = 15.0  # … and within the strip's height (± this)
MIN_DV_M = 0.15
SCALE_TOL = 0.12
MM_PER_M = (10.0, 250.0)  # 1:100 … 1:4
HEIGHT_M = (0.3, 8.0)
MERGE_GAP_M = 0.6
PIECE_MIN_MM = 3.0  # a piece of a strip interrupted by an element drawn across it


@dataclass
class SectionWall:
    poly: BaseGeometry
    top_mm: float
    bottom_mm: float
    x_mm: float
    mm_per_m: float
    height_m: float
    levels: list[float]
    flags: set[str] = field(default_factory=set)
    note: str | None = None

    def bbox_json(self) -> dict[str, float]:
        x0, y0, x1, y1 = self.poly.bounds
        return {"x": round(x0, 2), "y": round(y0, 2), "w": round(x1 - x0, 2), "h": round(y1 - y0, 2)}


def vertical_strip(
    p: BaseGeometry, min_mm: float = MIN_STRIP_MM, min_aspect: float = MIN_ASPECT
) -> tuple[float, float, float, float] | None:
    """(x, top, bottom, width) of the tallest vertical strip of ``p`` (paper mm), None when ``p`` has none."""
    if p.is_empty:
        return None
    x0, y0, x1, y1 = p.bounds
    xs = np.arange(x0 + COLUMN_STEP_MM / 2, x1, COLUMN_STEP_MM)
    if len(xs) == 0:
        return None
    cols: list[tuple[float, float, float]] = []  # (extent, top, bottom) per column
    for x in xs.tolist():
        cut = p.intersection(LineString([(x, y0 - 1), (x, y1 + 1)]))
        pieces = list(cut.geoms) if isinstance(cut, MultiLineString) else ([cut] if isinstance(cut, LineString) else [])
        pieces = [g for g in pieces if isinstance(g, LineString) and not g.is_empty]
        if not pieces:
            cols.append((0.0, 0.0, 0.0))
            continue
        g = max(pieces, key=lambda q: q.length)
        _, gy0, _, gy1 = g.bounds
        cols.append((gy1 - gy0, gy0, gy1))
    ext = np.array([c[0] for c in cols])
    top = float(ext.max())
    if top < min_mm:
        return None
    on = ext >= STRIP_FRACTION * top
    # the longest run of consecutive strip columns
    best: tuple[int, int] = (0, 0)
    for _k, grp in itertools.groupby(enumerate(on.tolist()), key=lambda t: t[1]):
        run_ = list(grp)
        if run_[0][1] and len(run_) > best[1] - best[0]:
            best = (run_[0][0], run_[-1][0] + 1)
    i0, i1 = best
    width = (i1 - i0) * COLUMN_STEP_MM
    if width <= 0 or top < min_aspect * width:
        return None
    mid = (i0 + i1 - 1) // 2
    # the strip's extent: the tallest column of the run (the outer face of a wall on its footing)
    k = i0 + int(np.argmax(ext[i0:i1]))
    _, t, b = cols[k]
    return float(xs[mid]), t, b, width


def section_scale(levels: Sequence[tuple[float, float, float]]) -> tuple[float, list[float]] | None:
    """``mm_per_m`` from level marks ``(x, y, value)`` of one section (every pair agrees within ``SCALE_TOL``) and the
    elevations used. Values are taken as read, else as depths below ±0.00 (the SHX reader drops "-": "0.50 / 2.57"
    on a basement section) — whichever puts every higher level above (smaller y) the lower ones."""
    if len({round(abs(v), 2) for _, _, v in levels}) < 2:
        return None
    for conv in ((lambda v: v), (lambda v: -abs(v))):
        pts = [(y, conv(v)) for _, y, v in levels]
        ratios: list[float] = []
        ordered = True
        for (ya, ea), (yb, eb) in itertools.combinations(pts, 2):
            de = ea - eb
            if abs(de) < MIN_DV_M:
                continue
            dy = yb - ya
            if dy * de <= 0:  # a higher level must be drawn higher on the sheet
                ordered = False
                break
            ratios.append(abs(dy) / abs(de))
        if not ordered or not ratios:
            continue
        med = float(np.median(ratios))
        if MM_PER_M[0] <= med <= MM_PER_M[1] and all(abs(r - med) <= SCALE_TOL * med for r in ratios):
            return med, sorted({round(e, 2) for _, e in pts})
    return None


def section_walls(
    regions: Sequence[BaseGeometry],
    levels: Sequence[tuple[float, float, float]],
    notes: Sequence[L.Note],
    *,
    exclude: BaseGeometry | None = None,
) -> list[SectionWall]:
    """Wall strips drawn in sections: highlight ``regions`` outside ``exclude`` (the plan zone) with level marks
    beside them (also outside ``exclude``) giving the scale. Pieces of one strip interrupted by an element drawn
    across it (the AC outlet box in a lining) are one wall when the gap is ≤ ``MERGE_GAP_M``."""
    from shapely.geometry import Point
    from shapely.ops import unary_union

    lv = [t for t in levels if exclude is None or not exclude.contains(Point(t[0], t[1]))]
    raw: list[tuple[BaseGeometry, float, float, float, float]] = []  # (poly, x, top, bottom, width)
    for p in regions:
        if not isinstance(p, Polygon) or p.is_empty:
            continue
        if exclude is not None and p.intersection(exclude).area > 0.2 * p.area:
            continue
        st = vertical_strip(p, PIECE_MIN_MM, 1.0)
        if st is not None:
            raw.append((p, *st))
    raw.sort(key=lambda t: (round(t[1], 1), t[2]))
    out: list[SectionWall] = []
    used: set[int] = set()
    for i, (p, x, top, bottom, w) in enumerate(raw):
        if i in used:
            continue
        near = [t for t in lv if abs(t[0] - x) <= LEVEL_DX_MM and top - LEVEL_DY_MM <= t[1] <= bottom + LEVEL_DY_MM]
        sc = section_scale(near)
        group = [p]
        for j in range(i + 1, len(raw)):
            q, xq, tq, bq, wq = raw[j]
            if j in used or abs(xq - x) > 0.6 * max(w, wq):
                continue
            gap = max(tq - bottom, top - bq, 0.0)
            if sc is not None and gap <= MERGE_GAP_M * sc[0]:
                used.add(j)
                group.append(q)
                top, bottom = min(top, tq), max(bottom, bq)
        near = [t for t in lv if abs(t[0] - x) <= LEVEL_DX_MM and top - LEVEL_DY_MM <= t[1] <= bottom + LEVEL_DY_MM]
        sc = section_scale(near)
        if sc is None:
            continue
        mm_per_m, used_levels = sc
        if bottom - top < MIN_STRIP_MM or bottom - top < MIN_ASPECT * w:
            continue
        h = (bottom - top) / mm_per_m
        if not (HEIGHT_M[0] <= h <= HEIGHT_M[1]):
            continue
        g = unary_union(group)
        note, _src, _d = L.best_note(g, notes)
        out.append(SectionWall(g, top, bottom, x, mm_per_m, round(h, 3), used_levels, set(note.flags) if note else set(),
                               note.text if note else None))  # fmt: skip
    return out
