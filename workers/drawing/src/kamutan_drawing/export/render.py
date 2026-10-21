"""Sandbox side of the marked PDF (task ``export_marked``): plan → PDF pages. Runs ONLY inside the parser sandbox.

Everything that touches customer bytes happens here: the original PDF page (pypdf reads it and merges our
overlay on top — merging *is* parsing, SEC-17), the rendered raster of a redacted page (pypdfium2), the stored
WebP tiles of raster / DXF sheets (Pillow) and the title-block search on the stored primitives / text.

Two modes (``args.mode``):

* ``pages`` — ``{plan, pages [i…], out}``: writes the given plan pages to ``out`` (one PDF part) and returns
  ``{out, pages, titleBlocks {i: [x0,y0,x1,y1] | null}, maskSource {i: "plan"|"detected"|"fallback"|"none"},
  background {i: "vector"|"raster"|"tiles"|"blank"}}``.
* ``assemble`` — ``{plan, parts [file…], out}``: concatenates the parts, appends the legend page(s) and writes
  ``out``; returns ``{out, pageCount, legendPages}``.

Page kinds: a PDF source keeps its ORIGINAL vector page (pypdf ``merge_transformed_page`` into a fresh page of
the display size — cropbox + /Rotate normalised exactly like ``ingest.pdf_vector._page_to_mm`` — then the
reportlab overlay merged over it; annotations / actions of the source are dropped). With ``hideTitleBlock`` the
page is instead rendered to a raster (pypdfium2, :data:`REDACT_DPI`) and the title block is painted white in the
pixels — a white box over vectors would only *hide* the text, the content stream would still carry it (real
redaction for share links). Raster / DXF sheets use the stored tile pyramid (level ≈ :data:`TILE_DPI`).
"""

from __future__ import annotations

import gzip
import io
import json
import math
import os
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .bidi import visual
from .palette import LEVEL_COLOURS, LEVEL_LABELS, LEVEL_SHAPES, hex_rgb

Progress = Callable[[str, int], None]

MM = 72.0 / 25.4  # pt per mm
REDACT_DPI = 200
FONT = "KamutanSans"
FONT_BOLD = "KamutanSans-Bold"
FONT_DIR = Path(__file__).resolve().parent / "fonts"
HATCH_SPACING_MM = 1.8
TB_PAD_MM = 1.5
MAX_PAGE_MM = 5000.0
WATERMARK_GREY = "#6B7280"
_fonts_ready = False


# ----------------------------------------------------------------------------- helpers
def _inside(rel: str) -> Path:
    """A relative path inside the sandbox workdir (cwd); rejects absolute / traversal / links."""
    base = Path.cwd().resolve()
    if not isinstance(rel, str) or not rel or os.path.isabs(rel) or ".." in Path(rel).parts:
        raise ValueError("invalid path")
    p = (base / rel).resolve()
    if os.path.commonpath([str(base), str(p)]) != str(base):
        raise ValueError("invalid path")
    return p


def register_fonts() -> None:
    global _fonts_ready
    if _fonts_ready:
        return
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    pdfmetrics.registerFont(TTFont(FONT, str(FONT_DIR / "DejaVuSans-heb.ttf")))
    pdfmetrics.registerFont(TTFont(FONT_BOLD, str(FONT_DIR / "DejaVuSans-Bold-heb.ttf")))
    _fonts_ready = True


def fmt_qty(v: float) -> str:
    if abs(v - round(v)) < 1e-9:
        return f"{round(v)}"
    return f"{v:.2f}".rstrip("0").rstrip(".")


def _rgb(c: str) -> Any:
    from reportlab.lib.colors import Color

    r, g, b = hex_rgb(c)
    return Color(r, g, b)


def _darker(c: str, f: float = 0.7) -> Any:
    from reportlab.lib.colors import Color

    r, g, b = hex_rgb(c)
    return Color(r * f, g * f, b * f)


class Page:
    """mm (y down) → reportlab pt (y up) on a canvas of the page's display size."""

    def __init__(self, c: Any, w_mm: float, h_mm: float) -> None:
        self.c, self.w, self.h = c, w_mm, h_mm

    def x(self, v: float) -> float:
        return v * MM

    def y(self, v: float) -> float:
        return (self.h - v) * MM


