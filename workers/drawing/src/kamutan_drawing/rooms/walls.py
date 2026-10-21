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

import math
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
DOOR_SWEEP_DEG = (60.0, 180.0)  # a door in a 45° wall swings up to 135°; pivot doors up to 180°
JAMB_SEARCH_R = (0.6, 2.0)  # other jamb of an open / pivot door, in door radii from the hinge
WINDOW_MAX_M = 3.0
WINDOW_JAMB_M = 0.3  # wall continuing past each end of a window, real metres
WINDOW_STRAIGHT_M = 0.15  # a frame / glass polyline stays within this of its chord (jogs at the ends), real metres
WINDOW_PATH_RATIO = 1.35  # … and its path is at most this × its chord
WALL_T_M = (0.06, 0.6)  # wall thickness range, real metres
BORROW_TOL_MM = 1.0  # reference walls closer than this to own walls are the same wall (alignment noise)


@dataclass
class Opening:
    """A door (swing arc) or window (glazing lines) closing a wall gap; ``a``–``b`` is the closing line (paper mm)."""

    kind: str  # door | window
    a: tuple[float, float]
    b: tuple[float, float]
    width_mm: float  # paper mm (door: leaf radius, window: glazing length)
    via: str = "leaf"  # door: leaf (closed-leaf end on a wall) | jamb (other jamb searched) ; window: glazing

    @property
    def center(self) -> tuple[float, float]:
        return ((self.a[0] + self.b[0]) / 2, (self.a[1] + self.b[1]) / 2)


@dataclass
class WallSet:
    walls: BaseGeometry  # union of wall polygons (paper mm)
    bridges: list[BaseGeometry] = field(default_factory=list)  # door / window closures
    door_arcs: list[tuple[float, float, float]] = field(default_factory=list)  # (cx, cy, r) paper mm
    source: str = "none"  # fills | strokes | parallel | none
    stats: dict[str, float] = field(default_factory=dict)
    openings: list[Opening] = field(default_factory=list)
    borrowed: BaseGeometry | None = None  # walls taken from a reference sheet (MEP thin partitions)


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
    reference: BaseGeometry | None = None,
    reference_closures: BaseGeometry | None = None,
    openings: bool = True,
) -> WallSet:
    """Walls inside ``box`` (x0,y0,x1,y1 paper mm).

    ``reference``: walls of another sheet of the same floor, already moved into this sheet's frame
    (:mod:`.reference`); pieces of it that this sheet lacks (thin partitions drawn as single lines on MEP
    sheets) and that are wall-like are added (``WallSet.borrowed``). ``openings=False`` skips doors / windows.
    """
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
    borrowed: BaseGeometry | None = None
    if reference is not None and not reference.is_empty and not walls.is_empty:
        extra = reference.intersection(shapely.box(*box)).difference(walls.buffer(BORROW_TOL_MM))
        keep = [g for g in _poly_parts(extra) if g.area >= 1.5 and _is_wall_like(g, mm_per_m)]
        if keep:
            borrowed = shapely.union_all(keep).buffer(BORROW_TOL_MM, join_style="mitre")
            walls = walls.union(borrowed)
            stats["borrowedParts"] = float(len(keep))
    ws = WallSet(walls=walls, source=src, stats=stats, borrowed=borrowed)
    if walls.is_empty or not openings:
        return ws
    _add_doors(vs, inbox, ws, mm_per_m)
    _add_windows(vs, inbox, ws, mm_per_m)
    if reference_closures is not None and not reference_closures.is_empty:
        own = shapely.union_all([walls, *ws.bridges]).buffer(BORROW_TOL_MM)
        extra = reference_closures.intersection(shapely.box(*box)).difference(own)
        keep = [g for g in _poly_parts(extra) if g.length >= 0.3 * mm_per_m]
        if keep:
            closing = shapely.union_all(keep).buffer(BORROW_TOL_MM, join_style="mitre")
            ws.bridges.append(closing)
            ws.borrowed = closing if ws.borrowed is None else ws.borrowed.union(closing)
            ws.stats["borrowedClosures"] = float(len(keep))
    return ws


