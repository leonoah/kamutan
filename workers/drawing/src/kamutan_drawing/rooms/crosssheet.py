"""Sprint 11 (Worker-Rooms): one room model per floor across the sheets of a project — pure, used by the BOQ.

The sheets of one floor (construction, plumbing, electrical, lighting …) draw the same walls, but

* not at the same place on the paper (measured: 40–90 mm between disciplines on Achituv / Yahav), so a point of the
  electrical sheet cannot be looked up in the construction sheet's rooms without a **registration**;
* the MEP sheets carry no room names and no sanitary fixtures, so their own rooms are ``other``: the room *type* of an
  accessory has to come from the canonical room it stands in;
* the garden, the terrace and the balconies are not rooms at all: an accessory outside the building has no polygon.

:func:`register` finds the translation between two sheets from the rooms both of them closed (same area, same
relative position); :class:`FloorLocator` answers, for a point of any sheet, "which canonical room" or "outdoors"
(outside the building outline = the canonical rooms grown by a wall thickness and closed).

:func:`remap_room_floors` is the rooms' side of ``classify.project``'s floor fix: rooms keep the floor the title block
gave them at ingest; while ``floorCheck`` moves the sheet they are re-labelled in memory like the detections.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

import shapely
import shapely.affinity
from shapely.geometry import Point, Polygon
from shapely.geometry.base import BaseGeometry

AREA_RATIO = 0.95  # two drawings of one room: areas within 5 %
ANCHOR_RATIO = 0.97  # the pair that proposes a translation
MIN_ANCHOR_M2 = 2.0
CENTROID_TOL_MM = 1.5  # paper mm between the moved centroid and its partner's
SINGLE_MIN_M2 = 4.0  # a single shared room registers two sheets only when it is this large and its box agrees
SINGLE_BOX_TOL_MM = 0.6
WALL_GROW_M = 0.25  # the building outline = the rooms grown by this (walls between and around them)
OUTLINE_CLOSE_M = 1.0  # … and closed by this radius (stair wells, shafts, unsegmented corners)
NEAR_ROOM_MM = 1.0
TRUST_MIN_ROOMS = 2  # "outside the outline = outdoors" needs a floor model that is a building, not one closed room
TRUST_MIN_M2 = 30.0
TRUST_MIN_SHARE = 0.5  # the majority of the sheet's accessories are inside the building
OUTLINE_MIN_IOU = 0.6
OUTLINE_MIN_M2 = 20.0
DEFAULT_SCALE = 50


class RoomLike(Protocol):
    @property
    def sheet_id(self) -> str: ...
    @property
    def floor(self) -> str | None: ...
    @property
    def area_m2(self) -> float: ...
    @property
    def polygon(self) -> list[tuple[float, float]]: ...


@dataclass(frozen=True)
class Shift:
    """Translation moving a point of the source sheet into the target sheet's frame (paper mm)."""

    dx: float
    dy: float
    matched: int  # rooms that agree with it


def _poly(r: RoomLike) -> Polygon | None:
    if len(r.polygon) < 3:
        return None
    p = Polygon(r.polygon)
    if not p.is_valid:
        p = p.buffer(0)
    return p if isinstance(p, Polygon) and not p.is_empty and p.area > 0 else None


def _ratio(a: float, b: float) -> float:
    a, b = max(a, 1e-9), max(b, 1e-9)
    return min(a, b) / max(a, b)


def register(src: Sequence[RoomLike], dst: Sequence[RoomLike]) -> Shift | None:
    """Translation from the frame of ``src`` rooms to the frame of ``dst`` rooms (two sheets of one floor, same scale).

    Every pair of equal-area rooms proposes the translation of their centroids; the proposal most other rooms agree
    with wins (a room agrees when its moved centroid meets the centroid of an equal-area room). Two agreeing rooms
    are required — or one large room whose bounding boxes also agree when no proposal has two."""
    a = [(r, p, p.centroid) for r in src if (p := _poly(r)) is not None]
    b = [(r, p, p.centroid) for r in dst if (p := _poly(r)) is not None]
    if not a or not b:
        return None
    best: tuple[int, float, float, float] | None = None  # matched, -residual, dx, dy
    for ra, pa, ca in a:
        if ra.area_m2 < MIN_ANCHOR_M2:
            continue
        for rb, pb, cb in b:
            if _ratio(ra.area_m2, rb.area_m2) < ANCHOR_RATIO:
                continue
            dx, dy = cb.x - ca.x, cb.y - ca.y
            pairs: list[tuple[float, float]] = []
            used: set[int] = set()
            for rx, _, cx in a:
                hit: tuple[float, int, float, float] | None = None
                for k, (ry, _, cy) in enumerate(b):
                    if k in used or _ratio(rx.area_m2, ry.area_m2) < AREA_RATIO:
                        continue
                    d = math.hypot(cx.x + dx - cy.x, cx.y + dy - cy.y)
                    if d <= CENTROID_TOL_MM and (hit is None or d < hit[0]):
                        hit = (d, k, cy.x - cx.x, cy.y - cx.y)
                if hit is not None:
                    used.add(hit[1])
                    pairs.append((hit[2], hit[3]))
            n = len(pairs)
            if n == 1:
                wa, ha = pa.bounds[2] - pa.bounds[0], pa.bounds[3] - pa.bounds[1]
                wb, hb = pb.bounds[2] - pb.bounds[0], pb.bounds[3] - pb.bounds[1]
                if ra.area_m2 < SINGLE_MIN_M2 or abs(wa - wb) > SINGLE_BOX_TOL_MM or abs(ha - hb) > SINGLE_BOX_TOL_MM:
                    continue
            mx = sum(p[0] for p in pairs) / n
            my = sum(p[1] for p in pairs) / n
            res = sum(math.hypot(p[0] - mx, p[1] - my) for p in pairs) / n
            cand = (n, -res, mx, my)
            if best is None or cand[:2] > best[:2]:
                best = cand
    if best is None:
        return None
    if best[0] == 1:
        # a lone room: ambiguous when another equal room of either sheet could be its partner
        big_a = [r for r, _, _ in a if r.area_m2 >= SINGLE_MIN_M2]
        if sum(1 for r, _, _ in b for q in big_a if _ratio(r.area_m2, q.area_m2) >= ANCHOR_RATIO) > 1:
            return None
    return Shift(round(best[2], 3), round(best[3], 3), best[0])


