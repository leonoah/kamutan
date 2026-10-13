"""PNG/JPEG sheets (runs inside the sandbox).

* SEC-16: the pixel count is checked from the header *before* decoding (limit 200 MP;
  A0 at 300 dpi is ~139 MP) and Pillow's own bomb guard is set to the same value.
* Paper size: from the file's DPI metadata; without it 300 dpi is assumed (reason added).
* Text: Tesseract (``heb+eng``, TSV word boxes) on the bands where title blocks live
  (bottom 22 %, right 28 %). Everything derived from a raster is capped at "yellow".
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from PIL import Image

from .. import errors as E
from ..errors import IngestError

MAX_PIXELS = 200_000_000
DEFAULT_DPI = 300.0
LOW_DPI = 150.0
OCR_MAX_DPI = 300.0
MM_PER_INCH = 25.4


def _open_checked(path: str) -> Image.Image:
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        img = Image.open(path)
    except Image.DecompressionBombError:
        raise IngestError(E.IMAGE_TOO_LARGE, f"image exceeds {MAX_PIXELS // 1_000_000} MP") from None
    except (OSError, ValueError, SyntaxError):
        raise IngestError(E.FILE_UNREADABLE, "image could not be read") from None
    w, h = img.size
    if w * h > MAX_PIXELS:
        raise IngestError(E.IMAGE_TOO_LARGE, f"image exceeds {MAX_PIXELS // 1_000_000} MP")
    if w < 16 or h < 16:
        raise IngestError(E.FILE_UNREADABLE, "image is too small")
    if img.format not in ("PNG", "JPEG"):
        raise IngestError(E.UNSUPPORTED_FORMAT, "only PNG and JPEG rasters are supported")
    return img


def probe(path: str) -> list[dict[str, Any]]:
    src = RasterSource.open(path, load=False)
    return [{"index": 0, "widthMm": round(src.width_mm, 3), "heightMm": round(src.height_mm, 3), "rotation": 0}]


@dataclass
class RasterSource:
    img: Image.Image
    dpi: float
    dpi_known: bool
    width_mm: float
    height_mm: float
    notes: list[str] = field(default_factory=list)

    @classmethod
    def open(cls, path: str, *, load: bool = True) -> RasterSource:
        img = _open_checked(path)
        dpi_info = img.info.get("dpi")
        dpi, known = DEFAULT_DPI, False
        if isinstance(dpi_info, tuple) and dpi_info and 20 <= float(dpi_info[0]) <= 1200:
            # snapped to an integer: the tiles contract stores an integer dpi (pHYs gives 299.9994)
            dpi, known = float(round(float(dpi_info[0]))), True
        if load:
            try:
                img.load()
            except (OSError, ValueError, Image.DecompressionBombError):
                raise IngestError(E.FILE_UNREADABLE, "image could not be decoded") from None
            img = img.convert("RGB")
        w, h = img.size
        return cls(img=img, dpi=dpi, dpi_known=known, width_mm=w / dpi * MM_PER_INCH, height_mm=h / dpi * MM_PER_INCH)

    def render(self, px_per_mm: float, x0: int, y0: int, w: int, h: int) -> Image.Image:
        f = px_per_mm * MM_PER_INCH / self.dpi  # output px per source px
        box = (x0 / f, y0 / f, (x0 + w) / f, (y0 + h) / f)
        W, H = self.img.size
        if abs(f - 1.0) < 1e-9:
            out = Image.new("RGB", (w, h), (255, 255, 255))
            out.paste(self.img.crop((x0, y0, min(W, x0 + w), min(H, y0 + h))), (0, 0))
            return out
        cb = (max(0.0, box[0]), max(0.0, box[1]), min(float(W), box[2]), min(float(H), box[3]))
        out = Image.new("RGB", (w, h), (255, 255, 255))
        if cb[2] > cb[0] and cb[3] > cb[1]:
            tw = max(1, min(w, round((cb[2] - cb[0]) * f)))
            th = max(1, min(h, round((cb[3] - cb[1]) * f)))
            part = self.img.resize((tw, th), Image.Resampling.BOX if f < 1 else Image.Resampling.BILINEAR, box=cb)
            out.paste(part, (0, 0))
        return out

    def ocr_lines(self) -> list[dict[str, Any]]:
        """Tesseract lines (paper mm) from the title-block bands."""
        from ..ocr.tess import ocr_words

        W, H = self.img.size
        f = min(1.0, OCR_MAX_DPI / self.dpi)
        bands = [(0, int(H * 0.78), W, H), (int(W * 0.72), 0, W, int(H * 0.78))]
        out: list[dict[str, Any]] = []
        for bx0, by0, bx1, by1 in bands:
            crop = self.img.crop((bx0, by0, bx1, by1)).convert("L")
            if f < 1.0:
                crop = crop.resize((max(1, int(crop.size[0] * f)), max(1, int(crop.size[1] * f))), Image.Resampling.BOX)
            groups: dict[tuple[int, int, int], list[Any]] = defaultdict(list)
            for wd in ocr_words(crop, "heb+eng", 11):
                groups[wd.line].append(wd)
            mm = MM_PER_INCH / self.dpi / f
            for ws in groups.values():
                ws.sort(key=lambda w: -w.x1)  # Hebrew reading order: right to left
                x0 = min(w.x0 for w in ws) / f + bx0
                y0 = min(w.y0 for w in ws) / f + by0
                x1 = max(w.x1 for w in ws) / f + bx0
                y1 = max(w.y1 for w in ws) / f + by0
                conf = sum(w.conf for w in ws) / len(ws) / 100.0
                out.append(
                    {
                        "text": " ".join(w.text for w in ws),
                        "bboxMm": [
                            round(x0 * MM_PER_INCH / self.dpi, 3),
                            round(y0 * MM_PER_INCH / self.dpi, 3),
                            round(x1 * MM_PER_INCH / self.dpi, 3),
                            round(y1 * MM_PER_INCH / self.dpi, 3),
                        ],
                        "angle": 0.0,
                        "heightMm": round((y1 - y0) * mm * f, 3),
                        "confidence": round(conf, 3),
                    }
                )
        return out
