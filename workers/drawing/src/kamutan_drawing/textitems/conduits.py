"""Conduit runs drawn as the legend's "צינור קוברה" sign: a free curve with a small circle at its end(s).

The legend sample is a short arc with a circle at both ends; on the plan every run has its own length and shape, so
template matching does not apply — the run is found structurally:

* one vector path, open, solid, dark pen (not a wall pen), not a glyph stroke (``textPaths``), ≥ 12 connected
  pieces, length ≥ ``MIN_LEN_MM``, smooth (no turn sharper than ``MAX_TURN_DEG`` between consecutive pieces — door
  swings and leaders are straight or kinked);
* at least one end on a small circle (r 0.2–1.1 mm, its rim within ``RIM_TOL_MM`` of the end); both ends for a
  run that no legend row names (the legend row makes the one-circle runs — floor box to a wall point — safe).

Pure (numpy / scipy); the legend tables and the title block are excluded by the caller's boxes.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
from scipy.spatial import cKDTree

from ..ingest.pdf_vector import VectorSheet

MIN_PIECES = 12
MIN_LEN_MM = 8.0
MAX_TURN_DEG = 35.0
DARK_MAX = 90
WALL_PEN_MM = 0.45
RIM_TOL_MM = 0.35
CIRCLE_R = (0.2, 1.1)

BBox = tuple[float, float, float, float]


@dataclass
class Run:
    path: int
    ends: tuple[tuple[float, float], tuple[float, float]]
    circled: tuple[bool, bool]
    length_mm: float
    bbox: BBox
    points: list[tuple[float, float]]


def _circles(vs: VectorSheet) -> tuple[np.ndarray, np.ndarray]:
    rgb = vs.path_stroke_rgba[:, :3].astype(int)
    cs: list[tuple[float, float]] = []
    rs: list[float] = []
    for p in range(vs.n_paths):
        b = vs.path_bbox[p]
        w, h = float(b[2] - b[0]), float(b[3] - b[1])
        r = max(w, h) / 2
        if not (CIRCLE_R[0] <= r <= CIRCLE_R[1]) or abs(w - h) > 0.25 * max(w, h) or rgb[p].max() > DARK_MAX:
            continue
        n, s0 = int(vs.path_seg_count[p]), int(vs.path_seg_start[p])
        if n < 6:
            continue
        ss = vs.segs[s0 : s0 + n]
        if not (bool(vs.path_closed[p]) or float(np.hypot(ss[-1, 2] - ss[0, 0], ss[-1, 3] - ss[0, 1])) < 0.15 * max(w, h)):
            continue
        cs.append((float(b[0] + b[2]) / 2, float(b[1] + b[3]) / 2))
        rs.append(r)
    return (np.array(cs, dtype=np.float64).reshape(-1, 2), np.array(rs, dtype=np.float64))


def _inside(pt: tuple[float, float], boxes: Sequence[BBox], pad: float = 0.5) -> bool:
    return any(b[0] - pad <= pt[0] <= b[2] + pad and b[1] - pad <= pt[1] <= b[3] + pad for b in boxes)


def find_runs(
    vs: VectorSheet,
    *,
    text_paths: set[int] | frozenset[int] = frozenset(),
    exclude: Sequence[BBox] = (),
    one_circle_ok: bool = True,
) -> list[Run]:
    """Conduit runs of a sheet (see the module docstring), in path order."""
    if vs.n_paths == 0:
        return []
    centres, radii = _circles(vs)
    tree = cKDTree(centres) if len(centres) else None
    rgb = vs.path_stroke_rgba[:, :3].astype(int)
    out: list[Run] = []
    for p in range(vs.n_paths):
        if p in text_paths or not bool(vs.path_stroked[p]) or vs.path_dash[p]:
            continue
        if rgb[p].max() > DARK_MAX or float(vs.path_width_mm[p]) >= WALL_PEN_MM:
            continue
        n, s0 = int(vs.path_seg_count[p]), int(vs.path_seg_start[p])
        if n < MIN_PIECES:
            continue
        ss = vs.segs[s0 : s0 + n].astype(np.float64)
        if (np.hypot(ss[1:, 0] - ss[:-1, 2], ss[1:, 1] - ss[:-1, 3]) > 0.05).any():
            continue  # several subpaths
        seg_len = np.hypot(ss[:, 2] - ss[:, 0], ss[:, 3] - ss[:, 1])
        length = float(seg_len.sum())
        if length < MIN_LEN_MM:
            continue
        a, z = (float(ss[0, 0]), float(ss[0, 1])), (float(ss[-1, 2]), float(ss[-1, 3]))
        if float(np.hypot(a[0] - z[0], a[1] - z[1])) < 0.2 * length:
            continue  # closed / looping shape
        keep = seg_len > 1e-6
        ang = np.arctan2(ss[keep, 3] - ss[keep, 1], ss[keep, 2] - ss[keep, 0])
        if len(ang) > 1 and float(np.degrees(np.abs(np.angle(np.exp(1j * np.diff(ang)))).max())) > MAX_TURN_DEG:
            continue
        circled = []
        for e in (a, z):
            ok = False
            if tree is not None:
                for k in tree.query_ball_point(e, CIRCLE_R[1] + RIM_TOL_MM):
                    if abs(float(np.hypot(centres[k, 0] - e[0], centres[k, 1] - e[1])) - radii[k]) <= RIM_TOL_MM:
                        ok = True
                        break
            circled.append(ok)
        if not any(circled) or (not one_circle_ok and not all(circled)):
            continue
        mid = ss[n // 2, :2]
        if _inside((float(mid[0]), float(mid[1])), exclude) or (_inside(a, exclude) and _inside(z, exclude)):
            continue
        b = vs.path_bbox[p]
        pts = [(float(x), float(y)) for x, y in ss[:, :2][:: max(1, n // 32)]] + [z]
        out.append(
            Run(p, (a, z), (circled[0], circled[1]), round(length, 2), (float(b[0]), float(b[1]), float(b[2]), float(b[3])), pts)
        )
    return out
