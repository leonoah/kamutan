"""Sprint 3 (Worker-A): switch ↔ luminaire link graph from dashed wiring arcs (synthetic reportlab plans)."""

from __future__ import annotations

import gzip
import json
import math
import time
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest
from reportlab.lib.colors import Color

from kamutan_drawing.ingest.pdf_vector import extract_pdf
from kamutan_drawing.links import LINKS_SCHEMA, extract_chains, link_sheet
from kamutan_drawing.links.floors import R_FLOOR, apply_confirmed_floors
from kamutan_drawing.links.graph import R_AMBIG, R_DANGLING, R_INFERRED, R_PARTNER

from .synth import MM, make_pdf, stroke_line, to_pdf_xy

RED = (1, 0, 0)
DASH, GAP = 1.0, 1.4


# ----------------------------------------------------------------------------- drawing helpers
def _bezier(a, b, bend: float, n: int = 400) -> np.ndarray:
    a, b = np.asarray(a, float), np.asarray(b, float)
    m = (a + b) / 2
    d = b - a
    ctrl = m + bend * np.array([-d[1], d[0]])
    t = np.linspace(0, 1, n)[:, None]
    return (1 - t) ** 2 * a + 2 * (1 - t) * t * ctrl + t**2 * b


def _poly(*pts) -> np.ndarray:
    out = [np.asarray(pts[0], float)]
    for p in pts[1:]:
        q = np.asarray(p, float)
        n = max(2, int(np.hypot(*(q - out[-1])) / 0.1))
        out.extend(out[-1] + (q - out[-1]) * t for t in np.linspace(0, 1, n)[1:])
    return np.array(out)


def exploded_dashes(c, ps, poly: np.ndarray, rgb=RED, dash=DASH, gap=GAP) -> None:
    """AutoCAD-style PDF export: every dash is its own path (dash starts at the first point and the
    pattern ends exactly at the last one)."""
    seg = np.hypot(*np.diff(poly, axis=0).T)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    total = cum[-1]
    s = 0.0
    while s < total - 0.05:
        e = min(s + dash, total)
        ts = np.linspace(s, e, 4)
        pts = np.column_stack([np.interp(ts, cum, poly[:, 0]), np.interp(ts, cum, poly[:, 1])])
        c.setStrokeColor(Color(*rgb))
        c.setLineWidth(0.21 * MM)
        c.setDash([], 0)
        p = c.beginPath()
        p.moveTo(*to_pdf_xy(*pts[0], ps))
        for q in pts[1:]:
            p.lineTo(*to_pdf_xy(*q, ps))
        c.drawPath(p, stroke=1, fill=0)
        s = e + gap


def real_dashed(c, ps, poly: np.ndarray, rgb=RED) -> None:
    c.setStrokeColor(Color(*rgb))
    c.setLineWidth(0.21 * MM)
    c.setDash([DASH * MM, GAP * MM], 0)
    p = c.beginPath()
    p.moveTo(*to_pdf_xy(*poly[0], ps))
    for q in poly[1:]:
        p.lineTo(*to_pdf_xy(*q, ps))
    c.drawPath(p, stroke=1, fill=0)
    c.setDash([], 0)


def circle(c, ps, x, y, r, width=0.25):
    c.setStrokeColor(Color(0, 0, 0))
    c.setLineWidth(width * MM)
    c.setDash([], 0)
    cx, cy = to_pdf_xy(x, y, ps)
    c.circle(cx, cy, r * MM, stroke=1, fill=0)


def switch_glyph(c, ps, x, y):
    """Ring (r 0.5) at (x, y) — where the wire ends — with a stem up and a flag."""
    circle(c, ps, x, y, 0.5)
    stroke_line(c, (x, y - 0.5), (x - 1.0, y - 2.6), ps)
    stroke_line(c, (x - 1.0, y - 2.6), (x - 2.0, y - 2.2), ps)


def luminaire_glyph(c, ps, x, y):
    circle(c, ps, x, y, 2.5)
    stroke_line(c, (x - 3.2, y), (x + 3.2, y), ps)
    stroke_line(c, (x, y - 3.2), (x, y + 3.2), ps)