def register_outlines(src: Sequence[RoomLike], dst: Sequence[RoomLike]) -> Shift | None:
    """Fallback registration when the two sheets closed their rooms differently (a partition missing on one of them, so
    no two rooms have equal areas): the translation that best overlays the room *outlines* (``align.align_polygons``),
    accepted when the moved rooms and the target rooms overlap by ``OUTLINE_MIN_IOU`` and both sides have at least
    ``OUTLINE_MIN_M2`` of rooms."""
    from .align import align_polygons

    if sum(r.area_m2 for r in src) < OUTLINE_MIN_M2 or sum(r.area_m2 for r in dst) < OUTLINE_MIN_M2:
        return None
    pa = [list(r.polygon) for r in src if len(r.polygon) >= 3]
    pb = [list(r.polygon) for r in dst if len(r.polygon) >= 3]
    if not pa or not pb:
        return None
    al = align_polygons(pa, pb)
    if al is None:
        return None
    # ``al.iou`` is the overlap of the outlines; what must agree is the floor area the two sheets cover
    ua = shapely.affinity.translate(shapely.union_all([Polygon(q).buffer(0) for q in pa]), al.dx, al.dy)
    ub = shapely.union_all([Polygon(q).buffer(0) for q in pb])
    union = ua.union(ub).area
    if union <= 0 or ua.intersection(ub).area / union < OUTLINE_MIN_IOU:
        return None
    return Shift(round(al.dx, 3), round(al.dy, 3), 0)


def _fill_holes(g: BaseGeometry) -> BaseGeometry:
    polys = [g] if isinstance(g, Polygon) else [p for p in getattr(g, "geoms", []) if isinstance(p, Polygon)]
    return shapely.union_all([Polygon(p.exterior) for p in polys]) if polys else g


def building_outline(rooms: Sequence[RoomLike], scale_den: int | None) -> BaseGeometry | None:
    """The building of one floor as seen from its rooms: the rooms grown by a wall thickness, closed, holes filled."""
    polys = [p for r in rooms if (p := _poly(r)) is not None]
    if not polys:
        return None
    mm_per_m = 1000.0 / float(scale_den or DEFAULT_SCALE)
    grow, close = WALL_GROW_M * mm_per_m, OUTLINE_CLOSE_M * mm_per_m
    g = shapely.union_all([p.buffer(grow, join_style="mitre") for p in polys])
    return _fill_holes(g.buffer(close, join_style="mitre").buffer(-close, join_style="mitre").union(g))


INSIDE = "inside"  # in the building, in no canonical room (a wall, a stair, a space the segmentation did not close)
OUTDOOR = "outdoor"
UNKNOWN = "unknown"  # the sheet could not be registered onto the floor's canonical sheet


