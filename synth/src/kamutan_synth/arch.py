"""Architectural background of a plan on paper: walls (by kind), openings, stairs, furniture, room names, dims, grid."""

from __future__ import annotations

import itertools
import math
import random
from dataclasses import dataclass, field
from typing import Any

from shapely.geometry import LineString, MultiPolygon, Polygon
from shapely.geometry.base import BaseGeometry

from .layout import Plan, Room, door_swing_boxes, wall_unions
from .scene import Arc, BBox, Circle, Pen, Poly, Scene, Text, bbox_of, prim_points
from .spec import SCHEMES, SheetSpec

Pt = tuple[float, float]


@dataclass
class ArchOut:
    occupied: list[BBox] = field(default_factory=list)  # boxes symbols / labels must avoid (paper mm)
    features: list[dict[str, Any]] = field(default_factory=list)  # GT context / wall / room features (props + geometry)
    texts: list[dict[str, Any]] = field(default_factory=list)


def _polys(g: BaseGeometry) -> list[Polygon]:
    if isinstance(g, Polygon):
        return [g] if not g.is_empty else []
    if isinstance(g, MultiPolygon):
        return [p for p in g.geoms if not p.is_empty]
    out: list[Polygon] = []
    for sub in getattr(g, "geoms", []):
        out.extend(_polys(sub))
    return out


def _hatch(poly: Polygon, spacing: float, angle: float) -> list[list[Pt]]:
    """Parallel hatch lines clipped to a polygon."""
    if poly.is_empty:
        return []
    x0, y0, x1, y1 = poly.bounds
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    r = math.hypot(x1 - x0, y1 - y0) / 2 + spacing
    a = math.radians(angle)
    d = (math.cos(a), -math.sin(a))
    n = (-d[1], d[0])
    out: list[list[Pt]] = []
    k = int(r / spacing) + 1
    for i in range(-k, k + 1):
        o = (cx + n[0] * i * spacing, cy + n[1] * i * spacing)
        ln = LineString([(o[0] - d[0] * r, o[1] - d[1] * r), (o[0] + d[0] * r, o[1] + d[1] * r)])
        g = poly.intersection(ln)
        for part in getattr(g, "geoms", [g]):
            if isinstance(part, LineString) and part.length > 0.05:
                out.append([(float(x), float(y)) for x, y in part.coords])
    return out


def _ring(coords: Any) -> list[Pt]:
    return [(round(float(x), 4), round(float(y), 4)) for x, y in list(coords)[:-1]]