def draw_shape(c: Any, shape: str, cx: float, cy: float, r: float, fill: Any, stroke: Any | None = None) -> None:
    """Level glyph as a vector shape (pt coordinates, y up)."""
    c.saveState()
    c.setFillColor(fill)
    if stroke is not None:
        c.setStrokeColor(stroke)
        c.setLineWidth(0.4)
    p = c.beginPath()
    if shape == "circle":
        c.circle(cx, cy, r, stroke=1 if stroke is not None else 0, fill=1)
        c.restoreState()
        return
    if shape == "triangle":
        p.moveTo(cx, cy + r * 1.1)
        p.lineTo(cx - r * 1.05, cy - r * 0.75)
        p.lineTo(cx + r * 1.05, cy - r * 0.75)
    else:  # diamond
        p.moveTo(cx, cy + r * 1.15)
        p.lineTo(cx + r * 0.9, cy)
        p.lineTo(cx, cy - r * 1.15)
        p.lineTo(cx - r * 0.9, cy)
    p.close()
    c.drawPath(p, stroke=1 if stroke is not None else 0, fill=1)
    c.restoreState()


def draw_text(c: Any, x: float, y: float, text: str, *, size: float, font: str = FONT, colour: Any = None,
              align: str = "right", halo: bool = False) -> float:  # fmt: skip
    """Draw logical-order ``text`` (bidi-reordered); ``align`` right = x is the right edge (RTL). Returns width."""
    from reportlab.pdfbase.pdfmetrics import stringWidth

    v = visual(text)
    w = stringWidth(v, font, size)
    x0 = x - w if align == "right" else (x - w / 2 if align == "center" else x)
    if halo:  # white outline under the glyphs; own graphics state so the stroke-only mode (Tr 1) does not leak
        c.saveState()
        t = c.beginText(x0, y)
        t.setFont(font, size)
        t.setTextRenderMode(1)
        c.setStrokeColorRGB(1, 1, 1)
        c.setLineWidth(max(0.6, size * 0.22))
        c.setLineJoin(1)
        t.textOut(v)
        c.drawText(t)
        c.restoreState()
    c.saveState()
    c.setFillColor(colour if colour is not None else _rgb("#1C1917"))
    c.setFont(font, size)
    c.drawString(x0, y, v)
    c.restoreState()
    return float(w)


def fit_text(text: str, font: str, size: float, max_w: float) -> str:
    from reportlab.pdfbase.pdfmetrics import stringWidth

    if stringWidth(text, font, size) <= max_w:
        return text
    t = text
    while t and stringWidth(t + "…", font, size) > max_w:
        t = t[:-1]
    return (t.rstrip() + "…") if t else ""


def wrap_text(text: str, font: str, size: float, max_w: float, max_lines: int = 2) -> list[str]:
    from reportlab.pdfbase.pdfmetrics import stringWidth

    words = text.split()
    lines: list[str] = []
    cur = ""
    for w in words:
        cand = f"{cur} {w}".strip()
        if stringWidth(cand, font, size) <= max_w or not cur:
            cur = cand
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    if len(lines) > max_lines:
        lines = lines[: max_lines - 1] + [fit_text(" ".join(lines[max_lines - 1 :]), font, size, max_w)]
    return [fit_text(ln, font, size, max_w) for ln in lines] or [""]


