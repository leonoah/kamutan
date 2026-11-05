"""Project level: one quantity per measure key from the ``geometry.json.gz`` documents of a build (pure).

The same wall / stair is drawn on several sheets (the construction and the master plan of a floor; a courtyard stair
on the basement and the ground plan). Rules:

* per floor, measures come from ONE sheet: the best discipline that has the key (construction > architecture >
  master; ``demolished_*`` only from demolition sheets), ties → more items, then sheet id;
* ``stair_treads`` sums distinct stairs: stairs with the same ``key`` (floor | lifecycle | treads | width | going)
  are one stair — the ground plan's view of a stair numbered below ±0.00 already carries the basement floor;
* a drawn height (note "H=", section, opening mark) of an element is shared with the same element on the other
  sheets of its floor (same kind, length within ``SAME_LEN_TOL``) that only have an assumed height — the master plan
  writes "U.K=75 / O.K=210" beside the window the construction plan closes (Sprint 7);
* a key no sheet carries is still returned (``computable: false``, reason "לא נמצא בשרטוטים") so the BOQ can emit a
  suggested line instead of a silent omission.
"""

from __future__ import annotations

import copy
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from .analyze import (
    DRAWN_SOURCES,
    FLOOR_RANK,
    KEYS,
    M2,
    R_NOT_DRAWN_H,
    R_NOT_ON_DWG,
    R_OTHER_SHEET_H,
    WALL_CONVENTION_KEYS,
    measures,
)

RANK = {"construction": 0, "architecture": 1, "architecture_master": 2, "master": 2, "demolition": 5}
R_NONE = "לא נמצא בשרטוטים — להשלמה ידנית"


def _rank(doc: Mapping[str, Any], key: str) -> int:
    disc = str(doc.get("discipline") or "")
    if key.startswith("demolished_"):
        return 0 if disc == "demolition" else 9
    if disc == "demolition":
        return 9
    return RANK.get(disc, 8)


def geometry_units(
    docs: Iterable[Mapping[str, Any]],
    *,
    keys: Sequence[str] | None = None,
    faces: int | None = None,
    height_mode: str | None = None,
) -> list[dict[str, Any]]:
    """``[{key, unit, qty|null, computable, reason, estimate, byFloor, refs: [{sheetId, id}], level, reasons}]``.

    ``faces`` / ``height_mode``: the partition convention of a BOQ rule (``analyze.measures``) — the partition keys are
    re-measured with it and carry ``items`` (``[{sheetId, id, lengthM, heightM, faces, areaM2, reason, …}]``)."""
    docs = share_heights([d for d in docs if isinstance(d, Mapping)])
    want = list(keys) if keys is not None else list(KEYS)
    if (faces is not None or height_mode is not None) and any(k in WALL_CONVENTION_KEYS for k in want):
        docs = [_with_convention(d, faces, height_mode) for d in docs]
    out: list[dict[str, Any]] = []
    for key in want:
        if key == "stair_treads":
            out.append(_stairs(docs))
            continue
        per_floor: dict[str, tuple[tuple[int, int, str], Mapping[str, Any], Mapping[str, Any]]] = {}
        for d in docs:
            r = _rank(d, key)
            if r >= 9:
                continue
            for m in d.get("measures") or []:
                if m.get("key") != key:
                    continue
                fl = str(m.get("floor"))
                sort = (r, -len(m.get("refs") or []), str(d.get("sheetId")))
                if fl not in per_floor or sort < per_floor[fl][0]:
                    per_floor[fl] = (sort, d, m)
        out.append(_combine(key, [(d, m) for _, d, m in sorted(per_floor.values(), key=lambda t: _floor_sort(t[2]))]))
    return out


