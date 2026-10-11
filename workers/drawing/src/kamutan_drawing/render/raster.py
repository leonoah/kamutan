"""Raster rendering with pypdfium2: full pages, mm-region crops, and 256px tiles.

Coordinates for regions are paper mm (origin top-left, y down), consistent with
:mod:`kamutan_drawing.ingest.pdf_vector`.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import pypdfium2 as pdfium
from PIL import Image

MM_PER_INCH = 25.4
TILE_SIZE = 256


def _open(pdf: str | Path | pdfium.PdfDocument) -> tuple[pdfium.PdfDocument, bool]:
    if isinstance(pdf, pdfium.PdfDocument):
        return pdf, False
    return pdfium.PdfDocument(str(pdf)), True


def render_page(
    pdf: str | Path | pdfium.PdfDocument,
    page_index: int = 0,
    dpi: float = 150,
    grayscale: bool = False,
) -> Image.Image:
    doc, owned = _open(pdf)
    try:
        page = doc[page_index]
        bmp = page.render(scale=dpi / 72.0, grayscale=grayscale, fill_color=(255, 255, 255, 255))
        img = bmp.to_pil()
        page.close()
        return img.convert("L" if grayscale else "RGB")
    finally:
        if owned:
            doc.close()


def render_region(
    pdf: str | Path | pdfium.PdfDocument,
    region_mm: tuple[float, float, float, float],
    page_index: int = 0,
    dpi: float = 400,
    grayscale: bool = True,
) -> Image.Image:
    """Render only ``region_mm`` = (x0, y0, x1, y1) in paper mm (y down).

    Uses pdfium's crop margins, so memory is proportional to the region, not the page.
    Assumes /Rotate == 0 (true for the sample set); rotated pages fall back to a
    full render + crop.
    """
    doc, owned = _open(pdf)
    try:
        page = doc[page_index]
        x0, y0, x1, y1 = region_mm
        if page.get_rotation() % 360 == 0:
            cx0, cy0, cx1, cy1 = page.get_cropbox()
            pw, ph = cx1 - cx0, cy1 - cy0
            k = 72.0 / MM_PER_INCH
            left = max(0.0, x0 * k)
            right = max(0.0, pw - x1 * k)
            top = max(0.0, y0 * k)
            bottom = max(0.0, ph - y1 * k)
            bmp = page.render(
                scale=dpi / 72.0,
                crop=(left, bottom, right, top),
                grayscale=grayscale,
                fill_color=(255, 255, 255, 255),
            )
            img = bmp.to_pil()
        else:  # pragma: no cover
            full = page.render(scale=dpi / 72.0, grayscale=grayscale).to_pil()
            f = dpi / MM_PER_INCH
            img = full.crop((int(x0 * f), int(y0 * f), int(math.ceil(x1 * f)), int(math.ceil(y1 * f))))
        page.close()
        return img.convert("L" if grayscale else "RGB")
    finally:
        if owned:
            doc.close()


@dataclass
class TileManifest:
    width_px: int
    height_px: int
    tile_size: int
    dpi: float
    mm_per_px: float
    cols: int
    rows: int
    fmt: str

    def to_json(self) -> str:
        return json.dumps(self.__dict__, indent=2)


def render_tiles(
    pdf: str | Path | pdfium.PdfDocument,
    out_dir: str | Path,
    page_index: int = 0,
    dpi: float = 150,
    tile_size: int = TILE_SIZE,
    fmt: str = "png",
) -> TileManifest:
    """Render the page once at ``dpi`` and cut it into ``tile_size`` tiles.

    Files: ``{out_dir}/{col}_{row}.{fmt}`` + ``manifest.json``. Edge tiles are
    smaller than ``tile_size`` (not padded) so the pixel grid is exact.
    For A0 at 300dpi the decision table (§2 #12) requires region-wise rendering;
    use :func:`render_region` per tile band for that case.
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    img = render_page(pdf, page_index, dpi=dpi)
    W, H = img.size
    cols = math.ceil(W / tile_size)
    rows = math.ceil(H / tile_size)
    for r in range(rows):
        for c in range(cols):
            box = (c * tile_size, r * tile_size, min(W, (c + 1) * tile_size), min(H, (r + 1) * tile_size))
            img.crop(box).save(out / f"{c}_{r}.{fmt}")
    man = TileManifest(
        width_px=W,
        height_px=H,
        tile_size=tile_size,
        dpi=dpi,
        mm_per_px=MM_PER_INCH / dpi,
        cols=cols,
        rows=rows,
        fmt=fmt,
    )
    (out / "manifest.json").write_text(man.to_json())
    return man
