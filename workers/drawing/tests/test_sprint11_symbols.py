"""Sprint 11 (Worker-Accuracy) — symbol fixes measured on the by-eye sheet GT of the four projects.

* "more specific" in NMS counts distinct ink, not sample points (exploded fills), and needs its added strokes on ink
  (Rubel / Yahav: ceiling points taken by the wall light or by "point + fan"; two-way switches read as single).
* a solid exported as many filled pieces: its area may differ per instance, and shifted poses of it are one instance
  (Rubel / Yahav cameras).
"""

from __future__ import annotations

import numpy as np
from scipy.spatial import cKDTree

from kamutan_drawing.symbols import match as MA
from kamutan_drawing.symbols import template as TP
from kamutan_drawing.symbols.geometry import resample

from .test_geometry import BLACK, RED, Sheet


def _tpl(vs, path_ids: list[int], tid: str, fill_area: float = 0.0, fill_pieces: int = 0) -> TP.Template:
    seg_idx = np.where(np.isin(vs.seg_path, path_ids))[0]
    segs = vs.segs[seg_idx].astype(np.float64)
    c = np.array([(segs[:, [0, 2]].min() + segs[:, [0, 2]].max()) / 2, (segs[:, [1, 3]].min() + segs[:, [1, 3]].max()) / 2])
    segs = segs - np.concatenate([c, c])
    pts, _ = resample(segs, MA.STEP)
    w = float(segs[:, [0, 2]].max() - segs[:, [0, 2]].min())
    h = float(segs[:, [1, 3]].max() - segs[:, [1, 3]].min())
    mid = np.zeros(2)
    t = TP.Template(tid, [], segs, pts, w, h, TP.Anchor("line", mid, mid=np.array([1.0, 0.0]), length=w), 0.0, 1.0, False)
    t.fill_area, t.fill_pieces, t.tree = fill_area, fill_pieces, cKDTree(pts)
    return t


def _cand(t: TP.Template, xy: tuple[float, float], q: float) -> MA.Candidate:
    c = MA.Candidate(t, xy, np.eye(2), 1.0, 0.0, 1.0)
    c.quality = q
    return c


def _cross(s: Sheet, cx: float, cy: float, arm: float = 2.5) -> None:
    s.line([(cx - arm, cy), (cx + arm, cy)], RED)
    s.line([(cx, cy - arm), (cx, cy + arm)], RED)


def test_more_specific_counts_distinct_ink_not_sample_points() -> None:
    """The wall light's exploded fill repeats its strokes: many more points, the same ink — not "more specific"."""
    s = Sheet()
    _cross(s, 20.0, 20.0)  # paths 0, 1: the plain point
    for _ in range(3):  # paths 2..7: the same cross drawn three times over (an exploded fill's repeated strokes)
        _cross(s, 20.0, 20.0)
    vs = s.build()
    point = _tpl(vs, [0, 1], "point")
    dup = _tpl(vs, [2, 3, 4, 5, 6, 7], "dup")
    assert len(dup.pts) >= 1.25 * len(point.pts)  # the old rule: clearly "more strokes"
    assert MA._ink_cells(dup) == MA._ink_cells(point)
    kept = MA._nms([_cand(point, (20.0, 20.0), 0.90), _cand(dup, (20.0, 20.0), 0.85)], 0.45)
    assert [c.tpl.id for c in kept] == ["point"] and kept[0].runner_up == 0.85


def test_a_containing_drawing_replaces_only_when_its_added_strokes_are_drawn() -> None:
    """Point vs "point + fan" (the same cross inside a box): the fan wins where the box is drawn, not on a bare point."""
    s = Sheet()
    _cross(s, 20.0, 20.0)  # 0, 1 legend point
    _cross(s, 40.0, 20.0)  # 2, 3 legend fan: cross …
    s.rect(36.5, 16.5, 43.5, 23.5, BLACK)  # 4 … in a box
    _cross(s, 100.0, 100.0)  # plan: a bare point
    _cross(s, 140.0, 100.0)  # plan: a real fan
    s.rect(136.5, 96.5, 143.5, 103.5, BLACK)
    vs = s.build()
    point, fan = _tpl(vs, [0, 1], "point"), _tpl(vs, [2, 3, 4], "fan")
    assert MA._ink_cells(fan) >= 1.25 * MA._ink_cells(point)
    scene = MA.build_scene(vs, [(0.0, 0.0, 60.0, 40.0)])  # the legend area is not searched
    bare = MA._nms([_cand(point, (100.0, 100.0), 0.92), _cand(fan, (100.0, 100.0), 0.86)], 0.45, frozenset(), scene)
    assert [c.tpl.id for c in bare] == ["point"]
    real = MA._nms([_cand(point, (140.0, 100.0), 0.92), _cand(fan, (140.0, 100.0), 0.86)], 0.45, frozenset(), scene)
    assert [c.tpl.id for c in real] == ["fan"] and real[0].runner_up == 0.92
    # without a scene (callers that have none) the previous behaviour holds
    assert [c.tpl.id for c in MA._nms([_cand(point, (100.0, 100.0), 0.92), _cand(fan, (100.0, 100.0), 0.86)], 0.45)] == ["fan"]


