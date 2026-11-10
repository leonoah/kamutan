"""BOQ rule kind ``lighting_circuit`` (Sprint 10, Worker-Lighting): the "נק' מאור …" lines from the circuits.

Rule doc (``orgs/{o}/boqRules``, mirrored request in packages/contracts/NOTES.md)::

    {kind: "lighting_circuit", match: {wording: "auto"|"topology"|"set", includeTimer: true, includeNoSwitch: true},
     itemCode: null, itemDescription: "נק' מאור לפי מעגלי הדלקה", unit: "יחידה", priority: 250}

The designer writes the lighting points in one of two wordings and the org's library tells which (``wording: auto``):

* **topology** — one line per switching topology: "נק' מאור בודדה כוללת מפסק", "שתי נק' מאור כוללות מפסק בודד
  משותף", "נק' מאור בודדה כוללת שני מפסקים מחליפים", "… שלושה מפסקים מצלבים", "… ללא מפסק (אפס קבוע)" (per fixture),
  "N נק' מאור כוללות מפסק טיימר משותף בלוח חשמל", "הזנות נק' מאור לתאורות דוקרנים …", "… עם אוטומט חדר מדרגות"
  (achituv, yahav, Noah's 4.09–4.16);
* **set** — "נק' מאור בודדה" once per circuit plus "סט: שירשור N נק' מאור משותפות במעגל הדלקה אחד" (unit סט) once
  per circuit of N ≥ 2 fixtures (rubel).

Library items are matched **structurally** (fixture count, switch count, timer / stair words parsed from the
item's description — :func:`parse_light_item`), never by text similarity: "שתי נק' מאור כוללות שני מפסקים מחליפים"
and "שתי נק' מאור כוללת מפסק בודד משותף" are near-identical strings. A topology the library lacks becomes an
unmatched (red, "אין פריט בספרייה") line with the designer's wording, so nothing is folded into a wrong line.

Circuits of one tag drawn on several sheets are merged: the stair fixtures appear on both floors' plans (same
count on both → one set of fixtures), a two-way's positions are one per floor; a sheet that compiles all floors
("תאורה - כל הקומות") is used only for tags no floor sheet has; the same letter on far-apart floors is two circuits.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from ..boq.dedup import Det
from ..boq.rules import Item, Library, Rule
from ..boq.units import Unit
from ..textitems.normalize import normalize
from .circuits import CIRCUIT_KINDS

KIND = "lighting_circuit"
R_MERGED_DIFF = "ספירת גופים שונה בין גיליונות"
R_NO_WORDING = "אין ניסוח מתאים בספרייה"
R_STAIR_FALLBACK = "אוטומט חדר מדרגות — נספר כמחליפים"
R_TIMER_FALLBACK = "מעגל טיימר — נספר ללא מפסק"
R_GARDEN_TIMER = "מעגל טיימר ללא שורה לפי מספר גופים — שויך לתאורת דוקרנים"

# worker default (not in contracts DEFAULT_BOQ_RULES yet — request published in packages/contracts/NOTES.md)
DEFAULT_RULE_DOC: dict[str, Any] = {
    "id": "r_lighting_circuit",
    "kind": KIND,
    "match": {"wording": "auto", "includeTimer": True, "includeNoSwitch": True},
    "itemCode": None,
    "itemDescription": "נק' מאור לפי מעגלי הדלקה",
    "unit": "יחידה",
    "priority": 250,
}

_HE_NUM = {
    "בודדה": 1, "בודד": 1, "אחת": 1, "אחד": 1,
    "שתי": 2, "שני": 2, "שניים": 2, "שתיים": 2,
    "שלוש": 3, "שלושה": 3, "ארבע": 4, "ארבעה": 4, "חמש": 5, "חמישה": 5, "שש": 6, "שישה": 6,
    "שבע": 7, "שבעה": 7, "שמונה": 8, "תשע": 9, "תשעה": 9, "עשר": 10, "עשרה": 10,
}  # fmt: skip
_NUM_HE = {1: "בודדה", 2: "שתי", 3: "שלוש", 4: "ארבע", 5: "חמש", 6: "שש", 7: "שבע", 8: "שמונה", 9: "תשע", 10: "עשר"}
_NUM_HE_M = {2: "שני", 3: "שלושה", 4: "ארבעה", 5: "חמישה", 6: "שישה"}
_POINT = re.compile(r"(?:נק'|נק\"|נקודת|נקודות|נק)\s*מאור")
_SET = re.compile(r"שירשור\s*(\S+)\s*(?:נק'|נק\"|נקודות|נק)\s*מאור")


def _word_num(w: str) -> int | None:
    w = w.strip("()[]:,.")
    if w.isdigit():
        return int(w)
    return _HE_NUM.get(w)


@dataclass(frozen=True)
class LightItem:
    """Structure of a lighting-point library line (see :func:`parse_light_item`)."""

    fixtures: int  # points in the line (1 for "נק' מאור בודדה"; 0 = any, the garden-spike timer line)
    switches: int | None  # 0 = ללא מפסק / timer, 1, 2 = מחליפים, 3 = מצלבים; None = not said (set-wording base line)
    timer: bool = False
    stair: bool = False
    sensor: bool = False
    set_n: int | None = None  # "סט: שירשור N נק' מאור" → N
    existing: bool = False  # "… לנקודת מאור קיימת" (Noah's add-to-existing lines): never ours
    garden: bool = False  # "הזנות נק' מאור לתאורות דוקרנים …": the garden-spike timer circuit (any fixture count)


def parse_light_item(description: str) -> LightItem | None:
    """Parse a library description into its lighting-point structure; None when it is not a lighting-point line
    (fixture installation, profiles, fans, feeds …). The text is :func:`normalize`-d (final letters folded)."""
    t = normalize(description)
    if not _POINT.search(t):
        return None
    m_set = _SET.search(t)
    if m_set:
        n = _word_num(m_set.group(1))
        return LightItem(n or 0, None, set_n=n) if n else None
    if any(w in t for w in ("התקנת גוף", "גופי תאורה", "פרופיל", "מאוורר", "הזנה ל", "החלפת")):
        return None
    existing = "קיימ" in t
    timer = "טיימר" in t or "שעונ שבת" in t  # normalised text: final letters folded
    garden = "דוקרנ" in t
    stair = "אוטומט" in t and "מדרג" in t
    sensor = "חיישנ" in t or "גלאי" in t
    # fixtures: the number word right before "נק' מאור" (or "נקודות מאור")
    m = _POINT.search(t)
    assert m is not None
    before = t[: m.start()].split()
    fixtures = 1
    if before:
        n = _word_num(before[-1])
        if n:
            fixtures = n
    switches: int | None
    if timer or re.search(r"ללא\s*מפסק", t) or "אפס קבוע" in t:
        switches = 0  # a timer in the panel is not a switch position
    elif re.search(r"מצלב", t):
        mm = re.search(r"(\S+)\s*(?:מפסקים\s*)?מצלבים", t)
        switches = (_word_num(mm.group(1)) if mm else None) or 3
    elif re.search(r"מחליפ", t):
        mm = re.search(r"(\S+)\s*(?:מפסקים\s*)?מחליפים", t)
        switches = (_word_num(mm.group(1)) if mm else None) or 2
    elif re.search(r"מפסק", t):
        switches = 1
    else:
        switches = None
    if garden and not (before and _word_num(before[-1])):
        fixtures = 0  # "הזנות נק' מאור לתאורות דוקרנים": no count in the wording
    return LightItem(fixtures, switches, timer, stair, sensor, None, existing, garden)


def _n_he(n: int) -> str:
    return _NUM_HE.get(n, str(n))


def describe(fixtures: int, positions: int, kind: str, *, stair: bool = False) -> str:
    """The designer's wording of a topology (used for unmatched lines)."""
    head = "נק' מאור בודדה" if fixtures == 1 else f"{_n_he(fixtures)} נק' מאור"
    verb = "כוללת" if fixtures == 1 else "כוללות"
    if kind == "timer":
        tail = 'בהדלקה ע"י טיימר בלוח'
    elif kind == "no_switch" or positions == 0:
        tail = "ללא מפסק (אפס קבוע)"
    elif positions == 1:
        tail = f"{verb} מפסק" if fixtures == 1 else f"{verb} מפסק בודד משותף"
    elif positions == 2:
        tail = f"{verb} שני מפסקים מחליפים"
    else:
        tail = f"{verb} {_NUM_HE_M.get(positions, str(positions))} מפסקים מצלבים"
    if stair:
        tail += " עם אוטומט חדר מדרגות"
    return f"{head} {tail}"


