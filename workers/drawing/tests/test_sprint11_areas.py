"""Sprint 11 (Worker-Areas): boxed-note plumbing sheets (Rubel / Achituv / Yahav notation) — every point is a text inside
a thin coloured box with a same-pen leader from the box edge to a dot — and the AC socket ↔ drain pairing."""

from __future__ import annotations

from collections import Counter

from reportlab.lib.colors import Color

from kamutan_drawing.boq.aggregate import aggregate
from kamutan_drawing.boq.rules import default_rules
from kamutan_drawing.fixtures import detect
from kamutan_drawing.fixtures import model as M
from kamutan_drawing.fixtures.labels import also_kinds, classify_text, labels, shower_parts
from kamutan_drawing.fixtures.leaders import FrameIndex
from kamutan_drawing.ingest.pdf_vector import extract_pdf
from kamutan_drawing.rooms import segment
from kamutan_drawing.types_sprint2 import SimpleText

from .synth import MM, make_pdf, to_pdf_xy
from .synth_fixtures import REGION, washer, wc
from .test_boq import det
from .test_boq_s4 import lib, lines, psheet, room
from .test_rooms import plan

ORANGE = (255 / 255, 64 / 255, 0.0)
DIM_RED = (255 / 255, 84 / 255, 86 / 255)
DARK_RED = (153 / 255, 27 / 255, 30 / 255)


def _pen(c, rgb=ORANGE, w=0.25):
    c.setStrokeColor(Color(*rgb))
    c.setLineWidth(w * MM)
    c.setDash([], 0)


def _line(c, ps, a, b, rgb=ORANGE):
    _pen(c, rgb)
    c.line(*to_pdf_xy(*a, ps), *to_pdf_xy(*b, ps))


def _box(c, ps, x0, y0, x1, y1, rgb=ORANGE):
    """A note box as AutoCAD plots it: one open path of four line pieces."""
    _pen(c, rgb)
    p = c.beginPath()
    pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]
    p.moveTo(*to_pdf_xy(*pts[0], ps))
    for q in pts[1:]:
        p.lineTo(*to_pdf_xy(*q, ps))
    c.drawPath(p, stroke=1, fill=0)


class Sheet:
    """Synthetic plumbing plan (rooms of ``test_rooms.plan``: bathroom A x 64–144, y 44–104; room B x 148–188) with
    boxed notes; ``note(text, box, *ends)`` draws the box, one straight leader per end and returns the text item."""

    def __init__(self) -> None:
        self.ops: list = []
        self.text: list[SimpleText] = [SimpleText((100.0, 60.0, 112.0, 63.0), "חדר רחצה", 0.95)]

    def note(self, text, box, *ends, pen=ORANGE, leader_pen=None, start=None, lines=None):
        x0, y0, x1, y1 = box
        self.ops.append(lambda c, ps: _box(c, ps, x0, y0, x1, y1, pen))
        for k, e in enumerate(ends):
            s = start[k] if start else (x0 if e[0] < x0 else min(e[0], x1), y0 if e[1] < y0 else min(e[1], y1))
            self.ops.append(lambda c, ps, s=s, e=e: _line(c, ps, s, e, leader_pen or pen))
        rows = lines or [text]
        h = (y1 - y0 - 1.0) / len(rows)
        for k, row in enumerate(rows):
            self.text.append(SimpleText((x0 + 1.0, y0 + 0.5 + k * h, x1 - 1.0, y0 + 0.5 + (k + 1) * h - 0.3), row, 0.9))

    def loose(self, text, box):
        self.text.append(SimpleText(box, text, 0.9))

    def draw(self, fn):
        self.ops.append(fn)

    def build(self):
        def draw(c, ps):
            plan(c, ps)
            for op in self.ops:
                op(c, ps)

        return extract_pdf(make_pdf(draw))[0], self.text


def _run(sheet: Sheet, discipline="plumbing"):
    vs, text = sheet.build()
    rooms = segment(vs, text, [REGION], 50)
    return detect(vs, text, rooms, discipline, regions=[REGION]), vs, text


