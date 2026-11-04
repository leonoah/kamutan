"""``analyze``: one plan sheet → the ``kamutan.geometry/1`` document (see :mod:`kamutan_drawing.geometry`)."""

from __future__ import annotations

import itertools
import math
import re
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from shapely.geometry import LineString, Point, Polygon, box
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from ..calibration import calibrate
from ..ingest.pdf_vector import VectorSheet
from ..rooms.walls import extract_walls
from . import hatches as H
from . import labels as L
from . import marks as MK
from . import sections as SEC
from . import stairs as S
from .prims import (
    HIGHLIGHTS,
    NEUTRAL,
    bbox_json,
    colour_class,
    fills,
    hex_colour,
    in_zone,
    lifecycle_of,
    line_json,
    plan_zone,
    poly_json,
    polygons_of,
    region_polygon,
    stroked_segments,
    union_parts,
)

GEOMETRY_SCHEMA = "kamutan.geometry/1"
_ALNUM = re.compile(r"[0-9A-Za-zא-ת]")
PLAN_DISCIPLINES = frozenset({"construction", "architecture", "architecture_master", "master", "demolition"})
DEFAULT_SCALE = 50
DEFAULT_CEILING_M = 2.6  # tiling default (Data/QA convention): min(2.6 m, ceiling)
WINDOW_H_M = 1.1  # the tiling convention (TilingParams): window sill 1.0 m, head 2.1 m
DEFAULT_SCREEN_M = 1.2  # concealed-cistern screen ("מסתור ניאגרה") when its H= is not read
WALL_T_M = (0.04, 0.6)
BLOCK_MIN_T_M = 0.17  # an unlabelled new wall this thick is masonry (gypsum partitions: 7–15 cm on the sample)
MIN_RUN_M = 0.15
MIN_REGION_M2 = 0.02
MAX_ITEMS = 256

# Hebrew reasons (user-facing)
R_DEFAULT_H = "גובה לפי ברירת מחדל {h:.2f} מ' — לא נקרא גובה בשרטוט"
R_LEVEL_H = "גובה לפי סימון מפלס בגיליון"
R_LABEL_H = "גובה לפי הכיתוב"
R_ROOM_H = "גובה לפי גובה התקרה בחדר"
R_KIND_THICK = "סוג הקיר לפי עובי בלבד"
R_KIND_LABEL = "סוג הקיר לפי הכיתוב"
R_NO_LABEL = "ללא כיתוב מזהה"
R_STAIR_NUM = "מספור מדרגות בשרטוט"
R_STAIR_LINES = "ספירת קווי מדרגות בלבד (ללא מספור)"
R_STAIR_MISMATCH = "מספור המדרגות שונה ממספר קווי המדרגות"
R_COURT_LEVELS = "גובה הקירות לפי מפלסי החצר בגיליון"
R_NOT_DRAWN_H = "הגובה אינו מופיע בשרטוט"
R_H_ASSUMED = "גובה הקיר הונח כגובה התקרה בקומה ({h:.2f} מ') — לבדיקה"
R_LOW_NO_H = "גובה הקיר הנמוך לא נקרא"
R_GEOM = "כמות מחושבת מגאומטריה — לבדיקה"
R_SECTION_H = "גובה לפי חתך בגיליון ({h:.2f} מ', קנ\"מ לפי סימוני המפלס)"
R_SECTION_FOOTING = "גובה קיר הדיפון לפי החתך: מראש הקיר עד תחתית היסוד"
R_OPENING_H = "גובה הפתח לפי סימון בשרטוט ({h:.2f} מ')"
R_MARK_H = "גובה לפי סימון H= בשרטוט"
R_OTHER_SHEET_H = "גובה לפי אותו פריט בגיליון אחר של הקומה"

KIND_KEYS = {
    "stair": "geometry:stair",
    "region": "geometry:region",
    "wall_run": "geometry:wall_run",
    "line": "geometry:line",
    "ceiling": "geometry:ceiling",
    "courtyard": "geometry:courtyard",
}


@dataclass
class _Room:
    id: str
    name: str | None
    type: str | None
    floor: str | None
    poly: Polygon
    ceiling_m: float | None


@dataclass
class _Ctx:
    sheet_id: str
    discipline: str | None
    floor: str | None
    region_id: str | None
    mm_per_m: float
    zone: BaseGeometry
    walls: BaseGeometry | None
    rooms: list[_Room]
    notes: list[L.Note]
    ceiling: tuple[float, str]
    colours: dict[str, str] | None
    green_threshold: float | None
    out: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    notes_all: list[L.Note] = field(default_factory=list)
    outside: list[BaseGeometry] = field(default_factory=list)  # highlight regions beside the plan (sections, details)


def _rooms_of(rooms: Sequence[Any]) -> list[_Room]:
    out: list[_Room] = []
    for r in rooms:
        if isinstance(r, Mapping):
            pts = r.get("polygonMm") or []
            ring = [(float(p["x"]), float(p["y"])) for p in pts if isinstance(p, Mapping)]
            rid, name, typ, fl, ch = r.get("id"), r.get("name"), r.get("type"), r.get("floor"), r.get("ceilingHeightM")
        else:
            ring = [(float(x), float(y)) for x, y in (getattr(r, "polygon_mm", None) or [])]
            rid, name, typ = getattr(r, "id", None), getattr(r, "name", None), getattr(r, "type", None)
            fl, ch = getattr(r, "floor", None), getattr(r, "ceiling_height_m", None)
        if len(ring) < 3 or rid is None:
            continue
        p = Polygon(ring).buffer(0)
        if p.is_empty:
            continue
        out.append(_Room(str(rid), name, typ, fl, p if isinstance(p, Polygon) else max(polygons_of(p), key=lambda q: q.area), ch))
    return out


def _room_at(ctx: _Ctx, g: BaseGeometry) -> _Room | None:
    best: tuple[float, _Room | None] = (0.0, None)
    for r in ctx.rooms:
        if g.area > 0:
            a = r.poly.intersection(g).area / g.area
        else:
            a = 1.0 if r.poly.contains(g.centroid) else 0.0
        if a > best[0] + 1e-6 or (best[1] is not None and abs(a - best[0]) <= 1e-6 and a > 0 and r.poly.area < best[1].poly.area):
            best = (a, r)
    if best[1] is None:
        c = g.centroid
        near = [(r.poly.distance(c), r) for r in ctx.rooms]
        near = [t for t in near if t[0] <= 0.3 * ctx.mm_per_m]
        if near:
            return min(near, key=lambda t: t[0])[1]
    return best[1]


def _rooms_touching(ctx: _Ctx, g: BaseGeometry) -> list[str]:
    tol = 0.15 * ctx.mm_per_m
    return [r.id for r in ctx.rooms if r.poly.distance(g) <= tol][:16]


def _level(kind: str, score: float, reasons: list[str], ctx: _Ctx) -> tuple[float, str, list[str]]:
    warn = bool(reasons)
    heur = "red" if score < 0.5 else ("green" if score >= 0.85 and not warn else "yellow")
    return calibrate(KIND_KEYS[kind], score, reasons, level=heur, green_threshold=ctx.green_threshold)


def _thickness_length(p: BaseGeometry) -> tuple[float, float]:
    """Thickness and centreline length of a thin (possibly bent) strip from its area and perimeter:
    A = L·t, P ≈ 2(L + t)."""
    a, per = p.area, p.length
    disc = (per / 2.0) ** 2 - 4.0 * a
    t = (per / 2.0 - math.sqrt(max(disc, 0.0))) / 2.0
    if t <= 0:
        return 0.0, 0.0
    return t, a / t


