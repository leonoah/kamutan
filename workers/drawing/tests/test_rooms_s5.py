"""Sprint 5 rooms: laundry niches as sub-rooms (open side, parent's perimeter / corners), and the window whose outer
frame is a jogged polyline (Noah master bath "not closed" regression)."""

from __future__ import annotations

import json
from pathlib import Path

import jsonschema
import pytest
from shapely.geometry import Polygon

from kamutan_drawing.ingest.pdf_vector import extract_pdf
from kamutan_drawing.rooms import apply_fixtures, rooms_json, segment
from kamutan_drawing.rooms.niches import R_NICHE_SHAPE, is_laundry_text, niche_evidence
from kamutan_drawing.rooms.segment import R_NOT_CLOSED
from kamutan_drawing.types_sprint2 import SimpleText

from .synth import MM, make_pdf, to_pdf_xy
from .synth_fixtures import washer
from .test_rooms import _arc, _line, _load_artifacts, _rect

M = 20.0  # paper mm per metre at 1:50
T = 4.0  # 20 cm walls
X0, Y0 = 60.0, 60.0
REGION = {
    "id": "r0",
    "floor": "first",
    "polygonMm": [{"x": 20, "y": 20}, {"x": 300, "y": 20}, {"x": 300, "y": 200}, {"x": 20, "y": 200}],
    "scaleDenominator": 50,
}
SCHEMA = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "json-schema" / "RoomsArtifact.json"

# room A: 3.0 x 2.5 m interior (64..124 x 64..114); niche 0.8 m wide x 0.7 m deep above its top wall (90..106 x 50..64)
A_BOX = (X0 + T, Y0 + T, X0 + T + 3.0 * M, Y0 + T + 2.5 * M)
NX0, NX1, NY0 = 90.0, 106.0, 50.0


def _niche_plan(c, ps, *, washer_in_niche: bool = False):
    ax0, ay0, ax1, ay1 = A_BOX
    _rect(c, ps, X0, Y0, NX0, ay0)  # top wall, left of the mouth
    _rect(c, ps, NX1, Y0, ax1 + T, ay0)  # top wall, right of the mouth
    _rect(c, ps, X0, ay1, ax1 + T, ay1 + T)  # bottom
    _rect(c, ps, X0, Y0, ax0, ay1 + T)  # left
    _rect(c, ps, ax1, Y0, ax1 + T, ay1 + T)  # right
    # the niche: three walls around 90..106 x 50..64 (open towards the room)
    _rect(c, ps, NX0 - T, NY0 - T, NX0, Y0)
    _rect(c, ps, NX1, NY0 - T, NX1 + T, Y0)
    _rect(c, ps, NX0 - T, NY0 - T, NX1 + T, NY0)
    if washer_in_niche:
        washer(c, ps, NX0 + 2.0, NY0 + 1.0)


def _rooms(labels, **kw):
    vs = extract_pdf(make_pdf(lambda c, ps: _niche_plan(c, ps, **kw)))[0]
    cx, cy = (A_BOX[0] + A_BOX[2]) / 2, (A_BOX[1] + A_BOX[3]) / 2
    text = [SimpleText((cx - 6, cy - 1.5, cx + 6, cy + 1.5), labels[0], 0.95)]
    if len(labels) > 1:
        mx, my = (NX0 + NX1) / 2, NY0 + 4.0
        text.append(SimpleText((mx - 2.5, my - 1.2, mx + 2.5, my + 1.2), labels[1], 0.9))
    return segment(vs, text, [REGION], 50)


def _validate(doc):
    if SCHEMA.exists():
        jsonschema.validate(doc, json.loads(SCHEMA.read_text()))


