"""Compose one sheet: page + title block + plan(s) + discipline symbols + legend + notes; build GT and BOQ truth."""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from typing import Any

from . import __version__
from .arch import ArchOut, draw_dims, draw_grid, draw_plan
from .catalog import CHAPTERS, CLASSES, DISCIPLINE_DOMAINS, PIPE_LINES, REPLACE_LINE
from .layout import BuildingSpec, Plan, generate_building
from .place import Pipe, Placed, Placer, context_fixtures, place_electrical, place_lighting, place_plumbing
from .scene import Arc, BBox, Circle, Pen, Poly, Scene, SymbolRef, Text, bbox_of, bbox_overlap, expand, prim_points
from .spec import SCHEMES, SheetSpec, sheet_rng
from .symbols import build

Pt = tuple[float, float]
PAPERS: list[tuple[str, float, float]] = [("A3", 420.0, 297.0), ("A2", 594.0, 420.0), ("A1", 841.0, 594.0), ("A0", 1189.0, 841.0)]
FLOOR_LABEL = {"ground": "קומת קרקע", "first": "קומה א'", "second": "קומה ב'", "third": "קומה ג'"}
SHEET_TITLES = {
    "electrical": ("ת. חשמל", "תוכנית חשמל", "תכנית חשמל ותקשורת"),
    "lighting": ("ת. תאורה", "תוכנית תאורה", "תכנית תאורה"),
    "electrical_lighting": ("תוכנית חשמל ותאורה", "ת. חשמל ותאורה"),
    "plumbing": ("תוכנית אינסטלציה", "ת. אינסטלציה סניטרית", "תכנית מים וביוב"),
}
SHEET_CODE = {"electrical": "E", "lighting": "L", "electrical_lighting": "E", "plumbing": "P"}
PROJECT_NAMES = (
    "בית משפחת כהן",
    "בית משפחת לוי",
    "דירת 4 חדרים",
    "שיפוץ דירה",
    "בית פרטי",
    "דירת גן",
    "דירה ברח' הרצל",
    "וילה בהרצליה",
)
NOTES: dict[str, tuple[str, ...]] = {
    "electrical": (
        "כל השקעים בגובה H=30 אלא אם צוין אחרת",
        'כל המידות בס"מ ממרכז האביזר',
        "יש לתאם מיקום סופי של האביזרים מול המזמין",
        "שקעי מטבח בגובה H=110 מעל משטח העבודה",
        'כל העבודות יבוצעו ע"י חשמלאי מוסמך',
        'אין לבצע עפ"י תוכנית זו ללא אישור',
    ),
    "lighting": (
        "כל המפסקים בגובה H=110 אלא אם צוין אחרת",
        'גופי התאורה יסופקו ע"י המזמין',
        "יש לתאם מיקום ספוטים מול תוכנית תקרות",
        "יש לקרוא תוכנית זו יחד עם תוכנית החשמל",
    ),
    "plumbing": (
        "צנרת מים חמים וקרים מסוג PEX",
        'כל הקוטרים במ"מ',
        "יש לבצע עבודות אינסטלציה יחד עם תוכנית הפריסות",
        "שיפוע צנרת ביוב 2% לפחות",
        "נקודות מים חמים מסומנות ח, קרים ק",
    ),
}


@dataclass
class SheetResult:
    spec: SheetSpec
    scene: Scene
    gt: dict[str, Any]
    boq: dict[str, Any]
    placed: list[Placed] = field(default_factory=list)


# ============================================================================================ page layout
def _plan_box(plan: Plan, k: float, spec: SheetSpec) -> tuple[float, float]:
    W = (plan.footprint[2] - plan.footprint[0]) * k
    D = (plan.footprint[3] - plan.footprint[1]) * k
    left = 26.0 if spec.dims else 8.0
    top = (36.0 if spec.grid else 26.0) if spec.dims or spec.grid else 8.0
    right = 22.0 if spec.grid else 8.0
    return W + left + right, D + top + 16.0


def _panel_size(spec: SheetSpec, n_rows: int) -> tuple[float, float]:
    rh = max(7.0, spec.sym_u * 1.9)
    cols = spec.legend_cols
    rows = math.ceil(n_rows / cols)
    w = 78.0 if cols == 1 else 150.0
    h = 10 + rows * rh
    if spec.type_tags:
        h += 14 + 6 * 7.0
    if spec.notes:
        h += 40
    return w, h


def _dry_rows(spec: SheetSpec, plans: list[Plan], mult_text: bool) -> int:
    """Legend rows this sheet will need: a dry run of the placement (cheap, same RNG streams)."""
    domains = DISCIPLINE_DOMAINS[spec.discipline]
    used: set[str] = set()
    for plan_m in plans:
        plan = plan_m.scaled(20.0, 0.0, 0.0)
        pl = Placer(plan, spec, sheet_rng(spec.seed, spec.index, f"place-{plan.floor}"), 50, spec.font(), [], mult_text=mult_text)
        if "electrical" in domains:
            place_electrical(pl)
        if "lighting" in domains:
            place_lighting(pl)
        if "plumbing" in domains:
            place_plumbing(pl)
        used |= {p.fine for p in pl.out}
    return len(used - set(spec.legend_missing)) + spec.legend_extra + 2


