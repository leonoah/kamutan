"""Fixture detection on one sheet: drawn shapes + plumbing labels (leader lines) + AC positions.

Discipline gates (the sheet classification):

* architecture / master / construction — shapes + the few fixture notes drawn there ("מסתור ניאגרה");
* plumbing — shapes + every plumbing label (fixtures, faucets, garden taps, AC drains "ניקוז + גז למזגן");
* electrical — AC positions only ("שקע למזגן H=240", "למ.א", "מאייד"; snapped to a socket detection when given);
* demolition / lighting / other — nothing (fixtures there are existing / to be removed, or not drawn).

Fusion per label (see :mod:`.labels`): the leader terminals pick a compatible shape (box + 0.3 m holds the
terminal); without a usable leader the nearest compatible shape in the label's room (≤ 2.5 m), else ≤ 1.5 m,
with ``ברז שויך לכלי הקרוב`` / ``קו הפניה לא נמצא``. A label without a shape becomes a text-only item at its
leader terminal (``זוהה מכיתוב בלבד``). Faucet labels create one faucet per served basin / sink (a "V" leader
serves two). Shower labels / mixers ("אינטרפוץ", "ראש גשם", "תעלת ניקוז") make one ``fixture_shower`` per room
unless the room has a bath (then they annotate the bath). Shape-only fixtures in a named dry room (bedroom,
living, corridor …) are dropped (wardrobes, beds, armchairs look like tubs and trays), a kitchen sink needs a
kitchen / living / unnamed room.

Scores: shape+leader 0.9, shape+nearest label 0.8, shape only 0.6–0.72 (``זוהה מצורה בלבד``), text only 0.6.
Levels by the brief rule (green ≥ 0.85 with no warning reason).
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import shapely
from shapely.geometry import Point, Polygon

from ..ingest.pdf_vector import VectorSheet
from ..rooms.types import DRY_NAMED, type_from_name
from ..types_sprint2 import BBox, Region
from . import model as M
from .labels import Label, labels, text_items
from .leaders import Leader, LeaderIndex
from .model import FixtureDetection
from .shapes import ShapeHit, cross_marks, detect_shapes, furniture_segments, sink_boxes

DEFAULT_SCALE = 50
SHAPE_DISCIPLINES = frozenset({"architecture", "architecture_master", "master", "construction", "plumbing"})
LABEL_KINDS: dict[str, frozenset[str]] = {
    "plumbing": frozenset(
        {
            "wc_monoblock",
            "wc_concealed",
            "garden_tap",
            "faucet_wall",
            "faucet_basin",
            "washer",
            "ac",
            "bath",
            "shower",
            "mixer",
            "kitchen_sink",
            "sink_point",
        }
    ),
    "architecture": frozenset({"wc_monoblock", "wc_concealed", "washer", "bath", "shower", "kitchen_sink"}),
    "electrical": frozenset({"ac"}),
}
LABEL_KINDS["architecture_master"] = LABEL_KINDS["architecture"]
LABEL_KINDS["master"] = LABEL_KINDS["architecture"]
LABEL_KINDS["construction"] = LABEL_KINDS["architecture"]

TARGETS: dict[str, frozenset[str]] = {
    "wc_monoblock": M.WC_CLASSES,
    "wc_concealed": M.WC_CLASSES,
    "sink_point": M.SINK_CLASSES,
    "kitchen_sink": M.SINK_CLASSES,
    "faucet_wall": M.SINK_CLASSES,
    "faucet_basin": M.SINK_CLASSES,
    "washer": frozenset({"fixture_washing_machine"}),
    "bath": frozenset({"fixture_bath"}),
    "shower": frozenset({"fixture_shower", "fixture_bath"}),
    "mixer": frozenset({"fixture_shower", "fixture_bath"}),
}
KIND_CLASS = {
    "wc_monoblock": "fixture_wc_monoblock",
    "wc_concealed": "fixture_wc_concealed",
    "sink_point": "fixture_basin",
    "kitchen_sink": "fixture_kitchen_sink",
    "washer": "fixture_washing_machine",
    "bath": "fixture_bath",
    "shower": "fixture_shower",
    "mixer": "fixture_shower",
    "garden_tap": "garden_tap",
    "ac": "ac_unit",
    "faucet_wall": "faucet_wall",
    "faucet_basin": "faucet_basin",
}
LEADER_SNAP_M = 0.3
ROOM_NEAREST_M = 2.5
ANY_NEAREST_M = 1.5
AC_MERGE_M = 1.5
SHOWER_MERGE_M = 2.0
NMS_M = 0.25


@dataclass
class _Room:
    id: str
    name: str | None
    poly: Polygon
    type: str | None
    floor: str | None


@dataclass
class _Item:
    cls: str
    center: tuple[float, float]
    box: tuple[float, float, float, float]
    score: float
    source: str
    reasons: list[str] = field(default_factory=list)
    annotations: list[str] = field(default_factory=list)
    angle: float = 0.0
    label: Label | None = None
    leader: Leader | None = None
    attached: _Item | None = None  # faucet -> fixture
    region: int = 0
    mm_per_m: float = 20.0


def _rooms(rooms: Sequence[Any]) -> list[_Room]:
    out: list[_Room] = []
    for r in rooms:
        if isinstance(r, Mapping):
            pts = [(float(p["x"]), float(p["y"])) for p in r.get("polygonMm", [])]
            rid, name, floor = str(r.get("id")), r.get("name"), r.get("floor")
        else:
            pts = [(float(x), float(y)) for x, y in getattr(r, "polygon_mm", [])]
            rid, name, floor = str(r.id), r.name, r.floor
        if len(pts) < 3:
            continue
        poly = shapely.make_valid(Polygon(pts))
        if not isinstance(poly, Polygon):
            hull = poly.convex_hull
            if not isinstance(hull, Polygon):
                continue
            poly = hull
        out.append(_Room(rid, name, poly, type_from_name(name), floor))
    return out


def _room_at(rooms: list[_Room], p: tuple[float, float], tol: float = 0.5) -> _Room | None:
    pt = Point(p)
    best: tuple[float, _Room] | None = None
    for r in rooms:
        d = r.poly.distance(pt)
        if d == 0:
            return r
        if d <= tol and (best is None or d < best[0]):
            best = (d, r)
    return best[1] if best else None


def _norm_discipline(d: str | None) -> str | None:
    if d is None:
        return None
    d = d.lower()
    if d.startswith("architect") or d in ("master", "architecture_master"):
        return "architecture_master"
    return d


def detect(
    prims: VectorSheet,
    text: Sequence[Any],
    rooms: Sequence[Any],
    discipline: str | None,
    *,
    regions: Sequence[Region | Mapping[str, Any]] | None = None,
    scale_denominator: int | None = None,
    detections: Sequence[Any] | None = None,
    debug: dict[str, Any] | None = None,
) -> list[FixtureDetection]:
    """Fixtures, faucets, garden taps and AC positions of one sheet (paper mm). See the module docstring.

    ``text``: TextLine / TextSpan / SimpleText items (``bbox`` x0,y0,x1,y1 + ``text`` [+ ``conf``]).
    ``rooms``: :class:`~..types_sprint2.Room` objects or ``rooms.json`` room dicts of the same sheet (``[]`` ok).
    ``regions``: contracts region dicts / :class:`Region` (scale + floor per drawing); None = whole page.
    ``detections``: optional symbol detections of the sheet (contracts dicts or objects with ``cls``/``class``
    and ``center``/``centerMm``) — sockets snap AC positions on electrical sheets.
    """
    disc = _norm_discipline(discipline)
    regs = [Region.coerce(r) for r in (regions or [])] or [
        Region.from_bbox("r0", (0.0, 0.0, prims.width_mm, prims.height_mm), None, scale_denominator)
    ]
    rms = _rooms(rooms)
    reg_info: list[tuple[tuple[float, float, float, float], float, list[str], str | None]] = []
    for reg in regs:
        den = reg.scale_denominator or scale_denominator
        rs: list[str] = []
        if not den or den <= 0:
            den = DEFAULT_SCALE
            rs.append(M.R_SCALE)
        reg_info.append((reg.bbox.as_xyxy(), 1000.0 / den, rs, reg.floor))

    def region_of(p: tuple[float, float]) -> int:
        for k, (b, _, _, _) in enumerate(reg_info):
            if b[0] <= p[0] <= b[2] and b[1] <= p[1] <= b[3]:
                return k
        return min(range(len(reg_info)), key=lambda k: _box_dist(reg_info[k][0], p))

    items: list[_Item] = []
    shape_items: list[_Item] = []
    if disc in SHAPE_DISCIPLINES:
        for k, (b, mmpm, _, _) in enumerate(reg_info):
            for h in detect_shapes(prims, [b], mmpm):
                shape_items.append(_from_shape(h, k, mmpm))
    # ------------------------------------------------------------------ labels + leaders
    allowed = LABEL_KINDS.get(disc or "", frozenset())
    labs = [lb for lb in labels(text) if lb.kind in allowed]
    li = LeaderIndex(prims, text_items(text)) if labs else None
    avoid_all = [lb.bbox for lb in labels(text)]
    lab_leaders: list[tuple[Label, list[Leader]]] = []
    for lb in labs:
        lead = li.follow(lb, avoid=[a for a in avoid_all if a != lb.bbox]) if li is not None else []
        lab_leaders.append((lb, lead))
    # ------------------------------------------------------------------ shapes vs room names
    kept_shapes: list[_Item] = []
    for it in shape_items:
        room = _room_at(rms, it.center)
        t = room.type if room else None
        if it.cls == "fixture_kitchen_sink":
            if t not in (None, "kitchen", "living", "other"):
                continue
        elif it.cls != "fixture_washing_machine" and t in DRY_NAMED:
            # a label pointing at it rescues it below; keep it aside as a weak candidate
            it.score -= 0.25
        kept_shapes.append(it)
    shape_items = kept_shapes
    # ------------------------------------------------------------------ attach labels
    used_label: set[int] = set()
    faucet_items: list[_Item] = []
    text_only: list[_Item] = []
    for li_idx, (lb, lead) in enumerate(lab_leaders):
        kind = lb.kind or ""
        targets = TARGETS.get(kind)
        k = region_of(lb.center)
        mmpm = reg_info[k][1]
        if targets is None:  # garden tap / AC: text-only positions
            text_only.extend(_point_items(lb, lead, kind, k, mmpm, rms))
            used_label.add(li_idx)
            continue
        matched: list[tuple[_Item, Leader | None]] = []
        for ld in lead:
            cand = [
                s
                for s in shape_items
                if s.cls in targets
                and _box_dist(_pad(s.box, LEADER_SNAP_M * mmpm), ld.terminal) == 0.0
                and s not in [m[0] for m in matched]
            ]
            if cand:
                best = min(cand, key=lambda s: math.dist(s.center, ld.terminal))
                matched.append((best, ld))
        if not matched:
            # the leader passes over the fixture (its free end lies under the label, e.g. an underline
            # running on to the washer): any compatible shape touched by the leader polyline
            for ld in lead:
                if len(ld.polyline) < 2:
                    continue
                line = shapely.LineString(ld.polyline)
                cand = [
                    s
                    for s in shape_items
                    if s.cls in targets
                    and line.intersects(shapely.box(*_pad(s.box, 0.1 * mmpm)))
                    and s not in [m[0] for m in matched]
                ]
                if cand:
                    best = min(cand, key=lambda s: line.distance(Point(s.center)))
                    matched.append((best, ld))
        reason: list[str] = []
        if not matched:
            room = _room_at(rms, lb.center)
            pts = [ld.terminal for ld in lead] or [lb.center]
            pool = [s for s in shape_items if s.cls in targets]
            near: list[tuple[float, _Item]] = []
            for s in pool:
                d = min(math.dist(s.center, p) for p in pts) / mmpm
                same = room is not None and _room_at(rms, s.center) is room
                if (same and d <= ROOM_NEAREST_M) or d <= ANY_NEAREST_M:
                    near.append((d, s))
            if near:
                matched.append((min(near, key=lambda q: q[0])[1], None))
                reason.append(M.R_NO_LEADER if not lead else M.R_LEADER_UNSURE)
        if kind in ("faucet_wall", "faucet_basin"):
            if matched:
                for s, mld in matched:
                    f = _Item(
                        kind,
                        s.center,
                        _pad(s.box, 0.0),
                        0.88 if mld is not None else 0.75,
                        "shape+text",
                        list(reason) + ([] if mld is not None else [M.R_FAUCET_NEAREST]),
                        _heights(lb),
                        label=lb,
                        leader=mld,
                        attached=s,
                        region=k,
                        mm_per_m=mmpm,
                    )
                    faucet_items.append(f)
                    if mld is not None:  # the faucet note's leader also confirms the basin it ends on
                        s.score = max(s.score, 0.85)
                        if s.source == "shape":
                            s.source = "shape+text"
                            s.label = s.label or lb
                            s.leader = s.leader or mld
            else:
                text_only.extend(_point_items(lb, lead, kind, k, mmpm, rms, multi=True))
            used_label.add(li_idx)
            continue
        if matched:
            for s, mld2 in matched:
                _apply_label(s, lb, mld2, kind, reason)
            used_label.add(li_idx)
        else:
            text_only.extend(_point_items(lb, lead, kind, k, mmpm, rms, multi=kind == "sink_point"))
            used_label.add(li_idx)
    # shapes in dry rooms that no label confirmed are dropped
    shape_items = [s for s in shape_items if s.score >= 0.5 or s.source != "shape"]
    items = shape_items + text_only
    items = _resolve_showers(items, rms)
    if disc in SHAPE_DISCIPLINES:
        items = _shower_zones(prims, items, rms, reg_info, add_unlabelled=disc != "plumbing")
        _snap_text_items(prims, items, rms, reg_info, text)
    items = _merge_ac(items, disc, detections)
    items = _nms(items)
    items.extend(faucet_items)
    # ------------------------------------------------------------------ output records
    items.sort(key=lambda it: (round(it.center[1] / 20.0), -it.center[0], it.cls))
    out: list[FixtureDetection] = []
    ids: dict[int, str] = {}
    order = [it for it in items if it.attached is None] + [it for it in items if it.attached is not None]
    for it in order:
        fid = f"d_fx_{len(out) + 1}"
        ids[id(it)] = fid
        _, _, rs, floor = reg_info[it.region]
        room = _room_at(rms, it.center)
        reasons = list(it.reasons) + list(rs)
        if room is None and rms:
            reasons.append(M.R_NO_ROOM)
        score = it.score * (0.9 if rs else 1.0)
        det = FixtureDetection(
            id=fid,
            cls=it.cls,
            center=it.center,
            bbox=BBox.from_xyxy(it.box),
            angle=it.angle,
            score=score,
            reasons=reasons,
            room_id=room.id if room else None,
            floor=room.floor if room and room.floor else floor,
            source=it.source,
            annotations=list(dict.fromkeys(it.annotations)),
            attached_to=ids.get(id(it.attached)) if it.attached is not None else None,
            label=it.label.text[:120] if it.label else None,
            leader=list(it.leader.polyline) if it.leader else [],
        )
        if det.source == "shape" and M.R_SHAPE_ONLY not in det.reasons:
            det.reasons.insert(0, M.R_SHAPE_ONLY)
        det.relevel()
        out.append(det)
    out.sort(key=lambda d: int(d.id.split("_")[-1]))
    if debug is not None:
        debug["labels"] = lab_leaders
        debug["shapes"] = shape_items
        debug["regions"] = reg_info
    return out


# ---------------------------------------------------------------------------------------------- helpers


def _box_dist(b: tuple[float, float, float, float], p: tuple[float, float]) -> float:
    dx = max(b[0] - p[0], 0.0, p[0] - b[2])
    dy = max(b[1] - p[1], 0.0, p[1] - b[3])
    return math.hypot(dx, dy)


def _pad(b: tuple[float, float, float, float], d: float) -> tuple[float, float, float, float]:
    return (b[0] - d, b[1] - d, b[2] + d, b[3] + d)


def _heights(lb: Label) -> list[str]:
    from .labels import heights

    return [f"H={h}" for h in heights(lb)][:2]


def _from_shape(h: ShapeHit, region: int, mmpm: float) -> _Item:
    return _Item(
        h.cls,
        h.center,
        h.comp.box,
        h.score,
        "shape",
        list(h.reasons),
        list(h.annotations),
        angle=h.comp.angle,
        region=region,
        mm_per_m=mmpm,
    )


def _apply_label(s: _Item, lb: Label, ld: Leader | None, kind: str, reason: list[str]) -> None:
    cls = KIND_CLASS.get(kind, s.cls)
    if kind in ("wc_monoblock", "wc_concealed"):
        s.cls = cls
        s.reasons = [r for r in s.reasons if r != M.R_WC_TYPE_SHAPE]
    elif kind == "kitchen_sink":
        s.cls = "fixture_kitchen_sink"
    elif kind in ("shower", "mixer") and s.cls == "fixture_bath":
        s.annotations.append("אינטרפוץ" if kind == "mixer" else "מקלחת באמבטיה")
    base = 0.9 if ld is not None else 0.8
    s.score = max(s.score, base)
    s.source = "shape+text"
    s.reasons.extend(reason)
    s.label = s.label or lb
    s.leader = s.leader or ld
    s.annotations.extend(_heights(lb))


def _point_items(
    lb: Label, lead: list[Leader], kind: str, region: int, mmpm: float, rooms: list[_Room], *, multi: bool = False
) -> list[_Item]:
    """Text-only items at the leader terminal(s) (several for a "V" leader when ``multi``), else at the label."""
    cls = KIND_CLASS[kind]
    pts: list[tuple[tuple[float, float], Leader | None]] = []
    good = [ld for ld in lead if ld.length / mmpm <= 4.0]
    if good:
        good.sort(key=lambda ld: -ld.length)
        for ld in good if multi else good[:1]:
            if all(math.dist(ld.terminal, p) > 0.3 * mmpm for p, _ in pts):
                pts.append((ld.terminal, ld))
    if not pts:
        pts.append((lb.center, None))
    out: list[_Item] = []
    for p, pld in pts:
        if kind == "sink_point":
            room = _room_at(rooms, p)
            if room is not None and room.type == "kitchen":
                cls = "fixture_kitchen_sink"
        reasons = [M.R_TEXT_ONLY]
        if pld is None and kind not in ("ac",):
            reasons.append(M.R_NO_LEADER)
        r = 0.2 * mmpm
        out.append(
            _Item(
                cls,
                p,
                (p[0] - r, p[1] - r, p[0] + r, p[1] + r),
                0.62 if pld is not None else 0.55,
                "text",
                reasons,
                _heights(lb),
                label=lb,
                leader=pld,
                region=region,
                mm_per_m=mmpm,
            )
        )
    return out


def _resolve_showers(items: list[_Item], rooms: list[_Room]) -> list[_Item]:
    """One shower per room from shower notes / mixers; none when the room has a bath (they annotate it)."""
    showers = [it for it in items if it.cls == "fixture_shower"]
    if not showers:
        return items
    others = [it for it in items if it.cls != "fixture_shower"]
    baths = [it for it in others if it.cls == "fixture_bath"]
    groups: list[list[_Item]] = []
    for s in sorted(showers, key=lambda it: (it.source == "text", -it.score)):
        room = _room_at(rooms, s.center)
        placed = False
        for g in groups:
            g_room = _room_at(rooms, g[0].center)
            same = (room is not None and g_room is room) or (
                (room is None or g_room is None) and math.dist(g[0].center, s.center) <= SHOWER_MERGE_M * s.mm_per_m
            )
            if same:
                g.append(s)
                placed = True
                break
        if not placed:
            groups.append([s])
    out = list(others)
    for g in groups:
        lead = g[0]
        room = _room_at(rooms, lead.center)
        bath = next((b for b in baths if room is not None and _room_at(rooms, b.center) is room), None)
        if bath is None and room is None:
            bath = next((b for b in baths if math.dist(b.center, lead.center) <= SHOWER_MERGE_M * lead.mm_per_m), None)
        if bath is not None:
            for s in g:
                if s.label is not None:
                    bath.annotations.append("אינטרפוץ" if "אינטרפוץ" in s.label.text else "מקלחת באמבטיה")
            continue
        # prefer a drawn tray, else the mixer's leader end
        best = max(g, key=lambda it: (it.source != "text", it.leader is not None, it.score))
        if best.source == "text" and M.R_SHOWER_FROM_MIXER not in best.reasons and best.label and "אינטרפוץ" in best.label.text:
            best.reasons.append(M.R_SHOWER_FROM_MIXER)
        if len(g) > 1:
            best.score = min(0.9, best.score + 0.08 * (len(g) - 1))
            for s in g:
                if s is not best:
                    best.annotations.extend(s.annotations)
        out.append(best)
    return out


ZONE_SIDE_M = (0.7, 2.0)  # long side of a shower zone
ZONE_SHORT_M = (0.6, 1.5)
ZONE_REACH_M = 2.5  # from the shower note / mixer
ZONE_EXTEND_MM = 0.4  # furniture strokes stop just short of the wall face


def _zone_faces(
    prims: VectorSheet, room: _Room, box: tuple[float, float, float, float], mmpm: float
) -> list[tuple[Polygon, int]]:
    """Shower-zone candidates of one room: faces of (thin grey strokes inside the room + the room outline) — a
    glass screen / tray drawn as 2–4 sides closes against the walls — sized like a shower (0.7–2.0 × 0.6–1.5 m) and
    nearly rectangular. Each face comes with the number of its sides lying on the room outline."""
    rb = room.poly.bounds
    segs, _ = furniture_segments(prims, [(max(rb[0], box[0]), max(rb[1], box[1]), min(rb[2], box[2]), min(rb[3], box[3]))])  # type: ignore[misc]
    if not len(segs):
        return []
    inner = room.poly.buffer(0.3)
    lines = []
    for x0, y0, x1, y1 in segs:
        ln = math.hypot(x1 - x0, y1 - y0)
        if ln < 0.15 * mmpm:  # drains, glyph pieces
            continue
        ux, uy = (x1 - x0) / ln, (y1 - y0) / ln
        e = ZONE_EXTEND_MM
        ls = shapely.LineString([(x0 - ux * e, y0 - uy * e), (x1 + ux * e, y1 + uy * e)])
        if inner.contains(Point((x0 + x1) / 2, (y0 + y1) / 2)):
            lines.append(ls)
    if not lines:
        return []
    ring = room.poly.exterior
    net = shapely.unary_union([*lines, ring])
    out: list[tuple[Polygon, int]] = []
    room_area = room.poly.area
    for f in shapely.polygonize(list(getattr(net, "geoms", [net]))).geoms:
        if not isinstance(f, Polygon) or f.area <= 0 or f.area > 0.75 * room_area:
            continue
        if not room.poly.buffer(0.5).contains(f):
            continue
        rr = f.minimum_rotated_rectangle
        xy = list(rr.exterior.coords)[:4] if isinstance(rr, Polygon) else []
        if len(xy) < 4:
            continue
        a, b = math.dist(xy[0], xy[1]) / mmpm, math.dist(xy[1], xy[2]) / mmpm
        lo, hi = max(a, b), min(a, b)
        if not (ZONE_SIDE_M[0] <= lo <= ZONE_SIDE_M[1] and ZONE_SHORT_M[0] <= hi <= ZONE_SHORT_M[1]):
            continue
        if f.area / max(rr.area, 1e-9) < 0.85:
            continue
        near_wall = ring.buffer(0.15 * mmpm)
        sides = sum(
            1
            for i in range(4)
            if shapely.LineString([xy[i], xy[(i + 1) % 4]]).intersection(near_wall).length
            >= 0.6 * math.dist(xy[i], xy[(i + 1) % 4])
        )
        if sides == 0:
            continue
        out.append((f, sides))
    return out


def _shower_zones(
    prims: VectorSheet,
    items: list[_Item],
    rooms: list[_Room],
    reg_info: list[tuple[tuple[float, float, float, float], float, list[str], str | None]],
    *,
    add_unlabelled: bool = False,
) -> list[_Item]:
    """Showers sit at the centre of their zone (the enclosure / tray outline in the shower's room nearest its note),
    not on the note. ``add_unlabelled`` (plans: no plumbing notes): a bathroom without bath / shower whose corner
    holds a shower-sized enclosure gets a shape-only shower (yellow)."""
    fixtures = [it for it in items if it.cls != "fixture_shower" and it.cls not in ("ac_unit", "garden_tap")]

    def free(face: Polygon) -> bool:  # a zone holds no other fixture
        return not any(face.buffer(-0.5).contains(Point(it.center)) for it in fixtures)

    cache: dict[str, list[tuple[Polygon, int]]] = {}

    def faces_of(room: _Room, k: int) -> list[tuple[Polygon, int]]:
        if room.id not in cache:
            box, mmpm = reg_info[k][0], reg_info[k][1]
            try:
                cache[room.id] = [fs for fs in _zone_faces(prims, room, box, mmpm) if free(fs[0])]
            except Exception:  # noqa: BLE001 - geometry edge cases: keep the note position
                cache[room.id] = []
        return cache[room.id]

    used: set[int] = set()
    for it in items:
        if it.cls != "fixture_shower" or it.source != "text":
            continue
        room = _room_at(rooms, it.center)
        pts = [it.center] + ([it.label.center] if it.label is not None else [])
        if room is None and it.label is not None:
            room = _room_at(rooms, it.label.center)
        if room is None:
            continue
        cands = [(min(f.distance(Point(p)) for p in pts), f) for f, _ in faces_of(room, it.region) if id(f) not in used]
        cands = [c for c in cands if c[0] <= ZONE_REACH_M * it.mm_per_m]
        if not cands:
            if M.R_SHOWER_ZONE_MISSING not in it.reasons:
                it.reasons.append(M.R_SHOWER_ZONE_MISSING)
            continue
        _, f = min(cands, key=lambda c: (c[0], c[1].area))
        used.add(id(f))
        b = f.bounds
        c = f.centroid
        it.center = (float(c.x), float(c.y))
        it.box = (float(b[0]), float(b[1]), float(b[2]), float(b[3]))
        it.source = "shape+text"
        it.reasons = [r for r in it.reasons if r not in (M.R_TEXT_ONLY, M.R_NO_LEADER)] + [M.R_SHOWER_ZONE]
        it.score = max(it.score, 0.8)
    if add_unlabelled:
        wet_items = [it for it in items if it.cls in ("fixture_shower", "fixture_bath")]
        for room in rooms:
            if room.type != "bathroom" or any(_room_at(rooms, it.center) is room for it in wet_items):
                continue
            rp = room.poly.representative_point()
            k = next((i for i, (b, _, _, _) in enumerate(reg_info) if _box_dist(b, (rp.x, rp.y)) == 0), 0)
            cands = [(sides, f) for f, sides in faces_of(room, k) if sides >= 2]
            if not cands:
                continue
            mmpm = reg_info[k][1]
            _, f = max(cands, key=lambda c: (c[0], -c[1].area))
            ext = f.minimum_rotated_rectangle
            if not isinstance(ext, Polygon):
                continue
            xy = list(ext.exterior.coords)[:4]
            dims = sorted((math.dist(xy[0], xy[1]) / mmpm, math.dist(xy[1], xy[2]) / mmpm))
            if dims[1] / max(dims[0], 1e-6) > 1.6:  # vanity counters are long and narrow
                continue
            b = f.bounds
            c = f.centroid
            items.append(
                _Item(
                    "fixture_shower",
                    (float(c.x), float(c.y)),
                    (float(b[0]), float(b[1]), float(b[2]), float(b[3])),
                    0.6,
                    "shape",
                    [M.R_SHAPE_ONLY],
                    region=k,
                    mm_per_m=mmpm,
                )
            )
    return items


SNAP_CROSS_TERMINAL_MM = 6.0  # a "+" mark this close to the leader end is the point
SNAP_CROSS_LABEL_MM = 12.0  # … else one this close to the note itself (leader not followed / wrong)
SINK_REACH_M = 1.5
KITCHEN_NAME_REACH_M = 3.0


def _kitchen_context(room: _Room | None, c: tuple[float, float], text: Sequence[Any], mmpm: float) -> bool:
    """A sink in a kitchen: the room is a kitchen / living space (merged names included) or a "מטבח" room name is
    written within 3 m (open plans / merged rooms)."""
    if room is not None:
        if room.type in ("kitchen", "living"):
            return True
        if room.type in ("bathroom", "wc"):
            return False
        if room.name and "מטבח" in room.name:
            return True
    for t in text:
        s = str(getattr(t, "text", "") or "")
        bb = getattr(t, "bbox", None)
        if "מטבח" not in s or bb is None or len(s) > 20:
            continue
        x0, y0, x1, y1 = (float(v) for v in bb[:4])
        if _box_dist((x0, y0, x1, y1), c) <= KITCHEN_NAME_REACH_M * mmpm:
            return True
    return False


def _snap_text_items(
    prims: VectorSheet,
    items: list[_Item],
    rooms: list[_Room],
    reg_info: list[tuple[tuple[float, float, float, float], float, list[str], str | None]],
    text: Sequence[Any],
) -> None:
    """Text-only items sit on their note when the leader was not followed: move them onto the drawn point.
    * AC (drain + gas note): the "+" point mark at the leader end (≤ 6 mm), else the free one nearest the note
      (≤ 12 mm) — the note's leader may have been confused with a neighbouring line;
    * sink notes ("נק' מים+ביוב", shared by basins and kitchen sinks): the sink-sized box outline nearest the leader
      end / note in the same room (≤ 1.5 m); class from the room (kitchen / living or a "מטבח" name nearby →
      kitchen sink; bathroom / wc → basin). In place."""
    todo = [it for it in items if it.source == "text" and it.cls in ("ac_unit", "fixture_basin", "fixture_kitchen_sink")]
    if not todo:
        return
    boxes = [b for b, _, _, _ in reg_info]
    crosses = cross_marks(prims, boxes) if any(it.cls == "ac_unit" for it in todo) else []
    taken: set[tuple[float, float]] = set()
    for it in sorted((i for i in todo if i.cls == "ac_unit"), key=lambda i: (i.leader is None, -i.score)):
        free = [c for c in crosses if c not in taken]
        if not free:
            break
        pick = None
        if it.leader is not None:
            c = min(free, key=lambda q: math.dist(q, it.leader.terminal))  # type: ignore[union-attr]
            if math.dist(c, it.leader.terminal) <= SNAP_CROSS_TERMINAL_MM:  # type: ignore[union-attr]
                pick = c
        if pick is None and it.label is not None:
            lb = it.label.bbox
            c = min(free, key=lambda q: _box_dist(lb, q))
            if _box_dist(lb, c) <= SNAP_CROSS_LABEL_MM:
                pick = c
        if pick is None:
            continue
        taken.add(pick)
        r = 0.2 * it.mm_per_m
        it.center = pick
        it.box = (pick[0] - r, pick[1] - r, pick[0] + r, pick[1] + r)
        it.reasons = [x for x in it.reasons if x != M.R_NO_LEADER]
    sinks = [i for i in todo if i.cls != "ac_unit"]
    if not sinks:
        return
    occupied = [i.box for i in items if i.source != "text" and i.cls in M.SINK_CLASSES]
    by_region: dict[int, list[Any]] = {}
    for it in sinks:
        if it.region not in by_region:
            by_region[it.region] = sink_boxes(prims, [reg_info[it.region][0]], reg_info[it.region][1])
        pts = [it.center] + ([it.label.center] if it.label is not None else [])
        room = _room_at(rooms, it.center)
        cands = []
        for comp in by_region[it.region]:
            cen = ((comp.box[0] + comp.box[2]) / 2, (comp.box[1] + comp.box[3]) / 2)
            if any(_box_dist(b, cen) == 0.0 for b in occupied):
                continue
            croom = _room_at(rooms, cen)
            if room is not None and croom is not None and croom is not room:
                continue
            d = min(math.dist(cen, p) for p in pts) / it.mm_per_m
            if d <= SINK_REACH_M:
                cands.append((d, cen, comp))
        if not cands:
            continue
        _, cen, comp = min(cands, key=lambda q: q[0])
        occupied.append(comp.box)
        it.center = cen
        it.box = comp.box
        it.source = "shape+text"
        it.score = max(it.score, 0.75)
        it.reasons = [x for x in it.reasons if x not in (M.R_TEXT_ONLY, M.R_NO_LEADER)] + [M.R_LEADER_UNSURE]
        kitchen = _kitchen_context(_room_at(rooms, cen) or room, cen, text, it.mm_per_m)
        it.cls = "fixture_kitchen_sink" if kitchen else "fixture_basin"


def _center_of(d: Any) -> tuple[float, float] | None:
    if isinstance(d, Mapping):
        c = d.get("centerMm")
        return (float(c["x"]), float(c["y"])) if c else None
    c = getattr(d, "center", None)
    return (float(c[0]), float(c[1])) if c is not None else None


def _class_of(d: Any) -> str:
    if isinstance(d, Mapping):
        return str(d.get("class", ""))
    return str(getattr(d, "cls", getattr(d, "class_", "")))


def _merge_ac(items: list[_Item], disc: str | None, detections: Sequence[Any] | None) -> list[_Item]:
    """AC labels of one unit ("מזגן עילי" + "ניקוז + גז למזגן" / "שקע למזגן") → one ``ac_unit``; electrical
    sheets snap it to the nearest socket detection (≤ 15 mm paper)."""
    acs = [it for it in items if it.cls == "ac_unit"]
    if not acs:
        return items
    rest = [it for it in items if it.cls != "ac_unit"]

    def overhead(it: _Item) -> bool:  # "מזגן עילי" alone names the unit of a nearby drain / socket note
        t = it.label.text if it.label is not None else ""
        return "עילי" in t and not any(k in t for k in ("ניקוז", "גז", "שקע", "למ"))

    merged = [a for a in acs if not overhead(a)]
    # two notes of one unit (closer than 0.5 m) are one
    uniq: list[_Item] = []
    for a in merged:
        if any(math.dist(u.center, a.center) <= 0.5 * a.mm_per_m for u in uniq):
            continue
        uniq.append(a)
    merged = uniq
    for a in (a for a in acs if overhead(a)):
        tgt = min(merged, key=lambda m: math.dist(m.center, a.center), default=None)
        if tgt is not None and math.dist(tgt.center, a.center) <= AC_MERGE_M * a.mm_per_m:
            tgt.score = min(0.9, tgt.score + 0.1)
            continue
        merged.append(a)
    if disc == "electrical" and detections:
        socks = [(c, _class_of(d)) for d in detections if (c := _center_of(d)) is not None and _class_of(d).startswith("socket")]
        for a in merged:
            if not socks:
                break
            c, _ = min(socks, key=lambda q: math.dist(q[0], a.center))
            if math.dist(c, a.center) <= 15.0:
                a.center = c
                r = 0.2 * a.mm_per_m
                a.box = (c[0] - r, c[1] - r, c[0] + r, c[1] + r)
                a.reasons.append(M.R_AC_FROM_SOCKET)
                a.score = max(a.score, 0.7)
    return rest + merged


def _nms(items: list[_Item]) -> list[_Item]:
    """Same-class items closer than 0.25 m are one (keep the better: shape+text > shape > text, then score)."""
    rank = {"shape+text": 2, "shape": 1, "text": 0}
    items = sorted(items, key=lambda it: (-rank.get(it.source, 0), -it.score))
    kept: list[_Item] = []
    for it in items:
        dup = next(
            (
                k
                for k in kept
                if k.cls == it.cls
                and (math.dist(k.center, it.center) <= NMS_M * it.mm_per_m or _box_dist(k.box, it.center) == 0.0)
            ),
            None,
        )
        if dup is not None:
            if dup.source == "shape" and it.source == "text" and it.label is not None:
                _apply_label(dup, it.label, it.leader, "", [])
            continue
        kept.append(it)
    return kept


def fixtures_json(dets: Sequence[FixtureDetection], *, extended: bool = True) -> dict[str, Any]:
    """``kamutan.fixtures/1`` document (contracts Detection objects + the extended fields)."""
    return {"schema": "kamutan.fixtures/1", "fixtures": [d.to_json(extended=extended) for d in dets]}