def _height(ctx: _Ctx, g: BaseGeometry, note: L.Note | None) -> tuple[float, str, str]:
    if note is not None and note.height_m is not None:
        return note.height_m, "label", R_LABEL_H
    rs = [r for r in ctx.rooms if r.ceiling_m and r.poly.distance(g) <= 0.2 * ctx.mm_per_m]
    if rs:
        return float(min(r.ceiling_m for r in rs if r.ceiling_m)), "room", R_ROOM_H
    h, src = ctx.ceiling
    if src == "level_mark":
        return h, "level_mark", R_LEVEL_H
    return h, "default", R_DEFAULT_H.format(h=h)


def _floor_ceiling(spans: Sequence[Any], zone: BaseGeometry) -> tuple[float, str]:
    marks = [(x, y, h) for x, y, h in L.ceiling_marks(spans) if zone.contains(Point(x, y))]
    if marks:
        hs = sorted(h for _, _, h in marks)
        return hs[len(hs) // 2], "level_mark"
    return DEFAULT_CEILING_M, "default"


# ------------------------------------------------------------------------------------------------- the stage
def analyze(
    vs: VectorSheet,
    spans: Sequence[Any],
    *,
    sheet_id: str,
    discipline: str | None,
    regions: Sequence[Mapping[str, Any]],
    scale_den: int | None,
    rooms: Sequence[Any] = (),
    text_paths: set[int] | None = None,
    legend_colours: dict[str, str] | None = None,
    green_threshold: float | None = None,
    walls_by_region: Mapping[str, BaseGeometry] | None = None,
    read_marks: bool = True,
    marks_ocr: MK.OcrFn | None = None,
) -> dict[str, Any]:
    """Geometry of one plan sheet (all regions). Pure apart from the height-mark OCR (``read_marks``; Tesseract,
    ``marks_ocr`` in tests); never raises on odd input (empty lists instead)."""
    t_start = time.monotonic()
    doc: dict[str, Any] = {
        "schema": GEOMETRY_SCHEMA,
        "sheetId": sheet_id,
        "discipline": discipline,
        "scaleDenominator": int(scale_den) if scale_den else None,
        "heights": [],
        "levels": [],
        "stairs": [],
        "regions": [],
        "wallRuns": [],
        "lines": [],
        "ceilings": [],
        "courtyards": [],
        "measures": [],
        "stats": {},
    }
    regs = [dict(r) for r in regions] or [{"id": "r0", "floor": None}]
    all_rooms = _rooms_of(rooms)
    segs = stroked_segments(vs, min_len=0.25)
    hl_fills = fills(vs)
    notes_all = L.notes(vs, spans)
    tokens = S.number_tokens(spans)
    levels = L.level_values(spans)
    text_boxes = [
        (float(min(b[0], b[2])), float(min(b[1], b[3])), float(max(b[0], b[2])), float(max(b[1], b[3])))
        for t in spans
        if (b := getattr(t, "bbox", None)) is not None
        and 0 < abs(float(b[3]) - float(b[1])) <= 5.0
        # a line stroke read as a glyph ("\\", "/", "|", "-") is not text: only boxes with ≥ 2 letters / digits
        and len(_ALNUM.findall(str(getattr(t, "text", "")))) >= 2
    ]
    doc["levels"] = [{"valueM": round(v, 2), "atMm": {"x": round(x, 2), "y": round(y, 2)}} for x, y, v in levels][:64]
    for reg in regs:
        rpoly = region_polygon(reg, vs)
        sd = int(reg.get("scaleDenominator") or scale_den or DEFAULT_SCALE)
        mm_per_m = 1000.0 / sd
        rid = str(reg.get("id")) if reg.get("id") is not None else None
        floor = reg.get("floor")
        rooms_here = [r for r in all_rooms if rpoly.contains(r.poly.representative_point())]
        walls: BaseGeometry | None = (walls_by_region or {}).get(rid or "")
        if walls is None:
            try:
                ws = extract_walls(vs, rpoly.bounds, scale_den=sd, exclude_paths=text_paths or set(), openings=False)
                walls = ws.walls
            except Exception:  # noqa: BLE001 - walls are an aid (plan zone, courtyard faces); never fatal
                walls = None
        zone = plan_zone(walls, [r.poly for r in rooms_here], rpoly, mm_per_m)
        ceiling = _floor_ceiling(spans, zone.buffer(1.0 * mm_per_m))
        ctx = _Ctx(
            sheet_id,
            discipline,
            str(floor) if floor else None,
            rid,
            mm_per_m,
            zone,
            walls,
            rooms_here,
            [n for n in notes_all if zone.buffer(3.0 * mm_per_m).intersects(n.geom)],
            ceiling,
            legend_colours,
            green_threshold,
            {k: doc[k] for k in ("stairs", "regions", "wallRuns", "lines", "ceilings", "courtyards")},
            notes_all,
        )
        if ctx.floor:
            doc["heights"].append({"floor": ctx.floor, "ceilingM": round(ceiling[0], 2), "source": ceiling[1]})
        _region(ctx, vs, segs, hl_fills, tokens, levels, text_boxes, rpoly)
    n_marks = _opening_marks(doc, vs, green_threshold, marks_ocr) if read_marks else 0
    _ids(doc)
    doc["measures"] = measures(doc)
    doc["stats"] = {k: len(doc[k]) for k in ("stairs", "regions", "wallRuns", "lines", "ceilings", "courtyards")}
    doc["stats"]["heights"] = _height_stats(doc, notes_all, n_marks)
    doc["stats"]["seconds"] = round(time.monotonic() - t_start, 3)
    return doc


DRAWN_SOURCES = ("label", "section", "opening_mark", "other_sheet")


def _height_stats(doc: Mapping[str, Any], notes: Sequence[L.Note], n_marks: int) -> dict[str, int]:
    """``stats.heights``: heights read on the sheet (note "H=", ceiling marks, section walls, opening marks) and
    items whose quantity uses a drawn height (not the floor's ceiling / a default)."""
    sections = sum(1 for r in doc["wallRuns"] if r.get("heightSource") == "section")
    read = sum(1 for n in notes if n.height_m is not None) + len(doc.get("heights") or []) + sections + n_marks
    used = sum(1 for k in ("wallRuns", "lines") for i in doc[k] if i.get("heightSource") in DRAWN_SOURCES)
    used += sum(1 for c in doc["courtyards"] if c.get("heightSource") == "level_mark")
    return {"read": int(read), "used": int(used)}


def _opening_marks(doc: dict[str, Any], vs: VectorSheet, green_threshold: float | None, ocr: MK.OcrFn | None) -> int:
    """Rotated marks the glyph reader garbles, read by OCR beside the items that still lack a drawn height: an
    opening's "U.K= / O.K=" (window closure: head − sill; door closure in block: head), "H=" of a low wall / screen.
    Returns the number of items that got a mark."""
    targets: list[tuple[str, dict[str, Any]]] = []
    for ln in doc["lines"]:
        if ln.get("heightM") is None and ln["kind"] in ("window_closure", "cistern_screen"):
            targets.append(("line", ln))
    for wr in doc["wallRuns"]:
        if wr.get("heightSource") in ("label", "section"):
            continue
        if wr.get("closure") or (wr["kind"] == "low_wall" and wr.get("heightM") is None):
            targets.append(("run", wr))
    if not targets:
        return 0
    boxes = [(float(b["x"]), float(b["y"]), float(b["x"]) + float(b["w"]), float(b["y"]) + float(b["h"]))
             for _, it in targets for b in [it["bboxMm"]]]  # fmt: skip
    got = MK.read_marks(vs, boxes, ocr=ocr)
    n = 0
    for (kind, it), mk in zip(targets, got, strict=True):
        opening = kind == "line" and it["kind"] == "window_closure" or kind == "run" and bool(it.get("closure"))
        h = mk.opening_m if opening else mk.h_m
        if h is None:
            continue
        n += 1
        it["heightM"], it["heightSource"] = round(h, 2), "opening_mark" if opening else "label"
        it["heightMark"] = mk.text[:80]
        keep = [r for r in it["reasons"] if not r.startswith("גובה") and r != R_NOT_DRAWN_H]
        it["reasons"] = [*keep, R_OPENING_H.format(h=h) if opening else R_MARK_H]
        if kind == "run":
            it["areaM2"] = round(float(it["lengthM"]) * h, 3)
        sc, lv, rs = calibrate(KIND_KEYS["wall_run" if kind == "run" else "line"], float(it["scoreRaw"]), list(it["reasons"]),
                               level="yellow", green_threshold=green_threshold)  # fmt: skip
        it["confidence"], it["level"], it["reasons"] = sc, lv, rs
    return n


def _ids(doc: dict[str, Any]) -> None:
    for key, pre in (
        ("stairs", "st"),
        ("regions", "hr"),
        ("wallRuns", "wr"),
        ("lines", "ln"),
        ("ceilings", "cl"),
        ("courtyards", "cy"),
    ):
        items = doc[key][:MAX_ITEMS]
        ren: dict[str, str] = {}
        for k, it in enumerate(items, 1):
            ren[it["id"]] = f"{pre}_{k}"
            it["id"] = f"{pre}_{k}"
        doc[key] = items
        # fix references to renamed items
        for coll in ("wallRuns", "courtyards"):
            for it in doc.get(coll, []):
                if it.get("regionId") in ren:
                    it["regionId"] = ren[it["regionId"]]
                if it.get("stairId") in ren:
                    it["stairId"] = ren[it["stairId"]]
                if isinstance(it.get("wallRunIds"), list):
                    it["wallRunIds"] = [ren.get(x, x) for x in it["wallRunIds"]]


_tmp_counter = [0]


def _tmp_id(prefix: str) -> str:
    _tmp_counter[0] += 1
    return f"_{prefix}{_tmp_counter[0]}"


def _region(
    ctx: _Ctx,
    vs: VectorSheet,
    segs: H.Segs | Any,
    hl_fills: Sequence[Any],
    tokens: Sequence[tuple[float, float, int]],
    levels: Sequence[tuple[float, float, float]],
    text_boxes: Sequence[tuple[float, float, float, float]],
    rpoly: Polygon,
) -> None:
    m = ctx.mm_per_m
    rb = rpoly.bounds
    cx, cy = (segs.xy[:, 0] + segs.xy[:, 2]) / 2, (segs.xy[:, 1] + segs.xy[:, 3]) / 2
    in_reg = (cx >= rb[0]) & (cx <= rb[2]) & (cy >= rb[1]) & (cy <= rb[3])
    filled_path = vs.path_fill_mode[segs.path] > 0 if len(segs.path) else np.zeros(0, bool)

    # ------------------------------------------------------------- hatches (line families) + solid fills
    hatch_regs: list[H.HatchRegion] = []
    used = np.zeros(len(segs.path), bool)
    for cc in HIGHLIGHTS:
        sel = in_reg & (segs.cclass == cc) & ~filled_path
        if int(sel.sum()) < H.HATCH_MIN_LINES:
            continue
        fams = H.hatch_families(segs, sel)
        for hr in H.hatch_regions(fams, min_area=0.05 * m * m):
            if not in_zone(hr.poly, ctx.zone.buffer(0.3 * m), 0.5):
                ctx.outside.append(hr.poly)
                continue
            hatch_regs.append(hr)
            if hr.seg_idx is not None:
                used[hr.seg_idx] = True
    hatch_regs = _merge_pieces(hatch_regs)
    solid: list[H.HatchRegion] = []
    by_cc: dict[tuple[str, tuple[int, int, int]], list[BaseGeometry]] = {}
    for f in hl_fills:
        c = f.poly.centroid
        if not rpoly.contains(c):
            continue
        by_cc.setdefault((f.cclass, f.rgb), []).append(f.poly)
    for (cc, rgb), gs in by_cc.items():
        for p in union_parts(gs):
            if p.area < MIN_REGION_M2 * m * m:
                continue
            if not in_zone(p, ctx.zone.buffer(0.3 * m), 0.5):
                ctx.outside.append(p)
                continue
            solid.append(H.HatchRegion(p, "solid", cc, rgb))
    # strokes outlining a hatch / fill are part of it
    outline_geoms = [h.poly.boundary for h in hatch_regs + solid]
    if outline_geoms:
        ob = unary_union(outline_geoms).buffer(0.35)
        mids = np.where(in_reg & ~used)[0]
        for k in mids:
            if segs.length[k] > H.DASH_LEN_MM[1] and ob.contains(Point(cx[k], cy[k])) and segs.cclass[k] in HIGHLIGHTS:
                x0, y0, x1, y1 = segs.xy[k]
                if ob.contains(Point(x0, y0)) and ob.contains(Point(x1, y1)):
                    used[k] = True

    # ------------------------------------------------------------- runs of strokes: stairs, dashed boxes, lines
    hl_sel = in_reg & ~used & ~filled_path & np.isin(segs.cclass, list(HIGHLIGHTS))
    hl_chains = H.chains(segs, hl_sel, text_boxes=text_boxes)
    nt_sel = in_reg & ~filled_path & (segs.cclass == NEUTRAL) & (segs.length >= 0.5 * S.WIDTH_M[0] * m)
    nt_chains = [c for c in H.chains(segs, nt_sel, text_boxes=text_boxes) if not c.dashed]
    fls = S.flights([c for c in hl_chains + nt_chains if in_zone(c.line, ctx.zone.buffer(0.3 * m))], m)
    sts = S.stairs(fls, m)
    S.attach_numbers(sts, tokens, m)
    stair_chain_ids = {id(ch) for st in sts for f in st.flights for ch in f.chains}
    stair_ids = [_stair(ctx, st) for st in sts]
    rest = [c for c in hl_chains if id(c) not in stair_chain_ids]
    boxes, dashed_rest = H.dashed_boxes(rest)
    plain = [c for c in rest if not c.dashed and c.length >= 0.3 * m]

    # ------------------------------------------------------------- regions (hatch + solid) with categories
    region_items: list[tuple[H.HatchRegion, dict[str, Any]]] = []
    for hr in hatch_regs + solid:
        region_items.append((hr, _region_item(ctx, hr)))

    # ------------------------------------------------------------- wall runs
    runs: list[tuple[BaseGeometry, dict[str, Any]]] = []
    for hr, item in region_items:
        if item["lifecycle"] != "new" or hr.pattern == "cross":
            continue
        run = _wall_run(ctx, hr.poly, hr.pattern, item, area_mm2=hr.area_mm2)
        if run is not None:
            runs.append((hr.poly, run))
    for poly, rgb in _outlined_walls(vs, rpoly, m, [h.poly for h in hatch_regs + solid]):
        cc = colour_class(rgb)
        lc = lifecycle_of(cc, ctx.discipline, ctx.colours, hex_colour(rgb))
        if lc != "new" or not in_zone(poly, ctx.zone.buffer(0.3 * m), 0.5):
            continue
        run = _wall_run(ctx, poly, "outline", {"id": None, "lifecycle": lc, "color": hex_colour(rgb)})
        if run is not None:
            runs.append((poly, run))

    # ------------------------------------------------------------- ceilings (dashed X boxes)
    for bx in boxes:
        lc = lifecycle_of(bx.cclass, ctx.discipline, ctx.colours, hex_colour(bx.rgb))
        if lc != "new" or not in_zone(bx.poly, ctx.zone.buffer(0.3 * m), 0.5):
            continue
        _ceiling(ctx, bx)

    # ------------------------------------------------------------- labelled lines (valances, screens, closures)
    cand = [c for c in dashed_rest + plain if in_zone(c.line, ctx.zone.buffer(0.3 * m))]
    cand = [c for c in cand if lifecycle_of(c.cclass, ctx.discipline, ctx.colours, hex_colour(c.rgb)) == "new"]
    run_union = unary_union([g for g, _ in runs]) if runs else None
    if run_union is not None:
        cand = [c for c in cand if c.line.difference(run_union.buffer(0.4)).length > 0.5 * c.length]
    for grp in H.merge_parallel(cand, 0.25 * m):
        _line(ctx, grp)

    # ------------------------------------------------------------- courtyard (new retaining walls + new stair)
    _courtyards(ctx, runs, stair_ids, levels)

    # ------------------------------------------------------------- heights drawn in a section beside the plan
    _section_heights(ctx, [r for _, r in runs], levels)


_SECTION_FLAGS = {"ac", "gypsum", "double", "block", "concrete", "cladding", "partition", "closure", "courtyard"}
_REFERS_TO_SECTION = re.compile(r"חתכ|חתך")


def _section_heights(ctx: _Ctx, runs: Sequence[dict[str, Any]], levels: Sequence[tuple[float, float, float]]) -> None:
    """Wall runs whose height a section draws: new retaining walls (the section's concrete strip) and runs whose note
    says "ראה חתך" (the strip named by a note of the same kind: "סגירת גבס למיזוג … ראה חתך" ↔ the red lining strip
    with "פתח שירות … מ.א"). The section's height replaces the assumed one (heightSource ``section``)."""
    if not ctx.outside or not runs:
        return
    walls = SEC.section_walls(ctx.outside, levels, ctx.notes_all, exclude=ctx.zone.buffer(0.3 * ctx.mm_per_m))
    if not walls:
        return
    for run in runs:
        if run.get("heightSource") == "label":
            continue
        label = str(run.get("label") or "")
        if run["kind"] == "concrete_retaining":
            want = {"concrete", "courtyard"}
            cands = [w for w in walls if w.flags & want] or [w for w in walls if not w.flags]
        elif _REFERS_TO_SECTION.search(label):
            fl = L.flags_of(label) & _SECTION_FLAGS
            cands = [w for w in walls if w.flags & fl]
        else:
            continue
        if not cands:
            continue
        w = max(cands, key=lambda c: (len(c.flags & (L.flags_of(label) | {"concrete", "courtyard"})), c.height_m))
        h = round(w.height_m, 2)
        run["heightM"], run["heightSource"] = h, "section"
        run["areaM2"] = round(float(run["lengthM"]) * h, 3)
        run["sectionBboxMm"] = w.bbox_json()
        keep = [r for r in run["reasons"] if not r.startswith("גובה")]
        run["reasons"] = [*keep, R_SECTION_H.format(h=h)] + ([R_SECTION_FOOTING] if run["kind"] == "concrete_retaining" else [])
        _finish(ctx, "wall_run", run)


def _merge_pieces(regs: Sequence[H.HatchRegion], gap: float = 3.5) -> list[H.HatchRegion]:
    """Pieces of one hatch (same colour and pattern) cut apart by a dimension / text crossing it."""
    out: list[H.HatchRegion] = []
    groups: dict[tuple[str, str], list[H.HatchRegion]] = {}
    for r in regs:
        groups.setdefault((r.cclass, r.pattern), []).append(r)
    for rs in groups.values():
        u = unary_union([r.poly.buffer(gap / 2, join_style="mitre") for r in rs]).buffer(-gap / 2, join_style="mitre")
        for p in polygons_of(u):
            members = [r for r in rs if r.poly.intersects(p.buffer(0.1))]
            if not members:
                continue
            first = members[0]
            idx = [r.seg_idx for r in members if r.seg_idx is not None]
            drawn = [r.area_mm2 for r in members if r.area_mm2 is not None]
            out.append(H.HatchRegion(p, first.pattern, first.cclass, first.rgb, sorted({a for r in members for a in r.angles}),
                                     first.spacing, np.concatenate(idx) if idx else None,
                                     sum(drawn) if drawn and len(drawn) == len(members) else None))  # fmt: skip
    return out


# ------------------------------------------------------------------------------------------------ items
def _region_item(ctx: _Ctx, hr: H.HatchRegion) -> dict[str, Any]:
    m = ctx.mm_per_m
    hexc = hex_colour(hr.rgb)
    lc = lifecycle_of(hr.cclass, ctx.discipline, ctx.colours, hexc)
    note, src, _ = L.best_note(hr.poly, ctx.notes)
    fl = note.flags if note else set()
    cat = _category(fl, hr.pattern, lc)
    reasons: list[str] = []
    score = 0.8 if note else 0.6
    if note is None:
        reasons.append(R_NO_LABEL)
    room = _room_at(ctx, hr.poly)
    sc, lv, rs = _level("region", score, reasons, ctx)
    item = {
        "id": _tmp_id("hr"),
        "category": cat,
        "pattern": hr.pattern,
        "color": hexc,
        "lifecycle": lc,
        "areaM2": round((hr.area_mm2 if hr.area_mm2 is not None else hr.poly.area) / (m * m), 3),
        "perimeterM": round(hr.poly.length / m, 2),
        "polygonMm": poly_json(hr.poly),
        "bboxMm": bbox_json(hr.poly),
        "floor": ctx.floor,
        "roomId": room.id if room else None,
        "roomName": room.name if room else None,
        "roomType": room.type if room else None,
        "label": note.text[:200] if note else None,
        "labelBboxMm": note.bbox_json() if note else None,
        "labelSource": src,
        "confidence": sc,
        "scoreRaw": round(score, 3),
        "level": lv,
        "reasons": rs,
    }
    ctx.out["regions"].append(item)
    return item


def _category(fl: set[str], pattern: str, lc: str) -> str:
    if lc == "demolish" or "demolished" in fl:
        return "demolished"
    if "waterproofing" in fl:
        return "waterproofing"
    if "cladding" in fl:
        return "cladding"
    if "valance" in fl:
        return "valance"
    if "ceiling" in fl:
        return "ceiling"
    if "concrete" in fl:
        return "concrete"
    if "block" in fl:
        return "block"
    if "gypsum" in fl or "partition" in fl:
        return "gypsum"
    if "closure" in fl:
        return "closure"
    if pattern == "lines" and lc == "new":
        return "concrete"  # a single-direction hatch on a new wall = cast concrete (section convention)
    return "unknown"


def _wall_run(
    ctx: _Ctx, poly: BaseGeometry, pattern: str, region: Mapping[str, Any], *, area_mm2: float | None = None
) -> dict[str, Any] | None:
    m = ctx.mm_per_m
    t, ln = _thickness_length(poly)
    if area_mm2 is not None and t > 0:
        ln = area_mm2 / t  # the hatch's drawn area: the outline is a little larger than the wall
    t_m, l_m = t / m, ln / m
    if not (WALL_T_M[0] <= t_m <= WALL_T_M[1]) or l_m < MIN_RUN_M:
        return None
    want = {"gypsum", "double", "block", "concrete", "low", "partition", "closure", "courtyard"}
    note, _src, _ = L.best_note(poly, ctx.notes, want)
    fl = note.flags if note else set()
    reasons: list[str] = []
    if "low" in fl:
        kind = "low_wall"
    elif "double" in fl:
        kind = "gypsum_double"
    elif "block" in fl:
        kind = "block_new"
    elif "concrete" in fl or ("courtyard" in fl and pattern == "lines"):
        kind = "concrete_retaining"
    elif "gypsum" in fl or "partition" in fl:
        kind = "gypsum_single"
    elif pattern == "lines":
        kind = "concrete_retaining"
        reasons.append(R_KIND_THICK)
    else:
        kind = "gypsum_single" if t_m < BLOCK_MIN_T_M else "block_new"
        reasons.append(R_KIND_THICK)
    if note is not None and R_KIND_THICK not in reasons:
        reasons.append(R_KIND_LABEL)
    h: float | None
    if kind == "low_wall" and (note is None or note.height_m is None):
        h, hsrc = None, None
        reasons.append(R_LOW_NO_H)
    elif kind == "concrete_retaining":
        h, hsrc = None, None  # set by the courtyard (levels) when one is found, else the floor height below
    else:
        h, hsrc, why = _height(ctx, poly, note)
        if hsrc == "default":
            reasons.append(why)
        elif hsrc != "label":
            reasons.append(R_H_ASSUMED.format(h=h))
    score = 0.8 if note is not None else 0.65
    item: dict[str, Any] = {
        "id": _tmp_id("wr"),
        "kind": kind,
        "closure": "closure" in fl and "opening" in fl,
        # a low wall's own material (its measure: gypsum partition or block wall by this, else by thickness)
        "material": ("block" if fl & {"block", "concrete"} else "gypsum" if fl & {"gypsum", "partition"} else None)
        if kind == "low_wall"
        else None,
        "lifecycle": region.get("lifecycle") or "new",
        "lengthM": round(l_m, 3),
        "thicknessM": round(t_m, 3),
        "heightM": round(h, 2) if h is not None else None,
        "heightSource": hsrc,
        "areaM2": round(l_m * h, 3) if h is not None else None,
        "polygonMm": poly_json(poly),
        "bboxMm": bbox_json(poly),
        "floor": ctx.floor,
        "roomIds": _rooms_touching(ctx, poly),
        "label": note.text[:200] if note else None,
        "regionId": region.get("id"),
        "confidence": 0.0,
        "scoreRaw": round(score, 3),
        "level": "yellow",
        "reasons": reasons,
    }
    if kind == "concrete_retaining":
        h2, hsrc2, why2 = _height(ctx, poly, note)
        item.update({"heightM": round(h2, 2), "heightSource": hsrc2, "areaM2": round(l_m * h2, 3)})
        if hsrc2 == "default":
            reasons.append(why2)
    _finish(ctx, "wall_run", item)
    ctx.out["wallRuns"].append(item)
    return item


def _finish(ctx: _Ctx, kind: str, item: dict[str, Any]) -> None:
    sc, lv, rs = _level(kind, float(item["scoreRaw"]), list(item["reasons"]), ctx)
    item["confidence"], item["level"], item["reasons"] = sc, lv, rs


def _outlined_walls(
    vs: VectorSheet, rpoly: Polygon, m: float, known: Sequence[BaseGeometry]
) -> list[tuple[Polygon, tuple[int, int, int]]]:
    """Closed, unfilled highlight outlines shaped like a wall piece (a new low wall drawn as a rectangle)."""
    out: list[tuple[Polygon, tuple[int, int, int]]] = []
    if vs.n_paths == 0:
        return out
    cand = vs.path_stroked & (vs.path_fill_mode == 0)
    rb = rpoly.bounds
    bb = vs.path_bbox
    cand &= (bb[:, 0] >= rb[0]) & (bb[:, 2] <= rb[2]) & (bb[:, 1] >= rb[1]) & (bb[:, 3] <= rb[3])
    for i in np.where(cand)[0].tolist():
        rgb = tuple(int(c) for c in vs.path_stroke_rgba[i, :3])
        if colour_class(rgb) not in HIGHLIGHTS:
            continue
        s0, n = int(vs.path_seg_start[i]), int(vs.path_seg_count[i])
        if n < 3 or n > 16:
            continue
        pts = [(float(x), float(y)) for x, y, _, _ in vs.segs[s0 : s0 + n]] + [
            (float(vs.segs[s0 + n - 1, 2]), float(vs.segs[s0 + n - 1, 3]))
        ]
        gap = math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1])
        if gap > 0.2:
            # a wall stub drawn as three sides, its open end butting into an existing wall ("קיר נמוך" 100 × 10):
            # closed when the open side is the short side of a rectangle
            if n != 3 or not _u_closes(pts, m):
                continue
            pts = [*pts, pts[0]]
        p = Polygon(pts).buffer(0)
        if not isinstance(p, Polygon) or p.area <= 0:
            continue
        rect = p.minimum_rotated_rectangle
        if rect.area <= 0 or p.area / rect.area < 0.9:
            continue
        if any(p.intersection(k).area > 0.3 * p.area for k in known):
            continue
        t, ln = _thickness_length(p)
        if WALL_T_M[0] * m <= t <= 0.35 * m and ln >= 0.4 * m:
            out.append((p, (rgb[0], rgb[1], rgb[2])))
    return out