def test_exploded_fill_area_band_and_one_instance_per_overlapping_pose() -> None:
    s = Sheet()
    s.rect(10.0, 10.0, 13.0, 13.5, RED)  # 0: the camera's outline (stands for circle + cone)
    for k in range(8):  # the plan instance's solid: 8 filled strips, 6 mm² in all (the legend's sum to 8)
        s.fill([(50.0 + 0.375 * k, 50.0), (50.375 + 0.375 * k, 50.0), (50.375 + 0.375 * k, 52.0), (50.0 + 0.375 * k, 52.0)], RED)
    vs = s.build()
    scene = MA.build_scene(vs, [])
    centre = np.array([51.5, 51.0])
    whole = _tpl(vs, [0], "whole", fill_area=8.0, fill_pieces=1)
    cam = _tpl(vs, [0], "cam", fill_area=8.0, fill_pieces=11)  # cut into 11 pieces in the legend, 8 here
    same = _tpl(vs, [0], "same", fill_area=8.0, fill_pieces=8)  # a copy cut the same way: compared exactly
    d_whole = MA.fill_difference(whole, scene, centre, np.eye(2), 1.0)
    d_cam = MA.fill_difference(cam, scene, centre, np.eye(2), 1.0)
    assert d_whole > 0.15  # a one-piece solid: 2 mm² missing of 8 is another drawing
    assert d_cam == 0.0  # an exploded one: inside the band
    assert MA.fill_difference(same, scene, centre, np.eye(2), 1.0) == d_whole
    assert MA.fill_difference(cam, scene, np.array([200.0, 200.0]), np.eye(2), 1.0) > 0.4  # no solid at all: still a difference
    # two poses of the exploded drawing 2 mm apart share few points but are one instance; a one-piece drawing keeps both
    a, b = _cand(cam, (51.5, 51.0), 0.75), _cand(cam, (53.5, 51.0), 0.62)
    assert [c.quality for c in MA._nms([a, b], 0.45)] == [0.75]
    a2, b2 = _cand(whole, (51.5, 51.0), 0.75), _cand(whole, (53.5, 51.0), 0.62)
    assert len(MA._nms([a2, b2], 0.45)) == 2


def _tick_glyph(s: Sheet, x: float, y: float, ticks: int, tick_len: float = 4.0) -> list[int]:
    """Stem along +x from (x, y) crossed by ``ticks`` vertical lines 0.6 mm apart; returns nothing (paths in order)."""
    s.line([(x, y), (x + 3.0, y)], RED)
    for k in range(ticks):
        s.line([(x + 0.6 + 0.6 * k, y - tick_len / 2), (x + 0.6 + 0.6 * k, y + tick_len / 2)], RED)
    return []


