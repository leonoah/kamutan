"""Sprint 7 (Worker-Accuracy): drawn heights (sections, opening marks, "H" + number, low walls, shared across a
floor's sheets), 7.04 access panels per AC closure, and the two-way pairing at crossing arcs."""

from __future__ import annotations

import copy
from typing import Any

import pytest
from shapely.geometry import box as sbox

from kamutan_drawing.geometry import geometry_units
from kamutan_drawing.geometry import labels as L
from kamutan_drawing.geometry import marks as MK
from kamutan_drawing.geometry import sections as SEC
from kamutan_drawing.geometry.analyze import measures
from kamutan_drawing.geometry.project import share_heights
from kamutan_drawing.links.graph import R_PAIRED, R_PARTNER, pair_two_ways
from kamutan_drawing.textitems import extract

from .test_geometry import BLACK, REG, ROOM, Sheet, house, measure, run, text


# ---------------------------------------------------------------------------------------------- opening / H marks
def test_parse_marks_sill_head_and_h() -> None:
    m = MK.parse_marks("120\nU.K=75\nO.K=210\nLLLL")
    assert (m.sill_m, m.head_m, m.opening_m) == (0.75, 2.10, 1.35)
    assert MK.parse_marks("0.K=210").head_m == 2.10 and MK.parse_marks("0.K=210").opening_m == 2.10  # door: from the floor
    assert MK.parse_marks("H=140").h_m == 1.40
    assert MK.parse_marks("O.K=210 O.K=220").head_m is None  # two openings in one box: no reading
    assert MK.parse_marks("O.K=9").empty and MK.parse_marks("").empty


def _glyphs(s: Sheet, x: float, y: float, n: int = 12) -> Sheet:
    """Small dark strokes (a rotated word the glyph reader could not read)."""
    for k in range(n):
        s.line([(x, y + 1.2 * k), (x + 1.5, y + 1.2 * k + 0.8)], BLACK, 0.18)
    return s


def test_read_marks_renders_only_text_strokes_near_the_anchor_and_survives_ocr_failure() -> None:
    s = _glyphs(house(Sheet()), 95, 120)
    vs = s.build()
    seen: list[tuple[int, int]] = []

    def ocr(img: Any, psm: int) -> str:
        seen.append(img.size)
        return "U.K=75\nO.K=210"

    got = MK.read_marks(vs, [(105, 120, 106.5, 144), (250, 250, 251, 251)], ocr=ocr)
    assert got[0].opening_m == 1.35 and got[1].empty  # no strokes near the second anchor: not read at all
    assert len(seen) == len(MK.ROTATIONS)

    def broken(img: Any, psm: int) -> str:
        raise OSError("tesseract missing")

    assert all(m.empty for m in MK.read_marks(vs, [(105, 120, 106.5, 144)], ocr=broken))


def test_window_closure_height_from_its_opening_marks() -> None:
    s = _glyphs(house(Sheet()), 98, 122)
    s.line([(105, 120), (105, 144)]).line([(106.5, 120), (106.5, 144)])  # window closure, 1.2 m
    spans = [text("סגירה פנימית לחלון קיים בגבס", 108.5, 125, 140, 127.3)]
    from kamutan_drawing.geometry import analyze

    doc = analyze(s.build(), spans, sheet_id="s1", discipline="architecture_master", regions=REG, scale_den=50,
                  rooms=[ROOM], marks_ocr=lambda img, psm: "U.K=75 O.K=210")  # fmt: skip
    wc = next(ln for ln in doc["lines"] if ln["kind"] == "window_closure")
    assert wc["heightM"] == 1.35 and wc["heightSource"] == "opening_mark"
    win = measure(doc, "window_closure_area")
    assert win is not None and win["computable"] and win["qty"] == pytest.approx(1.2 * 1.35, rel=0.03)
    assert doc["stats"]["heights"]["used"] >= 1
    off = analyze(s.build(), spans, sheet_id="s1", discipline="construction", regions=REG, scale_den=50, rooms=[ROOM],
                  read_marks=False)  # fmt: skip
    assert not measure(off, "window_closure_area")["computable"]  # type: ignore[index]


