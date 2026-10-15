"""Sprint 4 fixtures: synthetic plans (reportlab → pypdfium2 vectors) + sample sheets (local artifacts, skipped
without them)."""

from __future__ import annotations

import copy
import json
from collections import Counter

import jsonschema
import pytest

from kamutan_drawing.fixtures import FIXTURE_CLASSES, FixtureDetection, SheetFixtures, dedupe_floor, detect, fixtures_json
from kamutan_drawing.fixtures import model as M
from kamutan_drawing.fixtures.labels import blocks, classify_text, labels, text_items
from kamutan_drawing.rooms import apply_fixtures, segment
from kamutan_drawing.types_sprint2 import BBox, SimpleText

from .pipeline_util import CONTRACTS
from .synth_fixtures import BASINS, REGION, WASHER_C, WC_C, bathroom_sheet, leader
from .test_rooms import _load_artifacts


def _run(vs, text, discipline="plumbing", **kw):
    rooms = segment(vs, text, [REGION], 50)
    fx = detect(vs, text, rooms, discipline, regions=[REGION], **kw)
    return rooms, fx


def _by_cls(fx):
    return Counter(f.cls for f in fx)


# ---------------------------------------------------------------- labels


@pytest.mark.parametrize(
    "text,kind",
    [
        ("מרכז ניאגרה", "wc_concealed"),
        ("מרכז ניאגרה / מונובלוק", "wc_monoblock"),
        ("ניאגרה סמויה", "wc_concealed"),
        ("ברז לניאגרה", None),
        ("נק' מים+ביוב", "sink_point"),
        ("ברז קיר 110", "faucet_wall"),
        ("ברז פרח", "faucet_basin"),
        ("ניקוז + גז למזגן", "ac"),
        ("למ.א, להצמיד", "ac"),
        ("פירוק מזגן עילי", None),
        ("נק' מים וניקוז למכונת +", "washer"),
        ("מ.כ", "washer"),
        ("אינטרפוץ 3 דרך 90", "mixer"),
        ("ראש גשם 230", "shower"),
        ("תעלת ניקוז", "shower"),
        ("ברז גן", "garden_tap"),
        ("נק' מים לתמי 4", "garden_tap"),
        ("מאסטר", None),
    ],
)
def test_label_kinds(text, kind):
    assert classify_text(text)[0] == kind


def test_label_blocks_stack_aligned_lines_only():
    items = text_items(
        [
            SimpleText((10, 10, 30, 12.2), "ברז קיר 110", 0.9),
            SimpleText((12, 12.8, 30, 15.0), "המידה מתייחסת", 0.9),
            SimpleText((10, 15.6, 30, 17.8), "למרכז הפיה", 0.9),
            SimpleText((10, 22.0, 30, 24.2), "ח.רחצה", 0.9),  # too far below: its own block
            SimpleText((60, 12.8, 70, 15.0), "מטבח", 0.9),  # beside, not aligned
        ]
    )
    bl = blocks(items)
    assert sorted(len(b) for b in bl) == [1, 1, 3]
    labs = labels([SimpleText(t.bbox, t.text, t.conf) for t in items])
    assert [lb.kind for lb in labs] == ["faucet_wall"]
    assert "למרכז הפיה" in labs[0].text


# ---------------------------------------------------------------- synthetic plan


def test_shapes_and_labels_on_plumbing_sheet():
    vs, text = bathroom_sheet()
    rooms, fx = _run(vs, text)
    c = _by_cls(fx)
    assert c["fixture_wc_concealed"] == 1
    assert c["fixture_basin"] == 2
    assert c["fixture_bath"] == 1
    assert c["fixture_kitchen_sink"] == 1
    assert c["fixture_washing_machine"] == 1
    assert c["faucet_wall"] == 2  # one "V" leader serves both basins
    assert c["ac_unit"] == 1
    assert c["garden_tap"] == 1
    assert c["fixture_shower"] == 0  # the mixer belongs to the bath
    names = {r.id: r.name for r in rooms}
    for f in fx:
        if f.cls in ("fixture_wc_concealed", "fixture_basin", "fixture_bath", "faucet_wall"):
            assert names[f.room_id] == "חדר רחצה", f
        if f.cls in ("fixture_kitchen_sink", "fixture_washing_machine"):
            assert names[f.room_id] == "מטבח", f
        assert f.level == "green" or f.reasons, f
        assert f.id.startswith("d_fx_")
    wc = next(f for f in fx if f.cls == "fixture_wc_concealed")
    assert wc.source == "shape+text" and wc.level == "green"
    assert abs(wc.center[0] - WC_C[0]) < 4 and abs(wc.center[1] - WC_C[1]) < 2
    washer = next(f for f in fx if f.cls == "fixture_washing_machine")
    assert abs(washer.center[0] - WASHER_C[0]) < 1 and abs(washer.center[1] - WASHER_C[1]) < 1
    bath = next(f for f in fx if f.cls == "fixture_bath")
    assert "אינטרפוץ" in bath.annotations
    tap = next(f for f in fx if f.cls == "garden_tap")
    assert tap.source == "text" and M.R_TEXT_ONLY in tap.reasons and tap.level == "yellow"


