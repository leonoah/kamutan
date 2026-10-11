"""Thin Tesseract 5 CLI wrapper (no pytesseract dependency) + vector line rendering."""

from __future__ import annotations

import os
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageOps

from .glyphs import TextLine

TESSERACT = os.environ.get("TESSERACT_CMD", "tesseract")


@dataclass
class BoxChar:
    ch: str
    x0: int
    y0: int  # top (image coords, y down)
    x1: int
    y1: int


def run_tesseract(img: Image.Image, lang: str = "heb", psm: int = 7, extra: list[str] | None = None) -> str:
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "in.png"
        img.save(p)
        cmd = [TESSERACT, str(p), "stdout", "-l", lang, "--psm", str(psm), *(extra or [])]
        r = subprocess.run(cmd, capture_output=True, text=True, env={**os.environ, "OMP_THREAD_LIMIT": "1"})
        return r.stdout


def ocr_text(img: Image.Image, lang: str = "heb", psm: int = 7) -> str:
    return " ".join(run_tesseract(img, lang, psm).split())


def ocr_boxes(img: Image.Image, lang: str = "heb", psm: int = 7) -> list[BoxChar]:
    """Per-character boxes via the ``makebox`` config (box file: x0 y0 x1 y1 bottom-left origin)."""
    out = run_tesseract(img, lang, psm, ["makebox"])
    H = img.size[1]
    res = []
    for ln in out.splitlines():
        parts = ln.split(" ")
        if len(parts) < 6:
            continue
        ch = parts[0]
        try:
            x0, y0, x1, y1 = (int(v) for v in parts[1:5])
        except ValueError:
            continue
        res.append(BoxChar(ch, x0, H - y1, x1, H - y0))
    return res


def render_line(
    line: TextLine,
    px_per_h: float = 40.0,
    stroke: int = 3,
    pad_h: float = 0.6,
    mirror: bool = False,
    glyph_ids: list[int] | None = None,
    supersample: int = 4,
) -> tuple[Image.Image, callable]:
    """Render the line's glyph strokes alone (no drawing clutter), text horizontal.

    Returns image and a function mapping line-frame x (mm) -> pixel x.
    """
    H = line.height
    ss = max(1, supersample)
    s = px_per_h / H * ss
    stroke = stroke * ss
    gl = line.glyphs if glyph_ids is None else [line.glyphs[i] for i in glyph_ids]
    x0 = min(g.bbox[0] for g in gl) - pad_h * H
    x1 = max(g.bbox[2] for g in gl) + pad_h * H
    y0 = line.topline - (0.6 + pad_h) * H
    y1 = line.baseline + (0.4 + pad_h) * H
    W = int(np.ceil((x1 - x0) * s))
    Hh = int(np.ceil((y1 - y0) * s))
    img = Image.new("L", (max(W, 8), max(Hh, 8)), 255)
    dr = ImageDraw.Draw(img)
    for g in gl:
        for a, b, c, d in g.segs:
            dr.line([((a - x0) * s, (b - y0) * s), ((c - x0) * s, (d - y0) * s)], fill=0, width=stroke)
            r = stroke / 2  # round joints so corners are closed
            for px, py in ((a, b), (c, d)):
                cx, cy = (px - x0) * s, (py - y0) * s
                dr.ellipse([cx - r, cy - r, cx + r, cy + r], fill=0)
    if ss > 1:
        img = img.resize((max(1, img.size[0] // ss), max(1, img.size[1] // ss)), Image.LANCZOS)
        s = s / ss
    if mirror:
        img = ImageOps.mirror(img)

    def to_px(x: float) -> float:
        p = (x - x0) * s
        return (img.size[0] - p) if mirror else p

    return img, to_px


def render_glyph(glyph, H: float, baseline: float, px_per_h: float = 48.0, stroke: int = 3) -> Image.Image:
    s = px_per_h / H
    x0 = glyph.bbox[0] - 0.6 * H
    x1 = glyph.bbox[2] + 0.6 * H
    y0 = baseline - 2.0 * H
    y1 = baseline + 1.0 * H
    img = Image.new("L", (int((x1 - x0) * s) + 1, int((y1 - y0) * s) + 1), 255)
    dr = ImageDraw.Draw(img)
    for a, b, c, d in glyph.segs:
        dr.line([((a - x0) * s, (b - y0) * s), ((c - x0) * s, (d - y0) * s)], fill=0, width=stroke)
    return img
