"""Tiling + waterproofing (chapter 05) from the canonical rooms + ``roomSettings`` — pure.

Effective settings of a room = its ``roomSettings`` doc (mapped onto the canonical room, :mod:`.spaces`) or, without
one, contracts ``defaultRoomSettings(type, wet)`` (:func:`default_settings`: bathroom / wc / wet → cladding 2.6 m,
floor tiled, waterproofed; courtyard → floor tiled; others nothing). A doc's ``type`` overrides the room type.

Rules (contracts kinds; per room and measure the first rule by priority whose ``roomTypes`` include the room type,
else — the user set a measure on a room of another type — the first rule of that measure with
``שיוך לפריט לפי כלל ברירת מחדל``):

* ``tiling_floor``    rooms with ``floorTiled`` (``wetOnly``: wet rooms, or a user doc that says so): area m²;
* ``tiling_cladding`` ``mode: full`` — rooms with ``claddingHeightM`` h > 0: perimeter × h − openings
  (``subtractOpenings``; not ``keepOpenings``): doors / plain openings width × min(height ?? defaultDoorHeightM, h),
  windows only below h: width × max(0, min(h, sill + (height ?? defaultWindowHeightM)) − sill), sill 1.0 m
  (:class:`TilingParams`). No openings in the rooms artifact → one default door (0.8 m) is subtracted,
  ``פתחים לא זוהו — הופחתה דלת ברירת מחדל``. ``mode: partial`` — Σ (toM − fromM) × heightM of ``partialCladding``;
* ``tiling_corner``   rooms with full cladding: externalCorners × h (m'); unknown corners → qty 0 +
  ``פינות חיצוניות לא זוהו``;
* ``waterproofing``   1 (קומפלט) per room with ``includeInWaterproofing`` (``wetOnly`` as for floors).

Sprint-4 integration defaults (Data/QA back-solved them from the sample BOQ; a user's settings doc always wins):

* default cladding height = min(2.6 m, the room's ceiling) — ceiling from a level mark "-2.55 H=220" inside the room
  (:func:`.spaces.ceiling_heights`; none → 2.6 m);
* windows: sill 1.0 m, head ≤ 2.1 m (``window_head_m``: the cladding stops at the window head even when the rule's
  ``defaultWindowHeightM`` would put it higher); doors 2.1 m;
* waterproofing by default only for rooms with a shower or bath (fixtures of any sheet mapped onto the canonical
  room); a floor without any fixture information keeps the type default.

Item: the room's ``floorMaterialItemCode`` (floor) / ``wallMaterialItemCode`` (cladding) when set, else the rule's.
``orderQty`` = qty × (1 + waste) on material lines (rules with a ``wasteFactor``; the room doc's ``wasteFactor``
wins). Level: a room that is not closed / not (surely) named caps the unit at yellow; a room without a
user-confirmed settings doc adds ``הגדרות חדר לפי ברירת מחדל`` (a rule reason → ≤ yellow). So a tiling line can only
be green when all its rooms are closed, named and their settings were confirmed by a user.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from .rules import (
    R_DEFAULT_OPENINGS,
    R_DEFAULT_RULE,
    R_NO_CORNERS,
    R_ROOM_DEFAULTS,
    R_ROOM_OPEN,
    R_ROOM_UNNAMED,
    TILING_KINDS,
    Rule,
)
from .spaces import ROOM_TYPES, WET_TYPES, Room
from .units import Unit, room_det

UNNAMED_REASONS = frozenset({R_ROOM_UNNAMED, "ללא שם"})
DEFAULT_WASTE_FACTOR = 0.07  # contracts DEFAULT_WASTE_FACTOR


@dataclass(frozen=True)
class TilingParams:
    door_height_m: float = 2.1
    default_door_width_m: float = 0.8
    window_sill_m: float = 1.0
    window_height_m: float = 1.2
    window_head_m: float = 2.1  # the cladding never goes above the window head


DEFAULT_CLADDING_HEIGHT_M = 2.6  # contracts DEFAULT_CLADDING_HEIGHT_M


def default_settings(
    rtype: str | None,
    wet: bool | None,
    *,
    ceiling_m: float | None = None,
    niche: bool = False,
    has_shower_or_bath: bool | None = None,
) -> dict[str, Any]:
    """Mirror of contracts ``defaultRoomSettings(type, wet, {ceilingHeightM, niche, hasShowerOrBath})``: wet rooms
    clad to min(2.6 m, ceiling), floor tiled, waterproofed only with a shower / bath (unknown → bathroom yes, wc no);
    a niche → floor tiled only; courtyard → floor tiled (the v5 floor rule still excludes it by type)."""
    base: dict[str, Any] = {
        "claddingHeightM": 0.0,
        "floorTiled": False,
        "floorMaterialItemCode": None,
        "wallMaterialItemCode": None,
        "partialCladding": [],
        "wasteFactor": DEFAULT_WASTE_FACTOR,
        "includeInWaterproofing": False,
    }
    ceil = ceiling_m if ceiling_m else None
    if niche:
        return {**base, "floorTiled": True, **({"ceilingHeightM": ceil} if ceil else {})}
    if rtype in ("bathroom", "wc") or (rtype in (None, "other") and wet is True):
        clad = min(DEFAULT_CLADDING_HEIGHT_M, ceil) if ceil else DEFAULT_CLADDING_HEIGHT_M
        waterproof = has_shower_or_bath if has_shower_or_bath is not None else rtype != "wc"
        return {
            **base,
            "claddingHeightM": clad,
            "floorTiled": True,
            "includeInWaterproofing": waterproof,
            **({"ceilingHeightM": ceil} if ceil else {}),
        }
    if rtype == "courtyard":
        return {**base, "floorTiled": True}
    return base


@dataclass
class Settings:
    type: str
    wet: bool
    cladding_h: float
    floor_tiled: bool
    waterproof: bool
    floor_item: str | None
    wall_item: str | None
    partial: list[tuple[float, float]]  # (length m, height m)
    waste: float
    keep_openings: frozenset[str]
    explicit: bool  # a settings doc exists
    confirmed: bool  # … and a user saved it (``by``)
    ceiling: float | None = None  # room ceiling (settings doc > rooms artifact > level mark)
    niche: bool = False
    fixtures: frozenset[str] | None = None  # fixture classes mapped into the room (None = unknown)


def _f(v: Any, default: float = 0.0) -> float:
    return float(v) if isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v) else default


WATERPROOF_FIXTURES = frozenset({"fixture_shower", "fixture_bath"})


def effective_settings(
    room: Room,
    doc: tuple[str, dict[str, Any]] | None,
    *,
    ceiling_m: float | None = None,
    fixtures: frozenset[str] | None = None,
) -> Settings:
    """``ceiling_m``: the room's ceiling from a level mark (the settings doc's / rooms artifact's ``ceilingHeightM``
    win). ``fixtures``: fixture classes mapped into the room (None = no fixture information on its floor)."""
    d = doc[1] if doc else {}
    rtype = str(d["type"]) if d.get("type") in ROOM_TYPES else room.type
    wet = room.wet or rtype in WET_TYPES
    ceil = _f(d.get("ceilingHeightM")) or room.ceiling_m or ceiling_m or None
    shower_or_bath = bool(fixtures & WATERPROOF_FIXTURES) if fixtures is not None else None
    base = default_settings(rtype, wet, ceiling_m=ceil, niche=room.niche, has_shower_or_bath=shower_or_bath)
    base.pop("ceilingHeightM", None)
    eff = {**base, **{k: v for k, v in d.items() if k in base}}
    partial: list[tuple[float, float]] = []
    for p in eff.get("partialCladding") or []:
        if isinstance(p, dict):
            length = _f(p.get("toM")) - _f(p.get("fromM"))
            ph = _f(p.get("heightM"))
            if length > 0 and ph > 0:
                partial.append((length, ph))
    return Settings(
        rtype,
        wet,
        max(_f(eff.get("claddingHeightM")), 0.0),
        bool(eff.get("floorTiled")),
        bool(eff.get("includeInWaterproofing")),
        str(eff["floorMaterialItemCode"]) if eff.get("floorMaterialItemCode") else None,
        str(eff["wallMaterialItemCode"]) if eff.get("wallMaterialItemCode") else None,
        partial,
        min(max(_f(eff.get("wasteFactor"), DEFAULT_WASTE_FACTOR), 0.0), 0.5),
        frozenset(str(o) for o in d.get("keepOpenings") or []),
        doc is not None,
        bool(doc and d.get("by")),
        ceil,
        room.niche,
        fixtures,
    )


def opening_deduction(room: Room, h: float, m: dict[str, Any], s: Settings, params: TilingParams) -> tuple[float, bool]:
    """(m² to subtract below cladding height h, a default door was assumed)."""
    door_h = _f(m.get("defaultDoorHeightM"), params.door_height_m)
    win_h = _f(m.get("defaultWindowHeightM"), params.window_height_m)
    sill_d = _f(m.get("defaultWindowSillM"), params.window_sill_m)
    head_d = _f(m.get("defaultWindowHeadM")) or None
    if room.openings is None:
        return params.default_door_width_m * min(door_h, h), True
    total = 0.0
    for o in room.openings:
        w = _f(o.get("widthM"))
        if w <= 0 or str(o.get("id")) in s.keep_openings:
            continue
        oh = _f(o.get("heightM"))
        if o.get("kind") == "window":
            sill = _f(o.get("sillM"), sill_d)
            if oh:
                head = sill + oh
            elif head_d is not None:
                head = head_d
            else:
                head = min(sill + win_h, params.window_head_m)
            total += w * max(0.0, min(h, head) - sill)
        else:
            total += w * min(oh or door_h, h)
    return total, False


def _height(s: Settings, m: dict[str, Any]) -> float:
    """Effective cladding height: the settings' height, capped at the room ceiling when the rule says so."""
    h = s.cladding_h
    if h > 0 and s.ceiling and m.get("capAtCeiling"):
        h = min(h, s.ceiling)
    return h