def _layout(spec: SheetSpec, plans: list[Plan], n_rows: int) -> tuple[str, float, float, int, list[Pt], BBox, BBox, BBox]:
    """(paper, W, H, scale, plan origins (top-left of footprint), drawing area, panel box, title box)."""
    pref = spec.legend_cols
    for scale in (50, 100):
        k = 1000.0 / scale
        boxes = [_plan_box(p, k, spec) for p in plans]
        for (name, W, H), cols in ((p, c) for p in PAPERS for c in (pref, 3 - pref)):
            spec.legend_cols = cols
            pw, ph = _panel_size(spec, n_rows)
            fx0, fy0, fx1, fy1 = 10.0, 10.0, W - 10.0, H - 10.0
            if spec.title_block == "bottom":
                tb = (fx0, fy1 - 32.0, fx1, fy1)
                area = (fx0, fy0, fx1, fy1 - 32.0)
            else:
                tb = (fx1 - 72.0, fy0, fx1, fy1)
                area = (fx0, fy0, fx1 - 72.0, fy1)
            aw, ah = area[2] - area[0], area[3] - area[1]
            rng = sheet_rng(spec.seed, spec.index, f"layout-{name}-{scale}")
            row_w = sum(b[0] for b in boxes) + 6 * (len(boxes) - 1)
            row_h = max(b[1] for b in boxes)
            col_w = max(b[0] for b in boxes)
            col_h = sum(b[1] for b in boxes) + 4 * (len(boxes) - 1)
            side = aw - pw - 12
            arr = mode = ""
            for m, a, fits in (
                ("beside", "row", row_w <= side and row_h <= ah - 4 and ph <= ah - 6),
                ("beside", "col", col_w <= side and col_h <= ah - 4 and ph <= ah - 6),
                ("below", "row", row_w <= aw - 8 and row_h + ph + 8 <= ah and pw <= aw - 8),
            ):
                if fits:
                    mode, arr = m, a
                    break
            if not mode:
                continue
            panel_left = rng.random() < 0.5
            if mode == "beside":
                px0 = area[0] + 4 if panel_left else area[2] - pw - 4
                py0 = area[3] - ph - 3 if rng.random() < 0.6 else area[1] + 4
                ox = area[0] + pw + 10 if panel_left else area[0] + 4
            else:
                px0 = area[0] + 4 if panel_left else area[2] - pw - 4
                py0 = area[3] - ph - 3
                ox = area[0] + 4 + max(0.0, (aw - 8 - row_w) / 2)
            panel = (px0, py0, px0 + pw, py0 + ph)
            origins: list[Pt] = []
            cur_x, cur_y = ox, area[1] + 4
            left = 26.0 if spec.dims else 8.0
            top = (36.0 if spec.grid else 26.0) if spec.dims or spec.grid else 8.0
            for bw, bh in boxes:
                origins.append((cur_x + left, cur_y + top))
                if arr == "row":
                    cur_x += bw + 6
                else:
                    cur_y += bh + 4
            return name, W, H, scale, origins, area, panel, tb
    spec.legend_cols = pref
    raise RuntimeError("plan does not fit on A0 at 1:100")


# ============================================================================================ helpers
def _closed(b: BBox) -> list[list[float]]:
    x0, y0, x1, y1 = (round(v, 3) for v in b)
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]


def _rect(scene: Scene, b: BBox, layer: str, pen: Pen | None = None) -> None:
    x0, y0, x1, y1 = b
    scene.add(Poly([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], True), layer, pen)


def _tbox(scene: Scene, t: Text) -> BBox:
    return bbox_of(prim_points(t, scene.font))