def draw_plan(scene: Scene, plan: Plan, spec: SheetSpec, rng: random.Random, scale: int, *, show_fixtures: bool) -> ArchOut:
    """Draw ``plan`` (already in paper mm). Returns occupancy and GT features (walls, rooms, context)."""
    sc = SCHEMES[spec.scheme]
    out = ArchOut()
    k = scale / 1000.0  # metres per paper mm
    L_WALL = scene.layer("A-WALL", sc["wall"], 0.35)
    L_HATCH = scene.layer("A-WALL-PATT", sc["wall"], 0.13)
    L_DOOR = scene.layer("A-DOOR", sc["wall"], 0.18)
    L_GLAZ = scene.layer("A-GLAZ", sc["wall"], 0.18)
    L_FURN = scene.layer("A-FURN", sc["furn"], 0.13)
    L_TEXT = scene.layer("A-ANNO-TEXT", sc["text"], 0.18)
    L_STAIR = scene.layer("A-FLOR-STRS", sc["wall"], 0.18)

    unions = wall_unions(plan.walls, plan.openings)
    wpen = Pen(sc["wall"], 0.35 if spec.wall_style != "outline" else 0.45)
    for kind in ("concrete", "exterior", "block", "gypsum"):
        g = unions.get(kind)
        if g is None:
            continue
        for poly in _polys(g):
            outer = _ring(poly.exterior.coords)
            holes = [_ring(h.coords) for h in poly.interiors]
            fill = None
            if spec.wall_style == "filled" and kind in ("exterior", "concrete", "block"):
                fill = sc["wall_fill"] if kind != "concrete" else tuple(max(0, c - 50) for c in sc["wall_fill"])
            scene.add(Poly(outer, True, wpen, fill, True, holes), L_WALL, wpen)  # type: ignore[arg-type]
            if (
                spec.wall_style == "hatched"
                or (kind == "gypsum" and spec.wall_style != "outline")
                or (kind == "concrete" and spec.wall_style != "filled")
            ):
                spacing = {"concrete": 0.9, "exterior": 1.2, "block": 1.0, "gypsum": 0.7}[kind]
                for ln in _hatch(poly, spacing, 45.0 if kind != "gypsum" else -45.0):
                    scene.add(Poly(ln), L_HATCH)
    for w in plan.walls:
        out.features.append(
            {
                "geometry": {"type": "LineString", "coordinates": [list(w.a), list(w.b)]},
                "props": {
                    "class": "wall",
                    "kind": "linear",
                    "wall_kind": w.kind,
                    "thickness_cm": round(w.t * k * 100, 1),
                    "length_m": round(w.length * k, 3),
                    "rooms": list(w.rooms),
                    "wid": w.wid,
                },
            }
        )

    # ---- openings
    for o in plan.openings:
        if o.kind == "window":
            hw, ht = o.w / 2, o.t / 2
            for f in (-ht, -ht / 3, ht / 3, ht):
                if o.horizontal:
                    pts = [(o.c[0] - hw, o.c[1] + f), (o.c[0] + hw, o.c[1] + f)]
                else:
                    pts = [(o.c[0] + f, o.c[1] - hw), (o.c[0] + f, o.c[1] + hw)]
                scene.add(Poly(pts), L_GLAZ)
            # jambs
            for s in (-hw, hw):
                pts = (
                    [(o.c[0] + s, o.c[1] - ht), (o.c[0] + s, o.c[1] + ht)]
                    if o.horizontal
                    else [(o.c[0] - ht, o.c[1] + s), (o.c[0] + ht, o.c[1] + s)]
                )
                scene.add(Poly(pts), L_GLAZ)
        elif o.hinge is not None:
            hx, hy = o.hinge
            ex, ey = hx + o.swing_dir[0] * o.w, hy + o.swing_dir[1] * o.w
            heavy = Pen(sc["wall"], 0.35 if o.w > 0.9 * 1000 / scale * 0.95 else 0.25)
            scene.add(Poly([(hx, hy), (ex, ey)]), L_DOOR, heavy)
            # arc from the open leaf end to the latch jamb (centre = hinge)
            a_leaf = math.degrees(math.atan2(-(ey - hy), ex - hx))
            lx, ly = hx + o.leaf_dir[0] * o.w, hy + o.leaf_dir[1] * o.w
            a_latch = math.degrees(math.atan2(-(ly - hy), lx - hx))
            d = (a_latch - a_leaf) % 360.0
            if d <= 180.0:
                scene.add(Arc((hx, hy), o.w, a_leaf, a_latch), L_DOOR)
            else:
                scene.add(Arc((hx, hy), o.w, a_latch, a_leaf), L_DOOR)
        out.features.append(
            {
                "geometry": {"type": "Point", "coordinates": [round(o.c[0], 3), round(o.c[1], 3)]},
                "props": {
                    "class": "window" if o.kind == "window" else "door",
                    "kind": "context",
                    "opening_kind": o.kind,
                    "width_m": round(o.w * k, 3),
                },
            }
        )

    # ---- stairs
    for ln in plan.stairs:
        scene.add(Poly(ln), L_STAIR)
    if plan.stairs:
        pts = [p for ln in plan.stairs for p in ln]
        out.features.append(
            {
                "geometry": {"type": "Polygon", "coordinates": [_closed(bbox_of(pts))]},
                "props": {"class": "stairs", "kind": "context"},
            }
        )

    # ---- furniture
    if spec.furniture:
        for fu in plan.furniture:
            for p in fu.polys:
                scene.add(Poly(p, True), L_FURN)
            for c, rr in fu.circles:
                scene.add(Circle(c, rr), L_FURN)
            for ln in fu.lines:
                scene.add(Poly(ln), L_FURN)
            out.features.append(
                {
                    "geometry": {"type": "Polygon", "coordinates": [_closed(fu.bbox)]},
                    "props": {"class": "furniture", "kind": "context", "furniture": fu.kind, "room_id": fu.room},
                }
            )

    # ---- rooms: GT + names (names avoid door swings, furniture and fixtures)
    th = spec.sym_u * 0.62
    obstacles = door_swing_boxes(plan.openings) + [f.bbox for f in plan.furniture] + [x.extent for x in plan.fixtures]
    for r in plan.rooms:
        ring = [[round(x, 3), round(y, 3)] for x, y in r.poly]
        ring.append(ring[0])
        area_m2 = r.area  # m2 (kept in metres by Plan.scaled)
        out.features.append(
            {
                "geometry": {"type": "Polygon", "coordinates": [ring]},
                "props": {
                    "class": "room",
                    "kind": "area",
                    "room_id": r.rid,
                    "name": r.name,
                    "room_kind": r.kind,
                    "area_m2": round(area_m2, 2),
                },
            }
        )
        _room_label(scene, r, area_m2, th, L_TEXT, rng, out, obstacles)
    return out


