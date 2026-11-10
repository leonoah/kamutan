"""Sprint 10 (Worker-Lighting): circuit tags → circuits → BOQ lines in both wordings."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from kamutan_drawing.boq.dedup import Det
from kamutan_drawing.boq.rules import Item, Library, Rule
from kamutan_drawing.lighting import build_circuits, parse_tags
from kamutan_drawing.lighting.boq import (
    DEFAULT_RULE_DOC,
    CircuitSheet,
    circuit_units,
    describe,
    describe_set,
    merge_circuits,
    parse_light_item,
)
from kamutan_drawing.lighting.circuits import (
    R_BUILTIN_SWITCH,
    R_LEADER_TAG,
    R_POSITION_NO_GLYPH,
    R_RETAGGED,
    R_TIMER_WORD_UNREAD,
    R_UNMATCHED_ON_SHEET,
    enclosing_rects,
    leader_lines,
)
from kamutan_drawing.lighting.tags import is_tag_only, looks_like_tag_label

PLAN = [{"floor": "ground", "polygonMm": [{"x": 0, "y": 0}, {"x": 140, "y": 0}, {"x": 140, "y": 120}, {"x": 0, "y": 120}]}]


# ----------------------------------------------------------------------------- tags
@pytest.mark.parametrize(
    ("text", "ids", "is_list"),
    [
        ("A1", ["A1"], False),
        ("D6", ["D6"], False),
        ("P10", ["P10"], False),
        ("i1", ["I1"], False),
        ("T2A", ["T2A"], False),
        ("A1-A4", ["A1", "A2", "A3", "A4"], True),
        ("B1 - B5", ["B1", "B2", "B3", "B4", "B5"], True),
        ("N1-N4", ["N1", "N2", "N3", "N4"], True),
        ("D1,D2,D3,D4", ["D1", "D2", "D3", "D4"], True),
        ("B5, פנוי", ["B5"], True),
        ("T2,T2A,M1,M3", ["T2", "T2A", "M1", "M3"], True),
        ("A4 A3 A1", ["A4", "A3", "A1"], True),
        ("C1,C2,B4,פנוי", ["C1", "C2", "B4"], True),
    ],
)
def test_parse_tags(text: str, ids: list[str], is_list: bool) -> None:
    r = parse_tags(text)
    assert r.ids == ids
    assert r.is_list == is_list
    assert not r.corrected


@pytest.mark.parametrize("text", ["60", "109", "H=100", "230", "1:50", "19/Feb/2025", "2026/ח22/00", "355", "X", "H=200", "L0"])
def test_parse_tags_rejects_dimensions_dates_and_scales(text: str) -> None:
    assert parse_tags(text).tags == []


def test_parse_tags_lookalike_folds() -> None:
    r = parse_tags("AI")  # 1 read as I in the digit slot
    assert r.ids == ["A1"] and r.corrected
    assert parse_tags("8ו").tags == []  # neither slot is sure: not a tag
    assert parse_tags("ב |").tags == []  # crumb of the glyph reader
    r = parse_tags("ד3")  # Hebrew letter read for the Latin D, digits real
    assert r.ids == ["D3"] and r.corrected
    assert parse_tags("ד3", allow_fold=False).tags == []


def test_tag_only_and_label() -> None:
    assert is_tag_only("A1-A4") and is_tag_only("B5, פנוי") and not is_tag_only("הזנה לשנאי A1")
    assert looks_like_tag_label("A1") and not looks_like_tag_label("A1-A4") and not looks_like_tag_label("A1 H=200")


def test_range_limits() -> None:
    assert parse_tags("A1-A40").ids == ["A1", "A40"]  # too wide a range: the two tags, not expanded
    assert parse_tags("A4-A1").ids == ["A4", "A1"]  # reversed: two tags, no range


# ----------------------------------------------------------------------------- synthetic sheets
@dataclass
class Span:
    bbox: tuple[float, float, float, float]
    text: str


def lum(i: int, x: float, y: float, cls: str = "luminaire_ceiling", floor: str | None = "ground") -> dict[str, Any]:
    return {"id": f"d_{i}", "class": cls, "centerMm": {"x": x, "y": y}, "bboxMm": {"x": x - 1.5, "y": y - 1.5, "w": 3, "h": 3},
            "level": "yellow", "reasons": [], "floor": floor, "lifecycle": "new"}  # fmt: skip


def sw(i: int, x: float, y: float, cls: str = "switch_single") -> dict[str, Any]:
    return {"id": f"d_{i}", "class": cls, "centerMm": {"x": x, "y": y}, "bboxMm": {"x": x - 1, "y": y - 1, "w": 2, "h": 2},
            "level": "yellow", "reasons": [], "floor": "ground", "lifecycle": "new"}  # fmt: skip


def tag(x: float, y: float, text: str) -> Span:
    return Span((x, y, x + 1.5 * len(text), y + 2.0), text)


def test_circuit_kinds_single_shared_two_way_cross_no_switch_timer() -> None:
    dets = [
        lum(1, 20, 20), lum(2, 40, 20), lum(3, 60, 20),  # A1 shared (2), A2 single
        lum(4, 20, 50), lum(5, 20, 80),  # B1 two-way (1 fixture), C1 cross
        lum(6, 100, 20), lum(7, 100, 40),  # D3 timer, P1 no switch
        sw(10, 20, 100), sw(11, 24, 100), sw(12, 28, 100),  # bank: A1 A2 B1
        sw(13, 60, 100),  # B1 second position
        sw(14, 60, 60), sw(15, 80, 60), sw(16, 80, 80),  # C1 ×3
    ]  # fmt: skip
    spans = [
        tag(21.5, 22, "A1"), tag(41.5, 22, "A1"), tag(61.5, 22, "A2"), tag(21.5, 52, "B1"), tag(21.5, 82, "C1"),
        tag(101.5, 22, "D3"), tag(101.5, 42, "P1"),
        tag(18, 102.5, "A1"), tag(22, 102.5, "A2"), tag(26, 102.5, "B1"), tag(58, 102.5, "B1"),
        tag(58, 62.5, "C1"), tag(78, 62.5, "C1"), tag(78, 82.5, "C1"),
        # the timer note, outside the plan: Hebrew prose + the tag list on the next row
        Span((150, 150, 190, 152.5), "תאורות שנדלקות ע\"י שעון שבת (טיימר) בלוח חשמל"),
        tag(170, 154, "D3"),
    ]  # fmt: skip
    doc = build_circuits(spans, dets, sheet_id="s", regions=PLAN)
    by = {c["tag"]: c for c in doc["circuits"]}
    assert by["A1"]["kind"] == "shared" and by["A1"]["fixtures"] == 2 and by["A1"]["positions"] == 1
    assert by["A2"]["kind"] == "single"
    assert by["B1"]["kind"] == "two_way" and by["B1"]["positions"] == 2 and len(by["B1"]["switchIds"]) == 2
    assert by["C1"]["kind"] == "cross" and by["C1"]["positions"] == 3
    assert by["D3"]["kind"] == "timer" and by["D3"]["timer"] and R_TIMER_WORD_UNREAD not in by["D3"]["reasons"]
    assert by["P1"]["kind"] == "no_switch"
    assert doc["unmatched"] == {"fixtureIds": [], "tags": [], "texts": []}
    assert all(c["level"] == "green" for c in doc["circuits"])
    assert doc["stats"]["byKind"] == {"single": 1, "shared": 1, "two_way": 1, "cross": 1, "timer": 1, "no_switch": 1}
    assert all(e["detectionId"] for c in doc["circuits"] for e in c["evidence"] if e["kind"] == "tag")
    # the bank's glyphs are split by tag: A1's gang is the one nearest its text
    assert by["A1"]["switchIds"] == ["d_10"] and by["A2"]["switchIds"] == ["d_11"]


def test_timer_list_without_readable_keyword_is_yellow_and_untagged_fixtures_are_reported() -> None:
    dets = [lum(1, 20, 20), lum(2, 40, 20), lum(3, 80, 80)]
    spans = [
        tag(21.5, 22, "D6"),
        tag(41.5, 22, "D6"),
        Span((150, 150, 190, 152.5), "garbage read of the note"),
        tag(170, 154, "D6"),
    ]
    doc = build_circuits(spans, dets, regions=PLAN)
    (c,) = doc["circuits"]
    assert c["kind"] == "timer" and c["level"] == "yellow"
    assert R_TIMER_WORD_UNREAD in c["reasons"] and R_UNMATCHED_ON_SHEET in c["reasons"]
    assert doc["unmatched"]["fixtureIds"] == ["d_3"] and doc["stats"]["untaggedFixtures"] == 1


def test_lone_tag_in_the_plan_is_unplaced_not_a_timer() -> None:
    dets = [lum(1, 20, 20)]
    spans = [tag(21.5, 22, "A1"), tag(90, 90, "Q7")]
    doc = build_circuits(spans, dets, regions=PLAN)
    assert [c["tag"] for c in doc["circuits"]] == ["A1"] and doc["unmatched"]["texts"][0]["tags"] == ["Q7"]


def test_rubel_switch_boxes_without_glyphs_and_ranges() -> None:
    """Orange boxes listing circuits, no switch glyphs: one position per box; ranges and list words."""
    dets = [lum(1, 20, 20), lum(2, 40, 20), lum(3, 60, 20), lum(4, 80, 20), lum(5, 100, 20)]
    spans = [tag(21.5, 22, "A1"), tag(41.5, 22, "A2"), tag(61.5, 22, "A3"), tag(81.5, 22, "A4"), tag(101.5, 22, "A5"),
             Span((20, 60, 36, 62.5), "A1-A3"), Span((20, 63, 36, 65.5), "A4, פנוי"), Span((20, 66, 36, 68.5), "מיזוג,מיזוג"),
             Span((80, 60, 92, 62.5), "A5,A4")]  # fmt: skip
    rects = [(18, 58, 38, 70), (78, 58, 94, 64)]
    doc = build_circuits(spans, dets, rects=rects)
    by = {c["tag"]: c for c in doc["circuits"]}
    assert len(doc["positions"]) == 2 and doc["stats"]["positionsWithoutGlyph"] == 2
    assert by["A1"]["kind"] == by["A2"]["kind"] == by["A3"]["kind"] == "single"
    assert by["A4"]["kind"] == "two_way" and R_POSITION_NO_GLYPH in by["A4"]["reasons"] and by["A4"]["level"] == "yellow"
    assert by["A5"]["kind"] == "single"
    assert doc["unmatched"]["tags"] == []


def test_stacked_boxes_share_an_edge_and_a_single_tag_box_is_a_position() -> None:
    """rubel: "D1,D2,D3,D4 / B1,B2,B3" box, then "A1-A5" and "T1" in their own boxes right below it."""
    dets = [lum(1, 20, 20), lum(2, 40, 20), lum(3, 60, 20)]
    spans = [tag(21.5, 22, "B1"), tag(41.5, 22, "A1"), tag(61.5, 22, "T1"),
             Span((21, 61, 33, 63), "B1,B2,B3"), Span((21, 65, 29, 67), "A1-A5"), Span((21, 69, 24, 71), "T1")]  # fmt: skip
    rects = [(20, 60, 40, 64), (20, 64, 40, 68), (20, 68, 30, 72)]
    doc = build_circuits(spans, dets, rects=rects)
    by = {c["tag"]: c for c in doc["circuits"]}
    assert {by[t]["kind"] for t in ("B1", "A1", "T1")} == {"single"}
    assert len(doc["positions"]) == 1  # one bank at one wall spot


def test_switch_tag_without_fixture_is_reported_not_dropped() -> None:
    dets = [lum(1, 20, 20), sw(2, 20, 60), sw(3, 24, 60)]
    spans = [tag(21.5, 22, "A1"), tag(18, 62.5, "A1"), tag(22, 62.5, "T1")]
    doc = build_circuits(spans, dets)
    assert [u["tag"] for u in doc["unmatched"]["tags"]] == ["T1"]
    assert doc["unmatched"]["tags"][0]["positionIds"] == ["sp_1"]


def test_builtin_switch_wall_light_and_leader_note() -> None:
    dets = [lum(1, 20, 20), sw(2, 20, 60), lum(3, 80, 60, "luminaire_wall"), sw(4, 84, 60), lum(5, 120, 20), sw(6, 120, 60)]
    spans = [tag(21.5, 22, "G1"), tag(18, 62.5, "G1"), tag(86, 62.5, "G1"), tag(121.5, 22, "C8"),
             Span((140, 90, 170, 92.5), "לחצן אוטומט חדר מדרגות"), tag(171, 90, "C8")]  # fmt: skip
    leaders = [(121, 61, 169.5, 91)]
    doc = build_circuits(spans, dets, leaders=leaders)
    by = {c["tag"]: c for c in doc["circuits"]}
    assert by["G1"]["kind"] == "two_way"  # the room switch + the glyph beside the wall light
    assert by["G1*"]["kind"] == "single" and R_BUILTIN_SWITCH in by["G1*"]["reasons"] and by["G1*"]["fixtureIds"] == ["d_3"]
    assert by["C8"]["kind"] == "single" and by["C8"]["stairAutomat"] and by["C8"]["switchIds"] == ["d_6"]
    assert any(R_LEADER_TAG in q["reasons"] for q in doc["positions"])


def test_leader_note_mention_is_not_a_timer_and_leader_tag_reaches_a_far_fixture() -> None:
    """ "הזנה לשנאי עבור פרופיל לד A1 H=200" above a strip ~9 mm away tags it; the mention is no timer list."""
    dets = [lum(1, 20, 20), lum(2, 20, 50, "luminaire_strip"), sw(3, 20, 100)]
    spans = [tag(21.5, 22, "A1"), Span((32, 40, 60, 42), "הזנה לשנאי עבור פרופיל לד"), tag(28, 40, "A1"), tag(18, 102.5, "A1")]
    doc = build_circuits(spans, dets)
    (c,) = doc["circuits"]
    assert c["kind"] == "shared" and c["fixtures"] == 2 and not c["timer"]


def test_misclassified_symbol_with_a_tag_is_a_fixture() -> None:
    """rubel: the ceiling spots detect as alarm_detector — a tag label right beside one re-tags it (yellow)."""
    dets = [
        lum(1, 20, 20),
        {**lum(2, 40, 20), "class": "alarm_detector"},
        {**lum(3, 60, 20), "class": "thermostat"},
        sw(4, 20, 60),
    ]
    spans = [tag(21.5, 22, "A1"), tag(41.5, 22, "A1"), tag(61.5, 22, "A2"), tag(18, 62.5, "A1")]
    doc = build_circuits(spans, dets)
    by = {c["tag"]: c for c in doc["circuits"]}
    assert by["A1"]["fixtures"] == 2 and R_RETAGGED in by["A1"]["reasons"]
    assert "A2" not in by  # a thermostat is never a fixture; its tag text is reported
    assert doc["unmatched"]["texts"][0]["tags"] == ["A2"]


def test_helpers_rects_and_leaders() -> None:
    bboxes = [(0, 0, 20, 10), (0, 0, 200, 100), (5, 5, 6, 6), (0, 0, 30, 1)]
    assert enclosing_rects(bboxes, closed=[True, True, True, True]) == [(0.0, 0.0, 20.0, 10.0)]
    assert enclosing_rects(bboxes, closed=[False, True, True, True]) == []
    segs = [[0, 0, 10, 0], [10, 0, 10, 10], [50, 50, 51, 50], [0, 0, 5, 0], [5, 0, 5, 5], [5, 5, 0, 5], [0, 5, 0, 0]]
    seg_path = [0, 0, 1, 2, 2, 2, 2]
    assert leader_lines(segs, seg_path, [False, False, True]) == [(0.0, 0.0, 10.0, 10.0)]


# ----------------------------------------------------------------------------- BOQ: library parsing and both wordings
@pytest.mark.parametrize(
    ("desc", "fixtures", "switches", "timer", "stair", "set_n"),
    [
        ("נק' מאור בודדה כוללת מפסק", 1, 1, False, False, None),
        ("נק' מאור בודדה ללא מפסק (אפס קבוע)", 1, 0, False, False, None),
        ("שתי נק' מאור כוללת מפסק בודד משותף", 2, 1, False, False, None),
        ("נק' מאור בודדה כוללת שני מפסקים מחליפים", 1, 2, False, False, None),
        ("נק' מאור בודדה כוללת שלושה מפסקים מצלבים", 1, 3, False, False, None),
        ("שלוש נק' מאור כוללות שני מפסקים מחליפים עם אוטומט חדר מדרגות", 3, 2, False, True, None),
        ("שבע נק' מאור כוללות מפסק טיימר משותף בלוח חשמל", 7, 0, True, False, None),
        ("נק' מאור בודדה", 1, None, False, False, None),
        ("סט: שירשור שתי נק' מאור משותפות במעגל הדלקה אחד", 2, None, False, False, 2),
        ("סט: שירשור 17 נק' מאור משותפות במעגל הדלקה אחד", 17, None, False, False, 17),
        ("נק' מאור כוללת מפסק", 1, 1, False, False, None),  # Noah's wording
        ("שתי נק' מאור משותפות בעלות מפסק בודד", 2, 1, False, False, None),
        ("שלוש נקודות מאור בעלות מפסק בודד", 3, 1, False, False, None),
    ],
)
def test_parse_light_item(desc: str, fixtures: int, switches: int | None, timer: bool, stair: bool, set_n: int | None) -> None:
    li = parse_light_item(desc)
    assert li is not None
    assert (li.fixtures, li.switches, li.timer, li.stair, li.set_n) == (fixtures, switches, timer, stair, set_n)


def test_parse_light_item_rejects_other_lines() -> None:
    assert parse_light_item("התקנת גוף תאורה פשוט") is None
    assert parse_light_item("התקנת מאוורר תקרה") is None
    assert parse_light_item("הוספת מפסק למאוורר עבור נק' מאור קייימת") is None
    li = parse_light_item("הוספת מפסק מחליף לנקודת מאור קיימת")
    assert li is not None and li.existing
    li = parse_light_item("הזנות נק' מאור לתאורות דוקרנים כוללות מפסק טיימר משותף בלוח חשמל")
    assert li is not None and li.garden and li.timer and li.fixtures == 0
    li = parse_light_item("נק' מאור ללא מפסק (חיישן תנועה)")
    assert li is not None and li.sensor and li.switches == 0


def test_describe() -> None:
    assert describe(1, 1, "single") == "נק' מאור בודדה כוללת מפסק"
    assert describe(2, 1, "shared") == "שתי נק' מאור כוללות מפסק בודד משותף"
    assert describe(1, 2, "two_way") == "נק' מאור בודדה כוללת שני מפסקים מחליפים"
    assert describe(3, 3, "cross") == "שלוש נק' מאור כוללות שלושה מפסקים מצלבים"
    assert describe(1, 0, "no_switch") == "נק' מאור בודדה ללא מפסק (אפס קבוע)"
    assert describe(7, 0, "timer") == "שבע נק' מאור בהדלקה ע\"י טיימר בלוח"
    assert describe(3, 2, "two_way", stair=True).endswith("עם אוטומט חדר מדרגות")
    assert describe_set(12) == "סט: שירשור 12 נק' מאור משותפות במעגל הדלקה אחד"


def _item(i: int, desc: str, unit: str = "יחידה") -> Item:
    return Item(f"it{i}", f"4.{30 + i}", "04", "חשמל", desc, unit)


TOPOLOGY_LIB = Library(
    [
        _item(1, "נק' מאור בודדה כוללת מפסק"),
        _item(2, "נק' מאור בודדה ללא מפסק (אפס קבוע)"),
        _item(3, "שתי נק' מאור כוללת מפסק בודד משותף"),
        _item(4, "נק' מאור בודדה כוללת שני מפסקים מחליפים"),
        _item(5, "נק' מאור בודדה כוללת שלושה מפסקים מצלבים"),
        _item(6, "שתי נק' מאור כוללות שני מפסקים מחליפים"),
        _item(7, "שבע נק' מאור כוללות מפסק טיימר משותף בלוח חשמל"),
        _item(8, "הזנות נק' מאור לתאורות דוקרנים כוללות מפסק טיימר משותף בלוח חשמל"),
        _item(9, "התקנת גוף תאורה פשוט"),
    ]
)
SET_LIB = Library(
    [
        _item(1, "נק' מאור בודדה"),
        _item(2, "סט: שירשור שתי נק' מאור משותפות במעגל הדלקה אחד", "סט"),
        _item(3, "סט: שירשור ארבע נק' מאור משותפות במעגל הדלקה אחד", "סט"),
        _item(4, "התקנת גוף תאורה פשוט"),
    ]
)


def _circ(tag: str, kind: str, fixtures: list[str], positions: list[str], *, timer: bool = False, stair: bool = False,
          floor: str | None = "ground") -> dict[str, Any]:  # fmt: skip
    return {"id": f"c_{tag}", "tag": tag, "kind": kind, "fixtureIds": fixtures, "switchIds": [], "positionIds": positions,
            "positions": len(positions), "fixtures": len(fixtures), "floor": floor, "timer": timer, "stairAutomat": stair,
            "level": "green", "reasons": [], "evidence": []}  # fmt: skip


def _det(sid: str, did: str, cls: str = "luminaire_ceiling", floor: str | None = "ground") -> Det:
    return Det(sid, "v1", did, cls, 0.0, 0.0, "green", [], floor, "new", None, "lighting")


def _sheet(
    sid: str,
    floors: list[str],
    circuits: list[dict[str, Any]],
    positions: list[dict[str, Any]] | None = None,
    unmatched_tags: list[dict[str, Any]] | None = None,
    det_floor: str | None = None,
) -> CircuitSheet:
    ids = {f for c in circuits for f in c["fixtureIds"]} | {s for p in (positions or []) for s in p.get("switchIds", [])}
    if positions is None:
        positions = [
            {"id": p, "tags": [c["tag"]], "switchIds": [], "bboxMm": {"x": 0, "y": 0, "w": 5, "h": 2}}
            for c in circuits
            for p in c["positionIds"]
        ]
    doc = {
        "schema": "kamutan.circuits/1",
        "circuits": circuits,
        "positions": positions,
        "unmatched": {"fixtureIds": [], "tags": unmatched_tags or [], "texts": []},
        "stats": {"fixtures": len(ids) or 1, "taggedFixtures": len(ids) or 1},
    }
    fl = det_floor or (floors[0] if floors else None)
    dets = {i: _det(sid, i, "switch_single" if i.startswith("s") else "luminaire_ceiling", fl) for i in ids}
    return CircuitSheet(sid, "v1", floors, doc, dets)


def test_topology_wording_units_and_circuit_field() -> None:
    sheet = _sheet("g", ["ground"], [
        _circ("A1", "single", ["d1"], ["p1"]),
        _circ("A2", "shared", ["d2", "d3"], ["p2"]),
        _circ("B1", "two_way", ["d4"], ["p3", "p4"]),
        _circ("C1", "cross", ["d5"], ["p5", "p6", "p7"]),
        _circ("P2", "no_switch", ["d6", "d7"], []),
        _circ("D3", "timer", ["d8", "d9", "d10", "d11", "d12", "d13", "d14"], [], timer=True),
        _circ("D6", "timer", ["d15", "d16", "d17"], [], timer=True),
        _circ("Z9", "shared", ["d18", "d19", "d20"], ["p8"]),  # no 3-fixture line in the library
    ])  # fmt: skip
    res = circuit_units([sheet], [], TOPOLOGY_LIB)
    assert res.stats["wording"] == "topology" and res.covered == {"g"}
    by_desc: dict[str, float] = {}
    for u in res.units:
        key = u.item.description if u.item else f"X {u.unmatched[1]}"
        by_desc[key] = by_desc.get(key, 0) + u.qty
    assert by_desc == {
        "נק' מאור בודדה כוללת מפסק": 1,
        "שתי נק' מאור כוללת מפסק בודד משותף": 1,
        "נק' מאור בודדה כוללת שני מפסקים מחליפים": 1,
        "נק' מאור בודדה כוללת שלושה מפסקים מצלבים": 1,
        "נק' מאור בודדה ללא מפסק (אפס קבוע)": 2,  # אפס קבוע: one point per fixture
        "שבע נק' מאור כוללות מפסק טיימר משותף בלוח חשמל": 1,
        "הזנות נק' מאור לתאורות דוקרנים כוללות מפסק טיימר משותף בלוח חשמל": 1,  # timer without a 3-fixture line
        "X שלוש נק' מאור כוללות מפסק בודד משותף": 1,  # unmatched, red, designer wording
    }
    u = next(u for u in res.units if u.circuit and u.circuit["id"] == "c_B1")
    assert (
        u.circuit == {"id": "c_B1", "kind": "two_way", "fixtures": 1} and u.rule is not None and u.rule.kind == "lighting_circuit"
    )
    garden = next(u for u in res.units if u.item and "דוקרנ" in u.item.description)
    assert garden.reasons  # the fallback is explained


def test_set_wording_units() -> None:
    sheet = _sheet("g", ["ground"], [
        _circ("A1", "single", ["d1"], ["p1"]),
        _circ("A2", "shared", ["d2", "d3"], ["p2"]),
        _circ("A3", "two_way", ["d4", "d5", "d6", "d7"], ["p3", "p4"]),
        _circ("A4", "shared", ["d8", "d9", "d10"], ["p5"]),
        _circ("P1", "no_switch", ["d11"], []),
    ])  # fmt: skip
    res = circuit_units([sheet], [], SET_LIB)
    assert res.stats["wording"] == "set"
    base = [u for u in res.units if u.item and u.item.description == "נק' מאור בודדה"]
    assert len(base) == 5  # one per circuit, whatever the topology
    sets = {(u.item.description if u.item else "X " + u.unmatched[1]): u.qty for u in res.units if u not in base}
    assert sets == {
        "סט: שירשור שתי נק' מאור משותפות במעגל הדלקה אחד": 1,
        "סט: שירשור ארבע נק' מאור משותפות במעגל הדלקה אחד": 1,
        "X סט: שירשור שלוש נק' מאור משותפות במעגל הדלקה אחד": 1,
    }
    assert all(u.item.unit == "סט" for u in res.units if u.item and u.item.description.startswith("סט"))


def test_explicit_wording_param_coverage_gate_and_no_circuits() -> None:
    rule = Rule.from_doc("r_x", {**DEFAULT_RULE_DOC, "match": {"wording": "set"}, "source": "custom"})
    assert rule is not None
    sheet = _sheet("g", ["ground"], [_circ("A1", "single", ["d1"], ["p1"])])
    res = circuit_units([sheet], [rule], TOPOLOGY_LIB)
    # set wording forced on a topology library: the base line falls back to the 1-fixture / 1-switch item
    assert res.stats["wording"] == "set" and res.units and res.units[0].item
    assert res.units[0].item.description == "נק' מאור בודדה כוללת מפסק"
    empty = CircuitSheet("n", "v1", ["ground"], {"circuits": []}, {})
    assert circuit_units([empty], [], TOPOLOGY_LIB).units == [] and circuit_units([], [], TOPOLOGY_LIB).covered == set()
    # Noah: a stray tag read out of SHX noise on an untagged plan (1 of 24 luminaires) prices nothing
    noisy = _sheet("n2", ["ground"], [_circ("L1", "single", ["d1"], ["p1"])])
    noisy.doc["stats"] = {"fixtures": 24, "taggedFixtures": 1}
    res = circuit_units([noisy], [], TOPOLOGY_LIB)
    assert res.units == [] and res.covered == set() and res.stats["skippedSheets"] == ["n2"]


def test_merge_stairs_two_way_across_floors_and_equal_counts_once() -> None:
    """The stair fixtures are drawn on both floors' plans; each floor has its own switch position → one two-way."""
    g = _sheet("g", ["ground"], [_circ("C1", "single", ["g1"], ["p1"]), _circ("C2", "shared", ["g2", "g3"], ["p1"])],
               positions=[{"id": "p1", "tags": ["C1", "C2"], "switchIds": [], "bboxMm": {"x": 0, "y": 0, "w": 5, "h": 2}}])  # fmt: skip
    f = _sheet("f", ["first"], [_circ("C1", "single", ["f1"], ["p1"], floor="first"), _circ("C2", "shared", ["f2", "f3"], ["p1"], floor="first")],
               positions=[{"id": "p1", "tags": ["C1", "C2", "L1"], "switchIds": [], "bboxMm": {"x": 0, "y": 0, "w": 5, "h": 2}}])  # fmt: skip
    merged, stats = merge_circuits([g, f])
    by = {m.tag: m for m in merged}
    assert by["C1"].kind == "two_way" and by["C1"].n == 1 and by["C1"].positions == 2
    assert by["C2"].kind == "two_way" and by["C2"].n == 2
    assert stats["mergedAcrossSheets"] == 2 and stats["differingCounts"] == 0


