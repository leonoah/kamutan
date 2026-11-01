"""Sprint 6 (Worker-Geometry): ``kamutan_drawing.geometry`` — synthetic plans + the Noah sample (local artifacts).

Synthetic sheets are 1:50 (20 paper mm = 1 m). Sample tests read ``scripts/geometry_local.py``'s scratch root
(``/home/claude/kamutan-data/acceptance/s6-geometry/artifacts``) or the shared artifacts and skip without them.
"""

from __future__ import annotations

import gzip
import itertools
import json
import math
import os
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from kamutan_drawing.calibration import CalibrationTable, ClassStats
from kamutan_drawing.geometry import GEOMETRY_SCHEMA, KEYS, analyze, geometry_units
from kamutan_drawing.geometry import labels as L
from kamutan_drawing.geometry.prims import colour_class, lifecycle_of
from kamutan_drawing.ingest.pdf_vector import VectorSheet
from kamutan_drawing.pipeline.ceiling import cap_document
from kamutan_drawing.types_sprint2 import SimpleText

RED = (255, 0, 0)
YELLOW = (255, 255, 20)
BLACK = (0, 0, 0)
GREY = (201, 201, 201)
M = 20.0  # paper mm per real metre at 1:50
REPO = Path(__file__).resolve().parents[3]
SCHEMA = REPO / "packages" / "contracts" / "json-schema" / "GeometryArtifact.json"


class Sheet:
    """Builder of a minimal VectorSheet (straight pieces only)."""

    def __init__(self) -> None:
        self.paths: list[dict[str, Any]] = []

    def line(self, pts: list[tuple[float, float]], rgb: tuple[int, int, int] = RED, width: float = 0.21) -> Sheet:
        self.paths.append({"pts": pts, "stroke": rgb, "fill": None, "w": width})
        return self

    def fill(self, pts: list[tuple[float, float]], rgb: tuple[int, int, int] = RED) -> Sheet:
        ring = [*pts, pts[0]]
        self.paths.append({"pts": ring, "stroke": rgb, "fill": rgb, "w": 0.0})
        return self

    def rect(self, x0: float, y0: float, x1: float, y1: float, rgb: tuple[int, int, int] = RED) -> Sheet:
        return self.fill([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], rgb)

    def dashed(
        self, a: tuple[float, float], b: tuple[float, float], rgb: tuple[int, int, int] = RED, dash: float = 2.5, gap: float = 1.3
    ) -> Sheet:
        L_ = math.hypot(b[0] - a[0], b[1] - a[1])
        ux, uy = (b[0] - a[0]) / L_, (b[1] - a[1]) / L_
        t = 0.0
        while t < L_ - 0.01:
            e = min(L_, t + dash)
            self.line([(a[0] + ux * t, a[1] + uy * t), (a[0] + ux * e, a[1] + uy * e)], rgb)
            t = e + gap
        return self

    def build(self, w: float = 420.0, h: float = 297.0) -> VectorSheet:
        segs, seg_path, starts, counts, bboxes = [], [], [], [], []
        for i, p in enumerate(self.paths):
            starts.append(len(segs))
            for (x0, y0), (x1, y1) in itertools.pairwise(p["pts"]):
                segs.append((x0, y0, x1, y1))
                seg_path.append(i)
            counts.append(len(p["pts"]) - 1)
            xs, ys = [q[0] for q in p["pts"]], [q[1] for q in p["pts"]]
            bboxes.append((min(xs), min(ys), max(xs), max(ys)))
        n = len(self.paths)
        stroke = np.array([[*p["stroke"], 255] for p in self.paths], np.uint8).reshape(n, 4)
        fill = np.array([[*(p["fill"] or (0, 0, 0)), 255 if p["fill"] else 0] for p in self.paths], np.uint8).reshape(n, 4)
        return VectorSheet(
            page_index=0,
            width_mm=w,
            height_mm=h,
            path_stroke_rgba=stroke,
            path_fill_rgba=fill,
            path_stroked=np.ones(n, bool),
            path_fill_mode=np.array([1 if p["fill"] else 0 for p in self.paths], np.int8),
            path_width_mm=np.array([p["w"] for p in self.paths], np.float32),
            path_dash=[() for _ in self.paths],
            path_closed=np.array([bool(p["fill"]) for p in self.paths], bool),
            path_bbox=np.array(bboxes, np.float32).reshape(n, 4),
            path_seg_start=np.array(starts, np.int32),
            path_seg_count=np.array(counts, np.int32),
            segs=np.array(segs, np.float32).reshape(-1, 4),
            seg_path=np.array(seg_path, np.int32),
            seg_kind=np.zeros(len(segs), np.int8),
            curves=np.zeros((0, 8), np.float32),
            curve_path=np.zeros(0, np.int32),
        )


