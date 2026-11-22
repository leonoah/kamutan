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
        "חדר הורים",
        "חדר שינה הורים",
        "יחידת הורים",
        "סוויטת הורים",
        "סוויטה",
        "חדר ילדים",
        "חדר ילד",
        "שינה",  # Sprint 14 — keep: a label read without its "חדר"
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
# Sprint 14 — keep: the abbreviation חד"ש (חדר שינה) loses its quote in ``normalise`` and then reads "חדש" — "new", the most
# common word of a construction sheet ("ת.גבס חדש", "חדשה") — so it is matched on the raw text, with its quote
_BEDROOM_ABBREV = re.compile(r"(^|\s)חד[\"״]ש(\s|$)")
# Sprint 14 — keep: "החדר של עמית" / "חדר של נלי": the room of a child — how the children's rooms are labelled when they are named after the child
_OWNED_ROOM = re.compile(r"^\s*ה?חדר\s+של\s+[א-ת\"'׳״\-]{2,}\s*$")
_ABBREV = re.compile(r"(^|\s)ח\s*[.׳']\s*")  # "ח.שינה" / "ח. רחצה" = חדר ...
_DIGITS = re.compile(r"[0-9]+")
_QUALIFIERS = {normalise(w) for w in ("כללי", "הורים", "ילדים", "ראשי", "ראשית", "משפחתי", "קיים", "חדש", "קטן", "גדול")}


# Sprint 14 — keep: an OCR slip is one wrong letter of a word of 5+ letters (or a ratio of 0.85); at 0.75 the common words of a drawing matched room names
# (חלון→סלון, בניה→חניה, נישה→חניה, חדשה→חדר שינה, ארון→חדר ארונות) and named faces nobody had labelled
FUZZY_MIN = 0.85


def _one_edit(a: str, b: str) -> bool:
    """Whether ``a`` and ``b`` differ by one inserted, deleted or substituted letter."""
    if abs(len(a) - len(b)) > 1 or a == b:
        return False
    i = 0
    while i < min(len(a), len(b)) and a[i] == b[i]:
        i += 1
    if len(a) == len(b):
        return a[i + 1 :] == b[i + 1 :]
    s, t = (a, b) if len(a) < len(b) else (b, a)
    return s[i:] == t[i + 1 :]


_NOT_NAMES = {normalise(w) for w in ("מדפסת", "מסנן", "שירות", "עבור", "מקרר", "מדיח", "מיקרו", "מזגן", "מחשב", "מסך")}


@dataclass(frozen=True)
class NameMatch:
    name: str  # canonical
    score: float  # 0..1 string similarity x coverage of the text
    raw: str


def _word_bounds(text: str) -> set[int]:
    """Offsets, in the normalised digit-less string of ``text``, at which a word starts or ends."""
    out = {0}
    pos = 0
    for w in re.split(r"\s+", text):
        pos += len(_DIGITS.sub("", normalise(w)))
        out.add(pos)
    return out


def _at_word_bounds(n: str, v: str, bounds: set[int]) -> bool:
    i = n.find(v)
    while i >= 0:
        if i in bounds and i + len(v) in bounds:
            return True
        i = n.find(v, i + 1)
    return False


