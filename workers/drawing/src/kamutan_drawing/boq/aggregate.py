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
from .plumbing import consumed_classes, plumbing_units, suggestion_units
from .rules import (
    CLASS_HE,
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
    R_NO_ITEM,
    R_NO_LINKS,
    R_NO_RULE,
    R_RELABELED,
    R_SHARED,
    R_SWITCH_LINK,
    R_UNKNOWN_FLOOR,
    R_UNKNOWN_SYMBOL,
    SHARED_KINDS,
    STAIR_WORDS,
    SWITCH_CLASSES,
    UNMATCHED_CHAPTER,
    Item,
    Library,
    Resolution,
    Rule,
)
from .spaces import Room, canonical_rooms, ceiling_heights, match_room, room_from_doc, settings_by_room
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


@dataclass
class Line:
    id: str
    chapter: str
    chapter_title: str
    code: str
    description: str
    unit: str
    qty: float
    by_floor: dict[str, float]
    level: str
    reasons: list[str]
    evidence: list[dict[str, Any]]
    rule_id: str | None
    item_id: str | None
    source_versions: list[dict[str, str]]
    order_qty: float | None = None
    waste_factor: float | None = None

    def computed_fields(self) -> dict[str, Any]:
        extra: dict[str, Any] = {"manualCount": sum(1 for e in self.evidence if e.get("source") == "manual")}
        if self.order_qty is not None:
            extra.update({"orderQty": self.order_qty, "wasteFactor": self.waste_factor})
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
    dets: list[Det], room_index: dict[tuple[str, str], Room], canon: list[Room]
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
        if r is None:
            continue
        c = r if r.key in ckeys else match_room(r, canon)
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

    contribs: list[Contribution] = []
    resolved_cache: dict[tuple[str | None, str, bool], Resolution | None] = {}

    def resolve(code: str | None, desc: str, trust: bool) -> Resolution | None:
        k = (code, desc, trust)
        if k not in resolved_cache:
            resolved_cache[k] = library.resolve(code, desc, trust_code=trust)
        return resolved_cache[k]

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
        if item is not None:
            res = Resolution(item, "room", 1.0)
            if rule is not None:
                rule_reasons.extend(r for r in rule.reasons if r not in rule_reasons)
        elif user_code is not None:
            res = resolve(user_code[0], "", True)
            rid = user_code[1]
            if res is None:
                unmatched = (user_code[0], f"פריט {user_code[0]}")
        elif unmatched is None and rule is not None:
            res = resolve(rule.item_code, rule.description, rule.source == "custom")
            rule_reasons.extend(rule.reasons)
            if res is None:
                unmatched = ("X-" + _slug(rule.item_code or rule.id).replace("_", "-"), rule.description or rule.id)
            elif res.how == "similarity" and R_DEFAULT_RULE not in rule_reasons:
                rule_reasons.append(R_DEFAULT_RULE)
        if unmatched is not None:
            level = "red"
            if R_NO_RULE not in rule_reasons:
                rule_reasons.append(R_NO_ITEM)
        elif rule_reasons:
            level = min_level(level, "yellow")  # a rule reason is a warning: never green
        key = f"i:{res.item.id}" if res is not None else f"x:{unmatched[0] if unmatched else '?'}"
        floor = unit.floor if unit is not None and unit.floor else _floor_of(dets)
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
            )
        )

    def add_unit(u: Unit) -> None:
        if u.rule is None and u.user_code is None and u.unmatched is None and u.item is None:
            return
        add(u.rule, u.members, u.qty, list(u.reasons), u.level, unmatched=u.unmatched, user_code=u.user_code, item=u.item,
            unit=u)  # fmt: skip

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
    rooms_by_sheet = {
        s.sheet_id: [r for d in s.room_docs if (r := room_from_doc(s.sheet_id, s.version_id, s.discipline, d)) is not None]
        for s in sheets
    }
    room_index = {(r.sheet_id, r.id): r for rs in rooms_by_sheet.values() for r in rs}
    scales = {s.sheet_id: s.scale for s in sheets}
    p_units, p_stats = plumbing_units(all_dets, rules, room_index, scales)
    for u in p_units:
        add_unit(u)
    consumed |= consumed_classes(rules)
    canon = canonical_rooms(rooms_by_sheet)
    texts = {s.sheet_id: [str(t.get("text") or "") for t in s.texts] for s in sheets if s.texts}
    for u in suggestion_units(rules, all_dets, canon, texts, {s.sheet_id: list(s.floors) for s in sheets}):
        add_unit(u)
    stats["plumbing"] = p_stats

    # --- tiling (chapter 05) from the canonical rooms + roomSettings
    rs = settings_by_room(room_settings or {}, rooms_by_sheet, canon)
    ceilings = ceiling_heights(canon, {s.sheet_id: s.texts for s in sheets if s.texts}, scales)
    room_fx, fx_floors = _room_fixtures(all_dets, room_index, canon)
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

    # --- class → item (and user-chosen item codes)
    excluded_lifecycle = 0
    unmapped = 0
    for d in all_dets:
        if d.dropped_by is not None or d.cls in consumed:
            continue
        if d.item_code and d.code_rule:
            add(None, [(d, None)], 1, [], user_code=(d.item_code, re.sub(r"[^A-Za-z0-9_-]", "_", d.code_rule)[:128]))
            continue
        rule = next((r for r in c2i if d.cls in r.classes), None)
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
        add(rule, [(d, None)], 1, [])
    stats["excludedByLifecycle"] = excluded_lifecycle
    stats["unmapped"] = unmapped
    stats["skipped"] = dict(sorted(skipped.items()))

    lines = _lines(contribs)
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


def _lines(contribs: list[Contribution]) -> list[Line]:
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
            chapter, chapter_title, code, desc, unit, item_id = (
                it.chapter,
                it.chapter_title,
                it.code,
                it.description,
                it.unit,
                it.id,
            )
        else:
            code, desc = first.unmatched or ("X", "?")
            chapter, chapter_title, unit, item_id = UNMATCHED_CHAPTER, UNMATCHED_CHAPTER, "יחידה", None
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
                seen[(d.key, gid or "")] = e
                evidence.append(e)
        evidence.sort(key=lambda e: (e["sheetId"], _natural(e["detectionId"]), e["linkGroupId"] or ""))
        rule_ids = Counter(c.rule_id for c in cs if c.rule_id)
        rule_id = min(rule_ids.items(), key=lambda kv: (-kv[1], kv[0]))[0] if rule_ids else None
        sv = sorted({(e["sheetId"], e["versionId"]) for e in evidence})
        oq = [c.order_qty for c in cs if c.order_qty is not None]
        wastes = [c.waste for c in cs if c.waste is not None]
        lines.append(
            Line(
                lid,
                chapter,
                chapter_title,
                code,
                desc,
                unit,
                round(qty, 4),
                {k: round(v, 4) for k, v in sorted(by_floor.items())},
                level,
                reasons[:MAX_REASONS],
                evidence,
                rule_id,
                item_id,
                [{"sheetId": s, "versionId": v} for s, v in sv],
                round(sum(oq) + sum(c.qty for c in cs if c.order_qty is None), 4) if oq else None,
                max(wastes) if wastes else None,
            )
        )
    lines.sort(key=lambda ln: (ln.chapter == UNMATCHED_CHAPTER, ln.chapter, code_key(ln.code), ln.id))
    return lines
