"""Contact sheets of zoomed crops around GT/detection disagreements (Sprint 11 Data/QA review pass).

Input: the `<project>_<sheet>_marks.json` written by `compare_detections.py --out`. Nearby marks share one crop.
Green ring = by-eye GT, blue ring = detection. Output PNGs stay outside git.

    uv run python -I tools/gt/review_sheet.py <pdf> <marks.json> <out-prefix> [--crop 26 20] [--ppmm 22] [--per-page 9]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont
from render_tiles import draw_grid, draw_marks, render


def cluster(marks: list[dict[str, Any]], radius: float) -> list[list[dict[str, Any]]]:
    groups: list[list[dict[str, Any]]] = []
    for mark in marks:
        for group in groups:
            if any(
                abs(float(m["x"]) - float(mark["x"])) <= radius and abs(float(m["y"]) - float(mark["y"])) <= radius for m in group
            ):
                group.append(mark)
                break
        else:
            groups.append([mark])
    return groups


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("marks", type=Path)
    parser.add_argument("out_prefix")
    parser.add_argument("--crop", type=float, nargs=2, default=(26.0, 20.0))
    parser.add_argument("--ppmm", type=float, default=22.0)
    parser.add_argument("--per-page", type=int, default=9)
    parser.add_argument("--all-marks", type=Path, default=None, help="draw these marks too (thin), e.g. the whole GT")
    args = parser.parse_args()
    marks = json.loads(args.marks.read_text())
    extra = json.loads(args.all_marks.read_text()) if args.all_marks else []
    groups = cluster(marks, min(args.crop) / 2.5)
    cw, ch = args.crop
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 16)
    cols = 3 if args.per_page <= 9 else (5 if args.per_page <= 20 else 8)
    tiles: list[Image.Image] = []
    for index, group in enumerate(groups, start=1):
        cx = sum(float(m["x"]) for m in group) / len(group)
        cy = sum(float(m["y"]) for m in group) / len(group)
        img, x0, y0 = render(args.pdf, (cx - cw / 2, cy - ch / 2, cx + cw / 2, cy + ch / 2), args.ppmm)
        draw_grid(img, x0, y0, args.ppmm, 5.0)
        draw_marks(img, x0, y0, args.ppmm, [dict(m, color="#00a000", r=3.6, label="") for m in extra])
        draw_marks(img, x0, y0, args.ppmm, group)
        canvas = Image.new("RGB", (int(cw * args.ppmm), int(ch * args.ppmm) + 22), "white")
        canvas.paste(img, (0, 22))
        ImageDraw.Draw(canvas).text((4, 2), f"#{index} @({cx:.0f},{cy:.0f})", fill="black", font=font)
        tiles.append(canvas)
    for page_index in range(0, len(tiles), args.per_page):
        chunk = tiles[page_index : page_index + args.per_page]
        rows = (len(chunk) + cols - 1) // cols
        tw, th = chunk[0].size
        sheet = Image.new("RGB", (cols * tw + (cols - 1) * 6, rows * th + (rows - 1) * 6), "#606060")
        for k, tile in enumerate(chunk):
            sheet.paste(tile, ((k % cols) * (tw + 6), (k // cols) * (th + 6)))
        out = Path(f"{args.out_prefix}_{page_index // args.per_page + 1}.png")
        out.parent.mkdir(parents=True, exist_ok=True)
        sheet.save(out)
        print(out, sheet.size, f"groups {page_index + 1}-{page_index + len(chunk)}")


if __name__ == "__main__":
    main()
