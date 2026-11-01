"""Hatches (families of regularly spaced parallel strokes), dashed lines / dashed X boxes, plain highlight lines.

* **Line hatch**: strokes of one pen colour, the same direction (± 1.5°), overlapping along that direction and
  spaced regularly at ``HATCH_SPACING_MM`` (a drafting hatch scale, paper mm) → the region they fill (union of the
  strokes widened by ~½ spacing). Two families of different directions over the same area = cross hatch.
* **Dashed chains**: short strokes on one line with regular gaps. A group of dashed chains with two crossing
  diagonals is a *dashed X box* (an element above the cut plane: a lowered gypsum ceiling / box on this office's
  plans); the other chains are dashed lines (valances).
* **Plain lines**: the remaining straight highlight strokes (not fill outlines, not hatch / stair / dash strokes).
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field

import numpy as np
from shapely.geometry import LineString, MultiPoint, Polygon
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from .prims import Segs, polygons_of

HATCH_SPACING_MM = (0.4, 3.5)
HATCH_MIN_LINES = 5
ANGLE_TOL = 1.5
DASH_LEN_MM = (0.6, 6.0)
DASH_GAP_MM = (0.3, 3.0)
DASH_MIN = 3
COLLINEAR_MM = 0.2


@dataclass
class Family:
    idx: np.ndarray  # indices into Segs
    angle: float
    spacing: float
    region: BaseGeometry
    cclass: str
    rgb: tuple[int, int, int]
    drawn_mm2: float = 0.0  # Σ stroke length × spacing


@dataclass
class HatchRegion:
    poly: Polygon
    pattern: str  # lines | cross | solid
    cclass: str
    rgb: tuple[int, int, int]
    angles: list[float] = field(default_factory=list)
    spacing: float | None = None
    seg_idx: np.ndarray | None = None
    area_mm2: float | None = None  # line hatch: Σ stroke length × spacing (exact for a regular hatch)


@dataclass
class Chain:
    """A straight run made of one or more collinear strokes (a dashed line when ``dashes`` ≥ DASH_MIN)."""

    a: tuple[float, float]
    b: tuple[float, float]
    idx: list[int]
    cclass: str
    rgb: tuple[int, int, int]
    dashed: bool

    @property
    def length(self) -> float:
        return math.hypot(self.b[0] - self.a[0], self.b[1] - self.a[1])

    @property
    def line(self) -> LineString:
        return LineString([self.a, self.b])


@dataclass
class DashedBox:
    poly: Polygon
    chains: list[Chain]
    cclass: str
    rgb: tuple[int, int, int]


def _angle_groups(ang: np.ndarray, tol: float = ANGLE_TOL) -> list[np.ndarray]:
    """Index groups of (circular, mod 180) angles within ``tol`` of each other (gap clustering)."""
    if len(ang) == 0:
        return []
    order = np.argsort(ang)
    a = ang[order]
    cuts = np.where(np.diff(a) > tol)[0]
    groups = np.split(order, cuts + 1)
    # wrap-around: the last group near 180 joins the first near 0
    if len(groups) > 1 and (a[0] + 180.0 - a[-1]) <= tol:
        groups[0] = np.concatenate([groups[-1], groups[0]])
        groups = groups[:-1]
    return groups


def _project(xy: np.ndarray, theta: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(offset across, t0, t1 along) for segments at direction ``theta`` (degrees)."""
    c, s = math.cos(math.radians(theta)), math.sin(math.radians(theta))
    mx, my = (xy[:, 0] + xy[:, 2]) / 2, (xy[:, 1] + xy[:, 3]) / 2
    d = -s * mx + c * my
    ta = c * xy[:, 0] + s * xy[:, 1]
    tb = c * xy[:, 2] + s * xy[:, 3]
    return d, np.minimum(ta, tb), np.maximum(ta, tb)


def _mean_angle(ang: np.ndarray) -> float:
    r = np.radians(ang * 2.0)
    return float((math.degrees(math.atan2(np.sin(r).mean(), np.cos(r).mean())) / 2.0) % 180.0)


