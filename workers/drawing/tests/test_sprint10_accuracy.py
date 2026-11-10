"""Sprint 10 (Worker-Accuracy): detection generalisation found on the Rubel / Achituv / Yahav electrical sheets.

* two legend drawings are one *family* only when nearly every point of each lies on the other (circled letters
  M / T / ג / צ / פ / V on the same ring were merged into one family before, and every ring became a "thermostat");
* circled-letter rows form a *ring family*: the ring is the template, the letter inside (strokes or a font text
  span) picks the member; an empty ring is nothing, an unreadable glyph is an ``unknown`` the reviewer sees;
* legend rows of the designer's wider catalogue get classes (smoke detector, camera, thermostat, alarm detector,
  siren, keypad, shutter feed, ventilator) instead of "no class" / the generic heater feed; shutter switches keep
  Noah's class and carry the annotation ``לתריס``;
* colour consistency: a candidate drawn in colours the legend drawing never uses is vetoed before NMS (a yellow
  wall light posed on an orange camera); a template whose dominant colour is unique gets a lower quality floor;
* a ring family yields in NMS to a containing, more specific drawing (the camera = circle + cone);
* ``+TYPE C`` / ``USB`` and ``שקע קופץ`` beside a socket become annotations (BOQ add-on lines).
"""

from __future__ import annotations

import math

import numpy as np
from scipy.spatial import cKDTree

from kamutan_drawing.legend.parse import LegendEntry
from kamutan_drawing.ocr.dictionary import TextSpan
from kamutan_drawing.symbols import detect as D
from kamutan_drawing.symbols import legend_extra as LX
from kamutan_drawing.symbols import match as MA
from kamutan_drawing.symbols import rings as RG
from kamutan_drawing.symbols import template as TP
from kamutan_drawing.symbols.geometry import resample

from .test_geometry import BLACK, RED, Sheet

ORANGE = (226, 128, 29)
YELLOW = (255, 255, 10)
R = 1.7  # ring radius of the designer's circled symbols


def _circle(cx: float, cy: float, r: float, n: int = 36) -> list[tuple[float, float]]:
    return [(cx + r * math.cos(2 * math.pi * k / n), cy + r * math.sin(2 * math.pi * k / n)) for k in range(n + 1)]


def _letter_m(cx: float, cy: float, h: float = 1.6) -> list[list[tuple[float, float]]]:
    w = 0.6 * h
    return [[(cx - w, cy + h / 2), (cx - w, cy - h / 2), (cx, cy + h / 4), (cx + w, cy - h / 2), (cx + w, cy + h / 2)]]


def _letter_t(cx: float, cy: float, h: float = 1.6) -> list[list[tuple[float, float]]]:
    return [[(cx - 0.5 * h, cy - h / 2), (cx + 0.5 * h, cy - h / 2)], [(cx, cy - h / 2), (cx, cy + h / 2)]]


def _ring(s: Sheet, cx: float, cy: float, rgb: tuple[int, int, int], letter: str | None) -> None:
    s.line(_circle(cx, cy, R), rgb)
    for pl in {"M": _letter_m, "T": _letter_t}.get(letter or "", lambda *_: [])(cx, cy):
        s.line(pl, rgb)


def _mark_curves(vs, path_ids: list[int]) -> None:
    """Flag the circle polylines as curved pieces so the anchor finder fits an arc (the Sheet builder writes lines)."""
    for p in path_ids:
        vs.seg_kind[vs.seg_path == p] = 1


def _entry(n: int, label: str, vs, path_ids: list[int], cls: str | None) -> LegendEntry:
    seg_idx = np.where(np.isin(vs.seg_path, path_ids))[0].astype(np.int64)
    s = vs.segs[seg_idx]
    bb = (float(s[:, [0, 2]].min()), float(s[:, [1, 3]].min()), float(s[:, [0, 2]].max()), float(s[:, [1, 3]].max()))
    return LegendEntry(n, "lg0", "symbol", bb, None, label, 0.9, "", seg_idx, cls, 0.7 if cls else 0.0, f"sig{n}")


def _span(text: str, cx: float, cy: float, w: float = 1.6, h: float = 2.0) -> TextSpan:
    return TextSpan("s", (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2), text, 0.95, h, 0, len(text))


