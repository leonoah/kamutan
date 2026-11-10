"""Render a sheet (or a window of it) with a paper-mm grid for by-eye symbol ground truth (Sprint 11 Data/QA).

Coordinates are paper millimetres of the page as displayed (rotation applied), y down — the worker's frame.
No customer content here: the PDFs and the PNGs stay under $KAMUTAN_DATA_DIR / a scratch dir.

    uv run python -I tools/gt/render_tiles.py <pdf> <out.png> [--win X0 Y0 X1 Y1] [--ppmm 12] [--grid 10]
        [--marks marks.json]   # optional [{"x":..,"y":..,"label":"..","color":"red"}] drawn as rings (review pass)
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import pypdfium2 as pdfium
from PIL import Image, ImageDraw, ImageFont

MM_PER_PT = 25.4 / 72.0


def page_size_mm(pdf: Path) -> tuple[float, float]:
    doc = pdfium.PdfDocument(str(pdf))
    page = doc[0]
    w, h = page.get_size()
    return w * MM_PER_PT, h * MM_PER_PT


def render(pdf: Path, win: tuple[float, float, float, float] | None, ppmm: float) -> tuple[Image.Image, float, float]:
    doc = pdfium.PdfDocument(str(pdf))
    page = doc[0]
    w_pt, h_pt = page.get_size()
    w_mm, h_mm = w_pt * MM_PER_PT, h_pt * MM_PER_PT
    x0, y0, x1, y1 = win or (0.0, 0.0, w_mm, h_mm)
    x0, y0, x1, y1 = max(0.0, x0), max(0.0, y0), min(w_mm, x1), min(h_mm, y1)
    scale = ppmm * MM_PER_PT
    # crop = (left, bottom, right, top) in points of the displayed page
    crop = (x0 / MM_PER_PT, (h_mm - y1) / MM_PER_PT, (w_mm - x1) / MM_PER_PT, y0 / MM_PER_PT)
    bitmap = page.render(scale=scale, crop=crop)
    return bitmap.to_pil().convert("RGB"), x0, y0


def draw_grid(img: Image.Image, x0: float, y0: float, ppmm: float, step: float) -> None:
    """Grid lines every `step` mm. Labels are CENTRED on their line (white backing), repeated every 5 steps."""
    draw = ImageDraw.Draw(img, "RGBA")
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", max(10, int(ppmm * 1.5)))
    except OSError:
        font = ImageFont.load_default()
    w, h = img.size
    period = max(1, int(step * 5 * ppmm))

    def label(cx: float, cy: float, text: str, colour: tuple[int, int, int, int]) -> None:
        box = draw.textbbox((0, 0), text, font=font)
        tw, th = box[2] - box[0], box[3] - box[1]
        left, top = cx - tw / 2, cy - th / 2
        draw.rectangle([left - 1, top - 1, left + tw + 1, top + th + 1], fill=(255, 255, 255, 215))
        draw.text((left - box[0], top - box[1]), text, fill=colour, font=font)

    xs: list[tuple[float, float]] = []
    gx = (int(x0 // step) + 1) * step
    while (gx - x0) * ppmm < w:
        xs.append((gx, (gx - x0) * ppmm))
        gx += step
    ys: list[tuple[float, float]] = []
    gy = (int(y0 // step) + 1) * step
    while (gy - y0) * ppmm < h:
        ys.append((gy, (gy - y0) * ppmm))
        gy += step
    for value, px in xs:
        major = round(value / step) % 5 == 0
        draw.line([(px, 0), (px, h)], fill=(0, 110, 255, 150 if major else 75), width=1)
    for value, py in ys:
        major = round(value / step) % 5 == 0
        draw.line([(0, py), (w, py)], fill=(230, 0, 120, 150 if major else 75), width=1)
    for value, px in xs:
        for ty in range(int(ppmm * 1.2), h, period):
            label(px, ty, f"{value:g}", (0, 70, 220, 255))
    for value, py in ys:
        for tx in range(int(ppmm * 2.2), w, period):
            label(tx, py, f"{value:g}", (200, 0, 100, 255))


def draw_marks(img: Image.Image, x0: float, y0: float, ppmm: float, marks: list[dict[str, Any]]) -> None:
    draw = ImageDraw.Draw(img, "RGBA")
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", max(10, int(ppmm * 1.5)))
    except OSError:
        font = ImageFont.load_default()
    for mark in marks:
        px = (float(mark["x"]) - x0) * ppmm
        py = (float(mark["y"]) - y0) * ppmm
        if not (-20 <= px <= img.size[0] + 20 and -20 <= py <= img.size[1] + 20):
            continue
        radius = float(mark.get("r", 3.0)) * ppmm
        color = str(mark.get("color", "red"))
        draw.ellipse([px - radius, py - radius, px + radius, py + radius], outline=color, width=2)
        label = str(mark.get("label", ""))
        if label:
            draw.text((px + radius + 1, py - radius - 2), label, fill=color, font=font)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--win", type=float, nargs=4, default=None)
    parser.add_argument("--ppmm", type=float, default=12.0)
    parser.add_argument("--grid", type=float, default=10.0)
    parser.add_argument("--marks", type=Path, default=None)
    args = parser.parse_args()
    img, x0, y0 = render(args.pdf, tuple(args.win) if args.win else None, args.ppmm)
    if args.grid > 0:
        draw_grid(img, x0, y0, args.ppmm, args.grid)
    if args.marks:
        draw_marks(img, x0, y0, args.ppmm, json.loads(args.marks.read_text()))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    img.save(args.out)
    print(f"{args.out} {img.size[0]}x{img.size[1]} origin=({x0:g},{y0:g}) page_mm={page_size_mm(args.pdf)}")


if __name__ == "__main__":
    main()
