"""Wall geometry from vector primitives (paper mm).

Walls on the sample architecture / MEP sheets are solid-filled polygons (grey 201, often split
into triangles by the CAD solid hatch) outlined with a heavy pen (0.55 mm). New / demolished
walls are filled or outlined in other colours (yellow / red). Sheets without fills fall back to
pairs of parallel lines of the dominant pen (wall faces).

Openings are closed so that rooms become closed faces:

* door swing arcs (circle fit on non-text paths, radius 0.5–1.3 m, sweep 60–120°) → a bridge
  from the hinge (arc centre) to the closed-leaf end of the arc;
* windows → short segments that span a gap between two wall pieces, drawn as ≥ 2 parallel
  lines of equal length inside the wall band;
* a small morphological closing (gaps < 0.9 m real) catches the rest.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

import numpy as np
import shapely
from shapely.geometry import LineString, Polygon
from shapely.geometry.base import BaseGeometry

from ..ingest.pdf_vector import VectorSheet

WHITE_MIN = 245  # fill channels all >= this: white mask, not a wall
WALL_STROKE_MIN_MM = 0.45  # heavy pen (sample: 0.55 mm wall outlines vs 0.25 mm drawing pen)
MIN_FILL_AREA_MM2 = 0.3
SECONDARY_MIN_AREA_MM2 = 1.5
DOOR_R_M = (0.5, 1.3)
DOOR_SWEEP_DEG = (60.0, 120.0)
WINDOW_MAX_M = 3.0
WINDOW_JAMB_M = 0.3  # wall continuing past each end of a window, real metres
WALL_T_M = (0.06, 0.6)  # wall thickness range, real metres


@dataclass
class WallSet:
    walls: BaseGeometry  # union of wall polygons (paper mm)
    bridges: list[BaseGeometry] = field(default_factory=list)  # door / window closures
    door_arcs: list[tuple[float, float, float]] = field(default_factory=list)  # (cx, cy, r) paper mm
    source: str = "none"  # fills | strokes | parallel | none
    stats: dict[str, float] = field(default_factory=dict)


def _rings(vs: VectorSheet, i: int) -> list[np.ndarray]:
    s0, n = int(vs.path_seg_start[i]), int(vs.path_seg_count[i])
    segs = vs.segs[s0 : s0 + n].astype(np.float64)
    rings: list[np.ndarray] = []
    cur: list[tuple[float, float]] = []
    for x0, y0, x1, y1 in segs:
        if cur and (abs(cur[-1][0] - x0) > 1e-3 or abs(cur[-1][1] - y0) > 1e-3):
            rings.append(np.asarray(cur))
            cur = []
        if not cur:
            cur.append((float(x0), float(y0)))
        cur.append((float(x1), float(y1)))
    if cur:
        rings.append(np.asarray(cur))
    return rings


def path_polygon(vs: VectorSheet, i: int) -> BaseGeometry | None:
    """Filled area of path ``i`` (even-odd for alternate fill, union for winding)."""
    geom: BaseGeometry | None = None
    for r in _rings(vs, i):
        if len(r) < 3:
            continue
        p = shapely.make_valid(Polygon(r))
        if p.is_empty or p.area <= 0:
            continue
        if geom is None:
            geom = p
        elif int(vs.path_fill_mode[i]) == 1:
            geom = geom.symmetric_difference(p)
        else:
            geom = geom.union(p)
    return geom


def path_lines(vs: VectorSheet, i: int) -> list[np.ndarray]:
    return [r for r in _rings(vs, i) if len(r) >= 2]


def _path_mask(vs: VectorSheet, box: tuple[float, float, float, float], exclude: set[int]) -> np.ndarray:
    b = vs.path_bbox
    cx, cy = (b[:, 0] + b[:, 2]) / 2, (b[:, 1] + b[:, 3]) / 2
    m = (cx >= box[0]) & (cx <= box[2]) & (cy >= box[1]) & (cy <= box[3])
    if exclude:
        ex = np.zeros(vs.n_paths, bool)
        ex[[i for i in exclude if 0 <= i < vs.n_paths]] = True
        m &= ~ex
    return m


def _is_wall_like(g: BaseGeometry, mm_per_m: float) -> bool:
    if g.area < SECONDARY_MIN_AREA_MM2:
        return False
    t = 2.0 * g.area / max(g.length, 1e-6)  # ~ thickness for long thin shapes
    return WALL_T_M[0] * mm_per_m * 0.5 <= t <= WALL_T_M[1] * mm_per_m


def extract_walls(
    vs: VectorSheet,
    box: tuple[float, float, float, float],
    *,
    scale_den: int,
    exclude_paths: set[int] | None = None,
) -> WallSet:
    """Walls inside ``box`` (x0,y0,x1,y1 paper mm)."""
    mm_per_m = 1000.0 / scale_den
    ex = exclude_paths or set()
    inbox = _path_mask(vs, box, ex)
    fill = inbox & (vs.path_fill_mode > 0) & (vs.path_fill_rgba[:, 3] > 0)
    rgb = vs.path_fill_rgba[:, :3]
    fill &= ~np.all(rgb >= WHITE_MIN, axis=1)

    polys: dict[int, BaseGeometry] = {}
    for pi in np.where(fill)[0].tolist():
        g = path_polygon(vs, pi)
        if g is not None and g.area >= MIN_FILL_AREA_MM2:
            polys[pi] = g

    def colour(k: int) -> tuple[int, int, int]:
        return (int(rgb[k, 0]), int(rgb[k, 1]), int(rgb[k, 2]))

    # dominant wall fill colour = largest total area
    area_by: dict[tuple[int, int, int], float] = {}
    for k, g in polys.items():
        area_by[colour(k)] = area_by.get(colour(k), 0.0) + float(g.area)
    parts: list[BaseGeometry] = []
    stats: dict[str, float] = {}
    if area_by:
        dom = max(area_by, key=lambda c: area_by[c])
        dom_parts = [g for k, g in polys.items() if colour(k) == dom]
        dom_union = shapely.union_all([g.buffer(0.05) for g in dom_parts]) if dom_parts else Polygon()
        parts.extend(dom_parts)
        near = dom_union.buffer(0.6)
        for k, g in polys.items():
            if colour(k) == dom:
                continue
            # other colours (new / demolished walls, black columns): wall-like and attached to the walls,
            # or clearly a wall on its own (long, wall-thick)
            if _is_wall_like(g, mm_per_m) and (g.intersects(near) or g.length > 1.5 * mm_per_m):
                parts.append(g)
        stats["fillPaths"] = float(len(parts))
        stats["dominantFill"] = float(dom[0] * 65536 + dom[1] * 256 + dom[2])

    # heavy pen outlines (also the only wall evidence on some sheets)
    heavy = inbox & vs.path_stroked & (vs.path_width_mm >= WALL_STROKE_MIN_MM)
    heavy &= np.array([len(d) == 0 for d in vs.path_dash], bool)
    lines: list[BaseGeometry] = []
    for i in np.where(heavy)[0]:
        w = max(float(vs.path_width_mm[i]) / 2.0, 0.15)
        for r in path_lines(vs, int(i)):
            ls = LineString(r)
            if ls.length > 0.4:
                lines.append(ls.buffer(w, cap_style="flat", join_style="mitre"))
    parts.extend(lines)
    stats["heavyStrokes"] = float(len(lines))

    src = "fills" if stats.get("fillPaths", 0) >= 5 else ("strokes" if lines else "none")
    walls: BaseGeometry = shapely.union_all([p.buffer(0.05, join_style="mitre") for p in parts]) if parts else Polygon()

    bw, bh = box[2] - box[0], box[3] - box[1]
    if walls.is_empty or walls.area < 0.002 * bw * bh:
        pw = parallel_walls(vs, inbox, mm_per_m)
        if not pw.is_empty:
            walls = walls.union(pw) if not walls.is_empty else pw
            src = "parallel"
    ws = WallSet(walls=walls, source=src, stats=stats)
    if walls.is_empty:
        return ws
    _add_doors(vs, inbox, ws, mm_per_m)
    _add_windows(vs, inbox, ws, mm_per_m)
    return ws


def parallel_walls(vs: VectorSheet, mask: np.ndarray, mm_per_m: float) -> BaseGeometry:
    """Wall bands between pairs of parallel segments of the dominant solid pen (no-fill sheets)."""
    idx = np.where(mask & vs.path_stroked & np.array([len(d) == 0 for d in vs.path_dash], bool))[0]
    if len(idx) == 0:
        return Polygon()
    pens = Counter((tuple(int(v) for v in vs.path_stroke_rgba[i, :3]), round(float(vs.path_width_mm[i]), 2)) for i in idx)
    sel = np.isin(vs.seg_path, idx)
    segs = vs.segs[sel].astype(np.float64)
    sp = vs.seg_path[sel]
    seg_pen = [(tuple(int(v) for v in vs.path_stroke_rgba[i, :3]), round(float(vs.path_width_mm[i]), 2)) for i in sp]
    out: list[BaseGeometry] = []
    tmin, tmax = WALL_T_M[0] * mm_per_m, WALL_T_M[1] * mm_per_m
    min_len = 0.5 * mm_per_m
    for pen, _ in pens.most_common(2):
        m = np.array([p == pen for p in seg_pen], bool)
        s = segs[m]
        d = s[:, 2:] - s[:, :2]
        ln = np.hypot(d[:, 0], d[:, 1])
        s, d, ln = s[ln >= min_len], d[ln >= min_len], ln[ln >= min_len]
        if len(s) < 2 or len(s) > 20000:
            continue
        ang = np.degrees(np.arctan2(d[:, 1], d[:, 0])) % 180.0
        u = d / ln[:, None]
        nrm = np.stack([-u[:, 1], u[:, 0]], 1)
        for b in np.unique(np.round(ang).astype(int) % 180):
            k = np.where(np.abs(((ang - b + 90) % 180) - 90) <= 1.0)[0]
            if len(k) < 2 or len(k) > 3000:
                continue
            uu = u[k[0]]
            nn = nrm[k[0]]
            off = s[k, :2] @ nn
            t0 = s[k, :2] @ uu
            t1 = s[k, 2:] @ uu
            lo, hi = np.minimum(t0, t1), np.maximum(t0, t1)
            order = np.argsort(off)
            for ai in range(len(order)):
                a = order[ai]
                for bi in range(ai + 1, len(order)):
                    c = order[bi]
                    gap = off[c] - off[a]
                    if gap > tmax:
                        break
                    if gap < tmin:
                        continue
                    o0, o1 = max(lo[a], lo[c]), min(hi[a], hi[c])
                    if o1 - o0 < 0.5 * min(hi[a] - lo[a], hi[c] - lo[c]):
                        continue
                    p = [uu * o0 + nn * off[a], uu * o1 + nn * off[a], uu * o1 + nn * off[c], uu * o0 + nn * off[c]]
                    out.append(Polygon(p))
                    break
    return shapely.union_all(out) if out else Polygon()


def _fit_circle(pts: np.ndarray) -> tuple[float, float, float, float]:
    x, y = pts[:, 0], pts[:, 1]
    a = np.stack([x, y, np.ones_like(x)], 1)
    bvec = x * x + y * y
    sol, *_ = np.linalg.lstsq(a, bvec, rcond=None)
    cx, cy = sol[0] / 2, sol[1] / 2
    r = float(np.sqrt(max(sol[2] + cx * cx + cy * cy, 0.0)))
    res = float(np.abs(np.hypot(x - cx, y - cy) - r).max()) if r > 0 else 1e9
    return float(cx), float(cy), r, res


def _circle3(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> tuple[float, float, float] | None:
    d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]))
    if abs(d) < 1e-9:
        return None
    a2, b2, c2 = a @ a, b @ b, c @ c
    ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d
    uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d
    return float(ux), float(uy), float(np.hypot(a[0] - ux, a[1] - uy))


def _arc_candidates(vs: VectorSheet, mask: np.ndarray, rmin: float, rmax: float) -> list[tuple[float, float, float, np.ndarray]]:
    """(cx, cy, r, sampled points) of circular arcs: bezier curves (merged per path when concentric)
    and polyline runs (circle fit on whole open polylines)."""
    out: list[tuple[float, float, float, np.ndarray]] = []
    if len(vs.curves):
        cm = mask[vs.curve_path]
        by_path: dict[int, list[tuple[float, float, float, np.ndarray]]] = {}
        t = np.array([0.0, 0.25, 0.5, 0.75, 1.0])[:, None]
        for k in np.where(cm)[0]:
            q = vs.curves[k].astype(np.float64).reshape(4, 2)
            pts = ((1 - t) ** 3) * q[0] + 3 * ((1 - t) ** 2) * t * q[1] + 3 * (1 - t) * (t**2) * q[2] + (t**3) * q[3]
            c = _circle3(pts[0], pts[2], pts[4])
            if c is None or not (0.5 * rmin <= c[2] <= rmax):
                continue
            if np.abs(np.hypot(pts[:, 0] - c[0], pts[:, 1] - c[1]) - c[2]).max() > 0.05 * c[2]:
                continue
            by_path.setdefault(int(vs.curve_path[k]), []).append((c[0], c[1], c[2], pts))
        for arcs in by_path.values():
            groups: list[list[tuple[float, float, float, np.ndarray]]] = []
            for a in arcs:
                for g in groups:
                    if np.hypot(g[0][0] - a[0], g[0][1] - a[1]) < 0.05 * a[2] and abs(g[0][2] - a[2]) < 0.05 * a[2]:
                        g.append(a)
                        break
                else:
                    groups.append([a])
            for g in groups:
                pts = np.concatenate([a[3] for a in g])
                out.append((g[0][0], g[0][1], g[0][2], pts))
    b = vs.path_bbox
    ext = np.maximum(b[:, 2] - b[:, 0], b[:, 3] - b[:, 1])
    cand = np.where(mask & (ext >= 0.6 * rmin) & (ext <= 2.1 * rmax) & (vs.path_seg_count >= 4))[0]
    for i in cand:
        s0, n = int(vs.path_seg_start[i]), int(vs.path_seg_count[i])
        if np.all(vs.seg_kind[s0 : s0 + n] == 1):
            continue  # pure bezier path: handled above
        for r in path_lines(vs, int(i)):
            if len(r) < 5:
                continue
            cx, cy, rad, res = _fit_circle(r)
            if rmin <= rad <= rmax and res <= 0.04 * rad:
                out.append((cx, cy, rad, r))
    return out


def _add_doors(vs: VectorSheet, mask: np.ndarray, ws: WallSet, mm_per_m: float) -> None:
    rmin, rmax = DOOR_R_M[0] * mm_per_m, DOOR_R_M[1] * mm_per_m
    walls = ws.walls
    near = 0.3 * mm_per_m
    seen: list[tuple[float, float]] = []
    for cx, cy, rad, pts in _arc_candidates(vs, mask & vs.path_stroked, rmin, rmax):
        if rad < rmin:
            continue
        ang = np.degrees(np.arctan2(pts[:, 1] - cy, pts[:, 0] - cx))
        # angular extent of the sampled points (robust to point order and merged pieces)
        a = np.sort(ang % 360.0)
        gaps = np.diff(np.concatenate([a, [a[0] + 360.0]]))
        k = int(np.argmax(gaps))
        sweep = 360.0 - float(gaps[k])
        if not (DOOR_SWEEP_DEG[0] <= sweep <= DOOR_SWEEP_DEG[1]):
            continue
        if any(np.hypot(cx - x, cy - y) < 0.1 * mm_per_m for x, y in seen):
            continue
        hinge = shapely.Point(cx, cy)
        # the hinge sits on a wall jamb; the closed-leaf end of the arc is the end nearer to the walls
        if walls.distance(hinge) > near:
            continue
        a_start = np.radians(a[(k + 1) % len(a)])
        a_end = np.radians(a[k])
        e0 = np.array([cx + rad * np.cos(a_start), cy + rad * np.sin(a_start)])
        e1 = np.array([cx + rad * np.cos(a_end), cy + rad * np.sin(a_end)])
        d0 = walls.distance(shapely.Point(*e0))
        d1 = walls.distance(shapely.Point(*e1))
        if min(d0, d1) > near:
            continue
        end = e0 if d0 <= d1 else e1
        ws.bridges.append(LineString([(cx, cy), (float(end[0]), float(end[1]))]).buffer(0.05 * mm_per_m, cap_style="square"))
        ws.door_arcs.append((cx, cy, rad))
        seen.append((cx, cy))


def _add_windows(vs: VectorSheet, mask: np.ndarray, ws: WallSet, mm_per_m: float) -> None:
    """Glazing: solid polylines whose both ends touch walls and that come in near-identical pairs.

    Windows, sliding doors and bay windows are drawn as 2–3 parallel frame / glass lines between
    two wall ends; the pair requirement keeps single furniture or dimension lines out.
    """
    walls = ws.walls
    idx = np.where(mask & vs.path_stroked & np.array([len(d) == 0 for d in vs.path_dash], bool))[0]
    if len(idx) == 0:
        return
    tol = 0.35
    wb = walls.buffer(tol)
    shapely.prepare(wb)
    cands: list[tuple[np.ndarray, float]] = []
    for i in idx:
        for r in path_lines(vs, int(i)):
            if np.hypot(*(r[0] - r[-1])) < 0.3 * mm_per_m:
                continue  # closed / tiny
            ln = float(np.hypot(*np.diff(r, axis=0).T).sum())
            if not (0.4 * mm_per_m <= ln <= WINDOW_MAX_M * 2 * mm_per_m):
                continue
            if not (wb.contains(shapely.Point(r[0])) and wb.contains(shapely.Point(r[-1]))):
                continue
            ls = LineString(r)
            if ls.difference(walls.buffer(0.05)).length < 0.5 * ln:
                continue  # runs inside the walls: an outline, not a gap closure
            cands.append((r, ln))
    tmax = WALL_T_M[1] * mm_per_m
    used = [False] * len(cands)
    for a, (ra, la) in enumerate(cands):
        if used[a]:
            continue
        group = [a]
        for c, (rc, lc) in enumerate(cands):
            if c == a or used[c] or abs(la - lc) > 0.15 * la:
                continue
            d_same = max(np.hypot(*(ra[0] - rc[0])), np.hypot(*(ra[-1] - rc[-1])))
            d_flip = max(np.hypot(*(ra[0] - rc[-1])), np.hypot(*(ra[-1] - rc[0])))
            if min(d_same, d_flip) <= tmax:
                group.append(c)
        if len(group) >= 2 and _in_wall_line([cands[g][0] for g in group], walls, mm_per_m):
            for g in group:
                ws.bridges.append(LineString(cands[g][0]).buffer(0.25, cap_style="flat", join_style="mitre"))
                used[g] = True


def _in_wall_line(lines: list[np.ndarray], walls: BaseGeometry, mm_per_m: float) -> bool:
    """A window continues its wall: beyond both ends of the glazing band, along the glazing direction,
    there is wall for at least ``WINDOW_JAMB_M``. Wardrobe fronts and stair treads end at a
    perpendicular wall instead and fail this test."""
    ext = WINDOW_JAMB_M * mm_per_m
    for end in (0, -1):
        cover = 0.0
        for r in lines:
            p = r[end]
            q = r[1] if end == 0 else r[-2]
            d = p - q
            n = float(np.hypot(*d))
            if n < 1e-6:
                return False
            u = d / n
            probe = LineString([tuple(p + u * 0.3), tuple(p + u * ext)])
            cover += probe.intersection(walls).length / max(probe.length, 1e-6)
        if cover / len(lines) < 0.6:
            return False
    return True