# ============================================================================================ title block
def _title_block(scene: Scene, spec: SheetSpec, rng: random.Random, tb: BBox, floors: list[str]) -> dict[str, str]:
    L = scene.layer("G-TTLB", (0, 0, 0), 0.35)
    LT = scene.layer("G-TTLB-TEXT", (0, 0, 0), 0.18)
    title = rng.choice(SHEET_TITLES[spec.discipline])
    floor_txt = " + ".join(FLOOR_LABEL[f] for f in floors)
    fields = {
        "project": rng.choice(PROJECT_NAMES),
        "sheet_name": f"{title} {floor_txt}",
        "scale": "",
        "date": f"{rng.randint(1, 28):02d}.{rng.randint(1, 12):02d}.{rng.randint(21, 26)}",
        "status": rng.choice(["לביצוע", "למכרז", "לעיון"]),
        "sheet_no": f"{SHEET_CODE[spec.discipline]}-{rng.randint(1, 12):02d}",
    }
    _rect(scene, tb, L)
    x0, y0, x1, y1 = tb
    if spec.title_block == "bottom":
        cells = [("שם הפרויקט:", fields["project"], 52), ("שם הגיליון:", fields["sheet_name"], 62), ('קנ"מ:', "", 22)]
        cells += [("תאריך:", fields["date"], 28), ("סטטוס:", fields["status"], 30), ("מס' גיליון:", fields["sheet_no"], 26)]
        x = x1
        for label, value, w in cells:
            xa = x - w
            scene.add(Poly([(xa, y0), (xa, y1)]), L)
            scene.add(Text(label, (x - 1.5, y0 + 5.0), 2.6, 0.0, "r", "b", role="title_label"), LT)
            if value:
                _fit_text(scene, value, (x + xa) / 2, y0 + 17.0, w - 3, 3.2, LT, "title_value")
            x = xa
        fields["_scale_cell"] = f"{x1 - 52 - 62 - 11:.2f},{y0 + 17.0:.2f}"
        scene.add(Text("תאור והערות:", (x - 1.5, y0 + 5.0), 2.6, 0.0, "r", "b", role="title_label"), LT)
        # revisions mini-table at the left end
        rx0 = x0
        scene.add(Poly([(rx0 + 60, y0), (rx0 + 60, y1)]), L)
        for i in range(1, 4):
            scene.add(Poly([(rx0, y0 + i * 8), (rx0 + 60, y0 + i * 8)]), L)
        scene.add(Text("שינויים", (rx0 + 45, y0 + 5.5), 2.4, 0.0, "c", "b", role="title_label"), LT)
        scene.add(Text("תאריך", (rx0 + 12, y0 + 5.5), 2.4, 0.0, "c", "b", role="title_label"), LT)
        scene.add(Poly([(rx0 + 24, y0), (rx0 + 24, y1)]), L)
        scene.add(Text("1", (rx0 + 58, y0 + 13.5), 2.2, 0.0, "r", "b", role="title_value"), LT)
        scene.add(Text("הוצאה ראשונה", (rx0 + 55, y0 + 13.5), 2.2, 0.0, "r", "b", role="title_value"), LT)
        scene.add(Text(fields["date"], (rx0 + 12, y0 + 13.5), 2.2, 0.0, "c", "b", role="title_value"), LT)
    else:
        y = y0
        # revisions table
        scene.add(Text("שינויים", (x1 - 12, y + 6), 2.6, 0.0, "c", "b", role="title_label"), LT)
        scene.add(Text("תאריך", (x0 + 14, y + 6), 2.6, 0.0, "c", "b", role="title_label"), LT)
        scene.add(Poly([(x0 + 28, y), (x0 + 28, y + 40)]), L)
        for i in range(1, 6):
            scene.add(Poly([(x0, y + i * 8), (x1, y + i * 8)]), L)
        scene.add(Text("הוצאה ראשונה", (x1 - 3, y + 14), 2.2, 0.0, "r", "b", role="title_value"), LT)
        scene.add(Text(fields["date"], (x0 + 14, y + 14), 2.2, 0.0, "c", "b", role="title_value"), LT)
        y += 48
        scene.add(Poly([(x0, y), (x1, y)]), L)
        scene.add(Text("תוכן גיליון:", (x1 - 3, y + 7), 2.6, 0.0, "r", "b", role="title_label"), LT)
        _fit_text(scene, title, (x0 + x1) / 2, y + 20, 64, 6.0, LT, "title_value")
        _fit_text(scene, floor_txt, (x0 + x1) / 2, y + 29, 64, 4.0, LT, "title_value")
        y += 36
        rows = [("פרויקט:", fields["project"]), ("שם הגיליון:", fields["sheet_name"]), ('קנ"מ:', ""), ("תאריך:", fields["date"])]
        rows += [("סטטוס:", fields["status"]), ("מס' גיליון:", fields["sheet_no"])]
        for label, value in rows:
            scene.add(Poly([(x0, y), (x1, y)]), L)
            scene.add(Text(label, (x1 - 3, y + 6), 2.6, 0.0, "r", "b", role="title_label"), LT)
            if value:
                _fit_text(scene, value, (x0 + x1) / 2 - 8, y + 12.5, 52, 3.0, LT, "title_value")
            if label.startswith("קנ"):
                fields["_scale_cell"] = f"{(x0 + x1) / 2 - 8:.2f},{y + 12.5:.2f}"
            y += 16
        scene.add(Poly([(x0, y), (x1, y)]), L)
        scene.add(Text("הערות כלליות:", (x1 - 3, y + 6), 2.6, 0.0, "r", "b", role="title_label"), LT)
    return fields


def _fit_text(scene: Scene, s: str, cx: float, y: float, maxw: float, h: float, layer: str, role: str) -> None:
    t = Text(s, (cx, y), h, 0.0, "c", "b", role=role)
    bb = _tbox(scene, t)
    if bb[2] - bb[0] > maxw:
        t.h = h * maxw / (bb[2] - bb[0])
    scene.add(t, layer)


# ============================================================================================ legend
@dataclass
class LegendRow:
    rid: str
    fine: str
    label: str
    sid: str
    mult: str | None  # "2X" when the row shows a single-socket glyph + 2X
    used: bool
    row_box: BBox = (0.0, 0.0, 0.0, 0.0)
    sym_box: BBox = (0.0, 0.0, 0.0, 0.0)
    label_box: BBox = (0.0, 0.0, 0.0, 0.0)


