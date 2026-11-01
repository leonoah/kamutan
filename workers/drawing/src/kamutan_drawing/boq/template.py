"""Template chapters offered as lump sums (Stage 10, A-pipeline-07) — pure.

``template_chapter`` rules (Stage 10 contract request, NOTES "Stage 10"): ``match = {chapters[], disciplines?[],
quantity, excludeCodes?[]}``. When the project has a current ready sheet of one of ``disciplines`` (absent = always),
every active library item of those chapters that no other rule produced is offered as ``quantity`` (1.0 קומפלט for the
demolition chapter 01), never green (the rule reasons, ``הצעה – לאשר ידנית``). Evidence = one whole-sheet item per
triggering sheet (``detectionId: "sheet"``), so the line is clickable (opens the demolition plan).
"""

from __future__ import annotations

from dataclasses import dataclass

from .dedup import Det
from .rules import FLOOR_ORDER, R_TEMPLATE, Item, Library, Rule
from .units import Unit

SHEET_EVIDENCE_ID = "sheet"


@dataclass(frozen=True)
class SheetRef:
    sheet_id: str
    version_id: str
    discipline: str
    floors: tuple[str, ...]
    page_mm: tuple[float, float]


def sheet_det(s: SheetRef) -> Det:
    floor = _first_floor(s.floors)
    return Det(s.sheet_id, s.version_id, SHEET_EVIDENCE_ID, "sheet", s.page_mm[0] / 2, s.page_mm[1] / 2, "yellow", [],
               floor, "new", None, s.discipline, 1.0, target="sheet")  # fmt: skip


def _first_floor(floors: tuple[str, ...] | list[str]) -> str | None:
    if not floors:
        return None
    return min(floors, key=lambda f: (FLOOR_ORDER.index(f) if f in FLOOR_ORDER else len(FLOOR_ORDER), f))


def template_units(rules: list[Rule], library: Library, sheets: list[SheetRef], produced: set[str]) -> list[Unit]:
    """``produced``: library item ids that already have a line from another rule (never offered twice)."""
    out: list[Unit] = []
    seen: set[str] = set(produced)
    for r in (x for x in rules if x.kind == "template_chapter"):
        m = r.match
        chapters = [str(c) for c in m.get("chapters") or [] if c]
        if not chapters:
            continue
        disc = {str(d) for d in m.get("disciplines") or []}
        trig = sorted((s for s in sheets if not disc or s.discipline in disc), key=lambda s: s.sheet_id)
        if disc and not trig:
            continue
        excluded = {str(c) for c in m.get("excludeCodes") or []}
        qty = float(m["quantity"]) if isinstance(m.get("quantity"), int | float) and m["quantity"] > 0 else 1.0
        floor = _first_floor([f for s in trig for f in s.floors])
        reasons = [] if R_TEMPLATE in r.reasons else [R_TEMPLATE]
        for item in library.in_chapters(chapters):
            if item.id in seen or item.code in excluded:
                continue
            seen.add(item.id)
            out.append(_unit(r, item, trig, qty, reasons, floor))
    return out


def _unit(r: Rule, item: Item, trig: list[SheetRef], qty: float, reasons: list[str], floor: str | None) -> Unit:
    return Unit(r, [(sheet_det(s), None) for s in trig], qty, list(reasons), "yellow", item=item, floor=floor,
                ignore_member_levels=True)  # fmt: skip