def test_tick_count_decides_between_power_and_three_phase() -> None:
    """Achituv: power = two ticks, 3-phase = three; the fit was 0.870 vs 0.867. The count read on the plan decides,
    also when stacked sockets share one long pair of ticks, and never from a long dimension line."""
    from kamutan_drawing.legend.parse import LegendEntry
    from kamutan_drawing.symbols import ticks as TK

    s = Sheet()
    _tick_glyph(s, 10.0, 10.0, 2)  # paths 0..2: legend power
    _tick_glyph(s, 10.0, 30.0, 3)  # paths 3..6: legend 3-phase
    _tick_glyph(s, 100.0, 100.0, 2)  # plan: a power socket
    _tick_glyph(s, 140.0, 100.0, 3)  # plan: a 3-phase socket
    s.line([(200.0, 100.0), (203.0, 100.0)], RED)  # plan: two stacked power sockets sharing their ticks …
    s.line([(200.0, 104.0), (203.0, 104.0)], RED)
    for k in range(2):
        s.line([(200.6 + 0.6 * k, 98.0), (200.6 + 0.6 * k, 106.0)], RED)  # … 8 mm long
    s.line([(201.8, 60.0), (201.8, 160.0)], RED)  # a dimension line through them: not a tick
    vs = s.build()

    def tpl(paths: list[int], tid: str) -> TP.Template:
        t = _tpl(vs, paths, tid)
        idx = np.where(np.isin(vs.seg_path, paths))[0]
        t.entries = [LegendEntry(0, "lg0", "symbol", (0, 0, 1, 1), None, tid, 0.9, "", idx, None, 0.0, tid)]
        return t

    power, three = tpl([0, 1, 2], "power"), tpl([3, 4, 5, 6], "three")
    sp, s3 = TK.tick_signature(power, vs), TK.tick_signature(three, vs)
    assert sp is not None and s3 is not None and (sp.count, s3.count) == (2, 3) and abs(sp.length - 4.0) < 1e-6
    scene = MA.build_scene(vs, [(0.0, 0.0, 60.0, 60.0)])

    def at(t: TP.Template, x: float, y: float) -> MA.Candidate:
        return _cand(t, (x + 1.5, y), 0.87)  # the template frame is centred on its box

    wrong_three, right_three = at(three, 100.0, 100.0), at(three, 140.0, 100.0)
    wrong_power, stacked = at(power, 140.0, 100.0), at(three, 200.0, 100.0)
    assert TK.resolve_by_ticks([wrong_three, right_three, wrong_power, stacked], [power, three], scene, vs) == 3
    assert [c.tpl.id for c in (wrong_three, right_three, wrong_power, stacked)] == ["power", "three", "three", "power"]
    assert wrong_three.runner_up_id == "three"
    # a drawing without ticks, or with no sibling of another count, is never touched
    lone = at(power, 100.0, 100.0)
    assert TK.resolve_by_ticks([lone], [power], scene, vs) == 0 and lone.tpl.id == "power"


def test_cross_switch_is_its_own_class_and_its_own_drawing() -> None:
    """Achituv: "מחלף" (two hooked tails) and "מצלב" (three) share a dot whose fill repeats its outline; counted on
    distinct ink the third tail is no longer under the family threshold, and the label has its own class."""
    from kamutan_drawing.legend.classes import suggest_class

    assert suggest_class("מצלב", 0.9)[0] == "switch_cross"
    assert suggest_class("מחלף", 0.9)[0] == "switch_2way"

    def glyph(s: Sheet, cx: float, cy: float, tails: int) -> None:
        for _ in range(12):  # the dot: the same small square drawn over and over (an exploded fill)
            s.line(
                [(cx - 0.4, cy - 0.4), (cx + 0.4, cy - 0.4), (cx + 0.4, cy + 0.4), (cx - 0.4, cy + 0.4), (cx - 0.4, cy - 0.4)],
                RED,
            )
        ends = [(-2.6, -2.2), (2.6, 2.2), (-2.2, 2.6)][:tails]
        for dx, dy in ends:
            s.line([(cx, cy), (cx + dx, cy + dy)], RED)

    s = Sheet()
    glyph(s, 20.0, 20.0, 2)  # paths 0..13
    glyph(s, 40.0, 20.0, 3)  # paths 14..28
    vs = s.build()
    two, three = _tpl(vs, list(range(14)), "two"), _tpl(vs, list(range(14, 29)), "three")
    assert not TP.same_drawing(two, three)
    assert TP.same_drawing(two, _tpl(vs, list(range(14)), "again"))


def _disc(s: Sheet, cx: float, cy: float, r: float = 1.9) -> None:
    import math

    pts = [(cx + r * math.cos(2 * math.pi * k / 24), cy + r * math.sin(2 * math.pi * k / 24)) for k in range(24)]
    s.fill(pts, (255, 255, 0))


def _ceiling(s: Sheet, cx: float, cy: float) -> None:
    _disc(s, cx, cy)
    s.line([(cx - 2.7, cy), (cx + 2.7, cy)], BLACK)
    s.line([(cx, cy - 2.7), (cx, cy + 2.7)], BLACK)


def _wall(s: Sheet, cx: float, cy: float, side: float = 1.0) -> None:
    _disc(s, cx, cy)
    s.line([(cx - 2.7, cy), (cx + 2.7, cy)], BLACK)
    s.line([(cx + side * 2.0, cy - 2.3), (cx + side * 2.0, cy + 2.3)], BLACK)  # the bar on the wall side, tangent