def _legend(
    scene: Scene, spec: SheetSpec, rng: random.Random, panel: BBox, used: list[str], mult_text: bool
) -> tuple[list[LegendRow], BBox, float]:
    domains = DISCIPLINE_DOMAINS[spec.discipline]
    sc = SCHEMES[spec.scheme]
    rows: list[LegendRow] = []
    shown = [f for f in used if f not in spec.legend_missing]
    pool = sorted(f for f, c in CLASSES.items() if c.domain in domains and f not in used and f not in spec.legend_missing)
    extra = rng.sample(pool, min(len(pool), spec.legend_extra)) if pool else []
    order = sorted(
        shown + extra, key=lambda f: (list(DISCIPLINE_DOMAINS["electrical_lighting"] + ("plumbing",)).index(CLASSES[f].domain), f)
    )
    if rng.random() < 0.4:
        rng.shuffle(order)
    for i, f in enumerate(order):
        info = CLASSES[f]
        label = rng.choice(info.labels)
        mult = None
        sid = spec.styles[f]
        if mult_text and f in ("socket_double", "socket_triple"):
            mult = "2X" if f == "socket_double" else "3X"
            sid = spec.styles["socket_single"]
            label = (
                rng.choice(["שקע בהרכבים", "שקע כפול", "זוג שקעים"])
                if f == "socket_double"
                else rng.choice(["שלישיית שקעים", "שקע משולש"])
            )
        rows.append(LegendRow(f"{spec.sheet_id}-legend-{i + 1}", f, label, sid, mult, f in used))
    L = scene.layer("G-LEGD", sc["text"], 0.25)
    LT = scene.layer("G-LEGD-TEXT", sc["text"], 0.18)
    rh = max(7.0, spec.sym_u * 1.9)
    cols = spec.legend_cols
    x0, y0, x1, _ = panel
    title_h = 3.2
    scene.add(
        Text(
            rng.choice(
                [
                    "מקרא:",
                    "מקרא",
                    f"מקרא {'חשמל' if 'electrical' in domains else ('תאורה' if 'lighting' in domains else 'אינסטלציה')}",
                ]
            ),
            (x1, y0 + 5),
            title_h,
            0.0,
            "r",
            "b",
            role="legend_title",
        ),
        LT,
    )
    ty0 = y0 + 8.0
    nrows = math.ceil(len(rows) / cols) if rows else 1
    ty1 = ty0 + nrows * rh
    col_w = (x1 - x0) / cols
    _rect(scene, (x0, ty0, x1, ty1), L)
    for r in range(1, nrows):
        scene.add(Poly([(x0, ty0 + r * rh), (x1, ty0 + r * rh)]), L)
    vlines = rng.random() < 0.5
    sym_w = max(12.0, spec.sym_u * 3.2)
    for c in range(cols):
        cx1 = x1 - c * col_w
        if c > 0:
            scene.add(Poly([(cx1, ty0), (cx1, ty1)]), L)
        if vlines:
            scene.add(Poly([(cx1 - sym_w, ty0), (cx1 - sym_w, ty1)]), L)
    sym_pen = Pen(sc[next(iter(domains))], spec.lw)
    for i, row in enumerate(rows):
        c, r = divmod(i, nrows)
        cx1 = x1 - c * col_w
        ry0 = ty0 + r * rh
        row.row_box = (cx1 - col_w, ry0, cx1, ry0 + rh)
        info = CLASSES[row.fine]
        u = spec.sym_u if not info.real_size else min(spec.sym_u * 1.6, 1000.0 / 50) / 1.0
        params: dict[str, object] = {}
        if row.fine == "luminaire_strip":
            params = {"length": 2.4}
        if info.real_size:
            u = (rh - 2.0) / 0.75
            if row.fine == "fixture_bath":
                params = {"length": 1.6}
                u = min(u, (sym_w - 1.5) / 1.6)
        local = build(row.sid, u, spec.lw, params)
        ref0 = SymbolRef("", row.sid, local, (0.0, 0.0), 0.0, False, "", sym_pen)
        bb0 = bbox_of([q for p in expand(ref0) for q in prim_points(p, scene.font)])
        scx = cx1 - sym_w / 2
        mult_t: Text | None = None
        if row.mult:
            mult_t = Text(row.mult + "-", (0.0, 0.0), min(2.4, rh * 0.3), 0.0, "r", "m", role="legend_mult")
            mw = _tbox(scene, mult_t)
            scx = cx1 - sym_w + 0.8 + (mw[2] - mw[0]) + 0.5 + (bb0[2] - bb0[0]) / 2
        ins = (scx - (bb0[0] + bb0[2]) / 2, ry0 + rh / 2 - (bb0[1] + bb0[3]) / 2)
        layer = scene.layer(_sym_layer(row.fine), sc[info.domain], spec.lw)
        ref = SymbolRef(row.rid, row.sid, local, ins, 0.0, False, layer, Pen(sc[info.domain], spec.lw), role="legend")
        scene.add_symbol(ref)
        row.sym_box = (bb0[0] + ins[0], bb0[1] + ins[1], bb0[2] + ins[0], bb0[3] + ins[1])
        if mult_t is not None:
            mult_t.pos = (row.sym_box[0] - 0.5, ry0 + rh / 2)
            scene.add(mult_t, LT)
        lab = Text(row.label, (cx1 - sym_w - 1.5, ry0 + rh / 2), min(2.6, rh * 0.36), 0.0, "r", "m", role="legend_label")
        bb = _tbox(scene, lab)
        maxw = col_w - sym_w - 3.0
        if bb[2] - bb[0] > maxw:
            lab.h *= maxw / (bb[2] - bb[0])
            bb = _tbox(scene, lab)
        scene.add(lab, LT)
        row.label_box = bb
    return rows, (x0, y0, x1, ty1), ty1


def _sym_layer(fine: str) -> str:
    d = CLASSES[fine].domain
    if d == "plumbing":
        return "P-SANR-FIXT" if CLASSES[fine].real_size else "P-DOMW-SYMB"
    if d == "lighting":
        return "E-LITE-SWCH" if fine.startswith("switch") else "E-LITE-EQPM"
    return "E-POWR-DEVC" if fine.startswith("socket") else "E-COMM-DEVC"


def _types_table(
    scene: Scene, spec: SheetSpec, rng: random.Random, x0: float, x1: float, y: float, placed: list[Placed]
) -> tuple[float, list[dict[str, Any]]]:
    types: dict[int, str] = {}
    for p in placed:
        if p.type_tag is not None:
            types[p.type_tag] = p.fine
    if not types:
        return y, []
    L = scene.layer("G-LEGD", (0, 0, 0), 0.25)
    LT = scene.layer("G-LEGD-TEXT", (0, 0, 0), 0.18)
    scene.add(Text(rng.choice(["טבלת תאורה:", "טבלת גופי תאורה"]), (x1, y + 5), 3.0, 0.0, "r", "b", role="types_title"), LT)
    rh = 6.5
    ty0 = y + 8
    n = len(types) + 1
    _rect(scene, (x0, ty0, x1, ty0 + n * rh), L)
    for i in range(1, n):
        scene.add(Poly([(x0, ty0 + i * rh), (x1, ty0 + i * rh)]), L)
    scene.add(Poly([(x1 - 10, ty0), (x1 - 10, ty0 + n * rh)]), L)
    scene.add(Poly([(x0 + 22, ty0), (x0 + 22, ty0 + n * rh)]), L)
    scene.add(Text("מס'", (x1 - 5, ty0 + rh / 2), 2.2, 0.0, "c", "m", role="types_header"), LT)
    scene.add(Text("סוג", (x1 - 12, ty0 + rh / 2), 2.2, 0.0, "r", "m", role="types_header"), LT)
    scene.add(Text("הערות", (x0 + 11, ty0 + rh / 2), 2.2, 0.0, "c", "m", role="types_header"), LT)
    rows = []
    for i, (num, fine) in enumerate(sorted(types.items())):
        ry = ty0 + (i + 1) * rh + rh / 2
        scene.add(Text(str(num), (x1 - 5, ry), 2.2, 0.0, "c", "m", role="types_num"), LT)
        desc = rng.choice(CLASSES[fine].labels)
        scene.add(Text(desc, (x1 - 12, ry), 2.2, 0.0, "r", "m", role="types_desc"), LT)
        scene.add(
            Text(rng.choice(["לבן", "שחור", "LED 12W", "3000K", "IP44"]), (x0 + 11, ry), 2.0, 0.0, "c", "m", role="types_note"),
            LT,
        )
        rows.append({"type": num, "synth_class": fine, "class": CLASSES[fine].taxonomy, "description": desc})
    return ty0 + n * rh, rows