def _with_convention(doc: Mapping[str, Any], faces: int | None, height_mode: str | None) -> Mapping[str, Any]:
    """The document with its partition measures re-measured by the convention: a re-measured (key, floor) replaces the
    stored one when it is computable; a stored measure that is not (an element without a height: its reason and
    estimate) is kept; every other measure stays as stored."""
    conv = {(m["key"], m.get("floor")): m for m in measures(doc, faces=faces, height_mode=height_mode)
            if m.get("key") in WALL_CONVENTION_KEYS}  # fmt: skip
    out: list[Mapping[str, Any]] = []
    seen: set[tuple[Any, Any]] = set()
    for m in doc.get("measures") or []:
        k = (m.get("key"), m.get("floor")) if isinstance(m, Mapping) else None
        if k is not None and k in conv:
            seen.add(k)
            if conv[k].get("computable"):
                out.append(conv[k])
                continue
        out.append(m)
    out.extend(m for k, m in conv.items() if k not in seen)
    return {**doc, "measures": out}


SAME_LEN_TOL = 0.03  # same element on two sheets: lengths within 3 % (and 5 cm)
_SHARED = ("wallRuns", "lines")


def _same(a: Mapping[str, Any], b: Mapping[str, Any]) -> bool:
    la, lb = float(a.get("lengthM") or 0.0), float(b.get("lengthM") or 0.0)
    if a.get("kind") != b.get("kind") or a.get("floor") != b.get("floor") or la <= 0 or lb <= 0:
        return False
    if abs(la - lb) > max(SAME_LEN_TOL * max(la, lb), 0.05):
        return False
    ta, tb = a.get("thicknessM"), b.get("thicknessM")
    return ta is None or tb is None or abs(float(ta) - float(tb)) <= 0.03


