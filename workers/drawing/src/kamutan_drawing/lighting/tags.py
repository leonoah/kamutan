"""Circuit tags of lighting plans (Sprint 10, Worker-Lighting).

The designer tags every fixture with its switching circuit — a letter and a number (``A1``, ``D6``, ``P10``, ``T2A``,
``i3``) — and writes at each switch position the circuits that position controls: one tag per switch glyph
(``D5``), a range (``A1-A4``), or a comma list in a switch box (``D1,D2,D3,D4``, ``B5, פנוי``, ``T2,T2A,M1,M3``).
Timer circuits are listed in a boxed note (``D6`` / ``D3`` or ``A4 A3 A1``). :func:`parse_tags` turns any such
text into the list of tags it names, expanding ranges and folding the usual read-outs of the SHX glyph reader
(``0``/``O``, ``1``/``I``/``l``, ``8``/``B``, ``5``/``S``; a Hebrew letter read for a Latin one in the letter slot —
one slot only, never both).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# Hebrew words that appear inside switch lists next to tags (spare gang, air-conditioning, shutters …) — never tags
LIST_WORDS = ("פנוי", "מיזוג", "תריס", "מאוורר", "ונטה", "דוד", "חימום", "פעמון", "אזעקה")

# letter-slot read-outs of the glyph reader / typing (Latin lookalikes and the Hebrew letters the SHX reader confuses
# with Latin capitals on the sample sheets)
_LETTER_FOLD = {
    "0": "O",
    "8": "B",
    "5": "S",
    "6": "G",
    "2": "Z",
    "א": "A",
    "צ": "A",
    "ב": "B",
    "ג": "C",
    "ד": "D",
    "ה": "E",
    "ו": "I",
    "ז": "Z",
    "ח": "H",
    "ט": "T",
    "י": "I",
    "כ": "K",
    "ל": "L",
    "מ": "M",
    "נ": "N",
    "ס": "S",
    "פ": "P",
    "ר": "R",
}
# digit-slot read-outs
_DIGIT_FOLD = {"O": "0", "o": "0", "I": "1", "l": "1", "|": "1", "S": "5", "B": "8", "Z": "2", "G": "6", "D": "0", "Q": "0"}

# a tag: one letter, one or two digits, an optional suffix letter (T2A)
_TAG = re.compile(r"(?<![A-Za-zא-ת0-9])([A-Za-zא-ת0-9])(\d{1,2}|[0-9OoIlSBZGDQ|]{1,2})([A-Za-z](?![A-Za-z0-9]))?")
_RANGE = re.compile(r"(?<![A-Za-zא-ת0-9])([A-Za-zא-ת])\s?(\d{1,2})\s*[-–־]\s*(?:([A-Za-zא-ת])\s?)?(\d{1,2})(?![A-Za-z0-9])")
_HEB_WORD = re.compile(r"[א-ת]{2,}")
_HAS_SEP = re.compile(r"[,/\-–־]|\s")
_DATE = re.compile(r"\d{1,2}[/.\-][A-Za-z]{3}[/.\-]\d{2,4}|\d{1,2}[/.]\d{1,2}[/.]\d{2,4}|\d{4}/")
_SCALE = re.compile(r"\b1:\d+")
MAX_RANGE = 12
MAX_TAGS = 40


@dataclass(frozen=True)
class Tag:
    letter: str  # upper-case Latin letter
    number: int
    suffix: str = ""  # "A" of T2A

    @property
    def id(self) -> str:
        return f"{self.letter}{self.number}{self.suffix}"

    def __str__(self) -> str:
        return self.id


@dataclass
class TagRead:
    """What a text names: the tags (in reading order, ranges expanded, duplicates kept once), whether a lookalike
    fold was needed (``corrected``), the Hebrew / other words that were skipped and whether the text is a *list*
    (ranges, commas, several tags) — a fixture carries exactly one tag, a switch position may carry a list."""

    text: str
    tags: list[Tag] = field(default_factory=list)
    corrected: bool = False
    words: list[str] = field(default_factory=list)
    is_list: bool = False

    @property
    def ids(self) -> list[str]:
        return [t.id for t in self.tags]


def _fold_letter(ch: str) -> tuple[str, bool]:
    if "A" <= ch <= "Z":
        return ch, False
    if "a" <= ch <= "z":
        return ch.upper(), False  # i1 / i2 are typed lower-case on the sheets: a case fold is not a correction
    f = _LETTER_FOLD.get(ch)
    return (f, True) if f else ("", False)


def _fold_digits(s: str) -> tuple[int | None, bool]:
    out, corr = "", False
    for ch in s:
        if ch.isdigit():
            out += ch
        elif ch in _DIGIT_FOLD:
            out += _DIGIT_FOLD[ch]
            corr = True
        else:
            return None, corr
    return (int(out), corr) if out else (None, corr)


def parse_tags(text: str, *, allow_fold: bool = True) -> TagRead:
    """Tags named by ``text`` (see the module docstring). Pure; never raises on odd input."""
    raw = str(text or "")
    read = TagRead(raw)
    t = raw.replace("\xa0", " ").strip()
    if not t or len(t) > 200:
        return read
    read.words = list(_HEB_WORD.findall(t))
    if _DATE.search(t) or _SCALE.search(t):
        return read  # "19/Feb/2025", "1:50" — title-block texts, never tags
    seen: set[str] = set()
    spans: list[tuple[int, int]] = []

    def add(tag: Tag) -> None:
        if tag.id not in seen and len(read.tags) < MAX_TAGS:
            seen.add(tag.id)
            read.tags.append(tag)

    # ranges first ("A1-A4", "N1-N4", "B1 - B5", "A1-4")
    for m in _RANGE.finditer(t):
        l1, corr1 = _fold_letter(m.group(1))
        l2, corr2 = _fold_letter(m.group(3)) if m.group(3) else (l1, False)
        if not l1 or not l2 or l1 != l2 or ((corr1 or corr2) and not allow_fold):
            continue
        a, b = int(m.group(2)), int(m.group(4))
        if b < a or b - a > MAX_RANGE:
            continue
        read.corrected |= corr1 or corr2
        read.is_list = True
        for n in range(a, b + 1):
            add(Tag(l1, n))
        spans.append(m.span())

    def covered(s: int, e: int) -> bool:
        return any(a <= s < b for a, b in spans)

    for m in _TAG.finditer(t):
        if covered(m.start(), m.end()):
            continue
        letter, corr_l = _fold_letter(m.group(1))
        if not letter:
            continue
        num, corr_d = _fold_digits(m.group(2))
        if num is None or num < 1:
            continue  # circuits are numbered from 1: "L0" / "O0" are glyph-reader crumbs
        corr = corr_l or corr_d
        if corr and not allow_fold:
            continue
        if corr_l and corr_d:
            continue  # both slots folded = a crumb of the glyph reader ("ב |"), not a tag
        if corr_l and not ("A" <= m.group(1) <= "Z" or "a" <= m.group(1) <= "z") and not m.group(2).isdigit():
            continue
        # a pure digit pair ("10", "30") must never become a tag: the letter slot was a digit AND the digits were digits
        if m.group(1).isdigit() and m.group(2).isdigit():
            continue
        read.corrected |= corr
        add(Tag(letter, num, (m.group(3) or "").upper()))
    if len(read.tags) > 1 or (read.tags and _HAS_SEP.search(t) and ("," in t or "/" in t)):
        read.is_list = True
    return read


def is_tag_only(text: str) -> bool:
    """``text`` is nothing but tags, separators and list words (a tag label or a switch list), not a sentence."""
    t = str(text or "")
    rest = _RANGE.sub(" ", t)
    rest = _TAG.sub(" ", rest)
    for w in LIST_WORDS:
        rest = rest.replace(w, " ").replace(w[::-1], " ")
    rest = re.sub(r"[\s,/\-–־.:;()]+", "", rest)
    return rest == "" and bool(parse_tags(t).tags)


def looks_like_tag_label(text: str) -> bool:
    """A single fixture / switch tag label ("A1", "T2A", "i3"), possibly with a lookalike fold."""
    r = parse_tags(text)
    return len(r.tags) == 1 and not r.is_list and is_tag_only(text) and not r.words


__all__ = ["LIST_WORDS", "Tag", "TagRead", "is_tag_only", "looks_like_tag_label", "parse_tags"]
