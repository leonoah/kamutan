"""Tiny synthetic vector PDFs built with reportlab (no customer data)."""

from __future__ import annotations

import io

from reportlab.lib.colors import Color
from reportlab.lib.pagesizes import A3, landscape
from reportlab.pdfgen import canvas

MM = 72.0 / 25.4


A3_LANDSCAPE = landscape(A3)


def make_pdf(draw, pagesize=A3_LANDSCAPE, rotate: int = 0) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=pagesize)
    if rotate:
        c.setPageRotation(rotate)
    draw(c, pagesize)
    c.showPage()
    c.save()
    return buf.getvalue()


def to_pdf_xy(x_mm: float, y_mm: float, pagesize) -> tuple[float, float]:
    """paper mm (y down from top) -> PDF points (y up)."""
    return x_mm * MM, pagesize[1] - y_mm * MM


def stroke_line(c, p0, p1, pagesize, width_mm=0.25, rgb=(0, 0, 0), dash=None):
    c.setStrokeColor(Color(*rgb))
    c.setLineWidth(width_mm * MM)
    c.setDash(*(dash or ([], 0)))
    x0, y0 = to_pdf_xy(*p0, pagesize)
    x1, y1 = to_pdf_xy(*p1, pagesize)
    c.line(x0, y0, x1, y1)


def glyph_strokes(kind: str, x: float, base: float, h: float) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    """Fake SHX letters as stroke lists (mm, y down). x = left edge, base = baseline."""
    w = 0.6 * h
    top = base - h
    if kind == "he":  # ה: roof + right leg (connected), separate left leg
        return [((x, top), (x + w, top)), ((x + w, top), (x + w, base)), ((x + 0.05 * h, top + 0.35 * h), (x + 0.05 * h, base))]
    if kind == "box":  # ם
        return [((x, top), (x + w, top)), ((x + w, top), (x + w, base)), ((x + w, base), (x, base)), ((x, base), (x, top))]
    if kind == "vav":  # ו
        return [((x, top), (x + 0.2 * h, top)), ((x + 0.2 * h, top), (x + 0.2 * h, base))]
    if kind == "colon":
        return [((x, top + 0.2 * h), (x, top + 0.3 * h)), ((x, base - 0.1 * h), (x, base))]
    if kind == "tick":  # geresh '
        return [((x + 0.1 * h, top - 0.05 * h), (x, top + 0.3 * h))]
    raise ValueError(kind)


def draw_word(c, pagesize, kinds, x, base, h, gap=0.3, width_mm=0.25, rgb=(0, 0, 0)):
    """Draw glyphs left to right; returns the right edge x."""
    for k in kinds:
        for p0, p1 in glyph_strokes(k, x, base, h):
            stroke_line(c, p0, p1, pagesize, width_mm=width_mm, rgb=rgb)
        x += {"vav": 0.2, "colon": 0.0, "tick": 0.1}.get(k, 0.6) * h + gap * h
    return x