def describe_set(n: int) -> str:
    return f"סט: שירשור {_n_he(n) if n <= 10 else n} נק' מאור משותפות במעגל הדלקה אחד"


# ----------------------------------------------------------------------------- library view
@dataclass
class LightLibrary:
    items: list[tuple[Item, LightItem]]

    @staticmethod
    def of(library: Library) -> LightLibrary:
        out = []
        for it in library.items:
            li = parse_light_item(it.description)
            if li is not None and not li.existing:
                out.append((it, li))
        return LightLibrary(out)

    @property
    def wording(self) -> str:
        """``set`` when the library has "סט: שירשור" lines, else ``topology``."""
        return "set" if any(li.set_n for _, li in self.items) else "topology"

    def topology(self, fixtures: int, positions: int, kind: str, stair: bool) -> tuple[Item | None, list[str]]:
        """Best item for a topology + the reasons of any fallback."""
        timer = kind == "timer"
        want_sw = 0 if kind in ("timer", "no_switch") else positions
        cands = [(it, li) for it, li in self.items if li.set_n is None and li.switches is not None]

        def pick(pred: Any) -> Item | None:
            hits = sorted((it for it, li in cands if pred(li)), key=lambda i: (not i.manual, i.id))
            return hits[0] if hits else None

        it = pick(
            lambda li: li.fixtures == fixtures and li.switches == want_sw and li.timer == timer and li.stair == stair
            and not li.sensor and not li.garden
        )  # fmt: skip
        if it is not None:
            return it, []
        reasons: list[str] = []
        if stair:
            it = pick(
                lambda li: (
                    li.fixtures == fixtures and li.switches == want_sw and li.timer == timer and not li.stair and not li.sensor
                )
            )
            if it is not None:
                return it, [R_STAIR_FALLBACK]
        if timer:
            it = pick(lambda li: li.timer and li.garden)
            if it is not None:
                return it, [R_GARDEN_TIMER]
            it = pick(lambda li: li.fixtures == fixtures and li.switches == 0 and not li.timer and not li.sensor)
            if it is not None:
                return it, [R_TIMER_FALLBACK]
        if want_sw == 0:
            it = pick(lambda li: li.fixtures == fixtures and li.switches == 0 and li.sensor)  # "ללא מפסק (חיישן תנועה)"
            if it is not None:
                return it, [R_NO_WORDING]
        return None, reasons

    def set_base(self) -> Item | None:
        hits = sorted(
            (it for it, li in self.items if li.set_n is None and li.fixtures == 1 and li.switches is None), key=lambda i: i.id
        )
        if hits:
            return hits[0]
        hits = sorted(
            (it for it, li in self.items if li.set_n is None and li.fixtures == 1 and li.switches == 1), key=lambda i: i.id
        )
        return hits[0] if hits else None

    def set_item(self, n: int) -> Item | None:
        hits = sorted((it for it, li in self.items if li.set_n == n), key=lambda i: i.id)
        return hits[0] if hits else None