def test_faucets_follow_the_v_leader_to_both_basins():
    vs, text = bathroom_sheet()
    _, fx = _run(vs, text)
    ids = {f.id: f for f in fx}
    faucets = [f for f in fx if f.cls == "faucet_wall"]
    served = sorted(ids[f.attached_to].center for f in faucets)
    assert [(round(x), round(y)) for x, y in served] == sorted((round(x), round(y)) for x, y in BASINS)
    for f in faucets:
        assert f.leader and f.level == "green" and "H=110" in f.annotations
        assert ids[f.attached_to].source == "shape+text"  # the faucet note confirms the basin


def test_monoblock_label_sets_the_wc_type():
    vs, text = bathroom_sheet(monoblock=True)
    _, fx = _run(vs, text)
    c = _by_cls(fx)
    assert c["fixture_wc_monoblock"] == 1 and c["fixture_wc_concealed"] == 0


def test_shape_only_on_architecture_sheet():
    vs, text = bathroom_sheet(labels=False)
    _, fx = _run(vs, text, "architecture_master")
    c = _by_cls(fx)
    assert c["fixture_wc_concealed"] == 1 and c["fixture_basin"] == 2 and c["fixture_bath"] == 1
    assert c["ac_unit"] == 0 and c["faucet_wall"] == 0
    wc = next(f for f in fx if f.cls == "fixture_wc_concealed")
    assert wc.level == "yellow" and M.R_SHAPE_ONLY in wc.reasons and M.R_WC_TYPE_SHAPE in wc.reasons


def test_shower_from_mixer_when_the_room_has_no_bath():
    vs, text = bathroom_sheet(with_bath=False)
    _, fx = _run(vs, text)
    showers = [f for f in fx if f.cls == "fixture_shower"]
    assert len(showers) == 1
    assert showers[0].source == "text" and M.R_TEXT_ONLY in showers[0].reasons


def test_discipline_gates():
    vs, text = bathroom_sheet()
    _, fx_e = _run(vs, text + [SimpleText((60, 150, 80, 152.6), "שקע למזגן", 0.9)], "electrical")
    assert {f.cls for f in fx_e} == {"ac_unit"}
    assert len(fx_e) == 2
    _, fx_d = _run(vs, text, "demolition")
    assert fx_d == []
    _, fx_l = _run(vs, text, "lighting")
    assert fx_l == []


def test_electrical_ac_snaps_to_socket_detection():
    vs, text = bathroom_sheet(labels=False)
    text = text + [SimpleText((60, 150, 80, 152.6), "שקע למזגן", 0.9)]
    sock = {"class": "socket_single", "centerMm": {"x": 66.0, "y": 145.0}}
    _, fx = _run(vs, text, "electrical", detections=[sock])
    assert len(fx) == 1 and fx[0].center == (66.0, 145.0) and M.R_AC_FROM_SOCKET in fx[0].reasons


def test_overhead_ac_note_joins_the_drain_note():
    vs, text = bathroom_sheet(labels=False)
    text = text + [
        SimpleText((165.0, 68.0, 180.0, 70.6), "ניקוז + גז למזגן", 0.9),
        SimpleText((166.0, 60.0, 176.0, 62.6), "מזגן עילי", 0.9),
        SimpleText((20.0, 60.0, 35.0, 62.6), "ניקוז + גז למזגן", 0.9),  # another unit, outside
    ]
    _, fx = _run(vs, text)
    assert _by_cls(fx)["ac_unit"] == 2


def test_dry_room_drops_unconfirmed_shapes():
    vs, text = bathroom_sheet(labels=False)
    text = [SimpleText((100.0, 60.0, 112.0, 63.0), "חדר שינה", 0.95), text[1]]
    _, fx = _run(vs, text, "architecture_master")
    c = _by_cls(fx)
    assert c["fixture_bath"] == 0 and c["fixture_wc_concealed"] == 0 and c["fixture_basin"] == 0
    assert c["fixture_kitchen_sink"] == 1  # the kitchen is unaffected