def _poly_parts(g: BaseGeometry) -> list[BaseGeometry]:
    if g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    return [p for p in getattr(g, "geoms", []) if isinstance(p, Polygon)]


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
        if min(d0, d1) > 0.15 * rad:
            # the closed-leaf end is not on a wall: door in a slanted wall, pivot / double door — close the
            # opening between the hinge and the other jamb instead
            j = _other_jamb(walls, (cx, cy), rad, [e0, e1])
            if j is None:
                continue
            ws.bridges.append(LineString([(cx, cy), j]).buffer(0.05 * mm_per_m, cap_style="square"))
            ws.door_arcs.append((cx, cy, rad))
            ws.openings.append(Opening("door", (cx, cy), j, float(np.hypot(j[0] - cx, j[1] - cy)), "jamb"))
            seen.append((cx, cy))
            continue
        end = e0 if d0 <= d1 else e1
        ws.bridges.append(LineString([(cx, cy), (float(end[0]), float(end[1]))]).buffer(0.05 * mm_per_m, cap_style="square"))
        ws.door_arcs.append((cx, cy, rad))
        ws.openings.append(Opening("door", (cx, cy), (float(end[0]), float(end[1])), float(rad), "leaf"))
        seen.append((cx, cy))


def _other_jamb(
    walls: BaseGeometry, hinge: tuple[float, float], rad: float, ends: list[np.ndarray]
) -> tuple[float, float] | None:
    """Nearest wall *corner* (a jamb: the wall outline turns ≥ 45° there) across the opening: 0.6–2.0 radii from
    the hinge, within ±60° of an arc end's direction, joined to the hinge through free space (the closing line
    does not run inside a wall)."""
    hx, hy = hinge
    h = shapely.Point(hx, hy)
    zone = h.buffer(JAMB_SEARCH_R[1] * rad)
    local = walls.intersection(zone.buffer(1.0))
    if local.is_empty:
        return None
    pts: list[tuple[float, float]] = []
    simple = local.simplify(0.2, preserve_topology=True)
    for poly in getattr(simple, "geoms", [simple]):
        if not isinstance(poly, Polygon):
            continue
        for ring in (poly.exterior, *poly.interiors):
            cs = np.asarray(ring.coords)[:-1]
            n = len(cs)
            for i in range(n):
                a, b, c = cs[i - 1], cs[i], cs[(i + 1) % n]
                t = math.degrees(math.atan2(c[1] - b[1], c[0] - b[0]) - math.atan2(b[1] - a[1], b[0] - a[0]))
                t = (t + 180.0) % 360.0 - 180.0
                d = math.hypot(b[0] - hx, b[1] - hy)
                if abs(t) >= 45.0 and JAMB_SEARCH_R[0] * rad <= d <= JAMB_SEARCH_R[1] * rad and zone.contains(shapely.Point(b)):
                    pts.append((float(b[0]), float(b[1])))
    if not pts:
        return None
    dirs = [math.atan2(e[1] - hy, e[0] - hx) for e in ends]
    inner = walls.buffer(-0.08)
    best: tuple[float, tuple[float, float]] | None = None
    for px, py in pts:
        ang = math.atan2(py - hy, px - hx)
        if min(abs((ang - d + math.pi) % (2 * math.pi) - math.pi) for d in dirs) > math.radians(60):
            continue
        dist = math.hypot(px - hx, py - hy)
        if best is not None and dist >= best[0]:
            continue
        seg = LineString([(hx + (px - hx) * 0.1, hy + (py - hy) * 0.1), (hx + (px - hx) * 0.9, hy + (py - hy) * 0.9)])
        if not inner.is_empty and seg.intersection(inner).length > 0.05 * dist:
            continue
        best = (dist, (px, py))
    return best[1] if best else None