def _legend_sheet() -> tuple[object, list[LegendEntry]]:
    """Three legend rows: ring+M (red), ring+T (orange, letter kept), bare ring (orange, letter lost to the reader)."""
    s = Sheet()
    _ring(s, 20.0, 20.0, RED, "M")  # paths 0, 1
    _ring(s, 20.0, 30.0, ORANGE, "T")  # paths 2, 3, 4
    _ring(s, 20.0, 40.0, ORANGE, None)  # path 5
    vs = s.build()
    _mark_curves(vs, [0, 2, 5])
    entries = [
        _entry(0, "הזנה לתריס חשמלי", vs, [0, 1], None),
        _entry(1, "תרמוסטט", vs, [2, 3, 4], None),
        _entry(2, "וונטה", vs, [5], "heater_feed"),
    ]
    LX.refine_entries(entries)
    return vs, entries


# ------------------------------------------------------------------------------------ families
def test_circled_letters_are_not_one_family_but_identical_drawings_are() -> None:
    vs, entries = _legend_sheet()
    ts = [TP.build_template(f"t{e.n}", e, vs) for e in entries]
    assert all(t is not None for t in ts)
    m, t, bare = ts
    assert m.anchor.kind == "arc" and abs(m.anchor.r - R) < 0.1
    assert not TP.same_drawing(m, t)  # M vs T: the letters are unexplained ink
    assert not TP.same_drawing(m, bare)
    # the same drawing elsewhere on the sheet is still a look-alike (the socket / 2X socket family)
    s2 = Sheet()
    _ring(s2, 20.0, 20.0, RED, "M")
    _ring(s2, 60.0, 20.0, RED, "M")
    vs2 = s2.build()
    _mark_curves(vs2, [0, 2])
    a = TP.build_template("a", _entry(0, "a", vs2, [0, 1], "x"), vs2)
    b = TP.build_template("b", _entry(1, "b", vs2, [2, 3], "y"), vs2)
    assert a is not None and b is not None and TP.same_drawing(a, b)
    fams = TP.build_templates(entries, vs)
    assert len(fams) == 3


# ------------------------------------------------------------------------------- ring families
def test_ring_family_merges_the_rings_and_reads_the_members() -> None:
    vs, entries = _legend_sheet()
    ts = TP.build_templates(entries, vs)
    fams = RG.merge_ring_families(ts, vs, [])
    assert len(fams) == 1 and fams[0].ring is not None
    fam = fams[0]
    assert [e.label for e in fam.entries] == ["הזנה לתריס חשמלי", "תרמוסטט", "וונטה"]
    assert abs(fam.ring.r - R) < 0.1 and fam.w == fam.h
    # the ring-only template holds no inner ink
    assert float(np.hypot(fam.pts[:, 0], fam.pts[:, 1]).min()) > 0.8 * R
    by = {m.entry.label: m for m in fam.ring.members}
    assert len(by["הזנה לתריס חשמלי"].inner) > 0 and "M" in by["הזנה לתריס חשמלי"].letters
    assert len(by["תרמוסטט"].inner) > 0 and {"T", "ת"} <= by["תרמוסטט"].letters
    assert len(by["וונטה"].inner) == 0 and "V" in by["וונטה"].letters  # letter lost in the legend: literal channel only


def test_ring_member_from_inner_strokes_text_or_nothing() -> None:
    vs, entries = _legend_sheet()
    fam = RG.merge_ring_families(TP.build_templates(entries, vs), vs, [])[0]
    # a plan sheet: ring with M strokes, ring with T strokes, bare rings
    s = Sheet()
    _ring(s, 100.0, 100.0, RED, "M")
    _ring(s, 140.0, 100.0, ORANGE, "T")
    _ring(s, 180.0, 100.0, ORANGE, None)
    _ring(s, 220.0, 100.0, ORANGE, None)
    _ring(s, 260.0, 100.0, ORANGE, None)
    plan = s.build()
    spans = [_span("V", 180.0, 100.0), _span("X", 220.0, 100.0), _span("O", 260.0, 100.0)]
    e, amb, word = RG.resolve_member(fam, (100.0, 100.0), 1.0, plan, spans)
    assert e is not None and e.label == "הזנה לתריס חשמלי" and not amb
    e, amb, _ = RG.resolve_member(fam, (140.0, 100.0), 1.0, plan, spans)
    assert e is not None and e.label == "תרמוסטט" and not amb
    e, amb, word = RG.resolve_member(fam, (180.0, 100.0), 1.0, plan, spans)
    assert e is not None and e.label == "וונטה" and word == "V"
    e, amb, word = RG.resolve_member(fam, (220.0, 100.0), 1.0, plan, spans)
    assert e is None and amb and word == "X"  # a glyph no member owns → unknown for the reviewer
    e, amb, _ = RG.resolve_member(fam, (260.0, 100.0), 1.0, plan, spans)
    assert e is None and not amb  # "O" is the ring itself as the reader sees it: an empty ring is not an item


