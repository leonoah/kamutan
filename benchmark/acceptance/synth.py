"""Synthetic drawings for the Stage-10 pipeline acceptance tests (no customer data).

Everything here is generated from code: reportlab vector PDFs with a real (TrueType) Hebrew text layer, ezdxf DXFs
and Pillow rasters. Only geometry conventions of the sample office are mimicked (A3, 1:50, bottom title-block strip,
cm dimension strings), never its content.
"""

from __future__ import annotations

import io
from collections.abc import Callable
from pathlib import Path
from typing import Any

MM = 72.0 / 25.4
A3_LANDSCAPE = (420.0 * MM, 297.0 * MM)
_FONT = "KamutanHeb"


def _font_path() -> Path:
    import kamutan_drawing

    return Path(kamutan_drawing.__file__).resolve().parent / "export" / "fonts" / "DejaVuSans-heb.ttf"


def _register_font() -> str:
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    if _FONT not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont(_FONT, str(_font_path())))
    return _FONT


class Page:
    """Paper-mm drawing helpers (y down from the top edge) over a reportlab canvas."""

    def __init__(self, c: Any, size: tuple[float, float] = A3_LANDSCAPE) -> None:
        self.c = c
        self.h = size[1]

    def xy(self, x: float, y: float) -> tuple[float, float]:
        return x * MM, self.h - y * MM

    def line(self, a: tuple[float, float], b: tuple[float, float], w: float = 0.18, grey: float = 0.0) -> None:
        self.c.setStrokeColorRGB(grey, grey, grey)
        self.c.setLineWidth(w * MM)
        self.c.line(*self.xy(*a), *self.xy(*b))

    def wall(self, x0: float, y0: float, x1: float, y1: float) -> None:
        """Filled wall rectangle (grey fill, thin black outline) like the sample's construction plans."""
        c = self.c
        c.setFillColorRGB(0.55, 0.55, 0.55)
        c.setStrokeColorRGB(0, 0, 0)
        c.setLineWidth(0.1 * MM)
        p = c.beginPath()
        p.moveTo(*self.xy(x0, y0))
        for q in ((x1, y0), (x1, y1), (x0, y1)):
            p.lineTo(*self.xy(*q))
        p.close()
        c.drawPath(p, fill=1, stroke=1)

    def text(self, x: float, y_base: float, s: str, h: float = 2.5, right: bool = False) -> None:
        """Text with its baseline at ``y_base`` (paper mm); ``right`` = x is the right edge (RTL alignment)."""
        c = self.c
        c.setFillColorRGB(0, 0, 0)
        c.setFont(_register_font(), h * MM / 0.72)  # cap height ~0.72 em
        x_pt, y_pt = self.xy(x, y_base)
        s = visual(s)
        if right:
            c.drawRightString(x_pt, y_pt, s)
        else:
            c.drawString(x_pt, y_pt, s)


def visual(s: str) -> str:
    """Logical → visual order for a Hebrew run, as CAD PDF exporters write it (reportlab does no bidi). Digit runs
    keep their left-to-right order; pdfium reverses RTL runs again on extraction, so the text layer reads logically."""
    if not any("֐" <= ch <= "׿" for ch in s):
        return s
    out: list[str] = []
    run = ""
    for ch in reversed(s):
        if ch.isdigit():
            run = ch + run
            continue
        if run:
            out.append(run)
            run = ""
        out.append(ch)
    if run:
        out.append(run)
    return "".join(out)


def make_pdf(draw: Callable[[Page], None], size: tuple[float, float] = A3_LANDSCAPE) -> bytes:
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=size)
    draw(Page(c, size))
    c.showPage()
    c.save()
    return buf.getvalue()


