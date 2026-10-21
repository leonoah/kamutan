"""Sprint 4 rooms: tiling geometry (walls, openings, perimeter, external corners), room types / wet flag, walls
borrowed from a reference sheet, open / slanted doors closed by the other jamb, sheet alignment."""

from __future__ import annotations

import json
from pathlib import Path

import jsonschema
import pytest
from shapely import affinity, union_all
from shapely.geometry import Polygon, box

from kamutan_drawing.ingest.pdf_vector import extract_pdf
from kamutan_drawing.rooms import (
    apply_fixtures,
    reference_walls,
    reference_walls_from_json,
    reference_walls_json,
    rooms_json,
    segment,
)
from kamutan_drawing.rooms.align import align, align_polygons
from kamutan_drawing.rooms.segment import R_BORROWED, R_NOT_CLOSED
from kamutan_drawing.rooms.types import room_type, type_from_name
from kamutan_drawing.types_sprint2 import SimpleText

from .synth import make_pdf
from .test_rooms import GREY, OX, OY, REGION, T, _arc, _label, _line, _load_artifacts, _rect, _sheet, plan

M = 20.0


def _rooms(vs, text=(), **kw):
    return segment(vs, list(text), [REGION], 50, **kw)


def _by_area(rooms, lo, hi):
    return next(r for r in rooms if lo <= r.area_m2 <= hi)


def test_walls_openings_perimeter_of_rectangular_rooms():
    vs, boxes = _sheet()
    rooms = _rooms(vs, [_label(boxes["A"], "חדר רחצה"), _label(boxes["B"], "מטבח")])
    a = _by_area(rooms, 11.0, 12.5)
    b = _by_area(rooms, 5.5, 6.5)
    # B: plain 2 x 3 m rectangle, one door (0.8 m) in its left wall
    assert len(b.walls) == 4
    assert sorted(w["lengthM"] for w in b.walls) == pytest.approx([2.0, 2.0, 3.0, 3.0], abs=0.1)
    assert b.perimeter_m == pytest.approx(10.0, abs=0.15)
    assert [o["kind"] for o in b.openings] == ["door"]
    assert b.openings[0]["widthM"] == pytest.approx(0.8, abs=0.05) and b.openings[0]["heightM"] is None
    door_wall = next(w for w in b.walls if w["id"] == b.openings[0]["wallId"])
    assert door_wall["lengthM"] == pytest.approx(3.0, abs=0.1) and not door_wall["exterior"]
    assert b.external_corners == 0
    # outer walls are exterior, the middle wall is not
    assert sum(w["exterior"] for w in b.walls) == 3
    # A: the window (1.2 m) and the shared door
    kinds = sorted(o["kind"] for o in a.openings)
    assert kinds == ["door", "window"]
    win = next(o for o in a.openings if o["kind"] == "window")
    assert win["widthM"] == pytest.approx(1.2, abs=0.05)
    assert a.type == "bathroom" and a.wet and b.type == "kitchen" and not b.wet
    doc = rooms_json(rooms, extended=True)
    r0 = doc["rooms"][0]
    assert {"type", "wet", "walls", "openings", "externalCorners", "perimeterM"} <= set(r0)
    # the extended document is what rooms.json.gz carries: strict contracts RoomsArtifact
    schema_p = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "json-schema" / "RoomsArtifact.json"
    if schema_p.exists():
        jsonschema.validate(doc, json.loads(schema_p.read_text()))
    assert "externalCornersMm" not in r0 and "typeSource" not in r0
    assert {"externalCornersMm", "typeSource"} <= set(rooms_json(rooms, extras=True)["rooms"][0])
    assert set(rooms_json(rooms)["rooms"][0]) == set(r0) - {
        "type",
        "wet",
        "walls",
        "openings",
        "externalCorners",
        "externalCornersMm",
        "typeSource",
    }


def test_external_corner_of_a_pillar_protruding_into_the_room():
    def draw(c, ps):
        plan(c, ps, door=False)
        # a 0.4 x 0.4 m column in room A's bottom-right corner area, against the bottom wall
        y1 = OY + T + 3.0 * M
        x = OX + T + 2.0 * M
        _rect(c, ps, x, y1 - 0.4 * M, x + 0.4 * M, y1)

    vs = extract_pdf(make_pdf(draw))[0]
    rooms = _rooms(vs)
    a = _by_area(rooms, 10.5, 12.5)
    assert a.external_corners == 2  # two outside corners of the column face the room
    assert len(a.external_corners_mm) == 2