def test_a_single_circled_symbol_keeps_its_own_template() -> None:
    s = Sheet()
    _ring(s, 20.0, 20.0, RED, "M")
    vs = s.build()
    _mark_curves(vs, [0])
    ts = TP.build_templates([_entry(0, "הזנה לתריס חשמלי", vs, [0, 1], "shutter_feed")], vs)
    assert RG.merge_ring_families(ts, vs, []) == ts and ts[0].ring is None


# ------------------------------------------------------------------------------ catalogue classes
def test_extra_classes_for_the_wider_catalogue() -> None:
    assert LX.extra_class("גלאי עשן")[0] == "smoke_detector"  # final letter in the label
    assert LX.extra_class("מצלמה")[0] == "camera"
    assert LX.extra_class("תרמוסטט")[0] == "thermostat"
    assert LX.extra_class("גלאי אזעקה")[0] == "alarm_detector"
    assert LX.extra_class("צופר")[0] == "siren"
    assert LX.extra_class("קיבורד")[0] == "keypad"
    assert LX.extra_class("הזנה לתריס חשמלי")[0] == "shutter_feed"
    assert LX.extra_class("וונטה")[0] == "ventilator_feed"
    for label in ("שקע בודד", "תנור חימום לחדר רחצה", "מפסק לתריס", "מתג לתריס", "נק' מאור תקרתית", "ראה הערה"):
        assert LX.extra_class(label) == (None, 0.0), label
    assert LX.is_shutter_switch("מפסק לתריס") and LX.is_shutter_switch("מתג לתריס")
    assert not LX.is_shutter_switch("הזנה לתריס חשמלי") and not LX.is_shutter_switch("מתג הפעלה")


def test_refine_entries_touches_only_classless_or_generic_feed_rows() -> None:
    vs = Sheet().line([(0.0, 0.0), (1.0, 1.0)]).build()
    rows = [
        _entry(0, "גלאי עשן", vs, [0], None),
        _entry(1, "הזנה לתריס חשמלי", vs, [0], "heater_feed"),  # the keyword rules' generic feed
        _entry(2, "תנור חימום לחדר רחצה", vs, [0], "heater_feed"),
        _entry(3, "מצלמה", vs, [0], "luminaire_wall"),  # a class the legend gave on purpose stays
        _entry(4, "שקע בודד", vs, [0], "socket_single"),
    ]
    changed = LX.refine_entries(rows)
    assert changed == ["גלאי עשן", "הזנה לתריס חשמלי"]
    assert [r.suggested_class for r in rows] == [
        "smoke_detector",
        "shutter_feed",
        "heater_feed",
        "luminaire_wall",
        "socket_single",
    ]
    assert rows[0].class_conf > 0.5


# ------------------------------------------------------------------------------- colour consistency
def _plain_template(vs, path_ids: list[int], tid: str) -> TP.Template:
    seg_idx = np.where(np.isin(vs.seg_path, path_ids))[0]
    segs = vs.segs[seg_idx].astype(np.float64)
    c = np.array([(segs[:, [0, 2]].min() + segs[:, [0, 2]].max()) / 2, (segs[:, [1, 3]].min() + segs[:, [1, 3]].max()) / 2])
    segs = segs - np.concatenate([c, c])
    pts, _ = resample(segs, MA.STEP)
    w = float(segs[:, [0, 2]].max() - segs[:, [0, 2]].min())
    h = float(segs[:, [1, 3]].max() - segs[:, [1, 3]].min())
    lens = np.hypot(segs[:, 2] - segs[:, 0], segs[:, 3] - segs[:, 1])
    k = int(np.argmax(lens))
    d = np.array([segs[k, 2] - segs[k, 0], segs[k, 3] - segs[k, 1]]) / max(lens[k], 1e-9)
    mid = np.array([(segs[k, 0] + segs[k, 2]) / 2, (segs[k, 1] + segs[k, 3]) / 2])
    t = TP.Template(tid, [], segs, pts, w, h, TP.Anchor("line", mid, mid=d, length=float(lens[k])), 0.0, 1.0, False)
    t.tree = cKDTree(pts)
    return t