def test_text_only_item_at_leader_end_when_no_shape():
    def extra(c, ps):
        leader(c, ps, (60.0, 170.0), (45.0, 170.0), (40.0, 160.0))

    vs, text = bathroom_sheet(labels=False, extra=extra)
    text = text + [SimpleText((45.0, 167.0, 60.0, 169.6), "מרכז ניאגרה", 0.9)]
    _, fx = _run(vs, text)
    wcs = [f for f in fx if f.cls == "fixture_wc_concealed" and f.source == "text"]
    assert len(wcs) == 1
    assert abs(wcs[0].center[0] - 40.0) < 0.5 and abs(wcs[0].center[1] - 160.0) < 0.5
    assert M.R_TEXT_ONLY in wcs[0].reasons


def test_apply_fixtures_types_rooms():
    vs, text = bathroom_sheet()
    text = [t for t in text if t.text not in ("חדר רחצה",)]  # unnamed bathroom
    rooms, fx = _run(vs, text)
    apply_fixtures(rooms, fx)
    a = next(r for r in rooms if r.area_m2 > 10)
    assert a.type == "bathroom" and a.wet and a.type_source == "fixtures"
    b = next(r for r in rooms if r.name == "מטבח")
    assert b.type == "kitchen" and not b.wet


def _detection_schema():
    path = CONTRACTS / "Detection.json"
    if not path.is_file():
        pytest.skip("contracts not available")
    schema = json.loads(path.read_text())
    enum = schema["definitions"]["Detection"]["properties"]["class"]["enum"]
    for c in FIXTURE_CLASSES:  # classes requested from the Data / API agents (Sprint-4 brief)
        if c not in enum:
            enum.append(c)
    return schema


def test_json_matches_detection_contract():
    vs, text = bathroom_sheet()
    _, fx = _run(vs, text)
    schema = _detection_schema()
    for f in fx:
        jsonschema.validate(f.to_json(), schema)
    doc = fixtures_json(fx)
    assert doc["schema"] == "kamutan.fixtures/1"
    faucet = next(d for d in doc["fixtures"] if d["class"] == "faucet_wall")
    assert faucet["attachedTo"].startswith("d_fx_") and faucet["source"] == "shape+text" and faucet["leaderMm"]


def test_detect_is_deterministic():
    vs, text = bathroom_sheet()
    a = [f.to_json(extended=True) for f in _run(vs, text)[1]]
    b = [f.to_json(extended=True) for f in _run(vs, text)[1]]
    assert a == b


# ---------------------------------------------------------------- cross-sheet de-dup


def _fd(i, cls, x, y, source="shape", reasons=None, score=0.7):
    f = FixtureDetection(id=f"d_fx_{i}", cls=cls, center=(x, y), bbox=BBox(x - 2, y - 2, 4, 4), score=score, source=source)
    f.reasons = list(reasons or ([M.R_SHAPE_ONLY] if source == "shape" else [M.R_TEXT_ONLY]))
    f.relevel()
    return f


def test_dedupe_floor_merges_translated_copies():
    plumb = [
        _fd(1, "fixture_wc_monoblock", 100, 100, "text"),
        _fd(2, "fixture_basin", 120, 100, "text"),
        _fd(3, "fixture_shower", 110, 120, "text"),
        _fd(4, "ac_unit", 50, 50, "text"),
    ]
    arch = [
        _fd(1, "fixture_wc_concealed", 130.4, 60.2),
        _fd(2, "fixture_kitchen_sink", 150.3, 60.1),
        _fd(3, "fixture_bath", 300, 300),
    ]
    out = dedupe_floor(
        [
            SheetFixtures("arch", "architecture_master", "ground", arch, 50, (420, 297)),
            SheetFixtures("plumb", "plumbing", "ground", plumb, 50, (420, 297)),
        ]
    )
    c = Counter(f.cls for f in out)
    assert c == {"fixture_wc_monoblock": 1, "fixture_kitchen_sink": 1, "fixture_shower": 1, "ac_unit": 1, "fixture_bath": 1}
    wc = next(f for f in out if f.cls == "fixture_wc_monoblock")
    assert wc.sheet_id == "plumb" and wc.duplicates == ["arch/d_fx_1"]
    assert wc.source == "shape+text" and M.R_TEXT_ONLY not in wc.reasons and wc.score >= 0.85
    sink = next(f for f in out if f.cls == "fixture_kitchen_sink")
    assert sink.sheet_id == "plumb"  # the label's sheet keeps the item, the drawing gives the sink type
    # inputs untouched
    assert plumb[0].duplicates == [] and arch[0].cls == "fixture_wc_concealed"


def test_dedupe_floor_without_alignment_keeps_both_with_reason():
    a = [_fd(1, "fixture_basin", 10, 10)]
    b = [_fd(1, "fixture_bath", 200, 200)]
    out = dedupe_floor(
        [
            SheetFixtures("a", "plumbing", "first", a, 50, (420, 297)),
            SheetFixtures("b", "construction", "first", b, 50, (297, 420)),
        ]
    )
    assert len(out) == 2
    assert M.R_ALIGN_FAILED in next(f for f in out if f.sheet_id == "b").reasons


