"""Sprint 8 (Worker-Accuracy): chapter-04 / 9.01 causes on the Noah sheets, fixed in detection.

* leader terminators and the leader leg ending on them do not count as extra ink in the reverse chamfer
  (4.00: the first-floor bedroom-2 socket whose cobra leader ends on a dot at its centre was missed);
* "2X" / "3X" read from strokes: a hatch of another colour never joins a glyph (4.00 / 4.01: the green patio
  hatch merged into "2X"), and two glyphs with a third one between them are not a word (4.00 / 4.02: "2" and "0"
  of "H=240" read as "3X");
* a "see note" cross named by a hub note ("ריכוז רמקולים") is not an item (4.07 stays 3);
* a vector match centred on a fixture type tag is the tag, not a fixture (9.01: the kitchen strip counted twice).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np
from scipy.spatial import cKDTree

from kamutan_drawing.ocr.dictionary import TextSpan
from kamutan_drawing.symbols import detect as D
from kamutan_drawing.symbols import marks as MK
from kamutan_drawing.symbols import match as MA
from kamutan_drawing.symbols.geometry import Group, resample
from kamutan_drawing.symbols.tags import Tag
from kamutan_drawing.symbols.template import Anchor, Template

from .test_geometry import BLACK, Sheet

GREEN = (0, 200, 0)


def _circle(cx: float, cy: float, r: float, n: int = 24) -> list[tuple[float, float]]:
    return [(cx + r * math.cos(2 * math.pi * k / n), cy + r * math.sin(2 * math.pi * k / n)) for k in range(n + 1)]


def _socket(s: Sheet, cx: float, cy: float) -> Sheet:
    """Circle r 1.6 + bar tangent on the left + stem (a socket drawn in lines)."""
    s.line(_circle(cx, cy, 1.6), BLACK)
    s.line([(cx - 1.6, cy - 1.6), (cx - 1.6, cy + 1.6)], BLACK)
    s.line([(cx - 1.6, cy), (cx - 2.9, cy)], BLACK)
    return s


def _template() -> tuple[Template, np.ndarray]:
    s = _socket(Sheet(), 0.0, 0.0).build()
    segs = s.segs.astype(np.float64)
    c = np.array([(segs[:, [0, 2]].min() + segs[:, [0, 2]].max()) / 2, (segs[:, [1, 3]].min() + segs[:, [1, 3]].max()) / 2])
    segs = segs - np.concatenate([c, c])
    pts, _ = resample(segs, MA.STEP)
    w = float(segs[:, [0, 2]].max() - segs[:, [0, 2]].min())
    h = float(segs[:, [1, 3]].max() - segs[:, [1, 3]].min())
    t = Template("t", [], segs, pts, w, h, Anchor("arc", -c, r=1.6, coverage=360.0), 0.5, 1.0, False)
    t.tree = cKDTree(pts)
    return t, c


def _reverse(s: Sheet, at: tuple[float, float]) -> tuple[float, float]:
    tpl, c = _template()
    vs = s.build()
    scene = MA.build_scene(vs, [])
    centre = np.array(at, dtype=np.float64) + c
    return MA.reverse(tpl, scene, centre, np.eye(2), 1.0)


def test_leader_ending_on_a_dot_inside_the_symbol_is_not_extra_ink() -> None:
    clean = _reverse(_socket(Sheet(), 50, 50), (50, 50))
    # the note's leader: underline → down to the stem → on to a filled dot at the circle's centre (one polyline)
    led = _socket(Sheet(), 50, 50)
    led.line([(40, 58), (46.5, 58), (46.5, 50), (50.2, 50)], BLACK)
    led.fill([(50.0, 49.85), (50.35, 49.85), (50.35, 50.2), (50.0, 50.2)], BLACK)
    with_dot = _reverse(led, (50, 50))
    assert with_dot[1] >= 0.95 and with_dot[0] <= clean[0] + 0.02
    # the same leader without a terminator, or a short stroke inside: still extra ink (unchanged)
    bare = _socket(Sheet(), 50, 50)
    bare.line([(40, 58), (46.5, 58), (46.5, 50), (50.2, 50)], BLACK)
    assert _reverse(bare, (50, 50))[1] < with_dot[1] - 0.05
    cross = _socket(Sheet(), 50, 50)
    cross.line([(49.0, 50), (50.4, 50)], BLACK)
    cross.fill([(50.3, 49.85), (50.6, 49.85), (50.6, 50.2), (50.3, 50.2)], BLACK)  # its own path ends inside the box
    assert _reverse(cross, (50, 50))[1] < with_dot[1] - 0.05


def test_scene_flags_terminators_and_leader_legs() -> None:
    s = Sheet().line([(0, 0), (10, 0), (10, 10)], BLACK)
    s.fill([(9.8, 9.8), (10.2, 9.8), (10.2, 10.2), (9.8, 10.2)], BLACK)  # dot at the polyline's end
    s.fill([(30, 30), (40, 30), (40, 40), (30, 40)], BLACK)  # a filled wall piece: not a terminator
    sc = MA.build_scene(s.build(), [])
    assert sc.seg_terminator is not None and sc.seg_leader_end is not None
    path = s.build().seg_path[sc.seg_ids]
    assert sc.seg_terminator[path == 1].all() and not sc.seg_terminator[path == 2].any()
    assert sc.seg_leader_end.tolist()[:2] == [False, True]  # only the leg that ends on the dot


# ---------------------------------------------------------------------------------------------- 2X / 3X marks
def _g(cx: float, cy: float, size: float = 1.6) -> Group:
    return Group(np.array([0]), (cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2))


def test_two_glyphs_with_one_between_are_not_a_word() -> None:
    a, mid, b = _g(10, 10), _g(11.9, 10), _g(13.8, 10)
    assert MK._glyph_between([a, mid, b], a, b, 1.6)
    assert not MK._glyph_between([a, b], a, b, 1.6)
    off = _g(11.9, 13.0)  # a glyph of another line is not between them
    assert not MK._glyph_between([a, off, b], a, b, 1.6)


def test_hatch_of_another_colour_does_not_join_a_glyph() -> None:
    s = Sheet()
    s.line([(10, 10), (11, 11.6)], BLACK).line([(11, 10), (10, 11.6)], BLACK)  # an "X"
    s.line([(10.2, 10.8), (10.8, 10.8)], GREEN).line([(10.5, 10.5), (10.5, 11.1)], GREEN)  # hatch "+" on it
    vs = s.build()
    segs = vs.segs.astype(np.float64)
    idx = np.arange(len(segs))
    assert len(MK._local_groups(segs, idx)) == 1  # merged without colours
    lib = MK.GlyphLibrary()
    by_colour = MK._local_groups(segs, idx, lib.sheet_colours(vs))
    assert len(by_colour) == 2 and sorted(len(g.segs) for g in by_colour) == [2, 2]


# ---------------------------------------------------------------------------------------------- notes / tags
def _span(text: str, bbox: tuple[float, float, float, float]) -> TextSpan:
    return TextSpan("s", bbox, text, 0.9, bbox[3] - bbox[1], 0, len(text))


@dataclass
class _Cand:
    center: tuple[float, float]
    quality: float = 0.95
    angle_deg: int = 0

    def bbox(self) -> tuple[float, float, float, float]:
        return (self.center[0] - 1.5, self.center[1] - 1.5, self.center[0] + 1.5, self.center[1] + 1.5)


@dataclass
class _Entry:
    label: str = "ראה הערה"


def _note_items(texts: list[tuple[str, tuple[float, float, float, float]]]) -> list[Any]:
    tix = D.TextIndex([_span(t, b) for t, b in texts])
    return D._note_items([(_Cand((50.0, 50.0)), _Entry())], tix, [])  # type: ignore[list-item]


def test_hub_note_does_not_make_the_cross_an_item() -> None:
    hub = _note_items([("ריכוז", (53.0, 46.0, 60.0, 47.9)), ("רמקולים", (52.0, 48.0, 60.0, 50.0))])
    assert hub == []
    one = _note_items([("פעמון דלת", (52.0, 48.0, 60.0, 50.0))])
    assert [d.cls for d in one] == ["doorbell"]
    far = _note_items([("ריכוז", (53.0, 30.0, 60.0, 32.0)), ("נק' רמקול", (52.0, 48.0, 60.0, 50.0))])
    assert [d.cls for d in far] == ["speaker"]  # "ריכוז" of another note, not touching this one


def test_a_match_centred_on_a_type_tag_is_the_tag() -> None:
    tag = Tag(entry=None, cx=312.0, cy=69.28, r=1.88, dist=0.01, margin=0.02)  # type: ignore[arg-type]
    on = D.Detection("luminaire_wall", (312.0, 69.11), (309.75, 66.28, 314.26, 71.95))
    beside = D.Detection("luminaire_ceiling", (309.17, 65.81), (306.48, 63.12, 311.86, 68.5))
    assert D._on_tag(on, [tag]) and not D._on_tag(beside, [tag])