def _shower(s: Sheet, x: float, y: float, *, mixers=2, ways=3, hands=1, rain=True, drain="תעלת ניקוז למילוי אריחים", side=1):
    """Shower parts on the wall at (x, y…): boxes stacked to one side, leaders to dots 3 mm (15 cm) apart."""
    bx = x + 12.0 * side
    dots = [(x, y + 3.0 * k) for k in range(mixers + hands)]
    box = lambda k: (min(bx, bx + 30.0 * side), y + 5.0 * k - 2.0, max(bx, bx + 30.0 * side), y + 5.0 * k + 2.0)
    row = 0
    if mixers == 3:  # one note, a fan of three leaders
        b = box(row)
        edge = b[0] if side > 0 else b[2]
        s.note(f"אינטרפוץ {ways} דרך H=110", b, *dots[:3], start=[(edge, y + 5.0 * row)] * 3)
        row += 1
    else:
        for k in range(mixers):
            b = box(row)
            s.note(f"אינטרפוץ {ways} דרך H=110", b, dots[k], start=[(b[0] if side > 0 else b[2], y + 5.0 * row)])
            row += 1
    for k in range(hands):
        b = box(row)
        s.note("נק' מים מאחז H=110", b, dots[mixers + k], start=[(b[0] if side > 0 else b[2], y + 5.0 * row)])
        row += 1
    if rain:
        b = box(row)
        s.note("ראש טוש מהתקרה", b, (x + 8.0, y + 6.0), start=[(b[0] if side > 0 else b[2], y + 5.0 * row)])
        row += 1
    if drain:
        b = box(row)
        s.note(drain, b, (x + 6.0, y + 12.0), start=[(b[0] if side > 0 else b[2], y + 5.0 * row)])


# ----------------------------------------------------------------------------- labels
def test_contractor_abbreviation_is_not_an_ac_unit_and_titles_name_nothing():
    assert classify_text('ע"י קבלן מ.א')[0] is None  # "the AC contractor"
    assert classify_text("שקע למ.א, להצמיד לתקרה")[0] == "ac"
    assert classify_text("ניקוז מזגן")[0] == "ac"
    assert classify_text('חזית מקלחון קנ"מ 1:25')[0] is None  # the title of an elevation detail
    assert classify_text("מיכל הדחה סמוי ללא עיבוי")[0] == "wc_concealed"
    for t in ("ראש טוש מהתקרה", "ראש דוש מהקיר H=220", "נק' מים מאחז H=110", "קופסת ניקוז", "ניקוז רגיל"):
        assert classify_text(t)[0] == "shower", t


def test_shower_parts_and_combined_notes():
    assert shower_parts("אינטרפוץ 3 דרך H=110") == (["mixer"], 3)
    assert shower_parts("אינטרפוץ 4 דרך H=110 / ראש טוש קירי H=220") == (["mixer", "rain"], 4)
    assert shower_parts("אינטרפו3 3 דרך")[0] == ["mixer"]  # an OCR slip
    assert shower_parts("תעלת ניקוז מרובעת")[0] == ["channel"]
    assert shower_parts("אביק פיית מילוי")[0] == ["filler"]
    assert also_kinds("נק' מים קרים משולבת כביסה H=100 / תמי 4 + ניקוז לכביסה", "garden_tap") == ["washer"]
    assert also_kinds("נק' מים וניקוז למכונת כביסה", "washer") == []


def test_lines_of_one_box_are_one_label_and_stacked_boxes_stay_apart():
    s = Sheet()
    s.note("", (20.0, 150.0, 60.0, 154.2), (70.0, 152.0), lines=["אינטרפוץ 3 דרך H=110"])
    s.note("", (20.0, 155.2, 60.0, 159.4), (70.0, 157.0), lines=["אינטרפוץ 3 דרך H=110"])  # 1 mm below: its own box
    s.note("", (20.0, 165.0, 70.0, 176.0), (80.0, 170.0), lines=["ניקוז מזגן", "מיקום מדויק יסומן בשטח", 'ע"י קבלן מיזוג אויר'])
    vs, text = s.build()
    fi = FrameIndex(vs)
    assert len(fi.frames) == 3
    labs = [lb for lb in labels(text, fi.frames) if lb.frame is not None]
    assert sorted(lb.kind for lb in labs) == ["ac", "mixer", "mixer"]
    ac = next(lb for lb in labs if lb.kind == "ac")
    assert len(ac.lines) == 3
    assert [round(v, 1) for ld in fi.follow(ac.frame) for v in ld.terminal] == [80.0, 170.0]


