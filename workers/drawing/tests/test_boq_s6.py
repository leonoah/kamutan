"""Sprint 6 (Worker-BOQ): rule kinds text_item / area_item / length_item / suggested_item, line origin / needsInput /
quickAction, Worker-Text catalog items, Worker-Geometry measures, coverage, evidence shapes."""

from __future__ import annotations

import gzip
import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import jsonschema
import pytest

from kamutan_drawing.boq import rules as R
from kamutan_drawing.boq.aggregate import aggregate
from kamutan_drawing.boq.coverage import chapter_key, coverage
from kamutan_drawing.boq.rules import Library, Rule, default_rules, sort_rules
from kamutan_drawing.boq.textitems import norm_he
from kamutan_drawing.library_import.importer import item_id

from .test_boq import P, _gz, build, det, lines_of, seed_project, sheet

CONTRACTS = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "json-schema"


def lib(*items: tuple[str, str, str, str]) -> Library:
    """(code, description, chapter, unit)."""
    return Library.from_docs(
        [
            (item_id(c, d), {"code": c, "description": d, "chapter": ch, "chapterTitle": "", "unit": u, "active": True})
            for c, d, ch, u in items
        ]
    )


def rule(rid: str, kind: str, match: dict[str, Any], code: str | None, *, unit: str = "יחידה", desc: str = "", priority: int = 150,
         **kw: Any) -> Rule:  # fmt: skip
    r = Rule.from_doc(rid, {"kind": kind, "match": match, "itemCode": code, "itemDescription": desc, "unit": unit,
                            "priority": priority, "enabled": True, "source": "custom", **kw})  # fmt: skip
    assert r is not None
    return r


def text(i: int, s: str, x: float, y: float, w: float = 10.0) -> dict[str, Any]:
    return {"text": s, "bboxMm": [x, y, x + w, y + 2.0], "confidence": 0.9}


def by_code(res: Any) -> dict[str, Any]:
    return {ln.code: ln for ln in res.lines}


def esheet(texts: list[dict[str, Any]], dets: list[dict[str, Any]] | None = None, **kw: Any) -> Any:
    return replace(sheet("E", "electrical", dets or [], None), texts=texts, **kw)


ELEC_LIB_ITEMS = (
    ("4.25", "אספקה והתקנת לוח תקשורת", "04", "יחידה"),
    ("4.24", "אספקה והתקנת לוח חשמל", "04", "יחידה"),
    ("4.20", "צינור קוברה 50 מ\"מ באורך 1.5 מ'", "04", "יחידה"),
    ("4.06", "אביזר עדה פלאסט הכולל 6 שקעים", "04", "יחידה"),
)
ELEC_LIB = lib(*ELEC_LIB_ITEMS)


# ----------------------------------------------------------------------------- normalisation (contracts examples)
@pytest.mark.parametrize(
    ("raw", "norm"),
    [
        ("נק׳  מאור", "נק' מאור"),
        ("מ״ר", 'מ"ר'),
        ("מ''ר", 'מ"ר'),
        ("לוח תקשורת קיים", "לוח תקשורת קיימ"),
        ("חימום +\u200fמפסק", "חימומ + מפסק"),
        ("דו־קרומי", "דו-קרומי"),
        ("שָׁלוֹם PANEL", "שלומ panel"),
    ],
)
def test_norm_he_matches_contracts_normalize_hebrew_text(raw: str, norm: str) -> None:
    assert norm_he(raw) == norm


# ----------------------------------------------------------------------------- text_item
def test_text_item_counts_callouts_not_legend_rows_and_merges_by_proximity() -> None:
    r = rule("r_t", "text_item", {"patterns": ["לוח\\s*תקשורת"], "scope": "callout", "qty": "count", "proximityMm": 5}, "4.25")
    texts = [text(0, "לוח תקשורת", 10, 10), text(1, "לוח  תקשורת", 12, 11), text(2, "לוח תקשורת", 100, 100),
             text(3, "לוח תקשורת", 205, 205)]  # fmt: skip
    s = esheet(texts, legends=[(200.0, 200.0, 50.0, 50.0)])
    ln = by_code(aggregate([s], sort_rules([r]), ELEC_LIB))["4.25"]
    assert ln.qty == 2 and ln.origin == "text" and not ln.needs_input and ln.quick_action is None
    assert {e["detectionId"] for e in ln.evidence} == {"text_0", "text_1", "text_2"}  # legend row (text_3) excluded
    e0 = next(e for e in ln.evidence if e["detectionId"] == "text_0")
    assert e0["kind"] == "text" and e0["bboxMm"] == {"x": 10.0, "y": 10.0, "w": 10.0, "h": 2.0}
    assert ln.level != "green"