def _components(n: int, pairs: Sequence[tuple[int, int]]) -> list[list[int]]:
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, j in pairs:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[ri] = rj
    out: dict[int, list[int]] = {}
    for i in range(n):
        out.setdefault(find(i), []).append(i)
    return list(out.values())


def hatch_families(segs: Segs, sel: np.ndarray, *, spacing: tuple[float, float] = HATCH_SPACING_MM) -> list[Family]:
    """Line-hatch families among ``segs[sel]`` (one colour class per call is expected)."""
    out: list[Family] = []
    idx_all = np.where(sel)[0]
    if len(idx_all) < HATCH_MIN_LINES:
        return out
    for grp in _angle_groups(segs.angle[idx_all]):
        if len(grp) < HATCH_MIN_LINES:
            continue
        gi = idx_all[grp]
        theta = _mean_angle(segs.angle[gi])
        d, t0, t1 = _project(segs.xy[gi], theta)
        order = np.argsort(d)
        pairs: list[tuple[int, int]] = []
        for a_pos in range(len(order)):
            i = order[a_pos]
            for b_pos in range(a_pos + 1, len(order)):
                j = order[b_pos]
                dd = d[j] - d[i]
                if dd > spacing[1]:
                    break
                if dd < 0.05:
                    # collinear pieces of one hatch line: join when they touch
                    if min(t1[i], t1[j]) - max(t0[i], t0[j]) > -0.3:
                        pairs.append((int(i), int(j)))
                    continue
                ov = min(t1[i], t1[j]) - max(t0[i], t0[j])
                if ov > 0.2 * min(t1[i] - t0[i], t1[j] - t0[j]) - 0.05:
                    pairs.append((int(i), int(j)))
        for comp in _components(len(gi), pairs):
            if len(comp) < HATCH_MIN_LINES:
                continue
            cd = np.sort(d[comp])
            uniq = cd[np.concatenate([[True], np.diff(cd) > 0.05])]
            if len(uniq) < HATCH_MIN_LINES:
                continue
            gaps = np.diff(uniq)
            s = float(np.median(gaps))
            if not (spacing[0] <= s <= spacing[1]):
                continue
            # regular: most gaps are a multiple (1×, 2× for a missing line) of the spacing
            rel = gaps / s
            regular = np.mean((np.abs(rel - np.round(rel)) <= 0.25) & (np.round(rel) <= 2))
            if regular < 0.75:
                continue
            ci = gi[comp]
            r = 0.55 * s
            lines = [LineString([(x0, y0), (x1, y1)]) for x0, y0, x1, y1 in segs.xy[ci]]
            reg = unary_union([ln.buffer(r, cap_style="flat", join_style="mitre") for ln in lines]).buffer(0)
            # the flat caps of oblique strokes leave a saw-tooth outline: open + close with round joins
            k = 0.35 * s
            reg = reg.buffer(k).buffer(-2 * k).buffer(k)
            if reg.is_empty:
                continue
            rgb = tuple(int(v) for v in np.median(segs.rgb[ci], axis=0))
            out.append(
                Family(ci, theta, s, reg, str(segs.cclass[ci[0]]), (rgb[0], rgb[1], rgb[2]), float(segs.length[ci].sum()) * s)
            )
    return out


def hatch_regions(fams: Sequence[Family], *, min_area: float = 1.0) -> list[HatchRegion]:
    """Families → regions; overlapping families of different directions (IoU ≥ 0.3) merge into a cross hatch."""
    used = [False] * len(fams)
    out: list[HatchRegion] = []
    for i, f in enumerate(fams):
        if used[i]:
            continue
        used[i] = True
        geom = f.region
        angles = [f.angle]
        idx = [f.idx]
        for j in range(i + 1, len(fams)):
            g = fams[j]
            if used[j] or g.cclass != f.cclass:
                continue
            da = abs((g.angle - f.angle + 90.0) % 180.0 - 90.0)
            if da < 20:
                continue
            inter = geom.intersection(g.region).area
            if inter <= 0:
                continue
            iou = inter / max(geom.union(g.region).area, 1e-9)
            if iou >= 0.3 or inter >= 0.6 * min(geom.area, g.region.area):
                used[j] = True
                geom = geom.union(g.region)
                angles.append(g.angle)
                idx.append(g.idx)
        pattern = "cross" if len(angles) > 1 else "lines"
        parts = [
            p for p in polygons_of(geom.buffer(0.05, join_style="mitre").buffer(-0.05, join_style="mitre")) if p.area >= min_area
        ]
        total = sum(p.area for p in parts)
        for p in parts:
            # a single-direction hatch: the drawn strokes give the area (the outline over-estimates at the line ends)
            drawn = f.drawn_mm2 * p.area / total if pattern == "lines" and total > 0 else None
            out.append(HatchRegion(p, pattern, f.cclass, f.rgb, angles, f.spacing, np.concatenate(idx), drawn))
    return out


