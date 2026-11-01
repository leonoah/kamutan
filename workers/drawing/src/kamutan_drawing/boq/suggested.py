"""Sprint 6: suggested lines — rule kind ``suggested_item`` (pure). Contracts ``SuggestedItemMatchSchema``::

    match = {trigger: {kind: "sheet_discipline", disciplines}
                    | {kind: "text", patterns, scope?, disciplines?}
                    | {kind: "demolition", categories?}
                    | {kind: "always"},
             estimate?: {kind: "fixed", quantity} | {kind: "geometry", match} | {kind: "room_area", roomTypes?, floors?}
                        | null,
             reason, quickAction?, level?: yellow | red}

When the trigger fires and **no other rule produced the code** (detections, text, geometry, tiling, plumbing, manual
measures / counts — so a quick-measure correction bound to the line replaces it), ONE line of ``itemCode`` with
``origin: "suggested"``, the rule's ``reason`` (+ rule reasons), ``quickAction {kind, sheetId}`` (kind: the rule's, else
by unit — contracts ``defaultQuickActionFor``; sheet: the trigger's) and evidence = what fired (the matched text items,
the triggering sheets, the demolished geometry / detections). Quantity: the estimate (> 0) → level ``match.level`` or
yellow; no estimate → ``needsInput: true``, qty 0, red, chip ``להשלמה ידנית``. Never green. Only items of the org's
library are offered (a default rule whose code the library lacks yields nothing — no "לא משויך" noise).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .dedup import Det
from .geometry import GeoItem, key_units, select, unit_kind
from .rules import FLOOR_ORDER, R_NEEDS_INPUT, Library, Rule
from .spaces import Room
from .template import SheetRef, sheet_det
from .textitems import TextEntry, clusters, entry_det, first_match, patterns_of, per_floor_authority, scope_ok
from .units import Unit

QUICK_ACTIONS = ("measure_area", "measure_length", "count", "confirm")
DEFAULT_DEMOLITION_CATEGORIES = ("wall_demolished",)
MAX_TRIGGER_EVIDENCE = 8


def default_quick_action(unit: str | None) -> str:
    """contracts ``defaultQuickActionFor``: מ"ר → measure_area, מ"א → measure_length, קומפלט → confirm, else count."""
    k = unit_kind(unit or "")
    return {"area": "measure_area", "length": "measure_length", "lump": "confirm"}.get(k, "count")


def _floor_rank(f: str | None) -> tuple[int, str]:
    return (FLOOR_ORDER.index(f) if f in FLOOR_ORDER else len(FLOOR_ORDER), f or "")


@dataclass
class Fired:
    dets: list[Det]
    floor: str | None
    sheets: list[str]  # sheet ids of the cue, in order


def _lowest(floors: list[str]) -> str | None:
    return min(floors, key=_floor_rank) if floors else None


def fire(trigger: Any, sheets: list[SheetRef], entries: list[TextEntry], geo: list[GeoItem], dets: list[Det],
         room_type: Any) -> Fired | None:  # fmt: skip
    """Evaluate a trigger; None = not fired."""
    if not isinstance(trigger, dict):
        return None
    kind = trigger.get("kind")
    disc = [str(d) for d in trigger.get("disciplines") or []]
    rank = {d: i for i, d in enumerate(disc)}
    if kind == "always":
        return Fired([], _lowest([f for s in sheets for f in s.floors]), [])
    if kind == "sheet_discipline":
        hit = sorted((s for s in sheets if s.discipline in rank), key=lambda s: (rank[s.discipline], s.sheet_id))
        if not hit:
            return None
        return Fired([sheet_det(s) for s in hit[:MAX_TRIGGER_EVIDENCE]], _lowest([f for s in hit for f in s.floors]),
                     [s.sheet_id for s in hit])  # fmt: skip
    if kind == "demolition":
        hit = sorted((s for s in sheets if s.discipline == "demolition"), key=lambda s: s.sheet_id)
        if hit:
            return Fired([sheet_det(s) for s in hit[:MAX_TRIGGER_EVIDENCE]], _lowest([f for s in hit for f in s.floors]),
                         [s.sheet_id for s in hit])  # fmt: skip
        cats = [str(c) for c in trigger.get("categories") or []] or list(DEFAULT_DEMOLITION_CATEGORIES)
        units, _ = select({"source": "wall_run", "categories": cats}, "length_item", geo, room_type)
        units += select({"source": "hatch", "categories": cats}, "area_item", geo, room_type)[0]
        ev = [u.det for u in units] or [d for d in dets if d.lifecycle == "demolish" and d.dropped_by is None]
        if not ev:
            return None
        ev = sorted(ev, key=lambda d: (d.sheet_id, d.id))
        return Fired(
            ev[:MAX_TRIGGER_EVIDENCE], _lowest([d.floor for d in ev if d.floor]), list(dict.fromkeys(d.sheet_id for d in ev))
        )
    if kind == "text":
        pats = patterns_of(trigger)
        if not pats:
            return None
        scope = str(trigger.get("scope") or "any")
        hits = [(e, m) for e in entries if (not disc or e.discipline in disc) and scope_ok(scope, e.scope)
                and (m := first_match(e, pats, [])) is not None]  # fmt: skip
        cs = per_floor_authority(clusters(hits, 0.0), disc)
        if not cs:
            return None
        cs.sort(
            key=lambda c: (_floor_rank(c[0][0].floor), rank.get(c[0][0].discipline, 0), c[0][0].sheet_id, c[0][0].y, c[0][0].x)
        )
        return Fired([entry_det(c[0][0]) for c in cs[:MAX_TRIGGER_EVIDENCE]], cs[0][0][0].floor,
                     list(dict.fromkeys(c[0][0].sheet_id for c in cs)))  # fmt: skip
    return None


def estimate(
    est: Any, unit: str, geo: list[GeoItem], canon: list[Room], room_type: Any, docs: list[dict[str, Any]] | None = None
) -> float | None:
    """The suggested quantity, or None (no estimate / it yields nothing)."""
    if not isinstance(est, dict):
        return None
    k = est.get("kind")
    q: float | None = None
    if k == "fixed" and isinstance(est.get("quantity"), int | float) and not isinstance(est.get("quantity"), bool):
        q = float(est["quantity"])
    elif k == "geometry" and isinstance(est.get("match"), dict):
        kind = "length_item" if unit_kind(unit) == "length" else "area_item"
        if est["match"].get("keys"):
            # only a computable measure is an estimate; a non-computable one leaves the line needsInput
            q = sum(u.qty for u in key_units(est["match"], geo, docs or []) if u.origin == "geometry")
        else:
            q = sum(u.qty for u in select(est["match"], kind, geo, room_type)[0])
    elif k == "room_area":
        types = {str(t) for t in est.get("roomTypes") or []}
        floors = {str(f) for f in est.get("floors") or []}
        q = sum(r.area_m2 for r in canon if (not types or r.type in types) and (not floors or r.floor in floors))
    return round(q, 4) if q is not None and q > 0 else None


def suggested_units(
    rules: list[Rule],
    library: Library,
    sheets: list[SheetRef],
    entries: list[TextEntry],
    produced: set[str],
    *,
    geo: list[GeoItem] | None = None,
    dets: list[Det] | None = None,
    canon: list[Room] | None = None,
    room_type: Any = None,
    docs: list[dict[str, Any]] | None = None,
) -> tuple[list[Unit], dict[str, Any]]:
    """``produced``: library item ids that already have a line (any origin). Rules in priority order: the first rule
    that fires for an item offers it."""
    rt = room_type or (lambda _s, _r: None)
    out: list[Unit] = []
    stats: dict[str, Any] = {"rules": 0, "fired": 0, "units": 0, "noItem": 0, "alreadyProduced": 0}
    seen = set(produced)
    for r in (x for x in rules if x.kind == "suggested_item"):
        stats["rules"] += 1
        m = r.match
        res = library.resolve(r.item_code, r.description) if r.item_code else None
        if res is None:
            stats["noItem"] += 1
            continue
        item = res.item
        if item.id in seen:
            stats["alreadyProduced"] += 1
            continue
        f = fire(m.get("trigger"), sheets, entries, geo or [], dets or [], rt)
        if f is None:
            continue
        stats["fired"] += 1
        seen.add(item.id)
        unit = item.unit or r.unit
        qty = estimate(m.get("estimate"), unit, geo or [], canon or [], rt, docs)
        action = str(m["quickAction"]) if m.get("quickAction") in QUICK_ACTIONS else default_quick_action(unit)
        reason = str(m.get("reason") or "").strip()[:200]
        level = (str(m["level"]) if m.get("level") in ("yellow", "red") else "yellow") if qty is not None else "red"
        reasons = [x for x in (reason, None if qty is not None else R_NEEDS_INPUT) if x]
        out.append(
            Unit(
                r,
                [(d, None) for d in f.dets],
                qty if qty is not None else 0.0,
                list(dict.fromkeys(reasons)),
                level,
                item=item,
                floor=f.floor,
                ignore_member_levels=True,
                origin="suggested",
                quick_action={"kind": action, "sheetId": f.sheets[0] if f.sheets else None},
                needs_input=qty is None,
            )
        )
    stats["units"] = len(out)
    return out, stats