def test_leader_in_another_pen_and_box_drawn_in_two_pens():
    s = Sheet()
    s.note("אביק פיית מילוי", (20.0, 150.0, 50.0, 154.0), (60.0, 152.0), leader_pen=DIM_RED)  # leader in the dimension pen
    s.note("ניאגרה סמויה", (20.0, 160.0, 50.0, 164.0), (60.0, 162.0), pen=DARK_RED, leader_pen=ORANGE)
    s.draw(lambda c, ps: _box(c, ps, 20.0, 160.0, 50.0, 164.0, ORANGE))  # the same box again in the orange pen
    s.note("כל מיקומי ניקוז מזגנים יסומנו בשטח", (20.0, 170.0, 90.0, 174.0))  # a general note: no leader
    vs, text = s.build()
    fi = FrameIndex(vs)
    assert len(fi.frames) == 3
    ends = {lb.text: [tuple(round(v) for v in ld.terminal) for ld in fi.follow(lb.frame)] for lb in labels(text, fi.frames)}
    assert ends["אביק פיית מילוי"] == [(60, 152)]
    assert ends["ניאגרה סמויה"] == [(60, 162)]
    assert ends["כל מיקומי ניקוז מזגנים יסומנו בשטח"] == []


# ----------------------------------------------------------------------------- detection on a boxed-note sheet
def test_boxed_showers_count_mixers_per_dot_and_carry_the_parts():
    s = Sheet()
    _shower(s, 66.0, 50.0, mixers=2)  # a standard shower on the west wall of the bathroom
    _shower(s, 142.0, 80.0, mixers=3, hands=2, side=-1)  # the parents' shower: one note, three dots
    # elevation detail beside the plan: loose texts, no box
    s.loose('חזית מקלחון קנ"מ 1:25', (230.0, 60.0, 270.0, 63.0))
    s.loose("3 יח' אינטרפוץ 3 דרך", (230.0, 40.0, 262.0, 43.0))
    fx, _, _ = _run(s)
    showers = [f for f in fx if f.cls == "fixture_shower"]
    assert len(showers) == 2
    west = min(showers, key=lambda f: f.center[0])
    east = max(showers, key=lambda f: f.center[0])
    assert west.annotations[:4] == ["אינטרפוץ 3 דרך x2", "נק' מים מאחז x1", "ראש גשם", "תעלת ניקוז"]
    assert east.annotations[:4] == ["אינטרפוץ 3 דרך x3", "נק' מים מאחז x2", "ראש גשם", "תעלת ניקוז"]


def test_boxed_bath_by_its_filler_and_plain_drain_variant():
    s = Sheet()
    _shower(s, 66.0, 50.0, mixers=3, drain="אביק פיית מילוי")
    fx, _, _ = _run(s)
    assert Counter(f.cls for f in fx if f.cls.startswith("fixture_")) == {"fixture_bath": 1}
    bath = next(f for f in fx if f.cls == "fixture_bath")
    assert "אינטרפוץ 3 דרך x3" in bath.annotations and "פיית מילוי" in bath.annotations
    s = Sheet()
    _shower(s, 66.0, 50.0, mixers=1, ways=4, rain=False, drain="ניקוז רגיל")
    fx, _, _ = _run(s)
    sh = next(f for f in fx if f.cls == "fixture_shower")
    assert sh.annotations[:3] == ["אינטרפוץ 4 דרך x1", "נק' מים מאחז x1", "ניקוז רגיל"]


