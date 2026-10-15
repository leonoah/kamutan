"""Existing / new / demolish classifier: synthetic vectors + sample demolition / construction / lighting sheets."""

from __future__ import annotations

from itertools import pairwise

import pytest

from kamutan_drawing.ingest.pdf_vector import extract_pdf
from kamutan_drawing.lifecycle import classify
from kamutan_drawing.lifecycle.classify import R_CONFLICT, R_DEFAULT, R_UNKNOWN
from kamutan_drawing.types_sprint2 import BBox, SimpleText

from .synth import make_pdf, stroke_line

YELLOW = (1.0, 1.0, 20 / 255)
RED = (1.0, 0.0, 0.0)
BLACK = (0.0, 0.0, 0.0)


def _boxes_sheet():
    """Three 4 mm 'symbols' (squares of lines): black at x=50, yellow at x=100, red dashed at x=150."""

    def sq(c, ps, x, y, rgb, dash=None):
        pts = [(x, y), (x + 4, y), (x + 4, y + 4), (x, y + 4), (x, y)]
        for a, b in pairwise(pts):
            stroke_line(c, a, b, ps, rgb=rgb, dash=dash)

    def draw(c, ps):
        sq(c, ps, 50, 50, BLACK)
        sq(c, ps, 100, 50, YELLOW)
        sq(c, ps, 150, 50, RED, dash=([2, 1], 0))

    return extract_pdf(make_pdf(draw))[0]


BOXES = [BBox(50, 50, 4, 4), BBox(100, 50, 4, 4), BBox(150, 50, 4, 4)]


def test_unknown_without_evidence_and_default():
    vs = _boxes_sheet()
    res = classify(vs, BOXES, {})
    assert [r.lifecycle for r in res] == ["unknown"] * 3
    assert all(r.reasons == [R_UNKNOWN] and r.confidence == 0.0 for r in res)
    res = classify(vs, BOXES, {"default": "new"})
    assert all(r.lifecycle == "new" and r.reasons == [R_DEFAULT] and r.confidence == 0.5 for r in res)


def test_legend_colours_and_dashed():
    vs = _boxes_sheet()
    res = classify(vs, BOXES, {"colors": {"#ffff14": "demolish", (255, 0, 0): "new"}})
    assert [r.lifecycle for r in res] == ["unknown", "demolish", "new"]
    assert res[1].confidence >= 0.8
    res = classify(vs, BOXES, {"dashed": "existing"})
    assert [r.lifecycle for r in res] == ["unknown", "unknown", "existing"]


def test_sheet_discipline_colour_prior():
    vs = _boxes_sheet()
    dem = classify(vs, BOXES, {"discipline": "demolition"})
    assert [r.lifecycle for r in dem] == ["existing", "demolish", "demolish"]
    con = classify(vs, BOXES, {"discipline": "construction"})
    assert [r.lifecycle for r in con] == ["existing", "new", "new"]
    assert all(r.confidence < 0.85 for r in dem + con)  # priors alone never green


@pytest.mark.parametrize(
    ("text", "want"),
    [
        ("נק' קיימת", "existing"),
        ("להריסה", "demolish"),
        ("פירוק מטבח קיים", "demolish"),
        ("שקע חדש", "new"),
        ("שקע כפול", "unknown"),
    ],
)
def test_text_votes_for_nearest_box(text, want):
    vs = _boxes_sheet()
    t = SimpleText((56.0, 50.0, 70.0, 53.0), text)  # 2 mm right of the first box
    res = classify(vs, BOXES, {"text": [t]})
    assert res[0].lifecycle == want
    assert res[1].lifecycle == "unknown" and res[2].lifecycle == "unknown"  # only the nearest box


def test_text_too_far_is_ignored():
    vs = _boxes_sheet()
    res = classify(vs, BOXES, {"text": [SimpleText((50.0, 80.0, 60.0, 83.0), "קיים")]})
    assert res[0].lifecycle == "unknown"


def test_conflict_between_colour_and_text_lowers_confidence():
    vs = _boxes_sheet()
    t = SimpleText((106.0, 50.0, 116.0, 53.0), "קיים")
    res = classify(vs, BOXES, {"colors": {"#ffff14": "demolish"}, "text": [t]})
    assert res[1].lifecycle in ("demolish", "existing")
    assert R_CONFLICT in res[1].reasons and res[1].confidence <= 0.45


def test_agreeing_evidence_raises_confidence():
    vs = _boxes_sheet()
    t = SimpleText((106.0, 50.0, 116.0, 53.0), "להריסה")
    res = classify(vs, BOXES, {"colors": {"#ffff14": "demolish"}, "text": [t]})
    assert res[1].lifecycle == "demolish" and res[1].confidence > 0.85


def test_accepts_tuples_and_dicts():
    vs = _boxes_sheet()
    res = classify(vs, [(100, 50, 104, 54), {"x": 150, "y": 50, "w": 4, "h": 4}], {"discipline": "demolition"})
    assert [r.lifecycle for r in res] == ["demolish", "demolish"]
    assert classify(vs, [], {}) == []


# ---------------------------------------------------------------- sample sheets


def _colour_boxes(vs):
    tp = set(vs.stats.get("textPaths", []))
    out = []
    for i in range(vs.n_paths):
        if i in tp:
            continue
        rgba = vs.path_fill_rgba[i] if vs.path_fill_mode[i] > 0 else vs.path_stroke_rgba[i]
        c = [int(v) for v in rgba[:3]]
        b = vs.path_bbox[i]
        if max(c) - min(c) > 24 and c != [0, 221, 0] and max(b[2] - b[0], b[3] - b[1]) > 3:
            out.append(BBox.from_xyxy(b))
    return out


@pytest.mark.parametrize(
    ("fid", "want"), [("70a5c3e0", "demolish"), ("af849ec4", "demolish"), ("1470f005", "new"), ("ad257a1c", "new")]
)
def test_sample_colour_semantics(sample_dir, fid, want):
    from .test_rooms import _load_artifacts

    vs, text, e = _load_artifacts(fid)
    boxes = _colour_boxes(vs)
    assert boxes
    res = classify(vs, boxes, {"discipline": e["discipline"], "text": text})
    share = sum(r.lifecycle == want for r in res) / len(res)
    assert share >= 0.8, (fid, share)


def test_sample_lighting_existing_points(sample_dir):
    """b2046277: the fixtures next to "נק' קיימת" notes are existing, the others stay unknown."""
    from .test_rooms import _load_artifacts

    vs, text, e = _load_artifacts("b2046277")
    notes = [t for t in text if "קיימ" in t.text]
    assert len(notes) >= 4
    b = vs.path_bbox
    import numpy as np

    has_curve = np.zeros(vs.n_paths, bool)
    has_curve[vs.curve_path] = True
    w, h = b[:, 2] - b[:, 0], b[:, 3] - b[:, 1]
    sel = np.where((w > 3) & (w < 6) & (h > 3) & (h < 6) & has_curve & (np.abs(w - h) < 0.3))[0]
    boxes, seen = [], set()
    for i in sel:
        q = BBox.from_xyxy(b[i])
        k = (round(q.cx), round(q.cy))
        if k not in seen:
            seen.add(k)
            boxes.append(q)
    res = classify(vs, boxes, {"text": text, "discipline": e["discipline"], "exclude_paths": []})
    existing = [q for q, r in zip(boxes, res, strict=True) if r.lifecycle == "existing"]
    assert 4 <= len(existing) <= 2 * len(notes) + 2
    assert sum(r.lifecycle == "unknown" for r in res) >= len(boxes) - len(existing) - 1
