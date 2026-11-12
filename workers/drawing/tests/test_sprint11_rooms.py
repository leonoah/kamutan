"""Sprint 11 (Worker-Rooms): wall colour on plans with filled decks, hatched concrete walls, vitrines drawn as sliding
leaves, room names at word boundaries, registration between sheets of one floor, outdoors, room floors after a floor fix."""

from __future__ import annotations

from dataclasses import dataclass, field

from kamutan_drawing.ingest.pdf_vector import extract_pdf
from kamutan_drawing.rooms import segment
from kamutan_drawing.rooms.closure import glazing_bands, hatched_walls
from kamutan_drawing.rooms.crosssheet import INSIDE, OUTDOOR, UNKNOWN, FloorLocator, register, remap_room_floors
from kamutan_drawing.rooms.names import match_room_name
from kamutan_drawing.rooms.segment import R_NOT_CLOSED
from kamutan_drawing.rooms.walls import extract_walls
from kamutan_drawing.types_sprint2 import SimpleText

from .synth import make_pdf, stroke_line
from .test_rooms import _rect

M = 20.0  # paper mm per metre at 1:50
T = 4.0  # 20 cm walls
BEIGE = (243 / 255, 217 / 255, 176 / 255)
REGION = {
    "id": "r0",
    "floor": "ground",
    "polygonMm": [{"x": 10, "y": 10}, {"x": 400, "y": 10}, {"x": 400, "y": 280}, {"x": 10, "y": 280}],
    "scaleDenominator": 50,
}
BOX = (10.0, 10.0, 400.0, 280.0)
# a 4 x 3 m room: interior 104..184 x 104..164
RX0, RY0, RX1, RY1 = 100.0, 100.0, 188.0, 168.0


def _shell(c, ps, *, east: bool = True, top: bool = True):
    if top:
        _rect(c, ps, RX0, RY0, RX1, RY0 + T)
    _rect(c, ps, RX0, RY1 - T, RX1, RY1)
    _rect(c, ps, RX0, RY0, RX0 + T, RY1)
    if east:
        _rect(c, ps, RX1 - T, RY0, RX1, RY1)


def _vs(draw):
    return extract_pdf(make_pdf(draw))[0]


# ----------------------------------------------------------------------------------------------- wall colour
def test_a_filled_deck_larger_than_the_walls_is_not_the_wall_colour():
    """Achituv ground floor: the beige entrance deck out-weighs every wall; the room must still be found."""

    def draw(c, ps):
        _shell(c, ps)
        _rect(c, ps, 200.0, 40.0, 380.0, 200.0, rgb=BEIGE)  # 9 x 8 m deck beside the house

    vs = _vs(draw)
    ws = extract_walls(vs, BOX, scale_den=50)
    assert ws.walls.area < 2500, "the deck must not be part of the walls"
    rooms = segment(vs, [SimpleText((130, 130, 150, 134), "חדר שינה", 0.95)], [REGION], 50)
    assert [r.name for r in rooms] == ["חדר שינה"]
    assert abs(rooms[0].area_m2 - 12.0) < 0.6 and R_NOT_CLOSED not in rooms[0].reasons


def test_walls_that_are_the_largest_colour_stay_the_walls():
    def draw(c, ps):
        _shell(c, ps)
        _rect(c, ps, 250.0, 100.0, 262.0, 112.0, rgb=BEIGE)  # a small filled object

    ws = extract_walls(_vs(draw), BOX, scale_den=50)
    assert ws.stats["dominantFill"] == float(201 * 65536 + 201 * 256 + 201) or ws.walls.area > 1000


# ----------------------------------------------------------------------------------------------- hatched walls
def _cross_hatch(c, ps, x0, y0, x1, y1, step=1.27):
    """45° / 135° hatch strokes clipped to the box (a concrete wall drawn without a fill)."""
    w, h = x1 - x0, y1 - y0
    k = -h
    while k < w:
        a = (x0 + max(k, 0.0), y0 + max(-k, 0.0))
        b = (x0 + min(k + h, w), y0 + min(h, w - k))
        if b[0] - a[0] > 0.5:
            stroke_line(c, a, b, ps, 0.04, (0.39, 0.39, 0.4))
            stroke_line(c, (a[0], y1 - (a[1] - y0)), (b[0], y1 - (b[1] - y0)), ps, 0.04, (0.39, 0.39, 0.4))
        k += step