# ============================================================================================ notes, clouds, north arrow
def _notes(scene: Scene, spec: SheetSpec, rng: random.Random, x0: float, x1: float, y: float) -> float:
    LT = scene.layer("G-ANNO-NOTE", SCHEMES[spec.scheme]["text"], 0.18)
    key = "plumbing" if spec.discipline == "plumbing" else ("lighting" if spec.discipline == "lighting" else "electrical")
    pool = list(NOTES[key])
    if spec.discipline == "electrical_lighting":
        pool += list(NOTES["lighting"])
    notes = rng.sample(pool, min(len(pool), rng.randint(2, 4)))
    scene.add(Text("הערות:", (x1, y + 6), 3.0, 0.0, "r", "b", role="notes_title"), LT)
    yy = y + 12
    for i, n in enumerate(notes):
        t = Text(f"{i + 1}. {n}", (x1, yy), 2.3, 0.0, "r", "b", role="note")
        bb = _tbox(scene, t)
        if bb[2] - bb[0] > x1 - x0:
            t.h *= (x1 - x0) / (bb[2] - bb[0])
        scene.add(t, LT)
        yy += 5.5
    return yy


def _cloud(scene: Scene, b: BBox, rng: random.Random, color: tuple[int, int, int]) -> BBox:
    L = scene.layer("G-ANNO-REVS", color, 0.3)
    x0, y0, x1, y1 = b
    r = 2.2
    pts: list[Pt] = []
    for (ax, ay), (bx, by) in (((x0, y0), (x1, y0)), ((x1, y0), (x1, y1)), ((x1, y1), (x0, y1)), ((x0, y1), (x0, y0))):
        n = max(1, int(math.dist((ax, ay), (bx, by)) / (2 * r)))
        for i in range(n):
            pts.append((ax + (bx - ax) * i / n, ay + (by - ay) * i / n))
    for p, q in zip(pts, pts[1:] + pts[:1], strict=True):
        c = ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
        rr = math.dist(p, q) / 2
        if rr < 0.3:
            continue
        a = math.degrees(math.atan2(-(q[1] - p[1]), q[0] - p[0]))
        # bulge outward: clockwise traversal on paper (y down) -> the arc to the left of p->q
        scene.add(Arc(c, rr, a, a + 180.0), L)
    tx, ty = x1 + 1.0, y0 - 5.5
    scene.add(Poly([(tx, ty + 4.5), (tx + 5.2, ty + 4.5), (tx + 2.6, ty)], True), L)
    scene.add(Text("1", (tx + 2.6, ty + 3.0), 2.0, 0.0, "c", "m", role="revision_tag"), L)
    del rng
    return (x0 - r, y0 - 6, x1 + 7, y1 + r)


def _north(scene: Scene, c: Pt) -> BBox:
    L = scene.layer("G-ANNO-SYMB", (0, 0, 0), 0.25)
    scene.add(Circle(c, 6.0), L)
    scene.add(
        Poly([(c[0], c[1] - 7.5), (c[0] + 2.4, c[1] + 4.5), (c[0], c[1] + 2.5), (c[0] - 2.4, c[1] + 4.5)], True, None, (0, 0, 0)),
        L,
    )
    scene.add(Text("צ", (c[0], c[1] - 9.5), 3.0, 0.0, "c", "b", role="north"), L)
    return (c[0] - 6, c[1] - 13, c[0] + 6, c[1] + 6)


