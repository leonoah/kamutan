"""Sprint 10 (Worker-Classify): ToUnicode repair, title blocks with unreadable labels, strict keywords, floor
folding, confidence, region labels, project reconciliation (overview sheets, floor clashes) and the BOQ skip."""

from __future__ import annotations

import gzip
import io
import json
from pathlib import Path

import pytest

from kamutan_drawing.classify.project import (
    R_DUPLICATE,
    SheetFacts,
    apply_to_project,
    contained,
    find_overviews,
    reconcile,
    tokens_from_lines,
)
from kamutan_drawing.classify.regions import RegionResult, apply_label_floors, label_phrases
from kamutan_drawing.classify.sheet import R_NO_FLOOR, Classification, _floors_in_order, _from_free_text, classify_page
from kamutan_drawing.ingest.pdf_text import parse_tounicode, repaired_mapping, tounicode_cmap
from kamutan_drawing.ingest.pdf_vector import extract_pdf
from kamutan_drawing.ocr.dictionary import TextSpan
from kamutan_drawing.titleblock.classify import DISCIPLINES, FLOORS, _best_keyword, read_title_block_cells

from .synth import make_pdf, stroke_line

# --------------------------------------------------------------------------------------------- ToUnicode repair


def test_parse_tounicode_bfchar_and_bfrange():
    cm = "2 beginbfchar\n<02a0> <05d5>\n<0003> <0020>\nendbfchar\n1 beginbfrange\n<0010> <0012> <0041>\nendbfrange\n"
    assert parse_tounicode(cm) == {0x2A0: 0x5D5, 0x3: 0x20, 0x10: 0x41, 0x11: 0x42, 0x12: 0x43}
    assert parse_tounicode(tounicode_cmap({0x2A0: 0x5D0, 0x3: 0x20}).decode()) == {0x2A0: 0x5D0, 0x3: 0x20}


def test_repaired_mapping_only_when_the_cmap_disagrees_with_the_font():
    font = {0x2A0: 0x5D0, 0x2A1: 0x5D1, 0x2B7: 0x5E7, 0x2A4: 0x5D4, 0x3: 0x20}
    wrong = {0x2A0: 0x5D5, 0x2A1: 0x5D5, 0x2B7: 0x5E4, 0x2A4: 0x5EA, 0x3: 0x20, 0x999: 0x41}
    fixed = repaired_mapping(wrong, font)
    assert fixed == {0x2A0: 0x5D0, 0x2A1: 0x5D1, 0x2B7: 0x5E7, 0x2A4: 0x5D4, 0x3: 0x20, 0x999: 0x41}
    assert repaired_mapping(font, font) is None  # a correct CMap is never touched
    assert repaired_mapping({**font, 0x2A0: 0x5D5}, font) is None  # one stray entry: below MIN_WRONG


def _hebrew_font() -> bytes:
    """A tiny TrueType font (square glyphs) whose own cmap maps glyphs 2..4 to א ב ק."""
    from fontTools.fontBuilder import FontBuilder
    from fontTools.pens.ttGlyphPen import TTGlyphPen

    names = [".notdef", "space", "uni05D0", "uni05D1", "uni05E7"]
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap({0x20: "space", 0x5D0: "uni05D0", 0x5D1: "uni05D1", 0x5E7: "uni05E7"})
    glyphs = {}
    for n in names:
        pen = TTGlyphPen(None)
        if n not in ("space",):
            pen.moveTo((50, 0))
            pen.lineTo((50, 700))
            pen.lineTo((550, 700))
            pen.lineTo((550, 0))
            pen.closePath()
        glyphs[n] = pen.glyph()
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({n: (600, 50) for n in names})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({"familyName": "TestHeb", "styleName": "Regular"})
    fb.setupOS2()
    fb.setupPost()
    buf = io.BytesIO()
    fb.save(buf)
    return buf.getvalue()


