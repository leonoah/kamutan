"""Fixture-type tags: a type number in a small circle next to a luminaire ("טבלת תאורה").

The SHX reader cannot read these (the circle and the digits form one glyph cluster, typically
read as "0"), so the number is recognised geometrically: the strokes inside the circle are
compared with the strokes of every number in the fixture-types table of the same sheet (same
font, same drafting) after normalising both by their height — a nearest-neighbour reading
with a margin, which is exactly what the table defines.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
from scipy.spatial import cKDTree

from ..ingest.pdf_vector import SEG_BEZIER, VectorSheet
from ..legend.parse import LegendEntry
from .arcs import Arc
from .geometry import BBox, bbox_of, in_box, resample

MIN_TAG_R = 0.8
MAX_TAG_R = 3.2
ACCEPT = 0.05  # mean symmetric chamfer / digit height (true readings are ~0.01)
MARGIN = 0.006


@dataclass
class Tag:
    entry: LegendEntry
    cx: float
    cy: float
    r: float
    dist: float
    margin: float

    @property
    def bbox(self) -> BBox:
        return (self.cx - self.r, self.cy - self.r, self.cx + self.r, self.cy + self.r)


def _norm(segs: np.ndarray) -> np.ndarray | None:
    if len(segs) == 0:
        return None
    b = bbox_of(segs)
    h = b[3] - b[1]
    if h < 0.3:
        return None
    c = np.array([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2])
    pts, _ = resample(segs, h / 40)
    return (pts - c) / h


def _sym(a: np.ndarray, ta: cKDTree, b: np.ndarray, tb: cKDTree) -> float:
    return float((tb.query(a)[0].mean() + ta.query(b)[0].mean()) / 2)


def number_glyphs(vs: VectorSheet, entries: list[LegendEntry]) -> list[tuple[LegendEntry, np.ndarray, Any]]:
    """Normalised strokes of each table number (from the number cell of the types table)."""
    s = vs.segs.astype(np.float64)
    mx, my = (s[:, 0] + s[:, 2]) / 2, (s[:, 1] + s[:, 3]) / 2
    lens = np.hypot(s[:, 2] - s[:, 0], s[:, 3] - s[:, 1])
    out: list[tuple[LegendEntry, np.ndarray, Any]] = []
    for e in entries:
        if e.kind != "type":
            continue
        b = e.symbol_bbox
        h = b[3] - b[1]
        sel = np.where(in_box(mx, my, b, pad=0.15) & (lens < 1.2 * h + 0.2))[0]
        p = _norm(s[sel])
        if p is not None and len(p) >= 8:
            out.append((e, p, cKDTree(p)))
    return out


def _circle_strokes(vs: VectorSheet, s: np.ndarray, tree: cKDTree, a: Arc) -> np.ndarray | None:
    """Strokes strictly inside the circle, or None when a stroke enters it from outside (⊕)."""
    idx = np.asarray(tree.query_ball_point([a.cx, a.cy], a.r), dtype=np.int64)
    if len(idx) == 0:
        return None
    # drop the circle itself (its flattened bezier pieces), keep other strokes of the same path (⊕ cross)
    own = (vs.seg_path[idx] == a.path) & (vs.seg_kind[idx] == SEG_BEZIER)
    sg = s[idx[~own]]
    if len(sg) == 0:
        return None
    d0 = np.hypot(sg[:, 0] - a.cx, sg[:, 1] - a.cy)
    d1 = np.hypot(sg[:, 2] - a.cx, sg[:, 3] - a.cy)
    lo, hi = np.minimum(d0, d1), np.maximum(d0, d1)
    ln = np.hypot(sg[:, 2] - sg[:, 0], sg[:, 3] - sg[:, 1])
    if (((lo <= 0.8 * a.r) & (hi >= 1.15 * a.r)) | ((lo > 1.05 * a.r) & (ln > 1.5 * a.r) & (ln < 4 * a.r))).any():
        return None
    inner = sg[(hi <= 0.985 * a.r)]
    return inner if len(inner) >= 2 else None


def _read(
    p: np.ndarray, glyphs: list[tuple[LegendEntry, np.ndarray, cKDTree]], fwd_weight: float
) -> list[tuple[float, LegendEntry]]:
    tp = cKDTree(p)
    out = []
    for e, g, tg in glyphs:
        f = float(tp.query(g)[0].mean())  # table glyph → strokes in the circle
        r_ = float(np.minimum(tg.query(p)[0], 0.15).mean())
        out.append((fwd_weight * f + (1 - fwd_weight) * r_, e))
    return sorted(out, key=lambda q: q[0])


def find_tags(vs: VectorSheet, arcs: list[Arc], entries: list[LegendEntry], exclude: list[BBox]) -> list[Tag]:
    """Two passes: (1) digits normalised by their own bbox — clean tags, learns the digit height /
    circle radius ratio; (2) the rest normalised by the circle (robust to a dimension line or a
    leader crossing the digits)."""
    glyphs = number_glyphs(vs, entries)
    if not glyphs:
        return []
    s = vs.segs.astype(np.float64)
    mid = np.column_stack([(s[:, 0] + s[:, 2]) / 2, (s[:, 1] + s[:, 3]) / 2])
    tree = cKDTree(mid)
    circles: list[tuple[Arc, np.ndarray]] = []
    for a in arcs:
        if not (a.full and MIN_TAG_R <= a.r <= MAX_TAG_R):
            continue
        if any(b[0] <= a.cx <= b[2] and b[1] <= a.cy <= b[3] for b in exclude):
            continue
        inner = _circle_strokes(vs, s, tree, a)
        if inner is not None:
            circles.append((a, inner))
    tags: list[Tag] = []
    rest: list[tuple[Arc, np.ndarray]] = []
    ratios: list[float] = []
    for a, inner in circles:
        p = _norm(inner)
        if p is None:
            rest.append((a, inner))
            continue
        scored = _read(p, glyphs, 0.5)
        best, e = scored[0]
        second = scored[1][0] if len(scored) > 1 else 1.0
        if best <= ACCEPT and second - best >= MARGIN:
            tags.append(Tag(e, a.cx, a.cy, a.r, best, second - best))
            b = bbox_of(inner)
            ratios.append((b[3] - b[1]) / a.r)
        else:
            rest.append((a, inner))
    if ratios and rest:
        k = float(np.median(ratios))
        for a, inner in rest:
            pts, _ = resample(inner, max(0.02, k * a.r / 40))
            p = (pts - np.array([a.cx, a.cy])) / (k * a.r)
            scored = _read(p, glyphs, 0.8)
            best, e = scored[0]
            second = scored[1][0] if len(scored) > 1 else 1.0
            if best <= ACCEPT * 1.2 and second - best >= 1.5 * MARGIN:
                tags.append(Tag(e, a.cx, a.cy, a.r, best, second - best))
    return tags
