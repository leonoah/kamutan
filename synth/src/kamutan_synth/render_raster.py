"""Raster renders of the vector PDF with perturbations (for the input-quality gate and raster work).

Every render records the affine map paper-mm -> pixel (``[[a, b, c], [d, e, f]]``: px = a x + b y + c,
py = d x + e y + f) so the GT can be projected onto it, and the quality issues a correct gate should report.
"""

from __future__ import annotations

import io
import math
import random
from pathlib import Path
from typing import Any

import numpy as np
import pypdfium2 as pdfium
from PIL import Image, ImageDraw, ImageFilter, ImageOps

MAX_PIXELS = 20_000_000

Affine = list[list[float]]


def _mul(a: Affine, b: Affine) -> Affine:
    """a after b (both 2x3)."""
    return [
        [
            a[0][0] * b[0][0] + a[0][1] * b[1][0],
            a[0][0] * b[0][1] + a[0][1] * b[1][1],
            a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2],
        ],
        [
            a[1][0] * b[0][0] + a[1][1] * b[1][0],
            a[1][0] * b[0][1] + a[1][1] * b[1][1],
            a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2],
        ],
    ]


def render_page(pdf_path: Path, dpi: float) -> Image.Image:
    doc = pdfium.PdfDocument(str(pdf_path))
    try:
        page = doc[0]
        img = page.render(scale=dpi / 72.0).to_pil().convert("RGB")
        page.close()
    finally:
        doc.close()
    return img


def make_render(pdf_path: Path, page_mm: tuple[float, float], opts: dict[str, Any], out_path: Path, seed: int) -> dict[str, Any]:
    rng = random.Random(seed)
    W, H = page_mm
    dpi = float(opts["dpi"])
    px = (W / 25.4 * dpi) * (H / 25.4 * dpi)
    if px > MAX_PIXELS:
        dpi = dpi * math.sqrt(MAX_PIXELS / px)
    img = render_page(pdf_path, dpi)
    s = dpi / 25.4
    T: Affine = [[img.width / W, 0.0, 0.0], [0.0, img.height / H, 0.0]]
    del s
    issues: list[dict[str, str]] = []
    if dpi < 100:
        issues.append({"kind": "low_resolution", "detail": f"{dpi:.0f} dpi"})
    if opts.get("blur"):
        img = img.filter(ImageFilter.GaussianBlur(radius=rng.uniform(0.8, 1.6)))
        issues.append({"kind": "blurred"})
    if opts.get("crop"):
        w, h = img.size
        l_ = int(w * rng.uniform(0.0, 0.2))
        t_ = int(h * rng.uniform(0.0, 0.2))
        r_ = int(w * rng.uniform(0.55, 0.8)) if rng.random() < 0.6 else w
        b_ = int(h * rng.uniform(0.6, 0.85)) if r_ == w else h
        img = img.crop((l_, t_, r_, b_))
        T = _mul([[1.0, 0.0, -l_], [0.0, 1.0, -t_]], T)
        issues.append({"kind": "partial_crop"})
    skew = float(opts.get("skew_deg", 0.0))
    if skew:
        w, h = img.size
        img = img.rotate(skew, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=(255, 255, 255))
        c, sn = math.cos(math.radians(skew)), math.sin(math.radians(skew))
        cx, cy, ncx, ncy = w / 2, h / 2, img.width / 2, img.height / 2
        R: Affine = [[c, sn, ncx - c * cx - sn * cy], [-sn, c, ncy + sn * cx - c * cy]]
        T = _mul(R, T)
    if opts.get("mirrored"):
        img = ImageOps.mirror(img)
        T = _mul([[-1.0, 0.0, float(img.width)], [0.0, 1.0, 0.0]], T)
        issues.append({"kind": "mirrored"})
    if opts.get("dark"):
        img = ImageOps.invert(img)
        issues.append({"kind": "dark_background"})
    if opts.get("screenshot"):
        top, left, bottom = rng.randint(50, 90), rng.randint(40, 120), rng.randint(20, 40)
        bg = (40, 44, 52) if opts.get("dark") else (235, 235, 238)
        canvas = Image.new("RGB", (img.width + left, img.height + top + bottom), bg)
        canvas.paste(img, (left, top))
        d = ImageDraw.Draw(canvas)
        fg = (90, 95, 110) if opts.get("dark") else (180, 182, 190)
        for i in range(8):
            d.rectangle((left + 10 + i * 34, 12, left + 36 + i * 34, 38), outline=fg, width=2)
        for i in range(10):
            d.rectangle((8, top + 10 + i * 34, left - 8, top + 34 + i * 34), outline=fg, width=2)
        d.rectangle((0, canvas.height - bottom, canvas.width, canvas.height), fill=fg)
        img = canvas
        T = _mul([[1.0, 0.0, float(left)], [0.0, 1.0, float(top)]], T)
        issues.append({"kind": "screenshot"})
    noise = float(opts.get("noise", 0.0))
    if noise:
        arr = np.asarray(img, dtype=np.int16)
        nrng = np.random.default_rng(seed)
        arr = np.clip(arr + nrng.normal(0.0, noise, arr.shape).round().astype(np.int16), 0, 255).astype(np.uint8)
        img = Image.fromarray(arr, "RGB")
    fmt = opts.get("format", "png")
    buf = io.BytesIO()
    if fmt == "jpg":
        img.save(buf, "JPEG", quality=int(opts.get("jpeg_quality", 75)), optimize=False)
    else:
        img.save(buf, "PNG", optimize=False, compress_level=1)
    out_path.write_bytes(buf.getvalue())
    status = "reject" if any(i["kind"] in ("mirrored",) for i in issues) or dpi < 60 else ("warn" if issues else "ok")
    return {
        "file": out_path.name,
        "dpi": round(dpi, 2),
        "size_px": [img.width, img.height],
        "perturbations": opts,
        "mm_to_px": [[round(v, 6) for v in row] for row in T],
        "expected_quality": {"status": status, "effectiveDpi": round(dpi, 1), "issues": issues},
    }
