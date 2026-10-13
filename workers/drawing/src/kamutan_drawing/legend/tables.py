"""Ruled tables on a sheet: families of long parallel horizontal rules sharing their extent.

SHX drawings rarely carry a readable legend title (on the sample set "מקרא:" is never read),
so the legend is found from geometry first: a stack of ≥ 4 horizontal rules with the same
right edge, regular spacing, outside the title block. :mod:`.parse` then decides whether a
table is a symbol legend (Hebrew labels + symbol columns), a fixture-types table
("טבלת תאורה": header with "סוג" / "מס'") or something else (ignored).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from ..ingest.pdf_vector import VectorSheet
from ..symbols.geometry import BBox, seg_lengths

MIN_RULE_MM = 25.0
MAX_ROW_GAP_MM = 16.0
MIN_RULES = 4
EDGE_TOL_MM = 1.2


@dataclass
class Table:
    bbox: BBox
    rule_ys: list[float]  # y of the horizontal rules (sorted, deduplicated)
    rule_segs: list[int]  # segment indices of the horizontal rules
    vertical_segs: list[int] = field(default_factory=list)  # vertical rules inside the table

    @property
    def width(self) -> float:
        return self.bbox[2] - self.bbox[0]

    @property
    def height(self) -> float:
        return self.bbox[3] - self.bbox[1]


def _overlap(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


def find_tables(vs: VectorSheet, *, exclude: list[BBox] | None = None) -> list[Table]:
    return find_tables_segs(vs.segs, exclude=exclude)


def find_tables_segs(segs: np.ndarray, *, exclude: list[BBox] | None = None) -> list[Table]:
    """:func:`find_tables` on a plain segment array (also used for lines found in raster sheets)."""
    if len(segs) == 0:
        return []
    s = np.asarray(segs, dtype=np.float64)
    lens = seg_lengths(s)
    horiz = np.where((lens >= MIN_RULE_MM) & (np.abs(s[:, 3] - s[:, 1]) < 0.15))[0]
    if len(horiz) < MIN_RULES:
        return []
    x0 = np.minimum(s[horiz, 0], s[horiz, 2])
    x1 = np.maximum(s[horiz, 0], s[horiz, 2])
    y = (s[horiz, 1] + s[horiz, 3]) / 2
    used = np.zeros(len(horiz), bool)
    tables: list[Table] = []
    order = np.argsort(y)
    for oi in order:
        if used[oi]:
            continue
        # family: rules with the same left and right edges
        fam = [j for j in order if not used[j] and abs(x1[j] - x1[oi]) <= EDGE_TOL_MM and abs(x0[j] - x0[oi]) <= EDGE_TOL_MM]
        fam_y = sorted({round(float(y[j]), 2) for j in fam})
        # chain by vertical gaps starting at this rule
        start = round(float(y[oi]), 2)
        chain = [start]
        for yy in fam_y:
            if yy <= chain[-1] + 0.2:
                continue
            if yy - chain[-1] > MAX_ROW_GAP_MM:
                break
            chain.append(yy)
        members = [j for j in fam if chain[0] - 0.2 <= y[j] <= chain[-1] + 0.2]
        if len(chain) < MIN_RULES:
            used[oi] = True
            continue
        for j in members:
            used[j] = True
        bx0 = float(min(x0[j] for j in members))
        bx1 = float(max(x1[j] for j in members))
        bb = (bx0, chain[0], bx1, chain[-1])
        if exclude and any(
            _overlap(bb[0], bb[2], e[0], e[2]) * _overlap(bb[1], bb[3], e[1], e[3]) > 0.3 * (bb[2] - bb[0]) * (bb[3] - bb[1])
            for e in exclude
        ):
            continue
        dedup: list[float] = []
        for yy in chain:
            if not dedup or yy - dedup[-1] > 0.3:
                dedup.append(yy)
        t = Table(bb, dedup, [int(horiz[j]) for j in members])
        # vertical rules crossing the table (column separators may overshoot the outer rules)
        ylo = np.minimum(s[:, 1], s[:, 3])
        yhi = np.maximum(s[:, 1], s[:, 3])
        vert = np.where(
            (np.abs(s[:, 2] - s[:, 0]) < 0.15)
            & (lens >= 2.5)
            & (s[:, 0] >= bb[0] - 0.3)
            & (s[:, 0] <= bb[2] + 0.3)
            & (np.minimum(yhi, bb[3]) - np.maximum(ylo, bb[1]) >= 0.5 * (yhi - ylo))
        )[0]
        t.vertical_segs = [int(v) for v in vert]
        if len(vert):
            t.bbox = (bb[0], min(bb[1], float(ylo[vert].min())), bb[2], max(bb[3], float(yhi[vert].max())))
        tables.append(t)
    return tables
