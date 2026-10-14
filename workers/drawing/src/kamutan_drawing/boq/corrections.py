"""Human corrections (``orgs/{o}/projects/{p}/corrections``) applied in ``boq.build`` after automatic detection.

Contract (docs/agents/SPRINT4_BRIEF.md): ``{kind: add|remove|reclassify|move|link|unlink|measure|count|accept|reject,
sheetId, versionId (at edit time), anchorMm {x,y}, radiusMm, detectionId|null, signature|null, class|null,
itemCode|null, linkGroupId|null, switchIds?, pointIds?, geometry {type point|polygon|polyline, mm[]}|null,
quantity|null, unit|null, roomId|null, floor|null, reason|null, batchId|null, by, at, revertedAt|null}``.

Application order: ``at`` then id (a later correction wins). Reverted corrections (``revertedAt``) are skipped.

**Re-matching** (a correction made on an older version of the sheet): the target is the current detection nearest to
``anchorMm`` within ``radiusMm`` (default 3 mm paper) of the same class family (:func:`family`); ids in
``switchIds`` / ``pointIds`` are re-matched the same way from their position in the correction's version
(``old_detections``). On the correction's own version the ``detectionId`` is used directly. A correction that finds
no target is *unmatched*: reported in the build (``boqBuilds/{id}.unmatchedCorrections``, the review queue's
"תיקון לא הותאם") and not applied.

Semantics:

* ``accept``  → level green, reasons ``[אושר ידנית]``;   ``reject`` / ``remove`` → the detection is dropped (and
  removed from link groups);
* ``reclassify`` → class (+ itemCode) from the correction, green ``סווג ידנית``; legend / mapping / label rules do
  not override it;
* ``move`` → new centre = ``geometry.mm[0]`` (room re-assigned from the sheet's rooms);
* ``add`` → a manual detection ``m_{correctionId}`` (``source: manual``, green ``נוסף ידנית``). Re-applied on a newer
  version where the detector now finds the same family within the radius → that detection is accepted instead
  (no double count);
* ``link`` → the switches / luminaires leave their groups and form (or join ``linkGroupId``) a human group
  (kind from the counts: 0 switches sensor, 1 single/shared, ≥ 2 two_way), green; ``unlink`` → removed from the
  group (a group left without switches is dissolved unless it is a sensor group);
* ``measure`` / ``count`` → manual quantities (:class:`ManualQty`): ``quantity`` or the geometry (polygon area /
  polyline length, paper mm × scale) in m² / m'; item = ``itemCode`` (or ``class`` through the rules).
"""

from __future__ import annotations

import itertools
import math
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from typing import Any

from .contracts import LinkGroup

try:  # Worker-A's re-matching (symbols/rematch.py); the local fallback below has the same semantics
    from ..symbols.rematch import rematch as _wa_rematch
    from ..symbols.rematch import rematch_ids as _wa_rematch_ids
except ImportError:  # pragma: no cover
    _wa_rematch = None  # type: ignore[assignment]
    _wa_rematch_ids = None  # type: ignore[assignment]
from .rules import (
    LUMINAIRE_CLASSES,
    R_ACCEPTED,
    R_ADDED,
    R_RECLASSED,
    SWITCH_CLASSES,
)

KINDS = ("add", "remove", "reclassify", "move", "link", "unlink", "measure", "count", "accept", "reject")
DEFAULT_RADIUS_MM = 3.0
COMMS = frozenset({"tv_point", "data_point", "phone_point", "bezek_point", "speaker", "intercom", "doorbell"})
FEEDS = frozenset({"heater_feed", "water_heater_feed"})

U_NO_TARGET = "לא נמצא פריט במיקום התיקון"
U_NO_SHEET = "הגיליון לא נכלל בבנייה"
U_INVALID = "תיקון חסר נתונים"
U_NO_GROUP = "קבוצת הקישור לא נמצאה"

OldDetections = Callable[[str, str], list[dict[str, Any]] | None]


def family(cls: str | None) -> str | None:
    if not cls:
        return None
    if cls in SWITCH_CLASSES or cls.startswith("switch_"):
        return "switch"
    if cls in LUMINAIRE_CLASSES or cls == "ceiling_fan" or cls.startswith("luminaire_"):
        return "luminaire"
    if cls.startswith("socket_"):
        return "socket"
    if cls in COMMS:
        return "comms"
    if cls in FEEDS:
        return "feed"
    if cls.startswith(("fixture_", "faucet_")) or cls == "garden_tap":
        return "plumbing"
    return cls