# ============================================================================================ main
def compose(spec: SheetSpec) -> SheetResult:
    rng = sheet_rng(spec.seed, spec.index, "compose")
    brng = sheet_rng(spec.seed, spec.index, "building")
    all_floors = ["ground", "first"] if spec.building == "house" else spec.floors
    plans_all = generate_building(brng, BuildingSpec(spec.building, all_floors, spec.ext_t, spec.part_kind, 0.10))
    plans = [p for p in plans_all if p.floor in spec.floors]
    mult_text = rng.random() < spec.p_mult_text
    paper, W, H, scale, origins, area, panel, tb = _layout(spec, plans, _dry_rows(spec, plans, mult_text))
    k = 1000.0 / scale
    font = spec.font()
    scene = Scene(W, H, font)
    sc = SCHEMES[spec.scheme]
    LF = scene.layer("G-FRAM", (0, 0, 0), 0.5)
    _rect(scene, (10.0, 10.0, W - 10.0, H - 10.0), LF)
    fields = _title_block(scene, spec, rng, tb, spec.floors)
    sx, sy = (float(v) for v in fields.pop("_scale_cell").split(","))
    scene.add(Text(f"1:{scale}", (sx, sy), 3.2, 0.0, "c", "b", role="title_value"), "G-TTLB-TEXT")

    placed: list[Placed] = []
    pipes: list[Pipe] = []
    arch_feats: list[dict[str, Any]] = []
    texts: list[dict[str, Any]] = []
    regions: list[dict[str, Any]] = []
    domains = DISCIPLINE_DOMAINS[spec.discipline]
    occ_global: list[BBox] = [panel, tb]
    for plan_m, (ox, oy) in zip(plans, origins, strict=True):
        plan = plan_m.scaled(k, ox, oy)
        arng = sheet_rng(spec.seed, spec.index, f"arch-{plan.floor}")
        ao: ArchOut = draw_plan(scene, plan, spec, arng, scale, show_fixtures=spec.discipline != "plumbing")
        occ = list(ao.occupied)
        if spec.dims:
            occ += draw_dims(scene, plan, spec, scale)
        if spec.grid:
            draw_grid(scene, plan, spec)
        fx0, fy0, fx1, fy1 = plan.footprint
        title_t = Text(f"תוכנית {FLOOR_LABEL[plan.floor]}", ((fx0 + fx1) / 2, fy1 + 9.0), 3.6, 0.0, "c", "b", role="plan_title")
        scene.add(title_t, scene.layer("A-ANNO-TTLB", sc["text"], 0.25))
        tbb = _tbox(scene, title_t)
        scene.add(Poly([(tbb[0], fy1 + 10.2), (tbb[2], fy1 + 10.2)]), "A-ANNO-TTLB", Pen(sc["text"], 0.35))
        scene.add(Text(f'קנ"מ 1:{scale}', ((fx0 + fx1) / 2, fy1 + 14.0), 2.4, 0.0, "c", "b", role="plan_scale"), "A-ANNO-TTLB")
        regions.append(
            {
                "floor": plan.floor,
                "bbox_mm": [round(v, 2) for v in (fx0 - 26, fy0 - 36, fx1 + 22, fy1 + 16)],
                "footprint_mm": [round(v, 2) for v in plan.footprint],
            }
        )
        prng = sheet_rng(spec.seed, spec.index, f"place-{plan.floor}")
        pl = Placer(plan, spec, prng, scale, font, occ + occ_global, mult_text=mult_text)
        if spec.discipline != "plumbing":
            placed += context_fixtures(pl)
        if "electrical" in domains:
            place_electrical(pl)
        if "lighting" in domains:
            place_lighting(pl)
        if "plumbing" in domains:
            place_plumbing(pl)
        nc = (fx1 + (30.0 if spec.grid else 14.0), fy1 - 10.0)
        nbox = (nc[0] - 7, nc[1] - 14, nc[0] + 7, nc[1] + 7)
        inside = area[0] < nbox[0] and nbox[2] < area[2] and area[1] < nbox[1] and nbox[3] < area[3]
        if rng.random() < 0.6 and inside and not any(bbox_overlap(nbox, o, 1.0) for o in occ_global):
            occ_global.append(_north(scene, nc))
        placed += pl.out
        pipes += pl.pipes
        arch_feats += ao.features
        texts += ao.texts

    # ---- symbols + labels + pipes into the scene
    for p in placed:
        if p.context:
            layer = scene.layer("A-PLMB-FIXT", sc["furn"], 0.18)
            scene.add_symbol(
                SymbolRef(
                    "", p.sid, p.local, p.insert, p.rot, p.mirror, layer, Pen(sc["furn"], 0.18), exploded=True, role="context"
                )
            )
            continue
        dom = CLASSES[p.fine].domain
        layer = scene.layer(_sym_layer(p.fine), sc[dom], spec.lw)
        scene.add_symbol(
            SymbolRef("", p.sid, p.local, p.insert, p.rot, p.mirror, layer, Pen(sc[dom], spec.lw), exploded=p.exploded)
        )
        lt = scene.layer(f"{layer}-TEXT", sc[dom] if spec.scheme != "noah" else (0, 0, 0), 0.18)
        for prim in p.labels:
            scene.add(prim, lt)
    pipe_col = (
        {"cold": (0, 90, 220), "hot": (220, 0, 0), "sewer": (120, 70, 20)}
        if spec.scheme != "mono"
        else {"cold": (0, 0, 0), "hot": (0, 0, 0), "sewer": (0, 0, 0)}
    )
    for pp in pipes:
        layer = scene.layer(
            {"cold": "P-DOMW-CPIP", "hot": "P-DOMW-HPIP", "sewer": "P-SANR-PIPE"}[pp.system], pipe_col[pp.system], 0.35
        )
        dash = None if pp.system == "cold" else ((2.0, 1.0) if pp.system == "hot" else (4.0, 1.0, 1.0, 1.0))
        scene.add(Poly(list(pp.pts)), layer, Pen(pipe_col[pp.system], 0.5 if pp.system == "sewer" else 0.3, dash))
        if pp.label is not None:
            scene.add(pp.label, layer)

    # ---- clouds (hard / medium)
    real = [p for p in placed if not p.context]
    for _ in range(spec.clouds):
        if not real:
            break
        p = rng.choice(real)
        c = ((p.bbox[0] + p.bbox[2]) / 2, (p.bbox[1] + p.bbox[3]) / 2)
        group = [q.bbox for q in real if math.dist(c, ((q.bbox[0] + q.bbox[2]) / 2, (q.bbox[1] + q.bbox[3]) / 2)) < 18.0]
        b = (min(g[0] for g in group), min(g[1] for g in group), max(g[2] for g in group), max(g[3] for g in group))
        _cloud(scene, (b[0] - 6, b[1] - 6, b[2] + 6, b[3] + 6), rng, (200, 0, 0) if spec.scheme != "mono" else (0, 0, 0))

    # ---- panel: legend, types table, notes
    lrng = sheet_rng(spec.seed, spec.index, "legend")
    used = sorted({p.fine for p in real})
    rows, legend_box, y = _legend(scene, spec, lrng, panel, used, mult_text)
    types_rows: list[dict[str, Any]] = []
    if spec.type_tags:
        y, types_rows = _types_table(scene, spec, lrng, panel[0], panel[2], y + 4, placed)
    if spec.notes:
        _notes(scene, spec, lrng, panel[0], panel[2], y + 4)

    gt = _gt(spec, scene, paper, scale, placed, pipes, arch_feats, rows, types_rows, regions, legend_box, tb, texts, fields)
    boq = build_boq(spec.sheet_id, gt)
    return SheetResult(spec, scene, gt, boq, placed)


