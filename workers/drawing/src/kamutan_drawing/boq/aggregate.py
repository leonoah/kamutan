"""Pure aggregation: sheet versions (detections + link groups) + rules + library → BOQ lines + evidence.

Order: prepare detections (legend confirmations, symbol mappings, ignored signatures, confirmed floors) →
cross-sheet de-dup (:mod:`.dedup`) → composite lighting lines from the link graph → lighting install count →
class → item lines → unmatched lines ("לא משויך") → lines (qty, byFloor, level = min of evidence, reasons =
rule reasons + union of evidence reasons, evidence, sourceVersions). Deterministic: every collection is sorted.
"""

from __future__ import annotations

import hashlib
import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field, replace
from typing import Any

from .contracts import LinkGroup
from .corrections import Correction, ManualQty, OldDetections, apply_corrections
from .dedup import Det, SheetMeta, dedup
from .geometry import GeoItem, geometry_units, parse_geometry
from .labeled import count_only_units, make_labeler, marker_units, pick_class_rule, text_lines
from .plumbing import combination_units, consumed_classes, plumbing_units, suggestion_units
from .rules import (
    CLASS_HE,
    CODE_MATCH_MIN,
    FIXTURE_CLASSES,
    FLOOR_ORDER,
    LABEL_RADIUS_MM,
    LABEL_RECLASS,
    NOT_NEW_LIFECYCLES,
    R_ADDED,
    R_DEFAULT_RULE,
    R_FLOOR_UNSURE,
    R_LOW,
    R_MEASURED,
    R_NEEDS_INPUT,
    R_NO_ITEM,
    R_NO_LINKS,
    R_NO_RULE,
    R_NOT_FOR_TOTAL,
    R_RELABELED,
    R_SHARED,
    R_SWITCH_LINK,
    R_TEMPLATE,
    R_UNKNOWN_FLOOR,
    R_UNKNOWN_SYMBOL,
    SHARED_KINDS,
    SPRINT10_RULE_IDS,
    STAIR_WORDS,
    SWITCH_CLASSES,
    UNMATCHED_CHAPTER,
    Item,
    Library,
    Resolution,
    Rule,
    desc_score,
)
from .spaces import Room, canonical_rooms, ceiling_heights, match_room, room_from_doc, settings_by_room
from .suggested import default_quick_action, suggested_units
from .template import SheetRef, template_units
from .textitems import TextEntry, catalog_units, entry_det, sheet_entries, text_item_units
from .tiling import TilingParams, tiling_units
from .units import Unit

LEVEL_RANK = {"red": 0, "yellow": 1, "green": 2}
UNKNOWN_FLOOR = "unknown"
MAX_REASONS = 32


def min_level(*levels: str) -> str:
    return min(levels, key=lambda lv: LEVEL_RANK.get(lv, 0)) if levels else "green"


@dataclass
class SheetInput:
    sheet_id: str
    version_id: str
    discipline: str
    scale: int | None
    floors: list[str]
    page: tuple[float, float, int]
    detections: list[dict[str, Any]]
    links: list[LinkGroup] | None  # None = no links artifact for this version
    confirmed: bool = False
    regions: list[dict[str, Any]] = field(default_factory=list)
    texts: list[dict[str, Any]] = field(default_factory=list)  # kamutan.text/1 lines (only when a label rule may apply)
    rooms: dict[str, str] = field(default_factory=dict)  # roomId -> name
    room_docs: list[dict[str, Any]] = field(default_factory=list)  # kamutan.rooms/1 rooms (Sprint 4 fields optional)
    # Sprint 6: Worker-Text items (kamutan.text-items/1; None = no artifact → OCR lines of `texts`), legend boxes
    # (x, y, w, h — OCR lines inside them have scope "legend") and Worker-Geometry's geometry.json.gz object
    text_items: list[dict[str, Any]] | None = None
    legends: list[tuple[float, float, float, float]] = field(default_factory=list)
    geometry: Any = None
    # Sprint 10 (Worker-Lighting): the version's circuits.json.gz object (kamutan.circuits/1), None = no artifact
    circuits: Any = None


@dataclass
class Contribution:
    key: str  # line key
    rule_id: str | None
    resolution: Resolution | None
    unmatched: tuple[str, str] | None  # (code, description) of an unmatched pseudo item
    floor: str | None
    qty: float
    level: str
    reasons: list[str]
    rule_reasons: list[str]
    evidence: list[tuple[Det, str | None]]
    order_qty: float | None = None
    waste: float | None = None
    ev_qty: dict[str, float] = field(default_factory=dict)
    unit_hint: str | None = None  # unmatched line: the rule's unit (A-LIVE-01: never "יחידה" for an area line)
    origin: str = "detected"  # Sprint 6: detected | text | geometry | suggested | manual
    quick_action: dict[str, str | None] | None = None
    needs_input: bool = False
    circuit: dict[str, Any] | None = None  # Sprint 10 (Worker-Lighting): {id, kind, fixtures} of a lighting circuit


# rule kinds whose lines have no drawn symbol behind them (Sprint 10: dropped when the org library lacks the item)
DERIVED_KINDS = frozenset({"text_item", "one_off_suggestion", "suggested_item", "template_chapter"})

RoomRef = tuple[str | None, str | None, str | None, str | None, str | None]  # (sheetId, roomId, name, type, floor)
MAX_BY_ROOM = 200

# Sprint 6: line origin. A line's origin = "manual" when every contribution is manual, else the first of ORIGIN_ORDER
# among its other contributions; needsInput = origin "suggested".
ORIGINS = ("detected", "text", "geometry", "suggested", "manual")
ORIGIN_ORDER = ("detected", "geometry", "text", "suggested")
KIND_ORIGIN = {
    "text_item": "text",
    "area_item": "geometry",
    "length_item": "geometry",
    "tiling_floor": "geometry",
    "tiling_cladding": "geometry",
    "tiling_corner": "geometry",
    "waterproofing": "geometry",
    "suggested_item": "suggested",
    "one_off_suggestion": "suggested",
    "template_chapter": "suggested",
}


@dataclass
class Line:
    id: str
    chapter: str
    chapter_title: str
    code: str
    description: str
    unit: str
    qty: float  # 0 with needs_input: a suggested line whose quantity a person must enter ("להשלמה ידנית")
    by_floor: dict[str, float]
    level: str
    reasons: list[str]
    evidence: list[dict[str, Any]]
    rule_id: str | None
    item_id: str | None
    source_versions: list[dict[str, str]]
    order_qty: float | None = None
    waste_factor: float | None = None
    by_room: list[dict[str, Any]] = field(default_factory=list)
    origin: str = "detected"
    needs_input: bool = False
    quick_action: dict[str, str | None] | None = None
    # Sprint 8 (cause attribution, lines snapshot only — not a boqLines field): the computed qty per sheet version,
    # [{sheetId, versionId, qty}] sorted; sums to ``qty`` minus what no drawing produced (suggestions, templates).
    by_version: list[dict[str, Any]] = field(default_factory=list)
    # Sprint 10 (Worker-Lighting, contracts additive ``circuit?``): {id, kind, fixtures} when every contribution of the
    # line is a lighting circuit of one kind and fixture count (id = the circuit ids joined with ",")
    circuit: dict[str, Any] | None = None
    # Sprint 10 (contracts request, additive): the item is a "לא לסיכום / לספירה בסוף" line of the client's BOQ — unit
    # price only, never counted in the totals (the API / Excel exclude it)
    not_for_total: bool = False

    def computed_fields(self) -> dict[str, Any]:
        extra: dict[str, Any] = {
            "manualCount": sum(1 for e in self.evidence if e.get("source") == "manual"),
            "byRoom": [dict(r) for r in self.by_room],
            "origin": self.origin,
            "needsInput": self.needs_input,
            "quickAction": dict(self.quick_action) if self.quick_action else None,
        }
        if self.circuit is not None:
            extra["circuit"] = dict(self.circuit)
        if self.order_qty is not None:
            extra.update({"orderQty": self.order_qty, "wasteFactor": self.waste_factor})
        if self.not_for_total:
            extra["notForTotal"] = True
        return {
            **extra,
            "chapter": self.chapter,
            "code": self.code,
            "description": self.description,
            "unit": self.unit,
            "qty": self.qty,
            "floor": None,
            "byFloor": dict(self.by_floor),
            "level": self.level,
            "reasons": list(self.reasons),
            "evidenceCount": len(self.evidence),
            "ruleId": self.rule_id,
            "itemId": self.item_id,
            "sourceVersions": list(self.source_versions),
        }


@dataclass
class Result:
    lines: list[Line]
    stats: dict[str, Any]