def title_block(p: Page, sheet_name: str, scale: str, *, x0: float = 230.0, y0: float = 262.0) -> None:
    """Bottom-right title block: ruled cells with the office's labels (שם הגיליון / קנ"מ / תאריך / סטטוס)."""
    x1, y1 = 410.0, 287.0
    for y in (y0, y0 + 12.5, y1):
        p.line((x0, y), (x1, y), 0.35)
    for x in (x0, x0 + 60.0, x0 + 120.0, x1):
        p.line((x, y0), (x, y1), 0.35)
    cells = [
        ("שם הגיליון:", sheet_name, x1, y0),
        ('קנ"מ:', scale, x0 + 120.0, y0),
        ("תאריך:", "01.01.26", x0 + 60.0, y0),
        ("סטטוס:", "לביצוע", x1, y0 + 12.5),
        ("שם הפרויקט:", "פרויקט סינתטי", x0 + 120.0, y0 + 12.5),
    ]
    for label, value, right, top in cells:
        p.text(right - 2.0, top + 4.0, label, 2.2, right=True)
        p.text(right - 2.0, top + 9.5, value, 2.5, right=True)


def bathroom_plan(p: Page, *, ox: float = 60.0, oy: float = 50.0, m: float = 20.0, t: float = 4.0) -> dict[str, Any]:
    """One closed 4.0 × 3.0 m bathroom + a 2.0 × 3.0 m kitchen at ``m`` paper mm per metre (1:50 → 20)."""
    xa = ox + t + 4.0 * m
    xb = xa + t + 2.0 * m
    y1 = oy + t + 3.0 * m
    p.wall(ox, oy, xb + t, oy + t)
    p.wall(ox, y1, xb + t, y1 + t)
    p.wall(ox, oy, ox + t, y1 + t)
    p.wall(xb, oy, xb + t, y1 + t)
    d0 = y1 - 0.2 * m - 0.8 * m
    p.wall(xa, oy, xa + t, d0)
    p.wall(xa, d0 + 0.8 * m, xa + t, y1)
    p.text(ox + t + 2.0 * m + 10.0, oy + t + 1.5 * m, "חדר רחצה", 3.0, right=True)
    p.text(xa + t + 1.0 * m + 6.0, oy + t + 1.5 * m, "מטבח", 3.0, right=True)
    return {"bath": (ox + t, oy + t, xa, y1), "kitchen": (xa + t, oy + t, xb, y1), "y1": y1, "xb": xb, "t": t}


def dimension(p: Page, x0: float, x1: float, y: float, value_cm: int) -> None:
    """Horizontal dimension line with ticks and its cm value written just above it (sample convention)."""
    p.line((x0, y), (x1, y), 0.13)
    for x in (x0, x1):
        p.line((x - 0.8, y + 0.8), (x + 0.8, y - 0.8), 0.13)
    p.text((x0 + x1) / 2 - 2.0, y - 0.6, str(value_cm), 2.0)


def scale_conflict_pdf(*, conflict: bool = True) -> bytes:
    """E2E-04: construction plan whose title block says 1:50 while every dimension string implies 1:100.

    Geometry is drawn at 1:50 (20 mm/m). With ``conflict`` the dimension strings are doubled (a 80 mm line is
    labelled 800 cm → 800·10/80 = 1:100); without it they agree with 1:50 (control sheet)."""
    k = 2 if conflict else 1

    def draw(p: Page) -> None:
        g = bathroom_plan(p)
        y = g["y1"] + g["t"] + 8.0
        bx0, _, bx1, _ = g["bath"]
        kx0, _, kx1, _ = g["kitchen"]
        dimension(p, bx0, bx1, y, 400 * k)
        dimension(p, kx0, kx1, y, 200 * k)
        dimension(p, bx0, kx1, y + 8.0, 640 * k)
        # vertical extent written as a horizontal dimension under the plan, a fourth independent pair
        dimension(p, bx0, bx0 + 60.0, y + 16.0, 300 * k)
        title_block(p, "ת. בנייה / קומת קרקע", "1:50")

    return make_pdf(draw)


def plain_sheet_pdf(title: str, n_lines: int = 12) -> bytes:
    """A small valid sheet (title block + a few lines) for set-level tests (E2E-14)."""

    def draw(p: Page) -> None:
        for i in range(n_lines):
            p.line((40.0, 40.0 + 10.0 * i), (200.0, 40.0 + 10.0 * i), 0.25)
        p.wall(40.0, 30.0, 200.0, 34.0)
        title_block(p, title, "1:50")

    return make_pdf(draw)