def _square(s: Sheet, cx: float, cy: float, rgb: tuple[int, int, int], a: float = 2.0) -> None:
    s.line([(cx - a, cy - a), (cx + a, cy - a), (cx + a, cy + a), (cx - a, cy + a), (cx - a, cy - a)], rgb)


def test_colour_share_vetoes_a_pose_on_ink_of_another_colour_code() -> None:
    s = Sheet()
    _square(s, 20.0, 20.0, YELLOW)  # legend: yellow wall light (path 0)
    _square(s, 100.0, 100.0, YELLOW)  # plan: a yellow one (1)
    _square(s, 140.0, 100.0, ORANGE)  # plan: an orange camera-coloured one (2)
    _square(s, 180.0, 100.0, (255, 250, 0))  # plan: nearly the same yellow (3)
    vs = s.build()
    t = _plain_template(vs, [0], "wall")
    t.entries = [_entry(0, "גוף תאורה מהקיר", vs, [0], "luminaire_wall")]
    cols = D.template_colours(t, vs)
    assert set(cols) == {YELLOW}
    scene = MA.build_scene(vs, [])
    eye = np.eye(2)
    on_yellow = MA.Candidate(t, (100.0, 100.0), eye, 1.0, 0.0, 1.0)
    on_orange = MA.Candidate(t, (140.0, 100.0), eye, 1.0, 0.0, 1.0)
    on_near = MA.Candidate(t, (180.0, 100.0), eye, 1.0, 0.0, 1.0)
    assert D.colour_share(on_yellow, scene, vs, cols) == 1.0
    assert D.colour_share(on_orange, scene, vs, cols) == 0.0
    assert D.colour_share(on_near, scene, vs, cols) == 1.0
    assert D.colour_share(on_orange, scene, vs, {}) == 1.0  # no colours known: no veto
    # the veto runs inside spot(), before NMS
    res = MA.spot([t], scene, accept=lambda c: D.colour_share(c, scene, vs, cols) >= D.COLOUR_MIN_SHARE)
    centres = sorted(round(c.center[0]) for c in res.detections if c.quality >= 0.6)
    assert 140 not in centres and 100 in centres


def test_unique_colour_templates_use_the_dominant_colour_and_skip_neutral_pens() -> None:
    cols = {
        "camera": {(254, 204, 102): 480, ORANGE: 89},  # dominant light orange: unique
        "siren": {ORANGE: 45},  # orange is shared with the panel row
        "panel": {ORANGE: 19},
        "cobra": {BLACK: 86},  # a neutral pen names nothing
        "socket": {(237, 31, 36): 27},
        "power": {(205, 32, 39): 148},  # within tolerance of the socket's red
    }
    assert D.unique_colour_templates(cols) == {"camera"}


# ------------------------------------------------------------------------------------------- NMS
def test_ring_family_yields_to_a_containing_specific_drawing() -> None:
    s = Sheet()
    s.line(_circle(20.0, 20.0, R), ORANGE)  # ring (0)
    s.line(_circle(60.0, 20.0, R), ORANGE)  # camera: ring + cone (1, 2)
    s.line([(60.0 + R, 20.0), (60.0 + R + 3.0, 20.0 - 2.0), (60.0 + R + 3.0, 20.0 + 2.0), (60.0 + R, 20.0)], ORANGE)
    vs = s.build()
    ring = _plain_template(vs, [0], "ring")
    ring.ring = RG.RingInfo(R)
    cam = _plain_template(vs, [1, 2], "cam")
    eye = np.eye(2)
    kept_ring = MA.Candidate(ring, (60.0, 20.0), eye, 1.0, 0.0, 1.0)
    kept_ring.quality = 0.95
    camera = MA.Candidate(cam, (60.0 + 1.5, 20.0), eye, 1.0, 0.0, 1.0)
    camera.quality = 0.55
    out = MA._nms([kept_ring, camera], 0.45)
    assert [c.tpl.id for c in out] == ["cam"] and out[0].runner_up_id == "ring"
    # a plain (non-ring) template keeps the old 0.15 rule
    ring.ring = None
    out = MA._nms([kept_ring, camera], 0.45)
    assert [c.tpl.id for c in out] == ["ring"]


