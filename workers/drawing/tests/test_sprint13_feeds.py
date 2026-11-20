"""Sprint 13 (Accuracy): the named feeds of a house are marked by notes — a leader note names the glyph at its arrow
tip, a free note (a boxed list, a cloud) is an instruction counted once per project."""

from __future__ import annotations

from kamutan_drawing.boq.dedup import Det
from kamutan_drawing.boq.labeled import FEED_NOTE, dedupe_feed_notes
from kamutan_drawing.ocr.dictionary import TextSpan
from kamutan_drawing.symbols import detect as D
from kamutan_drawing.symbols import feednotes as F

from .test_geometry import Sheet

ORANGE = (226, 128, 29)


def _span(text: str, x: float, y: float, w: float | None = None, h: float = 2.0) -> TextSpan:
    w = 1.2 * len(text) if w is None else w
    return TextSpan("s", (x, y, x + w, y + h), text, 0.9, h, 0, len(text))


def _row(words: list[str], x_right: float, y: float, h: float = 2.0) -> list[TextSpan]:
    """The words of one row as the reader gives them: one span per word, laid out right to left."""
    out, x = [], x_right
    for w in words:
        width = 1.2 * len(w)
        out.append(_span(w, x - width, y, width, h))
        x -= width + 2.0
    return out


def _det(cls: str, x: float, y: float, source: str = "vector") -> D.Detection:
    return D.Detection(cls=cls, center=(x, y), bbox=(x - 2, y - 2, x + 2, y + 2), source=source)


def test_words_of_a_row_are_read_right_to_left_and_rows_stack_into_one_note() -> None:
    spans = [*_row(["הזנה", "תלת", "פאזית", "לשקע", "טעינה"], 100, 50), *_row(["לרכב", "חשמלי"], 100, 52.8)]
    notes = F.note_blocks(spans[::-1])  # the order of the spans does not matter
    assert [n.text for n in notes] == ["הזנה תלת פאזית לשקע טעינה לרכב חשמלי"]
    assert notes[0].rows == 2
    tall = [*_row(["תלת", "פאזי"], 60, 10, h=3.6), _span("לגקוזי", 30, 9.2, 11, 5.8)]  # a descender makes the word taller
    assert [n.text for n in F.note_blocks(tall)] == ["תלת פאזי לגקוזי"]


def test_the_lexicon_reads_through_the_readers_slips_and_needs_the_right_context() -> None:
    assert F.classify("שקע תלת פאזי לה'קוזי").key == "jacuzzi"  # ג read as ה
    assert F.classify("ש.תלת פאזי לאינדוכציה").key == "induction"  # ק read as כ
    assert F.classify("הזנה לפרהולה חשמלית ללא מפסל").key == "awning"
    assert F.classify("הזנה לדוד הזנה למכשיר חימום מים בגז בצמוד לדוד").key == "roof_boiler"
    assert F.classify("מפסל תריס בריכה").key == "shutter"
    assert F.classify("מפסק לתריס") is None  # the legend row names no shutter
    assert F.classify("פרגולת אלומיניום מעל") is None  # the pergola itself, not its feed
    assert F.classify("ניקוז מזגן") is None and F.classify("שקע לכיריים") is None  # a three-phase feed says "תלת"
    assert F.classify("בריכה") is None  # a room name, no feed word


def test_a_leader_note_names_the_glyph_at_its_arrow_tip_not_the_nearer_one() -> None:
    spans = _row(["שקע", "תלת", "פאזי", "לג'קוזי"], 100, 50)
    s = Sheet()
    s.line([(74, 52.6), (100, 52.6), (150, 52.6)], ORANGE)  # the shelf under the words runs on to the glyph
    dets = [_det("socket_power", 153, 52.6), _det("socket_power", 85, 60)]  # the second one is nearer the words
    assert D._named_feeds(s.build(), spans, dets, set()) == []
    assert dets[0].cls == "socket_3phase" and dets[0].annotations == ["ג'קוזי"] and D.R_REFINED in dets[0].reasons
    assert dets[1].cls == "socket_power" and dets[1].annotations == []


def test_a_leader_in_two_paths_and_a_feed_ring_named_as_the_awning() -> None:
    spans = [*_row(["הזנה", "לפרגולה", "חשמלית"], 100, 80), *_row(["ללא", "מפסק"], 100, 82.8)]
    s = Sheet()
    s.line([(70, 82.5), (101, 82.5)], ORANGE)  # the shelf, overshooting the words on the far side
    s.line([(101, 82.5), (118, 66)], ORANGE)  # then the line up to the ring, drawn as a second path
    dets = [_det("shutter_feed", 120, 64), _det("shutter_feed", 60, 90)]
    assert D._named_feeds(s.build(), spans, dets, set()) == []
    assert dets[0].annotations == ["סוכך"] and dets[0].cls == "shutter_feed" and dets[1].annotations == []


