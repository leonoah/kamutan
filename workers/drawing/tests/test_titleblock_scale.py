from kamutan_drawing.ingest.pdf_vector import extract_pdf
from kamutan_drawing.ocr.dictionary import TextSpan
from kamutan_drawing.scale.detect import detect_scale
from kamutan_drawing.titleblock.classify import classify_sheet, fuzzy_ratio, parse_scale, read_title_block

from .synth import make_pdf, stroke_line


def _span(text, x0, y0, x1, y1, conf=0.9):
    return TextSpan(sheet="s", bbox=(x0, y0, x1, y1), text=text, conf=conf, height=y1 - y0, rotation=0, n_glyphs=len(text))


def _title_block_pdf():
    def draw(c, ps):
        # bottom strip 270..295 with cells split at x=300, 330, 360
        stroke_line(c, (240, 270), (415, 270), ps)
        stroke_line(c, (240, 295), (415, 295), ps)
        for x in (240, 300, 330, 360, 415):
            stroke_line(c, (x, 270), (x, 295), ps)

    return extract_pdf(make_pdf(draw))[0]


def test_read_title_block_and_classify():
    vs = _title_block_pdf()
    spans = [
        _span("שם הפרויקט:", 380, 272, 410, 275),
        _span("בית משפחת", 385, 277, 410, 280),
        _span("שם הגיליון:", 340, 272, 358, 275),  # label OCR exactly
        _span("ת. חשמל", 345, 277, 358, 280),
        _span("קומת מרתף+", 340, 281, 358, 284),
        _span("קומת קרקע", 342, 285, 358, 288),
        _span('קנ"מ:', 320, 272, 328, 275),
        _span("1:50", 318, 278, 327, 281),
        _span("תאריך:", 280, 272, 298, 275),
        _span("22.12.16", 280, 278, 297, 281),
    ]
    tb = read_title_block(spans, vs)
    assert tb.bbox is not None
    assert tb.fields["sheet_name"] == "ת. חשמל\nקומת מרתף+\nקומת קרקע"
    assert tb.fields["scale"] == "1:50"
    cl = classify_sheet(tb)
    assert cl.disciplines == ["electrical"]
    assert cl.floors == ["basement", "ground"]
    assert cl.scale_den == 50 and cl.date == "22.12.16"
    assert 0.5 < cl.confidence <= 1.0


def test_classify_is_tolerant_to_ocr_noise():
    vs = _title_block_pdf()
    spans = [
        _span("שם הגיליוו:", 340, 272, 358, 275),  # one wrong letter in the label
        _span("ת. אינסטלצי", 345, 277, 358, 280),  # truncated keyword
        _span("קומה א'", 345, 281, 358, 284),
        _span('קנ"מ:', 320, 272, 328, 275),
    ]
    cl = classify_sheet(read_title_block(spans, vs))
    assert cl.disciplines == ["plumbing"]
    assert cl.floors == ["first"]


def test_helpers():
    assert parse_scale("1:50") == 50
    assert parse_scale("1 / 100") == 100
    assert parse_scale("2:1") is None
    assert fuzzy_ratio("תאריך:", "תאריך") == 1.0


def test_scale_from_dimension_strings():
    # three dimension lines: 550 cm drawn 110 mm long -> 1:50
    def draw(c, ps):
        for k, (val, L) in enumerate([(550, 110), (270, 54), (120, 24)]):
            y = 50 + 20 * k
            stroke_line(c, (50, y), (50 + L, y), ps)

    vs = extract_pdf(make_pdf(draw))[0]
    spans = [
        _span("550", 100, 47.3, 106, 49.5),
        _span("270", 72, 67.3, 78, 69.5),
        _span("120", 59, 87.3, 65, 89.5),
        _span('פרט A קנ"מ 1:20', 10, 10, 30, 12),
    ]
    r = detect_scale(50, spans, vs)
    assert r.n_dimension_pairs == 3
    assert r.from_dimensions == 50 and not r.conflict and r.agree_share == 1.0
    assert r.other_scales_in_text == [20]
