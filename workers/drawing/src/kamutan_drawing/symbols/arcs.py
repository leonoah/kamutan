"""Arc primitives from the PDF's cubic beziers (circles, half circles, quarter arcs).

Symbols on electrical / lighting plans are built around arcs (socket = half circle, ceiling
point = circle, switch = small circle, speaker = arcs). Each chain of connected beziers in one
path is fitted with a circle; well-fitting chains become :class:`Arc` anchors that give the
symbol matcher a position, a radius (→ scale) and, for partial arcs, an orientation.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from ..ingest.pdf_vector import VectorSheet

MIN_R_MM = 0.25
MAX_R_MM = 25.0


@dataclass
class Arc:
    cx: float
    cy: float
    r: float
    coverage: float  # degrees covered (0..360)
    mid: tuple[float, float]  # unit vector from the centre to the middle of the arc (paper frame, y down)
    path: int

    @property
    def full(self) -> bool:
        return self.coverage >= 320.0


def _bez(c: np.ndarray, ts: np.ndarray) -> np.ndarray:
    p0, c1, c2, p3 = c[0:2], c[2:4], c[4:6], c[6:8]
    t = ts[:, None]
    mt = 1 - t
    return (mt**3) * p0 + 3 * (mt**2) * t * c1 + 3 * mt * (t**2) * c2 + (t**3) * p3


def fit_circle(pts: np.ndarray) -> tuple[float, float, float, float]:
    """Algebraic (Kåsa) circle fit → (cx, cy, r, rms residual)."""
    x, y = pts[:, 0], pts[:, 1]
    a = np.column_stack([x, y, np.ones_like(x)])
    b = x * x + y * y
    sol, *_ = np.linalg.lstsq(a, b, rcond=None)
    cx, cy = sol[0] / 2, sol[1] / 2
    r = math.sqrt(max(sol[2] + cx * cx + cy * cy, 0.0))
    res = np.hypot(x - cx, y - cy) - r
    return float(cx), float(cy), float(r), float(np.sqrt(np.mean(res * res)))


def arc_of_points(pts: np.ndarray, path: int = -1) -> Arc | None:
    if len(pts) < 4:
        return None
    cx, cy, r, rms = fit_circle(pts)
    if not (MIN_R_MM <= r <= MAX_R_MM) or rms > 0.03 * r + 0.01:
        return None
    ang = np.sort(np.arctan2(pts[:, 1] - cy, pts[:, 0] - cx))
    gaps = np.diff(np.concatenate([ang, ang[:1] + 2 * math.pi]))
    k = int(np.argmax(gaps))
    coverage = math.degrees(2 * math.pi - float(gaps[k]))
    if coverage < 45.0:
        return None
    start = float(ang[(k + 1) % len(ang)])
    mid_a = start + math.radians(coverage) / 2
    return Arc(cx, cy, r, coverage, (math.cos(mid_a), math.sin(mid_a)), path)


def extract_arcs(vs: VectorSheet, keep_path: np.ndarray | None = None) -> list[Arc]:
    """Arcs of every bezier chain (consecutive, touching curves of one path)."""
    if vs.curves.shape[0] == 0:
        return []
    ts = np.linspace(0.0, 1.0, 5)
    out: list[Arc] = []
    curves = vs.curves.astype(np.float64)
    paths = vs.curve_path
    i = 0
    n = len(curves)
    while i < n:
        p = int(paths[i])
        j = i + 1
        while j < n and int(paths[j]) == p and np.hypot(*(curves[j, 0:2] - curves[j - 1, 6:8])) < 0.02:
            j += 1
        if keep_path is None or keep_path[p]:
            pts = np.concatenate([_bez(curves[k], ts) for k in range(i, j)])
            a = arc_of_points(pts, p)
            if a is not None:
                out.append(a)
        i = j
    return out