def test_a_free_note_is_a_text_only_feed_and_a_conduit_note_never_names_a_glyph() -> None:
    roof = [*_row(["הזנה", "לדוד"], 300, 20), *_row(["הזנה", "למכשיר", "חימום", "מים", "בגז", "בצמוד", "לדוד"], 300, 22.8)]
    out = D._named_feeds(None, roof, [], set())
    assert [(d.cls, d.source, d.annotations) for d in out] == [("heater_feed", "text", [F.A_FEED_NOTE, "דוד שמש וחימום מים בגג"])]
    # "צינור חופשי עבור תלת פאזי לג'קוזי": about a conduit, so it is a free note even with a socket right beside it
    cloud = _row(["צינור", "חופשי", "עבור", "תלת", "פאזי", "לג'קוזי"], 200, 100)
    sock = _det("socket_power", 205, 101)
    out = D._named_feeds(None, cloud, [sock], set())
    assert [d.cls for d in out] == ["socket_3phase"] and sock.cls == "socket_power" and sock.annotations == []


def test_a_free_note_about_a_feed_a_glyph_already_carries_is_not_a_second_feed() -> None:
    leader = _row(["ש.תלת", "פאזי", "לאינדוקציה"], 100, 50)
    conduits = [*_row(["צינורות", "חופשיים", "עבור:"], 100, 70), *_row(["תלת", "פאזי", "לאינדוקציה"], 100, 72.8)]
    sock = _det("socket_3phase", 104, 51)
    out = D._named_feeds(None, [*leader, *conduits], [sock], set())  # no leader drawn: the socket beside the note
    assert out == [] and sock.annotations == ["אינדוקציה"]


def test_a_shutter_switch_note_counts_only_without_a_glyph_and_away_from_a_feed_ring() -> None:
    note = _row(["מפסק", "תריס", "בריכה"], 100, 50)
    out = D._named_feeds(None, note, [], set())
    assert [(d.cls, d.annotations) for d in out] == [("switch_shutter", [F.A_FEED_NOTE, "תריס"])]
    switch = _det("switch_single", 103, 51)
    assert D._named_feeds(None, note, [switch], set()) == [] and switch.annotations == []  # the drawn switch is the item
    assert D._named_feeds(None, note, [_det("shutter_feed", 120, 60)], set()) == []  # the ring's own switch


def _boq_det(sheet: str, i: int, cls: str, *ann: str, lifecycle: str = "new") -> Det:
    return Det(sheet, "v1", f"d_{i}", cls, 10.0 * i, 5.0, "yellow", [], "ground", lifecycle, None, "electrical", annotations=ann)


def test_a_free_note_repeated_on_every_sheet_is_one_feed_per_project() -> None:
    roof = "דוד שמש וחימום מים בגג"
    dets = [
        _boq_det("s2", 1, "heater_feed", FEED_NOTE, roof),
        _boq_det("s1", 1, "heater_feed", FEED_NOTE, roof),
        _boq_det("s3", 1, "water_heater_feed", FEED_NOTE, roof),  # the relabeler may have changed the class on one sheet
        _boq_det("s1", 2, "socket_3phase", FEED_NOTE, "אינדוקציה"),  # explained by the drawn socket on another sheet
        _boq_det("s2", 2, "socket_3phase", "אינדוקציה"),
        _boq_det("s1", 3, "socket_3phase", FEED_NOTE, "היתרו"),
        _boq_det("s1", 4, "heater_feed"),
    ]
    assert dedupe_feed_notes(dets) == 3
    live = [(d.sheet_id, d.id) for d in dets if d.dropped_by is None]
    assert live == [("s1", "d_1"), ("s2", "d_2"), ("s1", "d_3"), ("s1", "d_4")]
    assert dedupe_feed_notes([_boq_det("s1", 1, "heater_feed")]) == 0


def test_a_feed_read_from_a_note_is_not_a_waterproof_host() -> None:
    from kamutan_drawing.boq.labeled import marker_units
    from kamutan_drawing.boq.rules import default_rules

    def host(i: int, *ann: str) -> Det:
        return _boq_det("s1", i, "socket_single", *ann)

    mark = _boq_det("s1", 9, "waterproof_marker")
    mark.x, mark.y = 10.0 * 1 + 1.0, 6.0  # beside d_1 (x=10, y=5)
    plain, noted = host(1), host(1, FEED_NOTE, "ג'קוזי")
    assert len(marker_units([plain, mark], default_rules(), lambda d, r: "")[0]) == 1
    assert marker_units([noted, mark], default_rules(), lambda d, r: "")[0] == []