def house(s: Sheet, x0: float = 100, y0: float = 60, x1: float = 300, y1: float = 200, t: float = 4.0) -> Sheet:
    """Four grey (existing) walls of a house, 0.2 m thick, plus their black outline."""
    s.rect(x0, y0, x1, y0 + t, GREY).rect(x0, y1 - t, x1, y1, GREY).rect(x0, y0, x0 + t, y1, GREY).rect(x1 - t, y0, x1, y1, GREY)
    return s


def room(rid: str, x0: float, y0: float, x1: float, y1: float, **kw: Any) -> dict[str, Any]:
    return {"id": rid, "polygonMm": [{"x": x0, "y": y0}, {"x": x1, "y": y0}, {"x": x1, "y": y1}, {"x": x0, "y": y1}], **kw}


ROOM = room("r_1", 104, 64, 296, 196, name="סלון", type="living")
REG = [
    {
        "id": "r0",
        "floor": "ground",
        "polygonMm": [{"x": 0, "y": 0}, {"x": 420, "y": 0}, {"x": 420, "y": 297}, {"x": 0, "y": 297}],
        "scaleDenominator": 50,
    }
]


def text(t: str, x0: float, y0: float, x1: float, y1: float) -> SimpleText:
    return SimpleText((x0, y0, x1, y1), t, 0.9, y1 - y0)


def run(
    vs: VectorSheet,
    spans: list[SimpleText] | None = None,
    *,
    discipline: str = "construction",
    regions: Any = None,
    rooms: Any = None,
) -> dict[str, Any]:
    return analyze(
        vs,
        spans or [],
        sheet_id="s1",
        discipline=discipline,
        regions=regions or REG,
        scale_den=50,
        rooms=rooms if rooms is not None else [ROOM],
    )


def by_kind(items: list[dict[str, Any]], kind: str, key: str = "kind") -> list[dict[str, Any]]:
    return [i for i in items if i.get(key) == kind]


def measure(doc: dict[str, Any], key: str) -> dict[str, Any] | None:
    return next((m for m in doc["measures"] if m["key"] == key), None)


# ---------------------------------------------------------------------------------------------------- pure helpers
def test_colour_classes_and_lifecycle() -> None:
    assert colour_class((255, 0, 0)) == "red"
    assert colour_class((255, 255, 20)) == "yellow"
    assert colour_class((201, 201, 201)) == "neutral"
    assert colour_class((0, 221, 0)) == "green"
    assert lifecycle_of("red", "construction") == "new"
    assert lifecycle_of("yellow", "architecture_master") == "demolish"
    assert lifecycle_of("red", "demolition") == "demolish"
    assert lifecycle_of("neutral", "construction") == "existing"
    assert lifecycle_of("red", "construction", {"#ff0000": "existing"}, "#ff0000") == "existing"


def test_note_flags_and_heights() -> None:
    assert {"block", "closure", "opening"} <= L.flags_of("סגירת דלת בבלוק")
    assert {"gypsum", "double", "partition"} <= L.flags_of("מחיצת גבס דו כרומי")
    assert {"valance", "curtain", "gypsum"} <= L.flags_of("סינר גבס לוילון")
    assert {"valance", "ventilator"} <= L.flags_of("סינר לונטה")
    assert "ceiling" in L.flags_of("ה.ת H=40")
    assert "closure" in L.flags_of("סגירה הרמטית") and "opening" not in L.flags_of("סגירה הרמטית")
    assert L.height_of("קיר נמוך H=140") == 1.4
    marks = L.ceiling_marks([text("-2.55", 100, 70, 106, 72), text("220", 101, 72.4, 105, 74.2)])
    assert marks and marks[0][2] == 2.2