def _closed(b: BBox) -> list[list[float]]:
    x0, y0, x1, y1 = (round(v, 3) for v in b)
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]


def _room_label(
    scene: Scene, r: Room, area_m2: float, th: float, layer: str, rng: random.Random, out: ArchOut, obstacles: list[BBox]
) -> None:
    x0, y0, x1, y1 = r.net
    w = x1 - x0
    h = th
    probe = Text(r.name, (0.0, 0.0), h, 0.0, "c", "b")
    pb = bbox_of(prim_points(probe, scene.font))
    if pb[2] - pb[0] > 0.86 * w:
        h = max(1.5, h * 0.86 * w / (pb[2] - pb[0]))
    with_area = (y1 - y0) > 3.2 * h
    fy = [0.5, 0.3, 0.7, 0.2, 0.8, 0.4, 0.6]
    fx = [0.5, 0.3, 0.7]
    rng.shuffle(fy)
    best: tuple[int, list[Text]] | None = None
    for yy in fy:
        for xx in fx:
            cx, cy = x0 + w * xx, y0 + (y1 - y0) * yy
            ts = [Text(r.name, (cx, cy), h, 0.0, "c", "b", role="room_name")]
            if with_area:
                ts.append(Text(f'{area_m2:.1f} מ"ר', (cx, cy + h * 1.7), h * 0.75, 0.0, "c", "b", role="room_area"))
            bbs = [bbox_of(prim_points(t, scene.font)) for t in ts]
            inside = all(b[0] >= x0 + 0.5 and b[2] <= x1 - 0.5 and b[1] >= y0 + 0.5 and b[3] <= y1 - 0.5 for b in bbs)
            hits = sum(1 for b in bbs for o in obstacles if b[0] < o[2] and o[0] < b[2] and b[1] < o[3] and o[1] < b[3])
            score = hits + (0 if inside else 10)
            if best is None or score < best[0]:
                best = (score, ts)
            if score == 0:
                break
        if best is not None and best[0] == 0:
            break
    assert best is not None
    for t in best[1]:
        scene.add(t, layer)
        bb = bbox_of(prim_points(t, scene.font))
        out.occupied.append(bb)
        out.texts.append({"text": t.text, "bbox": [round(v, 2) for v in bb], "role": t.role, "room_id": r.rid})
        if t.role == "room_name":
            scene.add(Poly([(bb[0], t.pos[1] + 0.4 * t.h), (bb[2], t.pos[1] + 0.4 * t.h)]), layer)