def _pick(rules: list[Rule], room_type: str, niche: bool = False) -> tuple[Rule | None, bool]:
    """First rule (priority order) whose roomTypes include the type (a niche passes rules with ``includeNiches``);
    else the first rule (fallback=True — used only when the user's settings doc asks for that measure)."""
    for r in rules:
        types = r.match.get("roomTypes")
        if not types or room_type in types or (niche and r.match.get("includeNiches")):
            return r, False
    return (rules[0], True) if rules else (None, False)


def tiling_units(
    rules: list[Rule],
    rooms: list[Room],
    settings: dict[str, tuple[str, dict[str, Any]]],
    params: TilingParams | None = None,
    *,
    ceilings: dict[str, float] | None = None,
    room_fixtures: dict[str, frozenset[str]] | None = None,
    fixture_floors: set[str] | None = None,
) -> tuple[list[Unit], dict[str, Any]]:
    """``ceilings`` {room key: m}; ``room_fixtures`` {room key: classes}; ``fixture_floors``: floors with fixture
    information (rooms on other floors keep the type defaults)."""
    params = params or TilingParams()
    ceilings = ceilings or {}
    room_fixtures = room_fixtures or {}
    fixture_floors = fixture_floors or set()
    tr = [r for r in rules if r.kind in TILING_KINDS]
    groups = {
        "floor": [r for r in tr if r.kind == "tiling_floor"],
        "full": [r for r in tr if r.kind == "tiling_cladding" and r.match.get("mode") == "full"],
        "partial": [r for r in tr if r.kind == "tiling_cladding" and r.match.get("mode") == "partial"],
        "corner": [r for r in tr if r.kind == "tiling_corner"],
        "waterproofing": [r for r in tr if r.kind == "waterproofing"],
    }
    units: list[Unit] = []
    counted: set[str] = set()
    eff = {
        r.key: effective_settings(
            r,
            settings.get(r.key),
            ceiling_m=ceilings.get(r.key),
            fixtures=room_fixtures.get(r.key, frozenset()) if r.floor in fixture_floors else None,
        )
        for r in rooms
    }
    for room in rooms:
        s = eff[room.key]
        full_rule, _ = _pick(groups["full"], s.type, s.niche)
        for measure, cands in groups.items():
            rule, fallback = _pick(cands, s.type, s.niche)
            if rule is None or (fallback and not s.explicit):
                continue
            m = rule.match
            qty: float | None = None
            reasons: list[str] = []
            code: str | None = None
            wet_ok = s.wet or s.explicit  # wetOnly: a wet room, or the user said so in its settings
            if measure == "floor" and s.floor_tiled and (not m.get("wetOnly") or wet_ok):
                qty, code = room.area_m2, s.floor_item
            elif measure == "full" and _height(s, m) > 0 and not (s.niche and m.get("excludeNiches")):
                h = _height(s, m)
                gross = room.perimeter_m * h
                sub, default_door = (0.0, False)
                if m.get("subtractOpenings", True):
                    sub, default_door = opening_deduction(room, h, m, s, params)
                qty, code = max(gross - sub, 0.0), s.wall_item
                if default_door:
                    reasons.append(R_DEFAULT_OPENINGS)
            elif measure == "partial" and s.partial:
                qty, code = sum(length * ph for length, ph in s.partial), s.wall_item
            elif measure == "corner" and s.cladding_h > 0 and not s.niche:
                h = _height(s, full_rule.match if full_rule is not None else {})
                if room.external_corners is None:
                    qty = 0.0
                    reasons.append(R_NO_CORNERS)
                else:
                    qty = room.external_corners * h
            elif measure == "waterproofing" and s.waterproof and (not m.get("wetOnly") or wet_ok):
                need = set(m.get("requireFixtureClasses") or [])
                if need and not s.explicit and s.fixtures is not None and not (need & s.fixtures):
                    continue  # default only for rooms holding one of these fixtures; an explicit setting wins
                qty = 1.0
            if qty is None:
                continue
            counted.add(room.key)
            if fallback:
                reasons.append(R_DEFAULT_RULE)
            if not s.confirmed:
                reasons.append(R_ROOM_DEFAULTS)
            level = "green"
            if R_ROOM_OPEN in room.reasons or not room.name or UNNAMED_REASONS & set(room.reasons):
                level = "yellow"
            ev = room_det(room)
            qty = round(qty, 4)
            u = Unit(rule, [(ev, None)], qty, reasons, level, floor=room.floor, ev_qty={ev.key: qty})
            if code:
                u.user_code = (code, rule.id)
            if rule.waste_factor is not None:
                waste = s.waste if s.explicit else rule.waste_factor
                u.order_qty, u.waste = round(qty * (1 + waste), 4), waste
            units.append(u)
    return units, {"rooms": len(counted), "confirmedRooms": sum(1 for s in eff.values() if s.confirmed)}