# ---------------------------------------------------------------------------------------------------- stairs
def stair(
    s: Sheet, x0: float, y0: float, n_lines: int, rgb: tuple[int, int, int] = RED, going: float = 5.0, width: float = 18.0
) -> Sheet:
    for k in range(n_lines):
        x = x0 + k * going
        s.line([(x, y0), (x, y0 + width)], rgb)
    return s


def test_stair_numbered_descending_counts_treads_and_moves_to_basement() -> None:
    s = house(Sheet())
    stair(s, 150, 100, 12)
    spans = [text("-11 -10 -9 -8 -7 -6", 148, 96, 180, 98), text("-5 -4 -3 -2 -1", 181, 96, 205, 98)]
    doc = run(s.build(), spans)
    new = by_kind(doc["stairs"], "new", "lifecycle")
    assert len(new) == 1
    st = new[0]
    assert st["treads"] == 11 and st["lines"] == 12 and st["numbered"] and st["descending"]
    assert st["floor"] == "basement"  # numbered below ±0.00 on the ground plan
    assert st["widthM"] == pytest.approx(0.9, abs=0.02) and st["goingM"] == pytest.approx(0.25, abs=0.01)
    assert st["level"] == "yellow"  # geometry:stair is not in the calibration table
    m = measure(doc, "stair_treads")
    assert m is not None and m["qty"] == 11 and m["floor"] == "basement" and m["computable"]


def test_stair_unnumbered_counts_gaps_existing_lifecycle() -> None:
    s = house(Sheet())
    stair(s, 150, 100, 7, BLACK)
    doc = run(s.build())
    assert len(doc["stairs"]) == 1
    st = doc["stairs"][0]
    assert st["treads"] == 6 and not st["numbered"] and st["lifecycle"] == "existing"
    assert measure(doc, "stair_treads") is None  # only new stairs are measured


def test_hatch_lines_are_not_a_stair_and_a_double_nosing_counts_once() -> None:
    s = house(Sheet())
    for k in range(6):  # tread lines drawn twice 0.3 mm apart (nosing)
        x = 150 + k * 5.0
        s.line([(x, 100), (x, 118)], BLACK).line([(x + 0.3, 100), (x + 0.3, 118)], BLACK)
    doc = run(s.build())
    assert [st["treads"] for st in doc["stairs"]] == [5]


# ---------------------------------------------------------------------------------------------------- wall runs
def test_solid_new_walls_by_label_and_thickness() -> None:
    s = house(Sheet())
    s.rect(150, 100, 230, 102)  # 4.0 m x 0.10 m, unlabelled → gypsum single
    s.rect(200, 60, 216, 64)  # 0.8 m x 0.20 m in the north wall, "סגירת דלת בבלוק"
    s.rect(120, 150, 180, 152)  # 3.0 m x 0.10 m, "מחיצת גבס דו כרומי"
    spans = [
        text("סגירת דלת", 218, 66, 230, 68.3),
        text("בבלוק", 223, 68.8, 230, 71),
        text("מחיצת גבס דו כרומי", 120, 154, 146, 156.3),
    ]
    doc = run(s.build(), spans)
    runs = doc["wallRuns"]
    gyp = by_kind(runs, "gypsum_single")
    blk = by_kind(runs, "block_new")
    dbl = by_kind(runs, "gypsum_double")
    assert (
        len(gyp) == 1
        and gyp[0]["lengthM"] == pytest.approx(4.0, rel=0.03)
        and gyp[0]["thicknessM"] == pytest.approx(0.1, abs=0.01)
    )
    assert len(blk) == 1 and blk[0]["closure"] and blk[0]["lengthM"] == pytest.approx(0.8, rel=0.05)
    assert len(dbl) == 1 and dbl[0]["lengthM"] == pytest.approx(3.0, rel=0.03)
    # no level mark, no label height: the default height, said so in the reasons, never green
    for r in runs:
        assert r["heightSource"] == "default" and r["heightM"] == 2.6
        assert any("ברירת מחדל" in x for x in r["reasons"]) and r["level"] != "green"
        assert r["areaM2"] == pytest.approx(r["lengthM"] * 2.6, rel=1e-3)
    assert measure(doc, "gypsum_partition_area")["qty"] == pytest.approx(4.0 * 2.6, rel=0.03)  # type: ignore[index]
    assert measure(doc, "block_wall_area")["qty"] == pytest.approx(0.8 * 2.6, rel=0.05)  # type: ignore[index]
    pl = measure(doc, "plaster_new_walls_area")
    assert pl is not None and not pl["computable"] and pl["estimate"]["qty"] == pytest.approx(2 * 0.8 * 2.6, rel=0.05)