def test_h_and_number_read_apart_take_the_number_on_the_same_row() -> None:
    blk = [text("קיר נמוך", 169, 123.3, 179, 125.6), text("140", 174.3, 126.8, 179.1, 128.8), text("y H", 166.8, 126.8, 171, 128.8),
           text("100", 166.1, 133.7, 172.2, 136.3)]  # fmt: skip
    assert L._h_beside_number(blk) == [1.40]  # not the "100" dimension one row below


def test_low_wall_drawn_as_three_sides_against_a_wall_counts_with_its_height() -> None:
    s = house(Sheet())
    # 1.0 m × 0.10 m low wall, its open end on the existing wall at x = 296
    s.line([(296, 131.32), (276, 131.32), (276, 133.31), (296, 133.31)])
    spans = [text("קיר נמוך", 285, 123.3, 295, 125.6), text("H", 283, 126.8, 284, 128.8), text("140", 286, 126.8, 291, 128.8)]
    doc = run(s.build(), spans)
    low = [w for w in doc["wallRuns"] if w["kind"] == "low_wall"]
    assert len(low) == 1 and low[0]["heightM"] == 1.4 and low[0]["lengthM"] == pytest.approx(1.0, rel=0.03)
    part = measure(doc, "gypsum_partition_area")
    assert part is not None and part["qty"] == pytest.approx(1.4, rel=0.03)  # a thin low wall is a partition of that height
    # an open U whose missing side is long is not a wall stub
    s2 = house(Sheet())
    s2.line([(296, 131.32), (276, 131.32), (276, 150), (296, 150)])
    assert not [w for w in run(s2.build(), spans)["wallRuns"] if w["kind"] == "low_wall"]


# ---------------------------------------------------------------------------------------------------- sections
def test_section_scale_from_level_marks_signed_or_depths() -> None:
    sc = SEC.section_scale([(62, 221.8, 0.65), (62, 237.8, 0.25), (62, 247.8, 0.0)])
    assert sc is not None and sc[0] == pytest.approx(40.0, rel=0.01)  # 1:25
    # a basement section read without the "-": depths below the datum
    sc2 = SEC.section_scale([(400, 109, 0.50), (400, 117, 0.70), (254, 185, 2.57)])
    assert sc2 is not None and sc2[0] == pytest.approx(36.6, rel=0.03)
    assert SEC.section_scale([(0, 100, 0.0), (0, 120, 1.0), (0, 130, 2.0)]) is None  # inconsistent pairs
    assert SEC.section_scale([(0, 100, 0.5)]) is None


def test_section_wall_strip_merged_across_an_interruption() -> None:
    upper, lower = sbox(48.0, 145.2, 50.8, 225.3), sbox(48.0, 241.3, 50.8, 251.3)
    levels = [(62, 221.8, 0.65), (62, 237.8, 0.25), (62, 247.8, 0.0)]
    notes = [L.Note("פתח שירות בתיאום / אדריכל ויועץ מ.א", (8, 207, 30.7, 212.3), L.flags_of("פתח שירות מ.א"), None,
                    [(49.0, 210.0)])]  # fmt: skip
    walls = SEC.section_walls([upper, lower], levels, notes)
    assert len(walls) == 1 and walls[0].height_m == pytest.approx(2.65, abs=0.01) and "ac" in walls[0].flags
    # a section without level marks has no scale: nothing read
    assert SEC.section_walls([upper, lower], [], notes) == []
    # a squat region is no wall strip
    assert SEC.vertical_strip(sbox(0, 0, 40, 10)) is None