def _u_closes(pts: Sequence[tuple[float, float]], m: float) -> bool:
    """Three sides a-b-c-d of a rectangle whose missing side d-a is as long as b-c (the wall's thickness) and short."""
    (ax, ay), (bx, by), (cx, cy), (dx, dy) = pts[:4]
    ab, bc, cd = math.hypot(bx - ax, by - ay), math.hypot(cx - bx, cy - by), math.hypot(dx - cx, dy - cy)
    da = math.hypot(ax - dx, ay - dy)
    if min(ab, bc, cd) <= 0 or abs(ab - cd) > 0.05 * max(ab, cd) or abs(da - bc) > 0.05 * max(da, bc):
        return False
    perp = abs((bx - ax) * (cx - bx) + (by - ay) * (cy - by)) / (ab * bc)
    return perp < 0.05 and bc <= 0.35 * m


def _stair(ctx: _Ctx, st: S.Stair) -> tuple[dict[str, Any], BaseGeometry]:
    m = ctx.mm_per_m
    lc = lifecycle_of(st.cclass, ctx.discipline, ctx.colours, hex_colour(st.rgb))
    reasons: list[str] = []
    if st.numbered:
        reasons.append(R_STAIR_NUM)
        score = 0.85
        if abs(st.treads - st.gaps) > 1 and len(st.flights) == 1:
            reasons.append(R_STAIR_MISMATCH)
            score = 0.6
    else:
        reasons.append(R_STAIR_LINES)
        score = 0.7
    floor = ctx.floor
    if st.descending and floor == "ground":
        floor = "basement"  # numbered below the ±0.00 datum: the stair leads down to the floor below the ground
    going = float(np.median([f.going_mm for f in st.flights])) / m
    width = float(np.median([f.width_mm for f in st.flights])) / m
    run = sum((len(f.chains) - 1) * f.going_mm for f in st.flights) / m
    room = _room_at(ctx, st.poly)
    item = {
        "id": _tmp_id("st"),
        "floor": floor,
        "regionId": ctx.region_id,
        "lifecycle": lc,
        "treads": int(st.treads),
        "risers": int(st.treads) if st.numbered else None,
        "lines": int(st.lines),
        "numbered": st.numbered,
        "numbers": sorted(set(st.numbers), key=abs) if st.numbers else None,
        "descending": st.descending,
        "widthM": round(width, 2),
        "goingM": round(going, 3),
        "runLengthM": round(run, 2),
        "polygonMm": poly_json(st.poly),
        "bboxMm": bbox_json(st.poly),
        "roomId": room.id if room else None,
        "key": f"{floor}|{lc}|{int(st.treads)}|{round(width, 1)}|{round(going, 2)}",
        "confidence": 0.0,
        "scoreRaw": round(score, 3),
        "level": "yellow",
        "reasons": reasons,
    }
    _finish(ctx, "stair", item)
    ctx.out["stairs"].append(item)
    return item, st.poly


