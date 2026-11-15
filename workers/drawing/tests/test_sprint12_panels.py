"""Sprint 12 (Accuracy): the panel written as a leader note ("לוח חשמל ותקשורת") is one electrical board (+ one comms
board), its role is given by the library's main / secondary items."""

from __future__ import annotations

from types import SimpleNamespace

from kamutan_drawing.boq.dedup import Det
from kamutan_drawing.boq.labeled import assign_panel_roles
from kamutan_drawing.ocr.dictionary import TextSpan
from kamutan_drawing.symbols import detect as D


def _span(text: str, x: float, y: float, w: float = 10.0, h: float = 2.0) -> TextSpan:
    return TextSpan("s", (x, y, x + w, y + h), text, 0.9, h, 0, len(text))


def _notes(*spans: TextSpan) -> list[D.Detection]:
    return D._panels_from_notes(D.TextIndex(list(spans)), [])


def test_a_leader_note_with_lock_word_and_electricity_is_one_panel_and_comms_rides_on_it() -> None:
    out = _notes(_span("לוח", 100, 100, 6), _span("חשמל", 100, 103), _span("ותכשורת", 90, 106))  # OCR slip in "תקשורת"
    assert len(out) == 1
    assert out[0].cls == "panel" and out[0].source == "text"
    assert {D.A_PANEL_NOTE, D.A_PANEL_COMMS} <= set(out[0].annotations)


def test_a_panel_with_a_sub_meter_has_no_comms() -> None:
    out = _notes(_span("לוח", 50, 50, 6), _span("חשמל עם", 50, 53), _span("מונה", 40, 56), _span("משני", 40, 59))
    assert len(out) == 1 and D.A_PANEL_COMMS not in out[0].annotations


def test_feed_and_in_panel_notes_never_start_a_board() -> None:
    assert not _notes(_span("מלוח", 10, 10, 6), _span("חשמל", 10, 13))  # a feed FROM the panel
    assert not _notes(_span("שקע", 10, 10, 6), _span("בלוח", 10, 13), _span("חשמל", 10, 16))  # a socket IN it
    assert not _notes(_span("לוח", 10, 10, 6), _span("אחר", 10, 13))  # no electricity word


def test_the_note_whose_first_word_was_lost_still_counts_once() -> None:
    out = _notes(_span("ל.חשמל ותקשורת", 10, 10, 20), _span("לוח", 12, 6, 6), _span("חשמל", 12, 9))
    assert len(out) == 1  # both readings of the one note are one board (30 mm de-duplication)


def _panel(i: int, *ann: str, lifecycle: str = "new") -> Det:
    return Det(
        "s", "v1", f"d_{i}", "panel", 10.0 * i, 5.0, "yellow", [], "ground", lifecycle, None, "electrical", annotations=ann
    )


def _rule(rid: str) -> SimpleNamespace:
    return SimpleNamespace(id=rid, source="default", item_code="x", description=rid, unit="")


def test_roles_follow_the_library_main_first_then_secondary_and_never_without_two_items() -> None:
    rules = [_rule("r_panel_role_main"), _rule("r_panel_role_sub")]
    both = {
        "r_panel_role_main": SimpleNamespace(item=SimpleNamespace(id=1)),
        "r_panel_role_sub": SimpleNamespace(item=SimpleNamespace(id=2)),
    }
    dets = [
        _panel(1, "panelnote", "comms"),
        _panel(2, "panelnote"),
        _panel(3, "panelnote", "comms"),
        _panel(4, lifecycle="existing"),
    ]
    assert assign_panel_roles(dets, rules, lambda r: both[r.id]) == 3  # type: ignore[arg-type]
    assert [d.annotations[-1] for d in dets[:3]] == ["commsmain", "rolesub", "commssub"]
    assert "rolemain" in dets[0].annotations and "rolesub" in dets[2].annotations
    assert dets[3].annotations == ()  # the existing board is not new work
    # one item for both roles (Noah: "14 מקום" / "36 מקום" are sizes, not roles): nothing is assigned
    same = {
        "r_panel_role_main": SimpleNamespace(item=SimpleNamespace(id=1)),
        "r_panel_role_sub": SimpleNamespace(item=SimpleNamespace(id=1)),
    }
    fresh = [_panel(1, "panelnote")]
    assert assign_panel_roles(fresh, rules, lambda r: same[r.id]) == 0  # type: ignore[arg-type]


def test_comms_on_another_line_of_the_note_and_the_existing_word_are_read_from_the_notes_box() -> None:
    # Yahav: the words run right to left on one row, "תקשורת" 14 mm from the word "לוח" but 5 mm from the note's box
    out = _notes(_span("לוח", 85.6, 218, 4), _span("חשמל", 76.1, 218, 7), _span("תקשורת", 60.5, 219, 10.7))
    assert len(out) == 1 and D.A_PANEL_COMMS in out[0].annotations
    old = _notes(_span("לוח", 111, 147, 4), _span("חשמל", 103, 147, 7), _span("כיים", 95, 149, 6))  # Achituv: the existing board
    assert len(old) == 1 and D.A_PANEL_EXISTING in old[0].annotations and D.A_PANEL_COMMS not in old[0].annotations
    assert (
        D.A_PANEL_EXISTING not in _notes(_span("לוח", 10, 10, 4), _span("חשמל", 2, 10, 7), _span("כי", 0, 14, 3))[0].annotations
    )