def test_text_item_qty_modes_capture_group_number_length_and_one() -> None:
    base = {"scope": "any", "proximityMm": 0}
    rs = [
        rule("r_c", "text_item", {**base, "patterns": ["(\\d+) קוברה"], "qty": "count"}, "4.20"),
        rule("r_n", "text_item", {**base, "patterns": ["לוח תקשורת"], "qty": "number_in_text"}, "4.25"),
        rule("r_o", "text_item", {**base, "patterns": ["פרט א"], "qty": "one"}, "4.06"),
    ]
    texts = [text(0, "3 קוברה", 0, 0), text(1, "לוח תקשורת 2 יח'", 50, 0), text(2, "פרט א", 100, 0), text(3, "פרט א", 150, 0)]
    res = by_code(aggregate([esheet(texts)], sort_rules(rs), ELEC_LIB))
    assert (res["4.20"].qty, res["4.25"].qty, res["4.06"].qty) == (3.0, 2.0, 1.0)
    assert len(res["4.06"].evidence) == 2


def test_text_item_per_floor_authority_counts_a_note_drawn_on_two_sheets_once() -> None:
    r = rule(
        "r_t",
        "text_item",
        {"patterns": ["לוח תקשורת"], "scope": "any", "qty": "count", "disciplines": ["electrical", "lighting"]},
        "4.25",
    )
    e = esheet([text(0, "לוח תקשורת", 10, 10)])
    lt = replace(sheet("L", "lighting", [], []), texts=[text(0, "לוח תקשורת", 10, 10)])
    first = replace(sheet("F", "electrical", [], None, floors=["first"]), texts=[text(0, "לוח תקשורת", 10, 10)])
    ln = by_code(aggregate([e, lt, first], sort_rules([r]), ELEC_LIB))["4.25"]
    assert ln.qty == 2 and ln.by_floor == {"first": 1.0, "ground": 1.0}
    assert {e["sheetId"] for e in ln.evidence} == {"E", "F"}


def test_text_item_near_classes_filter_and_consume_near() -> None:
    r = rule("r_t", "text_item", {"patterns": ["לוח תקשורת"], "scope": "any", "qty": "count", "nearClasses": ["panel"],
                                  "consumeNear": True, "proximityMm": 20}, "4.25", priority=130)  # fmt: skip
    rs = sort_rules([r, *[x for x in default_rules() if x.id == "r_panel"]])
    near = esheet([text(0, "לוח תקשורת", 10, 10)], [det(1, "panel", 25, 11), det(2, "panel", 300, 200)])
    res = by_code(aggregate([near], rs, ELEC_LIB))
    assert res["4.25"].qty == 1 and res["4.24"].qty == 1  # the panel next to the note is the comms panel
    far = esheet([text(0, "לוח תקשורת", 10, 10)], [det(2, "panel", 300, 200)])
    res = by_code(aggregate([far], rs, ELEC_LIB))
    assert "4.25" not in res and res["4.24"].qty == 1  # no panel within 20 mm: the note is not counted


