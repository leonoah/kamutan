"""Room segmentation: synthetic plans (reportlab → pypdfium2 vectors) + sample sheets (artifacts)."""

from __future__ import annotations

import json
import math

import pytest
from reportlab.lib.colors import Color
from shapely.geometry import Polygon

from kamutan_drawing.ingest.pdf_vector import extract_pdf
from kamutan_drawing.rooms import assign_room, rooms_json, segment
from kamutan_drawing.rooms.names import match_room_name
from kamutan_drawing.rooms.segment import R_NO_NAME, R_NOT_CLOSED, R_SCALE
from kamutan_drawing.types_sprint2 import Region, SimpleText

from .conftest import DATA_DIR
from .synth import MM, make_pdf, to_pdf_xy

GREY = (201 / 255, 201 / 255, 201 / 255)
M = 20.0  # paper mm per metre at 1:50
OX, OY = 60.0, 40.0  # plan origin on the page (mm)
T = 0.2 * M  # wall thickness 20 cm


def _rect(c, ps, x0, y0, x1, y1, rgb=GREY):
    c.setFillColor(Color(*rgb))
    c.setStrokeColor(Color(0, 0, 0))
    c.setLineWidth(0.1 * MM)
    p = c.beginPath()
    pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    p.moveTo(*to_pdf_xy(*pts[0], ps))
    for q in pts[1:]:
        p.lineTo(*to_pdf_xy(*q, ps))
    p.close()
    c.drawPath(p, fill=1, stroke=1)


def _line(c, ps, a, b, w=0.18):
    c.setStrokeColor(Color(0, 0, 0))
    c.setLineWidth(w * MM)
    c.line(*to_pdf_xy(*a, ps), *to_pdf_xy(*b, ps))


def _arc(c, ps, cx, cy, r, a0, a1):
    """Quarter-circle door swing as a bezier path (angles in degrees, paper frame y-down)."""
    c.setStrokeColor(Color(0, 0, 0))
    c.setLineWidth(0.18 * MM)
    p = c.beginPath()
    # paper y-down -> pdf y-up flips the angle sign
    x, y = to_pdf_xy(cx, cy, ps)
    p.arc(x - r * MM, y - r * MM, x + r * MM, y + r * MM, startAng=-a0, extent=-(a1 - a0))
    c.drawPath(p, fill=0, stroke=1)


def plan(c, ps, *, door=True, window=True, gap_wall=False):
    """Two rooms at 1:50: A = 4.0 x 3.0 m (clear), B = 2.0 x 3.0 m, separated by a wall with a 0.8 m door;
    a 1.2 m window in A's top wall (two glazing lines)."""
    x0, y0 = OX, OY
    xa = x0 + T + 4.0 * M  # inner face of the middle wall
    xb = xa + T + 2.0 * M
    y1 = y0 + T + 3.0 * M
    # outer walls
    if window:
        wx0, wx1 = x0 + T + 1.4 * M, x0 + T + 2.6 * M
        _rect(c, ps, x0, y0, wx0, y0 + T)
        _rect(c, ps, wx1, y0, xb + T, y0 + T)
        for k in (0.35, 0.65):
            _line(c, ps, (wx0, y0 + k * T), (wx1, y0 + k * T))
    else:
        _rect(c, ps, x0, y0, xb + T, y0 + T)
    _rect(c, ps, x0, y1, xb + T, y1 + T)  # bottom
    _rect(c, ps, x0, y0, x0 + T, y1 + T)  # left
    if gap_wall:  # right wall with a 2.5 m hole (room B open to the outside)
        _rect(c, ps, xb, y0, xb + T, y0 + 0.25 * M)
    else:
        _rect(c, ps, xb, y0, xb + T, y1 + T)
    # middle wall with a door (0.8 m) near the bottom
    if door:
        d0 = y1 - 0.2 * M - 0.8 * M
        _rect(c, ps, xa, y0, xa + T, d0)
        _rect(c, ps, xa, d0 + 0.8 * M, xa + T, y1)
        # hinge on the lower jamb, leaf open into room B, swing from closed (up) to open (right)
        hx, hy = xa + T, d0 + 0.8 * M
        _line(c, ps, (hx, hy), (hx + 0.8 * M, hy))
        _arc(c, ps, hx, hy, 0.8 * M, -90, 0)
    else:
        _rect(c, ps, xa, y0, xa + T, y1)
    return {"A": (x0 + T, y0 + T, xa, y1), "B": (xa + T, y0 + T, xb, y1)}


def _sheet(**kw):
    boxes = {}

    def draw(c, ps):
        boxes.update(plan(c, ps, **kw))

    vs = extract_pdf(make_pdf(draw))[0]
    return vs, boxes


