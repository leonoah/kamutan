"""Sprint 10: label-qualified class rules, marker add-ons and the lighting-circuit hook (pure).

The designer's chapter 04 is organised by *circuit and target*, not by symbol: one glyph (a feed arrow, a 3-phase
socket, a panel, a cobra run) becomes different BOQ lines depending on the text written next to it ("הזנה לתריס",
"שקע תלת פאזי למזגן", "לוח חשמל משני", "קוברה 32"). Contracts requests (packages/contracts/NOTES.md "Sprint 10"):

* ``class_to_item.match`` (additive, optional): ``labelPatterns`` / ``excludeLabelPatterns`` (regexes on the
  :func:`~kamutan_drawing.boq.hebrew.norm_he`-d label), ``labelRadiusMm`` (paper mm, default 10 — the detection's
  annotations, its legend label and the OCR lines this close count as its label), ``countOnly`` (the detection is
  counted but NOT consumed: another rule still counts it — "קופסת עומק למפסקים" = one per switch box while the switch
  still builds its lighting point) and ``params`` (``{"length": "label"}``: the drawn / written length in metres is
  passed to the library resolution so the client's "עד 4 מטר" / "עד 6 מטר" bucket is chosen). Rules with
  ``labelPatterns`` get a higher priority than the bare class rule; the first rule whose label matches wins.
* ``marker_addon`` (new kind): ``match = {hostClasses[], markerClasses?[], markerPatterns?[], radiusMm?}`` — one unit
  per live new host detection that has a marker detection of ``markerClasses`` within ``radiusMm`` (paper mm, default
  6) or whose label matches ``markerPatterns`` ("מוגן מים", "IP44", "USB"). Hosts are not consumed (the socket is still
  a socket; the add-on is a second line). Waterproof add-on = sockets AND switches with the marker.
* ``lighting_circuit`` (new kind, Worker-Lighting): produced from ``circuits.json.gz`` by ``lighting.boq.circuit_units``
  (hook ``aggregate._lighting_units``, owned by Worker-Lighting; the covered sheets skip the composite link groups).

A **default** Sprint-10 rule applies only when the org's library has its item (:func:`_usable`): no "לא משויך" noise for
lines the client's BOQ does not have — a label-qualified rule then falls through to the next rule (Noah's heater feeds
stay 4.17 whatever their label says). Custom / user rules always apply.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .dedup import Det
from .hebrew import norm_he
from .rules import NOT_NEW_LIFECYCLES, Rule
from .textitems import compile_pattern
from .units import Unit

DEFAULT_LABEL_RADIUS_MM = 10.0
DEFAULT_MARKER_RADIUS_MM = 6.0
MAX_LABEL_CHARS = 400
R_LABEL = "סווג לפי כיתוב סמוך"  # the label decided the line (≤ 64 chars)
R_MARKER = "תוספת לפי סימון מוגן מים / USB"
R_COUNT_ONLY = "נספר בנוסף לסעיף הסמל"
R_WET_ROOM = "אביזר בחדר רטוב / בחוץ – מוגן מים"

TextLine = tuple[str, float, float, float, float]  # text, x0, y0, x1, y1 (paper mm)
Labeler = Callable[..., str]
Resolvable = Callable[[Rule], bool]


def text_lines(texts: list[dict[str, Any]]) -> list[TextLine]:
    out: list[TextLine] = []
    for t in texts:
        bb = t.get("bboxMm")
        s = str(t.get("text") or "")
        if not s.strip() or not isinstance(bb, list | tuple) or len(bb) != 4:
            continue
        try:
            x0, y0, x1, y1 = (float(v) for v in bb)
        except (TypeError, ValueError):
            continue
        out.append((s, min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)))
    return out


def _box_dist(d: Det, ln: TextLine) -> float:
    _, x0, y0, x1, y1 = ln
    dx = max(x0 - d.x, 0.0, d.x - x1)
    dy = max(y0 - d.y, 0.0, d.y - y1)
    return math.hypot(dx, dy)


def make_labeler(texts_by_sheet: dict[str, list[TextLine]]) -> Labeler:
    """``labeler(det, radius=10)``: the detection's label = its annotations + its legend label + the OCR lines within
    the radius (nearest first, ≤ 8), normalised (:func:`norm_he`), joined by " | ". Cached per (sheet, id, radius)."""
    cache: dict[tuple[str, str, float], str] = {}

    def label(d: Det, radius: float = DEFAULT_LABEL_RADIUS_MM) -> str:
        k = (d.sheet_id, d.id, radius)
        if k in cache:
            return cache[k]
        parts = [str(a) for a in d.annotations if a]
        if d.legend_label:
            parts.append(d.legend_label)
        near = sorted(
            ((_box_dist(d, ln), ln[0]) for ln in texts_by_sheet.get(d.sheet_id, []) if _box_dist(d, ln) <= radius),
            key=lambda t: (t[0], t[1]),
        )
        parts.extend(s for _, s in near[:8])
        out = norm_he(" | ".join(parts))[:MAX_LABEL_CHARS]
        cache[k] = out
        return out

    return label


def _pats(m: dict[str, Any], key: str) -> list[re.Pattern[str]]:
    return [c for p in m.get(key) or [] if (c := compile_pattern(str(p))) is not None]


def label_matches(rule: Rule, label: str) -> bool:
    """True when the rule has no label filter, or its patterns match (and none of the exclusions do)."""
    pats, excl = _pats(rule.match, "labelPatterns"), _pats(rule.match, "excludeLabelPatterns")
    if not pats and not excl:
        return True
    if any(p.search(label) for p in excl):
        return False
    return not pats or any(p.search(label) for p in pats)


def has_label_filter(rule: Rule) -> bool:
    return bool(rule.match.get("labelPatterns") or rule.match.get("excludeLabelPatterns"))


def label_radius(rule: Rule) -> float:
    r = rule.match.get("labelRadiusMm")
    return float(r) if isinstance(r, int | float) and 0 < float(r) <= 100 else DEFAULT_LABEL_RADIUS_MM


_LEN_M = re.compile(r"(\d+(?:[.,]\d+)?)\s*(?:מטר|מ'|m(?![a-z]))")
_LEN_CM = re.compile(r"(\d+(?:[.,]\d+)?)\s*(?:ס\"מ|סמ|cm)")
_DIAM = re.compile(r"(\d+(?:[.,]\d+)?)\s*(?:מ\"מ|ממ|mm)")


def label_params(rule: Rule, label: str, det: Det) -> dict[str, float] | None:
    """Measured parameters for the library resolution (``match.params``): ``length`` from the label ("3.5 מ'", "350
    ס\"מ") else the detection's own drawn length (``det.length_m``), ``diameter`` from the label ("50 מ\"מ")."""
    want = rule.match.get("params")
    if not isinstance(want, dict):
        return None
    out: dict[str, float] = {}
    if want.get("length"):
        v: float | None = None
        if m := _LEN_M.search(label):
            v = float(m.group(1).replace(",", "."))
        elif m := _LEN_CM.search(label):
            v = float(m.group(1).replace(",", ".")) / 100.0
        elif det.length_m is not None:
            v = det.length_m
        if v is not None and v > 0:
            out["length_m"] = round(v, 3)
    if want.get("diameter") and (m := _DIAM.search(label)):
        out["diameter_mm"] = float(m.group(1).replace(",", "."))
    return out or None


