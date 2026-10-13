"""DEV ONLY: render detections (+ rooms) of one sheet over its page image for a visual check.

    uv run python -m kamutan_drawing.symbols.debug SHEET.pdf detections.json.gz [rooms.json.gz] OUT.png [--box x0,y0,x1,y1] [--ppm 5]

Boxes are coloured by level (green / orange / red; unknown clusters purple); the label is the
class id (abbreviated) plus annotations. Never used by the worker itself.
"""

from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

LEVEL_RGB = {"green": (0, 160, 0), "yellow": (235, 140, 0), "red": (220, 0, 0)}
ABBREV = (("socket_", "s_"), ("luminaire_", "L_"), ("switch_", "sw_"), ("fixture_", "fx_"))


def _short(cls: str) -> str:
    for a, b in ABBREV:
        cls = cls.replace(a, b)
    return cls


def _ascii(s: str) -> str:
    return s if s.isascii() else ""


def render_overlay(
    page: Image.Image,
    detections: dict[str, Any],
    rooms: dict[str, Any] | None = None,
    *,
    ppm: float,
    origin: tuple[float, float] = (0.0, 0.0),
) -> Image.Image:
    img = page.convert("RGB")
    d = ImageDraw.Draw(img)
    ox, oy = origin

    def px(x: float, y: float) -> tuple[float, float]:
        return ((x - ox) * ppm, (y - oy) * ppm)

    for r in (rooms or {}).get("rooms", []):
        pts = [px(p["x"], p["y"]) for p in r["polygonMm"]]
        if len(pts) >= 3:
            d.line([*pts, pts[0]], fill=(0, 120, 255), width=1)
            cx = sum(p[0] for p in pts) / len(pts)
            cy = sum(p[1] for p in pts) / len(pts)
            d.text((cx, cy), f"{r['id']} {r['areaM2']:.1f}m2", fill=(0, 90, 220))
    for det in detections.get("detections", []):
        b = det["bboxMm"]
        x0, y0 = px(b["x"], b["y"])
        x1, y1 = px(b["x"] + b["w"], b["y"] + b["h"])
        col = (150, 0, 200) if det["class"] == "unknown" else LEVEL_RGB.get(det["level"], (0, 0, 0))
        d.rectangle((x0 - 1, y0 - 1, x1 + 1, y1 + 1), outline=col, width=2)
        ann = " ".join(a for a in (_ascii(a) for a in det.get("annotations", [])) if a and not a.startswith("H="))
        t = det.get("annotations", [])
        typ = next((a.split()[-1] for a in t if a.startswith("סוג")), "")
        d.text((x1 + 2, y0 - 2), f"{_short(det['class'])}{' T' + typ if typ else ''} {ann}".strip(), fill=col)
    return img


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("detections")
    ap.add_argument("rest", nargs="+", help="[rooms.json.gz] OUT.png")
    ap.add_argument("--box", default="")
    ap.add_argument("--ppm", type=float, default=5.0)
    a = ap.parse_args()
    rooms_path, out = (a.rest[0], a.rest[1]) if len(a.rest) > 1 else (None, a.rest[0])
    from ..parse.pdf import PdfPageSource

    src = PdfPageSource.open(a.pdf, 0)
    try:
        x0, y0, x1, y1 = (float(v) for v in a.box.split(",")) if a.box else (0.0, 0.0, src.width_mm, src.height_mm)
        page = src.render(a.ppm, int(x0 * a.ppm), int(y0 * a.ppm), int((x1 - x0) * a.ppm), int((y1 - y0) * a.ppm))
    finally:
        src.close()
    dets = json.loads(gzip.decompress(Path(a.detections).read_bytes()))
    rooms = json.loads(gzip.decompress(Path(rooms_path).read_bytes())) if rooms_path else None
    render_overlay(page, dets, rooms, ppm=a.ppm, origin=(x0, y0)).save(out)
    print(out)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
