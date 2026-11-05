"""Owner decision 05.11 (BOQ 7.06): gypsum partitions = length × full storey height × both faces.

* Worker-Geometry: ``wallRuns[].lining`` (one long face against an existing / masonry wall → one gypsum face);
* ``measures(doc, faces=, height_mode=)`` / ``geometry_units(..., faces=, height_mode=)`` re-measure the partition keys
  and carry a per-element breakdown;
* Worker-BOQ: a ``keys`` rule with ``faces`` / ``heightMode`` → per-evidence m² and reason; the default 7.06 rule uses
  faces 2 + storey, 7.07 is unchanged.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

import pytest

from kamutan_drawing.boq import rules as R
from kamutan_drawing.boq.aggregate import aggregate
from kamutan_drawing.boq.rules import default_rules
from kamutan_drawing.geometry import geometry_units, measures
from kamutan_drawing.geometry.analyze import (
    R_LINING_1,
    R_PARTITION_2,
    R_PARTITION_2_DRAWN,
    R_PARTITION_2_STOREY,
    convention_items,
)

from .test_boq_s6 import BUILD_LIB, by_code, csheet, geo_doc, rule
from .test_geometry import YELLOW, Sheet, by_kind, house, run, text


# ---------------------------------------------------------------------------------------------------- lining test
def test_lining_against_an_existing_wall_vs_free_standing_partition() -> None:
    s = house(Sheet())  # grey existing walls, inner face of the south wall at y = 196
    s.rect(150, 194.6, 230, 196)  # 4.0 m × 0.07 m lining on the south wall
    s.rect(150, 100, 230, 102)  # 4.0 m × 0.10 m free-standing partition across the room
    s.rect(120, 150, 140, 152)  # low wall 1.0 m "קיר נמוך H=140"
    doc = run(s.build(), [text("קיר נמוך H=140", 120, 154, 140, 156.3)])
    gyp = sorted(by_kind(doc["wallRuns"], "gypsum_single"), key=lambda r: r["bboxMm"]["y"])
    assert len(gyp) == 2
    part, lining = gyp
    assert part["lining"] is False and part["wallContactM"] < 0.5
    assert lining["lining"] is True and lining["wallContactM"] == pytest.approx(4.0, rel=0.1)
    low = by_kind(doc["wallRuns"], "low_wall")
    assert len(low) == 1 and low[0]["lining"] is False and low[0]["heightM"] == 1.4
    # block / concrete runs are not tested
    assert all(
        r.get("lining") is None for r in doc["wallRuns"] if r["kind"] not in ("gypsum_single", "gypsum_double", "low_wall")
    )


def test_a_partition_beside_a_demolished_wall_is_not_a_lining() -> None:
    s = house(Sheet())
    s.rect(150, 100, 230, 102)  # new partition (red)
    s.rect(150, 102, 230, 106, YELLOW)  # the wall it replaces, drawn as demolished (yellow) on a master plan
    doc = run(s.build(), discipline="architecture_master")
    gyp = by_kind(doc["wallRuns"], "gypsum_single")
    assert len(gyp) == 1 and gyp[0]["lining"] is False


# ---------------------------------------------------------------------------------------------------- measures
def _run(
    rid: str, kind: str, length: float, h: float | None, src: str | None, lining: bool | None, floor: str = "ground"
) -> dict[str, Any]:
    return {"id": rid, "kind": kind, "lifecycle": "new", "lengthM": length, "thicknessM": 0.1, "heightM": h, "heightSource": src,
            "areaM2": round(length * h, 3) if h is not None else None, "floor": floor, "lining": lining, "level": "yellow",
            "reasons": ["סוג הקיר לפי עובי בלבד"] + (["גובה הקיר הונח כגובה התקרה בקומה (2.65 מ') — לבדיקה"] if src == "level_mark" else []),
            "polygonMm": [{"x": 0, "y": 0}, {"x": 5, "y": 0}, {"x": 5, "y": 1}]}  # fmt: skip


def _doc() -> dict[str, Any]:
    return geo_doc(
        heights=[{"floor": "ground", "ceilingM": 2.65, "source": "level_mark"}],
        wallRuns=[
            _run("wr_1", "gypsum_single", 4.0, 2.65, "level_mark", False),  # free-standing, ceiling assumed
            _run("wr_2", "gypsum_single", 4.4, 2.65, "section", True),  # AC lining against the existing wall
            {**_run("wr_3", "low_wall", 1.0, 1.4, "label", False), "material": "gypsum"},  # low wall H=140
            _run("wr_4", "gypsum_single", 2.0, 1.2, "label", False),  # a screen drawn H=120 (partial height)
            _run("wr_5", "gypsum_double", 3.0, 2.65, "level_mark", False),
        ],
    )


def _m(ms: list[dict[str, Any]], key: str) -> dict[str, Any]:
    return next(m for m in ms if m["key"] == key)


def test_measures_as_produced_without_a_convention() -> None:
    m = _m(measures(_doc()), "gypsum_partition_area")
    assert m["qty"] == pytest.approx(4.0 * 2.65 + 4.4 * 2.65 + 1.4 + 2.4, abs=0.01) and "items" not in m


def test_storey_two_faces_lining_one_face_low_wall_keeps_its_height() -> None:
    ms = measures(_doc(), faces=2, height_mode="storey")
    m = _m(ms, "gypsum_partition_area")
    items = {i["id"]: i for i in m["items"]}
    assert (items["wr_1"]["faces"], items["wr_1"]["heightM"], items["wr_1"]["reason"]) == (2, 2.65, R_PARTITION_2_STOREY)
    assert items["wr_1"]["heightSource"] == "storey" and items["wr_1"]["areaM2"] == pytest.approx(4.0 * 2.65 * 2)
    assert (items["wr_2"]["faces"], items["wr_2"]["reason"]) == (1, R_LINING_1)
    assert items["wr_2"]["areaM2"] == pytest.approx(4.4 * 2.65)
    assert (items["wr_3"]["faces"], items["wr_3"]["heightM"], items["wr_3"]["reason"]) == (2, 1.4, R_PARTITION_2_DRAWN)
    assert (items["wr_4"]["heightM"], items["wr_4"]["areaM2"]) == (1.2, pytest.approx(2.0 * 1.2 * 2))  # drawn below storey
    assert m["qty"] == pytest.approx(sum(i["areaM2"] for i in items.values()), abs=0.01)
    # the storey height is the convention, not an assumption to review
    assert not any("לבדיקה" in r for r in m["reasons"]) and R_LINING_1 in m["reasons"]
    # 7.07's key is re-measured only when the rule asks for it (same convention here: two faces)
    d = _m(ms, "gypsum_double_partition_area")
    assert d["qty"] == pytest.approx(3.0 * 2.65 * 2)


def test_drawn_mode_keeps_heights_and_one_face_keeps_the_area() -> None:
    m = _m(measures(_doc(), faces=2, height_mode="drawn"), "gypsum_partition_area")
    items = {i["id"]: i for i in m["items"]}
    assert items["wr_1"]["heightSource"] == "level_mark" and items["wr_1"]["reason"] == R_PARTITION_2
    assert "גובה הקיר הונח כגובה התקרה בקומה (2.65 מ') — לבדיקה" in m["reasons"]
    one = _m(measures(_doc(), faces=1, height_mode="drawn"), "gypsum_partition_area")
    assert one["qty"] == pytest.approx(_m(measures(_doc()), "gypsum_partition_area")["qty"], abs=0.01)


def test_storey_from_the_room_ceiling_and_the_default_ceiling_is_said() -> None:
    doc = _doc()
    room_item = {**_run("wr_9", "gypsum_single", 1.0, 2.4, "room", False)}
    assert convention_items(doc, [room_item], 2, "storey")[0]["heightM"] == 2.4
    no_marks = {**doc, "heights": [{"floor": "ground", "ceilingM": 2.6, "source": "default"}]}
    it = convention_items(no_marks, [_run("wr_1", "gypsum_single", 1.0, 2.6, "default", None)], 2, "storey")[0]
    assert it["faces"] == 2 and any("ברירת מחדל" in r for r in it["reasons"])  # lining unknown → the rule's faces
    no_h = convention_items(doc, [_run("wr_8", "low_wall", 1.0, None, None, False)], 2, "storey")[0]
    assert no_h["areaM2"] is None and "faces" not in no_h


def test_geometry_units_carry_the_breakdown_with_sheet_ids() -> None:
    u = geometry_units([_doc()], keys=["gypsum_partition_area"], faces=2, height_mode="storey")[0]
    assert u["computable"] and {i["sheetId"] for i in u["items"]} == {"C"} and len(u["items"]) == 4
    doc = _doc()
    doc["measures"] = measures(doc)
    plain = geometry_units([doc], keys=["gypsum_partition_area"])[0]
    assert "items" not in plain and plain["qty"] < u["qty"]


# ---------------------------------------------------------------------------------------------------- BOQ
def test_default_7_06_rule_two_faces_storey_and_7_07_unchanged() -> None:
    doc = _doc()
    doc["measures"] = measures(doc)
    ms = {m["key"]: m for m in doc["measures"]}
    res = by_code(aggregate([csheet(doc, floors=("ground",))], default_rules(), BUILD_LIB))
    g = res["7.06"]
    expected = 4.0 * 2.65 * 2 + 4.4 * 2.65 + 1.4 * 2 + 2.0 * 1.2 * 2
    assert g.qty == pytest.approx(expected, abs=0.01) and g.origin == "geometry"
    ev = {e["detectionId"]: e for e in g.evidence}
    assert ev["wr_1"]["reason"] == R_PARTITION_2_STOREY and ev["wr_1"]["quantity"] == pytest.approx(21.2)
    assert ev["wr_2"]["reason"] == R_LINING_1 and ev["wr_2"]["quantity"] == pytest.approx(11.66)
    assert ev["wr_3"]["quantity"] == pytest.approx(2.8)
    assert R_PARTITION_2_STOREY in g.reasons and R_LINING_1 in g.reasons
    r707 = next(r for r in R.DEFAULT_RULES if r["id"] == "r_geo_gypsum_partition_double")["match"]
    assert "faces" not in r707 and "heightMode" not in r707
    # 7.07 (no library item in BUILD_LIB) — its measure as produced: one face, the drawn / assumed height
    assert ms["gypsum_double_partition_area"]["qty"] == pytest.approx(3.0 * 2.65)


def test_a_rule_without_the_convention_keeps_the_produced_measure() -> None:
    doc = _doc()
    doc["measures"] = measures(doc)
    r = rule(
        "r_g", "area_item", {"source": "wall_run", "keys": ["gypsum_partition_area"], "measure": "wall_area"}, "7.06", unit='מ"ר'
    )
    g = by_code(aggregate([csheet(doc, floors=("ground",))], [r], BUILD_LIB))["7.06"]
    assert g.qty == pytest.approx(_m(doc["measures"], "gypsum_partition_area")["qty"], abs=0.01)
    assert all("reason" not in e for e in g.evidence)
    r1 = rule("r_g", "area_item", {"source": "wall_run", "keys": ["gypsum_partition_area"], "faces": 1, "heightMode": "storey"},
              "7.06", unit='מ"ר')  # fmt: skip
    g1 = by_code(aggregate([replace(csheet(doc, floors=("ground",)))], [r1], BUILD_LIB))["7.06"]
    assert g1.qty == pytest.approx(4.0 * 2.65 + 4.4 * 2.65 + 1.4 + 2.4, abs=0.01)
