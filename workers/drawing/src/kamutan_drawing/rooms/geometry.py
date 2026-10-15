"""Tiling geometry of one room (Sprint 4): walls, openings, inner perimeter, external corners.

The room polygon is the inner face of its walls (free space between wall faces, door / window closures).

* **walls** — the polygon simplified at 0.5 mm paper (2.5 cm at 1:50), nearly collinear edges (< 10°) merged,
  edges < 5 cm folded into a neighbour; one wall per edge ``{id w_<n>, aMm, bMm, lengthM, exterior}``.
  ``exterior`` = the space behind the wall face (0.6, 1.0 or 1.5 m) is outside the building envelope.
* **openings** — doors (swing arc → leaf radius, or hinge → other jamb for slanted / pivot doors) and windows
  (glazing lines → glazing length) whose closing line lies on this room's boundary (≥ 50 % within 0.4 m);
  ``wallId`` = nearest wall, ``heightM`` null (heights are not drawn in plan), ``centerMm``.
* **perimeterM** — length of the inner face (the polygon), openings included (the tiling rule subtracts them).
* **externalCorners** — *outside* corners of the tiled wall surface: reflex vertices of the simplified room
  polygon (interior angle > 210°: a wall end, pillar or shaft protruding into the room, the reveal of a window
  recess) between edges ≥ 10 cm. Corners at a door jamb (≤ 30 cm from a door's closing line) are not counted
  (the door frame covers them). Each counts once per storey height for the corner trim line (5.03).
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any

import shapely
from shapely.geometry import LineString, Point, Polygon
from shapely.geometry.base import BaseGeometry
from shapely.geometry.polygon import orient

from .walls import Opening

SIMPLIFY_M = 0.025
COLLINEAR_DEG = 10.0
MIN_EDGE_M = 0.05
CORNER_MIN_EDGE_M = 0.10
REFLEX_MIN_TURN_DEG = 30.0
EXTERIOR_PROBE_M = (0.6, 1.0, 1.5)  # behind the wall face; window sills / planters drawn outside are skipped
OPENING_NEAR_M = 0.4
DOOR_JAMB_M = 0.3


def _edges(poly: Polygon, mm_per_m: float) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    p = poly.simplify(SIMPLIFY_M * mm_per_m, preserve_topology=True)
    if not isinstance(p, Polygon) or p.is_empty:
        p = poly
    p = orient(p, 1.0)
    pts = [(float(x), float(y)) for x, y in p.exterior.coords][:-1]
    # merge nearly collinear consecutive edges and drop tiny ones
    changed = True
    while changed and len(pts) > 3:
        changed = False
        for i in range(len(pts)):
            a, b, c = pts[i - 1], pts[i], pts[(i + 1) % len(pts)]
            if abs(_turn(a, b, c)) < COLLINEAR_DEG or min(math.dist(a, b), math.dist(b, c)) < MIN_EDGE_M * mm_per_m:
                del pts[i]
                changed = True
                break
    return [(pts[i], pts[(i + 1) % len(pts)]) for i in range(len(pts))]


def _turn(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> float:
    """Signed turn at b in degrees (positive = left turn = convex for a counter-clockwise ring)."""
    a1 = math.atan2(b[1] - a[1], b[0] - a[0])
    a2 = math.atan2(c[1] - b[1], c[0] - b[0])
    d = math.degrees(a2 - a1)
    return (d + 180.0) % 360.0 - 180.0


def room_geometry(
    poly: Polygon,
    openings: Sequence[Opening],
    envelope: BaseGeometry | None,
    mm_per_m: float,
    *,
    id_prefix: str = "",
) -> dict[str, Any]:
    """``{walls, openings, externalCorners, externalCornersMm, perimeterM}`` of one room polygon (paper mm)."""
    edges = _edges(poly, mm_per_m)
    ccw = orient(poly, 1.0)
    walls: list[dict[str, Any]] = []
    for k, (a, b) in enumerate(edges):
        ln = math.dist(a, b)
        exterior = False
        if envelope is not None and ln > 0:
            mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
            ux, uy = (b[0] - a[0]) / ln, (b[1] - a[1]) / ln
            # outward normal of a CCW ring (shapely orientation) is to the right of the edge direction
            nx, ny = uy, -ux
            if ccw.contains(Point(mx + nx * 0.3, my + ny * 0.3)):
                nx, ny = -nx, -ny
            exterior = any(not envelope.contains(Point(mx + nx * d * mm_per_m, my + ny * d * mm_per_m)) for d in EXTERIOR_PROBE_M)
        walls.append(
            {
                "id": f"w_{id_prefix}{k + 1}",
                "aMm": {"x": round(a[0], 2), "y": round(a[1], 2)},
                "bMm": {"x": round(b[0], 2), "y": round(b[1], 2)},
                "lengthM": round(ln / mm_per_m, 3),
                "exterior": bool(exterior),
            }
        )
    # openings on this room's boundary
    ring = ccw.exterior
    near = ring.buffer(OPENING_NEAR_M * mm_per_m)
    ops: list[dict[str, Any]] = []
    door_lines: list[LineString] = []
    for op in openings:
        line = LineString([op.a, op.b])
        if line.length <= 0 or line.intersection(near).length < 0.5 * line.length:
            continue
        c = op.center
        wi = min(range(len(edges)), key=lambda i: LineString(edges[i]).distance(Point(c))) if edges else None
        ops.append(
            {
                "id": f"o_{id_prefix}{len(ops) + 1}",
                "kind": op.kind,
                "wallId": walls[wi]["id"] if wi is not None else None,
                "widthM": round(op.width_mm / mm_per_m, 3),
                "heightM": None,
                "centerMm": {"x": round(c[0], 2), "y": round(c[1], 2)},
            }
        )
        if op.kind == "door":
            door_lines.append(line)
    # external (outside) corners: reflex vertices
    corners: list[tuple[float, float]] = []
    n = len(edges)
    for i in range(n):
        a, b = edges[i - 1]
        _, c = edges[i]
        if math.dist(a, b) < CORNER_MIN_EDGE_M * mm_per_m or math.dist(b, c) < CORNER_MIN_EDGE_M * mm_per_m:
            continue
        if _turn(a, b, c) > -REFLEX_MIN_TURN_DEG:
            continue  # convex (inside corner of the tiles) or nearly straight
        if any(dl.distance(Point(b)) <= DOOR_JAMB_M * mm_per_m for dl in door_lines):
            continue
        corners.append(b)
    return {
        "walls": walls,
        "openings": ops,
        "externalCorners": len(corners),
        "externalCornersMm": corners,
        "perimeterM": poly.exterior.length / mm_per_m,
    }


def envelope_of(walls: BaseGeometry, mm_per_m: float, gap_m: float = 2.5) -> BaseGeometry:
    """Building envelope: walls closed with a large radius, holes filled (same as the leak cut in segment)."""
    r = gap_m * mm_per_m
    g = walls.buffer(r, quad_segs=4).buffer(-r, quad_segs=4)
    polys = [g] if isinstance(g, Polygon) else [p for p in getattr(g, "geoms", []) if isinstance(p, Polygon)]
    return shapely.union_all([Polygon(p.exterior) for p in polys]) if polys else g