def _add_windows(vs: VectorSheet, mask: np.ndarray, ws: WallSet, mm_per_m: float) -> None:
    """Glazing: solid polylines whose both ends touch walls and that come in near-identical pairs.

    Windows, sliding doors and bay windows are drawn as 2–3 parallel frame / glass lines between
    two wall ends; the pair requirement keeps single furniture or dimension lines out.

    Lines are compared by their **chord** (end point to end point), not their path length: a frame line is often a
    polyline with small jogs at its ends (the outer frame of the master-bath window on the Noah construction plan is
    a "U": 1 mm out, 22 mm along the wall, 1 mm back — path 24 mm vs the 20 mm glass line, so a path-length match
    rejected the pair and the room leaked). A line is "straight" when every vertex is within ``WINDOW_STRAIGHT_M`` of
    its chord and its path ≤ ``WINDOW_PATH_RATIO`` × chord; bent glazing (bay windows) keeps its path length. The
    window width is the shortest line of the group (the glass / inner frame spans the wall gap; outer frames overlap
    the jambs).
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
            chord = float(np.hypot(*(r[0] - r[-1])))
            if chord < 0.3 * mm_per_m:
                continue  # closed / tiny
            path = float(np.hypot(*np.diff(r, axis=0).T).sum())
            straight = path <= WINDOW_PATH_RATIO * chord and _max_offset(r) <= WINDOW_STRAIGHT_M * mm_per_m
            ln = chord if straight else path  # bay windows (bent glazing) keep their path length
            if not (0.4 * mm_per_m <= ln <= WINDOW_MAX_M * 2 * mm_per_m):
                continue
            if not (wb.contains(shapely.Point(r[0])) and wb.contains(shapely.Point(r[-1]))):
                continue
            ls = LineString(r)
            if ls.difference(walls.buffer(0.05)).length < 0.5 * path:
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
            # the window: mean of the glazing lines' end points (chord), its width = the glazing length
            starts, stops = [], []
            for g in group:
                r = cands[g][0]
                if np.hypot(*(r[0] - ra[0])) <= np.hypot(*(r[0] - ra[-1])):
                    starts.append(r[0])
                    stops.append(r[-1])
                else:
                    starts.append(r[-1])
                    stops.append(r[0])
            wa = np.mean(starts, axis=0)
            wb_ = np.mean(stops, axis=0)
            width = min(cands[g][1] for g in group)
            ws.openings.append(
                Opening("window", (float(wa[0]), float(wa[1])), (float(wb_[0]), float(wb_[1])), float(width), "glazing")
            )


def _inner_vertex(r: np.ndarray, end: int, min_len: float) -> np.ndarray:
    """The first vertex at least ``min_len`` away from the polyline's end ``end`` (0 / -1), walking inwards: the
    direction of the line at that end ignoring short jogs (a frame line's 1 mm return); the other end if none."""
    pts = r if end == 0 else r[::-1]
    for q in pts[1:]:
        if float(np.hypot(*(q - pts[0]))) >= min_len:
            return np.asarray(q)
    return np.asarray(pts[-1])


def _max_offset(r: np.ndarray) -> float:
    """Largest distance of a polyline's vertices from its chord (paper mm)."""
    if len(r) <= 2:
        return 0.0
    a, b = r[0], r[-1]
    d = b - a
    n = float(np.hypot(*d))
    if n < 1e-9:
        return float(np.hypot(*(r - a).T).max())
    return float(np.abs((r[:, 0] - a[0]) * d[1] - (r[:, 1] - a[1]) * d[0]).max() / n)


def _in_wall_line(lines: list[np.ndarray], walls: BaseGeometry, mm_per_m: float) -> bool:
    """A window continues its wall: beyond both ends of the glazing band, along the glazing direction,
    there is wall for at least ``WINDOW_JAMB_M``. Wardrobe fronts and stair treads end at a
    perpendicular wall instead and fail this test."""
    ext = WINDOW_JAMB_M * mm_per_m
    for end in (0, -1):
        cover = 0.0
        for r in lines:
            p = r[end]
            q = _inner_vertex(r, end, WINDOW_STRAIGHT_M * mm_per_m)  # skip a short sideways jog at the end
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