def test_cross_hatched_band_is_a_wall_and_closes_the_room():
    """Achituv ממ"ד: the east wall is two thin lines with a cross hatch between them, no fill."""

    def draw(c, ps):
        _shell(c, ps, east=False)
        for x in (RX1 - 6.0, RX1):
            stroke_line(c, (x, RY0), (x, RY1), ps, 0.3)
        _cross_hatch(c, ps, RX1 - 6.0, RY0, RX1, RY1)

    vs = _vs(draw)
    hw = hatched_walls(vs, BOX, M)
    assert len(hw) == 1
    b = hw[0].bounds
    assert abs(b[0] - (RX1 - 6.0)) < 1.0 and abs(b[2] - RX1) < 1.0 and b[3] - b[1] > 60.0
    rooms = segment(vs, [], [REGION], 50)
    assert len(rooms) == 1 and R_NOT_CLOSED not in rooms[0].reasons
    assert 11.0 < rooms[0].area_m2 < 12.5


def test_a_red_cross_hatch_is_a_work_item_not_a_wall():
    def draw(c, ps):
        _shell(c, ps)
        for k in range(40):
            stroke_line(c, (230.0 + k * 1.2, 100.0), (236.0 + k * 1.2, 106.0), ps, 0.04, (1, 0, 0))
            stroke_line(c, (230.0 + k * 1.2, 106.0), (236.0 + k * 1.2, 100.0), ps, 0.04, (1, 0, 0))

    assert hatched_walls(_vs(draw), BOX, M) == []


# ----------------------------------------------------------------------------------------------- glazing bands
def _leaf(c, ps, x, y0, y1, w=1.2):
    for a, b in (((x, y0), (x, y1)), ((x + w, y0), (x + w, y1)), ((x, y0), (x + w, y0)), ((x, y1), (x + w, y1))):
        stroke_line(c, a, b, ps, 0.08)


def _vitrine_plan(c, ps):
    """East side open between the top and bottom walls, closed by three staggered sliding leaves (no long line)."""
    _shell(c, ps, east=False)
    y0, y1 = RY0 + T, RY1 - T
    third = (y1 - y0) / 3
    _leaf(c, ps, RX1 - 3.6, y0, y0 + third + 2.0)
    _leaf(c, ps, RX1 - 2.4, y0 + third - 2.0, y0 + 2 * third + 2.0)
    _leaf(c, ps, RX1 - 1.2, y0 + 2 * third - 2.0, y1)


def test_staggered_sliding_leaves_between_two_walls_are_a_glazing_band():
    vs = _vs(_vitrine_plan)
    ws = extract_walls(vs, BOX, scale_den=50)
    bands = glazing_bands(vs, ws.walls, BOX, M)
    assert len(bands) == 1
    b = bands[0].bounds
    assert b[0] > RX1 - 5.0 and b[2] < RX1 + 1.0 and b[1] <= RY0 + T + 0.5 and b[3] >= RY1 - T - 0.5


def test_room_behind_a_sliding_vitrine_is_closed():
    rooms = segment(_vs(_vitrine_plan), [SimpleText((130, 130, 150, 134), "סלון", 0.95)], [REGION], 50)
    assert [r.name for r in rooms] == ["סלון"]
    assert R_NOT_CLOSED not in rooms[0].reasons and 11.0 < rooms[0].area_m2 < 13.5