# ============================================================================================ GT + BOQ
def _assign_ids(spec: SheetSpec, placed: list[Placed]) -> None:
    counters: dict[str, int] = {}
    for p in placed:
        key = p.cls + ("-ctx" if p.context else "")
        counters[key] = counters.get(key, 0) + 1
        p.gid = f"{spec.sheet_id}-{p.cls}{'-ctx' if p.context else ''}-{counters[key]}"


def _gt(
    spec: SheetSpec,
    scene: Scene,
    paper: str,
    scale: int,
    placed: list[Placed],
    pipes: list[Pipe],
    arch_feats: list[dict[str, Any]],
    rows: list[LegendRow],
    types_rows: list[dict[str, Any]],
    regions: list[dict[str, Any]],
    legend_box: BBox,
    tb: BBox,
    texts: list[dict[str, Any]],
    fields: dict[str, str],
) -> dict[str, Any]:
    _assign_ids(spec, placed)
    # SymbolRefs in the scene get the GT ids in the same order (context and symbols)
    refs = [it for it in scene.items if isinstance(it, SymbolRef) and it.role in ("symbol", "context")]
    for ref, p in zip(refs, placed, strict=True):
        ref.gid = p.gid
    legend_by_fine = {r.fine: r.rid for r in rows}
    feats: list[dict[str, Any]] = []
    annotator = f"synth:kamutan-synth/{__version__}"

    def feat(fid: str, geom: dict[str, Any], props: dict[str, Any]) -> None:
        base = {
            "id": fid,
            "floor": props.pop("floor", spec.floors[0]),
            "lifecycle": props.pop("lifecycle", "new"),
            "supply": props.pop("supply", "contractor"),
        }
        base |= {"annotator": annotator, "status": "verified"}
        feats.append({"type": "Feature", "id": fid, "geometry": geom, "properties": base | props})

    for p in placed:
        info = CLASSES[p.fine]
        bb = [round(v, 3) for v in p.bbox]
        props: dict[str, Any] = {
            "class": p.cls,
            "symbol_class": p.symbol_cls,
            "synth_class": p.fine,
            "kind": "context" if p.context else "symbol",
            "legend_entry": None if p.context else legend_by_fine.get(p.fine),
            "room_id": p.room_id,
            "floor": p.floor,
            "lifecycle": p.lifecycle,
            "supply": "existing" if p.lifecycle == "existing" else "contractor",
            "link_group": [],
            "boq_code": info.boq if (not p.context and p.lifecycle == "new") else None,
            "domain": "hvac" if p.cls == "ac_unit" else info.domain,
            "annotations": list(p.annotations),
            "style_id": p.sid,
            "rotation": round(p.rot % 360.0, 2),
            "mirrored": p.mirror,
            "exploded": p.exploded,
            "insert_mm": [round(p.insert[0], 3), round(p.insert[1], 3)],
            "bbox_mm": bb,
            "center_mm": [round((bb[0] + bb[2]) / 2, 3), round((bb[1] + bb[3]) / 2, 3)],
            "heights_cm": list(p.heights_cm),
            "qty": p.qty,
            "qualifier": p.qualifier,
            "type_tag": p.type_tag,
            "controls": [placed[i].gid for i in p.controls],
            "difficulty": sorted({t for t in p.tags if t in ("overlap", "rotated", "partial", "text_collision")}),
            "synth_tags": sorted(set(p.tags)),
            "label_boxes_mm": [[round(v, 2) for v in b] for b in p.label_boxes],
        }
        feat(p.gid, {"type": "Polygon", "coordinates": [_closed(p.bbox)]}, props)
    counters: dict[str, int] = {}
    for af in arch_feats:
        cls = af["props"]["class"]
        counters[cls] = counters.get(cls, 0) + 1
        fid = f"{spec.sheet_id}-{cls}-{counters[cls]}"
        props = dict(af["props"])
        props.setdefault("room_id", None)
        props["floor"] = _floor_of_feature(af, regions, spec)
        props["domain"] = "tiling" if cls == "room" else "other"
        feat(fid, af["geometry"], props)
    for i, pp in enumerate(pipes):
        pp.gid = f"{spec.sheet_id}-pipe-{i + 1}"
        code, _desc = PIPE_LINES.get((pp.system, pp.dia), ("", ""))
        feat(
            pp.gid,
            {"type": "LineString", "coordinates": [[round(x, 3), round(y, 3)] for x, y in pp.pts]},
            {
                "class": "pipe",
                "kind": "linear",
                "domain": "plumbing",
                "system": pp.system,
                "diameter_mm": pp.dia,
                "length_m": pp.length_m,
                "boq_code": code or None,
                "floor": pp.floor,
                "labelled": pp.label is not None,
                "quantity": pp.length_m,
            },
        )
    for r in rows:
        feat(
            r.rid,
            {"type": "Polygon", "coordinates": [_closed(r.row_box)]},
            {
                "class": "legend_entry",
                "kind": "context",
                "domain": "other",
                "legend_class": CLASSES[r.fine].taxonomy,
                "synth_class": r.fine,
                "label": r.label,
                "style_id": r.sid,
                "multiplicity_text": r.mult,
                "used": r.used,
                "symbol_bbox_mm": [round(v, 3) for v in r.sym_box],
                "label_bbox_mm": [round(v, 3) for v in r.label_box],
            },
        )
    feat(
        f"{spec.sheet_id}-legend_box-1",
        {"type": "Polygon", "coordinates": [_closed(legend_box)]},
        {"class": "legend_box", "kind": "context", "domain": "other"},
    )
    disciplines = list(DISCIPLINE_DOMAINS[spec.discipline])
    gt: dict[str, Any] = {
        "type": "FeatureCollection",
        "kamutan": {
            "schema_version": "1.0",
            "project_id": spec.sheet_id,
            "sheet_id": spec.sheet_id,
            "page_size_mm": [scene.width, scene.height],
            "units": "mm",
            "y_axis": "down",
            "scale": scale,
            "input_type": "vector",
            "scale_conflict": False,
            "discipline": spec.discipline if spec.discipline != "electrical_lighting" else "electrical",
            "disciplines": disciplines,
            "floors": list(spec.floors),
            "kind": "truth",
            "gt_version": f"synth-{__version__}",
            "notes": "synthetic sheet; ground truth exact by construction (kamutan-synth)",
        },
        "features": feats,
        "synth": {
            "generator": f"kamutan-synth {__version__}",
            "seed": spec.seed,
            "index": spec.index,
            "difficulty": spec.difficulty,
            "paper": paper,
            "knobs": spec.to_json(),
            "regions": regions,
            "legend_bbox_mm": [round(v, 2) for v in legend_box],
            "title_block_bbox_mm": [round(v, 2) for v in tb],
            "title_fields": {k: v for k, v in fields.items() if not k.startswith("_")} | {"scale": f"1:{scale}"},
            "types_table": types_rows,
            "dxf_transform": {"model_units": "mm", "x": f"x_mm * {scale}", "y": f"-y_mm * {scale}"},
            "texts": texts,
        },
    }
    return gt