@dataclass(frozen=True)
class Correction:
    id: str
    kind: str
    sheet_id: str
    version_id: str
    anchor: tuple[float, float] | None
    radius_mm: float
    detection_id: str | None
    signature: str | None
    cls: str | None
    item_code: str | None
    link_group_id: str | None
    switch_ids: tuple[str, ...]
    point_ids: tuple[str, ...]
    geometry_type: str | None
    geometry: tuple[tuple[float, float], ...]
    quantity: float | None
    unit: str | None
    room_id: str | None
    floor: str | None
    batch_id: str | None
    at: str

    @staticmethod
    def from_doc(cid: str, d: dict[str, Any]) -> Correction | None:
        kind = d.get("kind")
        sid, vid = d.get("sheetId"), d.get("versionId")
        if kind not in KINDS or not isinstance(sid, str) or not sid or not isinstance(vid, str) or not vid:
            return None
        a = d.get("anchorMm")
        anchor = (_num(a.get("x")), _num(a.get("y"))) if isinstance(a, dict) else None
        graw = d.get("geometry")
        g: dict[str, Any] = graw if isinstance(graw, dict) else {}
        pts = tuple((_num(p.get("x")), _num(p.get("y"))) for p in (g.get("mm") or []) if isinstance(p, dict))
        q = d.get("quantity")
        r = d.get("radiusMm")
        return Correction(
            cid,
            str(kind),
            sid,
            vid,
            anchor,
            float(r) if isinstance(r, int | float) and r > 0 else DEFAULT_RADIUS_MM,
            _s(d.get("detectionId")),
            _s(d.get("signature")),
            _s(d.get("class")),
            _s(d.get("itemCode")),
            _s(d.get("linkGroupId")),
            tuple(str(x) for x in (d.get("switchIds") or []) if x),
            tuple(str(x) for x in (d.get("pointIds") or []) if x),
            str(g.get("type")) if g.get("type") else None,
            pts,
            float(q) if isinstance(q, int | float) and not isinstance(q, bool) and math.isfinite(q) else None,
            _s(d.get("unit")),
            _s(d.get("roomId")),
            _s(d.get("floor")),
            _s(d.get("batchId")),
            str(d.get("at") or ""),
        )


def _s(v: Any) -> str | None:
    return str(v) if isinstance(v, str) and v else None


def _num(v: Any) -> float:
    return float(v) if isinstance(v, int | float) and math.isfinite(v) else 0.0


def parse_corrections(rows: list[tuple[str, dict[str, Any]]]) -> tuple[list[Correction], dict[str, int]]:
    out: list[Correction] = []
    counts = {"total": 0, "reverted": 0, "invalid": 0}
    for cid, d in rows:
        if not isinstance(d, dict):
            continue
        counts["total"] += 1
        if d.get("revertedAt"):
            counts["reverted"] += 1
            continue
        c = Correction.from_doc(cid, d)
        if c is None:
            counts["invalid"] += 1
            continue
        out.append(c)
    out.sort(key=lambda c: (c.at, c.id))
    return out, counts


@dataclass
class ManualQty:
    """A ``measure`` / ``count`` correction: manual quantity on a line."""

    correction: Correction
    sheet_id: str
    version_id: str
    qty: float
    unit: str | None
    item_code: str | None
    cls: str | None
    floor: str | None
    room_id: str | None
    center: tuple[float, float]
    points: tuple[tuple[float, float], ...] = ()  # count clicks (one evidence item each)


@dataclass
class Applied:
    sheets: list[Any]  # list[SheetInput] (typed loosely: no import cycle with aggregate)
    manual: list[ManualQty] = field(default_factory=list)
    unmatched: list[dict[str, Any]] = field(default_factory=list)
    applied: list[str] = field(default_factory=list)
    stats: dict[str, int] = field(default_factory=dict)


def _poly_area(pts: tuple[tuple[float, float], ...]) -> float:
    return abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(pts, pts[1:] + pts[:1], strict=True))) / 2.0


def _poly_len(pts: tuple[tuple[float, float], ...]) -> float:
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in itertools.pairwise(pts))


def _in_poly(x: float, y: float, poly: list[dict[str, Any]]) -> bool:
    inside = False
    for i in range(len(poly)):
        a, b = poly[i], poly[(i + 1) % len(poly)]
        ax, ay, bx, by = _num(a.get("x")), _num(a.get("y")), _num(b.get("x")), _num(b.get("y"))
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / ((by - ay) or 1e-12) + ax:
            inside = not inside
    return inside