def test_dedupe_floor_room_alignment():
    """Room outlines align two sheets even when no fixture pair votes."""
    rooms_a = [
        [(0, 0), (40, 0), (40, 30), (0, 30)],
        [(40, 0), (60, 0), (60, 30), (40, 30)],
        [(0, 30), (25, 30), (25, 50), (0, 50)],
    ]
    shift = (113.5, -20.25)
    rooms_b = [[(x + shift[0], y + shift[1]) for x, y in r] for r in rooms_a]
    a = [_fd(1, "fixture_basin", 50, 10, "text")]
    b = [_fd(1, "fixture_basin", 50 + shift[0], 10 + shift[1])]
    out = dedupe_floor(
        [
            SheetFixtures("a", "plumbing", "first", a, 50, (420, 297), room_polygons=rooms_a),
            SheetFixtures("b", "construction", "first", b, 50, (297, 420), room_polygons=rooms_b),
        ]
    )
    assert len(out) == 1 and out[0].duplicates == ["b/d_fx_1"]


# ---------------------------------------------------------------- sample sheets (local artifacts)

FIRST_FLOOR = {"first"}


def _sample_fixtures(fid, floors=None):
    vs, text, e = _load_artifacts(fid)
    regs = copy.deepcopy(e["regions"])
    for r in regs:
        if floors and r["id"] in floors:
            r["floor"] = floors[r["id"]]
    rooms = segment(vs, text, regs, e["scaleDenominator"])
    fx = detect(vs, text, rooms, e["discipline"], regions=regs, scale_denominator=e["scaleDenominator"])
    return e, rooms, fx


def test_sample_first_floor_plumbing(sample_dir):
    _, rooms, fx = _sample_fixtures("2a308827")
    c = _by_cls(fx)
    assert c["fixture_wc_concealed"] == 2
    assert c["faucet_wall"] == 3
    assert c["fixture_bath"] == 1
    assert c["fixture_shower"] == 1
    assert c["fixture_washing_machine"] == 1
    assert c["fixture_basin"] == 3
    assert c["ac_unit"] == 5
    names = {r.id: r.name for r in rooms}
    for f in fx:
        if f.cls in ("fixture_wc_concealed", "fixture_bath", "faucet_wall"):
            assert names.get(f.room_id) == "חדר רחצה"


def test_sample_basement_and_ground_plumbing(sample_dir):
    _, _, fx_b = _sample_fixtures("24ab0ea0")
    cb = _by_cls(fx_b)
    assert cb["fixture_wc_monoblock"] == 1 and cb["fixture_wc_concealed"] == 0
    assert cb["fixture_shower"] == 1 and cb["ac_unit"] == 2 and cb["fixture_washing_machine"] == 1
    _, _, fx_g = _sample_fixtures("8d51ed5a")
    cg = _by_cls(fx_g)
    assert cg["fixture_wc_concealed"] == 1 and cg["garden_tap"] == 2 and cg["fixture_kitchen_sink"] == 1


def test_sample_electrical_ac_positions(sample_dir):
    _, _, fx = _sample_fixtures("c054fd3a")
    assert {f.cls for f in fx} == {"ac_unit"}
    assert 6 <= len(fx) <= 7
    _, _, fx_g = _sample_fixtures("eb8be8a3")
    assert len(fx_g) == 2


def test_sample_first_floor_dedupe_across_sheets(sample_dir):
    from kamutan_drawing.fixtures import anchors_from_rooms

    sheets = []
    for fid, floors in (("2a308827", None), ("8099ab2c", None), ("6fa88f92", {"r1": "first"}), ("c054fd3a", {"r1": "first"})):
        e, rooms, fx = _sample_fixtures(fid, floors)
        mine = [f for f in fx if f.floor == "first"]
        rr = [r for r in rooms if r.floor == "first"]
        sheets.append(
            SheetFixtures(
                fid,
                e["discipline"],
                "first",
                mine,
                50,
                (e["page"]["widthMm"], e["page"]["heightMm"]),
                anchors_from_rooms(rr),
                [r.polygon_mm for r in rr],
            )
        )
    out = dedupe_floor(sheets)
    c = Counter(f.cls for f in out)
    assert c["fixture_wc_concealed"] == 2 and c["fixture_bath"] == 1 and c["fixture_basin"] == 3
    assert c["ac_unit"] == 5 and c["faucet_wall"] == 3
    assert all(f.sheet_id == "2a308827" for f in out if f.cls.startswith("fixture_wc"))