# ----------------------------------------------------------------------------- merge across sheets
@dataclass
class CircuitSheet:
    """One lighting sheet version's circuits artifact and its (de-duplicated) detections."""

    sheet_id: str
    version_id: str
    floors: list[str]
    doc: dict[str, Any]
    dets: dict[str, Det]  # detection id → Det (``dropped_by`` copies may be included; they are skipped)
    discipline: str = "lighting"


@dataclass
class MergedCircuit:
    tag: str
    kind: str
    fixtures: list[Det]
    switches: list[Det]
    positions: int
    floor: str | None
    reasons: list[str]
    timer: bool
    stair: bool
    sheet_ids: list[str]
    position_boxes: list[tuple[str, str, tuple[float, float, float, float]]]  # (sheetId, versionId, bbox) of glyph-less positions
    evidence_level: str = "green"

    @property
    def n(self) -> int:
        return len(self.fixtures)

    @property
    def id(self) -> str:
        return f"c_{self.tag}"


def _compilations(sheets: list[CircuitSheet]) -> set[str]:
    """Sheets that compile other sheets' floors (their tags cover ≥ 80 % of another sheet's tags and more)."""
    tags = {s.sheet_id: {c["tag"] for c in s.doc.get("circuits", [])} for s in sheets}
    out: set[str] = set()
    for a, ta in tags.items():
        for b, tb in tags.items():
            if a == b or not tb or len(ta) <= len(tb):
                continue
            if len(ta & tb) >= 0.8 * len(tb):
                out.add(a)
    return out


