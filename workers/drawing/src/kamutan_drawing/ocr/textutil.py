"""Text helpers: visual->logical bidi for Hebrew lines, normalisation, CER."""

from __future__ import annotations

import re
import unicodedata

_HEB = re.compile(r"[֐-׿]")
# characters that form left-to-right runs inside a Hebrew line
_LTR_CORE = re.compile(r"[0-9A-Za-z]")
_LTR_JOIN = set(".,:/=+-%Ø±×*()")


def is_hebrew(ch: str) -> bool:
    return bool(_HEB.match(ch))


def visual_to_logical(visual: str) -> str:
    """Convert a line given in *visual* left-to-right order to logical order.

    Minimal bidi good enough for drawing labels: a line with any Hebrew letter is
    RTL; inside it, maximal runs that contain a digit/Latin letter (plus joiners
    such as ``. : / = + - %``) keep their LTR order. Lines without Hebrew are LTR.
    """
    if not _HEB.search(visual):
        return visual
    rev = visual[::-1]
    out: list[str] = []
    i = 0
    n = len(rev)
    while i < n:
        ch = rev[i]
        joiner_starts = ch in _LTR_JOIN and i + 1 < n and _LTR_CORE.match(rev[i + 1]) and not (i > 0 and is_hebrew(rev[i - 1]))
        if _LTR_CORE.match(ch) or joiner_starts:
            j = i
            while j < n and (_LTR_CORE.match(rev[j]) or rev[j] in _LTR_JOIN or rev[j] == " "):
                # a space only continues the run if more LTR follows
                if rev[j] == " ":
                    k = j
                    while k < n and rev[k] == " ":
                        k += 1
                    if k >= n or not _LTR_CORE.match(rev[k]):
                        break
                j += 1
            run = rev[i:j]
            # trailing joiners that belong to the Hebrew side (e.g. final ':')
            core_end = len(run)
            while core_end > 0 and not _LTR_CORE.match(run[core_end - 1]):
                core_end -= 1
            out.append(run[:core_end][::-1])
            out.append(run[core_end:])
            i = j
        else:
            out.append(ch)
            i += 1
    return "".join(out)


_NORM_MAP = {
    "״": '"',  # gershayim
    "׳": "'",  # geresh
    "’": "'",
    "‘": "'",
    "`": "'",
    "”": '"',
    "“": '"',
    "⌀": "Ø",  # diameter sign
    "ø": "Ø",
    "—": "-",
    "–": "-",
    "−": "-",
}


def normalize(s: str) -> str:
    s = unicodedata.normalize("NFC", s)
    # strip niqqud / cantillation
    s = "".join(ch for ch in s if not (0x0591 <= ord(ch) <= 0x05C7 and ch not in "־"))
    s = "".join(_NORM_MAP.get(ch, ch) for ch in s)
    s = s.replace("''", '"')
    s = re.sub(r"\s+", " ", s).strip()
    return s


def levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def cer_counts(ref: str, hyp: str, ignore_spaces: bool = False) -> tuple[int, int]:
    """(edit distance, reference length) after normalisation."""
    r, h = normalize(ref), normalize(hyp)
    if ignore_spaces:
        r, h = r.replace(" ", ""), h.replace(" ", "")
    return levenshtein(r, h), len(r)