def match_room_name(text: str) -> NameMatch | None:
    """Best dictionary match of one text item, or None.

    Whole-label matches score ~1; a room word inside a longer note ("פירוק מטבח קיים") scores
    low (coverage) so a real label wins. OCR noise is tolerated by a fuzzy ratio ≥ 0.75.
    """
    if not text or not _HEB.search(text):
        return None
    if _BEDROOM_ABBREV.search(text):
        return NameMatch("חדר שינה", 1.0 if len(normalise(text)) <= 5 else 0.5, text)
    if _OWNED_ROOM.match(text):
        return NameMatch("חדר שינה", 0.9, text)
    t = _ABBREV.sub(r"\1חדר ", text)
    n = _DIGITS.sub("", normalise(t))
    if len(n) < 3:
        return None
    # qualifiers ("ח.רחצה הורים", "ח.רחצה כללי") belong to the label, not to a note
    words = [w for w in re.split(r"\s+", t) if w]
    core = _DIGITS.sub("", normalise(" ".join(w for w in words if normalise(w) not in _QUALIFIERS))) or n
    bounds = _word_bounds(t)
    best: NameMatch | None = None
    for v, canon in _VARIANTS:
        if len(v) < 3 or v not in n:
            continue
        if not _at_word_bounds(n, v, bounds):
            continue  # Sprint 11: "מיקום מדויק" is not ממ"ד — the name must start and end at word boundaries
        cover = len(v) / max(1, min(len(n), len(core) if v in core else len(n)))
        score = 1.0 if cover >= 0.8 else 0.35 + 0.5 * cover
        if best is None or score > best.score:
            best = NameMatch(canon, score, text)
    if best is not None:
        return best
    # OCR noise: fuzzy match of the whole label — never for a word that is itself something else (Sprint 11: the
    # "מדפסת" in a study was read as מרפסת, the pool's "מסנן" as מחסן, "שירות" as שירותים)
    if core in _NOT_NAMES:
        return None
    for v, canon in _VARIANTS:
        if len(v) < 3 or abs(len(v) - len(core)) > max(2, len(v) // 3):
            continue
        sim = SequenceMatcher(None, v, core).ratio()
        if (sim >= FUZZY_MIN or (len(v) >= 5 and _one_edit(v, core))) and (best is None or sim > best.score):
            best = NameMatch(canon, sim * 0.9, text)
    return best


# Sprint 11: labels of open ground (a face holding one of them is a garden / terrace, not a room of the house)
OUTDOOR_WORDS: tuple[str, ...] = tuple(
    normalise(w) for w in ("דשא", "צמחייה", "צמחיה", "ערוגה", "גינה", "בריכה", "ריצוף חוץ", "שטח מרוצף", "גבול מגרש", "קו מגרש")
)


def is_outdoor_label(text: str) -> bool:
    """A text that labels open ground ("דשא", "ערוגה עם צמחייה", "שטח מרוצף")."""
    if not text or not _HEB.search(text) or len(text) > 40:
        return False
    n = _DIGITS.sub("", normalise(text))
    bounds = _word_bounds(text)
    return any(_at_word_bounds(n, w, bounds) for w in OUTDOOR_WORDS)


# Sprint 14 — keep: a label printed as separate words ("חדר" | "שינה": two text items on one baseline, as the SHX / CAD
# text of the construction sheets comes) is read as the phrase it is. Words of one line are chained right to left
# (Hebrew reading order) when they share a baseline and a text height and the gap is a word space.
STITCH_BASELINE_H = 0.4  # baseline offset allowed, in text heights
STITCH_GAP_H = 2.5  # gap between two words of one label, in text heights
STITCH_HEIGHT_RATIO = 1.35
STITCH_MAX_WORDS = 8


@dataclass(frozen=True)
class WordBox:
    x0: float
    y0: float
    x1: float
    y1: float
    text: str
    conf: float


def stitch_words(words: list[WordBox]) -> list[WordBox]:
    """Phrases of two or more neighbouring words on one baseline (maximal chains only, right to left)."""
    ws = [w for w in words if _HEB.search(w.text) and len(w.text) <= 25 and (w.y1 - w.y0) > 0.2]
    ws.sort(key=lambda w: -w.x1)
    used_next: set[int] = set()
    nxt: dict[int, int] = {}
    for i, a in enumerate(ws):
        ha = a.y1 - a.y0
        best: tuple[float, int] | None = None
        for j, b in enumerate(ws):
            if j == i or j in used_next:
                continue
            hb = b.y1 - b.y0
            if max(ha, hb) / max(min(ha, hb), 1e-6) > STITCH_HEIGHT_RATIO:
                continue
            if abs((a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2) > STITCH_BASELINE_H * max(ha, hb):
                continue
            gap = a.x0 - b.x1
            if gap < -0.3 * max(ha, hb) or gap > STITCH_GAP_H * max(ha, hb):
                continue
            if b.x1 > a.x1:
                continue  # b must lie to the left of a
            if best is None or gap < best[0]:
                best = (gap, j)
        if best is not None:
            nxt[i] = best[1]
            used_next.add(best[1])
    heads = [i for i in range(len(ws)) if i not in used_next]
    out: list[WordBox] = []
    for h in heads:
        chain = [h]
        while chain[-1] in nxt and len(chain) < STITCH_MAX_WORDS:
            chain.append(nxt[chain[-1]])
        if len(chain) < 2:
            continue
        parts = [ws[k] for k in chain]
        out.append(
            WordBox(
                min(p.x0 for p in parts),
                min(p.y0 for p in parts),
                max(p.x1 for p in parts),
                max(p.y1 for p in parts),
                " ".join(p.text for p in parts),
                min(p.conf for p in parts),
            )
        )
    return out
