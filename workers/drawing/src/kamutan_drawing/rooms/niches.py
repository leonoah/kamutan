"""Laundry niches (גומחות כביסה) as sub-rooms of the room they open onto (Sprint 5).

A washing-machine niche is a shallow recess with one open side: three sides are wall, the fourth (the *mouth*) opens
onto a bathroom / WC / corridor. Its mouth is narrower than the closing gap of :mod:`.segment` (0.9 m), so the
morphological closing that bridges door gaps also fills the niche: the niche floor is lost from every room (Noah:
basement bath 3.73 m² instead of 4.64, first-floor bath 5.04 instead of 5.88) and its mouth is counted as a wall face.

Detection (pure geometry + evidence):

1. **candidates** — free space that only the closing filled: ``(region − walls − bridges) ∩ closing(walls ∪
   bridges)``, cleaned of slivers (opening 5 cm). A candidate is a niche shape when it is 0.3–2.5 m², at least
   0.45 m wide, 0.4–1.4 m deep (area / mouth), touches exactly one kept room along a mouth of 0.5–1.6 m, and the rest
   of its outline is wall (≥ 85 %), with no door / window bridge on it (a window bay or a door recess is not a niche).
2. **evidence** — a washing-machine shape inside (``fixtures.shapes``), or a laundry label inside ("כביסה", "מ.כ",
   "מייבש"), or the parent is a wet room by its name (bathroom / WC / laundry room). Candidates holding another
   sanitary fixture shape (WC, basin, bath, shower tray, sink) are WC / shower alcoves, not laundry niches.
   Geometry-only niches (wet parent, no label, no machine drawn — the construction plans) are yellow with
   ``גומחה לפי צורה בלבד``; a washing machine found later by ``apply_fixtures`` confirms them.

Output: a :class:`~..types_sprint2.Room` with ``type='niche'``, ``niche=True``, ``parent_room_id``, its own polygon /
area; its mouth is a wall with ``open: True``. The parent gets the same mouth as an ``open`` wall; open walls are not
part of ``perimeterM`` (no wall face to clad) and the parent's external corners are counted on parent ∪ niche (the
niche's side walls end at the mouth: that wall end is an outside corner of the parent's tiling).
"""

from __future__ import annotations

import math
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import shapely
from shapely.geometry import LineString, MultiLineString, Point, Polygon
from shapely.geometry.base import BaseGeometry

NICHE_AREA_M2 = (0.3, 2.5)
NICHE_MIN_WIDTH_M = 0.45
NICHE_DEPTH_M = (0.4, 1.4)
NICHE_MOUTH_M = (0.5, 1.6)
NICHE_WALLED_MIN = 0.85  # share of the non-mouth outline that is wall
SLIVER_M = 0.05  # opening radius that removes the slivers / wedges the closing leaves along bridges, real metres
CONTACT_MM = 0.3

R_NICHE_SHAPE = "גומחה לפי צורה בלבד"
R_NICHE_FIXTURES = "כלים סניטריים בגומחה"
NICHE_TYPE = "niche"

_LAUNDRY = re.compile(r"כביס|מייבש|(?:^|\s)מ[.\"״']\s?כ(?:$|[\s.])")
_OTHER_FIXTURES = frozenset(
    {"fixture_wc_concealed", "fixture_wc_monoblock", "fixture_basin", "fixture_bath", "fixture_shower", "fixture_kitchen_sink"}
)


@dataclass
class NicheCandidate:
    poly: Polygon  # paper mm
    parent: int  # index into the kept room polygons
    mouth: tuple[tuple[float, float], tuple[float, float]]  # paper mm
    mouth_m: float
    area_m2: float
    depth_m: float


def is_laundry_text(s: str) -> bool:
    return bool(_LAUNDRY.search(" " + str(s or "").strip() + " "))


def _polys(g: BaseGeometry) -> list[Polygon]:
    if g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    return [p for p in getattr(g, "geoms", []) if isinstance(p, Polygon)]


def _lines(g: BaseGeometry) -> list[LineString]:
    if g.is_empty:
        return []
    if isinstance(g, LineString):
        return [g]
    if isinstance(g, MultiLineString):
        return list(g.geoms)
    return [x for p in getattr(g, "geoms", []) for x in _lines(p)]


def _mouth_segment(contact: BaseGeometry) -> tuple[tuple[float, float], tuple[float, float]] | None:
    """The two extreme points of the contact lines along their main direction."""
    pts = [(float(x), float(y)) for ln in _lines(contact) for x, y in ln.coords]
    if len(pts) < 2:
        return None
    best: tuple[float, tuple[float, float], tuple[float, float]] | None = None
    for i in range(len(pts)):
        for j in range(i + 1, len(pts)):
            d = math.dist(pts[i], pts[j])
            if best is None or d > best[0]:
                best = (d, pts[i], pts[j])
    return (best[1], best[2]) if best else None


