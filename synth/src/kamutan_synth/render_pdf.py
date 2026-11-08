"""Scene -> vector PDF (reportlab). Deterministic: ``invariant=1`` fixes dates / document ids."""

from __future__ import annotations

from pathlib import Path

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from .scene import RGB, Arc, Circle, Item, Pen, Poly, Scene, Text, resolve_fill, resolve_pen
from .text import FontSpec, anchor_offset, outline_glyphs, stroke_polylines, text_width, to_visual

MM = 72.0 / 25.4
_REGISTERED: set[str] = set()


def _reg(font: FontSpec) -> str:
    name = f"Synth-{font.ttf_name}"
    if name not in _REGISTERED:
        pdfmetrics.registerFont(TTFont(name, font.ttf_path))
        _REGISTERED.add(name)
    return name


def _rgb(c: RGB) -> tuple[float, float, float]:
    return (c[0] / 255.0, c[1] / 255.0, c[2] / 255.0)


class _Pdf:
    def __init__(self, path: Path, scene: Scene, title: str) -> None:
        self.H = scene.height
        self.scene = scene
        self.c = canvas.Canvas(str(path), pagesize=(scene.width * MM, scene.height * MM), invariant=1, pageCompression=1)
        self.c.setTitle(title)
        self.c.setAuthor("kamutan-synth")
        self.c.setCreator("kamutan-synth")
        self.c.scale(MM, MM)
        self.c.setLineCap(1)
        self.c.setLineJoin(1)

    def y(self, v: float) -> float:
        return self.H - v

    def pen(self, p: Pen) -> None:
        self.c.setStrokeColorRGB(*_rgb(p.color))
        self.c.setLineWidth(max(p.width, 0.05))
        self.c.setDash(list(p.dash) if p.dash else [])

    def item(self, it: Item) -> None:
        p = it.prim
        if isinstance(p, Text):
            self.text(p, it.pen)
            return
        pen = resolve_pen(p.pen, it.pen)
        fill = None if isinstance(p, Arc) else resolve_fill(p.fill, it.pen)
        stroke = True if isinstance(p, Arc) else p.stroke
        c = self.c
        self.pen(pen)
        if fill is not None:
            c.setFillColorRGB(*_rgb(fill))
        path = c.beginPath()
        if isinstance(p, Poly):
            if len(p.pts) < 2:
                return
            for ring in [p.pts, *p.holes]:
                path.moveTo(ring[0][0], self.y(ring[0][1]))
                for q in ring[1:]:
                    path.lineTo(q[0], self.y(q[1]))
                if p.closed or fill is not None:
                    path.close()
        elif isinstance(p, Circle):
            path.circle(p.c[0], self.y(p.c[1]), p.r)
        elif isinstance(p, Arc):
            ext = (p.a1 - p.a0) % 360.0 or 360.0
            path.arc(p.c[0] - p.r, self.y(p.c[1]) - p.r, p.c[0] + p.r, self.y(p.c[1]) + p.r, p.a0, ext)  # type: ignore[arg-type]  # stubs say int, floats work
            fill = None
        c.drawPath(path, stroke=1 if stroke else 0, fill=1 if fill is not None else 0, fillMode=1)

    def text(self, t: Text, owner: Pen) -> None:
        font = t.font or self.scene.font
        color = t.color or owner.color
        vis = to_visual(t.text)
        if not vis.strip():
            return
        w = text_width(vis, t.h, font)
        dx, dy = anchor_offset(w, t.h, t.align, t.valign)
        c = self.c
        c.saveState()
        c.translate(t.pos[0], self.y(t.pos[1]))
        c.rotate(t.angle)
        if font.mode == "ttf":
            m = font.metrics()
            c.setFillColorRGB(*_rgb(color))
            c.setFont(_reg(font), t.h / m.cap)
            c.drawString(dx, -dy, vis)
        elif font.mode == "outline":
            # one filled path object per glyph, as CAD "text as geometry" exports do
            c.setFillColorRGB(*_rgb(color))
            for glyph in outline_glyphs(vis, t.h, font):
                path = c.beginPath()
                for ring in glyph:
                    path.moveTo(dx + ring[0][0], -(dy + ring[0][1]))
                    for q in ring[1:]:
                        path.lineTo(dx + q[0], -(dy + q[1]))
                    path.close()
                c.drawPath(path, stroke=0, fill=1, fillMode=0)
        else:
            c.setStrokeColorRGB(*_rgb(color))
            c.setLineWidth(max(0.13, t.h * 0.09))
            c.setDash([])
            # one path object per stroke, like AutoCAD's SHX export (the worker's glyph reader relies on it)
            for ln in stroke_polylines(vis, t.h, font):
                path = c.beginPath()
                path.moveTo(dx + ln[0][0], -(dy + ln[0][1]))
                if len(ln) == 1:
                    path.lineTo(dx + ln[0][0] + 0.01, -(dy + ln[0][1]))
                for q in ln[1:]:
                    path.lineTo(dx + q[0], -(dy + q[1]))
                c.drawPath(path, stroke=1, fill=0)
        c.restoreState()

    def save(self) -> None:
        self.c.showPage()
        self.c.save()


def render_pdf(scene: Scene, path: Path, title: str = "synthetic sheet") -> None:
    pdf = _Pdf(path, scene, title)
    for it in scene.flat():
        pdf.item(it)
    pdf.save()