class _SheetState:
    def __init__(self, sheet: Any) -> None:
        self.sheet = sheet
        self.dets: list[dict[str, Any]] = [{**d, "reasons": list(d.get("reasons") or [])} for d in sheet.detections]
        self.by_id: dict[str, dict[str, Any]] = {str(d.get("id")): d for d in self.dets}
        self.groups: list[dict[str, Any]] | None = [g.model_dump() for g in sheet.links] if sheet.links is not None else None
        self.rooms: list[dict[str, Any]] = [dict(r) for r in sheet.room_docs]
        self.changed = False

    def live(self) -> list[dict[str, Any]]:
        return [d for d in self.dets if not d.get("_removed")]

    def room_at(self, x: float, y: float) -> str | None:
        for r in self.rooms:
            if r.get("_rejected"):
                continue
            poly = r.get("polygonMm") or []
            if len(poly) >= 3 and _in_poly(x, y, poly):
                return str(r.get("id"))
        return None

    def floor_at(self, x: float, y: float) -> str | None:
        for r in self.sheet.regions:
            poly = r.get("polygonMm") or []
            if r.get("floor") and len(poly) >= 3 and _in_poly(x, y, poly):
                return str(r["floor"])
        floors = list(dict.fromkeys(self.sheet.floors))
        return floors[0] if len(floors) == 1 else None

    def finish(self) -> Any:
        if not self.changed:
            return self.sheet
        removed = {str(d.get("id")) for d in self.dets if d.get("_removed")}
        dets = [d for d in self.dets if not d.get("_removed")]
        links = self.sheet.links
        if self.groups is not None:
            links = []
            for g in self.groups:
                g["switchIds"] = [i for i in g["switchIds"] if i not in removed]
                g["luminaireIds"] = [i for i in g["luminaireIds"] if i not in removed]
                if not g["switchIds"] and not g["luminaireIds"]:
                    continue
                links.append(LinkGroup.model_validate(g))
        rooms = [r for r in self.rooms if not r.get("_rejected")]
        return replace(self.sheet, detections=dets, links=links, room_docs=rooms)

    def group(self, c: Correction) -> dict[str, Any] | None:
        """The link group a correction names: by id on its own version, else the group with a member nearest
        to the anchor (within the radius)."""
        if self.groups is None or not c.link_group_id:
            return None
        if c.version_id == self.sheet.version_id or c.anchor is None:
            return next((g for g in self.groups if g["id"] == c.link_group_id), None)
        best: tuple[float, str, dict[str, Any]] | None = None
        for g in self.groups:
            for i in [*g["switchIds"], *g["luminaireIds"]]:
                d = self.by_id.get(i)
                if d is None:
                    continue
                x, y = _center(d)
                dist = math.hypot(x - c.anchor[0], y - c.anchor[1])
                if dist <= c.radius_mm and (best is None or (dist, g["id"]) < (best[0], best[1])):
                    best = (dist, g["id"], g)
        return best[2] if best else None

    def room(self, c: Correction) -> dict[str, Any] | None:
        if c.version_id == self.sheet.version_id and c.room_id:
            return next((r for r in self.rooms if r.get("id") == c.room_id and not r.get("_rejected")), None)
        rid = self.room_at(*c.anchor) if c.anchor else None
        return next((r for r in self.rooms if r.get("id") == rid), None) if rid else None


def _center(d: dict[str, Any]) -> tuple[float, float]:
    c = d.get("centerMm") or {}
    return _num(c.get("x")), _num(c.get("y"))


def _nearest(
    st: _SheetState, at: tuple[float, float], radius: float, fam: str | None, *, strict: bool, exclude: set[str] | None = None
) -> dict[str, Any] | None:
    cands = []
    for d in st.live():
        if exclude and str(d.get("id")) in exclude:
            continue
        x, y = _center(d)
        dist = math.hypot(x - at[0], y - at[1])
        if dist > radius:
            continue
        same = fam is None or family(str(d.get("class"))) == fam
        if strict and not same:
            continue
        cands.append((0 if same else 1, dist, str(d.get("id")), d))
    return min(cands, key=lambda t: (t[0], t[1], t[2]))[3] if cands else None