# ------------------------------------------------------------------------------------ annotations
def test_usb_and_popup_tokens() -> None:
    assert D.A_USB in D.annotation_tokens("+TYPE C") and D.A_USB in D.annotation_tokens("שקע כפול + USB")
    assert D.A_USB not in D.annotation_tokens("TYPE3")  # the general note "מסוג TYPE3" is not an add-on
    assert D.A_POPUP in D.annotation_tokens("שקע קופץ")
    assert D.annotation_tokens("H=65") == ["H=65"]


def test_addon_tokens_attach_to_the_nearby_socket_only() -> None:
    sock = D.Detection("socket_single", (100.0, 100.0), (98.5, 98.5, 101.5, 101.5), source="vector")
    sw = D.Detection("switch_single", (130.0, 100.0), (128.5, 98.5, 131.5, 101.5), source="vector")
    spans = [_span("+TYPE C", 100.0, 105.5, w=6.0), _span("USB", 130.0, 105.5, w=4.0), _span("2X", 100.0, 110.0)]
    D._annotate([sock, sw], D.TextIndex(spans), [])
    assert D.A_USB in sock.annotations
    assert D.A_USB not in sw.annotations  # an add-on names sockets only
    assert sock.cls == "socket_single"  # the far "2X" (8 mm) stays where the old reach left it


def test_shutter_switch_annotation() -> None:
    vs = Sheet().line([(0.0, 0.0), (1.0, 0.0)], BLACK).build()
    t = _plain_template(vs, [0], "t")
    e = _entry(0, "מפסק לתריס", vs, [0], "switch_single")
    t.entries = [e]
    c = MA.Candidate(t, (10.0, 10.0), np.eye(2), 1.0, 0.0, 1.0)
    c.quality = 0.9
    d = D._vector_detection(c, c.bbox(), [], e, False, False, {}, [])
    assert d is not None and d.cls == "switch_single" and LX.SHUTTER_SWITCH_ANNOTATION in d.annotations
    e2 = _entry(1, "מתג הפעלה", vs, [0], "switch_single")
    d2 = D._vector_detection(c, c.bbox(), [], e2, False, False, {}, [])
    assert d2 is not None and LX.SHUTTER_SWITCH_ANNOTATION not in d2.annotations


# ------------------------------------------------------------------ text-layer qualifiers (Sprint 10 re-measure fix)
class _Fam:
    def __init__(self, label: str, qualifier: str = "") -> None:
        self.label, self.qualifier = label, qualifier


COMMS = [_Fam("נק' קצה לכבל רשת"), _Fam("נק' קצה לטלויזיה"), _Fam("נק' קצה לטלפון")]  # no legend qualifier kept


def test_read_from_spans_names_brackets_from_the_text_layer() -> None:
    from kamutan_drawing.symbols.qualifiers import read_from_spans

    centers = [(100.0, 100.0), (100.0, 104.0), (150.0, 100.0), (200.0, 100.0)]
    spans = [
        _span("רשת", 104.0, 100.0),  # beside bracket 0 (Yahav: font text, OCR windows see no strokes)
        _span("TEL", 104.0, 104.0),  # beside bracket 1
        _span("ונז", 154.0, 100.0),  # bracket 2: garbled word → no exact match → OCR / fallback decide
        _span("רשת", 230.0, 100.0),  # 30 mm from bracket 3: out of reach
    ]
    reads = read_from_spans(centers, [3.6] * 4, [COMMS] * 4, spans)
    assert {i: (r.entry, r.token) for i, r in reads.items()} == {0: (0, "רשת"), 1: (2, "TEL")}
    assert reads[0].direction == -1 and reads[0].similarity == 1.0