def _autocad_like_pdf(font: bytes, tounicode: str) -> bytes:
    """One page, one Type0 / CIDFontType2 Identity-H font (like AutoCAD's ArialMT) drawing glyphs 2, 3, 4."""
    content = b"BT /F1 24 Tf 100 700 Td <000200030004> Tj ET"
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type0 /BaseFont /TestHeb /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 9 0 R >>",
        (
            b"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TestHeb /CIDSystemInfo << /Registry (PDFAUTOCAD) /Ordering "
            b"(Indentity0) /Supplement 0 >> /FontDescriptor 7 0 R /CIDToGIDMap /Identity /W [2 [600 600 600]] >>"
        ),
        (
            b"<< /Type /FontDescriptor /FontName /TestHeb /Flags 32 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 "
            b"/Descent -200 /CapHeight 700 /StemV 80 /FontFile2 8 0 R >>"
        ),
        b"<< /Length %d >>\nstream\n" % len(font) + font + b"\nendstream",
        b"<< /Length %d >>\nstream\n" % len(tounicode) + tounicode.encode() + b"\nendstream",
    ]
    out = io.BytesIO()
    out.write(b"%PDF-1.7\n")
    offsets = []
    for i, o in enumerate(objs, 1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n" % i + o + b"\nendobj\n")
    xref = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1))
    for off in offsets:
        out.write(b"%010d 00000 n \n" % off)
    out.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref))
    return out.getvalue()


def test_text_layer_reads_hebrew_through_the_fonts_own_cmap(tmp_path: Path):
    from kamutan_drawing.parse.pdf import PdfPageSource

    wrong = tounicode_cmap({2: 0x5D5, 3: 0x5D5, 4: 0x5E4}).decode()  # AutoCAD: א→ו, ב→ו, ק→פ
    p = tmp_path / "s.pdf"
    p.write_bytes(_autocad_like_pdf(_hebrew_font(), wrong))
    src = PdfPageSource.open(str(p), 0)
    try:
        text = "".join(ln["text"] for ln in src.text_layer())
    finally:
        src.close()
    assert sorted(text.replace(" ", "")) == sorted("אבק")
    assert "ו" not in text and "פ" not in text
    # the same file opened without a path (no repair) shows the broken CMap: the repair is what fixed it
    good = tmp_path / "good.pdf"
    good.write_bytes(_autocad_like_pdf(_hebrew_font(), tounicode_cmap({2: 0x5D0, 3: 0x5D1, 4: 0x5E7}).decode()))
    src = PdfPageSource.open(str(good), 0)
    try:
        assert sorted("".join(ln["text"] for ln in src.text_layer()).replace(" ", "")) == sorted("אבק")
    finally:
        src.close()


# ---------------------------------------------------------------------------------------------- title blocks


def _span(text, x0, y0, x1, y1, conf=0.9, h=None):
    return TextSpan(sheet="s", bbox=(x0, y0, x1, y1), text=text, conf=conf, height=h or (y1 - y0), rotation=0, n_glyphs=len(text))


def _cells_pdf():
    def draw(c, ps):
        stroke_line(c, (100, 268), (415, 268), ps)
        stroke_line(c, (100, 295), (415, 295), ps)
        for x in (100, 150, 200, 250, 300, 360, 415):
            stroke_line(c, (x, 268), (x, 295), ps)

    return extract_pdf(make_pdf(draw))[0]


def _new_template_spans(name_rows, label_conf=0.3):
    """The newer template: outlined labels read as garbage, values read well (Rubel / Yahav)."""
    out = [
        _span("רO תOרחיקלR", 365, 270, 412, 274, label_conf, 3.5),  # שם הפרויקט:
        _span("בית משפחת", 370, 277, 410, 280),
        _span("רO תעיPיחRP", 305, 270, 355, 274, label_conf, 3.5),  # שם הגיליון:
        _span("תאריRI", 255, 270, 295, 274, label_conf, 3.5),
        _span("22/Jan/2026", 255, 277, 295, 280),
        _span("סללחסR", 205, 270, 245, 274, label_conf, 3.5),  # סטטוס:
        _span("לעיון", 215, 277, 240, 280, 0.97),
        _span("לתמחור", 215, 282, 240, 285, 0.97),
        _span("לביצוע", 215, 287, 240, 290, 0.97),
        _span('קע"מ OתוחרתR', 155, 270, 195, 274, label_conf, 3.5),
        _span("1:50", 165, 280, 185, 284),
        _span("תאור והערות:", 105, 270, 145, 274, label_conf, 3.5),
    ]
    y = 277.0
    for row in name_rows:
        out.append(_span(row, 310, y, 350, y + 3))
        y += 5
    return out