def test_single_line_and_stair_treads_are_not_glazing():
    def draw(c, ps):
        _shell(c, ps, east=False)
        stroke_line(c, (RX1 - 2.0, RY0 + T), (RX1 - 2.0, RY1 - T), ps, 0.08)  # one line: a furniture edge
        for k in range(6):  # treads 27 cm apart between the two walls
            x = 120.0 + k * 5.4
            stroke_line(c, (x, RY0 + T), (x, RY1 - T), ps, 0.08)

    vs = _vs(draw)
    assert glazing_bands(vs, extract_walls(vs, BOX, scale_den=50).walls, BOX, M) == []


def test_bands_inside_a_closed_room_change_nothing(monkeypatch):
    """A wardrobe rail (two leaves wall to wall) inside a room that is closed anyway must not cut it: the rooms are
    the same with and without the glazing pass."""
    from kamutan_drawing.rooms import walls as walls_mod

    def draw(c, ps):
        _shell(c, ps)
        _leaf(c, ps, 150.0, RY0 + T, 134.0)
        _leaf(c, ps, 151.0, 132.0, RY1 - T)

    vs = _vs(draw)
    assert extract_walls(vs, BOX, scale_den=50).glazing, "the rail is a band (the case under test)"
    with_bands = [r.to_json(extended=True) for r in segment(vs, [], [REGION], 50)]
    monkeypatch.setattr(walls_mod, "glazing_bands", lambda *a, **k: [])
    assert with_bands == [r.to_json(extended=True) for r in segment(vs, [], [REGION], 50)]
    assert len(with_bands) == 1


# ----------------------------------------------------------------------------------------------- names
def test_room_name_must_sit_at_word_boundaries():
    assert match_room_name("מיקום מדויק יסומן בשטח") is None  # "…ם מד…" is not ממ"ד
    assert match_room_name('ממ"ד').name == 'ממ"ד'
    assert match_room_name("חדר שינה 2").name == "חדר שינה"
    assert match_room_name("ח.רחצה הורים").name == "חדר רחצה"
    m = match_room_name("פירוק מטבח קיים")
    assert m is not None and m.name == "מטבח" and m.score < 0.8  # a word inside a note still scores low


# ----------------------------------------------------------------------------------------------- cross-sheet
@dataclass
class R:
    sheet_id: str
    id: str
    floor: str | None
    area_m2: float
    polygon: list[tuple[float, float]]
    type: str = "other"
    niche: bool = False
    key: str = field(init=False)

    def __post_init__(self) -> None:
        self.key = f"{self.sheet_id}__{self.id}"


def _box(x0, y0, w, h):
    return [(x0, y0), (x0 + w, y0), (x0 + w, y0 + h), (x0, y0 + h)]


def _floor(sheet, dx=0.0, dy=0.0, types=("bathroom", "bedroom", "living")):
    # bath 2 x 2.5 m, bedroom 4 x 3 m, living 6 x 5 m (paper mm at 1:50), walls 4 mm
    specs = [(100, 100, 40, 50, 5.0), (144, 100, 80, 60, 12.0), (100, 164, 120, 100, 30.0)]
    return [
        R(sheet, f"r_{k + 1}", "first", a, _box(x + dx, y + dy, w, h), t)
        for k, ((x, y, w, h, a), t) in enumerate(zip(specs, types, strict=True))
    ]


def test_register_finds_the_translation_between_two_sheets_of_a_floor():
    canon, elec = _floor("con"), _floor("el", dx=62.5, dy=-41.0, types=("other",) * 3)
    sh = register(elec, canon)
    assert sh is not None and sh.matched == 3
    assert abs(sh.dx + 62.5) < 0.01 and abs(sh.dy - 41.0) < 0.01


def test_register_works_when_one_sheet_closed_fewer_rooms_and_refuses_unrelated_ones():
    canon, elec = _floor("con"), _floor("el", dx=50.0, dy=70.0)[:2]
    sh = register(elec, canon)
    assert sh is not None and sh.matched == 2 and abs(sh.dx + 50.0) < 0.01
    other = [R("x", "r_1", "first", 9.0, _box(10, 10, 60, 60)), R("x", "r_2", "first", 20.0, _box(90, 10, 100, 80))]
    assert register(other, canon) is None