def test_wall_height_from_level_mark_is_flagged_as_assumed() -> None:
    s = house(Sheet())
    s.rect(150, 100, 230, 102)
    doc = run(s.build(), [text("+2.96", 250, 150, 256, 152), text("H=265", 250, 152.4, 256, 154.2)])
    r = doc["wallRuns"][0]
    assert r["heightM"] == 2.65 and r["heightSource"] == "level_mark"
    assert any("הונח" in x for x in r["reasons"])


def test_details_beside_the_plan_are_ignored() -> None:
    s = house(Sheet())
    s.rect(20, 220, 60, 224)  # a red fill in a detail drawn far below the plan (its own wall network)
    s.rect(15, 215, 65, 216, GREY).rect(15, 228, 65, 229, GREY)
    doc = run(s.build())
    assert doc["wallRuns"] == []


def test_demolished_walls_on_a_demolition_plan() -> None:
    s = house(Sheet())
    s.rect(150, 100, 190, 104, YELLOW)  # 2.0 m x 0.2 m
    doc = run(s.build(), discipline="demolition")
    assert doc["wallRuns"] == []  # only new walls are runs
    reg = by_kind(doc["regions"], "demolished", "category")
    assert len(reg) == 1 and reg[0]["lifecycle"] == "demolish"
    assert measure(doc, "demolished_wall_length")["qty"] == pytest.approx(2.0, rel=0.05)  # type: ignore[index]


# ---------------------------------------------------------------------------------------------------- courtyard
def courtyard_sheet() -> tuple[Sheet, list[SimpleText]]:
    """A sunken courtyard north of the house: L-shaped red-hatched retaining wall (0.2 m), a red stair, yard levels."""
    s = house(Sheet())
    # retaining wall: north leg y 36..40 from x 140..240, west leg x 140..144 from y 36..60, 45° hatch every 1.8 mm
    from shapely.geometry import LineString, Polygon

    wall = Polygon([(140, 36), (240, 36), (240, 40), (144, 40), (144, 60), (140, 60)])
    for k in np.arange(-100, 300, 1.8):
        ln = LineString([(100 + k, 0), (100 + k + 100, 100)]).intersection(wall)
        for g in getattr(ln, "geoms", [ln]):
            if not g.is_empty and g.length > 0.2:
                (ax, ay), (bx, by) = g.coords[0], g.coords[-1]
                s.line([(ax, ay), (bx, by)])
    s.line([*[(float(x), float(y)) for x, y in wall.exterior.coords]], BLACK, 0.55)  # the wall's heavy outline
    stair(s, 175, 41, 12, going=5.0, width=18.0)
    spans = [
        text("-0.50", 250, 20, 256, 22),
        text("-2.57", 300, 250, 306, 252),
        text("-11 -10 -9 -8 -7 -6 -5 -4 -3 -2 -1", 173, 37, 233, 39),
    ]
    return s, spans


def test_courtyard_retaining_walls_height_from_yard_levels() -> None:
    s, spans = courtyard_sheet()
    doc = run(s.build(), spans, regions=[{**REG[0], "floor": "basement"}])
    ret = by_kind(doc["wallRuns"], "concrete_retaining")
    assert len(ret) == 1
    r = ret[0]
    assert r["thicknessM"] == pytest.approx(0.2, abs=0.03)
    assert r["lengthM"] == pytest.approx((100 - 2 + 24 - 2) / M, rel=0.08)  # centreline ≈ 5.9 m
    assert r["heightM"] == pytest.approx(2.07, abs=0.01) and r["heightSource"] == "level_mark"
    assert len(doc["courtyards"]) == 1
    cy = doc["courtyards"][0]
    assert cy["levels"] == {"topM": -0.5, "bottomM": -2.57}
    assert cy["stairId"] == doc["stairs"][0]["id"] and cy["wallRunIds"] == [r["id"]]
    kinds = {f["kind"] for f in cy["faces"]}
    assert {"retaining", "building"} <= kinds
    assert cy["floorAreaM2"] == pytest.approx((96 * 20) / (M * M), rel=0.1)
    assert measure(doc, "courtyard_waterproofing")["qty"] == 1.0  # type: ignore[index]
    assert measure(doc, "retaining_wall_area")["qty"] == pytest.approx(r["lengthM"] * 2.07, rel=1e-3)  # type: ignore[index]