def test_boxed_sheet_points_are_the_notes_not_the_blocks():
    s = Sheet()
    _shower(s, 66.0, 50.0)  # ≥ 3 boxed notes: the sheet is a boxed-note sheet
    s.draw(lambda c, ps: washer(c, ps, 150.0, 90.0))  # washing machine + dryer side by side, one note
    s.draw(lambda c, ps: washer(c, ps, 163.0, 90.0))
    s.note("נק' מים וניקוז למכונת כביסה H=100", (150.0, 70.0, 186.0, 74.0), (156.0, 89.0))
    s.draw(lambda c, ps: wc(c, ps, 110.0, 46.0))  # a WC block no note names (furniture layer of an existing fixture)
    # faucet note = the whole basin point (water + drain); no basin block is drawn
    s.note("", (95.0, 110.0, 135.0, 116.0), (120.0, 103.5), lines=["ברז קיר מים חמים/קרים H=110", "+ניקוז H=60"])
    # one box for two points: the washing machine and the Tami 4 tap
    s.note("", (20.0, 150.0, 70.0, 156.0), (80.0, 153.0), lines=["נק' מים קרים משולבת כביסה H=100", "תמי 4 + ניקוז לכביסה"])
    # a fan from one "ניקוז מזגן" note to two dots 0.3 m apart (two units back to back on one wall)
    s.note("ניקוז מזגן", (20.0, 165.0, 50.0, 169.0), (60.0, 164.0), (60.0, 170.0))
    s.note("כל מיקומי ניקוז מזגנים יסומנו בשטח", (200.0, 20.0, 280.0, 24.0))  # general note: no leader
    s.loose("מזגן עילי", (58.0, 172.0, 70.0, 174.5))
    fx, _, _ = _run(s)
    c = Counter(f.cls for f in fx)
    assert c["fixture_washing_machine"] == 2  # the labelled block + the combined note; the dryer block is not a point
    assert c["garden_tap"] == 1
    assert c["fixture_wc_concealed"] == 0
    assert c["fixture_basin"] == 1 and c["faucet_wall"] == 1
    basin = next(f for f in fx if f.cls == "fixture_basin")
    faucet = next(f for f in fx if f.cls == "faucet_wall")
    assert faucet.attached_to == basin.id and abs(basin.center[0] - 120.0) < 0.5 and abs(basin.center[1] - 103.5) < 0.5
    assert c["ac_unit"] == 2
    acs = sorted(f.center[1] for f in fx if f.cls == "ac_unit")
    assert abs(acs[0] - 164.0) < 0.5 and abs(acs[1] - 170.0) < 0.5
    assert all(M.R_NO_LEADER not in f.reasons for f in fx)


def test_sheet_without_boxed_notes_is_read_as_before():
    s = Sheet()
    s.draw(lambda c, ps: wc(c, ps, 110.0, 46.0))
    s.loose("ניקוז + גז למזגן", (165.0, 68.0, 180.0, 70.6))
    fx, _, _ = _run(s)
    c = Counter(f.cls for f in fx)
    assert c["fixture_wc_concealed"] + c["fixture_wc_monoblock"] == 1 and c["ac_unit"] == 1


# ----------------------------------------------------------------------------- AC socket ↔ drain pairing (boq.dedup)
def _ac(i: int, x: float, y: float, rid: str | None = None, floor: str = "ground"):
    return det(i, "ac_unit", x, y, roomId=rid, floor=floor, level="yellow", reasons=["זוהה מכיתוב בלבד"])


def test_leftover_sockets_pair_with_leftover_drains_of_the_floor():
    rooms = [room("r_1", "חדר שינה", 0, 0, 100, 80), room("r_2", "סלון", 110, 0, 260, 80)]
    # drain points along the outer wall, far (> 1.6 m) from the indoor units' sockets and outside every room
    pl = psheet("pl", "plumbing", [_ac(1, 300, 10), _ac(2, 300, 60), _ac(3, 300, 110)], rooms, page=(420.0, 297.0, 0))
    el = psheet("el", "electrical", [_ac(1, 50, 40, "r_1"), _ac(2, 180, 40, "r_2")], rooms, page=(420.0, 297.0, 0))
    ln = lines(aggregate([pl, el], default_rules(), lib()))
    assert ln["3.01"].qty == 3  # three drains; the two sockets are two of those units
    # more sockets than drains: the surplus sockets are units the plumbing sheet does not show
    el4 = psheet("el", "electrical", [_ac(i, 40 * i, 40, "r_1") for i in range(1, 5)], rooms, page=(420.0, 297.0, 0))
    assert lines(aggregate([pl, el4], default_rules(), lib()))["3.01"].qty == 4


