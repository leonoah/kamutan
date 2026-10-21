"""Tiling geometry of one room (Sprint 4): walls, openings, inner perimeter, external corners.

The room polygon is the inner face of its walls (free space between wall faces, door / window closures).

* **walls** — the polygon simplified at 0.5 mm paper (2.5 cm at 1:50), nearly collinear edges (< 10°) merged,
  edges < 5 cm folded into a neighbour; one wall per edge ``{id w_<n>, aMm, bMm, lengthM, exterior}``.
  ``exterior`` = the space behind the wall face (0.6, 1.0 or 1.5 m) is outside the building envelope.
* **openings** — doors (swing arc → leaf radius, or hinge → other jamb for slanted / pivot doors) and windows
  (glazing lines → glazing length) whose closing line lies on this room's boundary (≥ 50 % within 0.4 m);
  ``wallId`` = nearest wall, ``heightM`` null (heights are not drawn in plan), ``centerMm``.
* **perimeterM** — length of the inner face (the polygon), openings included (the tiling rule subtracts them), open
  sides excluded (Sprint 5: the mouth of a laundry niche, a wall ``open: true`` — there is no wall face to clad).
* **open sides** (Sprint 5, ``open_lines``) — edges lying on a given line (a niche mouth) are split off and marked
  ``open: true``; doors / windows are never assigned to them.
* **externalCorners** — *outside* corners of the tiled wall surface: reflex vertices of the simplified room
  polygon (interior angle > 210°: a wall end, pillar or shaft protruding into the room, the reveal of a window
  recess) between edges ≥ 10 cm. Corners at a door jamb (≤ 30 cm from a door's closing line) are not counted
  (the door frame covers them). Each counts once per storey height for the corner trim line (5.03). With
  ``corner_poly`` (Sprint 5: room ∪ its niches) the corners are counted on that outline instead — the end of a
  niche's side wall at the mouth is an outside corner of the parent's tiling.
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
OPEN_TOL_MM = 1.0  # an edge on an open line (niche mouth): within this of it, paper mm


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


Pt = tuple[float, float]


def _split_open(
    edges: list[tuple[Pt, Pt]], open_lines: Sequence[tuple[Pt, Pt]], min_mm: float
) -> tuple[list[tuple[Pt, Pt]], list[bool]]:
    """Split edges at the end points of the open lines that fall inside them; flag the pieces lying on an open line."""
    lines = [LineString(ol) for ol in open_lines if math.dist(*ol) > 0]
    if not lines:
        return edges, [False] * len(edges)
    cuts = [p for ol in open_lines for p in ol]
    out: list[tuple[Pt, Pt]] = []
    for a, b in edges:
        seg = LineString([a, b])
        ln = seg.length
        ts = sorted(
            {
                round(seg.project(Point(p)), 6)
                for p in cuts
                if seg.distance(Point(p)) <= OPEN_TOL_MM and min_mm <= seg.project(Point(p)) <= ln - min_mm
            }
        )
        pts = [a, *[(float(q.x), float(q.y)) for q in (seg.interpolate(t) for t in ts)], b]
        out.extend((pts[i], pts[i + 1]) for i in range(len(pts) - 1))
    flags = []
    for a, b in out:
        seg = LineString([a, b])
        on = max((seg.intersection(ol.buffer(OPEN_TOL_MM)).length for ol in lines), default=0.0)
        flags.append(seg.length > 0 and on >= 0.8 * seg.length)
    return out, flags


def room_geometry(
    poly: Polygon,
    openings: Sequence[Opening],
    envelope: BaseGeometry | None,
    mm_per_m: float,
    *,
    id_prefix: str = "",
    open_lines: Sequence[tuple[Pt, Pt]] = (),
    corner_poly: Polygon | None = None,
) -> dict[str, Any]:
    """``{walls, openings, externalCorners, externalCornersMm, perimeterM}`` of one room polygon (paper mm).

    ``open_lines``: open sides (niche mouths, paper mm) → walls with ``open: True``, not in ``perimeterM``;
    ``corner_poly``: the outline the external corners are counted on (default: the room polygon)."""
    edges, open_flags = _split_open(_edges(poly, mm_per_m), open_lines, MIN_EDGE_M * mm_per_m)
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
        wall: dict[str, Any] = {
            "id": f"w_{id_prefix}{k + 1}",
            "aMm": {"x": round(a[0], 2), "y": round(a[1], 2)},
            "bMm": {"x": round(b[0], 2), "y": round(b[1], 2)},
            "lengthM": round(ln / mm_per_m, 3),
            "exterior": bool(exterior) and not open_flags[k],
        }
        if open_flags[k]:
            wall["open"] = True  # Sprint 5 (contract request): an open side, no wall face
        walls.append(wall)
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
        solid = [i for i in range(len(edges)) if not open_flags[i]]
        wi = min(solid, key=lambda i: LineString(edges[i]).distance(Point(c))) if solid else None
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
    # external (outside) corners: reflex vertices (of the room ∪ its niches when given)
    cedges = _edges(corner_poly, mm_per_m) if corner_poly is not None and not corner_poly.is_empty else _edges(poly, mm_per_m)
    corners: list[tuple[float, float]] = []
    n = len(cedges)
    for i in range(n):
        a, b = cedges[i - 1]
        _, c = cedges[i]
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
        "perimeterM": max(0.0, poly.exterior.length - sum(math.dist(*e) for e, f in zip(edges, open_flags, strict=True) if f))
        / mm_per_m,
    }


def envelope_of(walls: BaseGeometry, mm_per_m: float, gap_m: float = 2.5) -> BaseGeometry:
    """Building envelope: walls closed with a large radius, holes filled (same as the leak cut in segment)."""
    r = gap_m * mm_per_m
    g = walls.buffer(r, quad_segs=4).buffer(-r, quad_segs=4)
    polys = [g] if isinstance(g, Polygon) else [p for p in getattr(g, "geoms", []) if isinstance(p, Polygon)]
    return shapely.union_all([Polygon(p.exterior) for p in polys]) if polys else g