def test_cells_title_block_without_readable_labels():
    vs = _cells_pdf()
    spans = _new_template_spans(["תכ' הריסה", "קומת קרקע"])
    tb = read_title_block_cells(spans, vs)
    assert tb.bbox is not None and tb.method == "cells"
    assert tb.fields["sheet_name"] == "תכ' הריסה\nקומת קרקע"
    assert tb.fields["scale"] == "1:50"
    cls = classify_page(spans, vs, check_dimensions=False)
    assert cls.discipline == "demolition"  # not "lighting" from the "תאור והערות:" label
    assert cls.floors == ["ground"]
    assert cls.source == "titleblock" and cls.level != "red"


def test_cells_fold_the_cold_store_confusions_and_split_words():
    vs = _cells_pdf()
    for rows, disc, floors in (
        (["חשמל", "כומת כרכע"], "electrical", ["ground"]),  # ק read as כ
        (["תכי הריסה", "לומת לרלע"], "demolition", ["ground"]),  # ק read as ל
        (["תכ הר סה", "לומה א"], "demolition", ["first"]),  # a word split in two
        (["העמדה", "קומת מרתף"], "furniture", ["basement"]),
        (["תכי בריכה", "קרקע"], "pool", ["ground"]),
        (["אחרי טופס 4", "קומת קרקע"], "post_permit", ["ground"]),
    ):
        cls = classify_page(_new_template_spans(rows), vs, check_dimensions=False)
        assert (cls.discipline, cls.floors) == (disc, floors), rows


def test_cells_need_anchors():
    vs = _cells_pdf()
    spans = [s for s in _new_template_spans(["תכ' חשמל", "קומה א"]) if s.text not in ("לעיון", "לתמחור", "לביצוע")]
    spans = [s for s in spans if s.text not in ("22/Jan/2026",)]
    assert read_title_block_cells(spans, vs).bbox is None  # no status column, no date + scale pair


def test_free_text_keywords_are_strict():
    for text in ("תאור והערות:", "פריסה", "ראה תכנית בניה", 'ע"פ הנחיות יועץ אינסטלציה', "בניה", "מיזוה"):
        title, _ = _from_free_text([_span(text, 10, 10, 60, 16, h=6)])
        assert title == "", text
    title, _ = _from_free_text([_span("תכנית חשמל", 10, 10, 60, 16, h=6)])
    assert title == "תכנית חשמל"
    assert _best_keyword("תאור", DISCIPLINES, 0.8, exact_up_to=5) == []
    assert _best_keyword("תאור", DISCIPLINES, 0.75)  # inside a title-block value one letter may be off


def test_scale_read_right_to_left():
    from kamutan_drawing.titleblock.classify import parse_scale

    assert parse_scale("50: ו") == 50 and parse_scale("1:50") == 50
    assert parse_scale("37: ו") is None and parse_scale("50: 3") is None


def test_glued_title_prefix():
    assert _best_keyword("תהתאורה", DISCIPLINES, 0.75)[0][0] == "lighting"  # "ת.תאורה", the dot read as ה
    assert _best_keyword("תהתאורה", DISCIPLINES, 0.8, exact_up_to=5) == []  # not in free text


def test_floor_folding():
    assert _floors_in_order("כומת כרכע") == ["ground"]
    assert _floors_in_order("לומה א") == ["first"]
    assert _floors_in_order("קומת מרתף+ קומת קרקע") == ["basement", "ground"]
    assert _best_keyword("א", FLOORS, 0.75) == [("first", 1.0)]  # the caller requires "קומה" for it
    assert _floors_in_order("גג") == ["roof"]


def test_read_but_weak_sheet_is_not_red():
    vs = _cells_pdf()
    spans = _new_template_spans(["תכ' תקרה", "קומה א"])
    spans = [_span(s.text, *s.bbox, conf=0.1 if s.text in ("תכ' תקרה", "קומה א") else s.conf, h=s.height) for s in spans]
    cls = classify_page(spans, vs, check_dimensions=False)
    assert cls.discipline == "ceiling" and cls.floors == ["first"]
    assert cls.level == "yellow" and cls.confidence >= 0.5


