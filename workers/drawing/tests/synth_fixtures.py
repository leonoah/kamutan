"""Synthetic 1:50 plan with sanitary fixtures (reportlab → pypdfium2 vectors), no customer data.

Plan = ``test_rooms.plan`` (room A 4.0 × 3.0 m = bathroom, room B 2.0 × 3.0 m = kitchen, door + window) with
fixtures drawn in the furniture pen (grey 152, 0.21 mm), plumbing labels as text items and black leader lines.
"""

from __future__ import annotations

import itertools

from reportlab.lib.colors import Color

from kamutan_drawing.ingest.pdf_vector import extract_pdf
from kamutan_drawing.types_sprint2 import SimpleText

from .synth import MM, make_pdf, to_pdf_xy
from .test_rooms import OX, OY, T, plan

GREY_PEN = (152 / 255, 152 / 255, 152 / 255)
M = 20.0  # paper mm per metre at 1:50
AX0, AY0 = OX + T, OY + T  # room A interior origin (64, 44)
XA = AX0 + 4.0 * M  # 144: inner face of the middle wall
BX0 = XA + T  # 148: room B interior

WC_C = (76.0, 49.6)
BASINS = ((100.0, 98.0), (120.0, 98.0))
BATH_C = (71.5, 78.0)
SINK_C = (181.0, 51.5)
WASHER_C = (156.0, 96.0)


def _pen(c, rgb=GREY_PEN, w=0.21):
    c.setStrokeColor(Color(*rgb))
    c.setLineWidth(w * MM)
    c.setDash([], 0)


def _rect(c, ps, x0, y0, x1, y1, r=0.0):
    x, y = to_pdf_xy(x0, y1, ps)
    if r:
        c.roundRect(x, y, (x1 - x0) * MM, (y1 - y0) * MM, r * MM, stroke=1, fill=0)
    else:
        c.rect(x, y, (x1 - x0) * MM, (y1 - y0) * MM, stroke=1, fill=0)


def _ellipse(c, ps, cx, cy, rx, ry):
    x0, y0 = to_pdf_xy(cx - rx, cy + ry, ps)
    x1, y1 = to_pdf_xy(cx + rx, cy - ry, ps)
    c.ellipse(x0, y0, x1, y1, stroke=1, fill=0)


def _line(c, ps, a, b):
    c.line(*to_pdf_xy(*a, ps), *to_pdf_xy(*b, ps))


def _poly(c, ps, pts):
    for a, b in itertools.pairwise(pts):
        _line(c, ps, a, b)


def wc(c, ps, x0, y0, *, tank: bool = False):
    """Bowl: 0.39 × 0.36 m box + half-round front (D-shape, 0.57 m long) + seat ring; optional 0.2 m tank box."""
    _pen(c)
    w, h, r = 7.8, 7.2, 3.6
    _poly(c, ps, [(x0 + w, y0), (x0, y0), (x0, y0 + h), (x0 + w, y0 + h)])
    p = c.beginPath()
    cx, cy = to_pdf_xy(x0 + w, y0 + h / 2, ps)
    p.arc(cx - r * MM, cy - r * MM, cx + r * MM, cy + r * MM, startAng=-90, extent=180)
    c.drawPath(p, fill=0, stroke=1)
    _ellipse(c, ps, x0 + 6.0, y0 + h / 2, 3.6, 2.8)
    if tank:
        _rect(c, ps, x0 - 4.0, y0 - 0.6, x0, y0 + h + 0.6)


def basin(c, ps, cx, cy):
    _pen(c)
    _ellipse(c, ps, cx, cy, 3.8, 3.1)
    _ellipse(c, ps, cx, cy, 3.2, 2.5)


def bath(c, ps, x0, y0):
    _pen(c)
    _rect(c, ps, x0, y0, x0 + 11.0, y0 + 32.0)
    _rect(c, ps, x0 + 1.0, y0 + 1.0, x0 + 10.0, y0 + 31.0, r=3.0)