def test_locator_gives_the_canonical_room_type_and_outdoors():
    canon, elec = _floor("con"), _floor("el", dx=62.5, dy=-41.0, types=("other",) * 3)
    loc = FloorLocator({"con": canon, "el": elec}, canon, {"con": 50, "el": 50})
    where, room = loc.locate("el", "first", 120 + 62.5, 125 - 41.0)  # inside the bathroom
    assert where == "room" and room.type == "bathroom"
    where, room = loc.locate("el", "first", 142 + 62.5, 125 - 41.0)  # in the wall between bath and bedroom
    assert where == INSIDE and room is None
    where, room = loc.locate("el", "first", 300 + 62.5, 125 - 41.0)  # 3.8 m east of the bedroom: the garden
    assert where == OUTDOOR and room is None
    assert loc.locate("el", "ground", 120, 120) == (UNKNOWN, None)  # no canonical rooms on that floor
    assert loc.locate("con", "first", 120, 125)[1].type == "bathroom"  # the canonical sheet itself: no shift


def test_outdoors_is_trusted_only_when_the_floor_model_is_a_building():
    canon = _floor("con")
    loc = FloorLocator({"con": canon}, canon, {"con": 50})
    inside = [(120.0, 125.0), (180.0, 130.0), (150.0, 200.0), (170.0, 230.0)]
    assert loc.outdoor_trusted("con", "first", [*inside, (300.0, 125.0)])  # 4 of 5 accessories in the house
    assert not loc.outdoor_trusted("con", "first", [inside[0], (300.0, 125.0), (320.0, 200.0), (340.0, 60.0)])
    one = canon[:1]  # the segmentation closed one bathroom only: "outside it" says nothing
    assert not FloorLocator({"con": one}, one, {"con": 50}).outdoor_trusted("con", "first", inside[:1])


def test_locator_does_not_guess_when_the_sheet_cannot_be_registered():
    canon = _floor("con")
    loc = FloorLocator({"con": canon, "el": []}, canon, {"con": 50, "el": 50})
    assert loc.locate("el", "first", 500.0, 500.0) == (UNKNOWN, None)


def test_room_floors_follow_a_floor_fix():
    rooms = [{"id": "r_1", "floor": "ground"}, {"id": "r_2", "floor": None}]
    sheet = {"floorCheck": {"titleFloors": ["ground"], "floors": ["first"]}}
    assert [r["floor"] for r in remap_room_floors(sheet, rooms)] == ["first", None]
    assert rooms[0]["floor"] == "ground"  # in memory only
    assert remap_room_floors({**sheet, "confirmed": True}, rooms) is rooms
    assert remap_room_floors({}, rooms) is rooms


# ----------------------------------------------------------------------------------------------- round 2
def _one_way_hatch(c, ps, x0, y0, x1, y1, step=0.63):
    w, h = x1 - x0, y1 - y0
    k = -h
    while k < w:
        a = (x0 + max(k, 0.0), y0 + max(-k, 0.0))
        b = (x0 + min(k + h, w), y0 + min(h, w - k))
        if b[0] - a[0] > 0.5:
            stroke_line(c, a, b, ps, 0.04, (0.73, 0.73, 0.73))
        k += step


def _pier_facade(c, ps):
    """Yahav ground floor: the east side is two windows (four frame lines each) either side of a hatched pier."""
    _shell(c, ps, east=False)
    x0, x1 = RX1 - T, RX1
    py0, py1 = 128.0, 138.0  # the pier: 0.5 m of wall drawn with a one-way hatch, no fill
    for a, b in (((x0, py0), (x1, py0)), ((x0, py1), (x1, py1)), ((x0, py0), (x0, py1)), ((x1, py0), (x1, py1))):
        stroke_line(c, a, b, ps, 0.17)
    _one_way_hatch(c, ps, x0, py0, x1, py1)
    for ya, yb in ((RY0 + T, py0), (py1, RY1 - T)):
        for x in (x0, x0 + 2.1, x0 + 3.0, x1):
            stroke_line(c, (x, ya), (x, yb), ps, 0.17)