def _ceiling(ctx: _Ctx, bx: H.DashedBox) -> None:
    m = ctx.mm_per_m
    note, _src, _ = L.best_note(bx.poly, ctx.notes, {"ceiling", "ac", "gypsum", "closure"})
    reasons = [] if note else [R_NO_LABEL]
    room = _room_at(ctx, bx.poly)
    item = {
        "id": _tmp_id("cl"),
        "kind": "gypsum_ceiling",
        "areaM2": round(bx.poly.area / (m * m), 3),
        "polygonMm": poly_json(bx.poly),
        "bboxMm": bbox_json(bx.poly),
        "floor": ctx.floor,
        "roomId": room.id if room else None,
        "label": note.text[:200] if note else None,
        "confidence": 0.0,
        "scoreRaw": 0.75 if note else 0.6,
        "level": "yellow",
        "reasons": reasons,
    }
    _finish(ctx, "ceiling", item)
    ctx.out["ceilings"].append(item)


LINE_MAX_M = {"window_closure": 3.0, "cistern_screen": 2.5}


def _line_kind(fl: set[str]) -> str:
    if "valance" in fl and "curtain" in fl:
        return "valance_curtain"
    if "valance" in fl and "ventilator" in fl:
        return "valance_ventilator"
    if "valance" in fl:
        return "valance"
    if "cistern" in fl:
        return "cistern_screen"
    if "window" in fl and "closure" in fl:
        return "window_closure"
    return ""


