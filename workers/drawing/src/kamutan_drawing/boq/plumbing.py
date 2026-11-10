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
# the Sprint-4 plumbing rules keep their pre-Sprint-10 behaviour (an unresolved item is a "לא משויך" line)
_S4_PLUMB_IDS = frozenset({
    "r_plumb_ac_drain", "r_plumb_basin_wall_faucet", "r_plumb_basin_flower_faucet", "r_plumb_wc_concealed",
    "r_plumb_washing_machine", "r_plumb_garden_tap", "r_plumb_wc_monoblock", "r_plumb_shower_basement", "r_plumb_shower",
    "r_plumb_bath",
})  # fmt: skip
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


def _match(
    r: Rule, f: Det, room: Room | None, faucets: list[Det], scale: int | None, labeler: Any = None
) -> tuple[bool, list[str]]:
    m = r.match
    if f.cls not in (m.get("fixtureClasses") or []):
        return False, []
    reasons: list[str] = []
    # Sprint 10 (contracts request): `labelPatterns` / `excludeLabelPatterns` on the fixture's label (annotations +
    # nearby text: "אינטרפוץ 4 דרך", "קופסת ניקוז", "3 דרך x2") pick the shower / bath line variant
    if labeler is not None and (m.get("labelPatterns") or m.get("excludeLabelPatterns")):
        from .labeled import label_matches, label_radius

        if not label_matches(r, labeler(f, label_radius(r))):
            return False, []
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


_MIXERS = re.compile(r"אינטרפוץ(?: (\d) דרך)? x(\d+)")
_HEB_N = {2: "שתי", 3: "שלוש", 4: "ארבע"}
R_MEASURED_SHOWER = "סעיף לפי מרכיבי המקלחון בשרטוט"


def measured_shower(f: Det) -> tuple[str, dict[str, float]] | None:
    """Sprint 11: the description of a shower point as the drawing states it (fixture annotations of a boxed-note
    sheet: ``אינטרפוץ 3 דרך x2``, ``תעלת ניקוז`` / ``קופסת ניקוז`` / ``ניקוז רגיל``) + its parameters — resolved against
    the library by description, so the client's own variants (2 / 3 mixers, 3 / 4 way, channel / box / plain drain,
    basement) are chosen by what is drawn. None when the shower carries no mixer count."""
    if f.cls != "fixture_shower":
        return None
    m = next((mm for a in f.annotations if (mm := _MIXERS.fullmatch(str(a)))), None)
    if m is None:
        return None
    n = int(m.group(2))
    ways = int(m.group(1)) if m.group(1) else None
    mix = "אינטרפוץ" if n == 1 else f"{_HEB_N.get(n, str(n))} יחידות אינטרפוץ"
    if ways:
        mix += f" {ways} דרך"
    drain = next((d for d in ("תעלת ניקוז", "קופסת ניקוז", "ניקוז רגיל") if d in f.annotations), None)
    where = " מרתף" if f.floor in ("basement", "-1") else ""
    desc = f"נק' למקלחון{where} הכוללת הזנת חמים+קרים, התקנת {mix}, נק' מים+מזלף, ראש גשם" + (f" ו{drain}" if drain else "")
    params: dict[str, float] = {"interpuz": float(n)}
    if ways:
        params["ways"] = float(ways)
    return desc, params


def plumbing_units(
    dets: list[Det],
    rules: list[Rule],
    rooms: dict[tuple[str, str], Room],
    scales: dict[str, int | None],
    labeler: Any = None,
    resolvable: Any = None,
    resolve_desc: Any = None,
) -> tuple[list[Unit], dict[str, Any]]:
    """``labeler(det, radius)`` / ``resolvable(rule) -> bool`` (Sprint 10): label-qualified variants; a default
    Sprint-10 rule whose item the library lacks falls through to the next matching rule (Noah's kitchen sinks stay on
    its basin lines)."""
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
            ok, reasons = _match(r, f, room, faucets, scales.get(f.sheet_id), labeler)
            if ok and r.source == "default" and resolvable is not None and r.id not in _S4_PLUMB_IDS and not resolvable(r):
                continue
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
        # Sprint 11: a shower whose parts are counted on the drawing picks the client's line by its own description
        # (one unit per shower: each one is a separate set of notes, whatever the room polygons say)
        ms = measured_shower(f) if resolve_desc is not None else None
        item = resolve_desc(ms[0], ms[1], r.unit or None) if ms is not None else None
        if item is not None:
            units.append(Unit(r, [(f, None)], 1.0, [*reasons, R_MEASURED_SHOWER], item=item))
            stats["measuredShowers"] = int(stats.get("measuredShowers") or 0) + 1
            continue
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


TextCue = tuple[str, float, float]  # (text, x, y) of a sheet text line, paper mm (bbox centre)


def text_cue_det(sheet_id: str, version_id: str, discipline: str, index: int, x: float, y: float, floor: str | None) -> Det:
    """Evidence item for a text-triggered suggestion (A-pipeline-10): ``detectionId`` = ``text_{n}`` (the n-th line of
    the version's ``text.json.gz``), placed at the text — a clickable cue on the sheet even without a detection."""
    return Det(
        sheet_id, version_id, f"text_{index}", "text", x, y, "yellow", [], floor, "new", None, discipline, 1.0, target="text"
    )


