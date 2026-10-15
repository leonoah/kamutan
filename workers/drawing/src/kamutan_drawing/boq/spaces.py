"""Rooms for the BOQ (Sprint 4): room types, the canonical room set per floor, ``roomSettings`` lookup.

Rooms are drawn on several sheets of a floor (construction, architecture, plumbing, electrical…). Tiling needs one
room per physical room: per floor, the rooms of the most authoritative sheet that has rooms on that floor
(:data:`ROOM_SOURCE_ORDER`; demolition sheets show the old state and never count). A ``roomSettings`` doc is keyed
``{sheetId}__{roomId}`` of whatever sheet the user edited it on; it is mapped onto the canonical room of the same
floor with the most similar area (± 15 %) and name (:func:`match_room`).

Room fields from Worker-B (``type``, ``wet``, ``walls``, ``openings``, ``externalCorners``) are optional here: a
missing ``type`` is inferred from the name (:func:`infer_type`), missing openings / corners are reported by the
tiling rules.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any

from .rules import similarity

ROOM_TYPES = (
    "bathroom",
    "wc",
    "kitchen",
    "bedroom",
    "living",
    "corridor",
    "balcony",
    "courtyard",
    "storage",
    "stairs",
    "other",
)
WET_TYPES = frozenset({"bathroom", "wc"})
# best first; demolition / other kinds are not room sources for the BOQ
ROOM_SOURCE_ORDER = ("construction", "architecture", "architecture_master", "plumbing", "electrical", "lighting")

# name keywords → type, first match wins (order matters: "חדר רחצה" before "חדר")
_TYPE_WORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("courtyard", ("חצר אנגלית", "חצר")),
    ("bathroom", ("רחצה", "מקלחת", "אמבטיה")),
    ("wc", ("שירותים", "שרותים", "ש.אורחים")),
    ("kitchen", ("מטבח",)),
    ("stairs", ("מדרגות", "חדר מדרגות")),
    ("balcony", ("מרפסת",)),
    ("corridor", ("מסדרון", "פרוזדור", "כניסה", "מבואה")),
    ("storage", ("מחסן", "ארונות", "כביסה", "שירות")),
    ("bedroom", ("שינה", "הורים", "ילדים", "עבודה", 'ממ"ד', "ממ״ד")),
    ("living", ("סלון", "מגורים", "אוכל", "טלויזיה", "משחקים", "משפחה")),
)


def infer_type(name: str | None) -> str:
    """Room type from its (OCR) name; "A / B" names take the first part that names a type."""
    if not name:
        return "other"
    for part in [p.strip() for p in name.split("/")]:
        for t, words in _TYPE_WORDS:
            if any(w in part for w in words):
                return t
    return "other"


@dataclass
class Room:
    sheet_id: str
    version_id: str
    id: str
    name: str | None
    type: str
    wet: bool
    floor: str | None
    area_m2: float
    perimeter_m: float
    level: str
    reasons: list[str]
    discipline: str
    center: tuple[float, float] = (0.0, 0.0)
    walls: list[dict[str, Any]] = field(default_factory=list)
    openings: list[dict[str, Any]] | None = None  # None = not provided by the rooms artifact
    external_corners: int | None = None
    polygon: list[tuple[float, float]] = field(default_factory=list)
    type_inferred: bool = False
    ceiling_m: float | None = None  # contracts Room.ceilingHeightM (optional)
    niche: bool = False  # contracts Room.niche (optional): a washing-machine alcove of the adjoining room

    @property
    def key(self) -> str:
        return f"{self.sheet_id}__{self.id}"

    def contains(self, x: float, y: float) -> bool:
        inside = False
        pts = self.polygon
        for i in range(len(pts)):
            (ax, ay), (bx, by) = pts[i], pts[(i + 1) % len(pts)]
            if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / ((by - ay) or 1e-12) + ax:
                inside = not inside
        return inside


def room_from_doc(sheet_id: str, version_id: str, discipline: str, d: dict[str, Any]) -> Room | None:
    rid = d.get("id")
    if not isinstance(rid, str) or not rid:
        return None
    name = d.get("name") if isinstance(d.get("name"), str) else None
    t = d.get("type")
    inferred = t not in ROOM_TYPES
    rtype = infer_type(name) if inferred else str(t)
    wet = bool(d["wet"]) if isinstance(d.get("wet"), bool) else rtype in WET_TYPES
    poly = [(float(p.get("x", 0)), float(p.get("y", 0))) for p in d.get("polygonMm") or [] if isinstance(p, dict)]
    cx = sum(p[0] for p in poly) / len(poly) if poly else 0.0
    cy = sum(p[1] for p in poly) / len(poly) if poly else 0.0
    openings = d.get("openings")
    corners = d.get("externalCorners")
    return Room(
        sheet_id,
        version_id,
        rid,
        name,
        rtype,
        wet,
        str(d["floor"]) if d.get("floor") else None,
        _num(d.get("areaM2")),
        _num(d.get("perimeterM")),
        str(d.get("level") or "yellow"),
        [str(r)[:64] for r in (d.get("reasons") or [])],
        discipline,
        (cx, cy),
        [w for w in (d.get("walls") or []) if isinstance(w, dict)],
        [o for o in openings if isinstance(o, dict)] if isinstance(openings, list) else None,
        int(corners) if isinstance(corners, int | float) and corners >= 0 else None,
        poly,
        inferred,
        _num(d.get("ceilingHeightM")) or None,
        d.get("niche") is True,
    )


def _num(v: Any) -> float:
    return float(v) if isinstance(v, int | float) and math.isfinite(v) else 0.0


def canonical_rooms(rooms_by_sheet: dict[str, list[Room]]) -> list[Room]:
    """Per floor: the rooms of the best room-source sheet having rooms on that floor (ties: more rooms, sheet id)."""
    by_floor: dict[str, dict[str, list[Room]]] = {}
    for sid, rooms in rooms_by_sheet.items():
        for r in rooms:
            if r.floor and r.discipline in ROOM_SOURCE_ORDER:
                by_floor.setdefault(r.floor, {}).setdefault(sid, []).append(r)
    out: list[Room] = []
    for floor in sorted(by_floor):
        cands = by_floor[floor]
        best = min(cands, key=lambda s: (ROOM_SOURCE_ORDER.index(cands[s][0].discipline), -len(cands[s]), s))
        out.extend(sorted(cands[best], key=lambda r: r.id))
    return out


def match_room(r: Room, canon: list[Room]) -> Room | None:
    """The canonical room that is the same physical room as ``r`` (same floor, area within 15 %, best name)."""
    best: tuple[float, str, Room] | None = None
    for c in canon:
        if c.floor != r.floor:
            continue
        if c.sheet_id == r.sheet_id and c.id == r.id:
            return c
        a, b = max(c.area_m2, 1e-6), max(r.area_m2, 1e-6)
        ratio = min(a, b) / max(a, b)
        if ratio < 0.85:
            continue
        name_s = similarity(c.name or "", r.name or "") if (c.name and r.name) else 0.5
        type_s = 1.0 if c.type == r.type else 0.0
        score = ratio + name_s + type_s
        if best is None or (score, c.key) > (best[0], best[1]):
            best = (score, c.key, c)
    return best[2] if best else None


def settings_by_room(
    settings: dict[str, dict[str, Any]], rooms_by_sheet: dict[str, list[Room]], canon: list[Room]
) -> dict[str, tuple[str, dict[str, Any]]]:
    """``{canonical room key: (settings doc id, doc)}``. A doc on the canonical room itself wins; otherwise the
    most recent (``at``, then doc id) of the docs mapped onto it."""
    index = {r.key: r for rooms in rooms_by_sheet.values() for r in rooms}
    out: dict[str, tuple[str, dict[str, Any]]] = {}
    for doc_id in sorted(settings):
        doc = settings[doc_id]
        r = index.get(doc_id)
        if r is None:
            continue
        c = match_room(r, canon)
        if c is None:
            continue
        cur = out.get(c.key)
        own = doc_id == c.key
        if cur is None or own or (cur[0] != c.key and str(doc.get("at") or "") >= str(cur[1].get("at") or "")):
            out[c.key] = (doc_id, doc)
    return out


# level mark "-2.55 H=220" / "±0.00 H=265" (one line, or the H= line stacked under the level): ceiling height in cm
_LEVEL = re.compile(r"[±+\-]?\s*\d{1,2}\.\d{2}")
_CEIL = re.compile(r"H\s*=\s*(\d{3})(?!\d)")
CEILING_RANGE_M = (2.0, 4.0)
LEVEL_STACK_MM = 6.0


def _bbox(t: dict[str, Any]) -> tuple[float, float, float, float] | None:
    b = t.get("bboxMm", t.get("bbox"))
    if isinstance(b, list | tuple) and len(b) >= 4:
        return float(b[0]), float(b[1]), float(b[2]), float(b[3])
    if isinstance(b, dict):
        return float(b["x"]), float(b["y"]), float(b["x"]) + float(b["w"]), float(b["y"]) + float(b["h"])
    return None


def level_marks(texts: list[dict[str, Any]]) -> list[tuple[float, float, float]]:
    """(x, y, ceiling m) of the level marks of a sheet's text lines: a level ("-2.55", "+2.96") with an "H=265" on
    the same line or on a line stacked right above / below it (≤ 6 mm)."""
    lines = [(str(t.get("text") or ""), b) for t in texts if isinstance(t, dict) and (b := _bbox(t)) is not None]
    out: list[tuple[float, float, float]] = []
    for txt, b in lines:
        m = _CEIL.search(txt)
        if not m:
            continue
        h = int(m.group(1)) / 100.0
        if not (CEILING_RANGE_M[0] <= h <= CEILING_RANGE_M[1]):
            continue
        cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        level_here = bool(_LEVEL.search(txt.replace(m.group(0), "")))
        stacked = any(
            _LEVEL.search(t2)
            and abs((b2[1] + b2[3]) / 2 - cy) <= LEVEL_STACK_MM
            and abs((b2[0] + b2[2]) / 2 - cx) <= LEVEL_STACK_MM * 2
            for t2, b2 in lines
            if b2 is not b
        )
        if level_here or stacked:
            out.append((cx, cy, h))
    return out


def ceiling_heights(
    rooms: list[Room], texts_by_sheet: dict[str, list[dict[str, Any]]], scale: dict[str, int | None]
) -> dict[str, float]:
    """``{room key: ceiling m}`` from the level marks inside a room (or ≤ 0.5 m outside it); when several, the lowest."""
    out: dict[str, float] = {}
    marks = {sid: level_marks(t) for sid, t in texts_by_sheet.items() if t}
    for r in rooms:
        ms = marks.get(r.sheet_id) or []
        if not ms or len(r.polygon) < 3:
            continue
        tol = 500.0 / float(scale.get(r.sheet_id) or 50)
        hs = [h for x, y, h in ms if r.contains(x, y) or _dist_to_poly(r.polygon, x, y) <= tol]
        if hs:
            out[r.key] = min(hs)
    return out


def _dist_to_poly(poly: list[tuple[float, float]], x: float, y: float) -> float:
    best = math.inf
    for i in range(len(poly)):
        (ax, ay), (bx, by) = poly[i], poly[(i + 1) % len(poly)]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 <= 0 else max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / L2))
        best = min(best, math.hypot(ax + t * dx - x, ay + t * dy - y))
    return best