def truncated(data: bytes, keep: float = 0.45) -> bytes:
    """The first ``keep`` share of a file (an interrupted upload): header intact, xref/trailer gone."""
    return data[: max(16, int(len(data) * keep))]


def blocks_dxf(*, blocks: int = 6, graphic_copies: int = 2, exploded_extra: int = 1) -> bytes:
    """E2E-07: one-floor electrical plan as DXF (mm units, 1:50 declared).

    * ``blocks`` INSERTs of block ``SOCKET`` (a circle + two prongs: the usual socket outlet glyph);
    * ``graphic_copies`` of those positions are additionally drawn as loose lines/circles on top of the INSERT
      (graphic duplicates from an exploded copy — the drawing shows the same symbol twice);
    * ``exploded_extra`` sockets exist ONLY as loose graphics (no INSERT) — the block count misses them.

    Block count = ``blocks``; graphic count (distinct symbol positions) = ``blocks + exploded_extra``."""
    import ezdxf

    doc = ezdxf.new("R2018", setup=True)
    doc.header["$INSUNITS"] = 4
    msp = doc.modelspace()
    blk = doc.blocks.new("SOCKET")
    blk.add_circle((0, 0), 150)
    blk.add_line((-60, 150), (-60, 260))
    blk.add_line((60, 150), (60, 260))

    def loose(x: float, y: float) -> None:
        msp.add_circle((x, y), 150, dxfattribs={"layer": "EL-EXPLODED"})
        msp.add_line((x - 60, y + 150), (x - 60, y + 260), dxfattribs={"layer": "EL-EXPLODED"})
        msp.add_line((x + 60, y + 150), (x + 60, y + 260), dxfattribs={"layer": "EL-EXPLODED"})

    msp.add_lwpolyline([(0, 0), (10000, 0), (10000, 6000), (0, 6000)], close=True, dxfattribs={"layer": "WALLS"})
    msp.add_line((5000, 0), (5000, 6000), dxfattribs={"layer": "WALLS"})
    pts = [(800 + 1400 * i, 1000 + 2500 * (i % 2)) for i in range(blocks + exploded_extra)]
    for i, (x, y) in enumerate(pts[:blocks]):
        msp.add_blockref("SOCKET", (x, y), dxfattribs={"layer": "EL-SOCKETS"})
        if i < graphic_copies:
            loose(x, y)
    for x, y in pts[blocks:]:
        loose(x, y)
    # legend: the symbol + its label, like the sample's electrical legends
    msp.add_blockref("SOCKET", (12000, 5000), dxfattribs={"layer": "LEGEND"})
    msp.add_text("שקע בודד", height=250, dxfattribs={"layer": "LEGEND"}).set_placement((12500, 4900))
    msp.add_text("מקרא", height=300, dxfattribs={"layer": "LEGEND"}).set_placement((12000, 5800))
    msp.add_text("ת. חשמל / קומת קרקע", height=500, dxfattribs={"layer": "TEXT"}).set_placement((11000, 1000))
    msp.add_text('קנ"מ 1:50', height=300, dxfattribs={"layer": "TEXT"}).set_placement((11000, 300))
    s = io.StringIO()
    doc.write(s)
    return s.getvalue().encode("utf-8")


def raster_png(dpi: int = 200) -> bytes:
    """A small raster drawing with a DPI tag (E2E-05 synthetic control)."""
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (2339, 1654), "white")  # A4 landscape at 200 dpi
    d = ImageDraw.Draw(img)
    d.rectangle((60, 60, 2279, 1594), outline="black", width=4)
    for k in range(8):
        d.line((200 + 250 * k, 200, 200 + 250 * k, 1300), fill="black", width=3)
    for k in range(6):
        cx, cy = 300 + 300 * k, 1450
        d.ellipse((cx - 20, cy - 20, cx + 20, cy + 20), outline="black", width=3)
    buf = io.BytesIO()
    img.save(buf, format="PNG", dpi=(dpi, dpi))
    return buf.getvalue()