def chains(segs: Segs, sel: np.ndarray, *, text_boxes: Sequence[tuple[float, float, float, float]] = ()) -> list[Chain]:
    """Collinear runs of strokes among ``segs[sel]``: dashes (short pieces with regular gaps) become dashed chains,
    longer strokes chain with touching collinear pieces into plain runs."""
    idx_all = np.where(sel)[0]
    out: list[Chain] = []
    if len(idx_all) == 0:
        return out
    if text_boxes:
        keep = np.ones(len(idx_all), bool)
        xy = segs.xy[idx_all]
        for x0, y0, x1, y1 in text_boxes:
            inside = (
                (np.minimum(xy[:, 0], xy[:, 2]) >= x0 - 0.2)
                & (np.maximum(xy[:, 0], xy[:, 2]) <= x1 + 0.2)
                & (np.minimum(xy[:, 1], xy[:, 3]) >= y0 - 0.2)
                & (np.maximum(xy[:, 1], xy[:, 3]) <= y1 + 0.2)
            )
            # only glyph-sized strokes are text (a dash or a line passing under a note is not)
            keep &= ~(inside & (segs.length[idx_all] < 0.6 * (y1 - y0)))
        idx_all = idx_all[keep]
    for grp in _angle_groups(segs.angle[idx_all], tol=2.0):
        gi = idx_all[grp]
        theta = _mean_angle(segs.angle[gi])
        d, t0, t1 = _project(segs.xy[gi], theta)
        # rows of equal offset (sorted offsets split at gaps > COLLINEAR_MM), one pen colour per row
        order = np.argsort(d)
        rows: list[list[int]] = []
        for k in order.tolist():
            if rows and d[k] - d[rows[-1][-1]] <= COLLINEAR_MM:
                rows[-1].append(int(k))
            else:
                rows.append([int(k)])
        rows = [
            [k for k in row if str(segs.cclass[gi[k]]) == cc]
            for row in rows
            for cc in sorted({str(segs.cclass[gi[q]]) for q in row})
        ]
        c, s = math.cos(math.radians(theta)), math.sin(math.radians(theta))
        for row in rows:
            row.sort(key=lambda k: t0[k])
            cur: list[int] = [row[0]]
            for k in row[1:]:
                prev_end = max(t1[q] for q in cur)
                gap = t0[k] - prev_end
                dash_like = (t1[k] - t0[k]) <= DASH_LEN_MM[1] and (t1[cur[-1]] - t0[cur[-1]]) <= DASH_LEN_MM[1]
                if gap <= 0.15 or (dash_like and gap <= DASH_GAP_MM[1]):
                    cur.append(k)
                else:
                    out.append(_chain(segs, gi, cur, d, t0, t1, c, s))
                    cur = [k]
            out.append(_chain(segs, gi, cur, d, t0, t1, c, s))
    return out


