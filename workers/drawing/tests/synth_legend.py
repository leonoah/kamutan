"""Synthetic electrical sheet with a ruled legend and placed symbols (reportlab; no customer data).

Labels are real PDF text (DejaVu Sans has Hebrew glyphs) so the pipeline's text layer reads them
without OCR. Symbols (paper mm, y down):

* socket   — half circle (r 1.6) + stem + bar      → "שקע בודד"     (socket_single)
* socket2x — same drawing with "2X" next to it     → "שקע בהרכבים"  (socket_double)
* power    — filled half disc + bar                → "שקע כח"       (socket_power)
* ceiling  — circle (r 1.9) + cross through it     → "נק' מאור תקרתית" (luminaire_ceiling)
* switch   — small circle + lever                  → "מתג הפעלה"    (switch_single)
"""

from __future__ import annotations

import io
import math
import os
from dataclasses import dataclass

from reportlab.lib.pagesizes import A3, landscape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

MM = 72.0 / 25.4
PAGE = landscape(A3)
FONT_PATHS = ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/TTF/DejaVuSans.ttf")


def hebrew_font() -> str | None:
    for p in FONT_PATHS:
        if os.path.exists(p):
            if "DejaVu" not in pdfmetrics.getRegisteredFontNames():
                pdfmetrics.registerFont(TTFont("DejaVu", p))
            return "DejaVu"
    return None


def _xy(x: float, y: float) -> tuple[float, float]:
    return x * MM, PAGE[1] - y * MM


class Pen:
    """Drawing in paper mm (y down) with an optional rotation (deg, counter-clockwise on paper)."""

    def __init__(self, c: canvas.Canvas, cx: float, cy: float, angle: float = 0.0) -> None:
        self.c, self.cx, self.cy = c, cx, cy
        self.t = math.radians(angle)

    def p(self, x: float, y: float) -> tuple[float, float]:
        # local (x right, y down) rotated counter-clockwise on paper
        c, s = math.cos(self.t), math.sin(self.t)
        return _xy(self.cx + c * x + s * y, self.cy - s * x + c * y)

    def line(self, a: tuple[float, float], b: tuple[float, float]) -> None:
        x0, y0 = self.p(*a)
        x1, y1 = self.p(*b)
        self.c.line(x0, y0, x1, y1)

    def arc(self, r: float, a0: float, a1: float, fill: bool = False) -> None:
        """Arc of radius r around the local origin from a0 to a1 (deg, local frame), as beziers."""
        path = self.c.beginPath()
        n = max(2, int(abs(a1 - a0) / 45))
        pts = []
        for k in range(n + 1):
            a = math.radians(a0 + (a1 - a0) * k / n)
            pts.append((r * math.cos(a), r * math.sin(a)))
        # cubic approximation per piece
        x, y = self.p(*pts[0])
        path.moveTo(x, y)
        for k in range(n):
            a = math.radians(a0 + (a1 - a0) * k / n)
            b = math.radians(a0 + (a1 - a0) * (k + 1) / n)
            h = 4 / 3 * math.tan((b - a) / 4) * r
            p1 = (r * math.cos(a) - h * math.sin(a), r * math.sin(a) + h * math.cos(a))
            p2 = (r * math.cos(b) + h * math.sin(b), r * math.sin(b) - h * math.cos(b))
            p3 = (r * math.cos(b), r * math.sin(b))
            path.curveTo(*self.p(*p1), *self.p(*p2), *self.p(*p3))
        if fill:
            path.close()
        self.c.drawPath(path, stroke=1, fill=1 if fill else 0)


def socket(c: canvas.Canvas, cx: float, cy: float, angle: float = 0.0) -> None:
    p = Pen(c, cx, cy, angle)
    p.arc(1.6, -90, 90)  # opening to the left
    p.line((0, -1.6), (0, 1.6))
    p.line((0, 0), (-1.6, 0))


def power(c: canvas.Canvas, cx: float, cy: float, angle: float = 0.0) -> None:
    p = Pen(c, cx, cy, angle)
    p.arc(1.8, -90, 90, fill=True)
    p.line((0, -1.8), (0, 1.8))
    p.line((-0.6, -1.8), (-0.6, 1.8))
    p.line((0, 0), (-2.0, 0))


def ceiling(c: canvas.Canvas, cx: float, cy: float, angle: float = 0.0) -> None:
    p = Pen(c, cx, cy, angle)
    p.arc(1.9, 0, 360)
    p.line((-2.7, 0), (2.7, 0))
    p.line((0, -2.7), (0, 2.7))