def draw_dims(scene: Scene, plan: Plan, spec: SheetSpec, scale: int) -> list[BBox]:
    """Exterior dimension chains (top and one side), values in cm."""
    sc = SCHEMES[spec.scheme]
    L = scene.layer("A-ANNO-DIMS", sc["dim"], 0.13)
    k = scale / 1000.0
    fx0, fy0, _fx1, _fy1 = plan.footprint
    occ: list[BBox] = []
    th = 2.0
    xs = sorted({round(v, 3) for r in plan.rooms for v in (r.rect[0], r.rect[2]) if abs(r.rect[1] - fy0) < 1e-6})
    ys = sorted({round(v, 3) for r in plan.rooms for v in (r.rect[1], r.rect[3]) if abs(r.rect[0] - fx0) < 1e-6})
    off = 9.0
    for axis, vals in (("x", xs), ("y", ys)):
        for lvl, chain in enumerate((vals, [vals[0], vals[-1]])):
            d = off + lvl * 6.0
            for a, b in itertools.pairwise(chain):
                if axis == "x":
                    p0, p1 = (a, fy0 - d), (b, fy0 - d)
                    scene.add(Poly([p0, p1]), L)
                    for x in (a, b):
                        scene.add(Poly([(x, fy0 - d + 1.5), (x, fy0 - 2.0)]), L)
                        scene.add(Poly([(x - 0.8, fy0 - d + 0.8), (x + 0.8, fy0 - d - 0.8)]), L, Pen(sc["dim"], 0.3))
                    t = Text(f"{(b - a) * k * 100:.0f}", ((a + b) / 2, fy0 - d - 0.8), th, 0.0, "c", "b", role="dimension")
                else:
                    p0, p1 = (fx0 - d, a), (fx0 - d, b)
                    scene.add(Poly([p0, p1]), L)
                    for y in (a, b):
                        scene.add(Poly([(fx0 - d + 1.5, y), (fx0 - 2.0, y)]), L)
                        scene.add(Poly([(fx0 - d - 0.8, y + 0.8), (fx0 - d + 0.8, y - 0.8)]), L, Pen(sc["dim"], 0.3))
                    t = Text(f"{(b - a) * k * 100:.0f}", (fx0 - d - 0.8, (a + b) / 2), th, 90.0, "c", "b", role="dimension")
                scene.add(t, L)
                occ.append(bbox_of(prim_points(t, scene.font)))
    return occ


def draw_grid(scene: Scene, plan: Plan, spec: SheetSpec) -> None:
    sc = SCHEMES[spec.scheme]
    L = scene.layer("S-GRID", sc["dim"], 0.13)
    _fx0, fy0, fx1, fy1 = plan.footprint
    xs = _spread(sorted({round(v, 3) for r in plan.rooms for v in (r.rect[0], r.rect[2])}), 9.0)
    ys = _spread(sorted({round(v, 3) for r in plan.rooms for v in (r.rect[1], r.rect[3])}), 9.0)
    pen = Pen(sc["dim"], 0.13, (6.0, 1.0, 1.0, 1.0))
    for i, x in enumerate(xs[:9]):
        scene.add(Poly([(x, fy0 - 26), (x, fy1 + 4)]), L, pen)
        scene.add(Circle((x, fy0 - 29), 3.0), L)
        scene.add(Text(str(i + 1), (x, fy0 - 29), 2.5, 0.0, "c", "m", role="grid"), L)
    letters = "ABCDEFGH"
    for i, y in enumerate(ys[:8]):
        scene.add(Poly([(fx1 + 4, y), (fx1 + 12, y)]), L, pen)
        scene.add(Circle((fx1 + 15, y), 3.0), L)
        scene.add(Text(letters[i], (fx1 + 15, y), 2.5, 0.0, "c", "m", role="grid"), L)


def _spread(vals: list[float], gap: float) -> list[float]:
    """Grid axes at least ``gap`` mm apart (bubbles must not overlap)."""
    out: list[float] = []
    for v in vals:
        if not out or v - out[-1] >= gap:
            out.append(v)
    return out