# ---------------------------------------------------------------------------------------------- region labels


def test_label_phrases_join_words_of_one_line():
    words = [_span("קרקע", 100, 50, 112, 55, h=4.5), _span("קומת", 118, 50, 130, 55, h=4.5), _span("x", 300, 50, 303, 55)]
    ph = label_phrases(words)
    assert any(p.text == "קומת קרקע" for p in ph)
    assert _floors_in_order(next(p.text for p in ph if "קומת" in p.text)) == ["ground"]


def test_label_floors_fill_a_title_without_floors():
    c = Classification("lighting", ["lighting"], [], "תאורה", "1:50", 50, 0.65, "yellow", [R_NO_FLOOR])
    apply_label_floors(c, RegionResult(regions=[], label_floors=["ground", "basement"]))
    assert c.floors == ["ground", "basement"] and R_NO_FLOOR not in c.reasons
    c2 = Classification("lighting", ["lighting"], ["first"], "תאורה", "1:50", 50, 0.9, "green", [])
    apply_label_floors(c2, RegionResult(regions=[], label_floors=["ground"]))
    assert c2.floors == ["first"]  # the title wins


# ---------------------------------------------------------------------------------------------- project reconcile


def _plan(seed: int, n: int = 40, dx: float = 0.0, dy: float = 0.0) -> list[tuple[str, float, float]]:
    """A floor plan's font text: room names / dimensions / tags at fixed relative positions (seeded)."""
    import random

    rnd = random.Random(seed)
    return [(f"t{seed}-{i}", dx + rnd.uniform(0, 200), dy + rnd.uniform(0, 150)) for i in range(n)]


def test_overview_sheet_repeating_per_floor_sheets_is_detected():
    b, g, f = _plan(1), _plan(2), _plan(3)
    overview = (
        [(t, x + 10, y + 300) for t, x, y in b]
        + [(t, x + 300, y + 20) for t, x, y in g]
        + [(t, x + 300, y + 300) for t, x, y in f]
    )
    sheets = [
        SheetFacts("lb", "lighting", ["basement"], b, title="תאורה מרתף"),
        SheetFacts("lg", "lighting", ["ground"], g, title="תאורה קרקע"),
        SheetFacts("lf", "lighting", ["first"], f, title="תאורה א"),
        SheetFacts("all", "lighting", [], overview + _plan(9, 10), title="תאורה כל הקומות"),
        SheetFacts("eg", "electrical", ["ground"], g),  # same plan, another discipline: never an overview part
    ]
    ov = find_overviews(sheets)
    assert list(ov) == ["all"]
    assert sorted(ov["all"].floors) == ["basement", "first", "ground"]
    assert sorted(ov["all"].covered_by) == ["lb", "lf", "lg"]
    assert "לא נספר" in ov["all"].reason and ov["all"].share > 0.95
    doc = ov["all"].to_doc()
    assert doc["status"] == "overview" and doc["coveredBy"]


def test_no_overview_without_two_distinct_parts():
    b, g = _plan(1), _plan(2)
    # a stacked sheet holding basement + first (Noah style) next to a ground sheet: not an overview
    sheets = [
        SheetFacts("lb_f", "lighting", ["basement", "first"], b + _plan(4, dx=300), title="מרתף+א"),
        SheetFacts("lg", "lighting", ["ground"], g),
    ]
    assert find_overviews(sheets) == {}
    # two per-floor sheets at the SAME place of the big sheet are one drawing, not two floors
    sheets = [
        SheetFacts("x", "lighting", ["basement"], b),
        SheetFacts("y", "lighting", ["ground"], b),
        SheetFacts("all", "lighting", [], b + _plan(5, 30)),
    ]
    assert find_overviews(sheets) == {}


def test_contained_is_asymmetric_and_offset_tolerant():
    a = _plan(7)
    big = [(t, x + 123.4, y - 50.2) for t, x, y in a] + _plan(8, 80)
    share, off = contained(a, big)
    assert share == 1.0 and abs(off[0] - 123.4) <= 1.0 and abs(off[1] + 50.2) <= 1.0
    assert contained(big, a)[0] < 0.5