def _chain(segs: Segs, gi: np.ndarray, ks: list[int], d: np.ndarray, t0: np.ndarray, t1: np.ndarray, c: float, s: float) -> Chain:
    ta, tb = float(min(t0[k] for k in ks)), float(max(t1[k] for k in ks))
    dd = float(np.mean([d[k] for k in ks]))
    a = (c * ta - s * dd, s * ta + c * dd)
    b = (c * tb - s * dd, s * tb + c * dd)
    lens = [t1[k] - t0[k] for k in ks]
    dashed = len(ks) >= DASH_MIN and float(np.median(lens)) <= DASH_LEN_MM[1] and float(np.median(lens)) >= DASH_LEN_MM[0]
    if dashed:
        tt = sorted((t0[k], t1[k]) for k in ks)
        gaps = [tt[i + 1][0] - tt[i][1] for i in range(len(tt) - 1)]
        dashed = bool(gaps) and float(np.median(gaps)) >= DASH_GAP_MM[0]
    ii = [int(gi[k]) for k in ks]
    rgb = tuple(int(v) for v in segs.rgb[ii[0]])
    return Chain(a, b, ii, str(segs.cclass[ii[0]]), (rgb[0], rgb[1], rgb[2]), dashed)


def dashed_boxes(chs: Sequence[Chain], *, min_side: float = 4.0) -> tuple[list[DashedBox], list[Chain]]:
    """Groups of dashed chains holding two diagonals that cross inside → boxes (convex hull of the group); the
    remaining dashed chains are returned as lines."""
    dashed = [c for c in chs if c.dashed]
    if not dashed:
        return [], []
    pairs: list[tuple[int, int]] = []
    for i in range(len(dashed)):
        li = dashed[i].line
        for j in range(i + 1, len(dashed)):
            if dashed[i].cclass != dashed[j].cclass:
                continue
            if li.distance(dashed[j].line) <= 1.0:
                pairs.append((i, j))
    boxes: list[DashedBox] = []
    used: set[int] = set()
    for comp in _components(len(dashed), pairs):
        if len(comp) < 2:
            continue
        crossing = False
        for a in range(len(comp)):
            for b in range(a + 1, len(comp)):
                ca, cb = dashed[comp[a]], dashed[comp[b]]
                p = ca.line.intersection(cb.line)
                if p.is_empty or p.geom_type != "Point":
                    continue
                da = min(p.distance(ca.line.boundary.geoms[0]), p.distance(ca.line.boundary.geoms[1]))
                db = min(p.distance(cb.line.boundary.geoms[0]), p.distance(cb.line.boundary.geoms[1]))
                if da >= 0.25 * ca.length and db >= 0.25 * cb.length:
                    crossing = True
                    break
            if crossing:
                break
        if not crossing:
            continue
        pts = [pt for k in comp for pt in (dashed[k].a, dashed[k].b)]
        hull = MultiPoint(pts).convex_hull
        if not isinstance(hull, Polygon):
            continue
        x0, y0, x1, y1 = hull.bounds
        if min(x1 - x0, y1 - y0) < min_side:
            continue
        used.update(comp)
        boxes.append(DashedBox(hull, [dashed[k] for k in comp], dashed[comp[0]].cclass, dashed[comp[0]].rgb))
    rest = [c for i, c in enumerate(dashed) if i not in used]
    return boxes, rest


def merge_parallel(lines: Sequence[Chain], gap_mm: float, *, min_overlap: float = 0.6) -> list[list[Chain]]:
    """Group parallel runs ≤ ``gap_mm`` apart that overlap ≥ ``min_overlap`` of the shorter (a "double line")."""
    pairs: list[tuple[int, int]] = []
    for i in range(len(lines)):
        a = lines[i]
        ta = math.degrees(math.atan2(a.b[1] - a.a[1], a.b[0] - a.a[0])) % 180
        for j in range(i + 1, len(lines)):
            b = lines[j]
            tb = math.degrees(math.atan2(b.b[1] - b.a[1], b.b[0] - b.a[0])) % 180
            if abs((ta - tb + 90) % 180 - 90) > 3:
                continue
            if a.line.distance(b.line) > gap_mm:
                continue
            c, s = math.cos(math.radians(ta)), math.sin(math.radians(ta))
            pa = sorted((c * a.a[0] + s * a.a[1], c * a.b[0] + s * a.b[1]))
            pb = sorted((c * b.a[0] + s * b.a[1], c * b.b[0] + s * b.b[1]))
            ov = min(pa[1], pb[1]) - max(pa[0], pb[0])
            if ov >= min_overlap * max(pa[1] - pa[0], pb[1] - pb[0]):
                pairs.append((i, j))
    return [[lines[k] for k in comp] for comp in _components(len(lines), pairs)]