def niche_candidates(
    rooms: Sequence[Polygon],
    walls: BaseGeometry,
    bridges: Sequence[BaseGeometry],
    closed_walls: BaseGeometry,
    region: Polygon,
    mm_per_m: float,
) -> list[NicheCandidate]:
    """Niche-shaped pieces of free space filled only by the closing (see module docstring, step 1).

    ``rooms``: the kept room polygons of the region; ``walls`` / ``bridges``: the region's :class:`~.walls.WallSet`;
    ``closed_walls``: walls ∪ bridges after the closing (``segment._faces``)."""
    if walls.is_empty or not rooms:
        return []
    w1 = shapely.union_all([walls, *bridges]) if bridges else walls
    filled = region.difference(w1).intersection(closed_walls)
    a_lo, a_hi = (a * mm_per_m**2 for a in NICHE_AREA_M2)
    wall_zone = walls.buffer(CONTACT_MM)
    bridge_zone = shapely.union_all(list(bridges)).buffer(CONTACT_MM).difference(wall_zone) if bridges else None
    room_zones = [r.buffer(CONTACT_MM) for r in rooms]
    out: list[NicheCandidate] = []
    for raw in _polys(filled):
        if raw.area < a_lo:
            continue
        sl = SLIVER_M * mm_per_m
        cleaned = _polys(raw.buffer(-sl, join_style="mitre").buffer(sl, join_style="mitre").intersection(raw))
        if not cleaned:
            continue
        p = max(cleaned, key=lambda g: g.area)
        if not (a_lo <= p.area <= a_hi) or p.buffer(-0.5 * NICHE_MIN_WIDTH_M * mm_per_m).is_empty:
            continue
        ring = p.exterior
        contacts = [(k, ring.intersection(z)) for k, z in enumerate(room_zones)]
        touching = [(k, c) for k, c in contacts if c.length > 0.1 * mm_per_m]
        if len(touching) != 1:
            continue  # a gap between two rooms, or free space touching none
        k, contact = touching[0]
        mouth_len = contact.length
        if not (NICHE_MOUTH_M[0] * mm_per_m <= mouth_len <= NICHE_MOUTH_M[1] * mm_per_m):
            continue
        depth = p.area / mouth_len
        if not (NICHE_DEPTH_M[0] * mm_per_m <= depth <= NICHE_DEPTH_M[1] * mm_per_m):
            continue
        rest = ring.difference(room_zones[k])
        if rest.length <= 0 or rest.intersection(wall_zone).length < NICHE_WALLED_MIN * rest.length:
            continue
        if bridge_zone is not None and rest.intersection(bridge_zone).length > 0.1 * mm_per_m:
            continue  # a door / window on the recess: a bay or a closet, not an open niche
        seg = _mouth_segment(contact)
        if seg is None:
            continue
        out.append(NicheCandidate(p, k, seg, mouth_len / mm_per_m, p.area / mm_per_m**2, depth / mm_per_m))
    return out


def niche_evidence(
    cand: NicheCandidate,
    texts: Sequence[tuple[Point, str, float]],
    shape_hits: Sequence[tuple[str, float, float]],
    mm_per_m: float,
) -> tuple[bool, bool, bool]:
    """(washing machine shape inside, laundry label inside, another sanitary fixture shape inside)."""
    zone = cand.poly.buffer(0.15 * mm_per_m)
    wm = any(c == "fixture_washing_machine" and zone.contains(Point(x, y)) for c, x, y in shape_hits)
    other = any(c in _OTHER_FIXTURES and cand.poly.contains(Point(x, y)) for c, x, y in shape_hits)
    label = any(is_laundry_text(t) and zone.contains(pt) for pt, t, _ in texts)
    return wm, label, other


def shape_hits_in(vs: Any, boxes: Sequence[tuple[float, float, float, float]], mm_per_m: float) -> list[tuple[str, float, float]]:
    """(class, cx, cy) of the fixture shapes (``fixtures.shapes``) inside the boxes; [] when that module fails."""
    if not boxes:
        return []
    try:
        from ..fixtures.shapes import detect_shapes

        hits = detect_shapes(vs, list(boxes), mm_per_m)
    except Exception:  # noqa: BLE001 - best effort: evidence only
        return []
    out: list[tuple[str, float, float]] = []
    for h in hits:
        cx, cy = h.center
        out.append((str(h.cls), float(cx), float(cy)))
    return out


__all__ = [
    "NICHE_TYPE",
    "R_NICHE_FIXTURES",
    "R_NICHE_SHAPE",
    "NicheCandidate",
    "is_laundry_text",
    "niche_candidates",
    "niche_evidence",
    "shape_hits_in",
]
