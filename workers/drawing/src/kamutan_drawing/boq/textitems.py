"""Sprint 6: BOQ lines from drawing text — rule kind ``text_item`` (pure). Contracts: ``TextItemMatchSchema``
(packages/contracts/src/library.ts) + ``kamutan.text-items/1`` (takeoff.ts)::

    match = {patterns: [regex], excludePatterns?: [regex], scope: legend|note|callout|panel_schedule|any,
             disciplines?, qty: count|number_in_text|length_in_text_m|one, proximityMm?, nearClasses?, consumeNear?,
             lifecycle?, floors?}

Text source per sheet version: Worker-Text's ``text_items.json.gz`` when present (its ``scope`` / ``floor`` / ``roomId``
/ ``lifecycle`` / ``numbers`` / ``lengthsM`` / ``anchorMm`` are used), else the OCR lines of ``text.json.gz`` (fallback):
a line inside a legend box (``legend.json.gz``) has scope ``legend``, any other line an unknown scope that satisfies
``note`` / ``callout`` / ``any`` (never ``legend`` / ``panel_schedule``); floor from the version's regions, room from
the sheet's rooms, no lifecycle.

Matching (contracts): :func:`norm_he` (= ``normalizeHebrewText``) of pattern AND text, case-insensitive search; any
pattern matches and no ``excludePatterns`` does; ``any`` = every scope except ``title``; ``lifecycle`` filters on the
text's qualifier (a text without one passes); ``nearClasses`` = a live detection of one of the classes on the same
sheet within ``proximityMm`` paper mm of the text's anchor (else its box) — when ``consumeNear`` that detection is
not counted by any other rule. ``proximityMm`` also merges repeated matches of the same rule closer than it into one.

Quantity: ``count`` = 1 per (merged) match, or the number of capture group 1 when the pattern has one; ``number_in_text``
= group 1, else the item's first number (``numbers`` / the text); ``length_in_text_m`` = ``lengthsM[0]``, else group 1;
``one`` = 1 for the whole project when anything matched. Worker convention (not in the contract text): per floor only
one sheet counts — the first of ``disciplines`` (rule order) with a match there, then the sheet with most matches — so
a note repeated on the electrical and the lighting plan of a floor is counted once.

Evidence: one item per matched text (``detectionId`` ``ti_…`` or ``text_{n}``, ``kind: "text"``, ``bboxMm``).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any

from .dedup import Det
from .hebrew import norm_he
from .rules import Rule

TEXT_ITEMS_SCHEMA = "kamutan.text-items/1"  # contracts (takeoff.ts)
CATALOG_SCHEMA = "kamutan.textItems/1"  # Worker-Text's published shape (NOTES "Sprint 6 — text & equipment items")
# Worker-Text item kind → contracts text scope
KIND_SCOPE = {"note": "note", "callout": "callout", "detail_ref": "callout", "legend_row": "legend",
              "panel_schedule": "panel_schedule", "conduit": "callout"}  # fmt: skip
ITEM_SCOPES = ("legend", "note", "callout", "panel_schedule", "label", "title", "other")
UNKNOWN_SCOPE = "unknown"  # OCR line outside a legend box (no Worker-Text artifact)
MAX_TEXTS_PER_SHEET = 20_000
MAX_PATTERN_LEN = 200
CONSUME_NEAR_MAX_MM = 8.0  # consumeNear takes a detection only this close to the text (paper mm; 0.4 m at 1:50)
ANCHOR_SAME_MM = 1.0  # a catalog item's anchor this close to a detection's centre is that detection (paper mm)


@lru_cache(maxsize=2048)
def compile_pattern(p: str) -> re.Pattern[str] | None:
    """A rule pattern, normalised like the text, compiled case-insensitive. Invalid / too long → None."""
    if not p or len(p) > MAX_PATTERN_LEN:
        return None
    try:
        return re.compile(norm_he(p), re.IGNORECASE)
    except re.error:
        return None


def patterns_of(m: dict[str, Any], key: str = "patterns") -> list[re.Pattern[str]]:
    return [c for p in m.get(key) or [] if (c := compile_pattern(str(p))) is not None]


@dataclass(frozen=True)
class TextEntry:
    sheet_id: str
    version_id: str
    discipline: str
    id: str  # evidence detectionId: ti_… | text_{n}
    text: str
    norm: str
    x: float
    y: float
    bbox: tuple[float, float, float, float]  # x, y, w, h (paper mm)
    scope: str
    floor: str | None
    room_id: str | None = None
    lifecycle: str | None = None
    numbers: tuple[float, ...] = ()
    lengths_m: tuple[float, ...] = ()
    anchor: tuple[float, float] | None = None
    level: str = "yellow"
    reasons: tuple[str, ...] = field(default_factory=tuple)
    # Worker-Text catalog match (kamutan.textItems/1): the item's code / own quantity (0 = folded into a pair) and flags
    catalog: bool = False
    item_code: str | None = None
    item_qty: float | None = None
    corroborates: bool = False
    suggested: bool = False
    per_floor: bool = False

    @property
    def key(self) -> tuple[str, str]:
        return (self.sheet_id, self.id)


def _bbox(v: Any) -> tuple[float, float, float, float] | None:
    """``[x0, y0, x1, y1]`` (text.json) or ``{x, y, w, h}`` → (x, y, w, h)."""
    try:
        if isinstance(v, list | tuple) and len(v) == 4:
            x0, y0, x1, y1 = (float(c) for c in v)
            return (min(x0, x1), min(y0, y1), abs(x1 - x0), abs(y1 - y0))
        if isinstance(v, dict):
            return (float(v["x"]), float(v["y"]), float(v.get("w") or 0.0), float(v.get("h") or 0.0))
    except (KeyError, TypeError, ValueError):
        return None
    return None


def _nums(v: Any) -> tuple[float, ...]:
    return tuple(float(x) for x in (v or [])[:16] if isinstance(x, int | float) and not isinstance(x, bool) and math.isfinite(x))


def parse_text_items(obj: Any) -> list[dict[str, Any]] | None:
    """Items of a ``text_items.json.gz``: contracts ``kamutan.text-items/1`` (ids ``ti_…``) or Worker-Text's
    ``kamutan.textItems/1`` (ids ``t_…``, catalog fields; marked ``_catalog``). None when the object is neither.
    Unknown fields are ignored; items without text / bbox / a valid id are dropped."""
    if not isinstance(obj, dict) or not isinstance(obj.get("items"), list):
        return None
    schema = obj.get("schema")
    if schema not in (TEXT_ITEMS_SCHEMA, CATALOG_SCHEMA):
        return None
    out: list[dict[str, Any]] = []
    for it in obj["items"]:
        if not isinstance(it, dict) or not isinstance(it.get("text"), str) or _bbox(it.get("bboxMm")) is None:
            continue
        iid = it.get("id")
        if not isinstance(iid, str) or not re.fullmatch(r"t[i]?_[A-Za-z0-9_-]{1,125}", iid):
            continue
        if schema == CATALOG_SCHEMA:
            if it.get("pairedWith"):  # folded into its partner (feed + switch = one item)
                continue
            it = {**it, "_catalog": True, "scope": KIND_SCOPE.get(str(it.get("kind")), "other"),
                  "normText": it.get("normalized")}  # fmt: skip
        out.append(it)
        if len(out) >= MAX_TEXTS_PER_SHEET:
            break
    return out


def legend_boxes(obj: Any) -> list[tuple[float, float, float, float]]:
    """Legend boxes (x, y, w, h) of a ``legend.json.gz`` (``kamutan.legend/1``)."""
    if not isinstance(obj, dict):
        return []
    return [b for lg in obj.get("legends") or [] if isinstance(lg, dict) and (b := _bbox(lg.get("bboxMm"))) is not None]


def _inside(b: tuple[float, float, float, float], x: float, y: float) -> bool:
    return b[0] <= x <= b[0] + b[2] and b[1] <= y <= b[1] + b[3]


def sheet_entries(
    sheet_id: str,
    version_id: str,
    discipline: str,
    texts: list[dict[str, Any]],
    text_items: list[dict[str, Any]] | None,
    legends: list[tuple[float, float, float, float]],
    floor_of: Any,
    room_of: Any,
) -> list[TextEntry]:
    """Text entries of one sheet version. ``floor_of(x, y)`` / ``room_of(x, y)`` place a point (callables)."""
    out: list[TextEntry] = []
    if text_items is not None:
        for t in text_items:
            b = _bbox(t.get("bboxMm"))
            s = str(t.get("text") or "")
            if b is None or not s.strip():
                continue
            x, y = b[0] + b[2] / 2, b[1] + b[3] / 2
            a = t.get("anchorMm")
            anchor = (float(a["x"]), float(a["y"])) if isinstance(a, dict) and {"x", "y"} <= set(a) else None
            scope = str(t.get("scope")) if t.get("scope") in ITEM_SCOPES else "other"
            fl = t.get("floor") if isinstance(t.get("floor"), str) and t.get("floor") else floor_of(x, y)
            rid = t.get("roomId") if isinstance(t.get("roomId"), str) and t.get("roomId") else room_of(x, y)
            lc = t.get("lifecycle") if t.get("lifecycle") in ("new", "existing", "demolish") else None
            norm = norm_he(str(t["normText"])) if isinstance(t.get("normText"), str) and t.get("normText") else norm_he(s)
            cat = t.get("_catalog") is True
            eid = str(t["id"])
            if cat:  # evidence the API can resolve: the first text.json.gz line of the item
                li = [i for i in (t.get("lineIdx") or []) if isinstance(i, int) and i >= 0]
                eid = f"text_{li[0]}" if li else f"ti_{eid}"
            lengths = _nums(t.get("lengthsM")) or _nums([t.get("lengthM")] if t.get("lengthM") is not None else [])
            code = t.get("itemCode") if cat and isinstance(t.get("itemCode"), str) and t.get("itemCode") else None
            iq = t.get("qty")
            out.append(TextEntry(sheet_id, version_id, discipline, eid[:128], s, norm, x, y, b, scope, fl, rid, lc,
                                 _nums(t.get("numbers")), lengths, anchor,
                                 str(t.get("level")) if t.get("level") in ("green", "yellow", "red") else "yellow",
                                 tuple(str(r)[:64] for r in (t.get("reasons") or [])[:8] if isinstance(r, str)),
                                 cat, code,
                                 float(iq) if isinstance(iq, int | float) and not isinstance(iq, bool) else None,
                                 bool(t.get("corroborates")), bool(t.get("suggested")),
                                 _per_floor(t.get("matchedPattern"))))  # fmt: skip
        return out
    for n, t in enumerate(texts[:MAX_TEXTS_PER_SHEET]):
        s = str(t.get("text") or "")
        b = _bbox(t.get("bboxMm"))
        if not s.strip() or b is None:
            continue
        x, y = b[0] + b[2] / 2, b[1] + b[3] / 2
        scope = "legend" if any(_inside(lb, x, y) for lb in legends) else UNKNOWN_SCOPE
        out.append(TextEntry(sheet_id, version_id, discipline, f"text_{n}", s, norm_he(s), x, y, b, scope,
                             floor_of(x, y), room_of(x, y)))  # fmt: skip
    return out


def _per_floor(pattern_id: Any) -> bool:
    """Worker-Text catalog entries counted once per floor over all sheets (the ventilator on three plans)."""
    try:
        from ..textitems.catalog import BY_ID
    except ImportError:  # pragma: no cover - Worker-Text package missing
        return False
    e = BY_ID.get(str(pattern_id or ""))
    return bool(getattr(e, "per_floor", False))


def catalog_counts(e: TextEntry, code: str | None) -> bool:
    """A Worker-Text catalog item is a countable instance of ``code`` (not evidence-only, not a suggestion, not
    folded / zero)."""
    return e.catalog and e.item_code == code and not e.corroborates and not e.suggested and (e.item_qty or 0) > 0


def scope_ok(want: str, have: str) -> bool:
    if have == UNKNOWN_SCOPE:
        return want in ("note", "callout", "any")
    if want == "any":
        return have != "title"
    return want == have


def first_match(e: TextEntry, pats: list[re.Pattern[str]], excl: list[re.Pattern[str]]) -> re.Match[str] | None:
    if any(p.search(e.norm) for p in excl):
        return None
    return next((m for p in pats if (m := p.search(e.norm)) is not None), None)


Cluster = list[tuple[TextEntry, "re.Match[str]"]]


def clusters(hits: list[tuple[TextEntry, re.Match[str]]], proximity: float) -> list[Cluster]:
    """Greedy single-link clusters per sheet (paper mm), deterministic (sheet, y, x, id order)."""
    out: list[Cluster] = []
    for e, m in sorted(hits, key=lambda h: (h[0].sheet_id, round(h[0].y, 3), round(h[0].x, 3), h[0].id)):
        home = None
        if proximity > 0:
            home = next(
                (
                    c
                    for c in out
                    if c[0][0].sheet_id == e.sheet_id and any(math.dist((o.x, o.y), (e.x, e.y)) <= proximity for o, _ in c)
                ),
                None,
            )
        if home is None:
            out.append([(e, m)])
        else:
            home.append((e, m))
    return out


def per_floor_authority(cs: list[Cluster], disciplines: list[str]) -> list[Cluster]:
    """Per floor keep the clusters of one sheet: the first discipline of ``disciplines`` (rule order) with a match on
    that floor, then the sheet with most clusters, then the sheet id. Without disciplines every sheet counts."""
    if not disciplines:
        return cs
    rank = {d: i for i, d in enumerate(disciplines)}
    by_floor: dict[str | None, dict[str, list[Cluster]]] = {}
    for c in cs:
        by_floor.setdefault(c[0][0].floor, {}).setdefault(c[0][0].sheet_id, []).append(c)
    keep: list[Cluster] = []
    for fl in sorted(by_floor, key=lambda f: f or ""):
        sheets = by_floor[fl]
        best = min(sheets, key=lambda sid: (rank.get(sheets[sid][0][0][0].discipline, len(rank)), -len(sheets[sid]), sid))
        keep.extend(sheets[best])
    return sorted(keep, key=lambda c: (c[0][0].sheet_id, c[0][0].y, c[0][0].x, c[0][0].id))


_NUM = re.compile(r"\d+(?:[.,]\d+)?")


def _num(s: str | None) -> float | None:
    m = _NUM.search(s or "")
    return float(m.group(0).replace(",", ".")) if m else None


def _group1(m: re.Match[str]) -> float | None:
    if m.re.groups < 1 or m.group(1) is None:
        return None
    return _num(m.group(1))


_ANY = re.compile("")


def cluster_qty(mode: str, c: Cluster) -> float | None:
    """Quantity of one merged match (contracts TEXT_QTY_MODES); None = no quantity found (the match is skipped). A
    Worker-Text catalog item brings its own quantity (pairing / grouping already applied)."""
    cat = next((e.item_qty for e, _ in c if e.catalog and e.item_qty), None)
    if cat is not None and mode != "length_in_text_m":
        return cat
    for e, m in c:
        g = _group1(m)
        if mode == "count":
            return g if g is not None and g > 0 else 1.0
        if mode == "number_in_text":
            v = g if g is not None else (e.numbers[0] if e.numbers else _num(e.norm))
            if v is not None and v > 0:
                return v
        elif mode == "length_in_text_m":
            v = e.lengths_m[0] if e.lengths_m else g
            if v is not None and v > 0:
                return v
    return 1.0 if mode in ("count", "one") else None


def entry_det(e: TextEntry) -> Det:
    return Det(e.sheet_id, e.version_id, e.id, "text", e.x, e.y, e.level, list(e.reasons), e.floor,
               e.lifecycle or "new", None, e.discipline, 1.0, room_id=e.room_id, target="text", bbox=e.bbox)  # fmt: skip


def _box_dist(e: TextEntry, x: float, y: float) -> float:
    if e.anchor is not None:
        return math.dist(e.anchor, (x, y))
    bx, by, bw, bh = e.bbox
    dx = max(bx - x, 0.0, x - (bx + bw))
    dy = max(by - y, 0.0, y - (by + bh))
    return math.hypot(dx, dy)


@dataclass
class TextUnit:
    rule: Rule
    members: list[TextEntry]
    qty: float
    floor: str | None


def text_item_units(rules: list[Rule], entries: list[TextEntry], dets: list[Det]) -> tuple[list[TextUnit], dict[str, Any]]:
    """Units of every ``text_item`` rule (rules sorted by priority) over all sheets' text entries. ``dets``: the live
    detections (``nearClasses``); a detection consumed by a ``consumeNear`` rule gets ``dropped_by = text:{ruleId}``."""
    out: list[TextUnit] = []
    stats: dict[str, Any] = {"rules": 0, "matches": 0, "units": 0, "consumed": 0}
    by_sheet: dict[str, list[Det]] = {}
    for d in dets:
        by_sheet.setdefault(d.sheet_id, []).append(d)
    for r in (x for x in rules if x.kind == "text_item"):
        m = r.match
        pats, excl = patterns_of(m), patterns_of(m, "excludePatterns")
        if not pats:
            continue
        stats["rules"] += 1
        scope = str(m.get("scope") or "any")
        disc = [str(d) for d in m.get("disciplines") or []]
        floors = {str(f) for f in m.get("floors") or []}
        lcs = {str(x) for x in m.get("lifecycle") or []}
        prox = float(m["proximityMm"]) if isinstance(m.get("proximityMm"), int | float) else 0.0
        prox = max(0.0, min(prox, 5000.0))
        near = {str(c) for c in m.get("nearClasses") or []}
        by_code = m.get("matchCatalogCode") is not False  # contracts default true
        hits: list[tuple[TextEntry, re.Match[str]]] = []
        attached: dict[tuple[str, str], Det] = {}
        for e in entries:
            if (disc and e.discipline not in disc) or (floors and e.floor not in floors) or not scope_ok(scope, e.scope):
                continue
            if lcs and e.lifecycle is not None and e.lifecycle not in lcs:
                continue
            if by_code and e.catalog and e.item_code is not None:
                # a catalog item belongs to its own code: counted by this rule only when the codes agree
                if not catalog_counts(e, r.item_code):
                    continue
                mt = _ANY.search(e.norm)
                assert mt is not None
            else:
                mt = first_match(e, pats, excl)
                if mt is None:
                    continue
            if near:
                cand = [(_box_dist(e, d.x, d.y), d.id, d) for d in by_sheet.get(e.sheet_id, [])
                        if d.cls in near and d.dropped_by is None and _box_dist(e, d.x, d.y) <= prox]  # fmt: skip
                if not cand:
                    continue
                attached[e.key] = min(cand, key=lambda t: (t[0], t[1]))[2]
            hits.append((e, mt))
        cs = per_floor_authority(clusters(hits, prox), disc)
        stats["matches"] += sum(len(c) for c in cs)
        if m.get("consumeNear") and near:
            for c in cs:
                for e, _ in c:
                    att = attached.get(e.key)
                    # only the symbol the text sits on is the text's item: within CONSUME_NEAR_MAX_MM, whatever the
                    # rule's (filter) proximity — a comms-panel label 17 mm from the unit panel must not take it from 4.24
                    if att is not None and att.dropped_by is None and _box_dist(e, att.x, att.y) <= CONSUME_NEAR_MAX_MM:
                        att.dropped_by = f"text:{r.id}"
                        stats["consumed"] += 1
        # a Worker-Text catalog item drawn as a symbol run (a cobra conduit whose callout says "למקרן") is the detection
        # at its anchor: counted here, so not again by that detection's class rule
        for c in cs:
            for e, _ in c:
                if not e.catalog or e.anchor is None:
                    continue
                for d in by_sheet.get(e.sheet_id, []):
                    if d.dropped_by is None and math.dist(e.anchor, (d.x, d.y)) <= ANCHOR_SAME_MM:
                        d.dropped_by = f"text:{r.id}"
                        stats["consumed"] += 1
        mode = str(m.get("qty") or "count")
        if mode == "one":
            if cs:
                out.append(TextUnit(r, [c[0][0] for c in cs], 1.0, cs[0][0][0].floor))
            continue
        for c in cs:
            q = cluster_qty(mode, c)
            if q is not None:
                out.append(TextUnit(r, [e for e, _ in c], float(q), c[0][0].floor))
    stats["units"] = len(out)
    return out, stats


def catalog_units(
    entries: list[TextEntry],
    ruled_codes: set[str],
    produced_codes: set[str],
    order: list[str],
    *,
    suggested: bool = False,
) -> list[tuple[str, list[TextEntry], float, str | None]]:
    """Worker-Text catalog items for codes no ``text_item`` rule targets (``ruled_codes``): one unit per item (one per
    (code, floor) for per-floor entries), per floor only the sheets of the first discipline of ``order`` that has the
    code there. Items of a code already produced (``produced_codes``) are skipped. ``suggested=False``: countable
    items, plus evidence-only (``corroborates``) items of a code no symbol / link produced (the symbol was not
    detected); ``suggested=True``: the catalog's suggestions (drawings show a trigger, not the item). Returns
    ``(code, members, qty, floor)`` tuples."""
    rank = {d: i for i, d in enumerate(order)}
    picked: dict[tuple[str, str | None], dict[str, list[TextEntry]]] = {}
    for e in entries:
        if not e.catalog or not e.item_code or e.item_code in ruled_codes or e.item_code in produced_codes:
            continue
        if not e.item_qty or e.item_qty <= 0 or e.suggested != suggested:
            continue
        picked.setdefault((e.item_code, e.floor), {}).setdefault(e.sheet_id, []).append(e)
    out: list[tuple[str, list[TextEntry], float, str | None]] = []
    for (code, floor), sheets in sorted(picked.items(), key=lambda kv: (kv[0][0], kv[0][1] or "")):
        best = min(sheets, key=lambda sid: (rank.get(sheets[sid][0].discipline, len(rank)), -len(sheets[sid]), sid))
        es = sorted(sheets[best], key=lambda e: (e.y, e.x, e.id))
        if any(e.per_floor for e in es):
            out.append((code, es, float(es[0].item_qty or 1.0), floor))
        else:
            out.extend((code, [e], float(e.item_qty or 1.0), floor) for e in es)
    return out
