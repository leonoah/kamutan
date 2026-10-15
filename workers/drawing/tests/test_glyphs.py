from collections import Counter

from kamutan_drawing.ingest.pdf_vector import extract_pdf
from kamutan_drawing.ocr.dictionary import GlyphDictionary, text_spans
from kamutan_drawing.ocr.glyphs import connected_components, extract_text_lines

from .synth import draw_word, make_pdf, stroke_line


def _sheet(draw):
    return extract_pdf(make_pdf(draw))[0]


def test_glyph_segmentation_and_stacked_merge():
    # "ה ם ו :" at 3 mm height; ה has a detached leg, ':' is two dots
    vs = _sheet(lambda c, ps: draw_word(c, ps, ["he", "box", "vav", "colon"], 50, 50, 3.0))
    lines = extract_text_lines(vs, "s")
    assert len(lines) == 1
    ln = lines[0]
    assert len(ln.glyphs) == 4  # leg merged into ה, two dots into ':'
    assert ln.height == __import__("pytest").approx(3.0, abs=0.05)


def test_identical_glyphs_share_key_across_sizes_and_positions():
    def draw(c, ps):
        draw_word(c, ps, ["he", "box", "he"], 40, 40, 2.0)
        draw_word(c, ps, ["box", "he", "vav", "he"], 200, 150, 3.5)

    lines = extract_text_lines(_sheet(draw), "s")
    keys = Counter(g.key for ln in lines for g in ln.glyphs)
    assert len(lines) == 2
    assert len(keys) == 3  # ה, ם, ו
    assert sorted(keys.values()) == [1, 2, 4]


def test_underline_does_not_glue_word():
    def draw(c, ps):
        x1 = draw_word(c, ps, ["box", "he", "box"], 50, 80, 2.0)
        stroke_line(c, (50, 80.0), (x1, 80.0), ps)  # underline touching the baseline

    vs = _sheet(draw)
    comps = connected_components(vs)
    assert len(comps) >= 4  # underline removed -> letters separate again
    lines = extract_text_lines(vs, "s")
    assert sum(len(ln.glyphs) for ln in lines) == 3


def test_geresh_attaches_to_its_line_only():
    def draw(c, ps):
        draw_word(c, ps, ["box", "tick"], 50, 50, 2.0, gap=0.15)
        draw_word(c, ps, ["box", "he"], 50, 53.2, 2.0)  # next line just below

    lines = extract_text_lines(_sheet(draw), "s")
    assert sorted(len(ln.glyphs) for ln in lines) == [2, 2]


def test_style_separates_text_from_drawing():
    def draw(c, ps):
        draw_word(c, ps, ["box", "box"], 50, 50, 2.0, rgb=(0, 0, 0))
        draw_word(c, ps, ["he", "he"], 50 + 2.6, 50, 2.0, rgb=(1, 0, 0))

    lines = extract_text_lines(_sheet(draw), "s")
    assert len(lines) == 2


def test_dictionary_labels_and_reads_rtl():
    def draw(c, ps):
        for k in range(6):
            draw_word(c, ps, ["box", "he", "vav"], 30, 20 + 6 * k, 2.0)

    lines = extract_text_lines(_sheet(draw), "s")
    gd = GlyphDictionary.build(lines)
    assert gd.n_unique == 3
    # fake OCR votes (what tesseract would say), one cluster per shape
    names = {}
    for ln in lines:
        for g, ch in zip(ln.glyphs, ["ם", "ה", "ו"]):  # visual left->right
            names[g.cluster] = ch
    for c in gd.clusters:
        c.votes[names[c.id]] += 5
    gd.finalize_labels()
    assert gd.read_line(lines[0]) == "והם"  # logical order is right-to-left
    spans = text_spans(lines, gd)
    assert len(spans) == 6 and all(s.text == "והם" for s in spans)
    assert all(s.conf == 1.0 for s in spans)


def test_latin_context_and_gershayim():
    def draw(c, ps):
        draw_word(c, ps, ["box", "he", "vav"], 30, 20, 2.0)

    lines = extract_text_lines(_sheet(draw), "s")
    gd = GlyphDictionary.build(lines)
    cl = {g.cluster: k for k, g in zip(["box", "he", "vav"], lines[0].glyphs)}
    for c in gd.clusters:
        if cl[c.id] == "box":
            c.votes["ם"] += 3
            c.votes_eng["D"] += 3
        elif cl[c.id] == "he":
            c.votes.update({"9": 1, "6": 1, ".": 1})  # Hebrew model is confused
            c.votes_eng["E"] += 3
        else:
            c.votes["'"] += 3
    gd.finalize_labels()
    # ם has a Latin alt and its neighbour is Latin -> read as D
    assert gd.read_line(lines[0]).startswith("DE")