# ---------------------------------------------------------------------------------------------------- ceilings, lines
def test_dashed_x_box_is_a_gypsum_ceiling() -> None:
    s = house(Sheet())
    a, b, c, d = (200, 100), (224, 100), (224, 122), (200, 122)
    for p, q in ((a, b), (b, c), (c, d), (d, a), (a, c), (b, d)):
        s.dashed(p, q)
    doc = run(s.build(), [text("ה.ת H=40", 226, 100, 240, 102.3)])
    assert len(doc["ceilings"]) == 1
    cl = doc["ceilings"][0]
    assert cl["areaM2"] == pytest.approx(24 * 22 / (M * M), rel=0.02) and cl["label"]
    assert measure(doc, "gypsum_ceiling_area")["qty"] == pytest.approx(1.32, rel=0.02)  # type: ignore[index]


def test_valances_cistern_screen_and_window_closure() -> None:
    s = house(Sheet())
    s.dashed((108, 70), (108, 190)).dashed((110, 70), (110, 190))  # double dashed curtain valance, 6.0 m
    s.line([(270, 170), (270, 186)])  # 0.8 m cistern screen
    s.line([(105, 120), (105, 144)]).line([(106.5, 120), (106.5, 144)])  # window closure, 1.2 m
    spans = [
        text("סינר גבס לוילון", 114, 90, 136, 92.3),
        text("מסתור ניאגרה", 276, 172, 292, 174),
        text("H", 280, 174.6, 281, 176.5),
        text("120", 284, 174.6, 289, 176.5),
        text("סגירה פנימית לחלון קיים בגבס", 108.5, 125, 140, 127.3),
    ]
    rooms = [ROOM, room("r_2", 262, 166, 296, 196, name="שירותים", type="wc")]
    doc = run(s.build(), spans, rooms=rooms)
    lines = {ln["kind"]: ln for ln in doc["lines"]}
    assert lines["valance_curtain"]["lengthM"] == pytest.approx(6.0, rel=0.02)
    assert lines["cistern_screen"]["lengthM"] == pytest.approx(0.8, rel=0.03) and lines["cistern_screen"]["heightM"] == 1.2
    assert lines["window_closure"]["lengthM"] == pytest.approx(1.2, rel=0.03)
    wc = measure(doc, "wc_partial_cladding_area")
    assert wc is not None and not wc["computable"] and wc["estimate"]["qty"] == pytest.approx(0.96, rel=0.05)
    win = measure(doc, "window_closure_area")
    assert win is not None and not win["computable"] and win["reason"] and win["estimate"]["qty"] == pytest.approx(1.32, rel=0.05)


def test_unlabelled_highlight_lines_are_dropped() -> None:
    s = house(Sheet())
    s.dashed((150, 120), (250, 120))
    doc = run(s.build())
    assert doc["lines"] == [] and doc["ceilings"] == []


# ---------------------------------------------------------------------------------------------------- doc / project
def test_document_shape_ids_and_contract() -> None:
    s, spans = courtyard_sheet()
    s.rect(150, 100, 230, 102)
    doc = run(s.build(), spans, regions=[{**REG[0], "floor": "basement"}])
    assert doc["schema"] == GEOMETRY_SCHEMA and doc["sheetId"] == "s1"
    ids = [i["id"] for k in ("stairs", "regions", "wallRuns", "lines", "ceilings", "courtyards") for i in doc[k]]
    assert len(ids) == len(set(ids)) and all(not i.startswith("_") for i in ids)
    for k in ("stairs", "regions", "wallRuns", "lines", "ceilings", "courtyards", "measures"):
        for it in doc[k]:
            assert it["level"] in ("yellow", "red") and it["reasons"], (k, it)
    json.dumps(doc)  # serialisable
    if not SCHEMA.exists():
        pytest.skip("contracts json-schema not generated")
    import jsonschema

    jsonschema.validate(doc, json.loads(SCHEMA.read_text(encoding="utf-8")))


