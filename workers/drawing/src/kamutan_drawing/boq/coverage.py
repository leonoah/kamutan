"""Sprint 6: BOQ coverage against the org's library (build ``stats.coverage``) — pure.

``{libraryCodes, produced, suggested, missing[], byChapter: {chapter: {libraryCodes, produced, suggested, missing}}}``:

* ``libraryCodes`` — distinct codes of the org's active library items (the imported client BOQ / template, or the
  shipped default library);
* ``produced`` — codes with a line whose quantity came from the drawings or a human (origin detected / text /
  geometry / manual; a pre-Sprint-6 line without ``origin`` counts as produced);
* ``suggested`` — codes whose only lines are suggested (origin ``suggested``: "להשלמה ידנית" / "הצעה – לאשר ידנית");
* ``missing`` — codes with no line at all (sorted, ≤ :data:`MAX_MISSING`). The Sprint-6 goal is ``missing == []``;
* ``byChapter`` — the same counts per chapter (key = contracts ``chapterKey``: "04" → "4"), ``missing`` as a count.

Obsolete lines kept at qty 0 (``הסעיף לא נמצא בבנייה האחרונה``) do not count as present.
"""

from __future__ import annotations

import re
from typing import Any

from .rules import R_OBSOLETE, Library, _code_sort

MAX_MISSING = 500


def chapter_key(code: str) -> str:
    """contracts ``chapterKey``: "04" → "4", "A1" → "a1"."""
    t = code.strip().lower()
    return re.sub(r"^0+(?=\w)", "", t)


def coverage(lines: dict[str, dict[str, Any]], library: Library) -> dict[str, Any]:
    chapter_of: dict[str, str] = {}
    for i in library.items:
        chapter_of.setdefault(i.code, chapter_key(i.chapter or i.code.split(".")[0]))
    origins: dict[str, set[str]] = {}
    for d in lines.values():
        code = d.get("code")
        if not isinstance(code, str) or code not in chapter_of:
            continue
        if R_OBSOLETE in (d.get("reasons") or []):
            continue
        origins.setdefault(code, set()).add(str(d.get("origin") or "manual"))
    out: dict[str, Any] = {"libraryCodes": 0, "produced": 0, "suggested": 0, "missing": []}
    by_ch: dict[str, dict[str, Any]] = {}
    for code in sorted(chapter_of, key=_code_sort):
        ch = by_ch.setdefault(chapter_of[code], {"libraryCodes": 0, "produced": 0, "suggested": 0, "missing": []})
        o = origins.get(code)
        key = "missing" if not o else "suggested" if o <= {"suggested"} else "produced"
        for acc in (out, ch):
            acc["libraryCodes"] += 1
            if key == "missing":
                acc["missing"].append(code)
            else:
                acc[key] += 1
    out["missing"] = out["missing"][:MAX_MISSING]
    out["byChapter"] = {k: {**v, "missing": len(v["missing"])} for k, v in sorted(by_ch.items())}
    return out