def kitchen_sink(c, ps, x0, y0):
    _pen(c)
    _rect(c, ps, x0, y0, x0 + 12.0, y0 + 11.0)
    _rect(c, ps, x0 + 1.5, y0 + 1.5, x0 + 10.5, y0 + 9.5, r=1.5)
    cx, cy = to_pdf_xy(x0 + 6.0, y0 + 5.5, ps)
    c.circle(cx, cy, 0.8 * MM, stroke=1, fill=0)


def washer(c, ps, x0, y0):
    _pen(c)
    _rect(c, ps, x0, y0, x0 + 12.0, y0 + 12.0)
    cx, cy = to_pdf_xy(x0 + 6.0, y0 + 6.0, ps)
    c.circle(cx, cy, 3.6 * MM, stroke=1, fill=0)
    _line(c, ps, (x0, y0), (x0 + 12.0, y0 + 12.0))


def leader(c, ps, *pts):
    _pen(c, (0, 0, 0), 0.25)
    _poly(c, ps, list(pts))


def bathroom_sheet(*, monoblock: bool = False, with_bath: bool = True, labels: bool = True, extra=None):
    """(VectorSheet, text items) of the synthetic plan; fixtures as listed above."""

    def draw(c, ps):
        plan(c, ps)
        wc(c, ps, 68.2, 46.0, tank=monoblock)
        for cx, cy in BASINS:
            basin(c, ps, cx, cy)
        if with_bath:
            bath(c, ps, 66.0, 62.0)
        kitchen_sink(c, ps, 175.0, 46.0)
        washer(c, ps, 150.0, 90.0)
        if labels:
            leader(c, ps, (104.0, 50.6), (88.0, 50.6), (80.0, 50.0))  # מרכז ניאגרה → WC
            leader(c, ps, (124.0, 83.0), (106.0, 83.0), (100.0, 98.0))  # ברז קיר → basin 1 ("V")
            leader(c, ps, (106.0, 83.0), (120.0, 98.0))  # → basin 2
            leader(c, ps, (95.0, 73.0), (82.0, 73.0), (73.0, 78.0))  # אינטרפוץ → bath / shower area
            leader(c, ps, (172.0, 65.0), (160.0, 65.0), (181.0, 52.0))  # נק' מים+ביוב → sink
            leader(c, ps, (170.0, 83.0), (152.0, 83.0), (156.0, 95.0))  # מכונת כביסה → washer
        if extra:
            extra(c, ps)

    vs = extract_pdf(make_pdf(draw))[0]
    text = [
        SimpleText((100.0, 60.0, 112.0, 63.0), "חדר רחצה", 0.95),
        SimpleText((160.0, 74.0, 170.0, 77.0), "מטבח", 0.95),
    ]
    if labels:
        text += [
            SimpleText((88.0, 47.5, 104.0, 50.2), "מרכז ניאגרה" + (" מונובלוק" if monoblock else ""), 0.9),
            SimpleText((108.0, 80.0, 124.0, 82.6), "ברז קיר 110", 0.9),
            SimpleText((82.0, 70.0, 95.0, 72.6), "אינטרפוץ 4 דרך", 0.9),
            SimpleText((160.0, 62.0, 172.0, 64.6), "נק' מים+ביוב", 0.9),
            SimpleText((152.0, 80.0, 170.0, 82.6), "נק' מים וניקוז למכונת כביסה", 0.9),
            SimpleText((165.0, 68.0, 180.0, 70.6), "ניקוז + גז למזגן", 0.9),
            SimpleText((20.0, 150.0, 30.0, 152.6), "ברז גן", 0.9),
        ]
    return vs, text


REGION = {
    "id": "r0",
    "floor": "ground",
    "polygonMm": [{"x": 10, "y": 10}, {"x": 300, "y": 10}, {"x": 300, "y": 200}, {"x": 10, "y": 200}],
    "scaleDenominator": 50,
}