def apply_corrections(
    sheets: list[Any],
    corrections: list[Correction],
    old_detections: OldDetections | None = None,
) -> Applied:
    states = {s.sheet_id: _SheetState(s) for s in sheets}
    pre: dict[str, Any] = {}  # correction id → Worker-A Rematched (current version, before any correction)
    out = Applied([])
    stats = {"applied": 0, "unmatched": 0, "manual": 0, "rematched": 0, "addMatchedAuto": 0}
    old_cache: dict[tuple[str, str], dict[str, dict[str, Any]]] = {}

    def old(sid: str, vid: str) -> dict[str, dict[str, Any]]:
        if (sid, vid) not in old_cache:
            rows = old_detections(sid, vid) if old_detections else None
            old_cache[(sid, vid)] = {str(d.get("id")): d for d in rows or [] if isinstance(d, dict)}
        return old_cache[(sid, vid)]

    if _wa_rematch is not None:
        for sid, st0 in states.items():
            mine = [c for c in corrections if c.sheet_id == sid]
            if not mine:
                continue
            payload = []
            for c in mine:
                od = old(c.sheet_id, c.version_id).get(c.detection_id or "") if c.version_id != st0.sheet.version_id else None
                payload.append({
                    "id": c.id, "kind": c.kind, "sheetId": c.sheet_id, "versionId": c.version_id,
                    "anchorMm": {"x": c.anchor[0], "y": c.anchor[1]} if c.anchor else None, "radiusMm": c.radius_mm,
                    "detectionId": c.detection_id, "class": c.cls, "signature": c.signature,
                    "fromClass": (od or {}).get("class") or None,
                })  # fmt: skip
            for rm in _wa_rematch(payload, st0.sheet.detections, sheet_id=sid, version_id=st0.sheet.version_id):
                pre[rm.correction_id] = rm

    def unmatched(c: Correction, reason: str) -> None:
        st = states.get(c.sheet_id)
        vid = st.sheet.version_id if st is not None else c.version_id
        out.unmatched.append({"correctionId": c.id, "sheetId": c.sheet_id, "versionId": vid, "reason": reason})
        stats["unmatched"] += 1

    def target(c: Correction, st: _SheetState) -> dict[str, Any] | None:
        same_version = c.version_id == st.sheet.version_id
        if same_version and c.detection_id:
            d = st.by_id.get(c.detection_id)
            return d if d is not None and not d.get("_removed") else None
        r = pre.get(c.id)
        if r is not None and r.status in ("matched", "unmatched"):  # Worker-A symbols.rematch
            d = st.by_id.get(r.detection_id) if r.detection_id else None
            if d is None or d.get("_removed"):
                return None
            if not same_version:
                stats["rematched"] += 1
            return d
        anchor = c.anchor
        fam = family(c.cls) if c.kind != "reclassify" else None
        if c.detection_id:
            od = old(c.sheet_id, c.version_id).get(c.detection_id)
            if od is not None:
                anchor = anchor or _center(od)
                fam = family(str(od.get("class"))) or fam
        if anchor is None:
            return None
        d = _nearest(st, anchor, c.radius_mm, fam, strict=fam is not None)
        if d is not None and not same_version:
            stats["rematched"] += 1
        return d

    def resolve_ids(c: Correction, st: _SheetState, ids: tuple[str, ...]) -> list[str] | None:
        res: list[str] = []
        for i in ids:
            if c.version_id == st.sheet.version_id:
                d = st.by_id.get(i)
                if d is None or d.get("_removed"):
                    return None
                res.append(i)
                continue
            od = old(c.sheet_id, c.version_id).get(i)
            if od is None:
                return None
            if _wa_rematch_ids is not None:
                nid = _wa_rematch_ids([i], [od], st.live(), radius_mm=c.radius_mm).get(i)
                d = st.by_id.get(nid) if nid and nid not in res else None
            else:
                d = _nearest(st, _center(od), c.radius_mm, family(str(od.get("class"))), strict=True, exclude=set(res))
            if d is None:
                return None
            res.append(str(d["id"]))
            stats["rematched"] += 1
        return res

    for c in corrections:
        st = states.get(c.sheet_id)
        if c.kind == "count" and not c.item_code and c.cls and st is not None:
            for k, at in enumerate(c.geometry or ((c.anchor,) if c.anchor else ())):
                _add(replace(c, id=f"{c.id}_{k + 1}" if k else c.id, geometry=(at,)), st, stats, c.id)
            st.changed = True
            stats["applied"] += 1
            out.applied.append(c.id)
            continue
        if c.kind in ("measure", "count"):
            mq = _manual_qty(c, st)
            if mq is None:
                unmatched(c, U_INVALID if st is not None or c.quantity is None else U_NO_SHEET)
                continue
            out.manual.append(mq)
            stats["manual"] += 1
            stats["applied"] += 1
            out.applied.append(c.id)
            continue
        if st is None:
            unmatched(c, U_NO_SHEET)
            continue
        if c.kind == "add":
            hit = pre.get(c.id)
            hint = hit.detection_id if hit is not None and hit.status == "already_detected" else None
            ok = _add(c, st, stats, auto_id=hint)
            if not ok:
                unmatched(c, U_INVALID)
                continue
        elif c.kind in ("accept", "reject", "remove") and not c.detection_id and c.link_group_id:
            g = st.group(c)
            if g is None:
                unmatched(c, U_NO_GROUP)
                continue
            if c.kind == "accept":
                g["confidence"], g["level"], g["reasons"] = 1.0, "green", []
            else:
                st.groups = [x for x in st.groups or [] if x is not g]
        elif c.kind in ("accept", "reject") and not c.detection_id and c.room_id:
            room = st.room(c)
            if room is None:
                unmatched(c, U_NO_TARGET)
                continue
            if c.kind == "accept":
                room["level"], room["reasons"] = "green", []
            else:
                room["_rejected"] = c.id
        elif c.kind == "unlink" and not (c.switch_ids or c.point_ids):
            g = st.group(c)
            if g is None:
                unmatched(c, U_NO_GROUP)
                continue
            st.groups = [x for x in st.groups or [] if x is not g]
        elif c.kind in ("link", "unlink"):
            sw = resolve_ids(c, st, c.switch_ids)
            pts = resolve_ids(c, st, c.point_ids)
            if sw is None or pts is None or not (sw or pts):
                unmatched(c, U_NO_TARGET)
                continue
            g = st.group(c)
            if c.link_group_id and g is None:
                unmatched(c, U_NO_GROUP)
                continue
            if not _relink(c, st, sw, pts, g):
                unmatched(c, U_NO_GROUP)
                continue
        else:
            d = target(c, st)
            if d is None:
                unmatched(c, U_NO_TARGET)
                continue
            if c.kind in ("remove", "reject"):
                d["_removed"] = c.id
            elif c.kind == "accept":
                d["level"], d["reasons"], d["_verified"] = "green", [R_ACCEPTED], c.id
            elif c.kind == "reclassify":
                if not c.cls and not c.item_code:
                    unmatched(c, U_INVALID)
                    continue
                if c.cls:
                    d["class"] = c.cls
                    d["_userClass"] = True
                if c.item_code:
                    d["_itemCode"], d["_codeRule"] = c.item_code, f"corr_{c.id}"
                d["level"], d["reasons"], d["_verified"] = "green", [R_RECLASSED], c.id
            elif c.kind == "move":
                if not c.geometry:
                    unmatched(c, U_INVALID)
                    continue
                at = c.geometry[0]
                ox, oy = _center(d)
                d["centerMm"] = {"x": at[0], "y": at[1]}
                bb = d.get("bboxMm")
                if isinstance(bb, dict):
                    d["bboxMm"] = {**bb, "x": _num(bb.get("x")) + at[0] - ox, "y": _num(bb.get("y")) + at[1] - oy}
                d["roomId"] = st.room_at(*at)
                d["_correctionId"] = c.id
        st.changed = True
        stats["applied"] += 1
        out.applied.append(c.id)
    out.sheets = [states[s.sheet_id].finish() for s in sheets]
    out.stats = stats
    return out


