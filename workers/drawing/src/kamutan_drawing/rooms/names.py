"""Hebrew room-name dictionary and fuzzy matching of OCR text against it."""

from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher

# canonical name -> spellings seen on drawings (normalised at import)
ROOM_NAMES: dict[str, tuple[str, ...]] = {
    "סלון": ("סלון", "חדר מגורים", "מגורים"),
    "מטבח": ("מטבח", "מטבחון"),
    "פינת אוכל": ("פינת אוכל", "פ. אוכל", "פינת אכילה", "חדר אוכל"),
    "חדר שינה": (
        "חדר שינה",
        'חד"ש',
        "חדר הורים",
        "חדר שינה הורים",
        "יחידת הורים",
        "סוויטת הורים",
        "סוויטה",
        "חדר ילדים",
        "חדר ילד",
    ),
    'ממ"ד': ('ממ"ד', "ממד", "מרחב מוגן", "מרחב מוגן דירתי"),
    "שירותים": ("שירותים", "ש. אורחים", "שירותי אורחים", "שרותים"),
    "מקלחת": ("מקלחת", "מקלחון"),
    "חדר רחצה": ("חדר רחצה", "אמבטיה", "אמבט", "חדר אמבטיה", "ח. רחצה", "רחצה", "רחצה הורים"),
    "מרפסת": ("מרפסת", "מרפסת שירות", "מרפסת שמש", "מרפסת מקורה"),
    "מחסן": ("מחסן", "מחסן ביתי"),
    "מסדרון": ("מסדרון", "פרוזדור", "מעבר"),
    "כניסה": ("כניסה", "מבואה", "מבואת כניסה", "הול", "הול כניסה", "לובי"),
    "חדר כביסה": ("חדר כביסה", "כביסה", "חדר כבסים"),
    "חדר עבודה": ("חדר עבודה", "משרד", "חדר מחשב", "ספריה", "ספרייה"),
    "חדר משחקים": ("חדר משחקים", "חדר משפחה", "חדר טלויזיה", "חדר טלוויזיה", "חדר קולנוע"),
    "חדר ארונות": ("חדר ארונות", "ארונות", "חדר הלבשה"),
    "מזווה": ("מזווה",),
    "חדר מדרגות": ("חדר מדרגות", "מדרגות", "גרם מדרגות"),
    "חדר טכני": ("חדר טכני", "חדר מכונות", "חדר משאבות", "חדר חשמל", "חדר דוודים"),
    "חניה": ("חניה", "חנייה", "חניון", "מוסך"),
    "פטיו": ("פטיו", "חצר אנגלית", "חצר"),
}

_FINALS = str.maketrans({"ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ"})
_QUOTES = re.compile(r"[\"'״׳`´”“]")
_PUNCT = re.compile(r"[\s.\-_:;,()\[\]|/\\?!]+")


def normalise(text: str) -> str:
    t = _QUOTES.sub("", text.lower()).translate(_FINALS)
    return _PUNCT.sub("", t)


_VARIANTS: list[tuple[str, str]] = sorted(
    {(normalise(v), canon) for canon, vs in ROOM_NAMES.items() for v in (canon, *vs)},
    key=lambda p: -len(p[0]),
)
_HEB = re.compile(r"[א-ת]")
_ABBREV = re.compile(r"(^|\s)ח\s*[.׳']\s*")  # "ח.שינה" / "ח. רחצה" = חדר ...
_DIGITS = re.compile(r"[0-9]+")
_QUALIFIERS = {normalise(w) for w in ("כללי", "הורים", "ילדים", "ראשי", "ראשית", "משפחתי", "קיים", "חדש", "קטן", "גדול")}


@dataclass(frozen=True)
class NameMatch:
    name: str  # canonical
    score: float  # 0..1 string similarity x coverage of the text
    raw: str


def match_room_name(text: str) -> NameMatch | None:
    """Best dictionary match of one text item, or None.

    Whole-label matches score ~1; a room word inside a longer note ("פירוק מטבח קיים") scores
    low (coverage) so a real label wins. OCR noise is tolerated by a fuzzy ratio ≥ 0.75.
    """
    if not text or not _HEB.search(text):
        return None
    t = _ABBREV.sub(r"\1חדר ", text)
    n = _DIGITS.sub("", normalise(t))
    if len(n) < 3:
        return None
    # qualifiers ("ח.רחצה הורים", "ח.רחצה כללי") belong to the label, not to a note
    words = [w for w in re.split(r"\s+", t) if w]
    core = _DIGITS.sub("", normalise(" ".join(w for w in words if normalise(w) not in _QUALIFIERS))) or n
    best: NameMatch | None = None
    for v, canon in _VARIANTS:
        if len(v) < 3 or v not in n:
            continue
        cover = len(v) / max(1, min(len(n), len(core) if v in core else len(n)))
        score = 1.0 if cover >= 0.8 else 0.35 + 0.5 * cover
        if best is None or score > best.score:
            best = NameMatch(canon, score, text)
    if best is not None:
        return best
    # OCR noise: fuzzy match of the whole label
    for v, canon in _VARIANTS:
        if len(v) < 3 or abs(len(v) - len(core)) > max(2, len(v) // 3):
            continue
        sim = SequenceMatcher(None, v, core).ratio()
        if sim >= 0.75 and (best is None or sim > best.score):
            best = NameMatch(canon, sim * 0.9, text)
    return best