def det(i: str, cls: str, x: float, y: float, w: float = 5.0, h: float = 5.0, **kw: Any) -> dict[str, Any]:
    d = {
        "id": i,
        "class": cls,
        "legendEntryId": None,
        "centerMm": {"x": x, "y": y},
        "bboxMm": {"x": x - w / 2, "y": y - h / 2, "w": w, "h": h},
        "angleDeg": 0,
        "score": 0.9,
        "level": "green",
        "reasons": [],
        "roomId": None,
        "floor": "ground",
        "lifecycle": "new",
        "supply": None,
        "annotations": [],
        "clusterId": None,
    }
    d.update(kw)
    return d


def sw_det(i: str, x: float, y: float, cls: str = "switch_single", **kw: Any) -> dict[str, Any]:
    # a switch detection box is centred on the whole glyph (ring + stem + flag), not on the ring
    return det(i, cls, x - 0.8, y - 1.2, 4.4, 4.8, **kw)


def span(text: str, x0: float, y0: float, x1: float, y1: float) -> SimpleNamespace:
    return SimpleNamespace(text=text, bbox=(x0, y0, x1, y1))


def run(draw, dets, spans=(), legend=None):
    vs = extract_pdf(make_pdf(draw))[0]
    return link_sheet(vs, list(spans), dets, legend, scale_den=50)


def groups_by_switch(doc):
    return {tuple(g["switchIds"]): g for g in doc["groups"]}


# ----------------------------------------------------------------------------- tests
def test_exploded_dashes_are_chained_into_one_arc():
    poly = _bezier((50, 100), (120, 60), 0.3)

    def draw(c, ps):
        exploded_dashes(c, ps, poly)

    vs = extract_pdf(make_pdf(draw))[0]
    assert vs.n_paths > 20 and all(not d for d in vs.path_dash)  # one path per dash
    chains = extract_chains(vs)
    assert len(chains) == 1
    ch = chains[0]
    ends = {tuple(np.round(ch.pts[0])), tuple(np.round(ch.pts[-1]))}
    assert ends == {(50.0, 100.0), (120.0, 60.0)}
    assert ch.curvature() > 0.1


def test_real_dash_array_path_is_a_chain():
    poly = _bezier((30, 30), (90, 40), 0.2)

    def draw(c, ps):
        real_dashed(c, ps, poly)

    chains = extract_chains(extract_pdf(make_pdf(draw))[0])
    assert len(chains) == 1 and not chains[0].exploded


def test_irregular_strokes_do_not_form_a_chain():
    rng = np.random.default_rng(3)

    def draw(c, ps):  # short collinear strokes of random lengths (text / hatch), not a dash pattern
        x = 20.0
        for _ in range(12):
            ln = float(rng.choice([0.3, 2.5, 0.6, 2.0]))
            stroke_line(c, (x, 50), (x + ln, 50), ps, rgb=RED)
            x += ln + 0.6

    assert extract_chains(extract_pdf(make_pdf(draw))[0]) == []


def test_single_shared_and_pass_through():
    s1, s2 = (40.0, 150.0), (42.3, 150.0)
    l1, l2, l3, l4 = (80.0, 110.0), (130.0, 110.0), (180.0, 110.0), (60.0, 60.0)

    def draw(c, ps):
        switch_glyph(c, ps, *s1)
        switch_glyph(c, ps, *s2)
        for lp in (l1, l2, l3, l4):
            luminaire_glyph(c, ps, *lp)
        exploded_dashes(c, ps, _bezier(s1, l4, -0.25))  # s1 → l4 (single)
        # s2 → l1 → l2 → l3 drawn as ONE continuous curve passing through l1 and l2 (shared, 3 points)
        exploded_dashes(c, ps, np.vstack([_bezier(s2, l1, 0.2), _bezier(l1, l2, 0.15)[1:], _bezier(l2, l3, 0.15)[1:]]))

    dets = [
        sw_det("d_1", *s1),
        sw_det("d_2", *s2),
        det("d_3", "luminaire_ceiling", *l1),
        det("d_4", "luminaire_ceiling", *l2),
        det("d_5", "luminaire_ceiling", *l3),
        det("d_6", "luminaire_ceiling", *l4),
    ]
    doc, stats = run(draw, dets)
    assert doc["schema"] == LINKS_SCHEMA
    g = groups_by_switch(doc)
    assert g[("d_1",)]["kind"] == "single" and g[("d_1",)]["luminaireIds"] == ["d_6"]
    assert g[("d_2",)]["kind"] == "shared" and len(g[("d_2",)]["pointIds"]) == 3
    assert sorted(g[("d_2",)]["luminaireIds"]) == ["d_3", "d_4", "d_5"]
    assert all(x["level"] == "green" and not x["reasons"] for x in doc["groups"])  # 2.3 mm bank pitch, unambiguous by ink
    assert stats["groups"] == 2 and stats["byKind"] == {"shared": 1, "single": 1} and stats["danglingEnds"] == 0
    assert len(doc["points"]) == 4 and all(len(a["polylineMm"]) >= 2 for a in doc["arcs"])