# ----------------------------------------------------------------------------------------- heights across sheets
def _line(kind: str, length: float, h: float | None, src: str | None) -> dict[str, Any]:
    return {"id": "ln_1", "kind": kind, "lengthM": length, "heightM": h, "heightSource": src, "floor": "ground",
            "level": "yellow", "reasons": ["הגובה אינו מופיע בשרטוט"] if h is None else [], "roomType": None}  # fmt: skip


def _doc(sid: str, disc: str, lines: list[dict[str, Any]]) -> dict[str, Any]:
    d = {"schema": "kamutan.geometry/1", "sheetId": sid, "discipline": disc, "scaleDenominator": 50,
         "heights": [{"floor": "ground", "ceilingM": 2.65, "source": "level_mark"}], "levels": [], "stairs": [],
         "regions": [], "wallRuns": [], "lines": lines, "ceilings": [], "courtyards": [], "stats": {}}  # fmt: skip
    d["measures"] = measures(d)
    return d


def test_a_drawn_height_is_shared_with_the_same_element_on_the_floors_other_sheet() -> None:
    cons = _doc("cons", "construction", [_line("window_closure", 1.20, None, None)])
    mast = _doc("mast", "architecture_master", [_line("window_closure", 1.20, 1.35, "opening_mark")])
    before = copy.deepcopy(cons)
    u = {x["key"]: x for x in geometry_units([cons, mast], keys=["window_closure_area"])}["window_closure_area"]
    assert u["computable"] and u["qty"] == pytest.approx(1.62) and u["refs"][0]["sheetId"] == "cons"  # authority kept
    assert cons == before  # pure: the caller's documents are not changed
    # another length (another window) or two disagreeing donors: nothing shared
    other = _doc("mast", "architecture_master", [_line("window_closure", 2.0, 1.35, "opening_mark")])
    assert not share_heights([cons, other])[0]["measures"][0]["computable"]
    a = _doc("m1", "architecture_master", [_line("window_closure", 1.20, 1.35, "opening_mark")])
    b = _doc("m2", "architecture", [_line("window_closure", 1.20, 1.10, "opening_mark")])
    assert not share_heights([cons, a, b])[0]["measures"][0]["computable"]


# ----------------------------------------------------------------------------------------------- 7.04 panels
def _ln(t: str, x: float, y: float, w: float = 20.0) -> dict[str, Any]:
    return {"text": t, "bboxMm": [x, y, x + w, y + 2.3], "angle": 0.0, "confidence": 0.9, "heightMm": 2.3}


def _panels(lines: list[dict[str, Any]], discipline: str = "construction") -> list[dict[str, Any]]:
    doc = extract(lines, sheet_id="s", discipline=discipline, regions=REG)
    return [it for it in doc["items"] if it["itemCode"] == "7.04"]


def test_access_panels_one_per_ac_closure_with_the_section_note_folded() -> None:
    items = _panels([
        _ln("סגירת גבס למיזוג", 331, 124), _ln("אוויר מעל נגרות", 331, 126.8),
        _ln("סגירת גבס למיזוג", 134, 192), _ln("אוויר בקיר", 134, 194.8), _ln("ראה חתך", 134, 197.6),
        _ln("פתח שירות בתיאום", 8, 207), _ln("אדריכל ויועץ מ.א", 8, 209.8),
        _ln("מזגן עילי", 200, 60, 11),  # a wall unit: no closure, no panel
        _ln("פירוק מזגן עילי", 200, 80),
    ])  # fmt: skip
    counted = [it for it in items if it["qty"]]
    assert len(counted) == 1 and counted[0]["qty"] == 2.0  # the floor's notes in one item: two closures
    assert sum(1 for it in items if it["pairedWith"]) == 2  # the other closure + the "פתח שירות" of the section
    # an access note with no closure is a panel of its own; a ceiling box for an AC unit is one
    assert sum(it["qty"] or 0 for it in _panels([_ln("פתח שירות בתקרה", 50, 50)])) == 1.0
    assert sum(it["qty"] or 0 for it in _panels([_ln("ה.ת 40", 220, 81), _ln("יש לבצע חיזוקים", 220, 83.8),
                                                 _ln("עבור מזגן עילי", 220, 86.6)])) == 1.0  # fmt: skip
    # the warm glyph store reads the box's "H" as "ה": "ה.ת 40" lands in a block of its own — the reinforcement note
    # for the unit still names the box
    assert sum(it["qty"] or 0 for it in _panels([_ln("ה", 227.7, 81, 1.4), _ln("יש לבצע חיזוקים", 220, 83.8),
                                                 _ln("עבור מזגן עילי", 222, 86.6)])) == 1.0  # fmt: skip
    assert _panels([_ln("יש לבצע חיזוקים", 220, 83.8), _ln("עבור תליית טלויזיה", 220, 86.6)]) == []
    # the master plan copies the construction notes: not read there
    assert _panels([_ln("סגירת גבס למיזוג", 331, 124)], discipline="architecture_master") == []