def test_merge_position_only_view_and_differing_counts() -> None:
    """A floor whose sheet only shows the circuit's switch (stair push-button) still adds a position."""
    b = _sheet("b", ["basement"], [_circ("M1", "shared", ["b1", "b2"], ["p1"], floor="basement")])
    g = _sheet("g", ["ground"], [_circ("Q1", "single", ["g1"], ["p2"])],
               unmatched_tags=[{"tag": "M1", "positionIds": ["p9"], "reason": "x"}],
               positions=[{"id": "p9", "tags": ["M1", "M2"], "switchIds": [], "bboxMm": {"x": 0, "y": 0, "w": 5, "h": 2}},
                          {"id": "p2", "tags": ["Q1"], "switchIds": [], "bboxMm": {"x": 0, "y": 0, "w": 5, "h": 2}}])  # fmt: skip
    merged, _ = merge_circuits([b, g])
    by = {m.tag: m for m in merged}
    assert by["M1"].kind == "two_way" and by["M1"].n == 2 and by["M1"].positions == 2
    # different fixture counts on adjacent floors = distinct fixtures (a double-height space): summed, flagged
    g2 = _sheet("g2", ["ground"], [_circ("L1", "single", ["x1"], ["p1"])])
    f2 = _sheet("f2", ["first"], [_circ("L1", "shared", ["y1", "y2"], ["p1"], floor="first")])
    (m,) = merge_circuits([g2, f2])[0]
    assert m.n == 3 and m.positions == 2 and m.reasons