def test_two_way_and_arc_ending_short_of_symbol():
    a, b, lum = (40.0, 150.0), (160.0, 150.0), (100.0, 90.0)

    def draw(c, ps):
        switch_glyph(c, ps, *a)
        switch_glyph(c, ps, *b)
        luminaire_glyph(c, ps, *lum)
        exploded_dashes(c, ps, _bezier(a, lum, 0.2))
        # this arc stops 1.2 mm before the luminaire's crosshair centre (still inside its symbol)
        end = (lum[0] + 1.2, lum[1] + 1.0)
        exploded_dashes(c, ps, _bezier(b, end, -0.2))

    dets = [sw_det("d_1", *a, cls="switch_2way"), sw_det("d_2", *b, cls="switch_2way"), det("d_3", "luminaire_ceiling", *lum)]
    doc, _ = run(draw, dets)
    (g,) = doc["groups"]
    assert g["kind"] == "two_way" and sorted(g["switchIds"]) == ["d_1", "d_2"] and g["pointIds"]
    assert g["level"] == "green"


def test_lone_two_way_switch_is_flagged():
    a, lum = (40.0, 150.0), (100.0, 90.0)

    def draw(c, ps):
        switch_glyph(c, ps, *a)
        luminaire_glyph(c, ps, *lum)
        exploded_dashes(c, ps, _bezier(a, lum, 0.2))

    doc, _ = run(draw, [sw_det("d_1", *a, cls="switch_2way"), det("d_2", "luminaire_wall", *lum)])
    (g,) = doc["groups"]
    assert g["kind"] == "single" and R_PARTNER in g["reasons"] and g["level"] == "yellow"


def test_dangling_end_is_never_green():
    a = (40.0, 150.0)

    b, lb = (250.0, 150.0), (300.0, 100.0)

    def draw(c, ps):
        switch_glyph(c, ps, *a)
        luminaire_glyph(c, ps, 200, 60)
        exploded_dashes(c, ps, _bezier(a, (100.0, 100.0), 0.2))  # ends in empty space
        # wiring elsewhere on the sheet in the same pen (a half-attached curve needs a known wiring pen)
        for p in (b, (b[0] + 2.3, b[1])):
            switch_glyph(c, ps, *p)
        luminaire_glyph(c, ps, *lb)
        luminaire_glyph(c, ps, 350, 100)
        exploded_dashes(c, ps, _bezier(b, lb, 0.2))
        exploded_dashes(c, ps, _bezier((b[0] + 2.3, b[1]), (350, 100), 0.2))

    dets = [sw_det("d_1", *a), det("d_2", "luminaire_ceiling", 200, 60), sw_det("d_3", *b), sw_det("d_4", b[0] + 2.3, b[1])]
    dets += [det("d_5", "luminaire_ceiling", *lb), det("d_6", "luminaire_ceiling", 350, 100)]
    doc, stats = run(draw, dets)
    g = groups_by_switch(doc)[("d_1",)]
    assert R_DANGLING in g["reasons"] and g["level"] != "green" and g["luminaireIds"] == []
    assert stats["danglingEnds"] == 1 and doc["unlinkedLuminaireIds"] == ["d_2"]