# ------------------------------------------------------------------------------------------------ two-way pairing
def _det(i: str, cls: str, x: float, y: float, lc: str = "new") -> dict[str, Any]:
    return {"id": i, "class": cls, "bboxMm": {"x": x - 1, "y": y - 1, "w": 2, "h": 2}, "centerMm": {"x": x, "y": y},
            "lifecycle": lc}  # fmt: skip


def _grp(kind: str, sw: list[str], pts: list[str], reasons: list[str] | None = None) -> dict[str, Any]:
    return {"id": "", "kind": kind, "switchIds": sw, "pointIds": pts, "luminaireIds": [], "confidence": 0.8, "level": "yellow",
            "reasons": list(reasons or []), "floor": "first", "fan": False, "inferredSwitches": 0, "arcIds": []}  # fmt: skip


DETS = [_det("s", "switch_2way", 274, 248, "existing"), _det("f", "switch_fan", 271, 257), _det("t", "switch_2way", 272, 267)]


def test_crossed_arcs_two_ways_are_paired_and_the_other_switch_takes_the_lone_ones_place() -> None:
    groups = [_grp("add_to_existing", ["s", "f"], ["pt_fan"]), _grp("single", ["t"], ["pt_spot"], [R_PARTNER])]
    out = pair_two_ways(groups, DETS)
    assert out[0]["kind"] == "two_way" and set(out[0]["switchIds"]) == {"s", "t"} and out[0]["pointIds"] == ["pt_fan"]
    assert out[1]["kind"] == "single" and out[1]["switchIds"] == ["f"] and out[1]["fan"] is True
    assert R_PAIRED in out[0]["reasons"] and R_PARTNER not in out[1]["reasons"]
    assert groups[0]["switchIds"] == ["s", "f"]  # pure


def test_two_way_pairing_leaves_unsupported_cases_alone() -> None:
    lone = _grp("single", ["t"], ["pt_spot"], [R_PARTNER])
    # the bed-head switch read as a single switch: no 2-way to pair with (today's Noah run)
    plain = [_det("s", "switch_single", 274, 248), *DETS[1:]]
    assert pair_two_ways([_grp("add_to_existing", ["s", "f"], ["pt_fan"]), lone], plain)[0]["kind"] == "add_to_existing"
    # an added 2-way ("להוסיף מחלף") is alone on purpose
    assert pair_two_ways([_grp("add_to_existing", ["s", "f"], ["pt_fan"]), lone], DETS, added={"t"})[1]["switchIds"] == ["t"]
    # too far apart
    far = [*DETS[:2], _det("t", "switch_2way", 372, 267)]
    assert pair_two_ways([_grp("add_to_existing", ["s", "f"], ["pt_fan"]), lone], far)[1]["switchIds"] == ["t"]
    # two other switches in the circuit: nothing tells which one crossed
    three = [*DETS, _det("g", "switch_single", 276, 250)]
    assert pair_two_ways([_grp("add_to_existing", ["s", "f", "g"], ["pt_fan"]), lone], three)[0]["kind"] == "add_to_existing"