def switch(c: canvas.Canvas, cx: float, cy: float, angle: float = 0.0) -> None:
    p = Pen(c, cx, cy, angle)
    p.arc(0.45, 0, 360)
    p.line((0.32, -0.32), (2.4, -2.2))
    p.line((2.4, -2.2), (3.4, -1.3))


def text(c: canvas.Canvas, s: str, x: float, y_base: float, size_mm: float = 1.8) -> None:
    font = hebrew_font() or "Helvetica"
    c.setFont(font, size_mm * MM)
    # pdfium returns Hebrew runs of a text layer in reverse (visual) order: draw visual order
    if any("\u0590" <= ch <= "\u05ff" for ch in s):
        s = s[::-1]
    c.drawString(*_xy(x, y_base), s)


@dataclass(frozen=True)
class Placed:
    kind: str
    x: float
    y: float
    angle: float
    cls: str


# legend rows: (right symbol, right label, left symbol, left label)
LEGEND_ROWS = [
    ("socket", "שקע בודד", "ceiling", "נק' מאור תקרתית"),
    ("socket2x", "שקע בהרכבים", "switch", "מתג הפעלה"),
    ("power", "שקע כח", "switch2way", "מחליף"),
]
LEGEND_BOX = (20.0, 200.0, 110.0, 236.0)  # x0, y0, x1, y1

PLACED = [
    Placed("socket", 150, 60, 0, "socket_single"),
    Placed("socket", 200, 60, 90, "socket_single"),
    Placed("socket", 250, 80, 180, "socket_single"),
    Placed("socket2x", 300, 80, 270, "socket_double"),
    Placed("power", 160, 120, 0, "socket_power"),
    Placed("power", 220, 140, 90, "socket_power"),
    Placed("ceiling", 180, 170, 0, "luminaire_ceiling"),
    Placed("ceiling", 260, 170, 0, "luminaire_ceiling"),
    Placed("switch", 320, 130, 0, "switch_single"),
    Placed("switch", 340, 160, 90, "switch_single"),
    Placed("switch2way", 300, 175, 0, "switch_2way"),
    # a switch bank: two switches 2.4 mm apart
    Placed("switch", 230, 110, 0, "switch_single"),
    Placed("switch", 230, 112.4, 0, "switch_single"),
]


def switch2way(c: canvas.Canvas, cx: float, cy: float, angle: float = 0.0) -> None:
    """Two-way switch: the single switch plus a mirrored lever (contains every stroke of `switch`)."""
    switch(c, cx, cy, angle)
    p = Pen(c, cx, cy, angle)
    p.line((-0.32, 0.32), (-2.4, 2.2))
    p.line((-2.4, 2.2), (-3.4, 1.3))


def mystery(c: canvas.Canvas, cx: float, cy: float, angle: float = 0.0) -> None:
    """A symbol that is not in the legend: triangle with a small circle inside."""
    p = Pen(c, cx, cy, angle)
    p.line((-2.6, 2.0), (2.6, 2.0))
    p.line((2.6, 2.0), (0.0, -2.6))
    p.line((0.0, -2.6), (-2.6, 2.0))
    p.arc(0.5, 0, 360)


DRAW = {
    "switch2way": switch2way,
    "mystery": mystery,
    "socket": socket,
    "socket2x": socket,
    "power": power,
    "ceiling": ceiling,
    "switch": switch,
}


def _draw(c: canvas.Canvas, kind: str, x: float, y: float, angle: float) -> None:
    DRAW[kind](c, x, y, angle)
    if kind == "socket2x":
        # "2X" written next to the socket (left of it before rotation)
        p = Pen(c, x, y, angle)
        gx, gy = p.p(-5.2, 1.0)
        c.setFont(hebrew_font() or "Helvetica", 2.0 * MM)
        c.saveState()
        c.translate(gx, gy)
        c.rotate(angle)
        c.drawString(0, 0, "2X")
        c.restoreState()