def test_floor_clash_resolved_by_the_other_disciplines():
    g, f, b = _plan(2), _plan(3), _plan(1)
    sheets = [
        SheetFacts("cg", "construction", ["ground"], g + _plan(20, 30)),
        SheetFacts("cf", "construction", ["ground"], f + _plan(21, 30)),  # the title block says ground: copy-paste
        SheetFacts("cb", "construction", ["basement"], b),
        SheetFacts("dg", "demolition", ["ground"], g[:30]),
        SheetFacts("df", "demolition", ["first"], f[:30]),
        SheetFacts("db", "demolition", ["basement"], b),
    ]
    rec = reconcile(sheets)
    assert list(rec.floor_fixes) == ["cf"]
    fix = rec.floor_fixes["cf"]
    assert fix.floors == ["first"] and fix.title_floors == ["ground"] and "קרקע" in fix.reason
    assert rec.clashes == {}


def test_floor_clash_without_evidence_is_flagged_not_moved():
    sheets = [
        SheetFacts("p1", "pool", ["ground"], _plan(30)),
        SheetFacts("p2", "pool", ["ground"], _plan(30)[:35] + _plan(31, 5)),  # two versions of one sheet
        SheetFacts("eg", "electrical", ["ground"], _plan(2)),
        SheetFacts("ef", "electrical", ["first"], _plan(3)),
    ]
    rec = reconcile(sheets)
    assert rec.floor_fixes == {}
    assert set(rec.clashes) == {"p1", "p2"}
    assert rec.clashes["p1"].startswith(R_DUPLICATE.split("(")[0].strip())
    unrelated = [SheetFacts("a", "pool", ["ground"], _plan(40)), SheetFacts("b", "pool", ["ground"], _plan(41)), *sheets[2:]]
    assert "אותה קומה" in reconcile(unrelated).clashes["a"]


def test_confirmed_sheet_is_never_moved():
    g, f = _plan(2), _plan(3)
    sheets = [
        SheetFacts("cg", "construction", ["ground"], g),
        SheetFacts("cf", "construction", ["ground"], f, confirmed=True),
        SheetFacts("df", "demolition", ["first"], f),
        SheetFacts("dg", "demolition", ["ground"], g),
    ]
    rec = reconcile(sheets)
    assert "cf" not in rec.floor_fixes and rec.floor_fixes == {}


def test_tokens_use_font_text_only_and_skip_the_title_block():
    lines = [
        {"text": "חדר רחצה", "bboxMm": [10, 10, 30, 14], "src": "pdf"},
        {"text": "חדר רחצה", "bboxMm": [10, 20, 30, 24]},  # SHX reading: varies with the glyph store
        {"text": "בית משפחת", "bboxMm": [300, 280, 330, 284], "src": "pdf"},
        {"text": "|", "bboxMm": [1, 1, 2, 2], "src": "pdf"},
    ]
    assert tokens_from_lines(lines, (250, 270, 400, 297)) == [("חדר רחצה", 20.0, 12.0)]


# ------------------------------------------------------------------------------------- orchestrator glue + BOQ


def _put_sheet(docs, blobs, proj, sid, disc, floors, tokens, *, confirmed=False):
    from kamutan_drawing.pipeline.artifacts import version_prefix

    pre = version_prefix("o", "p", sid, "v1")
    lines = [
        {"text": t, "bboxMm": [x - 2, y - 1, x + 2, y + 1], "angle": 0.0, "confidence": 0.95, "src": "pdf"} for t, x, y in tokens
    ]
    blobs.write(pre + "text.json.gz", gzip.compress(json.dumps({"lines": lines}).encode()), "application/gzip")
    docs.set(
        f"{proj}/sheets/{sid}",
        {
            "discipline": disc,
            "floors": floors,
            "currentVersionId": "v1",
            "confirmed": confirmed,
            "title": sid,
            "classification": {"discipline": disc, "floors": floors, "level": "green", "reasons": [], "sheetTitle": sid},
        },
    )
    docs.set(
        f"{proj}/sheets/{sid}/versions/v1",
        {
            "status": "ready",
            "artifacts": {"text": pre + "text.json.gz"},
            "regions": [{"id": "r0", "floor": (floors or ["unknown"])[0]}],
        },
    )