def _line(ctx: _Ctx, grp: Sequence[H.Chain]) -> None:
    m = ctx.mm_per_m
    geom = unary_union([c.line for c in grp])
    longest = max(grp, key=lambda c: c.length)
    length_m = longest.length / m
    note: L.Note | None = None
    kind = ""
    for cand, _src, _d in L.ranked_notes(geom, ctx.notes, {"valance", "cistern", "window", "closure", "low"}):
        k = _line_kind(cand.flags)
        if k and LINE_MAX_M.get(k, 1e9) >= length_m >= 0.3:
            note, kind = cand, k
            break
    if note is None:
        return
    reasons: list[str] = []
    h = note.height_m
    if kind in ("cistern_screen", "window_closure") and h is None:
        reasons.append(R_NOT_DRAWN_H)
    room = _room_at(ctx, longest.line.buffer(0.05 * m))
    item = {
        "id": _tmp_id("ln"),
        "kind": kind,
        "lengthM": round(longest.length / m, 3),
        "heightM": round(h, 2) if h is not None else None,
        "heightSource": "label" if h is not None else None,
        "polylineMm": line_json([longest.a, longest.b]),
        "bboxMm": bbox_json(geom),
        "floor": ctx.floor,
        "roomId": room.id if room else None,
        "roomType": room.type if room else None,
        "label": note.text[:200],
        "confidence": 0.0,
        "scoreRaw": 0.8 if any(c.dashed for c in grp) or len(grp) > 1 else 0.7,
        "level": "yellow",
        "reasons": reasons,
    }
    _finish(ctx, "line", item)
    ctx.out["lines"].append(item)