def _add(c: Correction, st: _SheetState, stats: dict[str, int], origin: str | None = None, auto_id: str | None = None) -> bool:
    at = c.geometry[0] if c.geometry else c.anchor
    if at is None or not (c.cls or c.item_code):
        return False
    if c.version_id != st.sheet.version_id and c.cls:
        auto = st.by_id.get(auto_id) if auto_id else _nearest(st, at, c.radius_mm, family(c.cls), strict=True)
        if auto is not None and auto.get("_removed"):
            auto = None
        if auto is not None and not str(auto.get("id")).startswith("m_"):
            auto["level"], auto["reasons"], auto["_verified"] = "green", [R_ACCEPTED], c.id
            if auto.get("class") != c.cls:
                auto["class"], auto["_userClass"] = c.cls, True
            stats["addMatchedAuto"] += 1
            return True
    did = f"m_{c.id}"[:128]
    d = {
        "id": did,
        "class": c.cls or "manual",
        "legendEntryId": None,
        "centerMm": {"x": at[0], "y": at[1]},
        "bboxMm": {"x": at[0] - 2.0, "y": at[1] - 2.0, "w": 4.0, "h": 4.0},
        "score": 1.0,
        "level": "green",
        "reasons": [R_ADDED],
        "roomId": c.room_id or st.room_at(*at),
        "floor": c.floor or st.floor_at(*at),
        "lifecycle": "new",
        "supply": None,
        "annotations": [],
        "_source": "manual",
        "_correctionId": origin or c.id,
        "_userClass": bool(c.cls),
        "_verified": c.id,
    }
    if c.item_code:
        d["_itemCode"], d["_codeRule"] = c.item_code, f"corr_{c.id}"
    st.dets = [x for x in st.dets if x.get("id") != did] + [d]
    st.by_id[did] = d
    return True


