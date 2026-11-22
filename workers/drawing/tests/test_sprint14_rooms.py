"""Sprint 14: room names — labels printed as separate words, common words that are not names, the room of a child;
fixture information of a floor whose sanitary fixtures no canonical room could place."""

from __future__ import annotations

import pytest

from kamutan_drawing.rooms import segment
from kamutan_drawing.rooms.names import WordBox, match_room_name, stitch_words
from kamutan_drawing.types_sprint2 import SimpleText

from .test_sprint11_rooms import REGION, _shell, _vs


def _w(x0: float, x1: float, text: str, y: float = 100.0, h: float = 1.3) -> WordBox:
    return WordBox(x0, y, x1, y + h, text, 0.98)


def test_words_of_one_baseline_are_read_right_to_left_as_one_label():
    ph = stitch_words([_w(361.7, 366.8, "שינה"), _w(368.9, 373.8, "חדר")])
    assert [p.text for p in ph] == ["חדר שינה"]
    assert match_room_name(ph[0].text).name == "חדר שינה"


def test_words_far_apart_or_on_other_lines_are_not_chained():
    assert stitch_words([_w(361.7, 366.8, "שינה"), _w(390.0, 395.0, "חדר")]) == []
    assert stitch_words([_w(361.7, 366.8, "שינה"), _w(368.9, 373.8, "חדר", y=105.0)]) == []
    assert stitch_words([_w(361.7, 366.8, "שינה"), _w(368.9, 373.8, "חדר", h=3.0)]) == []


def test_a_room_labelled_with_separate_words_is_named():
    def draw(c, ps):
        _shell(c, ps)

    rooms = segment(
        _vs(draw),
        [SimpleText((130, 130, 135, 131.3), "שינה", 0.98), SimpleText((136.5, 130, 142, 131.3), "חדר", 0.98)],
        [REGION],
        50,
    )
    assert [r.name for r in rooms] == ["חדר שינה"]


@pytest.mark.parametrize("word", ["חדש", "חדשה", "חדשים", "החדש", "בניה", "נישה", "חלון", "ארון", "נמוך", "פריסה", "מיזוה"])
def test_common_words_of_a_drawing_are_not_room_names(word):
    assert match_room_name(word) is None, word


def test_the_bedroom_abbreviation_needs_its_quote_and_a_misread_letter_still_matches():
    assert match_room_name('חד"ש').name == "חדר שינה"
    assert match_room_name("חד״ש 2").name == "חדר שינה"
    assert match_room_name("פינת אובל").name == "פינת אוכל"
    assert match_room_name("שינה").name == "חדר שינה"


def test_the_room_of_a_child_is_a_bedroom():
    assert match_room_name("החדר של עמית").name == "חדר שינה"
    assert match_room_name("חדר של מיה").name == "חדר שינה"
    assert match_room_name("החדר") is None


def test_fixture_information_is_incomplete_where_a_shower_found_no_room():
    from kamutan_drawing.boq.aggregate import _room_fixtures
    from kamutan_drawing.boq.dedup import Det

    shower = Det("pl", "v1", "d1", "fixture_shower", 300.0, 108.0, "yellow", [], "basement", "new", None, "plumbing")
    wc = Det("pl", "v1", "d2", "fixture_wc_concealed", 284.0, 111.0, "yellow", [], "basement", "new", None, "plumbing")
    fx, floors = _room_fixtures([shower, wc], {}, [])
    assert fx == {} and "basement" not in floors  # unknown, not "no shower"
    fx, floors = _room_fixtures([wc], {}, [])
    assert floors == {"basement"}  # a WC alone does not decide the waterproofing
