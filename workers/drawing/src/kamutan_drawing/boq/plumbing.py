"""Plumbing points (chapter 03) and one-off suggestions — pure.

``plumbing_point`` rules (contracts ``PlumbingPointMatchSchema``), highest priority first, each fixture counted by
the first rule it matches:

* ``fixtureClasses`` — the fixture's class;
* ``floors`` — the fixture's floor; ``roomTypes`` / ``roomNamePatterns`` (substrings) — its room (the rooms artifact
  of its own sheet). A fixture outside every room passes the room filters with ``פריט מחוץ לחדר`` (yellow) instead of
  silently becoming unmapped;
* ``withFaucetClasses`` — a faucet of those classes within ``faucetRadiusMm`` (real-world mm → paper mm with the
  sheet scale; default 600) on the same sheet and not in another room; ``withoutFaucetClasses`` — none of those.
  A basin counted by a ``withoutFaucetClasses`` rule with no faucet at all next to it gets ``סוג ברז לפי ברירת
  מחדל`` (the flower faucet is an assumption). Faucets only qualify basins: they are never counted themselves;
* ``perRoom`` — one unit per (rule, room) holding ≥ 1 matching fixture (shower / bath per bathroom; the default
  rules map the basement shower to 3.13 by ``floors``). Fixtures without a room: one unit each.

Existing / demolished fixtures are not new work and are skipped (like class → item). A fixture of a class some
plumbing rule covers but that no rule matches is reported as unmatched (red, ``אין כלל שיוך לסוג זה``).

``one_off_suggestion`` rules (contracts ``OneOffSuggestionMatchSchema``): one unit of ``quantity`` when ANY trigger
fires — ``always``, a live detection of ``classes``, a sheet text containing one of ``textPatterns``, a canonical
room of ``roomTypes`` — every trigger restricted to ``floors`` when given. Always ≤ yellow with the rule's reason
(``הצעה – לאשר ידנית``); evidence = the first cue (detection or room).
"""

from __future__ import annotations

import math
import re
from collections import defaultdict
from typing import Any

from .dedup import Det
from .rules import (
    CLASS_HE,
    NOT_NEW_LIFECYCLES,
    R_DEFAULT_FAUCET,
    R_NO_ROOM,
    R_NO_RULE,
    R_TEMPLATE,
    Rule,
)
from .spaces import Room
from .units import Unit, room_det

DEFAULT_FAUCET_RADIUS_MM = 600.0
DEFAULT_SCALE = 50
FAUCET_CLASSES = frozenset({"faucet_basin", "faucet_wall"})


def _live(d: Det) -> bool:
    return d.dropped_by is None and d.lifecycle not in NOT_NEW_LIFECYCLES


def _dist(a: Det, b: Det) -> float:
    return math.hypot(a.x - b.x, a.y - b.y)


def consumed_classes(rules: list[Rule]) -> set[str]:
    """Classes handled by the plumbing rules (not class → item)."""
    out: set[str] = set()
    for r in rules:
        if r.kind == "plumbing_point":
            out |= {str(c) for c in r.match.get("fixtureClasses") or []}
            out |= {str(c) for k in ("withFaucetClasses", "withoutFaucetClasses") for c in r.match.get(k) or []}
    return out


def _match(r: Rule, f: Det, room: Room | None, faucets: list[Det], scale: int | None) -> tuple[bool, list[str]]:
    m = r.match
    if f.cls not in (m.get("fixtureClasses") or []):
        return False, []
    reasons: list[str] = []
    floors = m.get("floors")
    if floors and f.floor not in floors:
        return False, []
    types, pats = m.get("roomTypes"), m.get("roomNamePatterns")
    if types or pats:
        if room is None:
            reasons.append(R_NO_ROOM)
        else:
            if types and room.type not in types:
                return False, []
            if pats and not any(str(p) in (room.name or "") for p in pats):
                return False, []
    with_, without = m.get("withFaucetClasses"), m.get("withoutFaucetClasses")
    if with_ or without:
        thr = float(m.get("faucetRadiusMm") or DEFAULT_FAUCET_RADIUS_MM) / float(scale or DEFAULT_SCALE)
        near = [
            x
            for x in faucets
            if x.sheet_id == f.sheet_id
            and _dist(f, x) <= thr
            and (f.room_id is None or x.room_id is None or f.room_id == x.room_id)
        ]
        if with_ and not any(x.cls in with_ for x in near):
            return False, []
        if without and any(x.cls in without for x in near):
            return False, []
        if without and not with_ and not near:
            reasons.append(R_DEFAULT_FAUCET)
    return True, reasons