def test_laundry_niche_of_a_bathroom_is_a_sub_room_with_an_open_side():
    rooms = _rooms(["חדר רחצה"])
    parent = next(r for r in rooms if r.type == "bathroom")
    niches = [r for r in rooms if r.niche]
    assert len(niches) == 1, [(r.id, r.type, r.area_m2) for r in rooms]
    n = niches[0]
    assert n.type == "niche" and n.parent_room_id == parent.id and n.id == f"{parent.id}_n1"
    assert n.floor == parent.floor == "first" and n.wet and parent.wet
    assert n.area_m2 == pytest.approx(0.8 * 0.7, abs=0.05)
    assert parent.area_m2 == pytest.approx(3.0 * 2.5, abs=0.15)  # the niche floor is NOT in the parent's area
    # geometry only (no label, no machine drawn): yellow with the reason
    assert n.reasons == [R_NICHE_SHAPE] and n.level == "yellow"
    # the mouth is an open wall of both rooms, not part of either perimeter
    p_open = [w for w in parent.walls if w.get("open")]
    n_open = [w for w in n.walls if w.get("open")]
    assert len(p_open) == 1 and len(n_open) == 1
    assert p_open[0]["lengthM"] == pytest.approx(0.8, abs=0.05) and not p_open[0]["exterior"]
    assert n_open[0]["lengthM"] == pytest.approx(0.8, abs=0.05)
    assert parent.perimeter_m == pytest.approx(2 * (3.0 + 2.5) - 0.8, abs=0.15)
    assert n.perimeter_m == pytest.approx(0.8 + 2 * 0.7, abs=0.1)
    # the ends of the niche's side walls are outside corners of the parent's cladding; none inside the niche
    assert parent.external_corners == 2 and n.external_corners == 0
    # walls of the parent away from the mouth stay closed / unsplit
    assert sum(w["lengthM"] for w in parent.walls if not w.get("open")) == pytest.approx(parent.perimeter_m, abs=0.1)
    assert Polygon(parent.polygon_mm).intersection(Polygon(n.polygon_mm)).area < 1.0
    # contract: type "niche", niche, parentRoomId, walls[].open (Sprint-5 contracts)
    doc = rooms_json(rooms, extended=True)
    jn = next(r for r in doc["rooms"] if r["id"] == n.id)
    assert jn["type"] == "niche" and jn["niche"] is True and jn["parentRoomId"] == parent.id
    jp = next(r for r in doc["rooms"] if r["id"] == parent.id)
    assert "niche" not in jp and "parentRoomId" not in jp
    assert all("open" not in w or w["open"] is True for r in doc["rooms"] for w in r["walls"])
    _validate(doc)
    # the Sprint-2 document (not extended) is unchanged in shape
    assert all("parentRoomId" not in r for r in rooms_json(rooms)["rooms"])


def test_niche_needs_evidence_when_the_parent_is_dry():
    rooms = _rooms(["חדר שינה"])
    assert not any(r.niche for r in rooms)  # a recess of a bedroom (wardrobe alcove) is not a laundry niche
    bed = next(r for r in rooms if r.type == "bedroom")
    assert not any(w.get("open") for w in bed.walls)
    # a laundry label inside the recess is enough
    rooms = _rooms(["חדר שינה", 'מ"כ'])
    n = next(r for r in rooms if r.niche)
    assert n.level == "green" and n.reasons == [] and not n.wet
    # … and so is a washing machine drawn in it
    rooms = _rooms(["חדר שינה"], washer_in_niche=True)
    n = next(r for r in rooms if r.niche)
    assert n.level == "green" and n.parent_room_id == next(r for r in rooms if r.type == "bedroom").id


def test_apply_fixtures_keeps_niches_and_confirms_them_with_a_washer():
    rooms = _rooms(["חדר רחצה"])
    n = next(r for r in rooms if r.niche)
    parent = next(r for r in rooms if r.id == n.parent_room_id)
    fx = [{"class": "fixture_washing_machine", "roomId": n.id}, {"class": "fixture_shower", "roomId": parent.id}]
    apply_fixtures(rooms, fx)
    assert n.type == "niche" and n.wet and parent.type == "bathroom"
    assert R_NICHE_SHAPE not in n.reasons and n.level == "green"
    # a WC standing in a "niche" flags it (a WC alcove read as a laundry niche)
    apply_fixtures(rooms, [{"class": "fixture_wc_concealed", "roomId": n.id}])
    assert n.level == "yellow" and "כלים סניטריים בגומחה" in n.reasons


def test_niche_evidence_and_labels():
    assert is_laundry_text("כביסה") and is_laundry_text("מכונת כביסה") and is_laundry_text('מ"כ') and is_laundry_text("מ.כ")
    assert is_laundry_text("מייבש") and not is_laundry_text("מטבח") and not is_laundry_text("מכסה")
    from shapely.geometry import Point, box

    from kamutan_drawing.rooms.niches import NicheCandidate

    c = NicheCandidate(box(0, 0, 16, 14), 0, ((0, 14), (16, 14)), 0.8, 0.56, 0.7)
    assert niche_evidence(c, [], [("fixture_washing_machine", 8, 7)], 20) == (True, False, False)
    assert niche_evidence(c, [(Point(8, 7), "כביסה", 0.9)], [], 20) == (False, True, False)
    assert niche_evidence(c, [], [("fixture_wc_concealed", 8, 7)], 20) == (False, False, True)
    assert niche_evidence(c, [], [("fixture_washing_machine", 40, 40)], 20) == (False, False, False)