def test_geometry_units_authority_dedupe_and_missing_keys() -> None:
    s, spans = courtyard_sheet()
    vs = s.build()
    reg = [{**REG[0], "floor": "basement"}]
    cons = analyze(vs, spans, sheet_id="cons", discipline="construction", regions=reg, scale_den=50, rooms=[ROOM])
    master = analyze(vs, spans, sheet_id="mast", discipline="architecture_master", regions=reg, scale_den=50, rooms=[ROOM])
    # the same stair seen from the ground plan (numbered below ±0.00 → basement)
    ground = analyze(vs, spans, sheet_id="grnd", discipline="construction", regions=REG, scale_den=50, rooms=[ROOM])
    units = {u["key"]: u for u in geometry_units([master, cons, ground])}
    assert set(units) == set(KEYS)
    assert units["stair_treads"]["qty"] == 11 and units["stair_treads"]["byFloor"] == {"basement": 11.0}
    ret = units["retaining_wall_area"]
    assert ret["computable"] and "mast" not in {r["sheetId"] for r in ret["refs"]}  # construction wins, not summed
    assert not units["kitchen_backsplash_area"]["computable"] and units["kitchen_backsplash_area"]["reason"]
    assert units["kitchen_backsplash_area"]["level"] == "red"


def test_unnumbered_view_of_a_numbered_stair_is_not_counted_twice() -> None:
    s, spans = courtyard_sheet()
    vs = s.build()
    reg = [{**REG[0], "floor": "basement"}]
    numbered = analyze(vs, spans, sheet_id="a", discipline="construction", regions=reg, scale_den=50, rooms=[ROOM])
    bare = analyze(vs, [], sheet_id="b", discipline="architecture_master", regions=REG, scale_den=50, rooms=[ROOM])
    assert bare["stairs"][0]["treads"] == 11 and not bare["stairs"][0]["numbered"]
    u = {x["key"]: x for x in geometry_units([numbered, bare])}["stair_treads"]
    assert u["qty"] == 11


def test_orchestrator_ceiling_caps_green_geometry_items() -> None:
    s = house(Sheet())
    s.rect(150, 100, 230, 102)
    doc = run(s.build())
    doc["wallRuns"][0]["level"] = "green"
    doc["wallRuns"][0]["reasons"] = []
    table = CalibrationTable(
        "t", "conservative", "now", None, {"room": ClassStats(n=1, tp=1, fp=0, precision=1.0, wilson_lb=1.0, green_allowed=True)}
    )
    assert cap_document("geometry", doc, table) == 1
    assert doc["wallRuns"][0]["level"] == "yellow" and doc["wallRuns"][0]["reasons"]


def test_garbage_input_never_raises() -> None:
    doc = analyze(
        Sheet().build(),
        [],
        sheet_id="x",
        discipline="construction",
        regions=[],
        scale_den=None,
        rooms=[{"id": "r", "polygonMm": []}],
    )
    assert doc["stairs"] == [] and doc["measures"] == []


# ---------------------------------------------------------------------------------------------------- Noah sample
ROOTS = [
    Path("/home/claude/kamutan-data/acceptance/s6-geometry/artifacts"),
    Path(os.environ.get("KAMUTAN_DEV_ARTIFACTS", "/home/claude/kamutan-data/artifacts")),
]


def _noah_docs() -> list[dict[str, Any]]:
    from kamutan_drawing.pipeline.artifacts import decode_primitives, decode_text
    from kamutan_drawing.types_sprint2 import text_items_from_json, vector_sheet_from_primitives

    root = next((r for r in ROOTS if (r / "dev-index.json").exists()), None)
    if root is None:
        pytest.skip("no local Noah artifacts")
    out = []
    for e in json.loads((root / "dev-index.json").read_text(encoding="utf-8")):
        if e.get("discipline") not in ("construction", "architecture_master", "demolition"):
            continue
        prim = decode_primitives((root / e["primitives"]).read_bytes())
        rooms_rel = (e.get("artifacts") or {}).get("rooms")
        rooms = json.loads(gzip.decompress((root / rooms_rel).read_bytes()))["rooms"] if rooms_rel else []
        out.append(
            analyze(
                vector_sheet_from_primitives(prim),
                text_items_from_json(decode_text((root / e["text"]).read_bytes())["lines"]),
                sheet_id=e["sheetId"],
                discipline=e["discipline"],
                regions=e["regions"],
                scale_den=e["scaleDenominator"],
                rooms=rooms,
                text_paths=set(prim.get("textPaths") or []),
            )
        )
    if not out:
        pytest.skip("no plan sheets in the local artifacts")
    return out