def _courtyards(
    ctx: _Ctx,
    runs: Sequence[tuple[BaseGeometry, dict[str, Any]]],
    stair_ids: Sequence[tuple[dict[str, Any], BaseGeometry]],
    levels: Sequence[tuple[float, float, float]],
) -> None:
    m = ctx.mm_per_m
    ret = [(g, r) for g, r in runs if r["kind"] == "concrete_retaining"]
    if not ret:
        return
    used: set[int] = set()
    for i, (g, r) in enumerate(ret):
        if i in used:
            continue
        group = [(g, r)]
        used.add(i)
        for j in range(i + 1, len(ret)):
            if j not in used and ret[j][0].distance(g) <= 0.5 * m:
                group.append(ret[j])
                used.add(j)
        rg = unary_union([x for x, _ in group])
        st = [(s, p) for s, p in stair_ids if s["lifecycle"] == "new" and p.distance(rg) <= 0.5 * m]
        x0, y0, x1, y1 = unary_union([rg] + [p for _, p in st]).bounds
        area = box(x0, y0, x1, y1).difference(rg.buffer(0.01))
        if ctx.walls is not None and not ctx.walls.is_empty:
            area = area.difference(ctx.walls)
        pieces = [p for p in polygons_of(area) if p.area >= 1.0 * m * m and p.distance(rg) <= 0.05 * m]
        pieces = [p for p in pieces if not any(r.poly.intersection(p).area > 0.6 * p.area for r in ctx.rooms)]
        if not pieces:
            continue
        cy_g = max(pieces, key=lambda p: p.area).simplify(0.3)
        if not isinstance(cy_g, Polygon):
            continue
        cy = cy_g
        faces = _faces(cy, rg, ctx.walls, m)
        wall_len = sum(f["lengthM"] for f in faces if f["kind"] != "open")
        lv = _yard_levels(levels, ctx.floor)
        reasons: list[str] = []
        if lv is not None:
            h, hsrc = lv[0] - lv[1], "level_mark"
            reasons.append(R_COURT_LEVELS)
        else:
            h, hsrc, why = _height(ctx, cy, None)
            if hsrc == "default":
                reasons.append(why)
        note, _src, _ = L.best_note(rg, ctx.notes, {"courtyard", "concrete", "waterproofing"})
        # retaining runs take the courtyard height
        for _gx, run in group:
            run["heightM"], run["heightSource"] = round(h, 2), hsrc
            run["areaM2"] = round(run["lengthM"] * h, 3)
            run["reasons"] = [x for x in run["reasons"] if not x.startswith("גובה לפי ברירת")] + ([R_COURT_LEVELS] if lv else [])
            _finish(ctx, "wall_run", run)
        item = {
            "id": _tmp_id("cy"),
            "floor": ctx.floor,
            "floorAreaM2": round(cy.area / (m * m), 3),
            "polygonMm": poly_json(cy),
            "bboxMm": bbox_json(cy),
            "stairId": st[0][0]["id"] if st else None,
            "wallRunIds": [run["id"] for _, run in group],
            "faces": faces,
            "wallLengthM": round(wall_len, 3),
            "wallHeightM": round(h, 2),
            "heightSource": hsrc,
            "wallAreaM2": round(wall_len * h, 3),
            "levels": {"topM": round(lv[0], 2), "bottomM": round(lv[1], 2)} if lv else None,
            "label": note.text[:200] if note else None,
            "waterproofing": bool(note and ("waterproofing" in note.flags))
            or any("waterproofing" in n.flags for n in ctx.notes if n.geom.distance(rg) <= 40.0),
            "confidence": 0.0,
            "scoreRaw": 0.75 if lv else 0.65,
            "level": "yellow",
            "reasons": reasons,
        }
        _finish(ctx, "courtyard", item)
        ctx.out["courtyards"].append(item)