_FLOOR_RANK = {"basement": -1, "-1": -1, "ground": 0, "first": 1, "second": 2, "third": 3, "fourth": 4, "roof": 5}


def _floor_ranks(s: CircuitSheet, c: dict[str, Any]) -> set[int]:
    fl = [str(c.get("floor"))] if c.get("floor") and c.get("floor") in _FLOOR_RANK else [str(f) for f in s.floors]
    return {_FLOOR_RANK[f] for f in fl if f in _FLOOR_RANK}


def _adjacent(a: set[int], b: set[int]) -> bool:
    """Two views may be one circuit when their floors are unknown, equal or adjacent (a stair's two-way)."""
    if not a or not b:
        return True
    return min(abs(x - y) for x in a for y in b) <= 1


def merge_circuits(sheets: list[CircuitSheet]) -> tuple[list[MergedCircuit], dict[str, Any]]:
    """One :class:`MergedCircuit` per tag and floor group (see the module docstring)."""
    comp = _compilations(sheets)
    by_tag: dict[str, list[tuple[CircuitSheet, dict[str, Any]]]] = {}
    for s in sheets:
        for c in s.doc.get("circuits", []):
            by_tag.setdefault(str(c["tag"]), []).append((s, c))
        # a switch position whose circuit's fixtures are on another sheet (the stair two-way's second floor)
        for u in (s.doc.get("unmatched") or {}).get("tags", []):
            if u.get("positionIds"):
                view = {"tag": u["tag"], "fixtures": 0, "fixtureIds": [], "positionIds": list(u["positionIds"]), "reasons": []}
                by_tag.setdefault(str(u["tag"]), []).append((s, view))
    merged: list[MergedCircuit] = []
    stats: dict[str, Any] = {
        "tags": len(by_tag),
        "compilationSheets": sorted(comp),
        "mergedAcrossSheets": 0,
        "differingCounts": 0,
        "splitByFloor": 0,
    }
    for tag in sorted(by_tag, key=_tag_sort):
        views = by_tag[tag]
        floor_views = [(s, c) for s, c in views if s.sheet_id not in comp]
        use = floor_views or views
        # floor groups: the same letter is re-used on far-apart floors (achituv: L on the basement and the first
        # floor) — views whose floors are not adjacent are different circuits
        groups: list[list[tuple[CircuitSheet, dict[str, Any]]]] = []
        for v in sorted(use, key=lambda sc: (sorted(_floor_ranks(*sc)) or [99], sc[0].sheet_id)):
            for g in groups:
                if all(_adjacent(_floor_ranks(*v), _floor_ranks(*w)) for w in g):
                    g.append(v)
                    break
            else:
                groups.append([v])
        if len(groups) > 1:
            stats["splitByFloor"] += 1
        for gi, grp in enumerate(groups):
            m = _merge_group(tag if len(groups) == 1 else f"{tag}/{gi + 1}", grp, stats)
            if m is not None:
                merged.append(m)
    stats["circuits"] = len(merged)
    stats["byKind"] = {k: sum(1 for m in merged if m.kind == k) for k in CIRCUIT_KINDS if any(m.kind == k for m in merged)}
    return merged, stats


