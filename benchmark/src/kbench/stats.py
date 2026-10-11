"""Statistics used by the metrics: Wilson bound, calibration, AUC, percentiles."""

from __future__ import annotations

import math
from typing import Sequence

import numpy as np

Z95 = 1.96


def wilson_lower(k: int, n: int, z: float = Z95) -> float | None:
    """Two-sided Wilson score interval lower bound (test plan formula).

    LB = (p + z^2/2n - z*sqrt(p(1-p)/n + z^2/4n^2)) / (1 + z^2/n)
    Returns None when n == 0.
    """
    if n <= 0:
        return None
    if not 0 <= k <= n:
        raise ValueError("k must be in [0, n]")
    p = k / n
    z2 = z * z
    num = p + z2 / (2 * n) - z * math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))
    return max(0.0, num / (1 + z2 / n))


def wilson_upper(k: int, n: int, z: float = Z95) -> float | None:
    if n <= 0:
        return None
    p = k / n
    z2 = z * z
    num = p + z2 / (2 * n) + z * math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))
    return min(1.0, num / (1 + z2 / n))


def min_n_for_lower_bound(target: float, errors: int = 0, z: float = Z95, n_max: int = 10_000_000) -> int | None:
    """Smallest n such that wilson_lower(n - errors, n) >= target (monotone in n for fixed errors)."""
    lo = max(errors, 1)
    if wilson_lower(lo - errors, lo, z) is not None and wilson_lower(lo - errors, lo, z) >= target:
        return lo
    hi = lo
    while hi <= n_max and wilson_lower(hi - errors, hi, z) < target:  # type: ignore[operator]
        hi *= 2
    if hi > n_max:
        return None
    while lo < hi:
        mid = (lo + hi) // 2
        if wilson_lower(mid - errors, mid, z) >= target:  # type: ignore[operator]
            hi = mid
        else:
            lo = mid + 1
    return lo


def equal_mass_bins(scores: Sequence[float], n_bins: int = 10) -> list[np.ndarray]:
    """Split indices (sorted by score) into n_bins groups of (almost) equal size."""
    idx = np.argsort(np.asarray(scores, dtype=float), kind="stable")
    k = min(n_bins, len(idx))
    if k == 0:
        return []
    return [b for b in np.array_split(idx, k) if len(b)]


def reliability(scores: Sequence[float], correct: Sequence[bool], n_bins: int = 10) -> dict:
    """Equal-mass reliability table, ECE, MCE and Brier score."""
    s = np.asarray(scores, dtype=float)
    c = np.asarray(correct, dtype=float)
    n = len(s)
    if n == 0:
        return {"n": 0, "bins": [], "ece": None, "mce": None, "brier": None}
    bins = []
    ece = 0.0
    mce = 0.0
    for b in equal_mass_bins(s, n_bins):
        conf = float(s[b].mean())
        acc = float(c[b].mean())
        gap = abs(acc - conf)
        ece += len(b) / n * gap
        mce = max(mce, gap)
        bins.append({"n": int(len(b)), "conf": conf, "acc": acc, "score_min": float(s[b].min()),
                     "score_max": float(s[b].max())})
    return {"n": n, "bins": bins, "ece": float(ece), "mce": float(mce), "brier": float(np.mean((s - c) ** 2))}


def ece(scores: Sequence[float], correct: Sequence[bool], n_bins: int = 10) -> float | None:
    return reliability(scores, correct, n_bins)["ece"]


def auc(scores: Sequence[float], positives: Sequence[bool]) -> float | None:
    """ROC AUC via Mann-Whitney U (ties count 1/2). None if a class is empty."""
    s = np.asarray(scores, dtype=float)
    y = np.asarray(positives, dtype=bool)
    npos, nneg = int(y.sum()), int((~y).sum())
    if npos == 0 or nneg == 0:
        return None
    from scipy.stats import rankdata

    r = rankdata(s)
    u = r[y].sum() - npos * (npos + 1) / 2
    return float(u / (npos * nneg))


def percentile(values: Sequence[float], q: float) -> float | None:
    if len(values) == 0:
        return None
    return float(np.percentile(np.asarray(values, dtype=float), q))