def legend_sheet_pdf(
    placed: list[Placed] | None = None, *, with_legend: bool = True, title: str | None = "ת. חשמל קומת קרקע"
) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=PAGE)
    c.setLineWidth(0.25 * MM)
    # frame + a few walls
    c.rect(*_xy(10, 287), 400 * MM, 277 * MM)
    for a, b in (((130, 40), (380, 40)), ((130, 40), (130, 190)), ((380, 40), (380, 190)), ((130, 190), (380, 190))):
        c.line(*_xy(*a), *_xy(*b))
    if with_legend:
        x0, y0, x1, _ = LEGEND_BOX
        text(c, "מקרא:", x1 - 12, y0 - 1.5)
        ys = [y0 + 6 * k for k in range(7)]
        for yy in ys:
            c.line(*_xy(x0, yy), *_xy(x1, yy))
        c.line(*_xy(x0, ys[0]), *_xy(x0, ys[-1]))
        c.line(*_xy(x1, ys[0]), *_xy(x1, ys[-1]))
        for i, (rs, rl, ls, ll) in enumerate(LEGEND_ROWS):
            cy = ys[2 * i] + 3.0
            _legend_symbol(c, rs, x1 - 6, cy)
            text(c, rl, x1 - 40, cy + 1.0)
            if rs == "socket2x":
                text(c, "2X", x1 - 13.5, cy + 1.0, 2.0)
            if ls:
                _legend_symbol(c, ls, x0 + 40, cy)
                text(c, ll, x0 + 4, cy + 1.0)
    for pl in placed if placed is not None else PLACED:
        _draw(c, pl.kind, pl.x, pl.y, pl.angle)
    if title:
        text(c, title, 330, 270, 5.0)
        text(c, 'קנ"מ', 345, 280, 4.0)
        text(c, "1:50", 330, 280, 4.0)
    c.showPage()
    c.save()
    return buf.getvalue()


def _legend_symbol(c: canvas.Canvas, kind: str, x: float, y: float) -> None:
    DRAW[kind](c, x, y, 0.0)


# ------------------------------------------------------------------ fixture types table + tags
_SEG7 = {
    "0": "abcdef",
    "1": "bc",
    "2": "abged",
    "3": "abgcd",
    "4": "fgbc",
    "5": "afgcd",
    "6": "afgedc",
    "7": "abc",
    "8": "abcdefg",
    "9": "abcdfg",
}


def seg7(c: canvas.Canvas, s: str, x: float, y: float, h: float) -> None:
    """Stroke digits (paper mm, x = left, y = baseline) — vector 'SHX-like' numbers."""
    w = 0.55 * h
    for ch in s:
        segs = {
            "a": ((x, y - h), (x + w, y - h)),
            "b": ((x + w, y - h), (x + w, y - h / 2)),
            "c": ((x + w, y - h / 2), (x + w, y)),
            "d": ((x, y), (x + w, y)),
            "e": ((x, y - h / 2), (x, y)),
            "f": ((x, y - h), (x, y - h / 2)),
            "g": ((x, y - h / 2), (x + w, y - h / 2)),
        }
        for k in _SEG7[ch]:
            a, b = segs[k]
            c.line(*_xy(*a), *_xy(*b))
        x += w + 0.35 * h


def hidden_text(c: canvas.Canvas, s: str, x: float, y_base: float, size_mm: float) -> None:
    c.saveState()
    c.setFillColorRGB(1, 1, 1)
    text(c, s, x, y_base, size_mm)
    c.restoreState()


TYPE_ROWS = [("1", "פס לד"), ("2", "צילינדר לד"), ("3", "מאוורר תקרה"), ("4", "פרוז'קטור")]
TAGS = [("1", 200.0, 80.0), ("1", 240.0, 80.0), ("2", 200.0, 120.0), ("3", 260.0, 140.0), ("4", 300.0, 100.0)]


def types_sheet_pdf() -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=PAGE)
    c.setLineWidth(0.25 * MM)
    x0, x1, y0 = 20.0, 120.0, 190.0
    text(c, "טבלת תאורה:", x1 - 25, y0 - 2)
    ys = [y0 + 5 * k for k in range(len(TYPE_ROWS) + 2)]
    for yy in ys:
        c.line(*_xy(x0, yy), *_xy(x1, yy))
    for xx in (x0, 60.0, 112.0, x1):
        c.line(*_xy(xx, ys[0]), *_xy(xx, ys[-1]))
    text(c, "הערות", 30, ys[0] + 3.5)
    text(c, "סוג", 95, ys[0] + 3.5)
    text(c, "מס'", 114, ys[0] + 3.5)
    for i, (no, desc) in enumerate(TYPE_ROWS):
        base = ys[i + 1] + 4.0
        seg7(c, no, 115.0, base, 2.4)
        hidden_text(c, no, 115.0, base, 2.4)
        text(c, desc, 80, base)
    for no, x, y in TAGS:
        Pen(c, x, y).arc(2.0, 0, 360)
        seg7(c, no, x - 0.66, y + 1.2, 2.4)
    c.showPage()
    c.save()
    return buf.getvalue()