@pytest.fixture(scope="module")
def noah_units() -> dict[str, dict[str, Any]]:
    return {u["key"]: u for u in geometry_units(_noah_docs())}


def test_noah_targets(noah_units: dict[str, dict[str, Any]]) -> None:
    """Noah: the quantities the drawings give (gt-v0.6-draft s6_lines.md), none green."""
    u = noah_units
    assert u["stair_treads"]["qty"] == 11 and u["stair_treads"]["byFloor"] == {"basement": 11.0}  # 5.04, drawn on 4 sheets
    assert u["retaining_wall_area"]["qty"] == pytest.approx(10.6, rel=0.15)  # 2.01 (BOQ 11)
    assert u["block_wall_area"]["qty"] == pytest.approx(2.0, rel=0.15)  # 2.03
    assert u["gypsum_ceiling_area"]["qty"] == pytest.approx(3.4, rel=0.1)  # 7.01 (BOQ 4)
    assert u["valance_ventilator_length"]["qty"] == pytest.approx(4.27, rel=0.03)  # 7.02
    assert u["valance_curtain_length"]["qty"] == pytest.approx(6.41, rel=0.03)  # 7.05 (BOQ 7)
    assert u["gypsum_partition_area"]["qty"] == pytest.approx(30.0, rel=0.15)  # 7.06 (BOQ 35.2)
    assert u["gypsum_double_partition_area"]["qty"] == pytest.approx(7.5, rel=0.1)  # 7.07
    assert u["courtyard_waterproofing"]["qty"] == 1.0  # 5.08
    assert u["window_closure_area"]["estimate"]["qty"] == pytest.approx(1.5, rel=0.2)  # 7.03 (width 1.2 m drawn)
    assert u["wc_partial_cladding_area"]["estimate"]["qty"] == pytest.approx(1.0, rel=0.1)  # 5.07 (BOQ 1.2)
    assert u["plaster_new_walls_area"]["estimate"]["qty"] == pytest.approx(22.0, rel=0.1)  # 8.02
    assert not u["kitchen_backsplash_area"]["computable"]  # 5.06 not on the drawings
    assert all(x["level"] != "green" for x in u.values())


# ---------------------------------------------------------------------------------------------------- understand hook
def test_understand_writes_and_reports_the_geometry_artifact(tmp_path: Path) -> None:
    from kamutan_drawing.ocr.dictionary import TextSpan
    from kamutan_drawing.pipeline.understand import GEOMETRY_FILE, understand

    s = house(Sheet())
    stair(s, 150, 100, 12)
    s.rect(150, 150, 230, 152)
    spans = [TextSpan("s1", (148, 96, 205, 98), "-11 -10 -9 -8 -7 -6 -5 -4 -3 -2 -1", 0.9, 2.0, 0, 30)]
    res = understand(
        s.build(), spans, sheet_id="s1", discipline="construction", scale_den=50, regions=REG, text_paths=set(),
        out_dir=tmp_path, detect=False, links=False, fixtures=False, text_items=False,
    )  # fmt: skip
    assert res["geometryFile"] == GEOMETRY_FILE and res["geometryStats"]["stairs"] == 1
    doc = json.loads(gzip.decompress((tmp_path / GEOMETRY_FILE).read_bytes()))
    assert doc["schema"] == GEOMETRY_SCHEMA and doc["stairs"][0]["treads"] == 11
    # MEP sheets get none
    res2 = understand(
        s.build(), spans, sheet_id="s2", discipline="electrical", scale_den=50, regions=REG, text_paths=set(),
        out_dir=tmp_path / "e", detect=False, links=False, fixtures=False, text_items=False,
    )  # fmt: skip
    assert "geometryFile" not in res2