def test_lines_across_the_disc_tell_a_ceiling_point_from_a_wall_light() -> None:
    """Rubel / Yahav / Achituv: disc + cross through the centre = ceiling point, disc + line + tangent bar = wall
    light (bar on either side); the fits differ by < 0.01."""
    from kamutan_drawing.legend.parse import LegendEntry
    from kamutan_drawing.symbols import ticks as TK

    s = Sheet()
    _ceiling(s, 20.0, 20.0)  # paths 0..2
    _wall(s, 40.0, 20.0)  # paths 3..5
    _ceiling(s, 100.0, 100.0)
    _wall(s, 140.0, 100.0, side=-1.0)
    _wall(s, 180.0, 100.0)
    _wall(s, 184.5, 100.0)  # a second fitting right beside it
    vs = s.build()

    def tpl(paths: list[int], tid: str) -> TP.Template:
        t = _tpl(vs, paths, tid)
        idx = np.where(np.isin(vs.seg_path, paths))[0]
        t.entries = [LegendEntry(0, "lg0", "symbol", (0, 0, 1, 1), None, tid, 0.9, "", idx, None, 0.0, tid)]
        return t

    ceil_t, wall_t = tpl([0, 1, 2], "ceiling"), tpl([3, 4, 5], "wall")
    sc, sw = TK.disc_signature(ceil_t, vs), TK.disc_signature(wall_t, vs)
    assert sc is not None and sw is not None and (sc.centre, sc.tangent) == (2, 0) and (sw.centre, sw.tangent) == (1, 1)
    scene = MA.build_scene(vs, [(0.0, 0.0, 60.0, 40.0)])
    a, b = _cand(wall_t, (100.0, 100.0), 0.86), _cand(ceil_t, (140.0, 100.0), 0.86)
    c, d = _cand(ceil_t, (180.0, 100.0), 0.86), _cand(wall_t, (140.0, 100.0), 0.86)
    assert TK.resolve_by_disc_lines([a, b, c, d], [ceil_t, wall_t], scene, vs) == 3
    assert [x.tpl.id for x in (a, b, c, d)] == ["ceiling", "wall", "wall", "wall"]
    # nothing drawn there (no disc): the candidate is left alone
    e = _cand(wall_t, (300.0, 200.0), 0.86)
    assert TK.resolve_by_disc_lines([e], [ceil_t, wall_t], scene, vs) == 0 and e.tpl.id == "wall"


def test_a_note_box_against_the_legend_is_a_frame_not_a_symbol() -> None:
    """Rubel ground lighting: a note boxed right above the legend, drawn 0.3 mm out of level, is not a "rule"; as a
    symbol group centred between the two symbol columns it chained them into one (rows 42 mm wide, a bogus row for
    the box). A group nearly as wide as the table is a frame."""
    from kamutan_drawing.legend.parse import parse_legends
    from kamutan_drawing.ocr.dictionary import TextSpan

    s = Sheet()
    spans: list[TextSpan] = []
    x0, x1, y0, rows = 100.0, 180.0, 50.0, 5
    s.rect(x0, y0, x1, y0 + 6.0 * rows, BLACK)
    for r in range(1, rows):
        s.line([(x0, y0 + 6.0 * r), (x1, y0 + 6.0 * r)], BLACK)
    labels = ["שקע בודד", "שקע כח", "מתג הפעלה", "נק' רמקול", "פעמון", "מצלמה", "קיבורד", "גלאי עשן", "וונטה", "תרמוסטט"]
    k = 0
    for r in range(rows):
        cy = y0 + 6.0 * r + 3.0
        for cx, lx in ((175.0, 150.0), (135.0, 110.0)):
            s.line([(cx - 2, cy - 2), (cx + 2, cy - 2), (cx + 2, cy + 2), (cx - 2, cy + 2), (cx - 2, cy - 2)], RED)
            s.line([(cx - 2, cy - 2 + 0.5 * (k % 5)), (cx + 2, cy + 2)], RED)
            spans.append(TextSpan("s", (lx, cy - 1.0, lx + 16.0, cy + 1.0), labels[k], 0.9, 2.0, 0, 8))
            k += 1
    spans.append(TextSpan("s", (168.0, y0 - 11.0, 180.0, y0 - 8.0), "מקרא:", 0.9, 2.5, 0, 5))
    # the note box: long sides 0.3 mm out of level, touching the table's top
    s.line([(x0 + 0.5, y0 - 6.5), (x1, y0 - 6.8), (x1, y0 - 0.8), (x0 + 0.5, y0 - 0.5), (x0 + 0.5, y0 - 6.5)], RED)
    spans.append(TextSpan("s", (x0 + 4.0, y0 - 5.5, x1 - 4.0, y0 - 2.0), "יש לבצע חיזוקי עץ לכל המאווררים", 0.9, 3.5, 0, 26))
    leg = parse_legends(s.build(), spans)
    entries = [e for lg in leg.legends for e in lg.entries]
    assert sorted(e.label for e in entries) == sorted(labels)
    assert all(abs((e.symbol_bbox[2] - e.symbol_bbox[0]) - 4.0) < 0.3 for e in entries)