def _floor_of_feature(af: dict[str, Any], regions: list[dict[str, Any]], spec: SheetSpec) -> str:
    g = af["geometry"]
    c = g["coordinates"]
    if g["type"] == "Point":
        x, y = c
    elif g["type"] == "LineString":
        x, y = c[0]
    else:
        x, y = c[0][0]
    for r in regions:
        b = r["bbox_mm"]
        if b[0] <= x <= b[2] and b[1] <= y <= b[3]:
            return str(r["floor"])
    return spec.floors[0]


def build_boq(sheet_id: str, gt: dict[str, Any]) -> dict[str, Any]:
    lines: dict[str, dict[str, Any]] = {}

    def line(code: str, desc: str, unit: str, category: str) -> dict[str, Any]:
        if code not in lines:
            lines[code] = {
                "code": code,
                "chapter": CHAPTERS[code.split(".")[0]],
                "description": desc,
                "unit": unit,
                "quantity": 0.0,
                "evidence": [],
                "derivation": "",
                "breakdown": {},
                "gt_status": "confirmed",
                "category": category,
                "flags": ["synthetic"],
            }
        return lines[code]

    for f in gt["features"]:
        p = f["properties"]
        if p.get("kind") == "symbol" and p.get("lifecycle") == "new":
            info = CLASSES[p["synth_class"]]
            ln = line(info.boq, info.boq_desc, "יחידה", "count")
            q = float(p.get("qty", 1))
            ln["quantity"] += q
            ln["evidence"].append(p["id"])
            ln["breakdown"][p["floor"]] = ln["breakdown"].get(p["floor"], 0.0) + q
            ln["derivation"] = f"sum(qty) of synth_class={info.fine}, lifecycle=new"
            if p.get("qualifier") in ("להחליף", "להחלפה"):
                rl = line(REPLACE_LINE[0], REPLACE_LINE[1], "יחידה", "count")
                rl["quantity"] += 1
                rl["evidence"].append(p["id"])
                rl["breakdown"][p["floor"]] = rl["breakdown"].get(p["floor"], 0.0) + 1
                rl["derivation"] = "count of symbols with qualifier להחליף / להחלפה"
        elif p.get("class") == "pipe" and p.get("boq_code"):
            code, desc = PIPE_LINES[(p["system"], p["diameter_mm"])]
            ln = line(code, desc, 'מ"א', "length")
            ln["quantity"] += float(p["length_m"])
            ln["evidence"].append(p["id"])
            ln["breakdown"][p["floor"]] = ln["breakdown"].get(p["floor"], 0.0) + float(p["length_m"])
            ln["derivation"] = f"sum(length_m) of pipes system={p['system']}, diameter={p['diameter_mm']}"
    out = sorted(lines.values(), key=lambda ln: [int(x) for x in ln["code"].split(".")])
    for ln in out:
        ln["quantity"] = round(ln["quantity"], 3)
        ln["breakdown"] = {k: round(v, 3) for k, v in sorted(ln["breakdown"].items())}
    return {
        "schema_version": "1.0",
        "project_id": sheet_id,
        "kind": "truth",
        "gt_version": f"synth-{__version__}",
        "status": "verified",
        "generated_by": f"kamutan-synth {__version__} (exact by construction)",
        "notes": [
            "Synthetic price list (catalog.py): codes are TEXT; existing (קיים) items are excluded; replaced items count in their line and in 4.90."
        ],
        "lines": out,
    }
