"""Hebrew text normalisation shared by the BOQ modules (import-light: no other boq module imports here).

:func:`norm_he` is the exact port of contracts ``normalizeHebrewText`` (takeoff.ts); the Sprint-6 ``textitems`` module
re-exports it.
"""

from __future__ import annotations

import re
import unicodedata

_FINALS = str.maketrans({"ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ"})
_NIQQUD = re.compile("[֑-ֽֿ-ׇ]")
_DASH = re.compile("[־–—]")
_GERESH = re.compile("[׳’‘`´]")
_GERSHAYIM = re.compile("[״”“„]")
_WS = re.compile("[\\s\u00a0\u200e\u200f]+")


def norm_he(s: str) -> str:
    """Port of contracts ``normalizeHebrewText`` (same order): NFC → niqqud / cantillation removed (maqaf kept) → maqaf /
    en / em dash → "-" → final letters → regular → geresh variants → "'" → gershayim variants and "''" → '"' → lower
    case → whitespace runs (NBSP, LRM, RLM incl.) → one space, trimmed."""
    t = unicodedata.normalize("NFC", s)
    t = _NIQQUD.sub("", t)
    t = _DASH.sub("-", t)
    t = t.translate(_FINALS)
    t = _GERESH.sub("'", t)
    t = _GERSHAYIM.sub('"', t).replace("''", '"')
    t = t.lower()
    return _WS.sub(" ", t).strip()
