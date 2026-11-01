"""Floors on the sheet vs floors in its title (Stage 10, A-UI-19).

Sprint 4 lets the drawings themselves set a region's floor (walls aligned with another floor's construction plan —
the stacked two-plan sheets titled "קומת מרתף+קומת קרקע" whose second plan is the first floor). The sheet's
``floors`` then follow the drawing while the title still names other floors, and the gallery showed the inferred
floors as plain fact. This helper makes the contradiction visible on the classification: a reason naming both readings
and the level capped at yellow. Pure; the orchestrator calls it once per page (never on a confirmed sheet).
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

FLOOR_HE = {
    "basement": "מרתף",
    "ground": "קרקע",
    "first": "קומה א'",
    "second": "קומה ב'",
    "third": "קומה ג'",
    "roof": "גג",
}
R_FLOOR_TITLE_PREFIX = "הקומות בשרטוט שונות מהכותרת"


def floor_names(floors: Sequence[str]) -> str:
    return ", ".join(FLOOR_HE.get(f, f) for f in floors)


def floor_title_reason(sheet_floors: Sequence[str], title_floors: Sequence[str]) -> str | None:
    """Reason chip when the sheet's floors (from the drawing) disagree with the floors its title names, else None.
    No title floors = nothing to contradict (``קומה לא זוהתה`` already says so)."""
    if not title_floors or not sheet_floors:
        return None
    if set(sheet_floors) == set(title_floors):
        return None
    return f"{R_FLOOR_TITLE_PREFIX} (בשרטוט: {floor_names(sheet_floors)}; בכותרת: {floor_names(title_floors)})"[:200]


def flag_floor_contradiction(classification: dict[str, Any], sheet_floors: Sequence[str]) -> dict[str, Any]:
    """Copy of ``classification`` (contracts ``SheetClassification``) with the contradiction reason added and a
    green level lowered to yellow. ``classification.floors`` keeps the title's reading."""
    reason = floor_title_reason(list(sheet_floors), list(classification.get("floors") or []))
    out = dict(classification)
    reasons = [r for r in (classification.get("reasons") or []) if not str(r).startswith(R_FLOOR_TITLE_PREFIX)]
    if reason is not None:
        reasons.append(reason)
        if out.get("level") == "green":
            out["level"] = "yellow"
    out["reasons"] = reasons[:32]
    return out
