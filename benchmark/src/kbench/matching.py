"""Detection <-> ground-truth matching (test plan, "התאמת זיהוי לאמת").

Hungarian assignment per sheet (and per class for detection metrics). A pair is
valid if IoU >= ``iou_threshold``; for small symbols (GT bbox max side <
``small_symbol_mm`` paper mm) or point geometries, the pair is valid if the centre
distance is <= ``center_tol_mm`` paper mm instead. Among valid pairs the assignment
maximises the number of matches first and the summed quality second.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal, Sequence

import numpy as np
from scipy.optimize import linear_sum_assignment

from .data import Feature

MatchMode = Literal["auto", "iou", "center"]


@dataclass(frozen=True)
class MatchParams:
    iou_threshold: float = 0.5
    center_tol_mm: float = 3.0
    small_symbol_mm: float = 8.0
    mode: MatchMode = "auto"


def iou_bbox(a: Sequence[float], b: Sequence[float]) -> float:
    ix0, iy0 = max(a[0], b[0]), max(a[1], b[1])
    ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0.0, ix1 - ix0), max(0.0, iy1 - iy0)
    inter = iw * ih
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def center_distance(a: Feature, b: Feature) -> float:
    (ax, ay), (bx, by) = a.center, b.center
    return math.hypot(ax - bx, ay - by)


def pair_quality(gt: Feature, pred: Feature, params: MatchParams) -> float | None:
    """Quality in (0, 1] if the pair is a valid match, else None."""
    use_center = params.mode == "center" or (
        params.mode == "auto"
        and (gt.geom_type == "Point" or pred.geom_type == "Point" or gt.size_mm < params.small_symbol_mm)
    )
    if params.mode == "iou" and (gt.geom_type == "Point" or pred.geom_type == "Point"):
        use_center = True  # IoU undefined for points
    if use_center:
        d = center_distance(gt, pred)
        if d <= params.center_tol_mm:
            return 1.0 - 0.5 * (d / params.center_tol_mm) if params.center_tol_mm > 0 else 1.0
        return None
    iou = iou_bbox(gt.bbox, pred.bbox)
    return iou if iou >= params.iou_threshold and iou > 0 else None


@dataclass
class MatchResult:
    pairs: list[tuple[int, int, float]]  # (gt index, pred index, quality)
    unmatched_gt: list[int]
    unmatched_pred: list[int]


def match(gts: Sequence[Feature], preds: Sequence[Feature], params: MatchParams = MatchParams()) -> MatchResult:
    n, m = len(gts), len(preds)
    if n == 0 or m == 0:
        return MatchResult([], list(range(n)), list(range(m)))
    big = float(min(n, m) + 1)  # each match outweighs any total quality difference
    cost = np.full((n, m), 0.0)
    valid = np.zeros((n, m), dtype=bool)
    for i, g in enumerate(gts):
        for j, p in enumerate(preds):
            q = pair_quality(g, p, params)
            if q is not None:
                valid[i, j] = True
                cost[i, j] = -(big + q)
    rows, cols = linear_sum_assignment(cost)
    pairs = [(int(i), int(j), float(-cost[i, j] - big)) for i, j in zip(rows, cols) if valid[i, j]]
    mg = {i for i, _, _ in pairs}
    mp = {j for _, j, _ in pairs}
    return MatchResult(pairs, [i for i in range(n) if i not in mg], [j for j in range(m) if j not in mp])