def test_merge_splits_far_apart_floors_and_skips_compilation_sheets() -> None:
    b = _sheet("b", ["basement"], [_circ("L1", "single", ["b1"], ["p1"], floor="basement")])
    f = _sheet("f", ["first"], [_circ("L1", "shared", ["f1", "f2"], ["p1"], floor="first")])
    merged, stats = merge_circuits([b, f])
    assert sorted(m.tag for m in merged) == ["L1/1", "L1/2"] and stats["splitByFloor"] == 1
    assert {m.kind for m in merged} == {"single", "shared"}
    # a sheet compiling all floors (its tags cover the floor sheets') is used only for tags no floor sheet has
    allf = _sheet("all", [], [_circ("L1", "shared", ["a1", "a2", "a3"], ["p1", "p2"], floor=None), _circ("Z1", "single", ["a9"], ["p3"], floor=None)],
                  det_floor=None)  # fmt: skip
    merged, stats = merge_circuits([b, f, allf])
    assert stats["compilationSheets"] == ["all"]
    assert sorted(m.tag for m in merged) == ["L1/1", "L1/2", "Z1"]


def test_aggregate_line_carries_circuit_and_suppresses_composite_groups() -> None:
    """End to end through boq.aggregate: a lighting sheet with a circuits artifact → "נק' מאור" lines with ``circuit``,
    no composite_lighting line for the same switches."""
    from kamutan_drawing.boq.aggregate import SheetInput, aggregate
    from kamutan_drawing.boq.contracts import LinkGroup
    from kamutan_drawing.boq.rules import default_rules

    dets = [lum(1, 20, 20), lum(2, 40, 20), sw(3, 20, 60), sw(4, 60, 60)]
    circuits = {
        "schema": "kamutan.circuits/1",
        "circuits": [_circ("A1", "two_way", ["d_1", "d_2"], ["sp_1", "sp_2"])],
        "positions": [{"id": "sp_1", "tags": ["A1"], "switchIds": ["d_3"], "bboxMm": {"x": 18, "y": 58, "w": 4, "h": 4}},
                      {"id": "sp_2", "tags": ["A1"], "switchIds": ["d_4"], "bboxMm": {"x": 58, "y": 58, "w": 4, "h": 4}}],
        "unmatched": {"fixtureIds": [], "tags": [], "texts": []},
        "stats": {"fixtures": 2, "taggedFixtures": 2},
    }  # fmt: skip
    links = [LinkGroup.model_validate({"id": "lk_1", "kind": "two_way", "switchIds": ["d_3", "d_4"], "pointIds": [], "luminaireIds": ["d_1", "d_2"],
                                       "confidence": 0.9, "level": "green", "reasons": [], "floor": "ground"})]  # fmt: skip
    sheet = SheetInput("s1", "v1", "lighting", 50, ["ground"], (594.0, 420.0, 0), dets, links, regions=[], circuits=circuits)
    rules = [r for r in default_rules() if r.kind in ("composite_lighting", "install_count")]
    res = aggregate([sheet], rules, TOPOLOGY_LIB)
    light = [ln for ln in res.lines if "מאור" in ln.description]
    assert len(light) == 1 and light[0].qty == 1
    assert light[0].circuit == {"id": "c_A1", "kind": "two_way", "fixtures": 2}
    assert light[0].computed_fields()["circuit"] == light[0].circuit
    ev_ids = {e["detectionId"] for e in light[0].evidence}
    assert ev_ids == {"d_1", "d_2", "d_3", "d_4"}
    assert res.stats["lightingCircuits"]["sheets"] == ["s1"]
    # the same two-way link group is not counted again by the composite rule
    assert not any(ln.rule_id and ln.rule_id.startswith("r_light_") for ln in res.lines)
    # without the artifact nothing changes: the composite rule prices the group as before Sprint 10
    plain = SheetInput("s1", "v1", "lighting", 50, ["ground"], (594.0, 420.0, 0), dets, links, regions=[])
    res2 = aggregate([plain], rules, TOPOLOGY_LIB)
    assert any(ln.rule_id and ln.rule_id.startswith("r_light_") for ln in res2.lines) or any(
        ln.chapter == "לא משויך" for ln in res2.lines
    )
    assert all(ln.circuit is None for ln in res2.lines)


def test_circuits_doc_validates_against_the_contracts_schema() -> None:
    """The worker's circuits.json.gz matches contracts ``CircuitsArtifact`` (and a line's ``circuit`` ``BoqLineCircuit``)."""
    import json
    from pathlib import Path

    import jsonschema

    p = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "json-schema" / "CircuitsArtifact.json"
    if not p.exists():
        pytest.skip("contracts json-schema not generated")
    dets = [lum(1, 20, 20), lum(2, 40, 20), sw(3, 20, 60), lum(4, 80, 60, "luminaire_wall"), sw(5, 84, 60), lum(6, 120, 20)]
    spans = [tag(21.5, 22, "A1"), tag(41.5, 22, "A1"), tag(18, 62.5, "A1"), tag(90, 90, "Q7"),
             Span((150, 150, 190, 152.5), "תאורות שנדלקות ע\"י שעון שבת (טיימר) בלוח חשמל"), tag(170, 154, "T9")]  # fmt: skip
    doc = build_circuits(spans, dets, sheet_id="s1-p0", regions=PLAN, debug=True)
    assert doc["unmatched"]["fixtureIds"] and doc["circuits"]
    jsonschema.validate(doc, json.loads(p.read_text()))
