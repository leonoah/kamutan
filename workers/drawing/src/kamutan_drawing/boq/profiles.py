"""LED lighting-profile lines from the drawn profile bars (Sprint 13, Worker-Areas). Pure.

``circuits.json.gz`` carries ``profiles`` (lighting/profiles.py: kind, paper length, parts). The client's library prices
profiles either per metre (one line per kind: surface / recessed in gypsum / water-protected) or per unit, one line per
nominal length ("… באורך 800 ס"מ" — the designer rounds the drawn length). ``profile_quantities`` gives one quantity
per library item; a profile whose kind / length has no line is left out (counted in the stats).
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from . import descmatch
from .rules import Item

R_PROFILE_LENGTH = "אורך פרופיל התאורה נמדד מהפס המשורטט"
R_PROFILE_UNIT = "פרופיל תאורה לפי אורכו המשורטט ({m:.2f} מ')"
R_PROFILE_NO_LABEL = 'סוג הפרופיל לא כתוב ליד הפס — חיצוני עה"ט'
SURFACE, RECESSED, WATER = "surface", "recessed", "water"
KINDS = (SURFACE, RECESSED, WATER)
LENGTH_UNITS = frozenset({'מ"א', "מא", "m", "מטר"})
COUNT_UNITS = frozenset({"יחידה", "יח'", "יח"})
NOMINAL_TOL = 0.10  # a per-unit line names the nominal (rounded) length of the drawn profile
_PROFILE = re.compile(r"פרופיל")
_LIGHT = re.compile(r"תאורה|לד|שקוע|מוגנ מימ")
_NOT = re.compile(r"str|פאנל|אלומיניומ לחלונ|מעקה")
_WATER = re.compile(r"מוגנ מימ")
_RECESSED = re.compile(r"שקוע")
_LEN_CM = re.compile(r"באורכ\s*(\d{2,4})\s*ס")


@dataclass(frozen=True)
class ProfileItem:
    item: Item
    kind: str
    nominal_m: float | None  # per-unit line: its nominal length
    per_metre: bool


def profile_item(item: Item) -> ProfileItem | None:
    t = descmatch.canon(item.description)
    if not _PROFILE.search(t) or not _LIGHT.search(t) or _NOT.search(t.lower()):
        return None
    unit = (item.unit or "").strip()
    kind = WATER if _WATER.search(t) else RECESSED if _RECESSED.search(t) else SURFACE
    m = _LEN_CM.search(t)
    if unit in LENGTH_UNITS:
        return ProfileItem(item, kind, None, True)
    if unit in COUNT_UNITS and m:
        return ProfileItem(item, kind, int(m.group(1)) / 100.0, False)
    return None


@dataclass
class ProfileQty:
    item: Item
    qty: float
    members: list[tuple[str, str, float]]  # (sheet id, profile id, length m)
    reasons: list[str]


def source_sheets(sheets: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """Sheets whose profiles count: a sheet that shows several floors repeats the single-floor sheets of those floors."""
    single = {fl[0] for s in sheets if len(fl := list(s.get("floors") or [])) == 1 and s.get("profiles")}
    out = []
    for s in sheets:
        fl = list(s.get("floors") or [])
        if len(fl) > 1 and all(f in single for f in fl):
            continue
        out.append(s)
    return out


def profile_quantities(sheets: Sequence[Mapping[str, Any]], items: Sequence[Item]) -> tuple[list[ProfileQty], dict[str, int]]:
    """``sheets``: ``{sheetId, floors, scale, profiles}`` of the lighting sheets."""
    stats = {"profiles": 0, "priced": 0, "noLine": 0, "tape": 0}
    lib = [pi for it in items if (pi := profile_item(it)) is not None]
    runs: list[tuple[str, str, str, float, bool]] = []
    for s in source_sheets(sheets):
        k = float(s.get("scale") or 50) / 1000.0
        for p in s.get("profiles") or []:
            if p.get("kind") == "tape":
                stats["tape"] += 1
                continue
            if p.get("kind") in KINDS and float(p.get("lengthMm") or 0) > 0:
                runs.append((str(s["sheetId"]), str(p["id"]), str(p["kind"]), float(p["lengthMm"]) * k, bool(p.get("labelled"))))
    stats["profiles"] = len(runs)
    if not lib or not runs:
        stats["noLine"] = len(runs)
        return [], stats
    out: dict[str, ProfileQty] = {}
    left = list(runs)
    # per-metre lines: one line of the kind takes every profile of that kind
    for kind in KINDS:
        metre = [pi for pi in lib if pi.per_metre and pi.kind == kind]
        if len(metre) != 1:
            continue
        mine = [r for r in left if r[2] == kind]
        if not mine:
            continue
        left = [r for r in left if r[2] != kind]
        rs = [R_PROFILE_LENGTH] + ([R_PROFILE_NO_LABEL] if any(not r[4] for r in mine) and kind == SURFACE else [])
        out[metre[0].item.id] = ProfileQty(
            metre[0].item, round(sum(r[3] for r in mine), 3), [(r[0], r[1], r[3]) for r in mine], rs
        )
    # per-unit lines: each line is ONE profile of its nominal length — nearest first, one profile per line
    cand = sorted(
        (abs(r[3] - pi.nominal_m) / pi.nominal_m, ri, li)
        for ri, r in enumerate(left)
        for li, pi in enumerate(lib)
        if not pi.per_metre and pi.nominal_m and pi.kind == r[2] and abs(r[3] - pi.nominal_m) <= NOMINAL_TOL * pi.nominal_m
    )
    used_r: set[int] = set()
    used_l: set[int] = set()
    for _, ri, li in cand:
        if ri in used_r or li in used_l:
            continue
        used_r.add(ri)
        used_l.add(li)
        r, pi = left[ri], lib[li]
        out[pi.item.id] = ProfileQty(pi.item, 1.0, [(r[0], r[1], r[3])], [R_PROFILE_UNIT.format(m=r[3])])
    stats["priced"] = sum(len(q.members) for q in out.values())
    stats["noLine"] = len(runs) - stats["priced"]
    return list(out.values()), stats