def _group_kind(n_switches: int, n_points: int, current: str | None) -> str:
    if n_switches == 0:
        return "sensor"
    if current == "add_to_existing":
        return current
    if n_switches >= 2:
        return "two_way"
    return "single" if n_points <= 1 else "shared"


def _relink(c: Correction, st: _SheetState, sw: list[str], pts: list[str], named: dict[str, Any] | None) -> bool:
    if st.groups is None:
        st.groups = []
    ids = set(sw) | set(pts)
    if c.kind == "unlink":
        groups = [g for g in st.groups if (named is None or g is named) and ids & (set(g["switchIds"]) | set(g["luminaireIds"]))]
        if not groups:
            return False
        for g in groups:
            g["switchIds"] = [i for i in g["switchIds"] if i not in ids]
            g["luminaireIds"] = [i for i in g["luminaireIds"] if i not in ids]
            g["pointIds"] = list(g["luminaireIds"])
            _human(g)
        st.groups = [g for g in st.groups if g["switchIds"] or (g["kind"] == "sensor" and g["luminaireIds"])]
        return True
    target = named
    for g in st.groups:  # the items leave their current groups
        if g is target:
            continue
        g["switchIds"] = [i for i in g["switchIds"] if i not in ids]
        g["luminaireIds"] = [i for i in g["luminaireIds"] if i not in ids]
        g["pointIds"] = [p for p in g["pointIds"] if p not in ids]
    st.groups = [g for g in st.groups if g is target or g["switchIds"] or (g["kind"] == "sensor" and g["luminaireIds"])]
    if target is None:
        gid = f"lk_m_{c.id}"[:128]
        target = {"id": gid, "switchIds": [], "pointIds": [], "luminaireIds": [], "kind": "single", "confidence": 1.0,
                  "level": "green", "reasons": [], "floor": None, "fan": False, "inferredSwitches": 0, "arcIds": []}  # fmt: skip
        st.groups.append(target)
    target["switchIds"] = list(dict.fromkeys([*target["switchIds"], *sw]))
    target["luminaireIds"] = list(dict.fromkeys([*target["luminaireIds"], *pts]))
    target["pointIds"] = list(target["luminaireIds"])
    _human(target)
    return True


def _human(g: dict[str, Any]) -> None:
    g["kind"] = _group_kind(len(g["switchIds"]), len(g["luminaireIds"]), g.get("kind"))
    g["confidence"], g["level"], g["reasons"] = 1.0, "green", []


def _manual_qty(c: Correction, st: _SheetState | None) -> ManualQty | None:
    if not (c.item_code or c.cls):
        return None
    unit = c.unit
    qty = c.quantity
    if qty is None and c.kind == "measure" and st is not None and c.geometry:
        k = float(st.sheet.scale or 50) / 1000.0  # paper mm → m
        if c.geometry_type == "polygon" and len(c.geometry) >= 3:
            qty, unit = _poly_area(c.geometry) * k * k, unit or 'מ"ר'
        elif len(c.geometry) >= 2:
            qty, unit = _poly_len(c.geometry) * k, unit or 'מ"א'
    if qty is None and c.kind == "count" and c.geometry:
        qty = float(len(c.geometry))
    if qty is None or qty < 0:
        return None
    at = c.anchor or (c.geometry[0] if c.geometry else (0.0, 0.0))
    floor = c.floor or (st.floor_at(*at) if st is not None else None)
    room = c.room_id or (st.room_at(*at) if st is not None else None)
    vid = st.sheet.version_id if st is not None else c.version_id
    pts = c.geometry if c.kind == "count" and c.geometry else (at,)
    return ManualQty(c, c.sheet_id, vid, round(qty, 4), unit, c.item_code, c.cls, floor, room, at, pts)