def test_read_from_spans_one_span_names_one_bracket_and_ties_stay_unread() -> None:
    from kamutan_drawing.symbols.qualifiers import read_from_spans

    # one "רשת" between two brackets, nearer to the second: only the second is named
    reads = read_from_spans([(100.0, 100.0), (106.0, 100.0)], [3.6, 3.6], [COMMS, COMMS], [_span("רשת", 104.0, 100.0)])
    assert set(reads) == {1}
    # "TV" and "TEL" at the same distance from one bracket: two members tie → unread
    tie = read_from_spans([(100.0, 100.0)], [3.6], [COMMS], [_span("TV", 104.0, 100.0), _span("TEL", 96.0, 100.0)])
    assert tie == {}


def test_resolve_by_ocr_uses_the_text_layer_before_ocr(monkeypatch: object) -> None:
    import kamutan_drawing.symbols.qualifiers as Q

    calls: list[int] = []

    def fake_ocr(segs, seg_path, path_bbox, centers, sizes, families, **kw):  # type: ignore[no-untyped-def]
        calls.append(len(centers))
        return {}

    monkeypatch.setattr(Q, "read_qualifiers", fake_ocr)  # type: ignore[attr-defined]
    vs = Sheet().line([(0.0, 0.0), (3.6, 0.0)], BLACK).build()
    t = _plain_template(vs, [0], "comms")
    classes = ("data_point", "tv_point", "phone_point")
    ents = [_entry(i, f.label, vs, [0], cls) for i, (f, cls) in enumerate(zip(COMMS, classes, strict=True))]
    t.entries = ents
    c0 = MA.Candidate(t, (100.0, 100.0), np.eye(2), 1.0, 0.0, 1.0)
    c1 = MA.Candidate(t, (150.0, 100.0), np.eye(2), 1.0, 0.0, 1.0)
    c0.quality = c1.quality = 0.9
    deferred = [(c0, c0.bbox(), [], ents[1], False), (c1, c1.bbox(), [], ents[1], False)]
    out = D._resolve_by_ocr(vs, deferred, {}, [], [_span("רשת", 104.0, 100.0)])
    assert [d.cls for d in out] == ["data_point", "tv_point"]  # the second keeps the old fallback member
    assert "רשת" in out[0].annotations
    assert calls == [1]  # OCR only for the bracket the text layer did not name


def test_a_ventilator_or_shutter_feed_label_does_not_make_a_socket_a_heater_feed() -> None:
    def refined(label: str) -> str:
        sock = D.Detection("socket_power", (100.0, 100.0), (98.5, 98.5, 101.5, 101.5), source="vector")
        D._annotate([sock], D.TextIndex([_span(label, 100.0, 105.0, w=12.0)]), [])
        return sock.cls

    assert refined("הזנה לוונטה") == "socket_power"  # Yahav laundry: the label names the V ring beside the dryer socket
    assert refined("הזנה לתריס") == "socket_power"
    assert refined("הזנה לדוד") == "heater_feed"  # Noah's water-heater feed keeps its refinement


def test_a_classless_marker_never_suppresses_a_real_symbol_in_nms() -> None:
    s = Sheet()
    s.line([(18.0, 20.0), (22.0, 20.0)], RED)  # the see-note "+" (marker), long arms
    s.line([(20.0, 18.0), (20.0, 22.0)], RED)
    s.line([(18.0, 20.0), (22.0, 20.0)], RED)  # a socket's stem + tick: a "+" with a short arm, NOT a superset
    s.line([(20.0, 18.8), (20.0, 21.2)], RED)
    vs = s.build()
    cross = _plain_template(vs, [0, 1], "cross")
    sock = _plain_template(vs, [2, 3], "sock")
    assert len(sock.pts) < 1.25 * len(cross.pts)  # the old "more specific" rule cannot rescue it
    eye = np.eye(2)
    c_cross = MA.Candidate(cross, (20.0, 20.0), eye, 1.0, 0.0, 1.0)
    c_cross.quality = 0.83
    c_sock = MA.Candidate(sock, (20.0, 20.0), eye, 1.0, 0.0, 1.0)
    c_sock.quality = 0.80
    old = MA._nms([c_cross, c_sock], 0.45)
    assert [c.tpl.id for c in old] == ["cross"]  # the marker won and the socket was gone (Yahav ground, before)
    c_sock.runner_up, c_sock.runner_up_id = 0.0, None
    new = MA._nms([c_cross, c_sock], 0.45, frozenset({"cross"}))
    assert [c.tpl.id for c in new] == ["sock"]
    assert new[0].runner_up == 0.83 and new[0].runner_up_id == "cross"  # margin < 0 → "דומה לסמל אחר"
    # a marker alone (nothing class-bearing there) is still kept: it annotates its neighbour as before
    alone = MA.Candidate(cross, (60.0, 20.0), eye, 1.0, 0.0, 1.0)
    alone.quality = 0.9
    assert [c.tpl.id for c in MA._nms([alone], 0.45, frozenset({"cross"}))] == ["cross"]


