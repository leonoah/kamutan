"""Sprint 11 (Worker-Areas): tiling lines split by LOCATION in the client's library — pure.

The designer's later BOQs (Rubel) do not have one "חיפוי קירות חדרי רחצה" line but one per location: "חיפוי קירות חדר
רחצה הורים", "… חדרי רחצה ילדים", "… אורחים", "ריצפות חדרי רחצה הורים+מרתף+אורחים", "ריצפות חדרי ילדים", "ריצפת חדר
כביסה", "ריצפת מרפסת קומה א'". The generic tiling rule fits several of them and differs from each only in a qualifier it
does not state, so ``Library.resolve`` rightly calls it ambiguous — every room's m² ended on one "אין פריט בספרייה" line and
the client's lines stayed 0. Here the ROOM decides:

* its **owner** (הורים / ילדים / אורחים): a word written inside the room on its sheet ("ש.אורחים"), else the owner the
  client's line of a fixture standing in it states (the shower resolved to "מקלחון יח' הורים" → the parents' bathroom);
* its **floor** (a basement bathroom matches a line that names מרתף);
* a wet room nobody names goes to the one line whose owner no room of the project carries (elimination, flagged);
* a named dry room (laundry, open terrace, English courtyard, patio, entrance) is tiled when the library has a floor
  line DEDICATED to it (a line that also names bathrooms is the wet rooms' line and never pulls dry rooms in).

Used only when the rule's own resolution finds no item, so a library with one line per measure (Noah, Achituv, Yahav wet
rooms) is resolved exactly as before.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from . import descmatch
from .rules import Item

R_BY_LOCATION = "סעיף לפי מיקום החדר (בעלים / קומה)"
R_BY_ELIMINATION = "שיוך לסעיף הנותר — בעל החדר לא כתוב בשרטוט"
R_DEDICATED_FLOOR = "ריצוף לפי סעיף ייעודי לחדר בספרייה"

OWNERS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("parents", re.compile(r"הורימ")),
    ("children", re.compile(r"ילדימ")),
    ("guests", re.compile(r"אורחימ")),
)
WET = frozenset({"bathroom", "wc"})
# dry rooms that can have a dedicated floor line: room value → words (canonical text: final letters folded)
DRY_ROOMS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("laundry", re.compile(r"כביסה")),
    ("terrace", re.compile(r"מרפסת")),
    ("courtyard", re.compile(r"חצר אנגלית")),
    ("patio", re.compile(r"פטיו")),
    ("entrance", re.compile(r"פודסט|כניסה")),
)
_BATH = re.compile(r"רחצה|מקלח|אמבט|שרותי|שירותי")
_CLAD = re.compile(r"חיפוי")
_WALL = re.compile(r"קיר")
_FLOOR = re.compile(r"ריצופ|ריצפ")
_NOT_TILE = re.compile(r"איטומ|סוג ב|תשתית|אבנ|פאנל שקוע|מדרגות|ליטוש|קופינג")
_OUTDOOR = re.compile(r"פיתוח|חוצ")
_LEVELS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("basement", re.compile(r"מרתפ")),
    ("first", re.compile(r"קומה א")),
    ("ground", re.compile(r"קרקע")),
)
AREA_UNITS = frozenset({'מ"ר', "מר", "m2"})


def owners_in(text: str) -> set[str]:
    t = descmatch.canon(text)
    return {o for o, rx in OWNERS if rx.search(t)}


@dataclass(frozen=True)
class ItemLoc:
    kind: str | None  # floor | cladding | None (not a tiling line)
    owners: frozenset[str]
    levels: frozenset[str]
    wet: bool  # names bathrooms / WCs
    dry: frozenset[str]  # dry rooms it names
    outdoor: bool


def item_loc(description: str, unit: str | None) -> ItemLoc:
    """What a library line says about WHERE it applies (every value it names, not only the first)."""
    t = descmatch.canon(description)
    kind: str | None = None
    if (unit or "").strip() in AREA_UNITS and not _NOT_TILE.search(t):
        if _CLAD.search(t) and _WALL.search(t):
            kind = "cladding"
        elif _FLOOR.search(t):
            kind = "floor"
    return ItemLoc(
        kind,
        frozenset(o for o, rx in OWNERS if rx.search(t)),
        frozenset(v for v, rx in _LEVELS if rx.search(t)),
        bool(_BATH.search(t)),
        frozenset(v for v, rx in DRY_ROOMS if rx.search(t)),
        bool(_OUTDOOR.search(t)),
    )


def dry_room_value(name: str | None) -> str | None:
    t = descmatch.canon(name or "")
    return next((v for v, rx in DRY_ROOMS if rx.search(t)), None) if t else None


# "ח.רחצה עמית" / "חדר רחצה נלי": a bathroom labelled with a person's first name belongs to that child (the parents' and
# guests' rooms are labelled הורים / אורחים). Only read when the library has a children's tiling line.
_PERSONAL = re.compile(r"^(?:ח\.?\s*רחצה|חדר\s+רחצה|ח\.?\s*שירותים|חדר\s+שירותים)\s+(?:של\s+)?([א-ת]{2,})$")
_NOT_A_NAME = re.compile(
    r"^(?:הורים|אורחים|ילדים|שירות|שירותים|מקלחת|ראשי|ראשית|כללי|קטן|גדול|חדש|חדשה|עליון|תחתון|קרקע|מרתף|ציבורי|נכים|נגיש"
    r"|משותף|משותפת|רטוב|יבש|ושירות|וכביסה|כביסה)$"
)


def personal_owner(text: str) -> str | None:
    m = _PERSONAL.match(" ".join(text.split()))
    return "children" if m and not _NOT_A_NAME.match(m.group(1)) else None


def owner_from_texts(
    polygon: Sequence[tuple[float, float]], texts: Iterable[Mapping[str, Any]], *, personal: bool = False
) -> str | None:
    """The owner word written inside a room (text centre in the polygon, paper mm); two different owners → None.
    ``personal``: a bathroom labelled with a first name counts as the children's."""
    if len(polygon) < 3:
        return None
    found: set[str] = set()
    for t in texts:
        bb = t.get("bboxMm")
        s = str(t.get("text") or "")
        if not s or not isinstance(bb, list | tuple) or len(bb) != 4:
            continue
        own = owners_in(s)
        if not own and personal and (po := personal_owner(s)):
            own = {po}
        if not own:
            continue
        x, y = (float(bb[0]) + float(bb[2])) / 2, (float(bb[1]) + float(bb[3])) / 2
        inside = False
        n = len(polygon)
        for i in range(n):
            (ax, ay), (bx, by) = polygon[i], polygon[(i + 1) % n]
            if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
                inside = not inside
        if inside:
            found |= own
    return next(iter(found)) if len(found) == 1 else None


