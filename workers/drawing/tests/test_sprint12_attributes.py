"""Sprint 12 (Accuracy): per-fixture garden / profile-feed attributes."""

from types import SimpleNamespace

from kamutan_drawing.lighting.attributes import fixture_attributes


def _det(i, room, cls="luminaire_ceiling", x=0.0, y=0.0):
    return {"id": i, "class": cls, "roomId": room, "centerMm": {"x": x, "y": y}}


def test_timer_circuit_without_rooms_is_garden():
    dets = [_det("a", None), _det("b", None), _det("c", "r1")]
    circ = {"circuits": [{"tag": "D6", "timer": True, "fixtureIds": ["a", "b"]}, {"tag": "A1", "fixtureIds": ["c"]}]}
    assert fixture_attributes(None, [], dets, circ) == {"a": "garden", "b": "garden"}


def test_timer_circuit_indoors_is_not_garden():
    dets = [_det("a", "r1"), _det("b", "r1")]
    circ = {"circuits": [{"tag": "D6", "timer": True, "fixtureIds": ["a", "b"]}]}
    assert fixture_attributes(None, [], dets, circ) == {}


def test_landscape_banner_flags_only_roomless_fixtures():
    spans = [SimpleNamespace(text="בפיתוח יש לעיין בתכנית פיתוח של אדריכל נוף")]
    dets = [_det("a", None), _det("b", "r1"), _det("o", "r1", "luminaire_outdoor")]
    assert fixture_attributes(None, spans, dets, None) == {"a": "garden"}


def test_switch_box_read_from_tags_without_glyph_is_a_deep_box():
    from kamutan_drawing.lighting.attributes import glyphless_switch_boxes

    circ = {
        "positions": [
            {"id": "sp_1", "switchIds": [], "boxMm": {"x": 10, "y": 20, "w": 4, "h": 6}},
            {"id": "sp_2", "switchIds": ["d_9"], "boxMm": {"x": 50, "y": 20, "w": 4, "h": 6}},
        ]
    }
    sh = SimpleNamespace(sheet_id="s", version_id="v", circuits=circ, floors=["ground"], discipline="lighting")
    got = glyphless_switch_boxes(sh)
    assert [(d.id, d.cls, d.x, d.y, d.floor) for d in got] == [("box:sp_1", "switch_single", 12.0, 23.0, "ground")]
    sh.floors = ["ground", "first"]  # a compiled all-floors sheet: its boxes are the floor sheets'
    assert glyphless_switch_boxes(sh) == []
