"""Room type + wet flag (Sprint 4) from the room name and the fixtures inside the room.

Types (brief): bathroom | wc | kitchen | bedroom | living | corridor | balcony | courtyard | storage | stairs | other.

1. **name** — the canonical name(s) of :mod:`.names` map to a type (:data:`NAME_TYPES`); a merged name "A / B"
   takes the wettest / most specific part (bathroom > wc > kitchen > bedroom > …).
2. **fixtures** (classes inside the room polygon) override or complete it: a shower or a bath → bathroom; a WC
   (with or without a basin) and no shower/bath → wc (≤ 4 m², else bathroom); a kitchen sink in an unnamed room →
   kitchen. A named living room keeps its type when it holds the kitchen sink (open plan).
3. **wet** = bathroom | wc (incl. rooms typed so by their fixtures), or a laundry room (חדר כביסה). A named dry
   room (bedroom, living …) holding a wet fixture stays dry with the note ``כלים סניטריים בחדר יבש``; a washing
   machine alone never makes a room wet (it often stands in a niche of a bedroom / corridor).
"""

from __future__ import annotations

from collections.abc import Iterable

ROOM_TYPES = ("bathroom", "wc", "kitchen", "bedroom", "living", "corridor", "balcony", "courtyard", "storage", "stairs", "other")

NAME_TYPES: dict[str, str] = {
    "סלון": "living",
    "פינת אוכל": "living",
    "חדר משחקים": "living",
    "מטבח": "kitchen",
    "חדר שינה": "bedroom",
    "חדר עבודה": "bedroom",
    'ממ"ד': "bedroom",
    "שירותים": "wc",
    "מקלחת": "bathroom",
    "חדר רחצה": "bathroom",
    "מרפסת": "balcony",
    "מחסן": "storage",
    "חדר ארונות": "storage",
    "מזווה": "storage",
    "חדר טכני": "storage",
    "מסדרון": "corridor",
    "כניסה": "corridor",
    "חדר מדרגות": "stairs",
    "פטיו": "courtyard",
    "חדר כביסה": "other",
    "חניה": "other",
}
# preference when one face carries several names
_ORDER = ("bathroom", "wc", "kitchen", "bedroom", "living", "storage", "corridor", "stairs", "balcony", "courtyard", "other")
WET_TYPES = frozenset({"bathroom", "wc"})
WET_FIXTURES = frozenset({"fixture_wc_concealed", "fixture_wc_monoblock", "fixture_basin", "fixture_shower", "fixture_bath"})
DRY_NAMED = frozenset({"bedroom", "living", "corridor", "stairs", "storage", "balcony"})


def is_laundry(name: str | None) -> bool:
    return bool(name) and "חדר כביסה" in {p.strip() for p in str(name).split("/")}


def type_from_name(name: str | None) -> str | None:
    """Type of a (possibly merged "A / B") canonical room name; None when unnamed / unknown."""
    if not name:
        return None
    types = [NAME_TYPES.get(part.strip()) for part in name.split("/")]
    found = [t for t in types if t]
    if not found:
        return None
    parts = {part.strip() for part in name.split("/")}
    if "סלון" in parts and not set(found) & WET_TYPES:
        return "living"  # open plan living / dining / kitchen
    return min(found, key=_ORDER.index)


def room_type(name: str | None, fixture_classes: Iterable[str], area_m2: float) -> tuple[str, bool, list[str]]:
    """(type, wet, evidence notes) of one room."""
    cls = set(fixture_classes)
    by_name = type_from_name(name)
    notes: list[str] = []
    t = by_name or "other"
    has_wc = bool(cls & {"fixture_wc_concealed", "fixture_wc_monoblock"})
    has_wash = bool(cls & {"fixture_shower", "fixture_bath"})
    if has_wash and t not in ("bathroom",):
        if by_name in (None, "wc", "other", "storage"):
            t = "bathroom"
            notes.append("סוג חדר לפי כלים סניטריים")
    elif has_wc and by_name in (None, "other", "storage"):
        t = "wc" if area_m2 <= 4.0 else "bathroom"
        notes.append("סוג חדר לפי כלים סניטריים")
    elif "fixture_kitchen_sink" in cls and by_name is None:
        t = "kitchen"
        notes.append("סוג חדר לפי כלים סניטריים")
    elif by_name is None and "fixture_basin" in cls and area_m2 <= 4.0:
        t = "wc"
        notes.append("סוג חדר לפי כלים סניטריים")
    wet = t in WET_TYPES or (by_name is None and t == "other" and bool(cls & WET_FIXTURES)) or (t == "other" and is_laundry(name))
    if t in DRY_NAMED and cls & WET_FIXTURES and by_name is not None:
        # a named dry room holding a WC / basin (en-suite drawn without a partition): wet, keep the name type
        notes.append("כלים סניטריים בחדר יבש")
    return t, wet, notes