def plumbing_units(
    dets: list[Det],
    rules: list[Rule],
    rooms: dict[tuple[str, str], Room],
    scales: dict[str, int | None],
) -> tuple[list[Unit], dict[str, Any]]:
    prules = [r for r in rules if r.kind == "plumbing_point"]
    fixture_classes = {str(c) for r in prules for c in r.match.get("fixtureClasses") or []}
    live = sorted((d for d in dets if _live(d)), key=lambda d: d.key)
    faucets = [d for d in dets if d.dropped_by is None and d.cls in FAUCET_CLASSES]
    units: list[Unit] = []
    per_room: dict[tuple[str, str, str], list[tuple[Det, list[str]]]] = defaultdict(list)
    rule_by_id = {r.id: r for r in prules}
    stats: dict[str, Any] = {"fixtures": 0, "roomUnits": 0, "unmatchedFixtures": 0}
    for f in live:
        if f.cls not in fixture_classes:
            continue
        room = rooms.get((f.sheet_id, f.room_id)) if f.room_id else None
        hit: tuple[Rule, list[str]] | None = None
        for r in prules:
            ok, reasons = _match(r, f, room, faucets, scales.get(f.sheet_id))
            if ok:
                hit = (r, reasons)
                break
        stats["fixtures"] += 1
        if hit is None:
            stats["unmatchedFixtures"] += 1
            u = Unit(None, [(f, None)], 1.0, [R_NO_RULE], "red")
            u.unmatched = ("X-" + re.sub(r"[^A-Za-z0-9]+", "-", f.cls).strip("-"), CLASS_HE.get(f.cls, f.cls))
            units.append(u)
            continue
        r, reasons = hit
        if r.match.get("perRoom") and f.room_id:
            per_room[(r.id, f.sheet_id, f.room_id)].append((f, reasons))
        else:
            units.append(Unit(r, [(f, None)], 1.0, list(reasons)))
    for (rid, _sid, _room), members in sorted(per_room.items()):
        reasons = list(dict.fromkeys(x for _, rs in members for x in rs))
        units.append(Unit(rule_by_id[rid], [(d, None) for d, _ in members], 1.0, reasons))
        stats["roomUnits"] += 1
    return units, stats


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s.replace("״", '"').replace("׳", "'")).strip()


def suggestion_units(
    rules: list[Rule],
    dets: list[Det],
    canon: list[Room],
    texts: dict[str, list[str]],
    sheet_floors: dict[str, list[str]],
) -> list[Unit]:
    live = sorted((d for d in dets if _live(d)), key=lambda d: d.key)
    out: list[Unit] = []
    for r in (x for x in rules if x.kind == "one_off_suggestion"):
        m = r.match
        fl = {str(f) for f in m.get("floors") or []}
        cue: list[Det] = []
        text_floor: str | None = None
        fired = bool(m.get("always"))
        cls = {str(c) for c in m.get("classes") or []}
        if cls:
            hits = [d for d in live if d.cls in cls and (not fl or d.floor in fl)]
            if hits:
                fired = True
                cue.append(hits[0])
        pats = [_norm(str(p)) for p in m.get("textPatterns") or [] if p]
        if pats and not cue:
            for sid in sorted(texts):
                if fl and not fl & set(sheet_floors.get(sid) or []):
                    continue
                if any(p in _norm(t) for t in texts[sid] for p in pats):
                    fired = True
                    floors = [f for f in sheet_floors.get(sid) or [] if not fl or f in fl]
                    text_floor = floors[0] if floors else None
                    break
        types = {str(t) for t in m.get("roomTypes") or []}
        if types:
            rh = [x for x in canon if x.type in types and (not fl or x.floor in fl)]
            if rh:
                fired = True
                if not cue:
                    cue.append(room_det(rh[0]))
        if not fired:
            continue
        qty = float(m.get("quantity") or 1)
        reasons = [] if R_TEMPLATE in r.reasons else [R_TEMPLATE]
        out.append(Unit(r, [(d, None) for d in cue[:1]], qty, reasons, "yellow", floor=text_floor, ignore_member_levels=True))
    return out