def test_slanted_door_closed_by_the_other_jamb():
    """The arc's closed end does not reach the jamb (door drawn as a 90° swing in a wall at another angle):
    the opening is closed between the hinge and the other jamb, the two rooms stay apart."""

    def draw(c, ps):
        x0, y0 = OX, OY
        xa = x0 + T + 4.0 * M
        xb = xa + T + 2.0 * M
        y1 = y0 + T + 3.0 * M
        _rect(c, ps, x0, y0, xb + T, y0 + T)
        _rect(c, ps, x0, y1, xb + T, y1 + T)
        _rect(c, ps, x0, y0, x0 + T, y1 + T)
        _rect(c, ps, xb, y0, xb + T, y1 + T)
        d0 = y1 - 0.2 * M - 0.8 * M
        _rect(c, ps, xa, y0, xa + T, d0)
        _rect(c, ps, xa, d0 + 0.8 * M, xa + T, y1)
        hx, hy = xa + T, d0 + 0.8 * M
        # leaf open towards +x, arc swinging 135° from +x through +y (down) — never reaching the upper jamb
        _line(c, ps, (hx, hy), (hx + 0.8 * M, hy))
        _arc(c, ps, hx, hy, 0.8 * M, -135, 0)

    vs = extract_pdf(make_pdf(draw))[0]
    rooms = _rooms(vs)
    areas = sorted(round(r.area_m2, 1) for r in rooms)
    assert len(rooms) == 2, areas
    assert areas[0] == pytest.approx(6.0, abs=0.4) and areas[1] == pytest.approx(12.0, abs=0.5)
    doors = [o for r in rooms for o in r.openings if o["kind"] == "door"]
    assert doors and all(o["widthM"] == pytest.approx(0.8, abs=0.15) for o in doors)


def _thin_partition_sheets():
    """(MEP sheet without the middle wall, architecture sheet with it, drawn 37 mm right / 12 mm up)."""

    def mep(c, ps):
        x0, y0 = OX, OY
        xb = x0 + T + 4.0 * M + T + 2.0 * M
        y1 = y0 + T + 3.0 * M
        _rect(c, ps, x0, y0, xb + T, y0 + T)
        _rect(c, ps, x0, y1, xb + T, y1 + T)
        _rect(c, ps, x0, y0, x0 + T, y1 + T)
        _rect(c, ps, xb, y0, xb + T, y1 + T)

    def arch(c, ps):
        c.translate(37.0 * 72 / 25.4, 12.0 * 72 / 25.4)
        plan(c, ps, door=False, window=False)

    return extract_pdf(make_pdf(mep))[0], extract_pdf(make_pdf(arch))[0]


def test_borrowed_partition_splits_merged_rooms():
    vs_mep, vs_arch = _thin_partition_sheets()
    alone = _rooms(vs_mep)
    assert len(alone) == 1 and alone[0].area_m2 == pytest.approx(18.8, abs=0.6)
    region_arch = dict(REGION, polygonMm=[{"x": 20, "y": 0}, {"x": 340, "y": 0}, {"x": 340, "y": 200}, {"x": 20, "y": 200}])
    refs = reference_walls(vs_arch, [region_arch], 50, sheet_id="arch")
    assert refs and refs[0].floor == "ground"
    refs = reference_walls_from_json(reference_walls_json(refs))  # stored + reloaded
    rooms = _rooms(vs_mep, reference_walls=refs)
    areas = sorted(round(r.area_m2, 1) for r in rooms)
    assert len(rooms) == 2, areas
    assert areas[0] == pytest.approx(6.0, abs=0.4) and areas[1] == pytest.approx(12.0, abs=0.5)
    assert all(R_BORROWED in r.reasons and r.level == "yellow" for r in rooms)
    # another floor's reference is ignored
    other = [type(refs[0])("first", 50, refs[0].walls, "arch", "r0", refs[0].closures)]
    assert len(_rooms(vs_mep, reference_walls=other)) == 1


def test_align_translation_and_polygons():
    a = union_all([box(0, 0, 100, 5), box(0, 0, 5, 60), box(40, 0, 45, 60), box(0, 55, 100, 60), box(95, 0, 100, 60)])
    al = align(a, affinity.translate(a, 37.25, -12.5))
    assert al is not None and al.dx == pytest.approx(37.25, abs=0.3) and al.dy == pytest.approx(-12.5, abs=0.3)
    assert al.iou > 0.9
    polys = [[(0, 0), (40, 0), (40, 30), (0, 30)], [(40, 0), (60, 0), (60, 30), (40, 30)]]
    moved = [[(x - 80.5, y + 140.0) for x, y in p] for p in polys]
    ap = align_polygons(polys, moved)
    assert ap is not None and ap.dx == pytest.approx(-80.5, abs=0.3) and ap.dy == pytest.approx(140.0, abs=0.3)
    assert align(Polygon(), a) is None


