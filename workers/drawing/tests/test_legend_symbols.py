"""Sprint 2 (Worker-A): legend parsing, vector symbol spotting, tags, annotations, unknown clusters,
the understanding stage's artifacts (validated against packages/contracts json-schema)."""

from __future__ import annotations

import gzip
import json
import math
import shutil
from pathlib import Path

import numpy as np
import pytest

from kamutan_drawing.classify.sheet import span_from_line
from kamutan_drawing.legend.classes import apply_multiplicity, multiplicity, suggest_class
from kamutan_drawing.legend.parse import clean_qualifier, parse_legends
from kamutan_drawing.parse.pdf import PdfPageSource
from kamutan_drawing.pipeline.understand import understand
from kamutan_drawing.symbols.detect import R_NOT_IN_LEGEND, detect_symbols
from kamutan_drawing.symbols.geometry import orient_matrix, segment_components, stroke_signature, stroke_signatures

from .pipeline_util import validate
from .synth_legend import LEGEND_BOX, PLACED, TAGS, Placed, hebrew_font, legend_sheet_pdf, types_sheet_pdf

pytestmark = pytest.mark.skipif(hebrew_font() is None, reason="needs a TTF font with Hebrew glyphs (DejaVu Sans)")


def _load(data: bytes, tmp_path: Path):
    p = tmp_path / "s.pdf"
    p.write_bytes(data)
    src = PdfPageSource.open(str(p), 0)
    vs = src.vectors()
    spans = [span_from_line(ln) for ln in src.text_layer()]
    return src, vs, spans