def suggestion_units(
    rules: list[Rule],
    dets: list[Det],
    canon: list[Room],
    texts: dict[str, list[TextCue]],
    sheet_floors: dict[str, list[str]],
    sheet_meta: dict[str, tuple[str, str]] | None = None,
) -> list[Unit]:
    """``sheet_meta``: sheet id → (version id, discipline) for text cues (evidence); without it a text trigger has
    no evidence item (pre-Stage-10 behaviour)."""
    live = sorted((d for d in dets if _live(d)), key=lambda d: d.key)
    out: list[Unit] = []
    for r in (x for x in rules if x.kind == "one_off_suggestion"):
        m = r.match
        fl = {str(f) for f in m.get("floors") or []}
        cue: list[Det] = []
        text_cue: Det | None = None
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
                hit = next(((i, t) for i, t in enumerate(texts[sid]) if any(p in _norm(t[0]) for p in pats)), None)
                if hit is not None:
                    fired = True
                    floors = [f for f in sheet_floors.get(sid) or [] if not fl or f in fl]
                    text_floor = floors[0] if floors else None
                    if sheet_meta and sid in sheet_meta:
                        vid, disc = sheet_meta[sid]
                        i, (_t, x, y) = hit
                        text_cue = text_cue_det(sid, vid, disc, i, x, y, text_floor)
                    break
        types = {str(t) for t in m.get("roomTypes") or []}
        if types:
            rh = [x for x in canon if x.type in types and (not fl or x.floor in fl)]
            if rh:
                fired = True
                if not cue:
                    cue.append(room_det(rh[0]))  # a room is a better cue than a text line
        if not cue and text_cue is not None:
            cue.append(text_cue)
        if not fired:
            continue
        qty = float(m.get("quantity") or 1)
        reasons = [] if R_TEMPLATE in r.reasons else [R_TEMPLATE]
        out.append(Unit(r, [(d, None) for d in cue[:1]], qty, reasons, "yellow", floor=text_floor, ignore_member_levels=True))
    return out


# ----------------------------------------------------------------------------- Stage 10: fixture combinations
DEFAULT_COMBINATION_RADIUS_MM = 1500.0


def combination_units(
    dets: list[Det],
    rules: list[Rule],
    rooms: dict[tuple[str, str], Room],
    scales: dict[str, int | None],
) -> tuple[list[Unit], dict[str, Any]]:
    """``fixture_combination`` rules (Stage 10 contract request): one unit of the rule's item per complete set — one
    live detection of each of ``classes``, on the same sheet, all within ``radiusMm`` (real mm) of the set's first
    member and, with ``sameRoom``, in the same room when both have one. Floors / room filters apply to the first
    member. Members are consumed (``dropped_by = combination:{ruleId}``) so ``plumbing_point`` / ``class_to_item`` do
    not count them again; incomplete sets fall through to those rules. Highest priority first (rules are sorted)."""
    units: list[Unit] = []
    stats: dict[str, Any] = {"sets": 0, "members": 0}
    for r in (x for x in rules if x.kind == "fixture_combination"):
        m = r.match
        classes = [str(c) for c in m.get("classes") or []]
        if len(classes) < 2 or len(set(classes)) != len(classes):
            continue
        fl = {str(f) for f in m.get("floors") or []}
        types, pats = m.get("roomTypes"), m.get("roomNamePatterns")
        rad = m.get("radiusMm")
        radius = float(rad) if isinstance(rad, int | float) else DEFAULT_COMBINATION_RADIUS_MM
        same_room = bool(m.get("sameRoom", True))
        pool = {c: sorted((d for d in dets if _live(d) and d.cls == c), key=lambda d: d.key) for c in classes}
        for a in pool[classes[0]]:
            if a.dropped_by is not None or (fl and a.floor not in fl):
                continue
            room = rooms.get((a.sheet_id, a.room_id)) if a.room_id else None
            if (types or pats) and room is not None:
                if types and room.type not in types:
                    continue
                if pats and not any(str(p) in (room.name or "") for p in pats):
                    continue
            thr = radius / float(scales.get(a.sheet_id) or DEFAULT_SCALE)
            members = [a]
            for c in classes[1:]:
                cands = [
                    b
                    for b in pool[c]
                    if b.dropped_by is None
                    and b.sheet_id == a.sheet_id
                    and _dist(a, b) <= thr
                    and not (same_room and a.room_id and b.room_id and a.room_id != b.room_id)
                ]
                if not cands:
                    break
                members.append(min(cands, key=lambda b: (_dist(a, b), b.key)))
            if len(members) != len(classes):
                continue
            for d in members:
                d.dropped_by = f"combination:{r.id}"
            units.append(Unit(r, [(d, None) for d in members], 1.0))
            stats["sets"] += 1
            stats["members"] += len(members)
    return units, stats