# ----------------------------------------------------------------------------- overlay
def draw_overlay(c: Any, plan: dict[str, Any], page: dict[str, Any], mask: list[float] | None) -> None:
    """Areas → arcs → marks → labels → title-block mask (+ sheet legend inside it) → page tag → watermark."""
    lines = plan["lines"]
    P = Page(c, float(page["widthMm"]), float(page["heightMm"]))
    # tiled / measured areas: hatch clipped to the polygon, dashed outline
    for a in page.get("areas") or []:
        ln = lines[a["line"]]
        col = _rgb(ln["colour"])
        poly = a["poly"]
        path = c.beginPath()
        path.moveTo(P.x(poly[0][0]), P.y(poly[0][1]))
        for x, y in poly[1:]:
            path.lineTo(P.x(x), P.y(y))
        path.close()
        c.saveState()
        c.clipPath(path, stroke=0, fill=0)
        xs, ys = [p[0] for p in poly], [p[1] for p in poly]
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        ang = math.radians(45 + 60 * (int(a.get("k", 0)) % 3))
        dx, dy = math.cos(ang), math.sin(ang)
        diag = math.hypot(x1 - x0, y1 - y0) + 2
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        c.setStrokeColor(col)
        c.setStrokeAlpha(0.75)
        c.setLineWidth(0.45)
        n = int(diag / HATCH_SPACING_MM) + 1
        for i in range(-n, n + 1):
            ox, oy = cx - dy * i * HATCH_SPACING_MM, cy + dx * i * HATCH_SPACING_MM
            c.line(P.x(ox - dx * diag), P.y(oy - dy * diag), P.x(ox + dx * diag), P.y(oy + dy * diag))
        c.restoreState()
        c.saveState()
        c.setStrokeColor(col)
        c.setLineWidth(1.0)
        c.setDash(3, 1.5)
        c.drawPath(path, stroke=1, fill=0)
        c.restoreState()
        # code tag inside the top-left corner of the bounding box, stacked when several lines share the room
        draw_text(c, P.x(x0) + 1, P.y(y0) - 7 - 6.5 * (int(a.get("k", 0)) % 6), ln["code"], size=5.5, font=FONT_BOLD, colour=_darker(ln["colour"]),
                  align="left", halo=True)  # fmt: skip
    # link groups: thin dashed arcs (cubic with both handles on one point = quadratic)
    for a in page.get("arcs") or []:
        col = _rgb(lines[a["line"]]["colour"])
        (ax, ay), (bx, by) = a["a"], a["b"]
        mx, my = (ax + bx) / 2, (ay + by) / 2
        L = math.hypot(bx - ax, by - ay)
        if L < 0.5:
            continue
        nx, ny = -(by - ay) / L, (bx - ax) / L
        qx, qy = mx + nx * 0.18 * L, my + ny * 0.18 * L
        c.saveState()
        c.setStrokeColor(col)
        c.setStrokeAlpha(0.85)
        c.setLineWidth(0.6)
        c.setDash(2, 1.2)
        p = c.beginPath()
        p.moveTo(P.x(ax), P.y(ay))
        p.curveTo(P.x(qx), P.y(qy), P.x(qx), P.y(qy), P.x(bx), P.y(by))
        c.drawPath(p, stroke=1, fill=0)
        c.restoreState()
    # counted items: tinted box per line (concentric when one item is evidence of several lines)
    for m in page.get("marks") or []:
        x, y, w, h = float(m["x"]), float(m["y"]), float(m["w"]), float(m["h"])
        first = lines[m["lines"][0]]
        c.saveState()
        c.setFillColor(_rgb(first["colour"]))
        c.setFillAlpha(0.16)
        c.rect(P.x(x), P.y(y + h), w * MM, h * MM, stroke=0, fill=1)
        c.restoreState()
        for k, li in enumerate(m["lines"][:4]):
            pad = 0.35 + 0.75 * k
            c.saveState()
            c.setStrokeColor(_rgb(lines[li]["colour"]))
            c.setLineWidth(1.1)
            c.rect(P.x(x - pad), P.y(y + h + pad), (w + 2 * pad) * MM, (h + 2 * pad) * MM, stroke=1, fill=0)
            c.restoreState()
        pad = 0.35 + 0.75 * (min(len(m["lines"]), 4) - 1)
        lvl = m.get("level", "red")
        r = 1.05 * MM
        draw_shape(c, LEVEL_SHAPES.get(lvl, "diamond"), P.x(x + w + pad), P.y(y - pad), r, _rgb(LEVEL_COLOURS.get(lvl, "#C2410C")),
                   _rgb("#FFFFFF"))  # fmt: skip
        label = " · ".join(lines[li]["code"] for li in m["lines"][:4])
        draw_text(c, P.x(x - pad), P.y(y - pad) + 1.2, label, size=5.0, font=FONT_BOLD, colour=_darker(first["colour"]),
                  align="left", halo=True)  # fmt: skip
    # title block: opaque white (the raster path also burns it into the pixels)
    if mask is not None:
        x0, y0, x1, y1 = mask
        c.saveState()
        c.setFillColorRGB(1, 1, 1)
        c.setStrokeColor(_rgb("#A8A29E"))
        c.setLineWidth(0.5)
        c.rect(P.x(x0), P.y(y1), (x1 - x0) * MM, (y1 - y0) * MM, stroke=1, fill=1)
        c.restoreState()
        if plan["options"].get("legend", True):
            draw_sheet_legend(c, plan, page, (P.x(x0), P.y(y1), P.x(x1), P.y(y0)))
    draw_page_tag(c, plan, page, P)
    if plan["options"].get("watermark"):
        draw_watermark(c, str(plan["options"]["watermark"]), P.w * MM, P.h * MM)