def test_hatched_pier_between_two_windows_closes_the_facade():
    vs = _vs(_pier_facade)
    piers: list = []
    hatched_walls(vs, BOX, M, piers)
    assert len(piers) == 1 and abs(piers[0].bounds[1] - 128.0) < 1.0 and abs(piers[0].bounds[3] - 138.0) < 1.0
    rooms = segment(vs, [SimpleText((130, 130, 150, 134), "סלון", 0.95)], [REGION], 50)
    assert [r.name for r in rooms] == ["סלון"] and 11.0 < rooms[0].area_m2 < 13.5


def test_open_ground_labels_and_plot_sized_faces_are_not_rooms():
    from kamutan_drawing.rooms.names import is_outdoor_label
    from kamutan_drawing.rooms.segment import MAX_OPEN_ROOM_M2

    assert is_outdoor_label("דשא") and is_outdoor_label("ערוגה עם צמחייה") and is_outdoor_label("שטח מרוצף")
    assert not is_outdoor_label("סלון") and not is_outdoor_label("מיקום מדויק יסומן בשטח")
    assert 100.0 < MAX_OPEN_ROOM_M2 <= 200.0


def test_fixture_without_an_own_room_lands_in_the_canonical_room_by_registration():
    from kamutan_drawing.boq.aggregate import _room_fixtures
    from kamutan_drawing.boq.dedup import Det

    canon, plumb = _floor("con"), _floor("pl", dx=62.5, dy=-41.0, types=("other",) * 3)
    loc = FloorLocator({"con": canon, "pl": plumb}, canon, {"con": 50, "pl": 50})
    d = Det("pl", "v1", "d1", "fixture_shower", 120 + 62.5, 125 - 41.0, "yellow", [], "first", "new", None, "plumbing")
    fx, floors = _room_fixtures([d], {}, canon, loc)
    assert fx == {"con__r_1": frozenset({"fixture_shower"})} and floors == {"first"}
    assert _room_fixtures([d], {}, canon)[0] == {}  # without the locator: no room on its own sheet, no mapping


def test_outline_registration_when_the_sheets_closed_different_rooms():
    from kamutan_drawing.rooms.crosssheet import register_outlines

    canon = _floor("con")
    # the electrical sheet lacks the bath / bedroom partition: one merged room, no equal-area pair with the canon
    merged = R("el", "r_1", "first", 18.0, _box(100 + 30, 100 + 50, 124, 60))
    living = R("el", "r_2", "first", 28.0, _box(100 + 30, 164 + 50, 120, 96))
    assert register([merged, living], canon) is None
    sh = register_outlines([merged, living], canon)
    assert sh is not None and abs(sh.dx + 30.0) < 1.5 and abs(sh.dy + 50.0) < 2.5
    loc = FloorLocator({"con": canon, "el": [merged, living]}, canon, {"con": 50, "el": 50})
    assert loc.locate("el", "first", 120 + 30, 125 + 50)[1].type == "bathroom"
    assert register_outlines([R("x", "r_1", "first", 3.0, _box(0, 0, 30, 40))], canon) is None  # too little to trust


def test_an_open_plan_floor_holding_the_guest_wc_is_not_a_bathroom():
    from kamutan_drawing.rooms.types import room_type

    assert room_type("מזווה", ["fixture_wc_concealed", "fixture_basin", "fixture_kitchen_sink"], 71.8) == ("storage", False, [])
    assert room_type(None, ["fixture_wc_concealed"], 71.8)[:2] == ("other", False)
    assert room_type(None, ["fixture_wc_concealed", "fixture_basin"], 3.0)[:2] == ("wc", True)
    assert room_type("חדר רחצה", ["fixture_shower"], 30.0)[:2] == ("bathroom", True)  # named: its size does not matter


def test_real_words_are_not_fuzzy_room_names():
    for w in ("מדפסת", "מסנן", "שירות", "עבור"):
        assert match_room_name(w) is None, w
    assert match_room_name("מרפסח").name == "מרפסת"  # a misread letter still matches