def test_ambiguous_end_between_overlapping_symbols():
    lum = (100.0, 90.0)

    def draw(c, ps):
        switch_glyph(c, ps, 40, 150)
        luminaire_glyph(c, ps, *lum)
        exploded_dashes(c, ps, _bezier((40, 150), lum, 0.2))

    # two detections claim the same luminaire glyph (a duplicate 1 mm away)
    dets = [
        sw_det("d_1", 40, 150),
        det("d_2", "luminaire_ceiling", *lum),
        det("d_3", "luminaire_strip", lum[0] + 0.4, lum[1] + 0.3),
    ]
    doc, _ = run(draw, dets)
    (g,) = doc["groups"]
    assert R_AMBIG in g["reasons"] and g["level"] != "green"


def test_crossing_arcs_keep_their_own_ends():
    s1, s2, l1, l2 = (40.0, 100.0), (40.0, 160.0), (160.0, 160.0), (160.0, 100.0)

    def draw(c, ps):
        for p in (s1, s2):
            switch_glyph(c, ps, *p)
        for p in (l1, l2):
            luminaire_glyph(c, ps, *p)
        exploded_dashes(c, ps, _bezier(s1, l1, 0.05))  # the two arcs cross near the middle
        exploded_dashes(c, ps, _bezier(s2, l2, -0.05))

    dets = [sw_det("d_1", *s1), sw_det("d_2", *s2), det("d_3", "luminaire_ceiling", *l1), det("d_4", "luminaire_ceiling", *l2)]
    doc, _ = run(draw, dets)
    g = groups_by_switch(doc)
    assert g[("d_1",)]["luminaireIds"] == ["d_3"] and g[("d_2",)]["luminaireIds"] == ["d_4"]


def test_bank_with_an_undetected_switch_infers_it():
    xs = (100.0, 102.3, 104.6)
    lums = ((60.0, 60.0), (100.0, 40.0), (150.0, 60.0))

    def draw(c, ps):
        for x, lp in zip(xs, lums, strict=True):
            switch_glyph(c, ps, x, 150.0)
            luminaire_glyph(c, ps, *lp)
            exploded_dashes(c, ps, _bezier((x, 150.0), lp, 0.15))

    # the detector found the outer two switches only
    dets = [sw_det("d_1", xs[0], 150.0), sw_det("d_2", xs[2], 150.0)]
    dets += [det(f"d_{3 + k}", "luminaire_ceiling", *lp) for k, lp in enumerate(lums)]
    doc, stats = run(draw, dets)
    assert len(doc["groups"]) == 3
    inferred = [g for g in doc["groups"] if g["inferredSwitches"]]
    assert len(inferred) == 1 and inferred[0]["switchIds"] == [] and R_INFERRED in inferred[0]["reasons"]
    assert inferred[0]["kind"] == "single" and inferred[0]["level"] != "green"
    assert stats["inferredSwitches"] == 1 and stats["danglingEnds"] == 0