def _live_new(d: Det) -> bool:
    return d.dropped_by is None and d.lifecycle not in NOT_NEW_LIFECYCLES


def _usable(r: Rule, resolvable: Resolvable | None) -> bool:
    return r.source != "default" or resolvable is None or resolvable(r)


@dataclass
class ClassPick:
    rule: Rule | None  # the consuming rule (None = no class rule matched)
    reasons: list[str]
    params: dict[str, float] | None


def pick_class_rule(d: Det, c2i: list[Rule], labeler: Labeler, resolvable: Resolvable | None = None) -> ClassPick:
    """The first ``class_to_item`` rule (priority order) whose classes hold the detection's class, whose label filter
    matches and whose item the library has (:func:`_usable`) — ``countOnly`` rules are skipped here (see
    :func:`count_only_units`). The label is read only for rules that have a label filter or params."""
    label: str | None = None
    for r in c2i:
        if d.cls not in r.classes or r.match.get("countOnly"):
            continue
        if has_label_filter(r) or isinstance(r.match.get("params"), dict):
            label = labeler(d, label_radius(r)) if label is None else label
            if not label_matches(r, label):
                continue
            if not _usable(r, resolvable):
                continue
            return ClassPick(r, [R_LABEL] if has_label_filter(r) else [], label_params(r, label, d))
        if not _usable(r, resolvable):
            continue  # a default Sprint-10 rule whose item the library lacks: the next rule of the class
        return ClassPick(r, [], None)
    return ClassPick(None, [], None)