# ----------------------------------------------------------------------------- shower variants by the drawn parts
YAHAV_SHOWERS = [
    ("3.01", "נק' מים חמים קרים וניקוז לכיור בחדר רחצה. העבודה כוללת התקנת ברז פרח/קיר והתקנת סיפון", "03"),
    ("3.02", "נק' מים חמים קרים וניקוז לכיור מטבח. העבודה כוללת התקנת ברז פרח/קיר והתקנת סיפון", "03"),
    ("3.05", "נק' למקלחון הכוללת: הזנת חמים+קרים, התקנת שתי יח' אינטרפוץ 3 דרך, נק' מים+מזלף, ראש גשם והתקנת תעלת ניקוז", "03"),
    ("3.06", "נק' למקלחון יח' דיור הכוללת: הזנת חמים+קרים, התקנת אינטרפוץ 4 דרך, נק' מים+מזלף, ראש גשם והתקנת תעלת ניקוז", "03"),
    ("3.07", "נק' למקלחון יח' דיור הכוללת: הזנת חמים+קרים, התקנת אינטרפוץ 4 דרך, נק' מים+מזלף, ראש גשם וניקוז רגיל", "03"),
    ("3.08", "נק' למקלחון יח' הורים הכוללת: הזנת חמים+קרים, התקנת שלוש יח' אינטרפוץ 3 דרך, שתי נק' מים+מזלף, ראש גשם והתקנת תעלת ניקוז", "03"),
]  # fmt: skip


def _client_lib(rows):
    from kamutan_drawing.boq.rules import Library

    from .test_boq import lib_rows

    return Library.from_docs(lib_rows(rows))


def test_measured_shower_description_and_params():
    from kamutan_drawing.boq.dedup import Det
    from kamutan_drawing.boq.plumbing import measured_shower

    def d(ann, floor="first", cls="fixture_shower"):
        return Det("pl", "v1", "d_1", cls, 0, 0, "yellow", [], floor, "new", None, "plumbing", annotations=tuple(ann))

    desc, params = measured_shower(d(["אינטרפוץ 3 דרך x3", "נק' מים מאחז x2", "ראש גשם", "תעלת ניקוז"]))
    assert "שלוש יחידות אינטרפוץ 3 דרך" in desc and desc.endswith("ותעלת ניקוז") and params == {"interpuz": 3.0, "ways": 3.0}
    desc, params = measured_shower(d(["אינטרפוץ 4 דרך x1", "ניקוז רגיל"], floor="basement"))
    assert "מקלחון מרתף" in desc and "התקנת אינטרפוץ 4 דרך" in desc and params == {"interpuz": 1.0, "ways": 4.0}
    assert measured_shower(d(["אינטרפוץ", "H=90"])) is None  # Noah's showers: no counted parts → the rules decide
    assert measured_shower(d(["אינטרפוץ 3 דרך x2"], cls="fixture_bath")) is None


def test_showers_pick_the_clients_variant_by_mixers_ways_and_drain():
    def sh(i, x, ann, floor="first", rid="r_1"):
        return det(i, "fixture_shower", x, 20, roomId=rid, floor=floor, level="yellow", annotations=ann)

    rooms = [room("r_1", None, 0, 0, 400, 80)]  # one merged "room" holding every shower: still one unit each
    pl = psheet(
        "pl",
        "plumbing",
        [
            sh(1, 20, ["אינטרפוץ 3 דרך x2", "נק' מים מאחז x1", "ראש גשם", "תעלת ניקוז"]),
            sh(2, 120, ["אינטרפוץ 4 דרך x1", "נק' מים מאחז x1", "ראש גשם", "תעלת ניקוז"]),
            sh(3, 220, ["אינטרפוץ 4 דרך x1", "נק' מים מאחז x1", "ראש גשם", "ניקוז רגיל"]),
            sh(4, 320, ["אינטרפוץ 3 דרך x3", "נק' מים מאחז x2", "ראש גשם", "תעלת ניקוז"]),
        ],
        rooms,
    )
    ln = lines(aggregate([pl], default_rules(), _client_lib(YAHAV_SHOWERS)))
    assert {c: ln[c].qty for c in ("3.05", "3.06", "3.07", "3.08")} == {"3.05": 1, "3.06": 1, "3.07": 1, "3.08": 1}


def test_same_code_item_with_another_target_does_not_win_by_code():
    # default rule r_plumb_basin_wall_faucet has code 3.02 (Noah's numbering); on this client 3.02 is the kitchen sink
    lib_ = _client_lib(YAHAV_SHOWERS)
    res = lib_.resolve("3.02", "נק' מים חמים קרים וניקוז לכיור, לרבות התקנת ברז קיר", unit="יחידה")
    assert res is not None and res.item.code == "3.01"
    # a same-code item without a conflict still wins by code
    assert lib().resolve("3.02", "נק' מים חמים קרים וניקוז לכיור, לרבות התקנת ברז קיר").item.code == "3.02"