def _faces(cy: Polygon, ret: BaseGeometry, walls: BaseGeometry | None, m: float) -> list[dict[str, Any]]:
    tol = 0.08 * m
    out: list[dict[str, Any]] = []
    pts = [(float(c[0]), float(c[1])) for c in cy.exterior.coords]
    for a, b in itertools.pairwise(pts):
        seg = LineString([a, b])
        if seg.length < 0.05 * m:
            continue
        mid = seg.interpolate(0.5, normalized=True)
        if mid.distance(ret) <= tol:
            kind = "retaining"
        elif walls is not None and not walls.is_empty and mid.distance(walls) <= tol:
            kind = "building"
        else:
            kind = "open"
        if out and out[-1]["kind"] == kind and _collinear(out[-1], a, b):
            out[-1]["bMm"] = {"x": round(b[0], 2), "y": round(b[1], 2)}
            out[-1]["lengthM"] = round(out[-1]["lengthM"] + seg.length / m, 3)
            continue
        out.append(
            {
                "kind": kind,
                "lengthM": round(seg.length / m, 3),
                "aMm": {"x": round(a[0], 2), "y": round(a[1], 2)},
                "bMm": {"x": round(b[0], 2), "y": round(b[1], 2)},
            }
        )
    # an open stretch on the line of a building face is an opening (door / window) in that wall
    lines = [LineString([(f["aMm"]["x"], f["aMm"]["y"]), (f["bMm"]["x"], f["bMm"]["y"])]) for f in out]
    for f, ln in zip(out, lines, strict=True):
        if f["kind"] != "open":
            continue
        for g, lg in zip(out, lines, strict=True):
            if g["kind"] != "building" or lg.length <= 0:
                continue
            if _collinear(g, (f["aMm"]["x"], f["aMm"]["y"]), (f["bMm"]["x"], f["bMm"]["y"])) and _on_line(lg, ln, tol):
                f["kind"], f["opening"] = "building", True
                break
    return out[:64]


def _on_line(base: LineString, other: LineString, tol: float) -> bool:
    """``other`` lies on the infinite line through ``base`` (both ends within ``tol``)."""
    (x0, y0), (x1, y1) = base.coords[0], base.coords[-1]
    dx, dy = x1 - x0, y1 - y0
    n = math.hypot(dx, dy)
    return all(abs((px - x0) * dy - (py - y0) * dx) / n <= tol for px, py in (other.coords[0], other.coords[-1]))


def _collinear(prev: Mapping[str, Any], a: tuple[float, float], b: tuple[float, float]) -> bool:
    pa, pb = prev["aMm"], prev["bMm"]
    t1 = math.atan2(pb["y"] - pa["y"], pb["x"] - pa["x"])
    t2 = math.atan2(b[1] - a[1], b[0] - a[0])
    return abs((math.degrees(t1 - t2) + 180) % 360 - 180) < 5


def _yard_levels(levels: Sequence[tuple[float, float, float]], floor: str | None) -> tuple[float, float] | None:
    """(top, bottom) of a sunken courtyard from the sheet's level marks: the yard floor is the lowest level, the top
    of its walls the highest level below ±0.00 (grade at the yard). On a basement sheet levels read without a sign are
    below the datum (the SHX reader often drops "-")."""
    vals = [v for _, _, v in levels]
    if not vals:
        return None
    below = floor == "basement" or any(v < 0 for v in vals)
    if not below:
        return None
    neg = sorted({-abs(v) for v in vals if abs(v) > 0.001})
    if len(neg) < 2:
        return None
    bottom, top = neg[0], neg[-1]
    if not (1.0 <= top - bottom <= 6.0):
        return None
    return top, bottom


# ------------------------------------------------------------------------------------------------ measures
def _sum(items: Sequence[Mapping[str, Any]], key: str) -> float | None:
    vals = [float(i[key]) for i in items if i.get(key) is not None]
    return round(sum(vals), 3) if vals else None


def _lv(items: Sequence[Mapping[str, Any]]) -> str:
    rank = {"red": 0, "yellow": 1, "green": 2}
    lvls = [str(i.get("level") or "yellow") for i in items]
    return min(lvls, key=lambda x: rank.get(x, 0)) if lvls else "yellow"


def _m(key: str, unit: str, items: Sequence[Mapping[str, Any]], qty: float | None, *, floor: str | None = None,
       computable: bool = True, reason: str | None = None, estimate: dict[str, Any] | None = None,
       reasons: Sequence[str] = ()) -> dict[str, Any]:  # fmt: skip
    rs = list(dict.fromkeys([*([reason] if reason else []), *reasons, *(r for i in items for r in (i.get("reasons") or []))]))[
        :12
    ]
    level = _lv(items) if computable and qty is not None else ("red" if estimate is None else "yellow")
    if level != "green" and not rs:
        rs = [R_GEOM]
    return {
        "key": key,
        "unit": unit,
        "qty": round(qty, 3) if qty is not None else None,
        "computable": bool(computable and qty is not None),
        "reason": reason,
        "estimate": estimate,
        "floor": floor,
        "refs": [str(i["id"]) for i in items][:64],
        "level": level,
        "reasons": rs if level != "green" else [],
    }


M2, M1, UNIT, LUMP = 'מ"ר', 'מ"א', "יחידה", "קומפלט"
# measure key -> unit (every key geometry_units returns)
KEYS: dict[str, str] = {
    "stair_treads": UNIT,
    "retaining_wall_area": M2,
    "courtyard_wall_area": M2,
    "courtyard_floor_area": M2,
    "courtyard_waterproofing": LUMP,
    "block_wall_area": M2,
    "gypsum_partition_area": M2,
    "gypsum_double_partition_area": M2,
    "gypsum_ceiling_area": M2,
    "valance_ventilator_length": M1,
    "valance_curtain_length": M1,
    "valance_length": M1,
    "window_closure_area": M2,
    "plaster_new_walls_area": M2,
    "kitchen_backsplash_area": M2,
    "wc_partial_cladding_area": M2,
    "demolished_wall_length": M1,
}
FLOOR_RANK = {f: i for i, f in enumerate(("basement", "ground", "first", "second", "third", "fourth", "roof"))}
R_NOT_ON_DWG = "לא מסומן בתכניות — להשלמה ידנית"
R_NO_HEIGHT = "גובה לא מופיע בשרטוט — להשלמה ידנית"
R_FACES = "אילו פני קיר מטויחים אינו מצוין — הערכה"


