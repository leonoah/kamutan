"""Dashed wiring arcs (switch ↔ luminaire) from the page vectors (paper mm, y down).

AutoCAD lighting plans draw the circuit of a switch as a dashed curve (arc / spline) from the
switch to the luminaire(s) it controls, and from luminaire to luminaire for points that share
it. In a PDF export the dashes usually arrive *exploded*: every dash is its own tiny path
(``path_dash`` empty); a DXF or a smarter exporter keeps one path with a dash array. Both are
handled:

* exploded dashes — short open stroked paths (≤ ``MAX_DASH_MM``) of one pen (colour + width)
  are chained end to end: an end may continue into another dash's end when the gap is short
  (adaptive to the sheet's own dash gap) and both dashes point at each other (tangent
  continuity). Pairs are taken greedily by cost, each end once; an end whose runner-up
  continuation is almost as good is counted as an *ambiguous join* (typically arcs crossing);
* real dashed paths — every subpath with a dash array is a chain as is.

Which chains are wiring is decided later (:mod:`kamutan_drawing.links.graph`) by what their
ends touch. Pure geometry, no I/O.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from scipy.spatial import cKDTree

from ..ingest.pdf_vector import VectorSheet

BBox = tuple[float, float, float, float]

MAX_DASH_MM = 3.2  # longest exploded dash (path length and bbox diagonal)
MIN_DASH_MM = 0.25  # shorter pieces (dots) have no reliable direction
SEARCH_GAP_MM = 4.0  # first-pass search radius for the next dash
JOIN_COS = math.cos(math.radians(40.0))  # both dashes must point at each other within 40°
MIN_CHAIN_DASHES = 3
MIN_CHAIN_MM = 3.0
AMBIGUOUS_JOIN_COST = 0.25  # runner-up continuation this close in cost → ambiguous join


@dataclass
class Chain:
    """One dashed polyline (ordered points) and how it was assembled."""

    pts: np.ndarray  # (k, 2)
    rgb: tuple[int, int, int]
    width: float
    n_dashes: int
    ambiguous_joins: int = 0
    exploded: bool = True
    paths: list[int] = field(default_factory=list)

    @property
    def length(self) -> float:
        d = np.diff(self.pts, axis=0)
        return float(np.hypot(d[:, 0], d[:, 1]).sum()) if len(d) else 0.0

    @property
    def bbox(self) -> BBox:
        return (
            float(self.pts[:, 0].min()),
            float(self.pts[:, 1].min()),
            float(self.pts[:, 0].max()),
            float(self.pts[:, 1].max()),
        )

    def curvature(self) -> float:
        """Max distance of the polyline from its chord, relative to the chord (0 = straight)."""
        a, b = self.pts[0], self.pts[-1]
        ch = float(np.hypot(*(b - a)))
        if ch < 1e-6:
            return 1.0
        n = np.array([-(b - a)[1], (b - a)[0]]) / ch
        return float(np.abs((self.pts - a) @ n).max() / ch)

    def end_tangent(self, end: int) -> np.ndarray:
        """Unit vector pointing *out of* the chain at ``end`` (0 = first point, 1 = last)."""
        p = self.pts if end == 1 else self.pts[::-1]
        tip = p[-1]
        # look back ~1 mm along the polyline for a stable direction
        acc = 0.0
        prev = p[-2]
        for q in p[-2::-1]:
            acc = float(np.hypot(*(tip - q)))
            prev = q
            if acc >= 1.0:
                break
        v = tip - prev
        n = float(np.hypot(*v))
        return v / n if n > 1e-9 else np.zeros(2)


def _outside(b: np.ndarray, exclude: list[BBox]) -> bool:
    cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    return not any(e[0] <= cx <= e[2] and e[1] <= cy <= e[3] for e in exclude)


def _subpaths(vs: VectorSheet, i: int) -> list[np.ndarray]:
    s, n = int(vs.path_seg_start[i]), int(vs.path_seg_count[i])
    if n <= 0:
        return []
    segs = vs.segs[s : s + n].astype(np.float64)
    out: list[np.ndarray] = []
    cur = [segs[0, :2], segs[0, 2:4]]
    for k in range(1, n):
        if float(np.hypot(*(segs[k, :2] - cur[-1]))) > 0.05:
            out.append(np.array(cur))
            cur = [segs[k, :2]]
        cur.append(segs[k, 2:4])
    out.append(np.array(cur))
    return out


def _poly_len(p: np.ndarray) -> float:
    d = np.diff(p, axis=0)
    return float(np.hypot(d[:, 0], d[:, 1]).sum()) if len(d) else 0.0


def _tangent_out(p: np.ndarray, at_end: bool) -> np.ndarray:
    q = p if at_end else p[::-1]
    v = q[-1] - q[0] if len(q) <= 2 else q[-1] - q[max(0, len(q) - 3)]
    if float(np.hypot(*v)) < 1e-9:
        v = q[-1] - q[0]
    n = float(np.hypot(*v))
    return v / n if n > 1e-9 else np.zeros(2)


def _regular(dashes: list[np.ndarray]) -> bool:
    """A dashed line repeats one dash length: ≥ 70 % of the inner dashes (the end ones may be cut
    by a symbol) within ±35 % of their median."""
    lens = np.array([_poly_len(d) for d in dashes[1:-1]] if len(dashes) > 3 else [_poly_len(d) for d in dashes])
    med = float(np.median(lens))
    return bool(med > 0 and np.mean(np.abs(lens - med) <= 0.35 * med) >= 0.7)


def extract_chains(
    vs: VectorSheet,
    *,
    text_paths: set[int] | None = None,
    exclude: list[BBox] | None = None,
) -> list[Chain]:
    """All dashed chains of the sheet (exploded dashes chained + paths with a dash array)."""
    text_paths = text_paths or set()
    exclude = exclude or []
    chains: list[Chain] = []
    dash_pts: list[np.ndarray] = []
    dash_pen: list[tuple[tuple[int, int, int], float]] = []
    dash_path: list[int] = []
    for i in range(vs.n_paths):
        if i in text_paths or not bool(vs.path_stroked[i]):
            continue
        b = vs.path_bbox[i]
        if not _outside(b, exclude):
            continue
        rgb = tuple(int(c) for c in vs.path_stroke_rgba[i, :3])
        width = round(float(vs.path_width_mm[i]), 2)
        if vs.path_dash[i]:  # a real dashed path: each subpath is a chain
            for sp in _subpaths(vs, i):
                if len(sp) >= 2 and _poly_len(sp) >= MIN_CHAIN_MM:
                    chains.append(Chain(sp, (rgb[0], rgb[1], rgb[2]), width, 1, exploded=False, paths=[i]))
            continue
        if bool(vs.path_closed[i]) or vs.path_fill_mode[i] != 0:
            continue
        if math.hypot(float(b[2] - b[0]), float(b[3] - b[1])) > MAX_DASH_MM:
            continue
        sps = _subpaths(vs, i)
        if len(sps) != 1:
            continue
        p = sps[0]
        ln = _poly_len(p)
        if not (MIN_DASH_MM <= ln <= MAX_DASH_MM):
            continue
        dash_pts.append(p)
        dash_pen.append(((rgb[0], rgb[1], rgb[2]), width))
        dash_path.append(i)
    chains.extend(_chain_dashes(dash_pts, dash_pen, dash_path))
    return chains


def _chain_dashes(pts: list[np.ndarray], pens: list[tuple[tuple[int, int, int], float]], paths: list[int]) -> list[Chain]:
    n = len(pts)
    if n < MIN_CHAIN_DASHES:
        return []
    ends = np.zeros((2 * n, 2))
    tans = np.zeros((2 * n, 2))
    for k, p in enumerate(pts):
        ends[2 * k] = p[0]
        ends[2 * k + 1] = p[-1]
        tans[2 * k] = _tangent_out(p, at_end=False)
        tans[2 * k + 1] = _tangent_out(p, at_end=True)
    pen_id = {pen: j for j, pen in enumerate(dict.fromkeys(pens))}
    pen_of = np.array([pen_id[pens[k // 2]] for k in range(2 * n)])
    tree = cKDTree(ends)
    pairs = tree.query_pairs(SEARCH_GAP_MM, output_type="ndarray")
    pa, pb = (pairs[:, 0], pairs[:, 1]) if len(pairs) else (np.zeros(0, dtype=np.int64),) * 2
    keep = (pa // 2 != pb // 2) & (pen_of[pa] == pen_of[pb])
    pa, pb = pa[keep], pb[keep]
    v = ends[pb] - ends[pa]
    g = np.hypot(v[:, 0], v[:, 1])
    u = v / np.where(g > 1e-9, g, 1.0)[:, None]
    touching = g < 0.05
    c1 = np.where(touching, -(tans[pa] * tans[pb]).sum(axis=1), (tans[pa] * u).sum(axis=1))
    c2 = np.where(touching, c1, -(tans[pb] * u).sum(axis=1))
    ok = (c1 >= JOIN_COS) & (c2 >= JOIN_COS)
    cost = g + 1.5 * ((1 - c1) + (1 - c2))
    cand: list[tuple[float, int, int, float]] = [
        (float(c), int(x), int(y), float(d)) for c, x, y, d in zip(cost[ok], pa[ok], pb[ok], g[ok], strict=True)
    ]
    if not cand:
        return []
    # adaptive gap per pen: the pen's dash gap is its typical best join; joins far beyond it are
    # other lines (pens differ: hatching, hidden lines and wiring have their own patterns)
    best: dict[int, float] = {}
    for _cost, a, b, g in cand:
        for e in (a, b):
            if g < best.get(e, 1e9):
                best[e] = g
    by_pen: dict[int, list[float]] = {}
    for e, g in best.items():
        by_pen.setdefault(int(pen_of[e]), []).append(g)
    gap_max = {pid: min(SEARCH_GAP_MM, max(0.8, 2.5 * float(np.median(gs)))) for pid, gs in by_pen.items()}
    cand = sorted(c for c in cand if c[3] <= gap_max[int(pen_of[c[1]])])
    costs_at: dict[int, list[float]] = {}
    for cost, a, b, _g in cand:
        costs_at.setdefault(a, []).append(cost)
        costs_at.setdefault(b, []).append(cost)
    mate = np.full(2 * n, -1)
    amb = np.zeros(2 * n, dtype=bool)
    for cost, a, b, _g in cand:
        if mate[a] >= 0 or mate[b] >= 0:
            continue
        mate[a], mate[b] = b, a
        for e in (a, b):
            cs = costs_at[e]
            if len(cs) > 1 and cs[1] - cs[0] < AMBIGUOUS_JOIN_COST:
                amb[e] = True
    # walk the chains
    seen = np.zeros(n, dtype=bool)
    out: list[Chain] = []

    def walk(start_dash: int, enter_end: int) -> tuple[list[np.ndarray], list[int], int]:
        """From ``start_dash`` entered at its end ``enter_end`` (0/1), follow mates."""
        seq: list[np.ndarray] = []
        ids: list[int] = []
        n_amb = 0
        d, e = start_dash, enter_end
        while True:
            seen[d] = True
            p = pts[d] if e == 0 else pts[d][::-1]
            seq.append(p)
            ids.append(d)
            exit_e = 2 * d + (1 - e)
            m = int(mate[exit_e])
            if m < 0 or seen[m // 2]:
                break
            n_amb += int(amb[exit_e])
            d, e = m // 2, m % 2
        return seq, ids, n_amb

    order = list(range(n))
    # start from free ends first so open chains are walked end to end; loops afterwards
    order.sort(key=lambda k: 0 if (mate[2 * k] < 0 or mate[2 * k + 1] < 0) else 1)
    for k in order:
        if seen[k]:
            continue
        if mate[2 * k] >= 0 and mate[2 * k + 1] >= 0:
            enter = 0
        else:
            enter = 0 if mate[2 * k] < 0 else 1
        seq, ids, n_amb = walk(k, enter)
        if len(ids) < MIN_CHAIN_DASHES:
            continue
        if not _regular([pts[i] for i in ids]):
            continue  # text / hatch strokes that happen to line up: no regular dash pattern
        poly = np.vstack(seq)
        pen = pens[ids[0]]
        ch = Chain(poly, pen[0], pen[1], len(ids), n_amb, True, [paths[i] for i in ids])
        if ch.length >= MIN_CHAIN_MM:
            out.append(ch)
    return out


__all__ = ["Chain", "extract_chains"]