def test_existing_point_fan_switch_and_sensor_rules():
    s_add, l_add = (40.0, 150.0), (90.0, 120.0)
    s_fan, l_fan = (150.0, 150.0), (200.0, 120.0)
    l_sensor, l_alone, l_exist = (260.0, 60.0), (300.0, 60.0), (340.0, 60.0)

    def draw(c, ps):
        for p in (s_add, s_fan):
            switch_glyph(c, ps, *p)
        for p in (l_add, l_fan, l_sensor, l_alone, l_exist):
            luminaire_glyph(c, ps, *p)
        exploded_dashes(c, ps, _bezier(s_add, l_add, 0.2))
        exploded_dashes(c, ps, _bezier(s_fan, l_fan, 0.2))

    dets = [
        sw_det("d_1", *s_add, cls="switch_2way"),
        det("d_2", "ceiling_fan", *l_add, lifecycle="existing"),
        sw_det("d_3", *s_fan),
        det("d_4", "ceiling_fan", *l_fan),
        det("d_5", "luminaire_outdoor", *l_sensor),
        det("d_6", "luminaire_ceiling", *l_alone),
        det("d_7", "luminaire_ceiling", *l_exist),
    ]
    spans = [
        span("להוסיף מחלף", 30, 152, 41, 155),  # next to the add switch
        span("מפסק", 141, 152, 149, 154.5),  # two-line note next to the fan switch
        span("למאוורר", 140, 155, 149, 157.5),
        span("נק' קיימת", 192, 124, 204, 127),  # the fan point is existing
        span("גלאי תנועה", 255, 64, 266, 67),  # sensor note next to the projector
        span("נק' קיימת", 334, 64, 346, 67),
    ]
    doc, stats = run(draw, dets, spans)
    g = groups_by_switch(doc)
    assert g[("d_1",)]["kind"] == "add_to_existing" and not g[("d_1",)]["fan"]  # → 4.12
    assert g[("d_3",)]["kind"] == "add_to_existing" and g[("d_3",)]["fan"]  # → 4.14
    assert g[()]["kind"] == "sensor" and g[()]["luminaireIds"] == ["d_5"]  # → 4.15
    assert doc["unlinkedLuminaireIds"] == ["d_6"]  # new point without a switch arc: no group, listed
    assert all("d_7" not in x["luminaireIds"] for x in doc["groups"])  # untouched existing point
    assert stats["byKind"] == {"add_to_existing": 2, "sensor": 1}


def test_sensor_from_fixture_table_notes_column():
    legend = {
        "legends": [{"id": "lg1", "bboxMm": {"x": 10, "y": 200, "w": 150, "h": 40}}],
        "entries": [
            {"id": "le_x_1", "legendId": "lg1", "label": "פרוז'קטור", "labelBboxMm": {"x": 100, "y": 210, "w": 30, "h": 3}},
            {"id": "le_x_2", "legendId": "lg1", "label": "פס לד", "labelBboxMm": {"x": 100, "y": 215, "w": 30, "h": 3}},
        ],
    }
    spans = [span("עם גלאי תנועה", 20, 210.3, 40, 212.7)]  # same table row as entry 1, notes column

    def draw(c, ps):
        luminaire_glyph(c, ps, 100, 60)
        luminaire_glyph(c, ps, 150, 60)

    dets = [
        det("d_1", "luminaire_outdoor", 100, 60, legendEntryId="le_x_1"),
        det("d_2", "luminaire_strip", 150, 60, legendEntryId="le_x_2"),
    ]
    doc, _ = run(draw, dets, spans, legend)
    (g,) = doc["groups"]
    assert g["kind"] == "sensor" and g["luminaireIds"] == ["d_1"] and g["level"] == "green"
    assert doc["unlinkedLuminaireIds"] == ["d_2"]


def test_floor_reason_is_carried_to_groups():
    a, lum = (40.0, 150.0), (100.0, 90.0)

    def draw(c, ps):
        switch_glyph(c, ps, *a)
        luminaire_glyph(c, ps, *lum)
        exploded_dashes(c, ps, _bezier(a, lum, 0.2))

    dets = [
        sw_det("d_1", *a, level="yellow", reasons=[R_FLOOR]),
        det("d_2", "luminaire_ceiling", *lum, level="yellow", reasons=[R_FLOOR]),
    ]
    doc, _ = run(draw, dets)
    (g,) = doc["groups"]
    assert g["reasons"] == [R_FLOOR] and g["level"] == "yellow"
    # the user confirms: the chip goes, the group is green again
    out = apply_confirmed_floors({"detections": {"detections": dets}, "links": doc}, {"confirmed": True, "floors": ["first"]})
    (g2,) = out["links"]["groups"]
    assert g2["reasons"] == [] and g2["level"] == "green" and g2["floor"] == "first"


# ----------------------------------------------------------------------------- floors
def _square(x0, y0, x1, y1):
    return [{"x": x0, "y": y0}, {"x": x1, "y": y0}, {"x": x1, "y": y1}, {"x": x0, "y": y1}]