@pytest.mark.parametrize(
    "name,fixtures,area,expected",
    [
        ("חדר רחצה", [], 5.0, ("bathroom", True)),
        ("שירותים", ["fixture_wc_concealed", "fixture_basin"], 2.2, ("wc", True)),
        (None, ["fixture_wc_monoblock", "fixture_basin", "fixture_shower"], 3.7, ("bathroom", True)),
        (None, ["fixture_wc_concealed"], 2.0, ("wc", True)),
        (None, ["fixture_kitchen_sink"], 20.0, ("kitchen", False)),
        ("חדר שינה / חדר כביסה", ["fixture_washing_machine"], 9.0, ("bedroom", False)),
        ("חדר כביסה", [], 4.0, ("other", True)),
        ("סלון / פינת אוכל / מטבח", ["fixture_kitchen_sink"], 25.0, ("living", False)),
        ("חדר שינה", ["fixture_basin"], 12.0, ("bedroom", False)),
        ("מסדרון", [], 6.0, ("corridor", False)),
        ("חדר מדרגות", [], 6.0, ("stairs", False)),
        ("פטיו", [], 6.0, ("courtyard", False)),
    ],
)
def test_room_types(name, fixtures, area, expected):
    t, wet, _ = room_type(name, fixtures, area)
    assert (t, wet) == expected


def test_type_from_name_merged():
    assert type_from_name("חדר שינה / חדר רחצה") == "bathroom"
    assert type_from_name(None) is None
    assert type_from_name("שם לא מוכר") is None


def test_apply_fixtures_accepts_detection_dicts():
    vs, _boxes = _sheet()
    rooms = _rooms(vs)
    a = _by_area(rooms, 11.0, 12.5)
    assert a.type == "other" and not a.wet
    apply_fixtures(rooms, [{"class": "fixture_bath", "roomId": a.id}])
    assert a.type == "bathroom" and a.wet and a.type_source == "fixtures"


def test_open_room_still_has_geometry():
    vs, _ = _sheet(gap_wall=True)
    rooms = _rooms(vs, [SimpleText((150, 60, 160, 63), "מטבח", 0.9)])
    for r in rooms:
        assert r.walls and r.perimeter_m > 0
    assert any(R_NOT_CLOSED in r.reasons for r in rooms) or len(rooms) == 1


# ---------------------------------------------------------------- sample sheets (local artifacts)


def test_sample_mep_basement_split_with_reference(sample_dir):
    vs, text, e = _load_artifacts("c054fd3a")
    vs_c, _, e_c = _load_artifacts("ad257a1c")
    refs = reference_walls(vs_c, e_c["regions"], 50, sheet_id="ad257a1c")
    rooms = segment(vs, text, e["regions"], 50, reference_walls=refs)
    base = sorted(round(r.area_m2, 1) for r in rooms if r.floor == "basement" and not r.niche)
    assert len(base) == 3, base  # bedroom / living+kitchen / bathroom (Sprint 2: bedroom+living merged 41.9)
    # Sprint 5: + the bathroom's laundry niche as a sub-room
    assert [r.parent_room_id for r in rooms if r.floor == "basement" and r.niche] == [
        next(r.id for r in rooms if r.floor == "basement" and r.type == "bathroom")
    ]
    assert any(13.5 <= a <= 16.5 for a in base) and any(23.0 <= a <= 27.0 for a in base)


def test_sample_wet_rooms_geometry(sample_dir):
    vs, text, e = _load_artifacts("6fa88f92")
    rooms = segment(vs, text, e["regions"], 50)
    wet = [r for r in rooms if r.wet and not r.niche]
    assert len(wet) == 3
    # Sprint 5: the basement and first-floor general baths each get their laundry niche (sub-room, wet like its parent)
    niches = [r for r in rooms if r.niche]
    assert len(niches) == 2 and {n.parent_room_id for n in niches} <= {r.id for r in wet}
    for r in wet:
        assert r.type == "bathroom"
        assert 3.0 <= r.area_m2 <= 6.5
        assert 7.5 <= r.perimeter_m <= 11.0
        assert any(o["kind"] == "door" and 0.55 <= o["widthM"] <= 0.9 for o in r.openings)
        assert 0 <= r.external_corners <= 4


def test_sample_ground_entrance_door_closed(sample_dir):
    vs, text, e = _load_artifacts("08222cb2")
    rooms = segment(vs, text, e["regions"], 50)
    big = max(rooms, key=lambda r: r.area_m2)
    assert R_NOT_CLOSED not in big.reasons
    assert any(o["kind"] == "door" and o["widthM"] > 1.2 for o in big.openings)  # the wide entrance
    assert 60.0 <= big.area_m2 <= 75.0


_ = GREY  # re-exported helpers of test_rooms used above