def choose_wet(
    items: Sequence[Item],
    kind: str,
    *,
    owner: str | None,
    floor: str | None,
    known_owners: set[str],
    all_owners: set[str] | None = None,
) -> tuple[Item, str] | None:
    """The client's line of a wet room's floor / wall tiling: (item, reason) or None (no line / still ambiguous).
    Elimination needs exactly ONE owner of the library's tiling lines (``all_owners``; default: this measure's lines)
    that no wet room of the drawing carries — with two unnamed owners nothing can be told."""
    pool = [(i, loc) for i in items if (loc := item_loc(i.description, i.unit)).kind == kind and not loc.outdoor and not loc.dry
            and (loc.wet or loc.owners)]  # fmt: skip
    if len(pool) < 2:
        return None  # one line per measure: the rule's own resolution decides (a lone partial-wall line is not "the" line)
    mine = {owner} if owner else set()
    if floor in ("basement", "-1"):
        mine.add("basement")

    def tokens(loc: ItemLoc) -> set[str]:
        return set(loc.owners) | ({"basement"} if "basement" in loc.levels else set())

    hits = [i for i, loc in pool if tokens(loc) & mine]
    if len(hits) == 1:
        return hits[0], R_BY_LOCATION
    if hits:
        return None
    if owner is None:
        named = all_owners if all_owners is not None else {o for _, loc in pool for o in loc.owners}
        left = named - known_owners
        if len(left) == 1:
            free = [i for i, loc in pool if set(loc.owners) & left]
            if len(free) == 1:
                return free[0], R_BY_ELIMINATION
        if named:
            return None  # the lines are split by owner and this room's owner is not known
    plain = [i for i, loc in pool if not tokens(loc)]
    return (plain[0], R_BY_LOCATION) if len(plain) == 1 else None


def choose_dry_floor(items: Sequence[Item], room_value: str, floor: str | None) -> Item | None:
    """The floor line dedicated to a dry room (laundry / terrace / courtyard …): names it, names no bathroom, and — when
    it names a floor — that floor."""
    hits = []
    for i in items:
        loc = item_loc(i.description, i.unit)
        if loc.kind != "floor" or loc.wet or room_value not in loc.dry:
            continue
        if loc.levels and floor is not None and (("basement" if floor == "-1" else floor) not in loc.levels):
            continue
        hits.append(i)
    return hits[0] if len(hits) == 1 else None


_WATERPROOF = re.compile(r"איטומ")
_MEMBRANE = re.compile(r"יריעות|ביטומנ")


def choose_dry_waterproof(items: Sequence[Item], room_value: str, floor: str | None) -> Item | None:
    """The membrane waterproofing line dedicated to an open dry room (open balcony / patio / English yard), m²."""
    hits = []
    for i in items:
        t = descmatch.canon(i.description)
        loc = item_loc(i.description, i.unit)
        if (i.unit or "").strip() not in AREA_UNITS or not _WATERPROOF.search(t) or not _MEMBRANE.search(t):
            continue
        if loc.wet or room_value not in loc.dry or room_value in ("laundry", "entrance"):
            continue
        if loc.levels and floor is not None and (("basement" if floor == "-1" else floor) not in loc.levels):
            continue
        hits.append(i)
    return hits[0] if len(hits) == 1 else None