class FloorLocator:
    """Canonical room / outdoors of a point of any sheet. ``rooms_by_sheet``: every sheet's rooms (floors already
    corrected); ``canon``: the canonical rooms (one source sheet per floor); ``scales``: sheet → scale denominator."""

    def __init__(
        self,
        rooms_by_sheet: Mapping[str, Sequence[Any]],
        canon: Sequence[Any],
        scales: Mapping[str, int | None] | None = None,
    ) -> None:
        self._by_sheet = rooms_by_sheet
        self._canon: dict[str, list[Any]] = {}
        for r in canon:
            if r.floor:
                self._canon.setdefault(str(r.floor), []).append(r)
        self._scales = dict(scales or {})
        self._shift: dict[tuple[str, str], Shift | None] = {}
        self._outline: dict[str, BaseGeometry | None] = {}
        self._polys: dict[str, list[tuple[Any, Polygon]]] = {}
        self.stats: dict[str, int] = {"registered": 0, "unregistered": 0}

    def shift(self, sheet_id: str, floor: str) -> Shift | None:
        key = (sheet_id, floor)
        if key not in self._shift:
            canon = self._canon.get(floor) or []
            if not canon:
                self._shift[key] = None
            elif canon[0].sheet_id == sheet_id:
                self._shift[key] = Shift(0.0, 0.0, len(canon))
            else:
                own = [r for r in self._by_sheet.get(sheet_id, []) if r.floor == floor and not getattr(r, "niche", False)]
                tgt = [r for r in canon if not getattr(r, "niche", False)]
                s_own, s_tgt = self._scales.get(sheet_id), self._scales.get(canon[0].sheet_id)
                same_scale = not (s_own and s_tgt) or s_own == s_tgt
                sh = register(own, tgt) if same_scale else None
                if sh is None and same_scale:
                    sh = register_outlines(own, tgt)
                self._shift[key] = sh
            self.stats["registered" if self._shift[key] is not None else "unregistered"] += 1
        return self._shift[key]

    def _floor_polys(self, floor: str) -> list[tuple[Any, Polygon]]:
        if floor not in self._polys:
            self._polys[floor] = [(r, p) for r in self._canon.get(floor, []) if (p := _poly(r)) is not None]
        return self._polys[floor]

    def locate(self, sheet_id: str, floor: str | None, x: float, y: float) -> tuple[str, Any | None]:
        """``(where, canonical room | None)``; ``where`` is ``"room"``, :data:`INSIDE`, :data:`OUTDOOR` or
        :data:`UNKNOWN`."""
        if not floor:
            return UNKNOWN, None
        sh = self.shift(sheet_id, floor)
        if sh is None:
            return UNKNOWN, None
        pt = Point(x + sh.dx, y + sh.dy)
        near: tuple[float, Any] | None = None
        for r, p in self._floor_polys(floor):
            d = p.distance(pt)
            if d == 0:
                return "room", r
            if d <= NEAR_ROOM_MM and (near is None or d < near[0]):
                near = (d, r)
        if near is not None:
            return "room", near[1]
        if floor not in self._outline:
            canon = self._canon.get(floor) or []
            self._outline[floor] = building_outline(canon, self._scales.get(canon[0].sheet_id) if canon else None)
        out = self._outline[floor]
        if out is None:
            return UNKNOWN, None
        return (INSIDE if out.contains(pt) else OUTDOOR), None

    def outdoor_trusted(self, sheet_id: str, floor: str | None, points: Sequence[tuple[float, float]]) -> bool:
        """Whether "outside the building outline" may be read as *outdoors* for this sheet and floor. The outline is
        only as good as the canonical rooms: when the segmentation closed a bathroom and nothing else, every other
        accessory of the floor lies "outside". Trusted when the floor has at least ``TRUST_MIN_ROOMS`` canonical rooms
        of ``TRUST_MIN_M2`` together and at least ``TRUST_MIN_SHARE`` of the sheet's ``points`` (its accessories) fall
        inside the outline — a house holds most of its sockets."""
        if not floor:
            return False
        rooms = [r for r in self._canon.get(floor, []) if not getattr(r, "niche", False)]
        if len(rooms) < TRUST_MIN_ROOMS or sum(float(r.area_m2) for r in rooms) < TRUST_MIN_M2:
            return False
        if not points:
            return False
        inside = sum(1 for x, y in points if self.locate(sheet_id, floor, x, y)[0] in ("room", INSIDE))
        return inside >= TRUST_MIN_SHARE * len(points)


def in_dry_kitchen_or_living(locator: FloorLocator, sheet_id: str, floor: str | None, x: float, y: float) -> bool:
    """Whether the point stands, by registration, in a canonical kitchen / living room that is not wet — where a wash
    basin read from a water-point note is the kitchen(ette) sink, not a bathroom basin."""
    room = locator.locate(sheet_id, floor, x, y)[1]
    return room is not None and room.type in ("kitchen", "living") and not bool(getattr(room, "wet", False))


def remap_room_floors(sheet_doc: Mapping[str, Any], room_docs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rooms of a sheet that ``classify.project`` moved to another floor (``floorCheck``): the floor they got from the
    title block at ingest is replaced in memory (single floor → single floor; never on a confirmed sheet) — the same
    rule as ``classify.project.remap_floors`` for detections."""
    fc = sheet_doc.get("floorCheck")
    if not isinstance(fc, Mapping) or sheet_doc.get("confirmed"):
        return room_docs
    old, new = list(fc.get("titleFloors") or []), list(fc.get("floors") or [])
    if len(old) != 1 or len(new) != 1 or old == new:
        return room_docs
    return [{**r, "floor": new[0]} if r.get("floor") == old[0] else r for r in room_docs]


__all__ = [
    "INSIDE",
    "OUTDOOR",
    "UNKNOWN",
    "FloorLocator",
    "Shift",
    "building_outline",
    "register",
    "register_outlines",
    "remap_room_floors",
]
