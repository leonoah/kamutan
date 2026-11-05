"""Sprint 6: BOQ lines from drawing geometry — rule kinds ``area_item`` / ``length_item`` (pure). Contracts:
``GeometryItemMatchSchema`` (library.ts) + ``kamutan.geometry/1`` features (takeoff.ts)::

    match = {source: hatch|room|wall_run|polyline|stair, keys?, categories?, legendPatterns?, disciplines?, floors?,
             roomTypes?, lifecycle?, measure?: area|length|wall_area|count|treads, heightM?, sides?: 1|2, minQty?,
             faces?: 1|2, heightMode?: storey|drawn}

Features of ``source`` (feature ``kind``), of one of ``categories`` (when given) AND whose ``legendLabel`` matches one
of ``legendPatterns`` (when given), filtered by sheet discipline, floor, room types (any of the feature's rooms, mapped
to the canonical room), lifecycle (a feature without one passes). Quantity per feature by ``measure`` (default: hatch /
room / polyline → area for area_item, length for length_item; wall_run → wall_area / length; stair → treads):
``wall_area`` = ``wallAreaM2``, else ``lengthM`` × (rule ``heightM``, else the feature's) × ``sides`` (no height → the
feature is skipped, ``stats.noHeight``); ``count`` = ``count`` ?? 1; ``treads`` = ``stair.treads``. Features below
``minQty`` are ignored. Missing real-world sizes are computed from the paper-mm shape and the sheet scale.

``faces`` / ``heightMode`` (with ``keys``, the partition measures — owner decision 05.11 for 7.06): ``faces: 2`` counts
both faces of a free-standing partition (a lining against an existing / masonry wall keeps one), ``heightMode: storey``
takes the storey's floor-to-ceiling height (a low wall keeps its drawn height); each element's m² and reason
("מחיצה דו-צדדית בגובה קומה" / "חיפוי חד-צדדי") go on its evidence item. Neither given → the measure as produced.

Worker convention: per floor one sheet counts (the first of ``disciplines``, default construction > architecture >
architecture_master > the rest), so a wall drawn on two plans is counted once. Evidence: one item per feature
(``detectionId`` = the ``g_…`` id, ``kind`` geometry | stair, ``geometryMm``, ``stair``, ``quantity``, ``roomId``).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field, replace
from typing import Any

from .dedup import Det
from .rules import Rule
from .spaces import ROOM_SOURCE_ORDER
from .textitems import norm_he, patterns_of

GEOMETRY_SCHEMA = "kamutan.geometry/1"
HEIGHT_MODES = ("storey", "drawn")
SOURCES = ("hatch", "room", "wall_run", "polyline", "stair")
MEASURES = ("area", "length", "wall_area", "count", "treads")
MAX_FEATURES = 20_000
MAX_EVIDENCE_POINTS = 2000
_ID = re.compile(r"[a-z]{1,3}_[A-Za-z0-9_-]{1,124}")


@dataclass(frozen=True)
class GeoItem:
    sheet_id: str
    version_id: str
    discipline: str
    id: str  # g_…
    kind: str  # GeometrySource
    category: str
    legend_label: str
    floor: str | None
    room_ids: tuple[str, ...]
    lifecycle: str | None
    area_m2: float | None
    length_m: float | None
    height_m: float | None
    wall_area_m2: float | None
    count: int | None
    treads: int | None
    risers: int | None
    from_floor: str | None
    to_floor: str | None
    stair_key: str | None
    points: tuple[tuple[float, float], ...]
    closed: bool
    level: str = "yellow"
    reasons: tuple[str, ...] = field(default_factory=tuple)


def _pts(v: Any) -> tuple[tuple[float, float], ...]:
    out = []
    for p in v or []:
        try:
            out.append((float(p["x"]), float(p["y"])))
        except (KeyError, TypeError, ValueError):
            continue
    return tuple(out)


def _pos(v: Any) -> float | None:
    return float(v) if isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v) and v >= 0 else None


def _int(v: Any) -> int | None:
    return int(v) if isinstance(v, int | float) and not isinstance(v, bool) and v >= 0 else None


def shoelace_mm2(pts: tuple[tuple[float, float], ...]) -> float:
    n = len(pts)
    if n < 3:
        return 0.0
    return abs(sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n))) / 2


def polyline_mm(pts: tuple[tuple[float, float], ...], closed: bool = False) -> float:
    n = len(pts)
    segs = sum(math.dist(pts[i], pts[i + 1]) for i in range(n - 1)) if n >= 2 else 0.0
    return segs + (math.dist(pts[-1], pts[0]) if closed and n >= 3 else 0.0)


def parse_geometry(obj: Any, sheet_id: str, version_id: str, discipline: str, scale: int | None, floor_of: Any) -> list[GeoItem]:
    """Features of a ``geometry.json.gz``; [] when it is not one. ``floor_of(x, y)`` places features without a floor."""
    if not isinstance(obj, dict) or obj.get("schema") != GEOMETRY_SCHEMA:
        return []
    if not isinstance(obj.get("features"), list):
        obj = {**obj, "features": features_from_worker_shape(obj)}
    sd = obj.get("scaleDenominator")
    k = float(sd if isinstance(sd, int | float) and sd > 0 else (scale or 50)) / 1000.0  # paper mm → real m
    out: list[GeoItem] = []
    for f in obj["features"][:MAX_FEATURES]:
        if (
            not isinstance(f, dict)
            or f.get("kind") not in SOURCES
            or not isinstance(f.get("id"), str)
            or not _ID.fullmatch(f["id"])
        ):
            continue
        poly, line = _pts(f.get("polygonMm")), _pts(f.get("polylineMm"))
        pts, closed = (line, False) if line else (poly, True)
        area, length = _pos(f.get("areaM2")), _pos(f.get("lengthM"))
        if area is None and closed and len(pts) >= 3:
            area = shoelace_mm2(pts) * k * k
        if length is None and len(pts) >= 2:
            length = polyline_mm(pts, closed) * k
        cx = sum(p[0] for p in pts) / len(pts) if pts else 0.0
        cy = sum(p[1] for p in pts) / len(pts) if pts else 0.0
        st: dict[str, Any] = f["stair"] if isinstance(f.get("stair"), dict) else {}
        fl = f.get("floor") if isinstance(f.get("floor"), str) and f.get("floor") else floor_of(cx, cy)
        out.append(
            GeoItem(
                sheet_id,
                version_id,
                discipline,
                f["id"],
                str(f["kind"]),
                str(f.get("category") or "unknown"),
                str(f.get("legendLabel") or ""),
                fl,
                tuple(str(r) for r in (f.get("roomIds") or [])[:32] if isinstance(r, str)),
                str(f["lifecycle"]) if f.get("lifecycle") in ("new", "existing", "demolish") else None,
                area,
                length,
                _pos(f.get("heightM")) or None,
                _pos(f.get("wallAreaM2")),
                _int(f.get("count")),
                _int(st.get("treads")),
                _int(st.get("risers")),
                str(st["fromFloor"]) if isinstance(st.get("fromFloor"), str) and st.get("fromFloor") else None,
                str(st["toFloor"]) if isinstance(st.get("toFloor"), str) and st.get("toFloor") else None,
                str(st["key"]) if isinstance(st.get("key"), str) and st.get("key") else None,
                pts,
                closed,
                str(f.get("level")) if f.get("level") in ("green", "yellow", "red") else "yellow",
                tuple(str(r)[:64] for r in (f.get("reasons") or [])[:8] if isinstance(r, str)),
            )
        )
    return out


# Worker-Geometry's ``kamutan.geometry/1`` collections (contracts takeoff.ts: stairs / regions / wallRuns / lines /
# ceilings / courtyards) → uniform features. Categories = the producer's codes (contracts GEOMETRY_CATEGORIES).
COLLECTIONS = (("stairs", "stair"), ("regions", "hatch"), ("wallRuns", "wall_run"), ("lines", "polyline"),
               ("ceilings", "hatch"), ("courtyards", "wall_run"))  # fmt: skip


def _lc(v: Any) -> str | None:
    return str(v) if v in ("new", "existing", "demolish") else None


def features_from_worker_shape(obj: dict[str, Any]) -> list[dict[str, Any]]:
    """The artifact's shape collections as uniform feature dicts (ids kept: ``st_`` / ``hr_`` / ``wr_`` / ``ln_`` /
    ``cl_`` / ``cy_``)."""
    out: list[dict[str, Any]] = []
    for coll, kind in COLLECTIONS:
        for it in (x for x in obj.get(coll) or [] if isinstance(x, dict)):
            rooms = [str(r) for r in (it.get("roomIds") or ([it["roomId"]] if it.get("roomId") else [])) if isinstance(r, str)]
            f: dict[str, Any] = {"id": str(it.get("id") or f"{coll}_{len(out)}"), "kind": kind, "floor": it.get("floor"),
                                 "legendLabel": it.get("label"), "roomIds": rooms, "lifecycle": _lc(it.get("lifecycle")),
                                 "level": it.get("level"), "reasons": it.get("reasons") or [],
                                 "polygonMm": it.get("polygonMm"), "polylineMm": it.get("polylineMm")}  # fmt: skip
            if coll == "stairs":
                f.update(category="stair", stair={"treads": it.get("treads"), "risers": it.get("risers"), "key": it.get("key")})
            elif coll == "regions":
                f.update(category=it.get("category"), areaM2=it.get("areaM2"))
            elif coll == "wallRuns":
                f.update(
                    category=it.get("kind"), lengthM=it.get("lengthM"), heightM=it.get("heightM"), wallAreaM2=it.get("areaM2")
                )
            elif coll == "lines":
                f.update(category=it.get("kind"), lengthM=it.get("lengthM"), heightM=it.get("heightM"))
            elif coll == "ceilings":
                f.update(category=it.get("kind") or "gypsum_ceiling", areaM2=it.get("areaM2"))
            else:
                f.update(category="courtyard", lengthM=it.get("wallLengthM"), heightM=it.get("wallHeightM"),
                         wallAreaM2=it.get("wallAreaM2"))  # fmt: skip
            out.append(f)
    return out


AREA_UNITS = frozenset({'מ"ר', "מר", "m2", "m²", "sqm"})
LENGTH_UNITS = frozenset({'מ"א', "מא", "מ'", "מטר", "m", "lm"})


def unit_kind(unit: str) -> str:
    """area | length | lump | count of a BOQ unit (contracts ``defaultQuickActionFor`` spellings)."""
    u = unit.replace("״", '"').replace("׳", "'").replace("''", '"').replace(" ", "").lower()
    if u in AREA_UNITS:
        return "area"
    if u in LENGTH_UNITS:
        return "length"
    if u in ("קומפלט", "קומפ'", "lump"):
        return "lump"
    return "count"


def default_measure(kind: str, source: str) -> str:
    if source == "stair":
        return "treads"
    if source == "wall_run":
        return "wall_area" if kind == "area_item" else "length"
    return "area" if kind == "area_item" else "length"


@dataclass
class GeoUnit:
    rule: Rule | None
    det: Det
    qty: float
    floor: str | None
    level: str
    origin: str = "geometry"  # "suggested": a measure Worker-Geometry could only estimate
    reasons: list[str] = field(default_factory=list)
    extra: list[Det] = field(default_factory=list)  # more evidence of the same unit (a measure's other shapes)
    ev_qty: dict[str, float] | None = None  # per evidence (Det.key) quantity when known (else an even share)


def _bbox(pts: tuple[tuple[float, float], ...]) -> tuple[float, float, float, float] | None:
    if not pts:
        return None
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return (min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys))


def _simplify(pts: tuple[tuple[float, float], ...]) -> tuple[tuple[float, float], ...]:
    if len(pts) <= MAX_EVIDENCE_POINTS:
        return pts
    step = math.ceil(len(pts) / MAX_EVIDENCE_POINTS)
    return pts[::step][:MAX_EVIDENCE_POINTS]


def geo_det(g: GeoItem, rooms: tuple[str, ...]) -> Det:
    b = _bbox(g.points)
    cx, cy = (b[0] + b[2] / 2, b[1] + b[3] / 2) if b else (0.0, 0.0)
    return Det(g.sheet_id, g.version_id, g.id, g.category or g.kind, cx, cy, g.level, list(g.reasons), g.floor,
               g.lifecycle or "new", None, g.discipline, 1.0, room_id=rooms[0] if rooms else None,
               target="stair" if g.kind == "stair" else "geometry", bbox=b, shape=_simplify(g.points) or None,
               closed=g.closed, treads=(g.treads, g.risers) if g.kind == "stair" and g.treads is not None else None)  # fmt: skip


def _authority(units: list[GeoUnit], disciplines: list[str]) -> list[GeoUnit]:
    order = disciplines or list(ROOM_SOURCE_ORDER)
    rank = {d: i for i, d in enumerate(order)}
    by_floor: dict[str | None, dict[str, list[GeoUnit]]] = {}
    for u in units:
        by_floor.setdefault(u.floor, {}).setdefault(u.det.sheet_id, []).append(u)
    out: list[GeoUnit] = []
    for fl in sorted(by_floor, key=lambda f: f or ""):
        sheets = by_floor[fl]
        best = min(sheets, key=lambda sid: (rank.get(sheets[sid][0].det.discipline, len(rank)), -len(sheets[sid]), sid))
        out.extend(sheets[best])
    return out


def feature_qty(g: GeoItem, measure: str, height: float | None, sides: int) -> float | None:
    if measure == "area":
        return g.area_m2
    if measure == "length":
        return g.length_m
    if measure == "wall_area":
        if g.wall_area_m2 is not None:  # one face, openings deducted by the producer
            return g.wall_area_m2 * sides
        h = height or g.height_m
        return g.length_m * h * sides if g.length_m is not None and h else None
    if measure == "count":
        return float(g.count if g.count is not None else 1)
    return float(g.treads) if g.treads is not None else None


def select(m: dict[str, Any], kind: str, items: list[GeoItem], room_type: Any) -> tuple[list[GeoUnit], dict[str, int]]:
    """Features of one geometry selection (``area_item`` / ``length_item`` match or a suggested ``geometry`` estimate)
    → (unit stubs without a rule, counters). ``room_type(sheet_id, room_id) -> type | None``."""
    st = {"noHeight": 0, "noQty": 0}
    src = str(m.get("source") or "")
    if src not in SOURCES:
        return [], st
    cats = {str(c) for c in m.get("categories") or []}
    lpats = patterns_of(m, "legendPatterns")
    floors = {str(f) for f in m.get("floors") or []}
    types = {str(t) for t in m.get("roomTypes") or []}
    disc = [str(d) for d in m.get("disciplines") or []]
    lcs = {str(x) for x in m.get("lifecycle") or []}
    measure = str(m["measure"]) if m.get("measure") in MEASURES else default_measure(kind, src)
    height = _pos(m.get("heightM")) or None
    sides = 2 if m.get("sides") == 2 else 1
    min_qty = _pos(m.get("minQty")) or 0.0
    out: list[GeoUnit] = []
    for g in items:
        if g.kind != src or (cats and g.category not in cats) or (floors and g.floor not in floors):
            continue
        if lpats and not any(p.search(norm_he(g.legend_label)) for p in lpats):
            continue
        if (disc and g.discipline not in disc) or (lcs and g.lifecycle is not None and g.lifecycle not in lcs):
            continue
        if types and not any(room_type(g.sheet_id, rid) in types for rid in g.room_ids):
            continue
        q = feature_qty(g, measure, height, sides)
        if q is None:
            st["noHeight" if measure == "wall_area" else "noQty"] += 1
            continue
        if q <= 0 or q < min_qty:
            st["noQty"] += 1
            continue
        out.append(GeoUnit(None, geo_det(g, g.room_ids), round(q, 4), g.floor, g.level))
    out = _authority(out, disc)
    return (_dedupe_stairs(out, items) if src == "stair" else out), st


def _dedupe_stairs(units: list[GeoUnit], items: list[GeoItem]) -> list[GeoUnit]:
    """The same flight seen from both floors it connects (basement and ground plans) is one stair: features with the
    same {fromFloor, toFloor} and tread count, else the same tread count on adjacent floors, count once (the lower
    floor's copy is kept)."""
    by_id = {(g.sheet_id, g.id): g for g in items}
    order = {f: i for i, f in enumerate(("basement", "ground", "first", "second", "third", "fourth", "roof"))}
    kept: list[GeoUnit] = []
    for u in sorted(units, key=lambda u: (order.get(u.floor or "", 99), u.det.sheet_id, u.det.id)):
        g = by_id.get((u.det.sheet_id, u.det.id))
        dup = False
        for k in kept:
            h = by_id.get((k.det.sheet_id, k.det.id))
            if g is None or h is None or g.treads != h.treads:
                continue
            if g.stair_key and h.stair_key:
                if g.stair_key == h.stair_key:
                    dup = True
                    break
                continue
            span_g, span_h = {g.from_floor, g.to_floor} - {None}, {h.from_floor, h.to_floor} - {None}
            if span_g and span_h:
                dup = span_g == span_h
            else:
                fa, fb = order.get(u.floor or ""), order.get(k.floor or "")
                dup = fa is not None and fb is not None and abs(fa - fb) <= 1
            if dup:
                break
        if not dup:
            kept.append(u)
    return kept


def key_units(m: dict[str, Any], items: list[GeoItem], docs: list[dict[str, Any]]) -> list[GeoUnit]:
    """``keys`` selector (contracts): the project-level Worker-Geometry measures of the keys
    (``geometry.project.geometry_units``: one authoritative sheet per floor, stairs de-duplicated). Computable → one
    unit per floor (evidence = the measure's shapes on that floor); not computable with an estimate → an estimated
    (``origin: suggested``) unit; otherwise nothing (the code's ``suggested_item`` rule offers it)."""
    keys = [str(k) for k in m.get("keys") or [] if k]
    if not keys or not docs:
        return []
    try:
        from ..geometry.project import geometry_units as project_measures
    except ImportError:  # pragma: no cover - Worker-Geometry package missing
        return []
    by_ref = {(g.sheet_id, g.id): g for g in items}
    floors = {str(f) for f in m.get("floors") or []}
    faces = m.get("faces") if m.get("faces") in (1, 2) else None
    height_mode = m.get("heightMode") if m.get("heightMode") in HEIGHT_MODES else None
    out: list[GeoUnit] = []
    for mes in project_measures(docs, keys=keys, faces=faces, height_mode=height_mode):
        # per element of a convention measure: its m² and reason (sheetId, id) → (areaM2, reason)
        elems = {(str(i.get("sheetId")), str(i.get("id"))): (_pos(i.get("areaM2")), i.get("reason"))
                 for i in mes.get("items") or [] if isinstance(i, dict)}  # fmt: skip
        refs = [by_ref[(str(r.get("sheetId")), str(r.get("id")))] for r in mes.get("refs") or []
                if (str(r.get("sheetId")), str(r.get("id"))) in by_ref]  # fmt: skip
        level = str(mes.get("level")) if mes.get("level") in ("green", "yellow", "red") else "yellow"
        reasons = [str(x)[:64] for x in (mes.get("reasons") or [])[:8]]
        by_floor = {str(f): float(q) for f, q in (mes.get("byFloor") or {}).items() if isinstance(q, int | float) and q > 0}
        est = mes.get("estimate") if isinstance(mes.get("estimate"), dict) else None
        if mes.get("computable") and mes.get("qty"):
            origin = "geometry"
        else:
            # not computable from the drawings (e.g. a wall height that is not drawn): a suggested line the user must
            # measure (needsInput, qty 0); Worker-Geometry's estimate is only a hint in the reasons
            origin = "suggested"
            hint = None
            if est and isinstance(est.get("qty"), int | float) and est["qty"] > 0:
                unit = str(mes.get("unit") or "")
                hint = f"הערכה: {float(est['qty']):g} {unit}".strip() + (f" ({est.get('method')})" if est.get("method") else "")
            reasons = [x for x in [str(mes.get("reason") or "")[:200], (hint or "")[:200], *reasons] if x]
            fls = [str(g.floor) for g in refs if g.floor] or [str(f) for f in by_floor] or [str(mes.get("floor") or "unknown")]
            by_floor = {fl: 0.0 for fl in sorted(set(fls))}
        for fl, q in sorted(by_floor.items()):
            if floors and fl not in floors:
                continue
            here = [g for g in refs if str(g.floor) == fl] or refs
            dets = [geo_det(g, g.room_ids) for g in here] or _measure_sheet(docs, str(mes.get("key")), fl)
            if not dets:
                continue
            ev: dict[str, float] | None = None
            if origin == "geometry":
                # Sprint 7: the measure was computed (its height possibly shared from another sheet of the floor, or read
                # from a mark): the stored items' own reasons ("הגובה אינו מופיע בשרטוט" of the construction sheet) are
                # stale — the line keeps only the reasons of the measure that was used
                dets = [replace(d, reasons=[]) for d in dets]
                if elems:
                    dets = [replace(d, note=str(e[1])[:200]) if (e := elems.get((d.sheet_id, d.id))) and e[1] else d
                            for d in dets]  # fmt: skip
                    known = {d.key: e[0] for d in dets if (e := elems.get((d.sheet_id, d.id))) and e[0] is not None}
                    if len(known) == len(dets) and abs(sum(known.values()) - q) <= 0.01 * max(q, 1.0):
                        ev = {k: round(v, 4) for k, v in known.items()}
            out.append(GeoUnit(None, dets[0], round(q, 4), None if fl in ("None", "unknown") else fl, level, origin,
                               list(reasons), dets[1:], ev))  # fmt: skip
    return out


def _measure_sheet(docs: list[dict[str, Any]], key: str, floor: str) -> list[Det]:
    """Evidence of a measure without shapes (an estimate): the sheet that carries it (``detectionId: "sheet"``)."""
    for d in docs:
        for m in d.get("measures") or []:
            if isinstance(m, dict) and m.get("key") == key and str(m.get("floor")) == floor and d.get("versionId"):
                return [Det(str(d["sheetId"]), str(d["versionId"]), "sheet", "sheet", 0.0, 0.0, "yellow", [],
                            None if floor in ("None", "unknown") else floor, "new", None, str(d.get("discipline") or ""), 1.0,
                            target="sheet")]  # fmt: skip
    return []


def geometry_units(
    rules: list[Rule], items: list[GeoItem], room_type: Any, docs: list[dict[str, Any]] | None = None
) -> tuple[list[GeoUnit], dict[str, Any]]:
    """Units of every ``area_item`` / ``length_item`` rule: the ``keys`` selector (Worker-Geometry measures, ``docs`` =
    the build's geometry documents with ``sheetId`` / ``discipline``) when given, else the feature selection."""
    stats: dict[str, Any] = {"features": len(items), "units": 0, "noHeight": 0, "noQty": 0, "estimated": 0}
    out: list[GeoUnit] = []
    for r in (x for x in rules if x.kind in ("area_item", "length_item")):
        if r.match.get("keys"):
            units = key_units(r.match, items, docs or [])
        else:
            units, st = select(r.match, r.kind, items, room_type)
            for k, v in st.items():
                stats[k] += v
        for u in units:
            u.rule = r
            stats["estimated"] += int(u.origin == "suggested")
            out.append(u)
    stats["units"] = len(out)
    return out, stats