# ----------------------------------------------------------------------------- floors
def _in_poly(x: float, y: float, poly: list[dict[str, Any]]) -> bool:
    inside = False
    n = len(poly)
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        ax, ay, bx, by = float(a["x"]), float(a["y"]), float(b["x"]), float(b["y"])
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / ((by - ay) or 1e-12) + ax:
            inside = not inside
    return inside


def confirm_floors(dets: list[dict[str, Any]], regions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The owner confirmed the sheet (floors/regions): floors come from the confirmed regions and the
    ``קומה לא ודאית`` chip is removed. Fallback for Worker-A's ``apply_confirmed_floors``."""
    out = []
    for d in dets:
        d = {**d, "reasons": [r for r in (d.get("reasons") or []) if r != R_FLOOR_UNSURE]}
        c = d.get("centerMm") or {}
        for r in regions:
            poly = r.get("polygonMm") or []
            if r.get("floor") and len(poly) >= 3 and _in_poly(float(c.get("x", 0)), float(c.get("y", 0)), poly):
                d["floor"] = str(r["floor"])
                break
        if not d["reasons"] and d.get("level") != "green":
            if float(d.get("score") or 0) >= 0.85:
                d["level"] = "green"
            else:
                d["reasons"] = [R_LOW]
        out.append(d)
    return out


def effective_regions(floors: list[str], regions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Regions carrying the owner's confirmed floors. The confirmation may replace the sheet's floors without
    sending new regions ("מרתף+קרקע" → basement + first): region floors outside the confirmed list are then
    re-labelled in drawing order (regions sorted by id ↔ confirmed floors in order); one confirmed floor
    labels every region."""
    regs = sorted((r for r in regions if isinstance(r, dict)), key=lambda r: _natural(str(r.get("id", ""))))
    have = [str(r["floor"]) for r in regs if r.get("floor")]
    if not floors or set(have) <= set(floors):
        return regs
    if len(floors) == 1:
        return [{**r, "floor": floors[0]} for r in regs]
    order = list(dict.fromkeys(have))
    if len(order) == len(floors):
        remap = dict(zip(order, floors, strict=True))
        return [{**r, "floor": remap.get(str(r.get("floor")), r.get("floor"))} for r in regs]
    return regs


def apply_confirmation(sheet: SheetInput) -> SheetInput:
    """Confirmed sheet → detections and link groups take the confirmed floors and lose ``קומה לא ודאית``.
    Uses Worker-A's ``links.floors.apply_confirmed_floors`` (same semantics as the understand stage), with
    :func:`effective_regions` so a confirmation that changed the floors without new regions is honoured;
    :func:`confirm_floors` is the fallback when that module is unavailable."""
    if not sheet.confirmed:
        return sheet
    regions = effective_regions(sheet.floors, sheet.regions)
    try:
        from ..links.floors import apply_confirmed_floors
    except ImportError:  # pragma: no cover - Worker-A module missing
        return replace(sheet, detections=confirm_floors(sheet.detections, regions))
    arts: dict[str, Any] = {"detections": {"detections": sheet.detections}}
    if sheet.links is not None:
        arts["links"] = {"groups": [g.model_dump() for g in sheet.links]}
    out = apply_confirmed_floors(arts, {"confirmed": True, "floors": list(sheet.floors), "regions": regions}, regions)
    links = sheet.links
    if sheet.links is not None:
        groups = []
        for g in out["links"]["groups"]:
            g.pop("floor", None)  # in-memory only (not part of kamutan.links/1)
            groups.append(LinkGroup.model_validate(g))
        links = groups
    return replace(sheet, detections=list(out["detections"]["detections"]), links=links)


def prepare(
    sheet: SheetInput, entries: dict[str, dict[str, Any]], mappings: dict[str, dict[str, Any]]
) -> tuple[list[Det], Counter[str]]:
    skipped: Counter[str] = Counter()
    raw = list(sheet.detections)
    out: list[Det] = []
    for d in raw:
        cls = str(d.get("class") or "unknown")
        item_code: str | None = None
        code_rule: str | None = None
        eid = d.get("legendEntryId")
        entry = entries.get(str(eid)) if eid else None
        sig = str(entry.get("signature")) if entry and entry.get("signature") else None
        mapping = mappings.get(sig) if sig else None
        if entry is not None and entry.get("status") == "ignored" and not d.get("_verified"):
            skipped["ignoredEntry"] += 1
            continue
        if mapping is not None and mapping.get("ignored") is True and not d.get("_verified"):
            skipped["ignoredSignature"] += 1
            continue
        corrected = bool(d.get("_userClass"))
        if corrected:
            pass  # a correction's class wins over legend entries / mappings / label rules
        elif entry is not None and entry.get("status") == "confirmed":
            if entry.get("class"):
                cls = str(entry["class"])
            if entry.get("itemCode"):
                item_code, code_rule = str(entry["itemCode"]), f"legend_{eid}"
        elif mapping is not None and mapping.get("class"):
            cls = str(mapping["class"])
        if d.get("_itemCode"):
            item_code, code_rule = str(d["_itemCode"]), str(d.get("_codeRule") or "correction")
        elif item_code is None and mapping is not None and mapping.get("itemCode") and not corrected:
            item_code, code_rule = str(mapping["itemCode"]), f"mapping_{sig}"
        user_class = corrected or (entry is not None and entry.get("status") == "confirmed" and bool(entry.get("class")))
        reasons = [str(r)[:64] for r in (d.get("reasons") or [])]
        if not user_class:
            new = relabel(cls, d, str((entry or {}).get("label") or ""), sheet.texts)
            if new is not None:
                cls = new
                if R_RELABELED not in reasons:
                    reasons.append(R_RELABELED)
        c = d.get("centerMm") or {}
        floor = d.get("floor")
        out.append(
            Det(
                sheet.sheet_id,
                sheet.version_id,
                str(d.get("id")),
                cls,
                float(c.get("x") or 0.0),
                float(c.get("y") or 0.0),
                str(d.get("level") or "red"),
                reasons,
                str(floor) if floor else None,
                str(d.get("lifecycle") or "unknown"),
                str(d["supply"]) if d.get("supply") else None,
                sheet.discipline,
                float(d.get("score") or 0.0),
                item_code,
                code_rule,
                room=sheet.rooms.get(str(d.get("roomId"))) if d.get("roomId") else None,
                annotations=tuple(str(a) for a in (d.get("annotations") or [])),
                room_id=str(d["roomId"]) if d.get("roomId") else None,
                source="manual" if d.get("_source") == "manual" else "auto",
                correction_id=str(d.get("_correctionId") or d.get("_verified") or "") or None,
                verified=bool(d.get("_verified")),
                legend_label=str(entry.get("label"))[:200] if entry is not None and entry.get("label") else None,
                length_m=float(d["lengthM"]) if isinstance(d.get("lengthM"), int | float) and d["lengthM"] > 0 else None,
            )
        )
    out.sort(key=lambda x: _natural(x.id))
    return out, skipped


def _hebrew(s: str) -> bool:
    return sum(1 for ch in s if "\u05d0" <= ch <= "\u05ea") >= 2


def relabel(cls: str, d: dict[str, Any], legend_label: str, texts: list[dict[str, Any]]) -> str | None:
    """:data:`LABEL_RECLASS`: new class from the label next to the symbol (or an unambiguous legend label)."""
    rules = [r for r in LABEL_RECLASS if r[0] == cls]
    if not rules:
        return None
    c = d.get("centerMm") or {}
    x, y = float(c.get("x") or 0.0), float(c.get("y") or 0.0)
    best: tuple[float, str] | None = None
    for t in texts:
        txt, bb = str(t.get("text") or ""), t.get("bboxMm")
        if not _hebrew(txt) or not isinstance(bb, list | tuple) or len(bb) != 4:
            continue
        dx = max(float(bb[0]) - x, 0.0, x - float(bb[2]))
        dy = max(float(bb[1]) - y, 0.0, y - float(bb[3]))
        dist = math.hypot(dx, dy)
        if dist <= LABEL_RADIUS_MM and (best is None or (dist, txt) < best):
            best = (dist, txt)
    for _src, words, excluded, new in rules:
        for label in [best[1]] if best else [legend_label]:
            if any(w in label for w in words) and not any(w in label for w in excluded):
                return new
    return None


def per_sheet_links(sheets: list[SheetInput], sheet_id: str) -> list[LinkGroup]:
    return next((s.links or [] for s in sheets if s.sheet_id == sheet_id), [])


def _floor_rank(f: str | None) -> int | None:
    return FLOOR_ORDER.index(f) if f in FLOOR_ORDER else None


def find_shared_groups(
    sheets: list[SheetInput], per_sheet: dict[str, list[Det]]
) -> tuple[dict[tuple[str, str], tuple[str, str]], set[tuple[str, str]]]:
    """:data:`SHARED_KINDS` groups drawn on two lighting sheets (see rules.py). Returns ({dup: kept}, kept set);
    the kept group is the better-levelled one (ties: sheet id order)."""
    cands: list[tuple[str, LinkGroup, tuple[Any, ...], int, list[Det]]] = []
    for s in sorted(sheets, key=lambda s: s.sheet_id):
        if s.links is None or s.discipline != "lighting":
            continue
        by_id = {d.id: d for d in per_sheet[s.sheet_id]}
        for g in sorted(s.links, key=lambda g: _natural(g.id)):
            if g.kind not in SHARED_KINDS:
                continue
            lum = [by_id[i] for i in g.luminaireIds if i in by_id]
            sw = [by_id[i] for i in g.switchIds if i in by_id]
            types = tuple(sorted({a for d in lum for a in d.annotations if a.startswith("סוג")}))
            rank = _floor_rank(_floor_of(sw + lum))
            if not lum or not types or rank is None:
                continue
            if not all(d.room is None or any(w in d.room for w in STAIR_WORDS) for d in lum):
                continue
            sig = (g.kind, len(g.switchIds), len(g.pointIds) or len(lum), types)
            cands.append((s.sheet_id, g, sig, rank, sw + lum))
    dup: dict[tuple[str, str], tuple[str, str]] = {}
    kept: set[tuple[str, str]] = set()
    for i, (sa, ga, siga, ra, _ma) in enumerate(cands):
        if (sa, ga.id) in dup:
            continue
        for sb, gb, sigb, rb, _mb in cands[i + 1 :]:
            if sb == sa or (sb, gb.id) in dup or (sb, gb.id) in kept or sigb != siga or abs(ra - rb) > 1:
                continue
            a, b = (sa, ga), (sb, gb)
            if LEVEL_RANK[gb.level] > LEVEL_RANK[ga.level]:
                a, b = b, a
            dup[(b[0], b[1].id)] = (a[0], a[1].id)
            kept.add((a[0], a[1].id))
            break
    return dup, kept


def _natural(s: str) -> tuple[Any, ...]:
    return tuple(int(p) if p.isdigit() else p for p in re.split(r"(\d+)", s))


def code_key(code: str) -> tuple[Any, ...]:
    """Natural order of TEXT codes: 4.9 < 4.10 < 4.11 (contracts ``compareItemCodes``)."""
    parts = re.split(r"[.\-/]", code)
    return tuple((0, int(p), len(p)) if p.isdigit() else (1, p, 0) for p in parts)


# ----------------------------------------------------------------------------- composite
@dataclass(frozen=True)
class GroupFeatures:
    kind: str
    switches: int
    points: int
    switch_classes: tuple[str, ...]


def _points(lum: list[Det], merge_mm_real: float, scale: int | None) -> int:
    """Luminaires within ``merge_mm_real`` (real-world mm) of each other form one point (union-find)."""
    if not lum:
        return 0
    if merge_mm_real <= 0:
        return len(lum)
    thr = merge_mm_real / float(scale or 50)
    parent = list(range(len(lum)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(lum)):
        for j in range(i + 1, len(lum)):
            if math.hypot(lum[i].x - lum[j].x, lum[i].y - lum[j].y) <= thr:
                parent[find(i)] = find(j)
    return len({find(i) for i in range(len(lum))})


def group_features(g: LinkGroup, switches: list[Det], lum: list[Det], merge_mm_real: float, scale: int | None) -> GroupFeatures:
    """Rule-matching features. A group whose controlled points are all ceiling fans and that has no 2-way
    switch is a *fan switch* group (``switch_fan`` added to its switch classes): the fan-switch glyph is often
    drawn / detected as a plain switch, the link graph tells what it controls."""
    pts = len(g.pointIds) if g.pointIds else _points(lum, merge_mm_real, scale)
    classes = {s.cls for s in switches}
    if lum and all(d.cls == "ceiling_fan" for d in lum) and "switch_2way" not in classes:
        classes.add("switch_fan")
    return GroupFeatures(g.kind, len(switches), pts, tuple(sorted(classes)))


def match_composite(rules: list[Rule], f: GroupFeatures) -> Rule | None:
    for r in rules:
        if r.kind != "composite_lighting":
            continue
        m = r.match
        if m.get("groupKind") and f.kind != m["groupKind"]:
            continue
        if isinstance(m.get("pointCount"), int | float) and f.points != int(m["pointCount"]):
            continue
        if isinstance(m.get("switchCount"), int | float) and f.switches != int(m["switchCount"]):
            continue
        sw = m.get("switchClasses")
        if sw and not set(sw) & set(f.switch_classes):
            continue
        return r
    return None


def _fallback_groups(dets: list[Det]) -> list[tuple[str, list[Det]]]:
    """No links artifact: one 'single' group per new single switch, 2-way switches paired by proximity
    (same floor), fan switches as 'add_to_existing'. Every such group is red (חושב ללא גרף קישורים)."""
    live = [d for d in dets if d.dropped_by is None and d.lifecycle not in ("existing", "demolish")]
    out: list[tuple[str, list[Det]]] = [("single", [d]) for d in live if d.cls == "switch_single"]
    out += [("add_to_existing", [d]) for d in live if d.cls == "switch_fan"]
    two = [d for d in live if d.cls == "switch_2way"]
    by_floor: dict[str | None, list[Det]] = defaultdict(list)
    for d in two:
        by_floor[d.floor].append(d)
    for fl in sorted(by_floor, key=lambda f: f or ""):
        rest = list(by_floor[fl])
        while len(rest) >= 2:
            a = rest.pop(0)
            j = min(range(len(rest)), key=lambda i: (math.hypot(rest[i].x - a.x, rest[i].y - a.y), rest[i].key))
            out.append(("two_way", [a, rest.pop(j)]))
        out += [("two_way", [d]) for d in rest]
    return out


# ----------------------------------------------------------------------------- main
def _room_outlines(s: SheetInput) -> list[tuple[str | None, list[tuple[float, float]]]]:
    out: list[tuple[str | None, list[tuple[float, float]]]] = []
    for r in s.room_docs:
        try:
            pts = [(float(p["x"]), float(p["y"])) for p in r.get("polygonMm") or []]
        except (KeyError, TypeError, ValueError):
            continue
        if len(pts) >= 3:
            fl = r.get("floor")
            out.append((str(fl) if fl else None, pts))
    return out


def _room_fixtures(
    dets: list[Det], room_index: dict[tuple[str, str], Room], canon: list[Room], locator: Any = None
) -> tuple[dict[str, frozenset[str]], set[str]]:
    """Fixture classes per canonical room (any sheet's fixture mapped by :func:`match_room`, dropped copies
    included: they tell what the room holds) and the floors that have fixture information at all."""
    out: dict[str, set[str]] = defaultdict(set)
    floors: set[str] = set()
    ckeys = {c.key for c in canon}
    for d in dets:
        if d.cls not in FIXTURE_CLASSES or d.cls == "ac_unit":
            continue
        if d.floor:
            floors.add(d.floor)
        r = room_index.get((d.sheet_id, d.room_id)) if d.room_id else None
        c = r if r is not None and r.key in ckeys else None
        if c is None and locator is not None:
            # Sprint 11 (Worker-Rooms) — keep: the fixture's point in the canonical sheet's frame (rooms.crosssheet)
            # says which canonical room holds it; the floor + area match is the fallback (two bathrooms of 5.0 and
            # 5.4 m² swap under an area match)
            c = locator.locate(d.sheet_id, d.floor, d.x, d.y)[1]
        if c is None and r is not None:
            c = match_room(r, canon)
        if c is not None:
            out[c.key].add(d.cls)
    return {k: frozenset(v) for k, v in out.items()}, floors


def _floor_of(members: list[Det]) -> str | None:
    c = Counter(d.floor for d in members if d.floor)
    if not c:
        return None
    return min(c.items(), key=lambda kv: (-kv[1], kv[0]))[0]


def _slug(code: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", code).strip("_") or "x"


def _lighting_units(
    rules: list[Rule], sheets: list[SheetInput], per_sheet: dict[str, list[Det]], library: Library
) -> tuple[list[Unit], set[str], dict[str, Any]]:
    """Sprint 10 (Worker-Lighting) hook: ``lighting.boq.circuit_units`` over the lighting sheets that carry a
    ``circuits`` artifact. No artifact → nothing (the link graph stays in charge, as before Sprint 10); the module's
    own default rule applies when the org has no ``lighting_circuit`` rule."""
    carriers = [s for s in sheets if isinstance(s.circuits, dict) and s.circuits.get("circuits")]
    if not carriers:
        return [], set(), {}
    from ..lighting.boq import CircuitSheet, circuit_units

    cs = [
        CircuitSheet(
            s.sheet_id, s.version_id, list(s.floors), s.circuits, {d.id: d for d in per_sheet.get(s.sheet_id, [])}, s.discipline
        )
        for s in sorted(carriers, key=lambda s: s.sheet_id)
    ]
    res = circuit_units(cs, rules, library)
    return list(res.units), {str(x) for x in res.covered}, dict(res.stats)


def aggregate(
    sheets: list[SheetInput],
    rules: list[Rule],
    library: Library,
    entries: dict[str, dict[str, Any]] | None = None,
    mappings: dict[str, dict[str, Any]] | None = None,
    corrections: list[Correction] | None = None,
    old_detections: OldDetections | None = None,
    room_settings: dict[str, dict[str, Any]] | None = None,
    tiling_params: TilingParams | None = None,
) -> Result:
    entries = entries or {}
    mappings = mappings or {}
    stats: dict[str, Any] = {"sheets": len(sheets), "detections": 0, "skipped": {}}
    all_dets: list[Det] = []
    per_sheet: dict[str, list[Det]] = {}
    skipped: Counter[str] = Counter()
    sheets = [apply_confirmation(s) for s in sheets]
    applied = apply_corrections(sheets, corrections or [], old_detections)
    sheets = applied.sheets
    stats["corrections"] = {**applied.stats, "unmatchedList": applied.unmatched, "appliedIds": applied.applied}
    for s in sorted(sheets, key=lambda s: s.sheet_id):
        dets, sk = prepare(s, entries, mappings)
        skipped.update(sk)
        per_sheet[s.sheet_id] = dets
        all_dets.extend(dets)
    stats["detections"] = len(all_dets)
    metas = {
        s.sheet_id: SheetMeta(s.sheet_id, s.discipline, s.scale, sorted(set(s.floors)), s.page, _room_outlines(s)) for s in sheets
    }
    dd = dedup(all_dets, metas, rules)
    stats["duplicatesRemoved"] = dd.dropped
    stats["secondaryKept"] = dd.secondary_kept
    stats["alignFailed"] = dd.align_failed
    stats["alignments"] = dd.alignments
    rooms_by_sheet = {
        s.sheet_id: [r for d in s.room_docs if (r := room_from_doc(s.sheet_id, s.version_id, s.discipline, d)) is not None]
        for s in sheets
    }
    room_index = {(r.sheet_id, r.id): r for rs in rooms_by_sheet.values() for r in rs}

    # --- Sprint 6: text entries (Worker-Text items, else OCR lines) + geometry features; text_item matching runs here,
    # before every counting rule, so a `consumeNear` rule can take its detection away from the class rules
    def placed(s: SheetInput) -> tuple[Any, Any]:
        regs = effective_regions(s.floors, s.regions) if s.confirmed else s.regions
        regs = [r for r in regs if r.get("floor") and len(r.get("polygonMm") or []) >= 3]
        own = rooms_by_sheet.get(s.sheet_id) or []
        single = s.floors[0] if len(set(s.floors)) == 1 else None

        def floor_of(x: float, y: float) -> str | None:
            return next((str(r["floor"]) for r in regs if _in_poly(x, y, r["polygonMm"])), single)

        def room_of_pt(x: float, y: float) -> str | None:
            return next((r.id for r in own if len(r.polygon) >= 3 and r.contains(x, y)), None)

        return floor_of, room_of_pt

    want_text = any(r.kind in ("text_item", "suggested_item") for r in rules)
    want_geo = any(r.kind in ("area_item", "length_item", "suggested_item") for r in rules)
    text_entries: list[TextEntry] = []
    geo_items: list[GeoItem] = []
    geo_docs: list[dict[str, Any]] = []
    for s in sorted(sheets, key=lambda s: s.sheet_id):
        has_text = want_text and (bool(s.texts) or s.text_items is not None)
        if not has_text and not (want_geo and s.geometry is not None):
            continue
        floor_of, room_of_pt = placed(s)
        if has_text:
            text_entries.extend(sheet_entries(s.sheet_id, s.version_id, s.discipline, s.texts, s.text_items, s.legends,
                                         floor_of, room_of_pt))  # fmt: skip
        if want_geo and s.geometry is not None:
            geo_items.extend(parse_geometry(s.geometry, s.sheet_id, s.version_id, s.discipline, s.scale, floor_of))
            if isinstance(s.geometry, dict):
                geo_docs.append({**s.geometry, "sheetId": s.sheet_id, "versionId": s.version_id, "discipline": s.discipline})
    live = [d for d in all_dets if d.dropped_by is None]
    tx_units, tx_stats = text_item_units(rules, text_entries, live)
    stats["textItems"] = tx_stats

    contribs: list[Contribution] = []
    code_rules: dict[str, Rule] = {}
    for rl in rules:  # rules are sorted by priority: the first rule of a code describes it
        if rl.item_code and rl.item_code not in code_rules:
            code_rules[rl.item_code] = rl
    resolved_cache: dict[tuple[Any, ...], Resolution | None] = {}

    def resolve(code: str | None, desc: str, trust: bool, params: dict[str, float] | None = None,
                unit: str | None = None) -> Resolution | None:  # fmt: skip
        k = (code, desc, trust, tuple(sorted(params.items())) if params else None, unit)
        if k not in resolved_cache:
            resolved_cache[k] = library.resolve(code, desc, trust_code=trust, params=params, unit=unit)
        return resolved_cache[k]

    # Sprint 10: labels of detections (annotations + legend label + OCR lines nearby) for label-qualified rules; a
    # default Sprint-10 rule applies only when the org's library has its item (`resolvable`)
    labeler = make_labeler({s.sheet_id: text_lines(s.texts) for s in sheets if s.texts})

    def resolvable(r: Rule) -> bool:
        """A default Sprint-10 rule applies only when the org's library has its item; older rules always apply."""
        if r.id not in SPRINT10_RULE_IDS:
            return True
        return resolve(r.item_code, r.description, r.source == "custom", None, r.unit or None) is not None

    def add(
        rule: Rule | None,
        members: list[tuple[Det, str | None]],
        qty: float,
        extra_reasons: list[str],
        extra_level: str = "green",
        unmatched: tuple[str, str] | None = None,
        user_code: tuple[str, str] | None = None,
        item: Item | None = None,
        unit: Unit | None = None,
    ) -> None:
        dets = [d for d, _ in members]
        if unit is not None and unit.ignore_member_levels:
            level, reasons = extra_level, []
        else:
            level = min_level(extra_level, *(d.level for d in dets))
            reasons = [r for d in dets for r in d.reasons]
        rule_reasons = list(extra_reasons)
        res: Resolution | None = None
        rid = rule.id if rule else None
        unit_hint: str | None = None
        if item is not None:
            res = Resolution(item, "room", 1.0)
            if rule is not None:
                rule_reasons.extend(r for r in rule.reasons if r not in rule_reasons)
        elif user_code is not None:
            res = resolve(user_code[0], "", True)
            rid = user_code[1]
            if res is None:
                # A-LIVE-01: the rule that targets this code (its description / unit), else the class name
                ref = code_rules.get(user_code[0])
                cls_he = next((CLASS_HE[d.cls] for d in dets if d.cls in CLASS_HE), None)
                desc = (ref.description if ref and ref.description else None) or cls_he or f"סעיף {user_code[0]}"
                unmatched = (user_code[0], desc)
                if ref is not None and ref.unit:
                    unit_hint = ref.unit
        elif unmatched is None and rule is not None:
            res = resolve(rule.item_code, rule.description, rule.source == "custom",
                          unit.params if unit is not None else None, rule.unit or None)  # fmt: skip
            rule_reasons.extend(rule.reasons)
            if res is None:
                unmatched = ("X-" + _slug(rule.item_code or rule.id).replace("_", "-"), rule.description or rule.id)
                unit_hint = rule.unit or None
            elif res.how == "similarity" and R_DEFAULT_RULE not in rule_reasons:
                rule_reasons.append(R_DEFAULT_RULE)
        if unit_hint is None and rule is not None and rule.unit:
            unit_hint = rule.unit
        # Sprint 10: an org whose (imported) library lacks the item of a default rule that has no drawn symbol behind it
        # (text / one-off / suggested / template), or that computed nothing (qty 0), gets no "לא משויך" line — only
        # noise; a detected symbol without an item stays a red line (it must be assigned)
        dropped = unmatched is not None and rule is not None and rule.source == "default" and res is None
        if dropped and user_code is None and rule is not None and (rule.kind in DERIVED_KINDS or qty == 0):
            stats["unmatchedDropped"] = int(stats.get("unmatchedDropped") or 0) + 1
            return
        if unmatched is not None:
            level = "red"
            if R_NO_RULE not in rule_reasons:
                rule_reasons.append(R_NO_ITEM)
        elif rule_reasons:
            level = min_level(level, "yellow")  # a rule reason is a warning: never green
        key = f"i:{res.item.id}" if res is not None else f"x:{unmatched[0] if unmatched else '?'}"
        floor = unit.floor if unit is not None and unit.floor else _floor_of(dets)
        if unit is not None and unit.origin:
            origin = unit.origin
        elif dets and all(d.source == "manual" for d in dets):
            origin = "manual"
        else:
            origin = KIND_ORIGIN.get(rule.kind, "detected") if rule is not None else "detected"
        contribs.append(
            Contribution(
                key,
                rid,
                res,
                unmatched if res is None else None,
                floor,
                qty,
                level,
                reasons,
                rule_reasons,
                members,
                unit.order_qty if unit is not None else None,
                unit.waste if unit is not None else None,
                dict(unit.ev_qty) if unit is not None else {},
                unit_hint,
                origin,
                (dict(unit.quick_action) if unit.quick_action else None) if unit is not None else None,
                bool(unit.needs_input) if unit is not None else False,
                dict(unit.circuit) if unit is not None and unit.circuit else None,
            )
        )

    def add_unit(u: Unit) -> None:
        if u.rule is None and u.user_code is None and u.unmatched is None and u.item is None:
            return
        add(u.rule, u.members, u.qty, list(u.reasons), u.level, unmatched=u.unmatched, user_code=u.user_code, item=u.item,
            unit=u)  # fmt: skip

    # --- Sprint 10 (Worker-Lighting) — keep: circuits from the tags (lighting/boq.py) replace the composite groups of
    # the sheets they cover (Worker-BOQ may move this into labeled.py; keep the call shape)
    lc_units, lc_covered, lc_stats = _lighting_units(rules, sheets, per_sheet, library)
    stats["lightingCircuits"] = {**lc_stats, "units": len(lc_units), "sheets": sorted(lc_covered)}
    # --- composite lighting (link graph per sheet; fallback without links)
    merge_mm = max([float(r.match.get("pointMergeMm") or 0) for r in rules if r.kind == "composite_lighting"] or [0.0])
    grouped_switches = 0
    unlinked_switches = 0
    shared_dup, shared_kept = find_shared_groups(sheets, per_sheet)
    for (sid, gid), (ksid, kgid) in shared_dup.items():  # count once: drop the copy's members everywhere
        by_id_dup = {d.id: d for d in per_sheet[sid]}
        g = next(x for x in per_sheet_links(sheets, sid) if x.id == gid)
        for i in [*g.switchIds, *g.luminaireIds]:
            if i in by_id_dup and by_id_dup[i].dropped_by is None:
                by_id_dup[i].dropped_by = f"{ksid}/{kgid}"
    stats["sharedGroups"] = len(shared_dup)
    for ksid, kgid in shared_kept:
        by_id_k = {d.id: d for d in per_sheet[ksid]}
        g = next(x for x in per_sheet_links(sheets, ksid) if x.id == kgid)
        for i in [*g.switchIds, *g.luminaireIds]:
            if i in by_id_k and R_SHARED not in by_id_k[i].reasons:
                by_id_k[i].reasons.append(R_SHARED)
                by_id_k[i].level = min_level(by_id_k[i].level, "yellow")
    for s in sorted(sheets, key=lambda s: s.sheet_id):
        dets = per_sheet[s.sheet_id]
        by_id = {d.id: d for d in dets}
        if s.sheet_id in lc_covered:
            continue  # Sprint 10: priced from the circuit tags
        if s.links is None:
            if s.discipline != "lighting":
                continue
            for n_fb, (kind, sw) in enumerate(_fallback_groups(dets), 1):
                f = GroupFeatures(kind, len(sw), 1, tuple(sorted({d.cls for d in sw})))
                rule = match_composite(rules, f)
                # synthetic group id (no links artifact): the UI / export count groups by linkGroupId
                ev: list[tuple[Det, str | None]] = [(d, f"lk_fb{n_fb}") for d in sw]
                if rule is None:
                    add(
                        None,
                        ev,
                        1,
                        [R_NO_RULE, R_NO_LINKS],
                        "red",
                        unmatched=(f"X-light-{kind}".replace("_", "-"), _group_desc(f)),
                    )
                else:
                    add(rule, ev, 1, [R_NO_LINKS], "red")
                grouped_switches += len(sw)
            stats["fallbackSheets"] = sorted([*stats.get("fallbackSheets", []), s.sheet_id])
            continue
        in_group: set[str] = set()
        for g in sorted(s.links, key=lambda g: _natural(g.id)):
            if (s.sheet_id, g.id) in shared_dup:
                continue
            sw = [by_id[i] for i in g.switchIds if i in by_id and by_id[i].dropped_by is None]
            lum = [by_id[i] for i in g.luminaireIds if i in by_id and by_id[i].dropped_by is None]
            if not sw and g.kind != "sensor":
                continue
            members = sw + lum
            in_group.update(d.id for d in members)
            if members and all(d.lifecycle in ("existing", "demolish") for d in members):
                continue  # nothing to build
            if g.kind == "add_to_existing":
                sw = [d for d in sw if d.lifecycle not in ("existing", "demolish")] or sw
            f = group_features(g, sw, lum, merge_mm, s.scale)
            rule = match_composite(rules, f)
            qty = 1.0
            ev = [(d, g.id) for d in members]
            greasons = list(g.reasons)
            if g.level != "green" and not greasons:
                greasons.append(R_SWITCH_LINK)
            if rule is None:
                add(None, ev, qty, [R_NO_RULE, *greasons], g.level, unmatched=(_group_code(f), _group_desc(f)))
            else:
                add(rule, ev, qty, greasons, g.level)
            grouped_switches += len(sw)
        unlinked_switches += sum(1 for d in dets if d.cls in SWITCH_CLASSES and d.dropped_by is None and d.id not in in_group)
    stats["groupedSwitches"] = grouped_switches
    stats["unlinkedSwitches"] = unlinked_switches
    for u in lc_units:  # Sprint 10 (Worker-Lighting)
        add_unit(u)

    # --- lighting install count
    install_rules = [r for r in rules if r.kind == "install_count"]
    consumed: set[str] = set(SWITCH_CLASSES)
    for rule in install_rules:
        consumed |= set(rule.classes) | set(rule.match.get("excludeClasses") or [])  # fans: lighting family, not items
        m = rule.match
        ex_c = set(m.get("excludeClasses") or [])
        ex_l = set(m.get("excludeLifecycle") or [])
        ex_s = set(m.get("excludeSupply") or [])
        for d in all_dets:
            if d.dropped_by is not None or d.cls not in rule.classes or d.cls in ex_c:
                continue
            if d.lifecycle in ex_l or (d.supply in ex_s if d.supply else False):
                continue
            add(rule, [(d, None)], 1, [])

    # --- plumbing points (chapter 03) + template suggestions
    scales = {s.sheet_id: s.scale for s in sheets}
    c_units, c_stats = combination_units(all_dets, rules, room_index, scales)
    for u in c_units:
        add_unit(u)
    stats["combinations"] = c_stats

    def resolve_desc(desc: str, params: dict[str, float] | None, unit: str | None) -> Item | None:
        # Sprint 11 (Worker-Areas) — keep: a shower described by its drawn parts → the client's variant
        res = resolve(None, desc, False, params, unit)
        return res.item if res is not None else None

    # Sprint 11 (Worker-Rooms) — keep: a wash basin read from a water-point note stands, by registration, in a canonical
    # kitchen / living room that is not wet → it is the kitchen(ette) sink (Yahav basement family room), not a bathroom
    # basin. Shape-detected basins and basins of bathrooms are untouched
    from ..rooms.crosssheet import FloorLocator as _Loc
    from ..rooms.crosssheet import in_dry_kitchen_or_living

    R_TEXT_ONLY = "זוהה מכיתוב בלבד"  # fixtures: read from its note, no drawn shape
    _loc0 = _Loc(rooms_by_sheet, canonical_rooms(rooms_by_sheet), scales)
    for _i, _d in enumerate(all_dets):
        note_basin = _d.cls == "fixture_basin" and _d.dropped_by is None and R_TEXT_ONLY in _d.reasons
        if note_basin and in_dry_kitchen_or_living(_loc0, _d.sheet_id, _d.floor, _d.x, _d.y):
            all_dets[_i] = replace(_d, cls="fixture_kitchen_sink")
    p_units, p_stats = plumbing_units(all_dets, rules, room_index, scales, labeler, resolvable, resolve_desc)
    for u in p_units:
        add_unit(u)
    consumed |= consumed_classes(rules)
    canon = canonical_rooms(rooms_by_sheet)
    texts = {s.sheet_id: [_text_cue(t) for t in s.texts] for s in sheets if s.texts}
    meta = {s.sheet_id: (s.version_id, s.discipline) for s in sheets}
    for u in suggestion_units(rules, all_dets, canon, texts, {s.sheet_id: list(s.floors) for s in sheets}, meta):
        add_unit(u)
    stats["plumbing"] = p_stats

    # --- tiling (chapter 05) from the canonical rooms + roomSettings
    rs = settings_by_room(room_settings or {}, rooms_by_sheet, canon)
    ceilings = ceiling_heights(canon, {s.sheet_id: s.texts for s in sheets if s.texts}, scales)
    # Sprint 11 (Worker-Rooms) — keep: one locator for the build (fixtures → canonical rooms, accessories → room type)
    from ..rooms.crosssheet import OUTDOOR, FloorLocator

    locator = FloorLocator(rooms_by_sheet, canon, scales)
    room_fx, fx_floors = _room_fixtures(all_dets, room_index, canon, locator)
    t_units, t_stats = tiling_units(
        rules, canon, rs, tiling_params, ceilings=ceilings, room_fixtures=room_fx, fixture_floors=fx_floors
    )
    for u in t_units:
        add_unit(u)
    stats["tiling"] = {**t_stats, "canonicalRooms": len(canon), "settingsMatched": len(rs)}

    # --- manual quantities (measure / count corrections)
    c2i = [r for r in rules if r.kind == "class_to_item"]
    disc = {s.sheet_id: s.discipline for s in sheets}
    for mq in applied.manual:
        add_unit(_manual_unit(mq, c2i, disc.get(mq.sheet_id, "")))

    # --- Sprint 10: count-only class rules (switch boxes, fan installs) and marker add-ons (waterproof / USB) over every
    # live new detection, consumed or not
    for u in count_only_units(all_dets, rules, labeler, resolvable):
        add_unit(u)

    # Sprint 11 (Worker-Rooms) — keep: the room type of an accessory comes from the canonical room it stands in (its
    # sheet registered onto the floor's canonical sheet, rooms.crosssheet); outside the building outline = outdoors
    WET_BY_FIXTURES_M2 = 25.0  # rooms.types.MAX_FIXTURE_TYPED_M2: an open-plan floor holding the guest WC is not wet
    wet_fx = {"fixture_shower", "fixture_bath", "fixture_wc_concealed", "fixture_wc_monoblock"}
    pts_by: dict[tuple[str, str | None], list[tuple[float, float]]] = defaultdict(list)
    for d in all_dets:
        if d.dropped_by is None and d.cls not in FIXTURE_CLASSES:
            pts_by[(d.sheet_id, d.floor)].append((d.x, d.y))
    outdoor_ok = {k: locator.outdoor_trusted(k[0], k[1], v) for k, v in pts_by.items()}

    def det_room_type(d: Det) -> str | None:
        where, cr = locator.locate(d.sheet_id, d.floor, d.x, d.y)
        if cr is not None:
            by_fx = cr.area_m2 <= WET_BY_FIXTURES_M2 and bool(room_fx.get(cr.key, frozenset()) & wet_fx)
            return "bathroom" if cr.type not in ("bathroom", "wc") and by_fx else cr.type
        if where == OUTDOOR and outdoor_ok.get((d.sheet_id, d.floor)):
            return "courtyard"  # outside the building of a trusted floor model, whatever face its own sheet closed there
        r = room_index.get((d.sheet_id, d.room_id)) if d.room_id else None
        if r is None:
            return None
        c = r if r.key in {x.key for x in canon} else (match_room(r, canon) or r)
        return c.type

    mk_units, mk_stats = marker_units(all_dets, rules, labeler, resolvable, det_room_type)
    for u in mk_units:
        add_unit(u)
    stats["markers"] = {**mk_stats, "sheetFloorsRegistered": locator.stats["registered"],
                        "sheetFloorsUnregistered": locator.stats["unregistered"]}  # fmt: skip

    # --- class → item (and user-chosen item codes); Sprint 10: the first rule whose label filter matches wins
    excluded_lifecycle = 0
    unmapped = 0
    for d in all_dets:
        if d.dropped_by is not None or d.cls in consumed:
            continue
        if d.item_code and d.code_rule:
            add(None, [(d, None)], 1, [], user_code=(d.item_code, re.sub(r"[^A-Za-z0-9_-]", "_", d.code_rule)[:128]))
            continue
        pick = pick_class_rule(d, c2i, labeler, resolvable)
        rule = pick.rule
        if rule is not None and rule.item_code is None:
            continue  # the org says: not a BOQ item
        if d.lifecycle in NOT_NEW_LIFECYCLES:
            excluded_lifecycle += 1  # existing / demolished: not new work
            continue
        if rule is None:
            unmapped += 1
            extra = [R_NO_RULE] + ([R_UNKNOWN_SYMBOL] if d.cls == "unknown" else [])
            add(None, [(d, None)], 1, extra, "red", unmatched=("X-" + _slug(d.cls).replace("_", "-"), CLASS_HE.get(d.cls, d.cls)))
            continue
        if pick.params or pick.reasons:
            add_unit(Unit(rule, [(d, None)], 1.0, list(pick.reasons), params=pick.params))
        else:
            add(rule, [(d, None)], 1, [])
    stats["excludedByLifecycle"] = excluded_lifecycle
    stats["unmapped"] = unmapped
    stats["skipped"] = dict(sorted(skipped.items()))

    # --- Sprint 6: text items (matched above) and geometry items
    def code_of(c: Contribution) -> str | None:
        return c.resolution.item.code if c.resolution is not None else (c.unmatched[0] if c.unmatched else None)

    tiling_rule_ids = {r.id for r in rules if r.kind in ("tiling_floor", "tiling_cladding", "tiling_corner", "waterproofing")}
    for tu in tx_units:  # one unit per merged match: its qty goes to the majority room of its texts (byRoom)
        if tu.rule.source == "default" and tu.rule.id in SPRINT10_RULE_IDS and not resolvable(tu.rule):
            continue  # Sprint 10: a generic text rule for a line the client's BOQ lacks is not a "לא משויך" line
        add_unit(Unit(tu.rule, [(entry_det(e), None) for e in tu.members], tu.qty, [], "yellow", floor=tu.floor,
                      origin="text"))  # fmt: skip
    canon_keys_ = {(r.sheet_id, r.id) for r in canon}

    def geo_room(sheet_id: str, room_id: str) -> str | None:
        r = room_index.get((sheet_id, room_id))
        if r is None:
            return None
        c = r if (r.sheet_id, r.id) in canon_keys_ else (match_room(r, canon) or r)
        return c.type

    g_units, g_stats = geometry_units(rules, geo_items, geo_room, geo_docs)
    # the room panel (tiling from roomSettings: a partial cladding the user entered) wins over the drawing geometry of
    # the same item, and a geometry *estimate* never adds to an item another rule produced
    tiled = {code for c in contribs if (code := code_of(c)) and c.rule_id and c.rule_id in tiling_rule_ids}
    any_code = {code for c in contribs if (code := code_of(c))}
    g_skipped = 0
    for gu in g_units:
        gcode = gu.rule.item_code if gu.rule else None
        if gcode and (gcode in tiled or (gu.origin == "suggested" and gcode in any_code)):
            g_skipped += 1
            continue
        gdets = [gu.det, *gu.extra]
        share = round(gu.qty / len(gdets), 4)
        gunit = Unit(gu.rule, [(d, None) for d in gdets], gu.qty, list(gu.reasons), gu.level, floor=gu.floor,
                     origin=gu.origin, ev_qty=gu.ev_qty or {d.key: share for d in gdets})  # fmt: skip
        if gu.origin == "suggested":  # not computable: the user measures it (the estimate is a hint in the reasons)
            gunit.qty, gunit.ev_qty, gunit.level = 0.0, {}, "red"
            gunit.ignore_member_levels = True
            gunit.needs_input = True
            gunit.reasons = [*gunit.reasons, R_NEEDS_INPUT]
            gunit.quick_action = {"kind": default_quick_action(gu.rule.unit if gu.rule else ""), "sheetId": gu.det.sheet_id}
        add_unit(gunit)
    g_stats["skippedProduced"] = g_skipped
    stats["geometry"] = g_stats

    # --- Worker-Text catalog items of codes no text_item rule targets (worker convention, NOTES "Sprint 6"):
    # countable items (e.g. the "פרט A" 6-socket boxes) and evidence-only items of a code no symbol produced
    ruled = {r.item_code for r in rules if r.kind == "text_item" and r.item_code}
    text_order = ["electrical", "lighting", "plumbing", "construction", "architecture", "architecture_master"]

    def catalog_unit(code: str, members: list[TextEntry], qty: float, floor: str | None, origin: str) -> Unit | None:
        # the catalog names the reference code; Sprint 10: codes drift between projects (4.06 = "שקע כח משולש" in the
        # designer's later BOQs), so the code's item counts only when it is the org's own manual / default item or its
        # wording matches the rule's — else the rule resolves by description; nothing matching → no line
        rule = code_rules.get(code)
        item = library.preferred(code)  # a manual (renamed) item of the code first, then by id
        own = item is not None and (item.manual or item.default)
        drift = item is not None and not own and rule is not None and bool(rule.description)
        if drift and rule is not None and item is not None and desc_score(rule.description, item.description) < CODE_MATCH_MIN:
            res = resolve(None, rule.description, False, None, rule.unit or None)
            if res is None:
                return None
            item = res.item
        if rule is None and item is None:
            return None
        return Unit(rule, [(entry_det(e), None) for e in members], qty, [], "yellow", floor=floor, origin=origin, item=item)

    # an evidence-only (corroborating) item never adds to a code another rule produced, a one-off suggestion included
    produced_codes = {code for c in contribs if (code := code_of(c))}
    n_cat = 0
    for code, cmembers, cqty, cfloor in catalog_units(text_entries, ruled, produced_codes, text_order):
        if (cu := catalog_unit(code, cmembers, cqty, cfloor, "text")) is not None:
            add_unit(cu)
            n_cat += 1
    stats["textItems"]["catalogUnits"] = n_cat

    # --- Worker-Text catalog suggestions first (the drawings show a trigger, not the item: 4.28 main panel, 9.03 vent
    # duct — they carry a quantity), then the suggested rules (every rule-covered item no rule produced)
    refs = [SheetRef(s.sheet_id, s.version_id, s.discipline, tuple(s.floors), (s.page[0], s.page[1])) for s in sheets]
    produced_codes = {code for c in contribs if (code := code_of(c))}
    n_sug = 0
    for code, cmembers, cqty, cfloor in catalog_units(text_entries, set(), produced_codes, text_order, suggested=True):
        su = catalog_unit(code, cmembers, cqty, cfloor, "suggested")
        if su is not None:
            su.ignore_member_levels = True
            su.reasons = [R_TEMPLATE]
            unit_s = su.item.unit if su.item else (su.rule.unit if su.rule else "")
            su.quick_action = {"kind": default_quick_action(unit_s), "sheetId": cmembers[0].sheet_id}
            add_unit(su)
            n_sug += 1
    produced = {c.resolution.item.id for c in contribs if c.resolution is not None}
    s_units, s_stats = suggested_units(rules, library, refs, text_entries, produced, geo=geo_items, dets=live, canon=canon,
                                       room_type=geo_room, docs=geo_docs)  # fmt: skip
    for u in s_units:
        add_unit(u)
    s_stats["catalogUnits"] = n_sug
    stats["suggested"] = s_stats

    # --- template chapters offered as lump sums (chapter 01 demolition), items no other rule produced
    produced = {c.resolution.item.id for c in contribs if c.resolution is not None}
    t_lines = template_units(rules, library, refs, produced)
    for u in t_lines:
        add_unit(u)
    stats["templateLines"] = len(t_lines)

    canon_keys = {c.key for c in canon}

    def room_of(d: Det) -> RoomRef | None:
        """The canonical room of an evidence item (the same physical room whatever sheet it was drawn on)."""
        if not d.room_id:
            return None
        r = room_index.get((d.sheet_id, d.room_id))
        if r is None:
            return (d.sheet_id, d.room_id, d.room, None, d.floor)
        c = r if r.key in canon_keys else (match_room(r, canon) or r)
        if c.niche:  # a laundry niche (unnamed sub-room): contracts RoomType "niche"
            return (c.sheet_id, c.id, c.name or "נישה", "niche", c.floor)
        return (c.sheet_id, c.id, c.name, c.type, c.floor)

    lines = _lines(contribs, room_of)
    stats["lines"] = len(lines)
    stats["evidence"] = sum(len(ln.evidence) for ln in lines)
    for lv in ("green", "yellow", "red"):
        stats[lv] = sum(1 for ln in lines if ln.level == lv)
    return Result(lines, stats)


def _manual_unit(mq: ManualQty, c2i: list[Rule], discipline: str) -> Unit:
    c = mq.correction
    pts = list(mq.points) or [mq.center]
    dets = [
        Det(
            mq.sheet_id,
            mq.version_id,
            (f"m_{c.id}" if k == 0 else f"m_{c.id}_{k + 1}")[:128],
            mq.cls or "manual",
            x,
            y,
            "green",
            [R_MEASURED if c.kind == "measure" else R_ADDED],
            mq.floor,
            "new",
            None,
            discipline,
            1.0,
            room_id=mq.room_id,
            source="manual",
            correction_id=c.id,
            verified=True,
        )
        for k, (x, y) in enumerate(pts)
    ]
    share = mq.qty / len(dets)
    u = Unit(None, [(d, None) for d in dets], mq.qty, floor=mq.floor, ev_qty={d.key: round(share, 4) for d in dets})
    if mq.item_code:
        u.user_code = (mq.item_code, re.sub(r"[^A-Za-z0-9_-]", "_", f"corr_{c.id}")[:128])
    else:
        rule = next((r for r in c2i if mq.cls in r.classes and r.item_code), None)
        if rule is not None:
            u.rule = rule
        else:
            u.unmatched = ("X-" + _slug(mq.cls or "manual").replace("_", "-"), CLASS_HE.get(mq.cls or "", mq.cls or "פריט ידני"))
            u.reasons = [R_NO_RULE]
            u.level = "red"
    return u


def _group_code(f: GroupFeatures) -> str:
    return f"X-light-{f.kind.replace('_', '-')}-{f.points}"


def _group_desc(f: GroupFeatures) -> str:
    return f"קבוצת מאור לא מסווגת ({f.kind}, {f.switches} מפסקים, {f.points} נק')"


def _text_cue(t: dict[str, Any]) -> tuple[str, float, float]:
    bb = t.get("bboxMm")
    if isinstance(bb, list | tuple) and len(bb) == 4:
        try:
            return str(t.get("text") or ""), (float(bb[0]) + float(bb[2])) / 2, (float(bb[1]) + float(bb[3])) / 2
        except (TypeError, ValueError):
            pass
    return str(t.get("text") or ""), 0.0, 0.0


def _by_room(cs: list[Contribution], room_of: Any) -> list[dict[str, Any]]:
    """Per-room split of a line (A-pipeline-12): a contribution with per-item quantities (tiling / measures) splits
    by item; otherwise its whole qty goes to the majority room of its items (a link group, a per-room plumbing unit)."""
    acc: dict[RoomRef | None, float] = defaultdict(float)
    for c in cs:
        refs = [(d, room_of(d)) for d, _ in c.evidence]
        if c.ev_qty:
            for d, ref in refs:
                acc[ref] += c.ev_qty.get(d.key, 0.0)
            rest = c.qty - sum(c.ev_qty.get(d.key, 0.0) for d, _ in refs)
            if abs(rest) > 1e-6:
                acc[None] += rest
            continue
        votes = Counter(ref for _, ref in refs if ref is not None)
        best = min(votes.items(), key=lambda kv: (-kv[1], tuple(x or "" for x in kv[0])))[0] if votes else None
        acc[best] += c.qty
    out = []
    for ref, q in acc.items():
        if abs(q) < 1e-9:
            continue
        sid, rid, name, rtype, floor = ref if ref is not None else (None, None, None, None, None)
        out.append({"sheetId": sid, "roomId": rid, "name": (name or None) and str(name)[:100], "type": rtype,
                    "floor": floor, "qty": round(q, 4)})  # fmt: skip
    rank = {f: i for i, f in enumerate(FLOOR_ORDER)}
    out.sort(key=lambda e: (e["roomId"] is None, rank.get(str(e["floor"]), len(rank)), str(e["floor"] or ""),
                            str(e["name"] or ""), str(e["sheetId"] or ""), str(e["roomId"] or "")))  # fmt: skip
    return out[:MAX_BY_ROOM]


def line_origin(cs: list[Contribution]) -> str:
    """``manual`` when every contribution is manual, else the first of :data:`ORIGIN_ORDER` among the others."""
    have = {c.origin for c in cs}
    if have <= {"manual"}:
        return "manual"
    return next((o for o in ORIGIN_ORDER if o in have), "detected")


def _evidence_extra(d: Det, e: dict[str, Any]) -> None:
    """Sprint 6 evidence fields (contracts ``BoqEvidenceItem``): ``kind`` of a non-detection item, the text box
    (``bboxMm``), the geometry shape (``geometryMm``, ≤ 2000 points) and stair facts."""
    if d.target is None:
        return
    e["kind"] = d.target
    if d.target == "text" and d.bbox is not None:
        x, y, w, h = d.bbox
        e["bboxMm"] = {"x": round(x, 2), "y": round(y, 2), "w": round(max(w, 0.0), 2), "h": round(max(h, 0.0), 2)}
    if d.shape and len(d.shape) >= (3 if d.closed else 2):
        e["geometryMm"] = {"type": "polygon" if d.closed else "polyline",
                           "mm": [{"x": round(px, 2), "y": round(py, 2)} for px, py in d.shape[:2000]]}  # fmt: skip
    if d.treads is not None:
        e["stair"] = {"treads": min(200, d.treads[0]), "risers": None if d.treads[1] is None else min(200, d.treads[1])}
    if d.note:
        e["reason"] = d.note[:200]


def _by_version(cs: list[Contribution]) -> list[dict[str, Any]]:
    """Sprint 8: each contribution's qty split over the sheet versions of its evidence — by the evidence quantities
    when it has them (geometry, measured corrections), else evenly per evidence item (a composite group lives on one
    sheet: all of it). Contributions without evidence (suggestions, templates) are attributed to no version."""
    acc: dict[tuple[str, str], float] = defaultdict(float)
    for c in cs:
        if not c.qty or not c.evidence:
            continue
        w: dict[tuple[str, str], float] = defaultdict(float)
        for d, _gid in c.evidence:
            if not d.sheet_id or not d.version_id:
                continue
            q = c.ev_qty.get(d.key)
            w[(d.sheet_id, d.version_id)] += abs(q) if q is not None else 1.0
        tot = sum(w.values())
        if tot <= 0:
            w = defaultdict(float, {k: 1.0 for k in w})
            tot = float(len(w))
        for k, v in w.items():
            acc[k] += c.qty * v / tot if tot else 0.0
    keys = sorted(acc)
    shares = [round(acc[k], 4) for k in keys]
    if shares:  # shares sum exactly to the attributed qty: the rounding remainder goes to the largest share
        big = max(range(len(keys)), key=lambda i: (shares[i], keys[i][0]))
        shares[big] = round(shares[big] + round(round(sum(acc.values()), 4) - sum(shares), 4), 4)
    return [{"sheetId": sid, "versionId": vid, "qty": q} for (sid, vid), q in zip(keys, shares, strict=True)]


def _line_circuit(cs: list[Contribution]) -> dict[str, Any] | None:
    """Sprint 10: the line's ``circuit`` when every contribution is a lighting circuit of the same kind and fixture
    count (the per-topology wording); None otherwise (mixed kinds — the set-wording base line — or no circuits)."""
    circ = [c.circuit for c in cs if c.circuit]
    if not circ or len(circ) != len(cs):
        return None
    kinds = {str(c.get("kind")) for c in circ}
    fixtures = {int(c.get("fixtures") or 0) for c in circ}
    if len(kinds) != 1 or len(fixtures) != 1:
        return None
    ids = ",".join(str(c.get("id")) for c in circ)
    return {"id": ids[:500], "kind": kinds.pop(), "fixtures": fixtures.pop()}


def _lines(contribs: list[Contribution], room_of: Any = None) -> list[Line]:
    by_key: dict[str, list[Contribution]] = defaultdict(list)
    for c in contribs:
        by_key[c.key].append(c)
    lines: list[Line] = []
    used_ids: set[str] = set()
    for key in sorted(by_key):
        cs = by_key[key]
        first = cs[0]
        if first.resolution is not None:
            it = first.resolution.item
            hint = next((c.unit_hint for c in cs if c.unit_hint), None)
            chapter, chapter_title, code, desc, unit, item_id = (
                it.chapter,
                it.chapter_title,
                it.code,
                it.description,
                it.unit or hint or "יחידה",
                it.id,
            )
        else:
            code, desc = first.unmatched or ("X", "?")
            hint = next((c.unit_hint for c in cs if c.unit_hint), None)
            chapter, chapter_title, unit, item_id = UNMATCHED_CHAPTER, UNMATCHED_CHAPTER, hint or "יחידה", None
        lid = f"ln_{_slug(code)}" if first.resolution is not None else f"ln_{_slug(code.lower())}"
        if lid in used_ids:
            lid = f"{lid}_{hashlib.sha256(key.encode()).hexdigest()[:8]}"  # pragma: no cover
        used_ids.add(lid)
        by_floor: dict[str, float] = defaultdict(float)
        for c in cs:
            by_floor[c.floor or UNKNOWN_FLOOR] += c.qty
        qty = float(sum(c.qty for c in cs))
        level = min_level(*(c.level for c in cs))
        rule_r: Counter[str] = Counter(r for c in cs for r in c.rule_reasons)
        ev_r: Counter[str] = Counter(r for c in cs for r in c.reasons)
        if UNKNOWN_FLOOR in by_floor:
            rule_r[R_UNKNOWN_FLOOR] += 1
            level = min_level(level, "yellow")
        reasons = [r for r, _ in sorted(rule_r.items(), key=lambda kv: (-kv[1], kv[0]))]
        reasons += [r for r, _ in sorted(ev_r.items(), key=lambda kv: (-kv[1], kv[0])) if r not in reasons]
        nft = first.resolution is not None and first.resolution.item.not_for_total
        if nft and R_NOT_FOR_TOTAL not in reasons:
            reasons.append(R_NOT_FOR_TOTAL)
        if level != "green" and not reasons:
            reasons = [R_LOW]
        evidence: list[dict[str, Any]] = []
        seen: dict[tuple[str, str], dict[str, Any]] = {}
        for c in cs:
            for d, gid in c.evidence:
                q = c.ev_qty.get(d.key)
                if (d.key, gid or "") in seen:
                    if q is not None:
                        prev = seen[(d.key, gid or "")]
                        prev["quantity"] = round(float(prev.get("quantity") or 0.0) + q, 4)
                    continue
                e: dict[str, Any] = {
                    "sheetId": d.sheet_id,
                    "versionId": d.version_id,
                    "detectionId": d.id,
                    "linkGroupId": gid,
                    "floor": d.floor,
                    "source": d.source,
                }
                if d.correction_id:
                    e["correctionId"] = d.correction_id
                if d.room_id:
                    e["roomId"] = d.room_id
                if q is not None:
                    e["quantity"] = round(q, 4)
                if d.verified:
                    e["verified"] = True
                _evidence_extra(d, e)
                seen[(d.key, gid or "")] = e
                evidence.append(e)
        evidence.sort(key=lambda e: (e["sheetId"], _natural(e["detectionId"]), e["linkGroupId"] or ""))
        rule_ids = Counter(c.rule_id for c in cs if c.rule_id)
        rule_id = min(rule_ids.items(), key=lambda kv: (-kv[1], kv[0]))[0] if rule_ids else None
        sv = sorted({(e["sheetId"], e["versionId"]) for e in evidence})
        oq = [c.order_qty for c in cs if c.order_qty is not None]
        wastes = [c.waste for c in cs if c.waste is not None]
        origin = line_origin(cs)
        # contracts: needsInput = the quantity must still be entered (a suggestion without an estimate) → qty 0
        needs = origin == "suggested" and all(c.needs_input for c in cs)
        qa: dict[str, str | None] | None = None
        if origin == "suggested":
            qa = next((c.quick_action for c in cs if c.quick_action), None) or {
                "kind": default_quick_action(unit),
                "sheetId": evidence[0]["sheetId"] if evidence else None,
            }
            level = min_level(level, "yellow")
        lines.append(
            Line(
                lid,
                chapter,
                chapter_title,
                code,
                desc,
                unit,
                0.0 if needs else round(qty, 4),
                {} if needs else {k: round(v, 4) for k, v in sorted(by_floor.items())},
                level,
                reasons[:MAX_REASONS],
                evidence,
                rule_id,
                item_id,
                [{"sheetId": s, "versionId": v} for s, v in sv],
                round(sum(oq) + sum(c.qty for c in cs if c.order_qty is None), 4) if oq else None,
                max(wastes) if wastes else None,
                _by_room(cs, room_of) if room_of is not None and not needs else [],
                origin,
                needs,
                qa,
                [] if needs else _by_version(cs),
                _line_circuit(cs),
                not_for_total=nft,
            )
        )
    lines.sort(key=lambda ln: (ln.chapter == UNMATCHED_CHAPTER, ln.chapter, code_key(ln.code), ln.id))
    return lines