# ----------------------------------------------------------------- Sprint 10 (warm determinism)
def test_a_stray_mark_beside_a_multiplier_is_never_part_of_the_qualifier() -> None:
    """Noah c054fd3a: the socket drawn right after the legend's "2X" joins its text span; the glyph reader gives that
    stroke ")" with a cold glyph store and "%" with a warm one. Both must be the multiplier."""
    from kamutan_drawing.legend.classes import multiplicity
    from kamutan_drawing.legend.parse import clean_qualifier

    for raw in ("2X", "2X)", "2X%", "%2X", "2X%%", "*3X", "+א2"):
        q = clean_qualifier(raw)
        assert multiplicity(q) in (2, 3) and len(q) == 2, raw
    # nothing else changes: words, numbers with a mark and long tokens stay as they were
    assert clean_qualifier("50%") == "50%"
    assert clean_qualifier("BEZEK |") == "BEZEK"
    assert clean_qualifier("TV") == "TV"
    assert multiplicity(clean_qualifier("H=2X%")) is None


def test_cold_and_warm_readings_of_the_legend_multiplier_give_the_same_detections(tmp_path: object) -> None:
    """Cold / warm determinism on the synthetic legend sheet: only the reading of the legend's "2X" span differs
    ("2X)" cold, "2X%" warm, as on Noah). Before the fix the warm reading lost the multiplier, the socket rows became
    a look-alike family named by text and every socket came out a guessed single."""
    import dataclasses

    import pytest

    from kamutan_drawing.classify.sheet import span_from_line
    from kamutan_drawing.legend.parse import parse_legends
    from kamutan_drawing.parse.pdf import PdfPageSource

    from .synth_legend import LEGEND_BOX, hebrew_font, legend_sheet_pdf

    if hebrew_font() is None:
        pytest.skip("needs a TTF font with Hebrew glyphs (DejaVu Sans)")
    p = tmp_path / "s.pdf"  # type: ignore[operator]
    p.write_bytes(legend_sheet_pdf())
    src = PdfPageSource.open(str(p), 0)
    try:
        vs = src.vectors()
        spans = [span_from_line(ln) for ln in src.text_layer()]
    finally:
        src.close()
    x0, y0, x1, y1 = LEGEND_BOX
    idx = [
        i for i, sp in enumerate(spans)
        if sp.text.strip() in ("2X", "X2") and x0 <= (sp.bbox[0] + sp.bbox[2]) / 2 <= x1 and y0 <= (sp.bbox[1] + sp.bbox[3]) / 2 <= y1
    ]  # fmt: skip
    assert len(idx) == 1

    sym = next(e.symbol_bbox for lg in parse_legends(vs, spans).legends for e in lg.entries if "בהרכבים" in e.label)
    sp0 = spans[idx[0]]
    joined = (sp0.bbox[0], sp0.bbox[1], sym[2], sp0.bbox[3])  # the reader joins the symbol's strokes to the "2X" span

    def run(reading: str) -> tuple[list[tuple[object, ...]], list[tuple[str, int | None]]]:
        sp2 = list(spans)
        sp2[idx[0]] = dataclasses.replace(sp0, text=reading, bbox=joined)
        leg = parse_legends(vs, sp2)
        res = D.detect_symbols(vs, sp2, leg, discipline="electrical", scale_den=50)
        dets = sorted(
            (d.cls, round(d.center[0], 1), round(d.center[1], 1), d.level, tuple(d.annotations), tuple(d.reasons))
            for d in res.detections
        )
        return dets, [(e.qualifier, e.multiplicity) for lg in leg.legends for e in lg.entries if e.qualifier]

    ref, ref_q = run("2X")
    assert ref_q == [("2X", 2)] and any(d[0] == "socket_double" for d in ref)
    for reading in ("2X)", "2X%"):
        got, got_q = run(reading)
        assert got_q == ref_q, reading
        assert got == ref, reading


