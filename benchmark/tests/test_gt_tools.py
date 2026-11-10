"""Sprint 11 Data/QA: by-eye GT tools (tools/gt). Synthetic data only."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "gt"))

import build_sheet_gt
import compare_detections
import render_tiles
from PIL import Image

TABLE = """
# project=demo sheet=abcd1234 discipline=electrical floor=ground scale=50 completeness=complete
# pass 1 comment
socket_double 141 165.3 ; X2 H=120
socket_single 109.5 128 ; existing socket ; lifecycle=existing
socket_box_6 349 344 ; D18 ; uncertain=true
conduit_cobra 43 144
"""


def test_parse_annot_reads_header_marks_and_props() -> None:
    annot = build_sheet_gt.parse_annot(TABLE)
    assert annot.meta["sheet"] == "abcd1234" and annot.meta["completeness"] == "complete"
    assert annot.comments == ["pass 1 comment"]
    assert [m.cls for m in annot.marks] == ["socket_double", "socket_single", "socket_box_6", "conduit_cobra"]
    assert annot.marks[0].notes == "X2 H=120" and (annot.marks[0].x, annot.marks[0].y) == (141.0, 165.3)
    assert annot.marks[1].props == {"lifecycle": "existing"} and annot.marks[1].notes == "existing socket"
    assert annot.marks[2].props == {"uncertain": "true"}


def test_parse_annot_needs_header() -> None:
    try:
        build_sheet_gt.parse_annot("socket_single 1 2\n")
    except ValueError:
        return
    raise AssertionError("a table without the project/sheet header must be rejected")


def test_ink_mask_keeps_saturated_colour_only() -> None:
    rgb = np.full((4, 4, 3), 255, dtype=np.uint8)
    rgb[0, 0] = (230, 30, 30)  # red glyph
    rgb[1, 1] = (128, 128, 128)  # grey wall
    rgb[2, 2] = (0, 0, 0)  # black architecture
    rgb[3, 3] = (255, 255, 0)  # yellow luminaire fill
    mask = build_sheet_gt.ink_mask(rgb)
    assert mask[0, 0] and mask[3, 3] and not mask[1, 1] and not mask[2, 2] and mask.sum() == 2


def _item(cls: str, x: float, y: float, ident: str = "i") -> compare_detections.Item:
    return {"id": ident, "cls": cls, "x": x, "y": y, "kind": "symbol", "level": "yellow"}


def test_compare_sheet_separates_match_confusion_miss_and_false_positive() -> None:
    gts = [_item("socket_single", 10, 10), _item("socket_double", 30, 10), _item("camera", 50, 10)]
    prs = [_item("socket_single", 10.5, 10.2), _item("socket_single", 30.4, 10.1), _item("socket_triple", 90, 90)]
    res = compare_detections.compare_sheet(gts, prs, tol=3.0)
    assert len(res["match"]) == 1 and res["match"][0][0] is gts[0]
    assert len(res["confusion"]) == 1 and res["confusion"][0][0] is gts[1] and res["confusion"][0][1] is prs[1]
    assert [g["cls"] for g, _ in res["fn"] if g] == ["camera"]
    assert [p["cls"] for _, p in res["fp"] if p] == ["socket_triple"]


def test_compare_sheet_prefers_same_class_over_a_nearer_other_class() -> None:
    gts = [_item("switch_single", 10, 10)]
    prs = [_item("socket_single", 10.1, 10), _item("switch_single", 11.5, 10)]
    res = compare_detections.compare_sheet(gts, prs, tol=3.0)
    assert len(res["match"]) == 1 and res["match"][0][1] is prs[1] and len(res["fp"]) == 1


def test_compare_sheet_respects_tolerance() -> None:
    res = compare_detections.compare_sheet([_item("panel", 0, 0)], [_item("panel", 3.5, 0)], tol=3.0)
    assert not res["match"] and len(res["fn"]) == 1 and len(res["fp"]) == 1


def test_draw_grid_and_marks_draw_inside_the_image() -> None:
    img = Image.new("RGB", (300, 200), "white")
    render_tiles.draw_grid(img, x0=100.0, y0=50.0, ppmm=10.0, step=10.0)
    render_tiles.draw_marks(img, 100.0, 50.0, 10.0, [{"x": 115.0, "y": 60.0, "label": "G", "color": "green"}])
    arr = np.asarray(img)
    assert (arr != 255).any()  # something was drawn
    assert tuple(arr[100, 150]) != (255, 255, 255) or tuple(arr[150, 100]) != (255, 255, 255)  # grid line at x=110 / y=60