def draw_page_tag(c: Any, plan: dict[str, Any], page: dict[str, Any], P: Page) -> None:
    floors = " + ".join(plan.get("floorLabels", {}).get(f, f) for f in page.get("floors") or []) or "ללא קומה"
    n = sum(cnt for _, cnt in page.get("legend") or [])
    title = page.get("title") or ""
    txt = (
        f"{floors} · {title} · {n} סימונים" if title and not plan["options"].get("hideTitleBlock") else f"{floors} · {n} סימונים"
    )
    from reportlab.pdfbase.pdfmetrics import stringWidth

    size = 6.5
    w = stringWidth(visual(txt), FONT_BOLD, size)
    x1, ytop = P.w * MM - 4 * MM, P.h * MM - 2.2 * MM
    c.saveState()
    c.setFillColorRGB(1, 1, 1)
    c.setFillAlpha(0.9)
    c.rect(x1 - w - 4, ytop - size - 3, w + 8, size + 5, stroke=0, fill=1)
    c.restoreState()
    draw_text(c, x1, ytop - size, txt, size=size, font=FONT_BOLD, colour=_rgb("#0F4C81"))


def draw_sheet_legend(c: Any, plan: dict[str, Any], page: dict[str, Any], box: tuple[float, float, float, float]) -> None:
    """Compact legend of the lines marked on this sheet, laid out RTL in columns inside ``box`` (pt, y up)."""
    x0, y0, x1, y1 = box
    rows = page.get("legend") or []
    if (x1 - x0) < 60 or (y1 - y0) < 14:
        return
    size = 6.0
    lh = size + 2.4
    draw_text(c, x1 - 3, y1 - size - 2, "מקרא הגיליון (המלא בעמוד המקרא)", size=size, font=FONT_BOLD)
    top = y1 - size - 2 - lh
    per_col = max(1, int((top - y0 - 2) // lh) + 1)
    col_w = 72 * MM / 1.0 if (x1 - x0) > 150 * MM else (x1 - x0 - 6) / 2
    col_w = min(col_w, 70 * MM)
    ncols = max(1, int((x1 - x0 - 6) // col_w))
    cap = per_col * ncols
    shown = rows if len(rows) <= cap else rows[: cap - 1]
    for k, (li, cnt) in enumerate(shown):
        ln = plan["lines"][li]
        col, row = divmod(k, per_col)
        right = x1 - 3 - col * col_w
        y = top - row * lh
        c.saveState()
        c.setFillColor(_rgb(ln["colour"]))
        c.rect(right - 7, y - 0.5, 7, size, stroke=0, fill=1)
        c.restoreState()
        text = fit_text(f"{ln['code']} {ln['description']}", FONT, size, col_w - 30)
        draw_text(c, right - 9, y, text, size=size)
        draw_text(c, right - col_w + 4, y, f"{cnt}×", size=size, align="left", colour=_rgb("#57534E"))
    if len(shown) < len(rows):
        k = len(shown)
        col, row = divmod(k, per_col)
        draw_text(c, x1 - 3 - col * col_w, top - row * lh, f"+{len(rows) - k} סעיפים נוספים בעמוד המקרא", size=size)


def draw_watermark(c: Any, text: str, w_pt: float, h_pt: float) -> None:
    from reportlab.pdfbase.pdfmetrics import stringWidth

    v = visual(text)
    diag = math.hypot(w_pt, h_pt)
    base = stringWidth(v, FONT_BOLD, 10) or 1.0
    size = max(14.0, min(140.0, 10 * 0.62 * diag / base))
    c.saveState()
    c.translate(w_pt / 2, h_pt / 2)
    c.rotate(math.degrees(math.atan2(h_pt, w_pt)))
    c.setFillColor(_rgb(WATERMARK_GREY))
    c.setFillAlpha(0.2)
    c.setFont(FONT_BOLD, size)
    c.drawCentredString(0, -size / 3, v)
    c.restoreState()


# ----------------------------------------------------------------------------- legend pages
def legend_pages(plan: dict[str, Any]) -> bytes:
    """Final legend: level glyphs + one row per BOQ line (colour · code · description · qty · unit · marks
    [· per floor]), A4 portrait, RTL; repeated header on every page; watermark when set."""
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.pdfgen import canvas

    register_fonts()
    floors: list[str] = list(plan.get("floors") or []) if plan["options"].get("floorSplit") else []
    size = landscape(A4) if len(floors) > 2 else A4
    W, H = size
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=size, pageCompression=1)
    c.setTitle("PDF מסומן — מקרא")
    margin = 14 * MM
    fs = 7.6
    # columns, right to left: (key, title, width pt)
    cols: list[tuple[str, str, float]] = [("swatch", "צבע", 13 * MM), ("code", "סעיף", 13 * MM)]
    fixed = [("qty", "כמות", 16 * MM), ("unit", "יחידה", 15 * MM), ("level", "ביטחון", 18 * MM), ("marks", "סימונים", 15 * MM)]
    from reportlab.pdfbase.pdfmetrics import stringWidth

    fl_cols = []
    for f in floors:
        label = str(plan.get("floorLabels", {}).get(f, f))[:24]
        fl_cols.append((f"f:{f}", label, max(15 * MM, stringWidth(visual(label), FONT_BOLD, fs) + 8)))
    used = sum(w for _, _, w in cols + fixed + fl_cols)
    cols.append(("desc", "תיאור", max(50 * MM, W - 2 * margin - used)))
    cols += fixed + fl_cols
    meta = plan.get("meta") or {}

    def header() -> float:
        y = H - margin
        draw_text(c, W - margin, y - 14, "מקרא צבעים לפי סעיף", size=15, font=FONT_BOLD)
        sub = f"כתב כמויות: בנייה {meta.get('buildId', '')} · הופק {meta.get('date', '')}"
        draw_text(c, W - margin, y - 28, sub, size=8, colour=_rgb("#57534E"))
        y -= 34
        if meta.get("stale"):
            draw_text(c, W - margin, y - 8, "שימו לב: כתב הכמויות אינו מעודכן לגרסאות האחרונות של השרטוטים", size=8,
                      font=FONT_BOLD, colour=_rgb("#C2410C"))  # fmt: skip
            y -= 12
        # level glyph key (shape + word, never colour alone)
        x = W - margin
        for lvl in ("green", "yellow", "red", "manual"):
            draw_shape(c, LEVEL_SHAPES[lvl], x - 4, y - 8 + 2.6, 3.4, _rgb(LEVEL_COLOURS[lvl]))
            wtxt = draw_text(c, x - 10, y - 8, LEVEL_LABELS[lvl], size=8)
            x -= wtxt + 26
        y -= 14
        draw_text(c, W - margin, y - 8, "מסגרת צבעונית = פריט שנספר · קווקוו צבעוני = שטח · קשת מקווקוות = קבוצת מפסק↔גוף תאורה",
                  size=7.2, colour=_rgb("#57534E"))  # fmt: skip
        y -= 18
        # table header
        x = W - margin
        c.saveState()
        c.setFillColor(_rgb("#E7E5E4"))
        c.rect(margin, y - 12, W - 2 * margin, 14, stroke=0, fill=1)
        c.restoreState()
        for _, title, w in cols:
            draw_text(c, x - 2, y - 8, title, size=fs, font=FONT_BOLD)
            x -= w
        return y - 14

    def footer(n: int) -> None:
        draw_text(c, W / 2, margin / 2, f"עמוד מקרא {n}", size=7, align="center", colour=_rgb("#57534E"))
        if plan["options"].get("watermark"):
            draw_watermark(c, str(plan["options"]["watermark"]), W, H)

    pages = 1
    y = header()
    for ln in plan["lines"]:
        dcol = next(w for k, _, w in cols if k == "desc")
        desc = wrap_text(ln["description"], FONT, fs, dcol - 12)
        rh = 5 + 10 * len(desc)
        if y - rh < margin + 10:
            footer(pages)
            c.showPage()
            pages += 1
            y = header()
        x = W - margin
        for key, _, w in cols:
            ty = y - 10
            if key == "swatch":
                c.saveState()
                c.setFillColor(_rgb(ln["colour"]))
                c.rect(x - w + 4, y - rh + 3, w - 8, rh - 6, stroke=0, fill=1)
                c.restoreState()
            elif key == "code":
                draw_text(c, x - 2, ty, ln["code"], size=fs, font=FONT_BOLD)
            elif key == "desc":
                for i, d in enumerate(desc):
                    draw_text(c, x - 2, ty - 10 * i, d, size=fs)
            elif key == "qty":
                q = fmt_qty(float(ln["qty"])) + (" ✎" if ln.get("overridden") else "")
                draw_text(c, x - 2, ty, q, size=fs)
            elif key == "unit":
                draw_text(c, x - 2, ty, fit_text(ln["unit"], FONT, fs, w - 4), size=fs)
            elif key == "level":
                lvl = ln["level"]
                draw_shape(c, LEVEL_SHAPES[lvl], x - 6, ty + 2.6, 3.2, _rgb(LEVEL_COLOURS[lvl]))
                draw_text(c, x - 12, ty, LEVEL_LABELS[lvl], size=fs - 0.6)
            elif key == "marks":
                draw_text(c, x - 2, ty, str(ln["marks"]) if ln["marks"] else "—", size=fs)
            elif key.startswith("f:"):
                v = float((ln.get("byFloor") or {}).get(key[2:], 0.0))
                draw_text(c, x - 2, ty, fmt_qty(v) if v else "—", size=fs)
            x -= w
        c.saveState()
        c.setStrokeColor(_rgb("#E7E5E4"))
        c.setLineWidth(0.5)
        c.line(margin, y - rh, W - margin, y - rh)
        c.restoreState()
        y -= rh
    if not plan["lines"]:
        draw_text(c, W - margin, y - 14, "אין שורות בכתב הכמויות", size=9)
    footer(pages)
    c.showPage()
    c.save()
    return buf.getvalue()


# ----------------------------------------------------------------------------- page backgrounds
Ctm = tuple[float, float, float, float, float, float]


def display_matrix(cropbox: tuple[float, float, float, float], rotation: int) -> tuple[Ctm, float, float]:
    """pypdf ctm (a,b,c,d,e,f) mapping PDF user space → the display page (pt, y up, origin bottom-left) +
    display size; same convention as ``ingest.pdf_vector._page_to_mm`` (crop box, clockwise /Rotate)."""
    x0, y0, x1, y1 = cropbox
    w, h = x1 - x0, y1 - y0
    rot = rotation % 360
    # (u, v) y-down in the crop box: u = x - x0, v = y1 - y
    if rot == 0:
        W, H = w, h
        # X = u, Yd = v → Y = H - v = y - y0
        return (1.0, 0.0, 0.0, 1.0, -x0, -y0), W, H
    if rot == 90:
        W, H = h, w
        # X = h - v = y - y0, Yd = u → Y = H - u = w - x + x0
        return (0.0, -1.0, 1.0, 0.0, -y0, w + x0), W, H
    if rot == 180:
        W, H = w, h
        # X = w - u = x1 - x, Yd = h - v → Y = v = y1 - y
        return (-1.0, 0.0, 0.0, -1.0, x1, y1), W, H
    if rot == 270:
        W, H = h, w
        # X = v = y1 - y, Yd = w - u → Y = u = x - x0
        return (0.0, 1.0, -1.0, 0.0, y1, -x0), W, H
    raise ValueError("unsupported rotation")


def _mask_px(mask: list[float], w_mm: float, h_mm: float, w_px: int, h_px: int) -> tuple[int, int, int, int]:
    sx, sy = w_px / w_mm, h_px / h_mm
    return (
        max(0, math.floor(mask[0] * sx)),
        max(0, math.floor(mask[1] * sy)),
        min(w_px, math.ceil(mask[2] * sx)),
        min(h_px, math.ceil(mask[3] * sy)),
    )


def render_pdf_raster(path: Path, index: int, dpi: int, mask: list[float] | None, w_mm: float, h_mm: float) -> Any:
    import pypdfium2 as pdfium
    from PIL import ImageDraw

    doc = pdfium.PdfDocument(str(path))
    try:
        page = doc[index]
        img = page.render(scale=dpi / 72.0, draw_annots=True, may_draw_forms=False).to_pil().convert("RGB")
        page.close()
    finally:
        doc.close()
    if mask is not None:
        ImageDraw.Draw(img).rectangle(_mask_px(mask, w_mm, h_mm, img.width, img.height), fill=(255, 255, 255))
    return img


def stitch_tiles(src: dict[str, Any], mask: list[float] | None, w_mm: float, h_mm: float) -> Any:
    from PIL import Image, ImageDraw

    d = _inside(str(src["dir"]))
    W, H, T = int(src["widthPx"]), int(src["heightPx"]), int(src["tileSize"])
    if not (0 < W <= 20000 and 0 < H <= 20000 and 16 <= T <= 4096):
        raise ValueError("bad tile geometry")
    img = Image.new("RGB", (W, H), (255, 255, 255))
    ext = str(src.get("format") or "webp")
    for ty in range(math.ceil(H / T)):
        for tx in range(math.ceil(W / T)):
            f = d / f"{tx}_{ty}.{ext}"
            if not f.is_file():
                continue
            with Image.open(f) as t:
                if t.width > T or t.height > T:
                    continue
                img.paste(t.convert("RGB"), (tx * T, ty * T))
    if mask is not None:
        ImageDraw.Draw(img).rectangle(_mask_px(mask, w_mm, h_mm, W, H), fill=(255, 255, 255))
    return img


# ----------------------------------------------------------------------------- title block
def find_title_block(page: dict[str, Any]) -> tuple[list[float] | None, str]:
    """(mask rect mm, source). Plan value → search on the stored primitives/text → band under the drawing regions."""
    W, H = float(page["widthMm"]), float(page["heightMm"])

    def pad(b: list[float]) -> list[float]:
        return [max(0.0, b[0] - TB_PAD_MM), max(0.0, b[1] - TB_PAD_MM), min(W, b[2] + TB_PAD_MM), min(H, b[3] + TB_PAD_MM)]

    if page.get("titleBlockMm"):
        return pad([float(v) for v in page["titleBlockMm"]]), "plan"
    tb_dir = page.get("tbDir")
    if tb_dir:
        try:
            from ..classify.sheet import span_from_line
            from ..pipeline.artifacts import decode_primitives, decode_text
            from ..titleblock.classify import read_title_block
            from ..types_sprint2 import vector_sheet_from_primitives

            d = _inside(str(tb_dir))
            vs = vector_sheet_from_primitives(decode_primitives((d / "primitives.msgpack.gz").read_bytes()))
            text = decode_text((d / "text.json.gz").read_bytes()) if (d / "text.json.gz").is_file() else {}
            spans = [span_from_line(ln) for ln in text.get("lines", [])]
            bb = read_title_block(spans, vs).bbox
            if bb is not None and (bb[2] - bb[0]) > 5 and (bb[3] - bb[1]) > 3:
                return pad([float(v) for v in bb]), "detected"
        except Exception as e:  # noqa: BLE001 - fall back to the geometric band below
            print(f"title block search failed: {type(e).__name__}", file=sys.stderr)
    regs = page.get("regions") or []
    if regs:
        bottom = max(float(r[3]) for r in regs)
        if H - bottom >= 8.0 and (H - bottom) <= 0.3 * H:
            return [0.0, bottom + 0.5, W, H], "fallback"
    return None, "none"


# ----------------------------------------------------------------------------- page assembly
def _overlay_bytes(plan: dict[str, Any], page: dict[str, Any], mask: list[float] | None, background: Any = None) -> bytes:
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    W, H = float(page["widthMm"]) * MM, float(page["heightMm"]) * MM
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(W, H), pageCompression=1)
    if background is not None:
        c.drawImage(ImageReader(background), 0, 0, width=W, height=H)
    draw_overlay(c, plan, page, mask)
    c.showPage()
    c.save()
    return buf.getvalue()


def write_pages(plan: dict[str, Any], indices: list[int], out: Path, progress: Progress) -> dict[str, Any]:
    from pypdf import PdfReader, PdfWriter, Transformation
    from pypdf.generic import NameObject

    register_fonts()
    hide = bool(plan["options"].get("hideTitleBlock"))
    writer = PdfWriter()
    readers: dict[str, Any] = {}
    tbs: dict[str, Any] = {}
    msrc: dict[str, str] = {}
    bgs: dict[str, str] = {}
    for n, i in enumerate(indices):
        page = plan["pages"][i]
        w_mm, h_mm = float(page["widthMm"]), float(page["heightMm"])
        if not (1 <= w_mm <= MAX_PAGE_MM and 1 <= h_mm <= MAX_PAGE_MM):
            raise ValueError("bad page size")
        mask, ms = find_title_block(page) if hide else (None, "none")
        tbs[str(i)], msrc[str(i)] = mask, ms
        src = page.get("source") or {"kind": "none"}
        kind = src.get("kind")
        if kind == "pdf" and not hide:
            f = str(src["file"])
            if f not in readers:
                r = PdfReader(str(_inside(f)), strict=False)
                if r.is_encrypted:
                    r.decrypt("")
                readers[f] = r
            sp = readers[f].pages[int(src["pageIndex"])]
            cb = sp.cropbox
            ctm, W, H = display_matrix((float(cb.left), float(cb.bottom), float(cb.right), float(cb.top)), int(sp.rotation or 0))
            if abs(W / MM - w_mm) > 2.0 or abs(H / MM - h_mm) > 2.0:
                raise ValueError("source page size does not match the version")
            dst = writer.add_blank_page(width=w_mm * MM, height=h_mm * MM)
            dst.merge_transformed_page(sp, Transformation(ctm), over=True, expand=False)
            ov = PdfReader(io.BytesIO(_overlay_bytes(plan, page, mask))).pages[0]
            dst.merge_page(ov, over=True)
            for key in ("/Annots", "/AA"):
                if NameObject(key) in dst:
                    del dst[NameObject(key)]
            dst.compress_content_streams(level=9)  # the merged stream is written uncompressed otherwise (MK-02 size)
            bgs[str(i)] = "vector"
        else:
            bg = None
            if kind == "pdf":
                bg = render_pdf_raster(_inside(str(src["file"])), int(src["pageIndex"]), REDACT_DPI, mask, w_mm, h_mm)
                bgs[str(i)] = "raster"
            elif kind == "tiles":
                bg = stitch_tiles(src, mask, w_mm, h_mm)
                bgs[str(i)] = "tiles"
            else:
                bgs[str(i)] = "blank"
            writer.add_page(PdfReader(io.BytesIO(_overlay_bytes(plan, page, mask, bg))).pages[0])
        progress("export", int(100 * (n + 1) / max(1, len(indices))))
    writer.compress_identical_objects(remove_identicals=True, remove_orphans=True)
    with open(out, "wb") as fh:
        writer.write(fh)
    return {"out": str(out.relative_to(Path.cwd().resolve())), "pages": len(indices), "titleBlocks": tbs, "maskSource": msrc,
            "background": bgs}  # fmt: skip


def assemble(plan: dict[str, Any], parts: list[str], out: Path) -> dict[str, Any]:
    from pypdf import PdfReader, PdfWriter

    writer = PdfWriter()
    for p in parts:
        for pg in PdfReader(str(_inside(p))).pages:
            writer.add_page(pg)
    legend_n = 0
    if plan["options"].get("legend", True):
        for pg in PdfReader(io.BytesIO(legend_pages(plan))).pages:
            writer.add_page(pg)
            legend_n += 1
    writer.add_metadata({"/Title": "PDF מסומן לפי סעיף", "/Producer": "kamutan-drawing", "/Creator": "Kamutan"})
    with open(out, "wb") as fh:
        writer.write(fh)
    return {"out": str(out.relative_to(Path.cwd().resolve())), "pageCount": len(writer.pages), "legendPages": legend_n}


def run(args: dict[str, Any], progress: Progress) -> dict[str, Any]:
    """Sandbox task ``export_marked`` (see the module docstring). Any parser failure → ``parse_crashed``."""
    from .. import errors as E
    from ..errors import IngestError

    try:
        return _run(args, progress)
    except (IngestError, MemoryError, RecursionError):
        raise
    except Exception as e:  # noqa: BLE001 - pypdf / pdfium / Pillow / reportlab errors on customer data
        raise IngestError(E.PARSE_CRASHED, f"marked PDF rendering failed ({type(e).__name__})") from None


def _run(args: dict[str, Any], progress: Progress) -> dict[str, Any]:
    plan_path = _inside(str(args["plan"]))
    raw = plan_path.read_bytes()
    plan = json.loads(gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw)
    out = _inside(str(args["out"]))
    out.parent.mkdir(parents=True, exist_ok=True)
    if args.get("mode") == "assemble":
        return assemble(plan, [str(p) for p in args.get("parts") or []], out)
    idx = [int(i) for i in args.get("pages") or []]
    if any(not 0 <= i < len(plan["pages"]) for i in idx):
        raise ValueError("page index out of range")
    return write_pages(plan, idx, out, progress)


__all__ = ["display_matrix", "find_title_block", "legend_pages", "register_fonts", "run"]