def test_apply_confirmed_floors_regions_and_levels():
    dets = {
        "schema": "kamutan.detections/1",
        "detections": [
            det("d_1", "socket_single", 50, 50, floor="ground", level="yellow", reasons=[R_FLOOR]),
            det("d_2", "socket_single", 50, 250, floor="ground", level="yellow", reasons=[R_FLOOR, "ביטחון נמוך"]),
            det("d_3", "socket_single", 500, 500, floor=None, level="red", reasons=["התאמה חלשה לסמל במקרא"]),
        ],
        "unknownClusters": [],
    }
    rooms = {
        "schema": "kamutan.rooms/1",
        "rooms": [
            {"id": "r_1", "floor": "ground", "polygonMm": _square(10, 210, 90, 290), "level": "yellow", "reasons": [R_FLOOR]}
        ],
    }
    regions = [
        {"id": "r0", "floor": "basement", "polygonMm": _square(0, 0, 200, 200), "scaleDenominator": 50},
        {"id": "r1", "floor": "first", "polygonMm": _square(0, 205, 200, 400), "scaleDenominator": 50},
    ]
    sheet = {"confirmed": True, "floors": ["basement", "first"]}
    before = json.dumps(dets, sort_keys=True)
    out = apply_confirmed_floors({"detections": dets, "rooms": rooms}, sheet, regions)
    d1, d2, d3 = out["detections"]["detections"]
    assert (d1["floor"], d1["level"], d1["reasons"]) == ("basement", "green", [])
    assert (d2["floor"], d2["level"], d2["reasons"]) == ("first", "yellow", ["ביטחון נמוך"])
    assert (d3["floor"], d3["level"]) == (None, "red")  # outside every region, two floors: unchanged
    (r,) = out["rooms"]["rooms"]
    assert (r["floor"], r["level"], r["reasons"]) == ("first", "green", [])
    assert json.dumps(dets, sort_keys=True) == before  # inputs untouched (copies)
    # not confirmed → unchanged copies
    same = apply_confirmed_floors({"detections": dets}, {"confirmed": False, "floors": ["x"]}, regions)
    assert same["detections"] == dets and same["detections"] is not dets
    # regions may also come with the sheet doc
    out2 = apply_confirmed_floors({"detections": dets}, {**sheet, "regions": regions})
    assert out2["detections"]["detections"][0]["floor"] == "basement"


# ----------------------------------------------------------------------------- understand stage
def test_understand_writes_links_on_lighting_sheets(tmp_path):
    from kamutan_drawing.pipeline.understand import LINKS_FILE, understand

    def draw(c, ps):
        switch_glyph(c, ps, 40, 150)
        luminaire_glyph(c, ps, 100, 90)
        exploded_dashes(c, ps, _bezier((40, 150), (100, 90), 0.2))

    vs = extract_pdf(make_pdf(draw))[0]
    regions = [{"id": "r0", "floor": "ground", "polygonMm": _square(0, 0, 420, 297), "scaleDenominator": 50}]
    t = time.monotonic()
    res = understand(
        vs, [], sheet_id="s", discipline="lighting", scale_den=50, regions=regions, text_paths=set(), out_dir=tmp_path
    )
    assert time.monotonic() - t < 60
    assert res["linksFile"] == LINKS_FILE and LINKS_FILE not in {f["path"] for f in res["files"]}
    doc = json.loads(gzip.decompress((tmp_path / LINKS_FILE).read_bytes()))
    assert doc["schema"] == LINKS_SCHEMA and res["linkStats"]["groups"] == len(doc["groups"])  # no legend → no detections
    # other disciplines: no links artifact
    res2 = understand(
        vs, [], sheet_id="s", discipline="electrical", scale_den=50, regions=regions, text_paths=set(), out_dir=tmp_path / "e"
    )
    assert "linksFile" not in res2 and "linkStats" not in res2


@pytest.mark.parametrize("bend", [0.05, 0.3, -0.4])
def test_chain_survives_any_bend(bend):
    poly = _bezier((60, 200), (200, 120), bend)

    def draw(c, ps):
        exploded_dashes(c, ps, poly)

    (ch,) = extract_chains(extract_pdf(make_pdf(draw))[0])
    assert math.isclose(ch.length, float(np.hypot(*np.diff(poly, axis=0).T).sum()), rel_tol=0.08)