def measures(doc: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Per-sheet measures (see the module docs for the keys). Items of several floors on one sheet are split."""
    out: list[dict[str, Any]] = []
    floors = sorted(
        {
            str(i.get("floor"))
            for k in ("stairs", "wallRuns", "lines", "ceilings", "courtyards", "regions")
            for i in doc.get(k, [])
            if i.get("floor")
        }
        | {str(h["floor"]) for h in doc.get("heights", []) if h.get("floor")}
    )
    if not floors:
        floors = ["None"]
    for fl in floors:
        f = None if fl == "None" else fl

        def on(coll: str, f: str | None = f) -> list[dict[str, Any]]:
            return [i for i in doc.get(coll, []) if (i.get("floor") or None) == f]

        new_stairs = [s for s in on("stairs") if s.get("lifecycle") == "new"]
        if new_stairs:
            out.append(_m("stair_treads", UNIT, new_stairs, float(sum(int(s["treads"]) for s in new_stairs)), floor=f))
        runs = on("wallRuns")
        by_kind = {
            k: [r for r in runs if r.get("kind") == k]
            for k in ("block_new", "gypsum_single", "gypsum_double", "concrete_retaining", "low_wall")
        }
        if by_kind["concrete_retaining"]:
            out.append(
                _m(
                    "retaining_wall_area",
                    M2,
                    by_kind["concrete_retaining"],
                    _sum(by_kind["concrete_retaining"], "areaM2"),
                    floor=f,
                )
            )
        # a low wall with its height read ("קיר נמוך H=140") is a partition / block wall of that height
        for lw in by_kind["low_wall"]:
            if lw.get("areaM2") is not None:
                mat = lw.get("material")
                thin = mat == "gypsum" or (mat is None and float(lw.get("thicknessM") or 0.0) < BLOCK_MIN_T_M)
                by_kind["gypsum_single" if thin else "block_new"].append(lw)
        if by_kind["block_new"]:
            out.append(_m("block_wall_area", M2, by_kind["block_new"], _sum(by_kind["block_new"], "areaM2"), floor=f))
        if by_kind["gypsum_single"]:
            out.append(
                _m("gypsum_partition_area", M2, by_kind["gypsum_single"], _sum(by_kind["gypsum_single"], "areaM2"), floor=f)
            )
        if by_kind["gypsum_double"]:
            out.append(
                _m(
                    "gypsum_double_partition_area",
                    M2,
                    by_kind["gypsum_double"],
                    _sum(by_kind["gypsum_double"], "areaM2"),
                    floor=f,
                )
            )
        cys = on("courtyards")
        if cys:
            out.append(_m("courtyard_wall_area", M2, cys, _sum(cys, "wallAreaM2"), floor=f))
            out.append(_m("courtyard_floor_area", M2, cys, _sum(cys, "floorAreaM2"), floor=f))
            wp = [c for c in cys if c.get("waterproofing")]
            out.append(
                _m("courtyard_waterproofing", LUMP, cys, 1.0, floor=f, reasons=([] if wp else ["לא נמצא כיתוב איטום ליד החצר"]))
            )
        ceils = on("ceilings")
        if ceils:
            out.append(_m("gypsum_ceiling_area", M2, ceils, _sum(ceils, "areaM2"), floor=f))
        lines = on("lines")
        for kind, key in (
            ("valance_ventilator", "valance_ventilator_length"),
            ("valance_curtain", "valance_curtain_length"),
            ("valance", "valance_length"),
        ):
            ls = [x for x in lines if x.get("kind") == kind]
            if ls:
                out.append(_m(key, M1, ls, _sum(ls, "lengthM"), floor=f))
        wc = [x for x in lines if x.get("kind") == "window_closure"]
        if wc:
            known = [x for x in wc if x.get("heightM")]
            if len(known) == len(wc):
                out.append(_m("window_closure_area", M2, wc, sum(float(x["lengthM"]) * float(x["heightM"]) for x in wc), floor=f))
            else:
                width = sum(float(x["lengthM"]) for x in wc)
                est = round(width * WINDOW_H_M, 3)
                out.append(_m("window_closure_area", M2, wc, None, floor=f, computable=False, reason=R_NO_HEIGHT,
                              estimate={"qty": est, "method": f"רוחב החלון {width:.2f} מ' × גובה מונח {WINDOW_H_M:.2f} מ' (אדן 1.0, משקוף 2.1)", "widthM": round(width, 3)}))  # fmt: skip
        # plaster on new walls: courtyard faces + both faces of new block walls (which faces is not stated)
        if cys or by_kind["block_new"]:
            cw = _sum(cys, "wallAreaM2") or 0.0
            bw = _sum(by_kind["block_new"], "areaM2") or 0.0
            est = round(cw + 2.0 * bw, 3)
            out.append(_m("plaster_new_walls_area", M2, [*cys, *by_kind["block_new"]], None, floor=f, computable=False, reason=R_FACES,
                          estimate={"qty": est, "method": "קירות החצר האנגלית + שני צדי קירות בלוק חדשים", "courtyardM2": round(cw, 3), "blockM2": round(bw, 3)}))  # fmt: skip
        # partial cladding: drawn cladding regions, else a suggestion with the evidence that triggered it
        clad = [r for r in on("regions") if r.get("category") == "cladding"]
        kitchen_clad = [r for r in clad if _room_type(doc, r) == "kitchen"]
        wc_clad = [r for r in clad if _room_type(doc, r) in ("wc", "bathroom")]
        if kitchen_clad:
            out.append(_m("kitchen_backsplash_area", M2, kitchen_clad, _sum(kitchen_clad, "areaM2"), floor=f))
        # the WC's partial cladding is offered from the cistern screen of a WC (guest WC), not of a bathroom
        screens = [x for x in lines if x.get("kind") == "cistern_screen" and x.get("roomType") == "wc"]
        if wc_clad:
            out.append(_m("wc_partial_cladding_area", M2, wc_clad, _sum(wc_clad, "areaM2"), floor=f))
        elif screens:
            est = sum(float(x["lengthM"]) * float(x.get("heightM") or DEFAULT_SCREEN_M) for x in screens)
            assumed = any(x.get("heightM") is None for x in screens)
            out.append(_m("wc_partial_cladding_area", M2, screens, None, floor=f, computable=False, reason=R_NOT_ON_DWG,
                          estimate={"qty": round(est, 3), "method": "אורך מסתור הניאגרה × גובהו" + (f" (גובה מונח {DEFAULT_SCREEN_M:.1f} מ')" if assumed else "")}))  # fmt: skip
        dem = [r for r in on("regions") if r.get("category") == "demolished" and r.get("pattern") == "solid"]
        if dem:
            length = 0.0
            for r in dem:
                p = Polygon([(q["x"], q["y"]) for q in r["polygonMm"]]) if len(r.get("polygonMm") or []) >= 3 else None
                if p is not None and p.is_valid:
                    t, ln = _thickness_length(p)
                    sd = float(doc.get("scaleDenominator") or DEFAULT_SCALE)
                    if WALL_T_M[0] <= t * sd / 1000.0 <= WALL_T_M[1]:
                        length += ln * sd / 1000.0
            if length > 0:
                out.append(_m("demolished_wall_length", M1, dem, round(length, 3), floor=f))
    return out


def _room_type(doc: Mapping[str, Any], item: Mapping[str, Any]) -> str | None:
    return item.get("roomType")