def test_apply_to_project_marks_overview_and_moves_the_clashing_sheet(tmp_path: Path):
    from kamutan_drawing.stores.local import LocalBlobStore, LocalDocStore

    docs, blobs = LocalDocStore(tmp_path), LocalBlobStore(tmp_path)
    proj = "orgs/o/projects/p"
    docs.set(proj, {"name": "x"})
    b, g, f = _plan(1), _plan(2), _plan(3)
    _put_sheet(docs, blobs, proj, "lb", "lighting", ["basement"], b)
    _put_sheet(docs, blobs, proj, "lg", "lighting", ["ground"], g)
    _put_sheet(docs, blobs, proj, "lf", "lighting", ["ground"], f)  # title says ground
    _put_sheet(docs, blobs, proj, "pg", "plumbing", ["ground"], g[:30])
    _put_sheet(docs, blobs, proj, "pf", "plumbing", ["first"], f[:30])
    over = (
        [(t, x + 10, y + 300) for t, x, y in b]
        + [(t, x + 300, y + 20) for t, x, y in g]
        + [(t, x + 300, y + 300) for t, x, y in f]
    )
    _put_sheet(docs, blobs, proj, "all", "lighting", [], over)
    rec = apply_to_project(docs, blobs, "o", "p")
    assert rec is not None
    lf = docs.get(f"{proj}/sheets/lf")
    assert lf["floors"] == ["first"] and lf["floorCheck"]["titleFloors"] == ["ground"]
    assert lf["classification"]["level"] == "yellow" and any("השוואה" in r for r in lf["classification"]["reasons"])
    assert docs.get(f"{proj}/sheets/lf/versions/v1")["regions"][0]["floor"] == "first"
    al = docs.get(f"{proj}/sheets/all")
    assert al["coverage"]["status"] == "overview" and sorted(al["coverage"]["coveredBy"]) == ["lb", "lf", "lg"]
    assert al["floors"] == ["basement", "ground", "first"]
    assert any("לא נספר" in r for r in al["classification"]["reasons"])
    # idempotent: a second run changes nothing and keeps the title's floors as the reference
    apply_to_project(docs, blobs, "o", "p")
    lf2 = docs.get(f"{proj}/sheets/lf")
    assert lf2["floors"] == ["first"] and lf2["floorCheck"]["titleFloors"] == ["ground"]
    assert sum("השוואה" in r for r in lf2["classification"]["reasons"]) == 1
    # the BOQ build loads the per-floor sheets and skips the overview with its reason
    from kamutan_drawing.boq.build import load_inputs

    inp = load_inputs("o", "p", blobs, docs, seed=False)
    assert inp.skipped_sheets.get("all") == "overview"


def test_remap_floors_moves_detections_and_circuits_with_the_fix():
    from kamutan_drawing.classify.project import remap_floors

    sheet = {"floorCheck": {"titleFloors": ["ground"], "floors": ["first"]}}
    dets = [{"id": "d1", "floor": "ground"}, {"id": "d2", "floor": "basement"}, {"id": "d3"}]
    circ = {"circuits": [{"id": "c_A1", "floor": "ground"}, {"id": "c_B1", "floor": None}]}
    d2, c2 = remap_floors(sheet, dets, circ)
    assert [d.get("floor") for d in d2] == ["first", "basement", None]
    assert [c["floor"] for c in c2["circuits"]] == ["first", None]
    assert remap_floors({**sheet, "confirmed": True}, dets, circ) == (dets, circ)
    assert remap_floors({}, dets, None) == (dets, None)


def test_apply_to_project_needs_two_sheets(tmp_path: Path):
    from kamutan_drawing.stores.local import LocalBlobStore, LocalDocStore

    docs, blobs = LocalDocStore(tmp_path), LocalBlobStore(tmp_path)
    _put_sheet(docs, blobs, "orgs/o/projects/p", "a", "lighting", ["ground"], _plan(1))
    assert apply_to_project(docs, blobs, "o", "p") is None


@pytest.mark.parametrize("bad", [b"", b"%PDF-1.4\n%%EOF"])
def test_repair_never_raises_on_bad_files(tmp_path: Path, bad: bytes):
    from kamutan_drawing.ingest.pdf_text import repaired_pdf

    p = tmp_path / "x.pdf"
    p.write_bytes(bad)
    assert repaired_pdf(str(p), 0) is None