def test_a_filled_outline_of_a_stroked_line_is_not_a_solid_for_a_stroke_only_symbol() -> None:
    """Rubel's purple AC socket: a stroked arc plus its 0.05 mm wide "filled" outline. The stroke-only legend socket
    must not be charged 2 mm² of extra fill for it — but a real solid beside it still counts."""
    s = Sheet()
    s.line([(10.0, 10.0), (14.0, 10.0), (14.0, 13.0)], RED)  # 0: the stroked ink
    s.fill([(10.0, 10.02), (14.02, 10.02), (14.02, 13.0), (14.0, 13.0), (14.0, 10.04), (10.0, 10.04)], RED)  # 1: its outline
    for k in range(3):  # 2..: a real solid elsewhere (a filled square), sitting on no stroke
        s.rect(50.0 + 0.0 * k, 50.0, 53.0, 53.0, RED)
    vs = s.build()
    scene = MA.build_scene(vs, [])
    assert scene.fill_outline is not None and scene.fill_outline.sum() >= 1
    stroke_only = _tpl(vs, [0], "stroke", fill_area=0.0, fill_pieces=0)
    on_line = MA.fill_difference(stroke_only, scene, np.array([12.0, 11.5]), np.eye(2), 1.0)
    on_solid = MA.fill_difference(stroke_only, scene, np.array([51.5, 51.5]), np.eye(2), 1.0)
    assert on_line == 0.0
    assert on_solid > 0.2


def test_a_vivid_colour_no_legend_symbol_uses_is_kept_and_not_vetoed() -> None:
    """The colour mask dropped Rubel's purple AC sockets with the furniture; a colour the legend never uses names
    nothing (neither for nor against), a legend colour of ANOTHER symbol still does."""
    from kamutan_drawing.symbols.detect import foreign_vivid

    legend = {(237, 31, 36), (147, 39, 143)}
    rgb = np.array([(166, 79, 238), (237, 31, 36), (150, 40, 140), (102, 93, 87), (0, 0, 0), (255, 255, 10)])
    assert foreign_vivid(rgb, legend).tolist() == [True, False, False, False, False, True]


def test_a_leader_note_naming_three_phase_reclasses_the_socket_it_points_at() -> None:
    """Yahav: "שקע תלת פאזי לג'קוזי" stands 10-25 mm from its two-tick socket and the reader drops a word of it."""
    from kamutan_drawing.ocr.dictionary import TextSpan
    from kamutan_drawing.symbols import detect as D

    def sock(cls: str, x: float, y: float) -> D.Detection:
        return D.Detection(cls, (x, y), (x - 1.5, y - 1.5, x + 1.5, y + 1.5), source="vector")

    def span(text: str, cx: float, cy: float) -> TextSpan:
        return TextSpan("s", (cx - 3.0, cy - 1.0, cx + 3.0, cy + 1.0), text, 0.95, 2.0, 0, len(text))

    a, other = sock("socket_power", 100.0, 100.0), sock("socket_power", 100.0, 140.0)
    D._annotate([a, other], D.TextIndex([span("תלת", 75.0, 100.0)]), [])  # 22 mm along the line, the other far away
    assert a.cls == "socket_3phase" and other.cls == "socket_power"
    b = sock("socket_power", 100.0, 100.0)
    D._annotate([b], D.TextIndex([span("תלת", 40.0, 100.0)]), [])  # 55 mm: out of reach
    assert b.cls == "socket_power"
    c, near = sock("socket_power", 100.0, 100.0), sock("socket_single", 80.0, 110.0)
    D._annotate([c, near], D.TextIndex([span("תלת", 76.0, 106.0)]), [])  # a nearer socket of another kind owns the note
    assert c.cls == "socket_power" and near.cls == "socket_single"