def _merge_group(tag: str, use: list[tuple[CircuitSheet, dict[str, Any]]], stats: dict[str, Any]) -> MergedCircuit | None:
    # fixtures: equal counts on two sheets = the same fixtures drawn twice (stairs); different = distinct sets
    by_count: dict[int, list[tuple[CircuitSheet, dict[str, Any]]]] = {}
    for s, c in use:
        n = int(c.get("fixtures") or len(c.get("fixtureIds", [])))
        if n:
            by_count.setdefault(n, []).append((s, c))
    fixtures: list[Det] = []
    reasons: list[str] = []
    sheet_ids: list[str] = []
    floors: list[str] = []
    for _n, vs in sorted(by_count.items(), reverse=True):
        s, c = min(vs, key=lambda sc: (not sc[0].floors, sc[0].sheet_id))
        for fid in c.get("fixtureIds", []):
            d = s.dets.get(str(fid))
            if d is not None and d.dropped_by is None:
                fixtures.append(d)
        sheet_ids.append(s.sheet_id)
        if c.get("floor"):
            floors.append(str(c["floor"]))
        for r in c.get("reasons", []):
            if r not in reasons:
                reasons.append(str(r))
    if len(by_count) > 1:
        reasons.append(R_MERGED_DIFF)
        stats["differingCounts"] += 1
    if len({s.sheet_id for s, _ in use}) > 1:
        stats["mergedAcrossSheets"] += 1
    # positions: every sheet's positions are distinct (a stair two-way = one position per floor)
    switches: list[Det] = []
    boxes: list[tuple[str, str, tuple[float, float, float, float]]] = []
    n_pos = 0
    for s, c in use:
        pos_by_id = {p["id"]: p for p in s.doc.get("positions", [])}
        for pid in c.get("positionIds", []):
            p = pos_by_id.get(pid)
            if p is None:
                continue
            n_pos += 1
            ids = [s.dets[str(i)] for i in p.get("switchIds", []) if str(i) in s.dets and s.dets[str(i)].dropped_by is None]
            switches.extend(ids)
            if not ids:
                b = p.get("bboxMm") or {}
                try:
                    boxes.append((s.sheet_id, s.version_id, (float(b["x"]), float(b["y"]), float(b["w"]), float(b["h"]))))
                except (KeyError, TypeError, ValueError):
                    pass
    timer = any(bool(c.get("timer")) for _, c in use) and n_pos == 0
    stair = any(bool(c.get("stairAutomat")) for _, c in use)
    if not fixtures:
        return None
    if n_pos == 0:
        kind = "timer" if timer else "no_switch"
    elif n_pos == 1:
        kind = "single" if len(fixtures) == 1 else "shared"
    elif n_pos == 2:
        kind = "two_way"
    else:
        kind = "cross"
    floor = Counter(floors).most_common(1)[0][0] if floors else None
    det_floors = [d.floor for d in fixtures if d.floor]
    if det_floors:
        floor = Counter(det_floors).most_common(1)[0][0]
    return MergedCircuit(tag, kind, fixtures, switches, n_pos, floor, reasons, timer, stair, sheet_ids, boxes)


def _tag_sort(tg: str) -> tuple[str, int, str]:
    m = re.match(r"([A-Z]+)(\d+)(.*)", tg)
    return (m.group(1), int(m.group(2)), m.group(3)) if m else (tg, 0, "")


# ----------------------------------------------------------------------------- units
@dataclass
class CircuitResult:
    units: list[Unit]
    covered: set[str] = field(default_factory=set)  # sheet ids whose composite link groups are superseded
    stats: dict[str, Any] = field(default_factory=dict)


def covered_sheets(sheets: list[CircuitSheet], *, min_share: float = 0.5) -> set[str]:
    """Sheets where the circuits artifact tags at least ``min_share`` of the luminaires: the link-graph composite
    groups are not counted there (both would price the same points)."""
    out: set[str] = set()
    for s in sheets:
        st = s.doc.get("stats") or {}
        n, tagged = int(st.get("fixtures") or 0), int(st.get("taggedFixtures") or 0)
        if n and tagged / n >= min_share and s.doc.get("circuits"):
            out.add(s.sheet_id)
    return out


def _pos_det(sheet_id: str, version_id: str, idx: int, bbox: tuple[float, float, float, float], floor: str | None) -> Det:
    x, y, w, h = bbox
    return Det(sheet_id, version_id, f"sp_{idx}", "text", x + w / 2, y + h / 2, "yellow", [], floor, "new", None, "lighting",
               1.0, target="text", bbox=bbox)  # fmt: skip