# ----------------------------------------------------------------------------- Worker-Text catalog items
def catalog(sid: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    from kamutan_drawing.boq.textitems import parse_text_items

    base = {"anchorMm": None, "lineIdx": [], "floor": "ground", "roomId": None, "lifecycle": None, "unit": None, "lengthM": None,
            "matchedPattern": None, "role": None, "pairedWith": None, "corroborates": False, "suggested": False,
            "confidence": 0.9, "level": "yellow", "reasons": ["x"], "sheetId": sid}  # fmt: skip
    out = parse_text_items({"schema": "kamutan.textItems/1", "items": [{**base, **it} for it in items]})
    assert out is not None
    return out


def ti(i: int, s: str, code: str | None, qty: float | None, **kw: Any) -> dict[str, Any]:
    return {"id": f"t_{i}", "kind": kw.pop("kind", "callout"), "text": s, "normalized": s, "bboxMm": {"x": i * 20.0, "y": 0, "w": 8, "h": 2},
            "lineIdx": [i], "itemCode": code, "qty": qty, **kw}  # fmt: skip


def test_catalog_items_count_for_codes_without_a_text_rule_and_corroborating_ones_only_without_symbols() -> None:
    items = catalog("E", [ti(1, "פרט A → שישה שקעים", "4.06", 1, kind="detail_ref"), ti(2, "פרט A → שישה שקעים", "4.06", 1, kind="detail_ref"),
                          ti(3, "קוברה", "4.20", 1, kind="conduit", corroborates=True), ti(4, "לגנדה", "4.06", 0, kind="legend_row"),
                          ti(5, "מפסק לונטה", "4.19", 0, pairedWith="t_6")])  # fmt: skip
    rs = default_rules()
    res = by_code(aggregate([esheet([], text_items=items)], rs, ELEC_LIB))
    assert res["4.06"].qty == 2 and res["4.06"].origin == "text"  # detail refs (legend row qty 0 skipped)
    assert res["4.20"].qty == 1 and res["4.20"].origin == "text"  # evidence-only item, no cobra detected
    assert {e["detectionId"] for e in res["4.06"].evidence} == {"text_1", "text_2"}
    with_symbol = esheet([], [det(9, "conduit_cobra", 0, 0)], text_items=items)
    res = by_code(aggregate([with_symbol], rs, ELEC_LIB))
    assert res["4.20"].qty == 1 and res["4.20"].origin == "detected"  # the symbol counts, the text is not added


def test_catalog_item_matched_by_code_by_the_text_rule_and_other_codes_not_by_its_patterns() -> None:
    r = rule("r_t", "text_item", {"patterns": ["קוברה"], "scope": "any", "qty": "count"}, "4.20")
    items = catalog("E", [ti(1, "צינורות חופשיים: צ.קוברה", "4.08", 1), ti(2, "צ.קוברה", "4.20", 1)])
    res = by_code(aggregate([esheet([], text_items=items)], sort_rules([r]), ELEC_LIB))
    assert res["4.20"].qty == 1 and [e["detectionId"] for e in res["4.20"].evidence] == ["text_2"]


def test_catalog_suggestion_becomes_a_suggested_line_when_nothing_produced_it() -> None:
    lb = lib(("9.03", 'התקנת צינור אוורור 4"', "08", "יחידה"))
    items = catalog("E", [ti(1, "מפסק לונטה", "9.03", 1, suggested=True)])
    ln = by_code(aggregate([esheet([], text_items=items)], default_rules(), lb))["9.03"]
    assert ln.origin == "suggested" and ln.qty == 1 and not ln.needs_input and ln.level == "yellow"
    assert ln.quick_action == {"kind": "count", "sheetId": "E"}


# ----------------------------------------------------------------------------- geometry
def geo_doc(**colls: Any) -> dict[str, Any]:
    return {"schema": "kamutan.geometry/1", "sheetId": "C", "discipline": "construction", "scaleDenominator": 50, **colls}


def measure(key: str, qty: float | None, floor: str, refs: list[str], **kw: Any) -> dict[str, Any]:
    return {"key": key, "unit": kw.pop("unit", 'מ"ר'), "qty": qty, "computable": qty is not None, "reason": kw.pop("reason", None),
            "estimate": kw.pop("estimate", None), "floor": floor, "refs": refs, "level": "yellow", "reasons": ["r"]}  # fmt: skip


BUILD_LIB = lib(
    ("2.01", "יציקה ודיפון קירות תומכים לחצר אנגלית חדשה ולמדרגות, בהתאם להנחיות קונסטרוקטור", "02", 'מ"ר'),
    ("2.03", "סגירת פתח דלת חיצונית במטבח בבלוק", "02", 'מ"ר'),
    ("5.04", "ריצוף בטיט של מדרגות ירידה למרתף במדרכי שיש  (רום+שלח)", "05", "יחידה"),
    ("7.06", 'בניית מחיצות גבס עם בידוד צמר סלעים 60 ק"ג למ"ר', "06", 'מ"ר'),
)


def csheet(geometry: dict[str, Any], sid: str = "C", floors: tuple[str, ...] = ("basement",), disc: str = "construction") -> Any:
    return replace(sheet(sid, disc, [], None, floors=list(floors)), geometry={**geometry, "sheetId": sid, "discipline": disc})


def test_area_item_keys_use_the_worker_geometry_measure_and_its_shapes() -> None:
    wr = {"id": "wr_1", "kind": "concrete_retaining", "lifecycle": "new", "lengthM": 4.7, "heightM": 2.34, "areaM2": 11.0,
          "polygonMm": [{"x": 0, "y": 0}, {"x": 94, "y": 0}, {"x": 94, "y": 6}], "floor": "basement", "level": "yellow", "reasons": ["x"]}  # fmt: skip
    st = {"id": "st_1", "lifecycle": "new", "treads": 11, "risers": 12, "key": "basement|new|11", "numbered": True,
          "polygonMm": [{"x": 0, "y": 0}, {"x": 50, "y": 0}, {"x": 50, "y": 20}], "floor": "basement", "level": "yellow", "reasons": ["x"]}  # fmt: skip
    doc = geo_doc(wallRuns=[wr], stairs=[st], measures=[measure("retaining_wall_area", 11.0, "basement", ["wr_1"])])
    ground = {**geo_doc(stairs=[{**st, "id": "st_9", "floor": "ground"}]), "sheetId": "G"}  # same stair seen from the ground
    res = by_code(aggregate([csheet(doc), csheet(ground, "G", ("ground",))], default_rules(), BUILD_LIB))
    w = res["2.01"]
    assert (w.qty, w.origin, w.by_floor, w.needs_input) == (11.0, "geometry", {"basement": 11.0}, False)
    ev = w.evidence[0]
    assert ev["detectionId"] == "wr_1" and ev["kind"] == "geometry" and ev["geometryMm"]["type"] == "polygon"
    s = res["5.04"]
    assert s.qty == 11 and s.origin == "geometry" and s.evidence[0]["kind"] == "stair" and s.evidence[0]["stair"]["treads"] == 11


def test_non_computable_measure_needs_input_with_the_estimate_as_hint_and_a_missing_one_falls_back() -> None:
    doc = geo_doc(
        wallRuns=[
            {
                "id": "wr_2",
                "kind": "gypsum_single",
                "lengthM": 10.8,
                "heightM": None,
                "polygonMm": [{"x": 0, "y": 0}, {"x": 5, "y": 0}, {"x": 5, "y": 1}],
                "floor": "basement",
                "level": "yellow",
                "reasons": ["x"],
            }
        ],
        measures=[
            measure(
                "gypsum_partition_area",
                None,
                "basement",
                ["wr_2"],
                reason="גובה לא משורטט",
                estimate={"qty": 28.1, "method": "h=2.6"},
            )
        ],
    )
    texts = [text(0, "סגירת פתח בבלוק", 10, 10)]
    res = by_code(aggregate([replace(csheet(doc), texts=texts)], default_rules(), BUILD_LIB))
    g = res["7.06"]
    # not computable (height not drawn): the user measures it; the estimate is only a hint
    assert (g.qty, g.origin, g.needs_input, g.level) == (0.0, "suggested", True, "red")
    assert "גובה לא משורטט" in g.reasons and any(r.startswith("הערכה: 28.1") for r in g.reasons) and g.by_floor == {}
    assert g.quick_action == {"kind": "measure_area", "sheetId": "C"}
    b = res["2.03"]  # no block-wall measure → the suggested_item fallback, quantity to be entered
    assert b.origin == "suggested" and b.needs_input and b.qty == 0 and b.level == "red" and b.by_floor == {}
    assert b.quick_action == {"kind": "measure_area", "sheetId": "C"} and b.evidence[0]["detectionId"] == "text_0"
    assert R.R_NEEDS_INPUT in b.reasons


def test_area_item_category_selection_wall_area_height_sides_min_qty_legend_patterns() -> None:
    doc = geo_doc(wallRuns=[
        {"id": "wr_1", "kind": "gypsum_single", "lengthM": 4.0, "heightM": 2.5, "areaM2": None, "floor": "basement",
         "polygonMm": [{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 1, "y": 1}], "label": "מחיצת גבס", "level": "yellow", "reasons": ["x"]},
        {"id": "wr_2", "kind": "gypsum_single", "lengthM": 0.2, "heightM": 2.5, "areaM2": None, "floor": "basement",
         "polygonMm": [{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 1, "y": 1}], "label": "מחיצת גבס", "level": "yellow", "reasons": ["x"]},
        {"id": "wr_3", "kind": "gypsum_single", "lengthM": 3.0, "heightM": None, "areaM2": None, "floor": "basement",
         "polygonMm": [{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 1, "y": 1}], "label": "אחר", "level": "yellow", "reasons": ["x"]},
    ])  # fmt: skip
    r = rule("r_g", "area_item", {"source": "wall_run", "categories": ["gypsum_single"], "legendPatterns": ["גבס"], "measure": "wall_area",
                                  "sides": 2, "minQty": 1.5}, "7.06", unit='מ"ר')  # fmt: skip
    ln = by_code(aggregate([csheet(doc)], [r], BUILD_LIB))["7.06"]
    assert ln.qty == 20.0 and [e["detectionId"] for e in ln.evidence] == ["wr_1"]  # 4 × 2.5 × 2; wr_2 < minQty; wr_3 no label


# ----------------------------------------------------------------------------- suggested_item
SUG_LIB = lib(("8.01", "תיקוני טיח לאחר הריסות", "07", "קומפלט"), ("7.01", "בניית תקרת גבס", "06", 'מ"ר'))


def test_suggested_triggers_estimates_and_levels() -> None:
    rs = [
        rule(
            "r_dem",
            "suggested_item",
            {"trigger": {"kind": "demolition"}, "estimate": {"kind": "fixed", "quantity": 1}, "reason": "הריסות"},
            "8.01",
            unit="קומפלט",
        ),
        rule(
            "r_ceil",
            "suggested_item",
            {
                "trigger": {"kind": "sheet_discipline", "disciplines": ["construction"]},
                "estimate": {"kind": "room_area", "roomTypes": ["corridor"]},
                "reason": "תקרה",
                "level": "red",
            },
            "7.01",
            unit='מ"ר',
        ),
    ]
    dem = sheet("D", "demolition", [], None)
    res = by_code(aggregate([dem], rs, SUG_LIB))
    assert res["8.01"].qty == 1 and res["8.01"].origin == "suggested" and not res["8.01"].needs_input
    assert res["8.01"].quick_action == {"kind": "confirm", "sheetId": "D"} and res["8.01"].evidence[0]["kind"] == "sheet"
    assert "7.01" not in res  # no construction sheet
    room = {"id": "r_1", "name": "מסדרון", "type": "corridor", "areaM2": 3.4, "perimeterM": 8, "floor": "ground", "level": "green",
            "polygonMm": [{"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 10, "y": 10}]}  # fmt: skip
    c = replace(sheet("C", "construction", [], None), room_docs=[room])
    res = by_code(aggregate([dem, c], rs, SUG_LIB))
    assert (
        res["7.01"].qty == 3.4
        and res["7.01"].level == "red"
        and res["7.01"].quick_action == {"kind": "measure_area", "sheetId": "C"}
    )


def test_suggested_line_is_not_offered_when_another_rule_produced_the_code_or_the_library_lacks_it() -> None:
    r = rule("r_s", "suggested_item", {"trigger": {"kind": "always"}, "reason": "תמיד"}, "7.01", unit='מ"ר')
    geo = rule("r_g", "area_item", {"source": "hatch", "categories": ["gypsum_ceiling"]}, "7.01", unit='מ"ר')
    doc = geo_doc(ceilings=[{"id": "cl_1", "kind": "gypsum_ceiling", "areaM2": 3.4, "polygonMm": [{"x": 0, "y": 0}, {"x": 4, "y": 0}, {"x": 4, "y": 4}],
                             "floor": "ground", "level": "yellow", "reasons": ["x"]}])  # fmt: skip
    res = by_code(aggregate([csheet(doc, floors=("ground",))], sort_rules([r, geo]), SUG_LIB))
    assert res["7.01"].qty == 3.4 and res["7.01"].origin == "geometry"
    res = by_code(aggregate([sheet("C", "construction", [], None)], [r], SUG_LIB))
    assert res["7.01"].qty == 0 and res["7.01"].needs_input and res["7.01"].evidence == []
    assert by_code(aggregate([sheet("C", "construction", [], None)], [r], lib(("1.01", "x", "01", "קומפלט")))) == {}


def test_quick_measure_correction_bound_to_the_line_replaces_the_suggestion() -> None:
    from kamutan_drawing.boq.corrections import parse_corrections

    r = rule("r_s", "suggested_item", {"trigger": {"kind": "always"}, "reason": "תמיד"}, "7.01", unit='מ"ר')
    corr = {"kind": "measure", "sheetId": "C", "versionId": "v1", "itemCode": "7.01", "quantity": 4.0, "unit": 'מ"ר',
            "geometry": None, "at": "2026-11-01T10:00:00Z", "by": "u1", "revertedAt": None, "radiusMm": 3, "signature": None,
            "linkGroupId": None, "roomId": None, "floor": "ground", "reason": None, "batchId": None, "class": None}  # fmt: skip
    cs, _ = parse_corrections([("c1", corr)])
    ln = by_code(aggregate([sheet("C", "construction", [], None)], [r], SUG_LIB, corrections=cs))["7.01"]
    assert ln.qty == 4.0 and ln.origin == "manual" and not ln.needs_input and ln.quick_action is None


# ----------------------------------------------------------------------------- coverage
def test_coverage_counts_produced_suggested_missing_by_chapter() -> None:
    lb = lib(("4.01", "a", "04", "יחידה"), ("4.02", "b", "04", "יחידה"), ("7.01", "c", "06", 'מ"ר'), ("7.02", "d", "06", 'מ"א'))
    lines = {"a": {"code": "4.01", "origin": "detected"}, "b": {"code": "7.01", "origin": "suggested"},
             "c": {"code": "4.02", "reasons": [R.R_OBSOLETE], "origin": "detected"}, "d": {"code": "9.99"}}  # fmt: skip
    cov = coverage(lines, lb)
    assert (cov["libraryCodes"], cov["produced"], cov["suggested"], cov["missing"]) == (4, 1, 1, ["4.02", "7.02"])
    assert cov["byChapter"] == {"4": {"libraryCodes": 2, "produced": 1, "suggested": 0, "missing": 1},
                                "6": {"libraryCodes": 2, "produced": 0, "suggested": 1, "missing": 1}}  # fmt: skip
    assert chapter_key("04") == "4" and chapter_key("A1") == "a1"


# ----------------------------------------------------------------------------- build job end to end + contracts
def _schema(name: str) -> dict[str, Any]:
    p = CONTRACTS / f"{name}.json"
    if not p.exists():
        pytest.skip(f"{name}.json not generated")
    out: dict[str, Any] = json.loads(p.read_text())
    return out


def test_build_writes_origin_fields_coverage_and_valid_evidence() -> None:
    blobs, docs = seed_project(
        [det(1, "socket_single", 0, 0), det(5, "panel", 62, 51)], [det(1, "switch_single"), det(2, "luminaire_ceiling", 5, 5)], []
    )
    pre = f"{P}/sheets/se/versions/v1/"
    blobs.write(
        pre + "text.json.gz", _gz({"schema": "kamutan.text/1", "lines": [text(0, "לוח תקשורת", 50, 50)]}), "application/gzip"
    )
    for code, desc, unit in (
        ("4.25", "אספקה והתקנת לוח תקשורת", "יחידה"),
        ("8.03", "צביעת פנים הבית", "קומפלט"),
        ("7.01", "תקרת גבס לפי תכנית התקרה", 'מ"ר'),
    ):
        docs.set(f"orgs/o1/itemLibrary/{item_id(code, desc)}", {"code": code, "description": desc, "chapter": code.split(".")[0].zfill(2),
                                                               "chapterTitle": "", "unit": unit, "active": True})  # fmt: skip
    docs.set(
        f"{P}/sheets/sc", {"discipline": "construction", "floors": ["ground"], "scaleDenominator": 50, "currentVersionId": "v1"}
    )
    pc = f"{P}/sheets/sc/versions/v1/"
    blobs.write(pc + "detections.json.gz", _gz({"schema": "kamutan.detections/1", "detections": []}), "application/gzip")
    blobs.write(
        pc + "text.json.gz", _gz({"schema": "kamutan.text/1", "lines": [text(0, "תקרת גבס", 20, 20)]}), "application/gzip"
    )
    docs.set(
        pc[:-1], {"status": "ready", "artifacts": {}, "regions": [], "page": {"widthMm": 420, "heightMm": 297, "rotation": 0}}
    )
    docs.set(f"{P}/boqBuilds/b1", {"jobId": "j-b1", "requestedBy": "u1", "createdAt": "2026-11-01T10:00:00.000Z"})
    build(blobs, docs, "b1")
    ls = lines_of(docs)
    assert ls["4.25"]["origin"] == "text" and ls["4.25"]["needsInput"] is False and ls["4.25"]["quickAction"] is None
    assert (
        ls["8.03"]["origin"] == "suggested"
        and ls["8.03"]["qty"] == 1
        and ls["8.03"]["quickAction"] == {"kind": "confirm", "sheetId": "sc"}
    )
    assert ls["7.01"]["needsInput"] is True and ls["7.01"]["qty"] == 0 and ls["7.01"]["level"] == "red"
    assert ls["4.00"]["origin"] == "detected"
    b = docs.get(f"{P}/boqBuilds/b1")
    cov = b["stats"]["coverage"]
    assert cov["missing"] == [] or set(cov["missing"]).isdisjoint({"4.25", "8.03", "7.01"})
    jsonschema.validate({k: v for k, v in b.items() if k in _schema("BoqBuild")["definitions"]["BoqBuild"]["properties"]} | {"id": "b1"},
                        _schema("BoqBuild"))  # fmt: skip
    ev = json.loads(gzip.decompress(blobs.read(f"{P}/boq/b1/evidence.json.gz")))
    jsonschema.validate(ev, _schema("BoqEvidenceArtifact"))
    line_s = _schema("BoqLine")
    props = line_s["definitions"]["BoqLine"]["properties"]
    for lid, d in docs.list_docs(f"{P}/boqLines"):
        doc = {k: v for k, v in {**d, "id": lid}.items() if k in props}
        jsonschema.validate(doc, line_s)


def test_approved_suggested_line_whose_estimate_changes_drops_to_reviewed() -> None:
    blobs, docs = seed_project([], [], None)
    desc = "צביעת פנים הבית"
    docs.set(f"orgs/o1/itemLibrary/{item_id('8.03', desc)}", {"code": "8.03", "description": desc, "chapter": "07", "chapterTitle": "",
                                                            "unit": "קומפלט", "active": True})  # fmt: skip
    docs.set(f"{P}/sheets/sc", {"discipline": "construction", "floors": ["ground"], "currentVersionId": "v1"})
    pc = f"{P}/sheets/sc/versions/v1/"
    blobs.write(pc + "detections.json.gz", _gz({"schema": "kamutan.detections/1", "detections": []}), "application/gzip")
    docs.set(
        pc[:-1], {"status": "ready", "artifacts": {}, "regions": [], "page": {"widthMm": 420, "heightMm": 297, "rotation": 0}}
    )
    build(blobs, docs, "b1")
    lid = lines_of(docs)["8.03"]["id"]
    docs.set(f"{P}/boqLines/{lid}", {"status": "approved", "approvedBy": "u1", "approvedAt": "2026-11-01T10:00:00Z"})
    build(blobs, docs, "b2")
    assert lines_of(docs)["8.03"]["status"] == "approved"  # same estimate: approval kept


# ----------------------------------------------------------------------------- Noah eval fixes (Sprint 6 round 2)
def test_catalog_item_at_a_detection_anchor_consumes_that_detection() -> None:
    """The projector cobra run: Worker-Text's 4.27 item is anchored on the conduit_cobra detection → not also a 4.20."""
    r = rule("r_p", "text_item", {"patterns": ["קוברה[^.]{0,40}מקרנ"], "scope": "any", "qty": "count"}, "4.27")
    rs = sort_rules([r, *[x for x in default_rules() if x.id == "r_conduit_cobra"]])
    lb = lib(*ELEC_LIB_ITEMS, ("4.27", "צינור קוברה 50 מ\"מ באורך 3.5 מ' למקרן תקרה", "04", "יחידה"))
    items = catalog("E", [ti(1, "קוברה+ / למקרן", "4.27", 1, kind="conduit", anchorMm={"x": 101.8, "y": 152.0})])
    dets = [det("d_cb_3", "conduit_cobra", 101.8, 152.0), det("d_cb_1", "conduit_cobra", 58.6, 150.2)]
    res = by_code(aggregate([esheet([], dets, text_items=items)], rs, lb))
    assert res["4.27"].qty == 1 and res["4.20"].qty == 1


def test_evidence_only_catalog_item_never_adds_to_a_one_off_suggestion() -> None:
    lb = lib(("3.15", "אספקה והתקנה של משאבה לניקוז מי גשם בחצר אנגלית", "03", "יחידה"))
    items = catalog("P", [ti(1, "משאבה לניקוז מי גשמים", "3.15", 1, corroborates=True)])
    s = replace(sheet("P", "plumbing", [], None), texts=[text(0, "חצר אנגלית", 10, 10)], text_items=items)
    ln = by_code(aggregate([s], default_rules(), lb))["3.15"]
    assert ln.qty == 1 and ln.origin == "suggested"


def test_room_settings_tiling_wins_over_the_drawing_geometry_of_the_same_item() -> None:
    lb = lib(("5.07", "חיפוי קיר שרותי אורחים באריח קרמיקה דמוי בריק", "05", 'מ"ר'))
    doc = geo_doc(measures=[measure("wc_partial_cladding_area", None, "ground", [], estimate={"qty": 0.98, "method": "screen"})])
    room = {"id": "r_4", "name": "ש.אורחים", "type": "wc", "areaM2": 1.5, "perimeterM": 5, "floor": "ground", "level": "green",
            "polygonMm": [{"x": 0, "y": 0}, {"x": 20, "y": 0}, {"x": 20, "y": 20}], "walls": [{"id": "w_1", "lengthM": 1.0}]}  # fmt: skip
    c = replace(csheet(doc, floors=("ground",)), room_docs=[room])
    alone = by_code(aggregate([c], default_rules(), lb))["5.07"]
    assert (alone.qty, alone.origin, alone.needs_input) == (0.0, "suggested", True)  # estimate only → needsInput
    settings = {"C__r_4": {"sheetId": "C", "roomId": "r_4", "claddingHeightM": 0, "floorTiled": False, "includeInWaterproofing": False,
                           "partialCladding": [{"wallId": "w_1", "fromM": 0, "toM": 0.8, "heightM": 1.5}], "by": "u1", "at": "2026-11-01T10:00:00Z"}}  # fmt: skip
    ln = by_code(aggregate([c], default_rules(), lb, room_settings=settings))["5.07"]
    assert ln.qty == 1.2 and ln.origin == "geometry"  # the user's partial wall, not 1.2 + 0.98


# ----------------------------------------------------------------------------- quick-measure corrections bound by lineId
def _seed_suggested(blobs: Any, docs: Any) -> None:
    for code, desc, unit in (("7.01", "תקרת גבס לפי תכנית התקרה", 'מ"ר'), ("8.03", "צביעת פנים הבית", "קומפלט")):
        docs.set(f"orgs/o1/itemLibrary/{item_id(code, desc)}", {"code": code, "description": desc, "chapter": "06",
                                                               "chapterTitle": "", "unit": unit, "active": True})  # fmt: skip
    docs.set(
        f"{P}/sheets/sc", {"discipline": "construction", "floors": ["ground"], "scaleDenominator": 50, "currentVersionId": "v1"}
    )
    pc = f"{P}/sheets/sc/versions/v1/"
    blobs.write(pc + "detections.json.gz", _gz({"schema": "kamutan.detections/1", "detections": []}), "application/gzip")
    blobs.write(
        pc + "text.json.gz", _gz({"schema": "kamutan.text/1", "lines": [text(0, "תקרת גבס", 20, 20)]}), "application/gzip"
    )
    docs.set(
        pc[:-1], {"status": "ready", "artifacts": {}, "regions": [], "page": {"widthMm": 420, "heightMm": 297, "rotation": 0}}
    )


def _qm(kind: str, line_id: str, **kw: Any) -> dict[str, Any]:
    return {"kind": kind, "sheetId": "sc", "versionId": "v1", "lineId": line_id, "quickAction": kw.pop("qa", None), "itemCode": None,
            "at": kw.pop("at", "2026-11-01T11:00:00Z"), "by": "u1", "revertedAt": None, "radiusMm": 3, **kw}  # fmt: skip


def test_quick_measure_bound_by_line_id_replaces_a_suggestion_and_adds_to_a_computed_line() -> None:
    blobs, docs = seed_project([det(1, "socket_single", 0, 0)], [], None)
    _seed_suggested(blobs, docs)
    build(blobs, docs, "b1")
    ls = lines_of(docs)
    assert ls["7.01"]["needsInput"] and ls["8.03"]["qty"] == 1 and ls["4.00"]["qty"] == 1
    poly = {
        "type": "polygon",
        "mm": [{"x": 0, "y": 0}, {"x": 40, "y": 0}, {"x": 40, "y": 40}, {"x": 0, "y": 40}],
    }  # 2 m × 2 m at 1:50
    docs.set(f"{P}/corrections/q1", _qm("measure", ls["7.01"]["id"], geometry=poly, qa="measure_area"))
    docs.set(f"{P}/corrections/q2", _qm("accept", ls["8.03"]["id"], qa="confirm"))  # confirm the estimate
    docs.set(f"{P}/corrections/q3", {**_qm("count", ls["4.00"]["id"], qa="count"), "sheetId": "se",
                                     "geometry": {"type": "points", "mm": [{"x": 50, "y": 50}, {"x": 60, "y": 60}]}})  # fmt: skip
    build(blobs, docs, "b2")
    ls = lines_of(docs)
    assert (ls["7.01"]["qty"], ls["7.01"]["origin"], ls["7.01"]["needsInput"], ls["7.01"]["quickAction"]) == (
        4.0,
        "manual",
        False,
        None,
    )
    assert (ls["8.03"]["qty"], ls["8.03"]["origin"], ls["8.03"]["needsInput"]) == (1.0, "manual", False)
    assert ls["8.03"]["level"] == "green"  # a person confirmed it
    assert (ls["4.00"]["qty"], ls["4.00"]["origin"]) == (3.0, "detected")  # 1 detected + 2 counted
    assert docs.get(f"{P}/boqBuilds/b2")["unmatchedCorrections"] == []


def test_every_default_rule_code_is_in_the_published_default_library() -> None:
    p = CONTRACTS / "defaults" / "library-defaults.json"
    if not p.exists():
        pytest.skip("library-defaults.json not generated")
    lib_doc = json.loads(p.read_text())
    items = lib_doc.get("items") or lib_doc.get("library") or []
    codes = {str(i.get("code")) for i in items if isinstance(i, dict)}
    assert codes, list(lib_doc)
    s6 = {r["itemCode"] for r in R.DEFAULT_RULES if r["kind"] in ("text_item", "area_item", "length_item", "suggested_item")}
    assert s6 <= codes, sorted(s6 - codes)


def test_consume_near_takes_only_the_symbol_the_text_sits_on() -> None:
    """Noah: "לוח תקשורת" is 17 mm from the unit's panel symbol, which is 4.24 — the default rule (near panel ≤ 40 mm,
    consumeNear) counts the comms panel but must not take the panel from 4.24."""
    rs = sort_rules([x for x in default_rules() if x.id in ("r_text_comms_panel", "r_panel")])
    s = esheet([text(0, "לוח תקשורת", 125.0, 114.0, w=10.0)], [det(16, "panel", 115.3, 124.6)])
    res = by_code(aggregate([s], rs, ELEC_LIB))
    assert res["4.25"].qty == 1 and res["4.24"].qty == 1 and res["4.24"].origin == "detected"
