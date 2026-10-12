"""Scale: declared value from the title block + sanity check from dimension strings.

Dimension check: a number (e.g. "550", in cm by Israeli architectural convention)
written just above/beside a straight dimension line parallel to the text. For
each such pair, implied denominator = value_cm * 10 / line_length_mm. The median
over all pairs, and the share agreeing with the declared scale, are reported.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import numpy as np

from ..ingest.pdf_vector import VectorSheet

COMMON_SCALES = (1, 2, 5, 10, 20, 25, 50, 75, 100, 200, 250, 500, 1000)
_NUM = re.compile(r"^\d{2,4}$")
_SCALE_IN_TEXT = re.compile(r"1\s*:\s*(\d{1,4})")


@dataclass
class ScaleResult:
    declared: int | None
    from_dimensions: int | None
    n_dimension_pairs: int
    agree_share: float  # share of pairs within 3% of the declared scale
    conflict: bool
    other_scales_in_text: list[int] = field(default_factory=list)
    samples: list[tuple[str, float, float]] = field(default_factory=list)  # (text, length_mm, ratio)


def scales_in_text(spans) -> list[int]:
    out = []
    for s in spans:
        for m in _SCALE_IN_TEXT.finditer(s.text):
            out.append(int(m.group(1)))
    return out


def dimension_pairs(spans, vs: VectorSheet, max_perp_h: float = 1.6) -> list[tuple[str, float, float]]:
    seg = vs.segs
    dx = seg[:, 2] - seg[:, 0]
    dy = seg[:, 3] - seg[:, 1]
    L = np.hypot(dx, dy)
    hor = (np.abs(dy) < 0.02) & (L > 5)
    ver = (np.abs(dx) < 0.02) & (L > 5)
    H = seg[hor]
    V = seg[ver]
    res = []
    for s in spans:
        t = s.text.strip()
        if not _NUM.match(t):
            continue
        val = int(t)
        x0, y0, x1, y1 = s.bbox
        h = s.height
        if s.rotation == 0:
            cx = (x0 + x1) / 2
            lo, hi = np.minimum(H[:, 0], H[:, 2]), np.maximum(H[:, 0], H[:, 2])
            y = H[:, 1]
            # line just below the text baseline (text sits above the dimension line)
            d = y - y1
            m = (lo <= cx) & (hi >= cx) & (d >= -0.2) & (d <= max_perp_h * h)
            lens = hi - lo
        else:
            cy = (y0 + y1) / 2
            lo, hi = np.minimum(V[:, 1], V[:, 3]), np.maximum(V[:, 1], V[:, 3])
            x = V[:, 0]
            # rotated text: line on either side
            d = np.minimum(np.abs(x - x0), np.abs(x - x1))
            m = (lo <= cy) & (hi >= cy) & (d <= max_perp_h * h)
            lens = hi - lo
        if not m.any():
            continue
        k = int(np.argmin(np.where(m, np.abs(d), np.inf)))
        length = float(lens[k])
        if length < 3 * h or val == 0:  # too short to be a dimension line
            continue
        res.append((t, length, val * 10.0 / length))
    return res


def detect_scale(declared: int | None, spans, vs: VectorSheet) -> ScaleResult:
    pairs = dimension_pairs(spans, vs)
    ratios = np.array([r for _, _, r in pairs])
    est = None
    if len(ratios) >= 3:
        # vote for the nearest common scale (log distance < 5%)
        votes: dict[int, int] = {}
        for r in ratios:
            c = min(COMMON_SCALES, key=lambda s: abs(np.log(r / s)))
            if abs(np.log(r / c)) < 0.05:
                votes[c] = votes.get(c, 0) + 1
        if votes:
            ranked = sorted(votes.values(), reverse=True)
            best = max(votes, key=votes.get)
            # clear plurality: stray numbers (heights "H=240", item tags) also sit near lines
            if ranked[0] >= 3 and (len(ranked) == 1 or ranked[0] >= 2 * ranked[1]):
                est = best
    agree = float(np.mean(np.abs(np.log(ratios / declared)) < 0.03)) if (declared and len(ratios)) else 0.0
    conflict = bool(declared and est and est != declared)
    return ScaleResult(
        declared=declared,
        from_dimensions=est,
        n_dimension_pairs=len(pairs),
        agree_share=round(agree, 3),
        conflict=conflict,
        other_scales_in_text=sorted(set(scales_in_text(spans)) - ({declared} if declared else set())),
        samples=pairs[:10],
    )
