"""Sprint 6 (Worker-Text): text & equipment items — normalisation, quantities, extraction, conduit runs, BOQ units,
the understand hook, the orchestrator upload and the Noah sample (skipped without the local artifacts)."""

from __future__ import annotations

import itertools
import json
import math
from pathlib import Path
from typing import Any

import jsonschema
import numpy as np
import pytest

from kamutan_drawing.calibration import fallback_table
from kamutan_drawing.ingest.pdf_vector import SEG_LINE, VectorSheet
from kamutan_drawing.pipeline.ceiling import cap_document
from kamutan_drawing.textitems import CATALOG, SCHEMA, entry_to_rule, extract, from_version_dir
from kamutan_drawing.textitems.boq import qty_by_code, text_units
from kamutan_drawing.textitems.conduits import find_runs
from kamutan_drawing.textitems.normalize import compile_pattern, detail_refs, is_detail_title, normalize
from kamutan_drawing.textitems.qty import count_in_text, length_in_text_m, lifecycle_of

CONTRACTS = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "json-schema"
ROOT = Path("/home/claude/kamutan-data/acceptance/fix-accuracy/after/artifacts/orgs/org-demo/projects/p-noah/sheets")


# ----------------------------------------------------------------------------------------------- helpers
def ln(text: str, x0: float, y0: float, w: float = 15.0, h: float = 2.0, conf: float = 0.9, angle: float = 0.0) -> dict[str, Any]:
    return {"text": text, "bboxMm": [x0, y0, x0 + w, y0 + h], "angle": angle, "confidence": conf, "heightMm": h}


REG = [
    {
        "id": "r0",
        "floor": "basement",
        "polygonMm": [{"x": 0, "y": 0}, {"x": 200, "y": 0}, {"x": 200, "y": 140}, {"x": 0, "y": 140}],
    },
    {
        "id": "r1",
        "floor": "first",
        "polygonMm": [{"x": 0, "y": 150}, {"x": 200, "y": 150}, {"x": 200, "y": 290}, {"x": 0, "y": 290}],
    },
]


def items_of(doc: dict[str, Any], code: str) -> list[dict[str, Any]]:
    return [i for i in doc["items"] if i["itemCode"] == code]


def counted(doc: dict[str, Any], code: str) -> float:
    return sum(float(i["qty"] or 0) for i in items_of(doc, code))


def vsheet(
    paths: list[list[tuple[float, float]]], *, closed: list[bool] | None = None, rgb: tuple[int, int, int] = (0, 0, 0)
) -> VectorSheet:
    """Minimal VectorSheet: one polyline path per point list (straight pieces)."""
    segs, seg_path, starts, counts, bboxes = [], [], [], [], []
    for i, pts in enumerate(paths):
        starts.append(len(segs))
        for (x0, y0), (x1, y1) in itertools.pairwise(pts):
            segs.append((x0, y0, x1, y1))
            seg_path.append(i)
        counts.append(len(pts) - 1)
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        bboxes.append((min(xs), min(ys), max(xs), max(ys)))
    n = len(paths)
    return VectorSheet(
        page_index=0,
        width_mm=420.0,
        height_mm=297.0,
        path_stroke_rgba=np.array([[*rgb, 255]] * n, np.uint8),
        path_fill_rgba=np.zeros((n, 4), np.uint8),
        path_stroked=np.ones(n, bool),
        path_fill_mode=np.zeros(n, np.int8),
        path_width_mm=np.full(n, 0.21, np.float32),
        path_dash=[() for _ in range(n)],
        path_closed=np.array(closed or [False] * n, bool),
        path_bbox=np.array(bboxes, np.float32),
        path_seg_start=np.array(starts, np.int32),
        path_seg_count=np.array(counts, np.int32),
        segs=np.array(segs, np.float32).reshape(-1, 4),
        seg_path=np.array(seg_path, np.int32),
        seg_kind=np.full(len(segs), SEG_LINE, np.int8),
        curves=np.zeros((0, 8), np.float32),
        curve_path=np.zeros(0, np.int32),
    )


