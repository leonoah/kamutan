"""Text items of a build → BOQ units (pure). For Worker-BOQ's ``text_item`` rule kind and local measurement.

:func:`text_units` takes the ``text_items.json.gz`` documents of the sheets in a build and returns one unit per
counted item, with the semantics of :mod:`textitems.catalog` applied *across* sheets:

* items with ``qty`` 0 / null (folded pairs, unmatched notes, legend rows, detail boxes) are not units;
* ``corroborates`` items are evidence for a line that symbols / links produce — skipped unless
  ``include_corroborating`` (then they become units of their own: use it only when no symbol rule targets the code);
* ``per_floor`` entries: one unit per (code, floor) over every sheet (the ventilator on the electrical, master and
  construction plans is one ventilator); the other items of that floor are its evidence;
* ``codes`` limits the output to some item codes (e.g. the codes a ``text_item`` rule targets).

A unit: ``{itemCode, qty, unit, floor, sheetId, roomId, level, reasons, suggested, origin: "text"|"suggested",
matchedPattern, evidence: [{sheetId, itemId, kind, lineIdx, bboxMm, anchorMm}]}`` — evidence entries map onto the
BOQ evidence ``text_{n}`` convention via ``lineIdx``.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from .catalog import BY_ID

LEVEL_RANK = {"red": 0, "yellow": 1, "green": 2}


def _evidence(it: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "sheetId": it.get("sheetId"),
        "itemId": it.get("id"),
        "kind": it.get("kind"),
        "lineIdx": list(it.get("lineIdx") or []),
        "bboxMm": it.get("bboxMm"),
        "anchorMm": it.get("anchorMm"),
    }


def _min_level(*levels: str) -> str:
    return min(levels, key=lambda lv: LEVEL_RANK.get(lv, 0)) if levels else "yellow"


def text_units(
    docs: Iterable[Mapping[str, Any]],
    *,
    codes: Sequence[str] | None = None,
    include_corroborating: bool = False,
) -> list[dict[str, Any]]:
    want = set(codes) if codes else None
    items: list[Mapping[str, Any]] = []
    folded: dict[tuple[str, str], list[Mapping[str, Any]]] = {}
    for d in docs:
        for it in d.get("items") or []:
            code = it.get("itemCode")
            if not code or (want is not None and code not in want):
                continue
            if it.get("corroborates") and not include_corroborating:
                continue
            if it.get("pairedWith"):
                folded.setdefault((str(it.get("sheetId")), str(it.get("pairedWith"))), []).append(it)
                continue
            if not it.get("qty"):
                continue
            items.append(it)
    units: list[dict[str, Any]] = []
    per_floor: dict[tuple[str, str | None], dict[str, Any]] = {}
    for it in sorted(items, key=lambda t: (-float(t.get("confidence") or 0.0), str(t.get("sheetId")), str(t.get("id")))):
        entry = BY_ID.get(str(it.get("matchedPattern") or ""))
        ev = [_evidence(it), *(_evidence(f) for f in folded.get((str(it.get("sheetId")), str(it.get("id"))), []))]
        key = (str(it["itemCode"]), it.get("floor"))
        if entry is not None and entry.per_floor and key in per_floor:
            u = per_floor[key]
            u["evidence"].extend(ev)
            continue
        suggested = bool(it.get("suggested"))
        u = {
            "itemCode": str(it["itemCode"]),
            "qty": float(it["qty"]),
            "unit": it.get("unit"),
            "floor": it.get("floor"),
            "sheetId": it.get("sheetId"),
            "roomId": it.get("roomId"),
            "level": _min_level(str(it.get("level") or "yellow"), "yellow"),
            "reasons": list(it.get("reasons") or []),
            "suggested": suggested,
            "origin": "suggested" if suggested else "text",
            "matchedPattern": it.get("matchedPattern"),
            "lengthM": it.get("lengthM"),
            "evidence": ev,
        }
        if entry is not None and entry.per_floor:
            per_floor[key] = u
        units.append(u)
    units.sort(key=lambda u: (u["itemCode"], str(u["floor"]), str(u["sheetId"])))
    return units


def qty_by_code(units: Iterable[Mapping[str, Any]]) -> dict[str, float]:
    out: dict[str, float] = {}
    for u in units:
        out[str(u["itemCode"])] = round(out.get(str(u["itemCode"]), 0.0) + float(u["qty"]), 3)
    return dict(sorted(out.items()))