def test_a_stray_letter_beside_the_ring_letter_does_not_hide_the_member() -> None:
    """Yahav first floor: the text layer holds "M" in the ring; a stroke nearby reads as a digit with a cold glyph store
    and as "J" with a warm one. The one word that is a member's letter names the ring in both."""
    vs, entries = _legend_sheet()
    fam = RG.merge_ring_families(TP.build_templates(entries, vs), vs, [])[0]
    s = Sheet()
    _ring(s, 100.0, 100.0, ORANGE, None)
    plan = s.build()
    cold = [_span("V", 100.0, 100.0), _span("3", 100.6, 100.3)]
    warm = [_span("V", 100.0, 100.0), _span("J", 100.6, 100.3)]
    for spans in (cold, warm):
        e, amb, word = RG.resolve_member(fam, (100.0, 100.0), 1.0, plan, spans)
        assert e is not None and e.label == "וונטה" and not amb and word == "V"
    # two member letters inside stay undecided
    e, amb, _ = RG.resolve_member(fam, (100.0, 100.0), 1.0, plan, [_span("V", 100.0, 100.0), _span("M", 100.6, 100.3)])
    assert e is None


def test_the_combos_row_is_the_multiplier_row_however_its_mark_reads(tmp_path: object) -> None:
    """Rubel ground floor: the legend's "2X" reads "20" with a cold glyph store and "2X" with a warm one. The row
    labelled "שקע בהרכבים" keeps its multiplicity either way, so the detections are the same."""
    import dataclasses

    import pytest

    from kamutan_drawing.classify.sheet import span_from_line
    from kamutan_drawing.legend.parse import parse_legends
    from kamutan_drawing.parse.pdf import PdfPageSource

    from .synth_legend import LEGEND_BOX, hebrew_font, legend_sheet_pdf

    if hebrew_font() is None:
        pytest.skip("needs a TTF font with Hebrew glyphs (DejaVu Sans)")
    p = tmp_path / "s.pdf"  # type: ignore[operator]
    p.write_bytes(legend_sheet_pdf())
    src = PdfPageSource.open(str(p), 0)
    try:
        vs = src.vectors()
        spans = [span_from_line(ln) for ln in src.text_layer()]
    finally:
        src.close()
    x0, y0, x1, y1 = LEGEND_BOX
    i = next(
        k for k, sp in enumerate(spans)
        if sp.text.strip() in ("2X", "X2") and x0 <= (sp.bbox[0] + sp.bbox[2]) / 2 <= x1 and y0 <= (sp.bbox[1] + sp.bbox[3]) / 2 <= y1
    )  # fmt: skip
    sym = next(e.symbol_bbox for lg in parse_legends(vs, spans).legends for e in lg.entries if "בהרכבים" in e.label)
    joined = (spans[i].bbox[0], spans[i].bbox[1], sym[2], spans[i].bbox[3])

    def run(reading: str) -> tuple[list[tuple[object, ...]], list[tuple[str, int | None]]]:
        sp2 = list(spans)
        sp2[i] = dataclasses.replace(spans[i], text=reading, bbox=joined)
        leg = parse_legends(vs, sp2)
        dets = sorted(
            (d.cls, round(d.center[0], 1), round(d.center[1], 1), tuple(d.annotations), tuple(d.reasons))
            for d in D.detect_symbols(vs, sp2, leg, discipline="electrical", scale_den=50).detections
        )
        return dets, [(e.qualifier, e.multiplicity) for lg in leg.legends for e in lg.entries if e.qualifier]

    ref = run("2X")
    assert ref[1] == [("2X", 2)]
    assert run("20") == ref
    assert run("3O")[1] == [("3X", 3)]