def _label(box, text, conf=0.9):
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    return SimpleText((cx - 5, cy - 1.5, cx + 5, cy + 1.5), text, conf)


REGION = {
    "id": "r0",
    "floor": "ground",
    "polygonMm": [{"x": 20, "y": 10}, {"x": 300, "y": 10}, {"x": 300, "y": 200}, {"x": 20, "y": 200}],
    "scaleDenominator": 50,
}


def test_two_closed_rooms_with_names_and_areas():
    vs, boxes = _sheet()
    text = [_label(boxes["A"], "סלון"), _label(boxes["B"], "ח.שינה 1")]
    rooms = segment(vs, text, [REGION], 50)
    assert len(rooms) == 2, [(r.name, r.area_m2) for r in rooms]
    by = {r.name: r for r in rooms}
    a, b = by["סלון"], by["חדר שינה"]
    assert a.area_m2 == pytest.approx(12.0, abs=0.4)
    assert b.area_m2 == pytest.approx(6.0, abs=0.4)
    assert b.perimeter_m == pytest.approx(10.0, abs=0.5)
    for r in (a, b):
        assert r.floor == "ground"
        assert R_NOT_CLOSED not in r.reasons
        assert r.level == "green" and r.reasons == []
        assert r.confidence >= 0.85
    # the door and the window are bridged: the rooms are separate and closed
    assert not Polygon(a.polygon_mm).intersects(Polygon(b.polygon_mm).buffer(-0.5))
    doc = rooms_json(rooms)
    assert doc["schema"] == "kamutan.rooms/1"
    json.dumps(doc)  # serialisable, points are {x,y}
    assert set(doc["rooms"][0]["polygonMm"][0]) == {"x", "y"}
    # point -> room
    ca = boxes["A"]
    assert assign_room(rooms, (ca[0] + ca[2]) / 2, (ca[1] + ca[3]) / 2) is a
    assert assign_room(rooms, 5.0, 5.0) is None


def test_unnamed_room_is_yellow_with_reason():
    vs, _ = _sheet()
    rooms = segment(vs, [], [REGION], 50)
    assert len(rooms) == 2
    assert all(r.name is None and R_NO_NAME in r.reasons and r.level == "yellow" for r in rooms)


def test_scale_changes_area_and_missing_scale_flags():
    vs, _ = _sheet()
    region = dict(REGION, scaleDenominator=None)
    r50 = segment(vs, [], [region], 50)
    r100 = segment(vs, [], [region], 100)  # door / gap thresholds are real-size: the 1.6 m "door" no longer closes
    assert sum(r.area_m2 for r in r100) == pytest.approx(4 * sum(r.area_m2 for r in r50), rel=0.06)
    r_none = segment(vs, [], [region], None)
    assert all(R_SCALE in r.reasons and r.level != "green" for r in r_none)


def test_open_room_flagged_not_closed():
    vs, boxes = _sheet(gap_wall=True)
    rooms = segment(vs, [_label(boxes["A"], "סלון"), _label(boxes["B"], "מחסן")], [REGION], 50)
    by = {r.name: r for r in rooms}
    assert "סלון" in by and R_NOT_CLOSED not in by["סלון"].reasons
    if "מחסן" in by:  # kept only while mostly walled; then it must say so
        assert R_NOT_CLOSED in by["מחסן"].reasons and by["מחסן"].level != "green"


def test_without_door_arc_closing_still_separates_rooms():
    vs, _ = _sheet(door=False, window=False)
    rooms = segment(vs, [], [Region.from_dict(REGION)], 50)
    assert sorted(round(r.area_m2) for r in rooms) == [6, 12]


def test_whole_page_when_no_regions_and_empty_sheet():
    vs, _ = _sheet()
    assert len(segment(vs, [], [], 50)) == 2
    empty = extract_pdf(make_pdf(lambda c, ps: None))[0]
    assert segment(empty, [], [], 50) == []


@pytest.mark.parametrize(
    ("text", "name", "label"),
    [
        ("סלון", "סלון", True),
        ("חדר מגורים", "סלון", True),
        ("ח.שינה 2", "חדר שינה", True),
        ("ח. רחצה הורים", "חדר רחצה", True),
        ('ממ"ד', 'ממ"ד', True),
        ("ממ״ד", 'ממ"ד', True),
        ("ש.אורחים", "שירותים", True),
        ("מטבח", "מטבח", True),
        ("מקלחת", "מקלחת", True),
        ("מרפסת שירות", "מרפסת", True),
        ("פרוזדור", "מסדרון", True),
        ("פירוק מטבח קיים והתקנת חדש בכל הבית", "מטבח", False),  # inside a note: weak
    ],
)
def test_room_name_matching(text, name, label):
    m = match_room_name(text)
    assert m is not None and m.name == name
    assert (m.score >= 0.8) is label