# ------------------------------------------------------------------------------------- window with a jogged frame
def _window_plan(c, ps, *, jog: bool):
    """Room 4.0 x 3.0 m; a 1.0 m window in the right wall: a straight glass line from jamb to jamb and an outer
    frame drawn as a "U" polyline (1 mm out, along the gap 1 mm past each jamb, 1 mm back) — the Noah construction
    plan's master-bath window. A 0.8 m door in the bottom wall."""
    x0, y0 = X0, Y0
    x1, y1 = x0 + T + 4.0 * M, y0 + T + 3.0 * M
    wy0, wy1 = y0 + T + 1.0 * M, y0 + T + 2.0 * M
    _rect(c, ps, x0, y0, x1 + T, y0 + T)
    _rect(c, ps, x0, y0, x0 + T, y1 + T)
    _rect(c, ps, x1, y0, x1 + T, wy0)
    _rect(c, ps, x1, wy1, x1 + T, y1 + T)
    d0 = x0 + T + 0.5 * M
    _rect(c, ps, x0, y1, d0, y1 + T)
    _rect(c, ps, d0 + 0.8 * M, y1, x1 + T, y1 + T)
    _line(c, ps, (d0, y1), (d0, y1 - 0.8 * M))
    _arc(c, ps, d0, y1, 0.8 * M, -90, 0)
    _line(c, ps, (x1 + 0.35 * T, wy0), (x1 + 0.35 * T, wy1), w=0.25)  # glass, jamb to jamb
    xo = x1 + 0.65 * T
    c.setLineWidth(0.25 * MM)
    p = c.beginPath()
    pts = [(xo, wy0 - 1.0), (xo + 1.0, wy0 - 1.0), (xo + 1.0, wy1 + 1.0), (xo, wy1 + 1.0)] if jog else [(xo, wy0), (xo, wy1)]
    p.moveTo(*to_pdf_xy(*pts[0], ps))
    for q in pts[1:]:
        p.lineTo(*to_pdf_xy(*q, ps))
    c.drawPath(p, fill=0, stroke=1)


@pytest.mark.parametrize("jog", [False, True])
def test_window_with_a_jogged_outer_frame_closes_the_room(jog):
    vs = extract_pdf(make_pdf(lambda c, ps: _window_plan(c, ps, jog=jog)))[0]
    rooms = segment(vs, [], [REGION], 50)
    room = max(rooms, key=lambda r: r.area_m2)
    assert R_NOT_CLOSED not in room.reasons, room.reasons
    assert room.area_m2 == pytest.approx(12.0, abs=0.4)
    wins = [o for o in room.openings if o["kind"] == "window"]
    assert len(wins) == 1
    assert wins[0]["widthM"] == pytest.approx(1.0, abs=0.03)  # the wall gap, not the frame's path / chord


# ------------------------------------------------------------------------------------- Noah (local artifacts)
@pytest.mark.parametrize("fid,parent_name,niche_m2", [("ad257a1c", "חדר רחצה", 0.71), ("8099ab2c", "חדר רחצה", 0.61)])
def test_sample_laundry_niches(fid, parent_name, niche_m2):
    vs, text, e = _load_artifacts(fid)
    rooms = segment(vs, text, e["regions"], e.get("scaleDenominator"))
    niches = [r for r in rooms if r.niche]
    assert len(niches) == 1, [(r.id, r.name, r.area_m2) for r in rooms]
    n = niches[0]
    parent = next(r for r in rooms if r.id == n.parent_room_id)
    assert parent.name == parent_name and parent.type == "bathroom"
    assert n.area_m2 == pytest.approx(niche_m2, abs=0.08)
    assert any(w.get("open") for w in parent.walls) and any(w.get("open") for w in n.walls)
    # no other room of the sheet gets a niche
    assert sum(1 for r in rooms if any(w.get("open") for w in r.walls)) == 2


def test_sample_master_bath_window_closes_the_room():
    """Noah construction plan (8099ab2c): the master-bath window's outer frame is a jogged "U" polyline; before
    Sprint 5 the glazing pair was rejected, the window missed and the master bath + bedroom leaked."""
    vs, text, e = _load_artifacts("8099ab2c")
    rooms = segment(vs, text, e["regions"], e.get("scaleDenominator"))
    baths = sorted((r for r in rooms if r.name == "חדר רחצה" and not r.niche), key=lambda r: -r.polygon_mm[0][0])
    master = baths[0]  # the eastern bathroom
    assert R_NOT_CLOSED not in master.reasons
    assert 4.5 <= master.area_m2 <= 5.3
    wins = [o for o in master.openings if o["kind"] == "window"]
    assert len(wins) == 1 and wins[0]["widthM"] == pytest.approx(1.0, abs=0.05)
    assert not any(R_NOT_CLOSED in r.reasons for r in rooms if r.name == "חדר שינה")