def share_heights(docs: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """Copies of the documents in which an item without a drawn height takes the drawn height of the same item on
    another (non-demolition) sheet of its floor; the measures of a changed document are recomputed. Pure."""
    donors: list[tuple[str, str, Mapping[str, Any]]] = []
    for d in docs:
        if str(d.get("discipline") or "") == "demolition":
            continue
        for coll in _SHARED:
            for it in d.get(coll) or []:
                if isinstance(it, Mapping) and it.get("heightSource") in DRAWN_SOURCES[:-1] and it.get("heightM"):
                    donors.append((str(d.get("sheetId")), coll, it))
    if not donors:
        return list(docs)
    out: list[Mapping[str, Any]] = []
    for d in docs:
        sid = str(d.get("sheetId"))
        if str(d.get("discipline") or "") == "demolition":
            out.append(d)
            continue
        new: dict[str, Any] | None = None
        for coll in _SHARED:
            for k, it in enumerate(d.get(coll) or []):
                if not isinstance(it, Mapping) or it.get("heightSource") in DRAWN_SOURCES:
                    continue
                src = [x for s2, c2, x in donors if s2 != sid and c2 == coll and _same(it, x)]
                hs = {round(float(x["heightM"]), 2) for x in src}
                if len(hs) != 1:
                    continue  # none, or the other sheets disagree
                h = hs.pop()
                if new is None:
                    new = copy.deepcopy(dict(d))
                tgt = new[coll][k]
                tgt["heightM"], tgt["heightSource"] = h, "other_sheet"
                if tgt.get("areaM2") is not None or coll == "wallRuns":
                    tgt["areaM2"] = round(float(tgt["lengthM"]) * h, 3)
                keep = [r for r in tgt.get("reasons") or [] if not str(r).startswith("גובה") and r != R_NOT_DRAWN_H]
                tgt["reasons"] = [*keep, R_OTHER_SHEET_H, *(r for r in src[0].get("reasons") or [] if str(r).startswith("גובה"))][
                    :12
                ]
        if new is not None:
            new["measures"] = measures(new)
            out.append(new)
        else:
            out.append(d)
    return out


def _floor_sort(m: Mapping[str, Any]) -> tuple[int, str]:
    f = str(m.get("floor"))
    return (FLOOR_RANK.get(f, 99), f)


def _combine(key: str, picked: Sequence[tuple[Mapping[str, Any], Mapping[str, Any]]]) -> dict[str, Any]:
    unit = KEYS.get(key, M2)
    if not picked:
        return {"key": key, "unit": unit, "qty": None, "computable": False, "reason": R_NONE, "estimate": None,
                "byFloor": {}, "refs": [], "level": "red", "reasons": [R_NONE]}  # fmt: skip
    comp = all(bool(m.get("computable")) for _, m in picked)
    qty: float | None = None
    by_floor: dict[str, float] = {}
    if comp:
        qty = round(sum(float(m.get("qty") or 0.0) for _, m in picked), 3)
        by_floor = {str(m.get("floor")): round(float(m.get("qty") or 0.0), 3) for _, m in picked}
    ests: list[Mapping[str, Any]] = [e for _, m in picked if isinstance(e := m.get("estimate"), Mapping)]
    est_qty = [float(e["qty"]) for e in ests if e.get("qty") is not None]
    estimate = None
    if not comp and ests:
        estimate = {"qty": round(sum(est_qty), 3) if est_qty else None, "method": str(ests[0].get("method") or "")}
        if not by_floor and est_qty:
            by_floor = {
                str(m.get("floor")): round(float(m["estimate"]["qty"]), 3)
                for _, m in picked
                if m.get("estimate") and m["estimate"].get("qty") is not None
            }
    reason = None if comp else next((str(m.get("reason")) for _, m in picked if m.get("reason")), R_NOT_ON_DWG)
    levels = [str(m.get("level") or "yellow") for _, m in picked]
    level = min(levels, key=lambda x: {"red": 0, "yellow": 1, "green": 2}.get(x, 0))
    reasons = list(dict.fromkeys(r for _, m in picked for r in (m.get("reasons") or [])))[:12]
    refs = [{"sheetId": str(d.get("sheetId")), "id": str(i)} for d, m in picked for i in (m.get("refs") or [])][:128]
    out = {"key": key, "unit": unit, "qty": qty, "computable": comp, "reason": reason, "estimate": estimate,
           "byFloor": by_floor, "refs": refs, "level": level, "reasons": reasons}  # fmt: skip
    if any("items" in m for _, m in picked):
        out["items"] = [{"sheetId": str(d.get("sheetId")), **i} for d, m in picked for i in (m.get("items") or [])][:128]
    return out


def _stairs(docs: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    best: dict[str, tuple[tuple[int, str], Mapping[str, Any], Mapping[str, Any]]] = {}
    for d in docs:
        r = _rank(d, "stair_treads")
        if r >= 9:
            continue
        for s in d.get("stairs") or []:
            if s.get("lifecycle") != "new":
                continue
            k = str(s.get("key"))
            sort = (r, str(d.get("sheetId")))
            if k not in best or sort < best[k][0]:
                best[k] = (sort, d, s)
    # an unnumbered view of a numbered stair (another sheet, same or adjacent floor, same width / going / lifecycle,
    # tread count ± 1) is the same stair
    numbered = [s for _, _, s in best.values() if s.get("numbered")]
    for k in list(best):
        s = best[k][2]
        if s.get("numbered"):
            continue
        for n in numbered:
            if (
                abs(float(n.get("widthM") or 0) - float(s.get("widthM") or 0)) <= 0.1
                and abs(float(n.get("goingM") or 0) - float(s.get("goingM") or 0)) <= 0.03
                and abs(int(n.get("treads") or 0) - int(s.get("treads") or 0)) <= 1
                and abs(FLOOR_RANK.get(str(n.get("floor")), 50) - FLOOR_RANK.get(str(s.get("floor")), 50)) <= 1
            ):
                del best[k]
                break
    if not best:
        return _combine("stair_treads", [])
    by_floor: dict[str, float] = {}
    for _, _d, s in best.values():
        f = str(s.get("floor"))
        by_floor[f] = by_floor.get(f, 0.0) + float(s.get("treads") or 0)
    levels = [str(s.get("level") or "yellow") for _, _, s in best.values()]
    return {
        "key": "stair_treads",
        "unit": KEYS["stair_treads"],
        "qty": float(sum(by_floor.values())),
        "computable": True,
        "reason": None,
        "estimate": None,
        "byFloor": by_floor,
        "refs": [{"sheetId": str(d.get("sheetId")), "id": str(s.get("id"))} for _, d, s in best.values()],
        "level": min(levels, key=lambda x: {"red": 0, "yellow": 1, "green": 2}.get(x, 0)),
        "reasons": list(dict.fromkeys(r for _, _, s in best.values() for r in (s.get("reasons") or [])))[:12],
    }