def circle(cx: float, cy: float, r: float = 0.5, n: int = 16) -> list[tuple[float, float]]:
    return [(cx + r * math.cos(2 * math.pi * k / n), cy + r * math.sin(2 * math.pi * k / n)) for k in range(n + 1)]


def arc(a: tuple[float, float], z: tuple[float, float], bulge: float = 6.0, n: int = 40) -> list[tuple[float, float]]:
    """A smooth curve from a to z (quadratic bezier sampled into n pieces)."""
    mx, my = (a[0] + z[0]) / 2, (a[1] + z[1]) / 2
    dx, dy = z[0] - a[0], z[1] - a[1]
    L = math.hypot(dx, dy)
    c = (mx - dy / L * bulge, my + dx / L * bulge)
    out = []
    for k in range(n + 1):
        t = k / n
        out.append(
            (
                (1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * z[0],
                (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * z[1],
            )
        )
    return out


# ------------------------------------------------------------------------------------------- normalisation
def test_normalize_folds_finals_quotes_and_spaces():
    assert normalize("נק׳  קיימת") == "נק' קיימת"
    assert normalize("קנ״מ") == 'קנ"מ'
    assert normalize("שישה שקעים") == "שישה שקעימ"
    assert compile_pattern("שישה שקעים").search(normalize("שישה   שקעים"))
    # a space in a pattern also spans a note's line join (" / ")
    assert compile_pattern("הזנה לונטה").search(normalize("הזנה / לונטה"))


def test_detail_references_tolerate_shx_slips_but_not_other_words():
    assert [r[0] for r in detail_refs("פרט A")] == ["a"]
    assert [r[0] for r in detail_refs("פרט ץ")] == ["a"]  # Latin A read as ץ
    assert [r[0] for r in detail_refs("א.קוברה סךט א")] == ["a"]  # פ→ס, ר→ך
    assert detail_refs("פרט קונסטרוקטור") == [] and detail_refs('ע"פ פרט') == [] and detail_refs("+פרט איטום") == []
    assert is_detail_title('פרט א קנ"מ 1:20') and not is_detail_title("פרט A")


# ------------------------------------------------------------------------------------------- quantities
@pytest.mark.parametrize(
    ("text", "n"),
    [("שקע x2", 2), ("2X", 2), ("3א", 3), ("שני שקעי כח למכונת כביסה", 2), ("שישה שקעים", 6), ("4 יח'", 4), ("מפסק לתנור", None)],
)
def test_count_in_text(text, n):
    assert count_in_text(text) == n


@pytest.mark.parametrize(
    ("text", "m"),
    [
        ("צינור קוברה 50 מ\"מ באורך 1.5 מ'", 1.5),
        ("באורך 3.5 מ' למקרן", 3.5),
        ('אורך 150 ס"מ', 1.5),
        ("L=2.4מ'", 2.4),
        ("H=160", None),
    ],
)
def test_length_in_text(text, m):
    assert length_in_text_m(text) == m


def test_lifecycle_qualifiers():
    assert lifecycle_of("מפסק דוד קיים / להחליף לטיימר") == "replace"
    assert lifecycle_of("להוסיף מחלף") == "add"
    assert lifecycle_of("נק' קיימת") == "existing"
    assert lifecycle_of("פירוק מטבח קיים") == "demolish"
    assert lifecycle_of("גוף חדש") == "new" and lifecycle_of("שקע כוח") is None


# ------------------------------------------------------------------------------------------- extraction
def _electrical_basement() -> dict[str, Any]:
    lines = [
        ln("לוח חשמל+מונה", 116, 111, 23),  # 0  → 4.24 (corroborates the panel detection)
        ln("לוח תקשורת", 121, 113.3, 18),  # 1  → 4.25
        ln("מפסק טיימר", 123, 117.4, 16),  # 2  → 4.23 switch
        ln("לדוד חשמל", 123, 119.6, 16),  # 3
        ln("מפסק לונטה", 116, 131, 23),  # 4  → 4.19 switch (+ 9.03)
        ln("הזנה", 91, 142.2 - 30, 7),  # 5  → 4.19 feed
        ln("לונטה", 91, 144.4 - 30, 7),  # 6
        ln("הזנה לדוד", 16, 60, 15),  # 7  → 4.23 feed
        ln("פעמון", 132, 39, 7),  # 8  → 4.22 push-button
        ln("פעמון", 127, 42.5, 8),  # 9  → 4.22 bell (same item)
        ln("מעל הדלת", 120, 45, 15),  # 10
        ln("הכנה לשקע", 230, 20, 30),  # 11 → NOT 4.25 (socket inside an existing panel)
        ln("בתוך לוח תקשורת", 230, 22.5, 30),  # 12
        ln("16 גוף תלוי פעמון מיני", 260, 192 - 120, 30),  # 13 → NOT 4.22 (luminaire type)
        ln("פרט A", 80, 160, 8),  # 14 → 4.06 via the detail box (first floor)
        ln("פרט A", 30, 200, 8),  # 15 → 4.06
        ln('פרט א קנ"מ 1:20', 273, 77, 20),  # 16 detail title — not counted
        ln("שישה שקעים", 275, 95, 14),  # 17 detail content
        ln("נקודת רשת", 276, 98, 13),  # 18
        ln("מפסק דוד קיים", 107, 200, 22),  # 19 → 4.26 (two lines, one item)
        ln("להחליף לטיימר", 107, 202.3, 22),  # 20
        ln("מפסק לתנור", 122, 125, 17),  # 21 → 4.17 corroborating
    ]
    return extract(lines, sheet_id="s-elec", discipline="electrical", regions=REG)


def test_extract_counts_pairs_and_traps():
    doc = _electrical_basement()
    assert doc["schema"] == SCHEMA and doc["sheetId"] == "s-elec"
    assert counted(doc, "4.19") == 1  # feed + switch = one ventilator feed
    (feed,) = [i for i in items_of(doc, "4.19") if i["role"] == "feed"]
    (sw,) = [i for i in items_of(doc, "4.19") if i["role"] == "switch"]
    assert sw["qty"] == 0 and sw["pairedWith"] == feed["id"] and feed["qty"] == 1
    assert counted(doc, "4.23") == 1 and {i["role"] for i in items_of(doc, "4.23")} == {"feed", "switch"}
    assert counted(doc, "4.22") == 1 and len(items_of(doc, "4.22")) == 2  # bell + button grouped; "פעמון מיני" not matched
    assert counted(doc, "4.25") == 1  # "בתוך לוח תקשורת" is excluded
    assert counted(doc, "4.24") == 1 and all(i["corroborates"] for i in items_of(doc, "4.24"))
    assert counted(doc, "4.26") == 1 and items_of(doc, "4.26")[0]["lifecycle"] == "replace"
    assert counted(doc, "4.06") == 2  # two references; the detail box itself is not an item
    ref = items_of(doc, "4.06")[0]
    assert ref["kind"] == "detail_ref" and "שישה שקעימ" in ref["normalized"]
    assert not any('קנ"מ' in i["text"] for i in doc["items"] if i["matchedPattern"])
    assert counted(doc, "9.03") == 1 and items_of(doc, "9.03")[0]["suggested"]
    assert counted(doc, "4.17") == 1 and items_of(doc, "4.17")[0]["corroborates"]
    # floors from the regions, lineIdx into text.json lines, never green, reasons on every item
    assert {i["floor"] for i in items_of(doc, "4.06")} == {"first"}
    assert items_of(doc, "4.25")[0]["lineIdx"] == [1]
    assert all(i["level"] in ("yellow", "red") and i["reasons"] for i in doc["items"])
    assert doc["stats"]["byCode"]["4.19"] == 1


def test_extract_respects_disciplines_and_legend_rows():
    lines = [
        ln("צינור גז 1 מ'", 268, 110, 19),
        ln("חופשי מהריצפה", 265, 113, 22),
        ln("תנור חימום לחדר רחצה", 17, 262, 28),  # legend row
        ln("צינורות חופשיים", 200, 79.5, 24),
        ln("מהריצפה:", 211, 82.4, 13),
    ]
    legend = [(10.0, 250.0, 100.0, 270.0)]
    plumb = extract(lines, sheet_id="p", discipline="plumbing", regions=REG, legend_boxes=legend)
    assert counted(plumb, "4.08") == 0
    elec = extract(lines, sheet_id="e", discipline="electrical", regions=REG, legend_boxes=legend)
    assert counted(elec, "4.08") == 1  # the gas pipe note is excluded by its own words, the island note counts once
    rows = [i for i in elec["items"] if i["kind"] == "legend_row"]
    assert rows and not any(i["matchedPattern"] for i in rows)


def test_extract_skips_title_block_and_validates_against_contract():
    lines = [ln("בית משפחת לקוח", 391, 277, 26), ln("אינטרקום", 126, 56, 13)]
    doc = extract(lines, sheet_id="s", discipline="electrical", regions=REG, title_block=(214.0, 270.0, 415.0, 296.0))
    assert all("משפחת" not in i["text"] for i in doc["items"])
    assert counted(doc, "4.18") == 1
    schema_file = CONTRACTS / "TextItemsArtifact.json"
    if schema_file.exists():
        jsonschema.validate(_electrical_basement(), json.loads(schema_file.read_text(encoding="utf-8")))


def test_per_floor_entries_fold_on_one_sheet():
    lines = [ln("מפסק לונטה", 10, 10, 15), ln("הזנה לונטה", 60, 60, 15), ln("סינר לונטה", 100, 200, 15)]
    doc = extract(lines, sheet_id="s", discipline="electrical", regions=REG)
    duct = items_of(doc, "9.03")
    assert sorted((i["floor"], i["qty"]) for i in duct) == [("basement", 0.0), ("basement", 1.0), ("first", 1.0)]
    assert all(i["dedupe"] == "floor" for i in duct)


def test_catalog_patterns_compile_and_mirror_as_rules():
    for e in CATALOG:
        for p in (*e.patterns, *e.exclude, *e.feed_patterns, *e.switch_patterns):
            compile_pattern(p)
            assert "\\S" not in p and "\\D" not in p and "(?P" not in p
        r = entry_to_rule(e)
        assert r["kind"] == "text_item" and r["itemCode"] == e.item_code and r["match"]["patterns"]


# ------------------------------------------------------------------------------------------- conduit runs
def _conduit_sheet() -> VectorSheet:
    run1 = arc((20.0, 100.0), (20.0, 50.0))  # circles at both ends
    run2 = arc((60.0, 100.0), (110.0, 70.0))  # one circle (floor box) only
    door = [(150.0, 50.0), (150.0, 60.0), (160.0, 60.0)] * 5  # kinked, no circles
    return vsheet([run1, circle(20.0, 100.5), circle(20.0, 49.5), run2, circle(60.0, 100.5), door])


def test_find_runs_needs_circles_and_smoothness():
    runs = find_runs(_conduit_sheet())
    assert [r.path for r in runs] == [0, 3]
    assert runs[0].circled == (True, True) and runs[1].circled == (True, False)
    assert 50 < runs[0].length_mm < 60
    assert [r.path for r in find_runs(_conduit_sheet(), one_circle_ok=False)] == [0]
    assert find_runs(_conduit_sheet(), exclude=[(0.0, 0.0, 200.0, 200.0)]) == []
    grey = vsheet([arc((20.0, 100.0), (20.0, 50.0)), circle(20.0, 100.5)], rgb=(152, 152, 152))
    assert find_runs(grey) == []  # furniture-grey curves are not conduits


def test_conduit_items_projector_and_legend_condition():
    vs = _conduit_sheet()
    lines = [ln("קוברה+", 100, 64, 10), ln("שקע בתקרה", 98, 66.2, 12), ln("למקרן", 102, 68.4, 8)]
    doc = extract(
        lines, sheet_id="e", discipline="electrical", vs=vs, regions=REG, legend_labels=['צינור קוברה 50 מ"מ'], scale_den=50
    )
    runs = [i for i in doc["items"] if i["kind"] == "conduit"]
    assert sorted(i["itemCode"] for i in runs) == ["4.20", "4.27"]
    proj = next(i for i in runs if i["itemCode"] == "4.27")
    assert not proj["corroborates"] and proj["qty"] == 1 and proj["lengthM"] > 2.0
    assert not next(i for i in runs if i["itemCode"] == "4.20")["corroborates"]  # runs are counted from text items
    none = extract(lines, sheet_id="e", discipline="electrical", vs=vs, regions=REG, legend_labels=["שקע בודד"])
    assert not [i for i in none["items"] if i["kind"] == "conduit"]


# ------------------------------------------------------------------------------------------- BOQ units
def test_text_units_dedupe_floors_across_sheets_and_skip_evidence_only():
    a = extract(
        [ln("מפסק לונטה", 10, 10, 15), ln("הזנה לונטה", 60, 60, 15)], sheet_id="elec", discipline="electrical", regions=REG
    )
    b = extract([ln("סינר לונטה", 10, 20, 15)], sheet_id="arch", discipline="construction", regions=REG)
    c = extract([ln("שקע תלת פאזי", 10, 20, 20)], sheet_id="elec2", discipline="electrical", regions=REG)
    units = text_units([a, b, c])
    q = qty_by_code(units)
    assert q == {"4.19": 1.0, "9.03": 1.0}  # 4.21 corroborates only; the ventilator on two sheets is one
    duct = next(u for u in units if u["itemCode"] == "9.03")
    assert duct["origin"] == "suggested" and {e["sheetId"] for e in duct["evidence"]} == {"elec", "arch"}
    vent = next(u for u in units if u["itemCode"] == "4.19")
    assert len(vent["evidence"]) == 2  # the feed and its folded switch
    assert qty_by_code(text_units([a, b, c], include_corroborating=True))["4.21"] == 1.0
    assert text_units([a, b, c], codes=["4.19"])[0]["itemCode"] == "4.19"


def test_ceiling_caps_text_items():
    doc = {"schema": SCHEMA, "items": [{"id": "t_1", "itemCode": "4.19", "level": "green", "reasons": [], "scoreRaw": 0.99}]}
    assert cap_document("text_items", doc, fallback_table()) == 1
    assert doc["items"][0]["level"] == "yellow" and doc["items"][0]["reasons"]


# ------------------------------------------------------------------------------------------- Noah sample
@pytest.mark.skipif(not ROOT.exists(), reason="needs the local Noah artifacts")
def test_noah_sample_lines():
    docs = [
        from_version_dir(p / "versions" / "v1", sheet_id=p.name)
        for p in sorted(ROOT.iterdir())
        if (p / "versions" / "v1" / "version.json").exists()
    ]
    q = qty_by_code(text_units(docs))
    assert q == {
        "4.06": 4.0,
        "4.08": 1.0,
        "4.19": 1.0,
        "4.20": 5.0,
        "4.25": 1.0,
        "4.26": 1.0,
        "4.27": 1.0,
        "4.28": 1.0,
        "5.08": 1.0,
        "9.03": 1.0,
    }
    ev = qty_by_code(text_units(docs, include_corroborating=True))
    for code, n in {"3.15": 1, "4.12": 3, "4.17": 3, "4.18": 1, "4.21": 3, "4.22": 1, "4.23": 1, "4.24": 1}.items():
        assert ev[code] == n, code
    assert next(u for u in text_units(docs) if u["itemCode"] == "4.28")["suggested"]