@pytest.mark.parametrize("text", ["", "H=120", "שקע כפול", "1:50", "קיים"])
def test_room_name_rejects_non_names(text):
    assert match_room_name(text) is None


# ---------------------------------------------------------------- sample sheets (local artifacts)

ARTIFACTS = DATA_DIR.parent / "artifacts" if DATA_DIR.name == "sample-noah" else DATA_DIR / "artifacts"


def _load_artifacts(fid: str):
    from kamutan_drawing.pipeline.artifacts import decode_primitives, decode_text
    from kamutan_drawing.types_sprint2 import text_items_from_json, vector_sheet_from_primitives

    idx_path = ARTIFACTS / "dev-index.json"
    if not idx_path.is_file():
        pytest.skip("local artifacts not available (scripts/ingest_local.py)")
    idx = {e["fileId"]: e for e in json.loads(idx_path.read_text())}
    if fid not in idx:
        pytest.skip(f"{fid} not ingested")
    e = idx[fid]
    vs = vector_sheet_from_primitives(decode_primitives((ARTIFACTS / e["primitives"]).read_bytes()))
    text = text_items_from_json(decode_text((ARTIFACTS / e["text"]).read_bytes())["lines"])
    return vs, text, e


def _check_sane(rooms):
    for r in rooms:
        if r.name in ("חדר רחצה", "שירותים", "מקלחת"):
            assert 1.5 <= r.area_m2 <= 8.0, (r.name, r.area_m2)
        if r.name == "חדר שינה":
            assert 7.5 <= r.area_m2 <= 17.0, (r.name, r.area_m2)
        assert r.level in ("green", "yellow", "red")
        assert r.level == "green" or r.reasons
        assert math.isfinite(r.area_m2) and r.area_m2 >= (0.3 if r.niche else 1.0)  # Sprint 5: laundry niches


def test_sample_architecture_basement_and_floor(sample_dir):
    vs, text, e = _load_artifacts("6fa88f92")
    rooms = segment(vs, text, e["regions"], e["scaleDenominator"])
    names = [r.name for r in rooms]
    assert len(rooms) >= 10
    assert sum(1 for r in rooms if r.name == "חדר שינה") >= 4
    assert sum(1 for r in rooms if r.name == "חדר רחצה") >= 3
    # the stacked second plan is the first floor (Sprint-4 floor inference; older artifacts: the title's "ground")
    assert {r.floor for r in rooms} in ({"basement", "first"}, {"basement", "ground"})
    assert "מטבח" in names
    _check_sane(rooms)


@pytest.mark.parametrize("fid", ["08222cb2", "eb8be8a3", "b2046277"])
def test_sample_ground_floor_open_plan(sample_dir, fid):
    vs, text, e = _load_artifacts(fid)
    rooms = segment(vs, text, e["regions"], e["scaleDenominator"])
    big = max(rooms, key=lambda r: r.area_m2)
    assert 55.0 <= big.area_m2 <= 80.0  # living + dining + kitchen + hall (open plan)
    assert big.name and "סלון" in big.name
    wc = [r for r in rooms if r.name == "שירותים"]
    assert wc and 1.5 <= wc[0].area_m2 <= 3.5
    _check_sane(rooms)


def test_sample_electrical_matches_architecture_rooms(sample_dir):
    """The electrical sheet carries the same walls: the first-floor rooms match the architecture sheet."""
    vs_a, tx_a, e_a = _load_artifacts("6fa88f92")
    vs_e, tx_e, e_e = _load_artifacts("c054fd3a")
    upper = e_a["regions"][-1]["floor"]  # "first" since the Sprint-4 floor inference ("ground" before)
    ra = sorted(round(r.area_m2, 1) for r in segment(vs_a, tx_a, e_a["regions"], 50) if r.floor == upper)
    re_ = sorted(round(r.area_m2, 1) for r in segment(vs_e, tx_e, e_e["regions"], 50) if r.floor == upper)
    common = [a for a in ra if any(abs(a - b) <= 0.3 for b in re_)]
    assert len(common) >= 6, (ra, re_)


def test_walls_doors_and_windows_detected():
    from kamutan_drawing.rooms.walls import extract_walls

    vs, _ = _sheet()
    ws = extract_walls(vs, (20, 10, 300, 200), scale_den=50)
    assert ws.source == "fills"
    assert len(ws.door_arcs) == 1
    _, _, r = ws.door_arcs[0]
    assert r == pytest.approx(0.8 * M, abs=0.3)
    assert len(ws.bridges) >= 3  # door bridge + 2 glazing lines