@pytest.fixture(scope="module")
def sheet(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("legend")
    src, vs, spans = _load(legend_sheet_pdf(), tmp)
    yield src, vs, spans
    src.close()


# ------------------------------------------------------------------------------ class rules
@pytest.mark.parametrize(
    ("label", "cls"),
    [
        ("שקע בודד", "socket_single"),
        ("שקע כפול", "socket_double"),
        ("שקע בהרכבים", "socket_double"),
        ("שקע כח", "socket_power"),
        ("שקע כוח למדיח", "socket_power"),
        ("שקע תלת פאזי", "socket_3phase"),
        ("מפסק מחליף", "switch_2way"),
        ("מתג הפעלה", "switch_single"),
        ("מפסק למאוורר", "switch_fan"),
        ("נק' מאור תקרתית", "luminaire_ceiling"),
        ("גוף תאורה שקוע מהקיר", "luminaire_wall"),
        ("מאוורר תקרה", "ceiling_fan"),
        ("פס לד", "luminaire_strip"),
        ("גוף תלוי פעמון מיני", "luminaire_pendant"),
        ("נק' קצה לטלויזיה", "tv_point"),
        ("נק' קצה לכבל רשת", "data_point"),
        ("נק' רמקול", "speaker"),
        ("לוח חשמל/לוח תקשורת", "panel"),
        ("תנור חימום לחדר רחצה", "heater_feed"),
        ("מרכז ניאגרה", "fixture_wc_concealed"),
        ("ברז קיר H=110", "faucet_wall"),
        ("ראה הערה", None),
        ("אביזר מוגן מים", None),
        ('צינור קוברה 50 מ"מ', "conduit_cobra"),
        ("צינור 25 להכנה", None),
    ],
)
def test_hebrew_label_rules(label, cls):
    got, conf = suggest_class(label, 0.9)
    assert got == cls
    assert (conf > 0.5) == (cls is not None)


def test_ocr_slips_do_not_cross_classes():
    # "תאורה" is one edit away from "תנור": short keywords never match fuzzily
    assert suggest_class("גוף תאורה שקוע", 0.9)[0] == "luminaire_ceiling"
    # a 6+ letter keyword survives one OCR slip
    assert suggest_class("שקע בהרכביס", 0.9)[0] == "socket_double"


@pytest.mark.parametrize(("tok", "n"), [("2X", 2), ("3x", 3), ("X2", 2), ("2א", 2), ("א3", 3), ("H=30", None), ("22", None)])
def test_multiplicity_tokens(tok, n):
    assert multiplicity(tok) == n


def test_multiplicity_changes_socket_class_only():
    assert apply_multiplicity("socket_single", 2) == "socket_double"
    assert apply_multiplicity("socket_single", 3) == "socket_triple"
    assert apply_multiplicity("socket_power", 2) == "socket_power_double"
    assert apply_multiplicity("luminaire_ceiling", 2) == "luminaire_ceiling"
    assert clean_qualifier("BEZEK |") == "BEZEK"
    assert clean_qualifier("+א2") == "2X"


# ------------------------------------------------------------------------------ geometry
def test_signature_ignores_position_and_size_but_not_shape():
    rng = np.random.default_rng(1)
    segs = rng.uniform(0, 4, size=(12, 4))
    a = stroke_signature(segs)
    assert a == stroke_signature(segs + 100.0)
    assert a == stroke_signature(segs * 1.5)
    assert a != stroke_signature(segs[:6])
    assert len(a) == 16 and all(c in "0123456789abcdef" for c in a)
    probes = stroke_signatures(segs)
    assert probes[0] == a and len(set(probes)) == len(probes) > 1
    assert stroke_signature(segs, "2X") != a  # the symbol's own text is part of the identity


def test_components_join_crossing_strokes():
    segs = np.array([[0, 0, 4, 0], [2, -1, 2, 1], [10, 0, 12, 0]], dtype=float)  # a cross + a separate dash
    lab = segment_components(segs)
    assert lab[0] == lab[1] != lab[2]


def test_orient_matrix_is_counter_clockwise_on_paper():
    m = orient_matrix(90, False)
    # +x (right) turned 90° counter-clockwise on paper points up, i.e. −y in a y-down frame
    assert np.allclose(m @ np.array([1.0, 0.0]), [0.0, -1.0])
    assert np.isclose(np.linalg.det(orient_matrix(45, True)), -1.0)


# ------------------------------------------------------------------------------ legend
def test_legend_found_from_ruled_table_with_labels_and_classes(sheet):
    _, vs, spans = sheet
    res = parse_legends(vs, spans)
    assert len(res.legends) == 1
    lg = res.legends[0]
    x0, y0, x1, _ = LEGEND_BOX
    assert abs(lg.bbox[0] - x0) < 0.5 and abs(lg.bbox[2] - x1) < 0.5 and abs(lg.bbox[1] - y0) < 0.5
    got = {e.label: e.suggested_class for e in res.entries}
    assert got == {
        "שקע בודד": "socket_single",
        "שקע בהרכבים": "socket_double",
        "שקע כח": "socket_power",
        "נק' מאור תקרתית": "luminaire_ceiling",
        "מתג הפעלה": "switch_single",
        "מחליף": "switch_2way",
    }
    for e in res.entries:
        sb = e.symbol_bbox
        assert e.label_bbox is not None and e.label_bbox[2] < sb[0]  # Hebrew: the label is left of its symbol
        assert 2.5 < max(sb[2] - sb[0], sb[3] - sb[1]) < 7.0
        assert len(e.signature) == 16


def test_spotting_finds_every_symbol_in_any_orientation(sheet, allow_green):
    """Heuristic levels (permissive calibration table); the conservative cap is checked at the end."""
    from kamutan_drawing import calibration as C

    _, vs, spans = sheet
    res = detect_symbols(vs, spans, parse_legends(vs, spans), discipline="electrical", scale_den=50)
    dets = [d for d in res.detections if d.source == "vector"]
    assert len(dets) == len(PLACED)
    used: set[int] = set()
    for pl in PLACED:
        dist, k = min((math.hypot(d.center[0] - pl.x, d.center[1] - pl.y), k) for k, d in enumerate(dets) if k not in used)
        assert dist < 2.0, pl
        used.add(k)
        assert dets[k].cls == pl.cls, (pl, dets[k].cls, dets[k].annotations)
    by_pos = {(round(d.center[0]), round(d.center[1])): d for d in dets}
    bank = [d for d in dets if 228 < d.center[0] < 233 and 107 < d.center[1] < 115]
    # the bank (2.4 mm pitch) keeps both switches, flagged as overlapping for the reviewer
    assert len(bank) == 2 and all("פריטים חופפים" in d.reasons and d.level != "green" for d in bank)
    # the 2-way switch is one detection (its strokes contain the single switch's), not a single + 2-way pair
    assert sum(1 for d in dets if math.hypot(d.center[0] - 300, d.center[1] - 175) < 5) == 1
    plain = [d for d in dets if d not in bank and d.cls != "switch_2way"]
    assert all(d.level == "green" and d.score >= 0.85 for d in plain), [(d.cls, d.reasons) for d in plain if d.level != "green"]
    assert by_pos
    two = next(d for d in dets if d.cls == "socket_double")
    assert "2X" in two.annotations
    # nothing is detected inside the legend itself
    x0, y0, x1, y1 = LEGEND_BOX
    assert not [d for d in res.detections if x0 <= d.center[0] <= x1 and y0 <= d.center[1] <= y1]
    # Sprint 5, conservative table (no class has enough DEV truth): the same items are capped at yellow with the
    # calibration chip; scoreRaw keeps the heuristic score
    C.set_default_table(C.fallback_table())
    cons = detect_symbols(vs, spans, parse_legends(vs, spans), discipline="electrical", scale_den=50).detections
    assert not [d for d in cons if d.level == "green"]
    cplain = [
        d
        for d in cons
        if d.source == "vector"
        and (round(d.center[0]), round(d.center[1])) in {(round(p.center[0]), round(p.center[1])) for p in plain}
    ]
    assert cplain and all(d.reasons == [C.R_CONSERVATIVE] and abs((d.score_raw or 0) - d.score) < 1e-3 for d in cplain)


def test_unknown_repeated_symbols_become_one_cluster(tmp_path):
    extra = [Placed("mystery", 150 + 30 * k, 250, 0, "unknown") for k in range(4)]
    src, vs, spans = _load(legend_sheet_pdf(PLACED[:3] + extra), tmp_path)
    try:
        res = detect_symbols(vs, spans, parse_legends(vs, spans), discipline="electrical", scale_den=50)
    finally:
        src.close()
    assert len(res.clusters) == 1 and res.clusters[0].count == 4
    unk = [d for d in res.detections if d.cls == "unknown"]
    assert len(unk) == 4 and all(
        d.cluster_id == res.clusters[0].id and d.level == "red" and R_NOT_IN_LEGEND in d.reasons for d in unk
    )


def test_type_tags_are_read_from_strokes_against_the_fixture_table(tmp_path):
    src, vs, spans = _load(types_sheet_pdf(), tmp_path)
    try:
        leg = parse_legends(vs, spans)
        res = detect_symbols(vs, spans, leg, discipline="lighting", scale_den=50)
    finally:
        src.close()
    types = {e.type_no: e.suggested_class for e in leg.entries}
    assert types == {"1": "luminaire_strip", "2": "luminaire_ceiling", "3": "ceiling_fan", "4": "luminaire_outdoor"}
    assert len(res.detections) == len(TAGS)
    for no, x, y in TAGS:
        d = next(d for d in res.detections if math.hypot(d.center[0] - x, d.center[1] - y) < 1.0)
        assert d.cls == types[no] and f"סוג {no}" in d.annotations
        assert d.level != "green"  # a tag alone is never enough for green


# ------------------------------------------------------------------------------ artifacts
def _gz(p: Path):
    return json.loads(gzip.decompress(p.read_bytes()))


def _check_refinements(det_doc):
    clusters = {c["id"] for c in det_doc["unknownClusters"]}
    ids = [d["id"] for d in det_doc["detections"]]
    assert len(ids) == len(set(ids))
    for d in det_doc["detections"]:
        if d["level"] != "green":
            assert d["reasons"], d
        if d["class"] == "unknown":
            assert d["clusterId"] in clusters
        assert len(d["annotations"]) <= 16 and all(0 < len(a) <= 32 for a in d["annotations"])


def test_understand_writes_contract_valid_artifacts(sheet, tmp_path):
    src, vs, spans = sheet
    out = tmp_path / "out"
    regions = [
        {
            "id": "r0",
            "floor": "ground",
            "polygonMm": [{"x": 0, "y": 0}, {"x": 420, "y": 0}, {"x": 420, "y": 297}, {"x": 0, "y": 297}],
            "scaleDenominator": 50,
        }
    ]
    res = understand(
        vs,
        spans,
        sheet_id="s1-p0",
        discipline="electrical",
        scale_den=50,
        regions=regions,
        text_paths=set(),
        render=src.render,
        out_dir=out,
    )
    leg, det, rooms = _gz(out / "legend.json.gz"), _gz(out / "detections.json.gz"), _gz(out / "rooms.json.gz")
    validate("LegendArtifact", leg)
    validate("DetectionsArtifact", det)
    validate("RoomsArtifact", rooms)
    _check_refinements(det)
    assert {e["legendId"] for e in leg["entries"]} <= {lg["id"] for lg in leg["legends"]}
    for e in leg["entries"]:
        assert e["id"].startswith("le_s1-p0_") and e["thumb"] == f"legend/{e['id']}.webp"
        assert (out / e["thumb"]).read_bytes()[:4] == b"RIFF"
    assert res["detectionStats"]["total"] == len(det["detections"]) == len(PLACED)
    assert res["detectionStats"]["byClass"]["socket_single"] == 3
    assert res["detectionStats"]["byClass"]["switch_2way"] == 1
    assert all(d["floor"] == "ground" for d in det["detections"])
    # deterministic: a second run writes byte-identical JSON
    out2 = tmp_path / "out2"
    understand(
        vs,
        spans,
        sheet_id="s1-p0",
        discipline="electrical",
        scale_den=50,
        regions=regions,
        text_paths=set(),
        render=src.render,
        out_dir=out2,
    )
    for name in ("legend.json.gz", "detections.json.gz", "rooms.json.gz"):
        assert (out / name).read_bytes() == (out2 / name).read_bytes()
    shutil.rmtree(out2)


def test_detection_only_on_mep_sheets(sheet):
    _, vs, spans = sheet
    res = understand(vs, spans, sheet_id="s", discipline="architecture", scale_den=50, regions=[], text_paths=set())
    assert res["legendEntries"] == 6 and res["detectionStats"]["total"] == 0 and not res["detected"]


def test_remembered_mapping_and_ignored_entries(sheet):
    _, vs, spans = sheet
    leg = parse_legends(vs, spans, sheet_id="s")
    by = {e.suggested_class: e for e in leg.entries}
    mappings = {
        by["socket_single"].signature: {"class": "socket_prep", "status": "confirmed", "entryId": "le_other_3"},
        by["socket_power"].signature: {"class": None, "status": "ignored", "entryId": "le_other_4"},
    }
    res = understand(
        vs, spans, sheet_id="s", discipline="electrical", scale_den=50, regions=[], text_paths=set(), mappings=mappings
    )
    by_class = res["detectionStats"]["byClass"]
    # the user confirmed the socket drawing as a preparation: every instance follows (also the 2X one)
    assert by_class.get("socket_prep") == 4 and "socket_single" not in by_class
    assert "socket_power" not in by_class  # ignored by the user
    assert res["legendLinks"][by["socket_single"].entry_id("s")] == "le_other_3"
    ent = {e["signature"]: e for e in res["legend"]["entries"]}
    assert ent[by["socket_single"].signature]["suggestedClass"] == "socket_prep"
    assert ent[by["socket_single"].signature]["classConfidence"] == 0.95


# ------------------------------------------------------------------------------ raster fallback
@pytest.mark.skipif(shutil.which("tesseract") is None, reason="tesseract not installed")
def test_raster_fallback_finds_legend_and_symbols_capped_at_yellow(tmp_path):
    from kamutan_drawing.render.raster import render_page
    from kamutan_drawing.symbols.raster import detect_raster

    p = tmp_path / "s.pdf"
    p.write_bytes(legend_sheet_pdf())
    img = render_page(str(p), 0, dpi=300)
    res = detect_raster(img, [], width_mm=420.0)
    assert res.legend is not None
    classes = {e.suggested_class for e in res.legend.entries}
    assert {"socket_power", "luminaire_ceiling", "switch_single"} <= classes
    assert len(res.detections) >= 8
    assert all(d.level != "green" and "רסטר" in d.reasons for d in res.detections)
    for kind in ("ceiling", "switch", "power"):
        for pl in [q for q in PLACED if q.kind == kind]:
            assert any(math.hypot(d.center[0] - pl.x, d.center[1] - pl.y) < 2.5 for d in res.detections), pl


# ------------------------------------------------------------------------------ trust rules
def test_floor_is_uncertain_without_an_agreeing_label_next_to_the_drawing():
    from kamutan_drawing.ocr.dictionary import TextSpan
    from kamutan_drawing.pipeline.understand import floor_labels, uncertain_floor_regions

    def reg(rid, floor, y0):
        return {
            "id": rid,
            "floor": floor,
            "polygonMm": [{"x": 0, "y": y0}, {"x": 200, "y": y0}, {"x": 200, "y": y0 + 100}, {"x": 0, "y": y0 + 100}],
        }

    def sp(text, x, y):
        return TextSpan("s", (x, y, x + 20, y + 3), text, 0.9, 3.0, 0, len(text))

    two = [reg("r0", "basement", 0), reg("r1", "ground", 150)]
    # floors from the title order only: both drawings are uncertain (the owner confirms the convention)
    assert uncertain_floor_regions([], two, None) == {"r0", "r1"}
    # a label next to each drawing that agrees: certain
    agree = [sp("קומת מרתף", 50, 102), sp("קומת קרקע", 50, 252)]
    assert floor_labels(agree, two, None) == {"r0": ["basement"], "r1": ["ground"]}
    assert uncertain_floor_regions(agree, two, None) == set()
    # a label that names another floor than the title order: uncertain, assignment kept
    assert uncertain_floor_regions([sp("קומת מרתף", 50, 102), sp("קומה א'", 50, 252)], two, None) == {"r1"}
    # notes are not labels ("במרתף", "קו קומה א'")
    one = [reg("r0", "ground", 0)]
    assert uncertain_floor_regions([sp("מחלף שני במרתף", 50, 50), sp("קו קומה א'", 50, 60)], one, None) == set()


def test_ambiguous_attachment_and_lone_rings():
    from kamutan_drawing.symbols.detect import _circle_with_contents, _contested, _lone_ring

    assert _contested([1.0, 2.5]) and not _contested([1.0, 6.0]) and not _contested([1.0])
    t = np.linspace(0, 2 * np.pi, 17)
    ring = np.column_stack([np.cos(t[:-1]), np.sin(t[:-1]), np.cos(t[1:]), np.sin(t[1:])])
    assert _lone_ring(ring)  # a circle drawn as a polyline: a dot / conduit end, never an unknown symbol
    tri = np.array([[-2, 1.5, 2, 1.5], [2, 1.5, 0, -2], [0, -2, -2, 1.5]], float)
    assert not _lone_ring(tri)
    kinds = np.ones(len(ring), np.int8)
    digit = np.array([[0.0, -0.4, 0.0, 0.4]])
    assert _circle_with_contents(np.vstack([ring * 1.5, digit]), np.concatenate([kinds, [0]]))  # a circled number
