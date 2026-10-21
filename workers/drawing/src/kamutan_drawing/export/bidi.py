"""Minimal bidirectional reordering for one line of Hebrew UI text (RTL paragraph), for PDF text drawing.

ReportLab draws code points left to right as given, so Hebrew must be passed in *visual* order. Hebrew needs
no contextual shaping (final letters are separate code points); what is needed is the Unicode Bidirectional
Algorithm for a single line in an RTL paragraph (embedding level 1), restricted to what BOQ text contains:
Hebrew, Latin, European digits with separators (4.10, 1:50, 12.5%, 16A), neutrals and brackets. Rules used
(UAX #9 subset): W2–W7 numbers (ES/CS between digits, ET next to digits join the number), N1/N2 (neutrals
between same-direction strong types take that direction, EN counts as R, otherwise the embedding direction R),
I2 (L and EN → level 2), L2 (reverse runs ≥ level 2, then the whole line), L4 (mirror brackets at odd levels).
Combining marks (nikud) stay attached to their base. Pure Python, no dependency (python-bidi is LGPL).
"""

from __future__ import annotations

import unicodedata

_MIRROR = {"(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<", "«": "»", "»": "«"}
_ES = frozenset("+-−")
_CS = frozenset(".,:/ ")
_ET = frozenset("%#$₪°′″±‰")


def _cls(ch: str) -> str:
    o = ord(ch)
    if 0x0590 <= o <= 0x05FF or 0xFB1D <= o <= 0xFB4F or 0x07C0 <= o <= 0x08FF:
        return "R"
    if 0x0600 <= o <= 0x06FF:
        return "R"
    if ch.isdigit() and o < 0x0660:
        return "EN"
    if ch in _ES:
        return "ES"
    if ch in _CS:
        return "CS"
    if ch in _ET:
        return "ET"
    if ch.isspace():
        return "WS"
    if ch == "\u200f":  # RLM
        return "R"
    if ch == "\u200e":  # LRM
        return "L"
    cat = unicodedata.category(ch)
    if cat[0] == "L":
        return "L"
    return "ON"


def _clusters(text: str) -> list[str]:
    out: list[str] = []
    for ch in text:
        if out and unicodedata.combining(ch):
            out[-1] += ch
        else:
            out.append(ch)
    return out


def visual(text: str) -> str:
    """Visual (left-to-right drawing) order of ``text`` laid out in an RTL paragraph."""
    if not text:
        return text
    cl = _clusters(text)
    t = [_cls(c[0]) for c in cl]
    n = len(t)
    # W4: single ES between EN, single CS between EN → EN
    for i in range(1, n - 1):
        if t[i] in ("ES", "CS") and t[i - 1] == "EN" and t[i + 1] == "EN":
            t[i] = "EN"
    # W5: ET sequences adjacent to EN → EN
    i = 0
    while i < n:
        if t[i] == "ET":
            j = i
            while j < n and t[j] == "ET":
                j += 1
            if (i > 0 and t[i - 1] == "EN") or (j < n and t[j] == "EN"):
                for k in range(i, j):
                    t[k] = "EN"
            i = j
        else:
            i += 1
    # W6: remaining separators / terminators → neutral
    t = ["ON" if x in ("ES", "CS", "ET") else x for x in t]
    # numbers right after Latin stay in the Latin run (W7, before N1: EN after L → L)
    last_strong = "R"
    for i in range(n):
        if t[i] in ("L", "R"):
            last_strong = t[i]
        elif t[i] == "EN" and last_strong == "L":
            t[i] = "L"
    # N1/N2: neutrals (ON, WS) take the surrounding direction when both sides agree (EN counts as R) else R
    strong = ["R" if x == "EN" else x for x in t]
    i = 0
    while i < n:
        if t[i] in ("ON", "WS"):
            j = i
            while j < n and t[j] in ("ON", "WS"):
                j += 1
            before = strong[i - 1] if i > 0 else "R"
            after = strong[j] if j < n else "R"
            d = before if before == after else "R"
            for k in range(i, j):
                t[k] = d
            i = j
        else:
            i += 1
    levels = [2 if x in ("L", "EN") else 1 for x in t]
    # L1: trailing whitespace goes to the paragraph level
    k = n - 1
    while k >= 0 and cl[k].isspace():
        levels[k] = 1
        k -= 1
    # L2: reverse from the highest level down to 1
    order = list(range(n))
    for lev in (2, 1):
        i = 0
        while i < n:
            if levels[order[i]] >= lev:
                j = i
                while j < n and levels[order[j]] >= lev:
                    j += 1
                order[i:j] = order[i:j][::-1]
                i = j
            else:
                i += 1
    out = []
    for idx in order:
        c = cl[idx]
        if levels[idx] % 2 == 1 and c[0] in _MIRROR:
            c = _MIRROR[c[0]] + c[1:]
        out.append(c)
    return "".join(out)


__all__ = ["visual"]