def count_only_units(dets: list[Det], rules: list[Rule], labeler: Labeler, resolvable: Resolvable | None = None) -> list[Unit]:
    """Units of ``class_to_item`` rules with ``countOnly`` over every live new detection of their classes (consumed or
    not — a switch grouped into a lighting point still has its box). Default rules only when the library has the item."""
    out: list[Unit] = []
    for r in (
        x for x in rules if x.kind == "class_to_item" and x.match.get("countOnly") and x.item_code and _usable(x, resolvable)
    ):
        for d in sorted(dets, key=lambda d: d.key):
            if d.cls not in r.classes or not _live_new(d):
                continue
            if has_label_filter(r) and not label_matches(r, labeler(d, label_radius(r))):
                continue
            out.append(Unit(r, [(d, None)], 1.0, [R_COUNT_ONLY]))
    return out


def marker_units(
    dets: list[Det],
    rules: list[Rule],
    labeler: Labeler,
    resolvable: Resolvable | None = None,
    room_type: Callable[[Det], str | None] | None = None,
) -> tuple[list[Unit], dict[str, Any]]:
    """``marker_addon`` rules: one unit per live new host detection with a marker (detection of ``markerClasses``
    within ``radiusMm`` paper mm, or a label matching ``markerPatterns``), or — Sprint 10, ``roomTypes`` — a host inside a
    room of those types (the designer draws no waterproof mark: every accessory of a wet room / balcony / courtyard is
    waterproof). ``room_type(det)`` gives the canonical room type of a detection. Hosts are never consumed. Default rules
    only when the library has the item."""
    out: list[Unit] = []
    stats: dict[str, Any] = {"rules": 0, "hosts": 0}
    by_sheet: dict[str, list[Det]] = {}
    for d in dets:
        by_sheet.setdefault(d.sheet_id, []).append(d)
    for r in (x for x in rules if x.kind == "marker_addon" and _usable(x, resolvable)):
        m = r.match
        hosts = {str(c) for c in m.get("hostClasses") or []}
        markers = {str(c) for c in m.get("markerClasses") or []}
        pats = _pats(m, "markerPatterns")
        rad = m.get("radiusMm")
        radius = float(rad) if isinstance(rad, int | float) and float(rad) > 0 else DEFAULT_MARKER_RADIUS_MM
        rtypes = {str(t) for t in m.get("roomTypes") or []}
        if not hosts or (not markers and not pats and not rtypes):
            continue
        stats["rules"] += 1
        for d in sorted(dets, key=lambda d: d.key):
            if d.cls not in hosts or not _live_new(d):
                continue
            mark: Det | None = None
            if markers:
                cands = [
                    x for x in by_sheet.get(d.sheet_id, []) if x.cls in markers and math.hypot(x.x - d.x, x.y - d.y) <= radius
                ]
                mark = min(cands, key=lambda x: (math.hypot(x.x - d.x, x.y - d.y), x.key)) if cands else None
            hit = mark is not None or (bool(pats) and any(p.search(labeler(d, radius)) for p in pats))
            in_room = bool(rtypes) and room_type is not None and room_type(d) in rtypes
            if not hit and not in_room:
                continue
            members: list[tuple[Det, str | None]] = [(d, None)]
            if mark is not None:
                members.append((mark, None))
            out.append(Unit(r, members, 1.0, [R_MARKER if hit else R_WET_ROOM], "green" if mark is not None else "yellow"))
            stats["hosts"] += 1
    return out, stats