def circuit_units(sheets: list[CircuitSheet], rules: list[Rule], library: Library) -> CircuitResult:
    """Units of the ``lighting_circuit`` rule (the org's, else :data:`DEFAULT_RULE_DOC`) for the project's lighting
    sheets. Returns no units when no sheet carries tagged circuits (Noah: the link graph stays in charge)."""
    sheets = [s for s in sheets if s.doc and s.doc.get("circuits")]
    covered = covered_sheets(sheets)
    # a sheet whose tags cover few of its luminaires is not a tagged plan (Noah: a stray "L1" read out of SHX noise):
    # its circuits are not priced, the link graph stays in charge there
    skipped = sorted(s.sheet_id for s in sheets if s.sheet_id not in covered)
    sheets = [s for s in sheets if s.sheet_id in covered]
    if not sheets:
        return CircuitResult([], set(), {"skippedSheets": skipped} if skipped else {})
    rule = next((r for r in rules if r.kind == KIND), None)
    if rule is None:
        rule = Rule.from_doc(DEFAULT_RULE_DOC["id"], {**DEFAULT_RULE_DOC, "source": "default"})
    assert rule is not None
    m = rule.match
    lib = LightLibrary.of(library)
    wording = str(m.get("wording") or "auto")
    if wording == "auto":
        wording = lib.wording
    include_timer = bool(m.get("includeTimer", True))
    include_no_switch = bool(m.get("includeNoSwitch", True))
    merged, mstats = merge_circuits(sheets)
    units: list[Unit] = []
    for c in merged:
        if c.kind == "timer" and not include_timer:
            continue
        if c.kind == "no_switch" and not include_no_switch:
            continue
        members: list[tuple[Det, str | None]] = [(d, c.id) for d in [*c.fixtures, *c.switches]]
        for i, (sid, vid, bb) in enumerate(c.position_boxes, 1):
            members.append((_pos_det(sid, vid, i, bb, c.floor), c.id))
        circ = {"id": c.id, "kind": c.kind, "fixtures": c.n}
        reasons = list(c.reasons)
        if wording == "set":
            base = lib.set_base()
            if base is not None:
                units.append(Unit(rule, members, 1.0, list(reasons), "green", item=base, floor=c.floor, circuit=circ))
            else:
                units.append(Unit(rule, members, 1.0, list(reasons), "green", unmatched=("X-light-point", "נק' מאור בודדה"),
                                  floor=c.floor, circuit=circ))  # fmt: skip
            if c.n >= 2:
                it = lib.set_item(c.n)
                if it is not None:
                    units.append(Unit(rule, members, 1.0, list(reasons), "green", item=it, floor=c.floor, circuit=circ))
                else:
                    units.append(Unit(rule, members, 1.0, list(reasons), "green", unmatched=(f"X-light-set-{c.n}", describe_set(c.n)),
                                      floor=c.floor, circuit=circ))  # fmt: skip
        else:
            it, fb = lib.topology(c.n, c.positions, c.kind, c.stair)
            qty = 1.0
            if it is None and c.kind == "no_switch" and c.n > 1:
                # אפס קבוע: every fixture is its own point ("נק' מאור בודדה ללא מפסק" × N — achituv 4.32 = 5)
                it, fb = lib.topology(1, 0, c.kind, c.stair)
                qty = float(c.n)
            rs = reasons + [r for r in fb if r not in reasons]
            if it is not None:
                units.append(Unit(rule, members, qty, rs, "green", item=it, floor=c.floor, circuit=circ))
            else:
                code = f"X-light-{c.kind}-{c.n}-{c.positions}".replace("_", "-")
                units.append(Unit(rule, members, 1.0, rs, "green", unmatched=(code, describe(c.n, c.positions, c.kind, stair=c.stair)),
                                  floor=c.floor, circuit=circ))  # fmt: skip
    stats = {**mstats, "wording": wording, "units": len(units), "ruleId": rule.id, "skippedSheets": skipped}
    return CircuitResult(units, covered, stats)


__all__ = [
    "DEFAULT_RULE_DOC",
    "KIND",
    "CircuitResult",
    "CircuitSheet",
    "LightItem",
    "LightLibrary",
    "MergedCircuit",
    "circuit_units",
    "covered_sheets",
    "describe",
    "describe_set",
    "merge_circuits",
    "parse_light_item",
]
