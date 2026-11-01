"""Hebrew text normalisation for pattern matching on drawing notes.

:func:`normalize` folds what varies between drawings and the SHX reader without changing meaning: final letters
(ך→כ, ם→מ, ן→נ, ף→פ, ץ→צ), geresh / gershayim / typographic quotes (׳ ’ ` → ', ״ ” “ → "), niqqud, dashes, case
of Latin letters and runs of spaces. Patterns of the catalog and of org rules are normalised the same way before
they are compiled, so they can be written naturally ("נק' קיימת", "צינורות חופשיים").
"""

from __future__ import annotations

import re
import unicodedata
from functools import lru_cache

_FINALS = str.maketrans({"ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ"})
_QUOTES = str.maketrans({"׳": "'", "’": "'", "‘": "'", "`": "'", "´": "'", "״": '"', "”": '"', "“": '"', "„": '"'})
_DASHES = str.maketrans({"–": "-", "—": "-", "־": "-", "‐": "-"})
_NIQQUD = re.compile(r"[֑-ׇ]")
_SPACES = re.compile(r"\s+")
_HEB = re.compile(r"[א-ת]")


def normalize(text: str) -> str:
    """Normalised form of a text (see the module docstring)."""
    t = unicodedata.normalize("NFKC", str(text or ""))
    t = _NIQQUD.sub("", t).translate(_QUOTES).translate(_DASHES).translate(_FINALS).lower()
    return _SPACES.sub(" ", t.replace("\xa0", " ")).strip()


def compact(text: str) -> str:
    """Normalised text without spaces and punctuation (letter-level matching of split / merged words)."""
    return re.sub(r"[\s'\".,:;()\[\]{}|/\\+\-_=]", "", normalize(text))


def has_hebrew(text: str) -> bool:
    return bool(_HEB.search(text or ""))


@lru_cache(maxsize=512)
def compile_pattern(pattern: str) -> re.Pattern[str]:
    """A catalog / rule pattern (regex) compiled against :func:`normalize`-d text. Literal Hebrew in the pattern is
    normalised the same way (finals, quotes); a space matches any run of spaces / line joins (" / ") / nothing."""
    p = normalize(pattern).replace(" ", r"[\s/]*")
    return re.compile(p)


# Detail references ("פרט A", "פרט 3") — the SHX reader mixes up a few glyph pairs inside this short word
# (measured on the sample set: פ→ס, ר→ך/ד; the Latin letter A read as א or ץ).
DETAIL_WORD = r"(?:[פס][רכד]ט)"
_DETAIL_REF = re.compile(DETAIL_WORD + r"\s*['\"]?\s*([a-z0-9]{1,2}|[א-ת](?![א-ת]))")
_LETTER_FOLD = {"א": "a", "צ": "a", "ב": "b", "ג": "c", "ד": "d"}


def detail_refs(text: str) -> list[tuple[str, int, int]]:
    """``(letter, start, end)`` of every detail reference in a normalised text (letter folded: א/ץ → a)."""
    out = []
    for m in _DETAIL_REF.finditer(normalize(text)):
        s = m.group(1)
        out.append((_LETTER_FOLD.get(s, s), m.start(), m.end()))
    return out


SCALE_TEXT = re.compile(r"קנ\s*[\"']?\s*מ|1\s*:\s*\d{1,3}\b")


def is_detail_title(text: str) -> bool:
    """A detail box title ("פרט א קנ"מ 1:20") — the definition, not a reference to it."""
    n = normalize(text)
    return bool(detail_refs(n)) and bool(SCALE_TEXT.search(n))
