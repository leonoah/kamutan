"""Primitive access for the geometry stage: colour classes, filled polygons, straight segments, the plan zone.

Everything is paper mm (y down). ``mm_per_m`` = 1000 / scale denominator converts real metres to paper mm.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import shapely
from shapely.geometry import MultiPolygon, Polygon, box
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from ..ingest.pdf_vector import SEG_LINE, VectorSheet
from ..rooms.walls import path_polygon

# colour classes of the pens / fills (sample: red (255,0,0) new, yellow (255,255,20) demolished, green dots = garden)
RED, YELLOW, GREEN, BLUE, MAGENTA, CYAN, NEUTRAL, WHITE = "red", "yellow", "green", "blue", "magenta", "cyan", "neutral", "white"
HIGHLIGHTS = (RED, YELLOW, BLUE, MAGENTA, CYAN)  # green = landscape dots on the sample, never a work category

LIFECYCLES = ("new", "existing", "demolish", "unknown")


def colour_class(rgb: Sequence[int]) -> str:
    r, g, b = int(rgb[0]), int(rgb[1]), int(rgb[2])
    if min(r, g, b) >= 245:
        return WHITE
    if max(r, g, b) - min(r, g, b) <= 40:
        return NEUTRAL
    if r >= 180 and g >= 180 and b <= 140:
        return YELLOW
    if r >= 180 and g <= 110 and b <= 110:
        return RED
    if g >= 150 and r <= 120 and b <= 120:
        return GREEN
    if b >= 180 and r <= 120 and g <= 120:
        return BLUE
    if r >= 180 and b >= 180 and g <= 120:
        return MAGENTA
    if g >= 180 and b >= 180 and r <= 120:
        return CYAN
    return NEUTRAL


def hex_colour(rgb: Sequence[int]) -> str:
    return f"#{int(rgb[0]):02x}{int(rgb[1]):02x}{int(rgb[2]):02x}"


def lifecycle_of(cclass: str, discipline: str | None, colours: dict[str, str] | None = None, rgb_hex: str | None = None) -> str:
    """Lifecycle of a drawn element from its pen colour.

    ``colours`` (legend hints ``{"#ffff14": "demolish"}``) win. Else the sheet kind: on a demolition plan every
    highlight colour is demolition; elsewhere yellow = demolition and red = new (measured on the sample in Sprint 2:
    ת. הריסה yellow = 95 % demolition notes, ת. בניה red = new; the master plan mixes both). Neutral pens = existing."""
    if colours and rgb_hex and rgb_hex.lower() in colours:
        v = colours[rgb_hex.lower()]
        return v if v in LIFECYCLES else "unknown"
    if cclass in (NEUTRAL, WHITE, GREEN):
        return "existing"
    if discipline == "demolition":
        return "demolish"
    if cclass == YELLOW:
        return "demolish"
    if cclass == RED:
        return "new"
    return "new" if discipline == "construction" else "unknown"


@dataclass
class Fill:
    path: int
    poly: BaseGeometry
    rgb: tuple[int, int, int]
    cclass: str


def fills(vs: VectorSheet, *, classes: Sequence[str] = HIGHLIGHTS, min_area: float = 0.05) -> list[Fill]:
    """Filled paths of the given colour classes (text paths included: the SHX heuristic also flags hatch pieces)."""
    out: list[Fill] = []
    if vs.n_paths == 0:
        return out
    fm = (vs.path_fill_mode > 0) & (vs.path_fill_rgba[:, 3] > 0)
    for i in np.where(fm)[0].tolist():
        rgb = tuple(int(c) for c in vs.path_fill_rgba[i, :3])
        cc = colour_class(rgb)
        if cc not in classes:
            continue
        g = path_polygon(vs, i)
        if g is None or g.is_empty or g.area < min_area:
            continue
        out.append(Fill(i, g, (rgb[0], rgb[1], rgb[2]), cc))
    return out


def union_parts(geoms: Sequence[BaseGeometry], pad: float = 0.03) -> list[Polygon]:
    """Union of touching pieces (triangulated fills) → its polygons, holes kept."""
    if not geoms:
        return []
    u = unary_union([g.buffer(pad, join_style="mitre") for g in geoms]).buffer(-pad, join_style="mitre")
    return polygons_of(u)


def polygons_of(g: BaseGeometry | None) -> list[Polygon]:
    if g is None or g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    if isinstance(g, MultiPolygon):
        return list(g.geoms)
    return [p for p in getattr(g, "geoms", []) if isinstance(p, Polygon)]


@dataclass
class Segs:
    """Straight stroked segments with per-segment pen attributes."""

    xy: np.ndarray  # (m,4) float64
    path: np.ndarray  # (m,) int
    rgb: np.ndarray  # (m,3) int
    cclass: np.ndarray  # (m,) object
    width: np.ndarray  # (m,) float
    length: np.ndarray  # (m,) float
    angle: np.ndarray  # (m,) float, degrees in [0, 180)


def stroked_segments(vs: VectorSheet, *, min_len: float = 0.3, box_mm: tuple[float, float, float, float] | None = None) -> Segs:
    """Straight pieces (not flattened beziers) of stroked paths, ≥ ``min_len`` mm."""
    if vs.n_segs == 0:
        z = np.zeros(0)
        return Segs(np.zeros((0, 4)), z.astype(int), np.zeros((0, 3), int), z.astype(object), z, z, z)
    sel = vs.path_stroked[vs.seg_path] & (vs.seg_kind == SEG_LINE)
    xy = vs.segs.astype(np.float64)
    ln = np.hypot(xy[:, 2] - xy[:, 0], xy[:, 3] - xy[:, 1])
    sel &= ln >= min_len
    if box_mm is not None:
        x0, y0, x1, y1 = box_mm
        cx, cy = (xy[:, 0] + xy[:, 2]) / 2, (xy[:, 1] + xy[:, 3]) / 2
        sel &= (cx >= x0) & (cx <= x1) & (cy >= y0) & (cy <= y1)
    idx = np.where(sel)[0]
    p = vs.seg_path[idx].astype(int)
    rgb = vs.path_stroke_rgba[p, :3].astype(int)
    cache: dict[tuple[int, int, int], str] = {}
    cc = np.empty(len(idx), dtype=object)
    for k, c in enumerate(map(tuple, rgb.tolist())):
        t = (int(c[0]), int(c[1]), int(c[2]))
        if t not in cache:
            cache[t] = colour_class(t)
        cc[k] = cache[t]
    s = xy[idx]
    ang = np.degrees(np.arctan2(s[:, 3] - s[:, 1], s[:, 2] - s[:, 0])) % 180.0
    return Segs(s, p, rgb, cc, vs.path_width_mm[p].astype(float), ln[idx], ang)


MAIN_ROOM_M2 = 2.0


def plan_zone(
    walls: BaseGeometry | None, rooms: Sequence[Polygon], region: Polygon, mm_per_m: float, link_m: float = 0.2
) -> BaseGeometry:
    """Area of the plan drawing inside a region: the wall-network components that hold (or touch) the rooms, their
    filled outline, grown by ``link_m``. Sections and details drawn beside the plan (separate wall networks, ≥ 2 ×
    ``link_m`` away) fall outside it. No rooms → the largest component; no walls → the region."""
    if walls is None or walls.is_empty:
        return region
    link = link_m * mm_per_m
    grown = walls.buffer(link, join_style="mitre")
    comps = polygons_of(grown)
    if not comps:
        return region
    rooms_u = unary_union([r.buffer(0) for r in rooms]) if rooms else None
    # components touching the plan's main rooms (a detail drawn beside the plan may enclose a small unnamed "room")
    main = [r for r in rooms if r.area >= MAIN_ROOM_M2 * mm_per_m * mm_per_m]
    main_u = unary_union(main) if main else rooms_u
    keep = [c for c in comps if main_u is not None and c.intersects(main_u)]
    if not keep:
        keep = [max(comps, key=lambda c: c.area)]
    zone = unary_union([Polygon(c.exterior) for c in keep])
    if main_u is not None:
        zone = zone.union(main_u.buffer(link))
    return zone.intersection(region.buffer(0))


def in_zone(g: BaseGeometry, zone: BaseGeometry, share: float = 0.5) -> bool:
    if g.is_empty:
        return False
    if g.area > 0:
        return g.intersection(zone).area >= share * g.area
    return bool(zone.contains(g.centroid)) or g.distance(zone) <= 0.5


def bbox_json(g: BaseGeometry) -> dict[str, float]:
    x0, y0, x1, y1 = g.bounds
    return {"x": round(x0, 2), "y": round(y0, 2), "w": round(x1 - x0, 2), "h": round(y1 - y0, 2)}


def poly_json(p: BaseGeometry, tol: float = 0.1, limit: int = 256) -> list[dict[str, float]]:
    """Exterior ring of the (largest) polygon, simplified, ≤ ``limit`` points."""
    parts = polygons_of(p)
    if not parts:
        return []
    q = max(parts, key=lambda g: g.area).simplify(tol)
    pts = list(q.exterior.coords)[:-1] if isinstance(q, Polygon) else []
    while len(pts) > limit and tol < 5:
        tol *= 2
        q2 = max(parts, key=lambda g: g.area).simplify(tol)
        pts = list(q2.exterior.coords)[:-1] if isinstance(q2, Polygon) else pts[:limit]
    return [{"x": round(float(x), 2), "y": round(float(y), 2)} for x, y in pts[:limit]]


def line_json(pts: Sequence[tuple[float, float]], limit: int = 256) -> list[dict[str, float]]:
    return [{"x": round(float(x), 2), "y": round(float(y), 2)} for x, y in list(pts)[:limit]]


def region_polygon(region: dict[str, object] | None, vs: VectorSheet) -> Polygon:
    pts = (region or {}).get("polygonMm") if region else None
    if isinstance(pts, list) and len(pts) >= 3:
        try:
            ring = [(float(p["x"]), float(p["y"])) if isinstance(p, dict) else (float(p[0]), float(p[1])) for p in pts]
            g = shapely.make_valid(Polygon(ring))
            parts = polygons_of(g)
            if parts:
                return max(parts, key=lambda q: q.area)
        except (KeyError, TypeError, ValueError, IndexError):
            pass
    return box(0.0, 0.0, vs.width_mm, vs.height_mm)
