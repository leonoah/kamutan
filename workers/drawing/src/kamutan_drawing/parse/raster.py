"""PNG/JPEG sheets (runs inside the sandbox).

* SEC-16: the pixel count is checked from the header *before* decoding (limit 200 MP;
  A0 at 300 dpi is ~139 MP) and Pillow's own bomb guard is set to the same value.
* Paper size: from the file's DPI metadata; without it 300 dpi is assumed (reason added).
* Text: Tesseract (``heb+eng``, TSV word boxes) on the bands where title blocks live
  (bottom 22 %, right 28 %), up-sampled to ``OCR_DPI`` (Stage 10: 200 dpi scans read "ת. חשמל" as Latin noise).
  Everything derived from a raster is capped at "yellow" (``גיליון רסטר``).
* Rules (Stage 10, A-pipeline-06): long horizontal / vertical ink runs become line segments (:meth:`rule_sheet`), so
  the title block's cells and the drawing regions are found as on a vector sheet.
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
OCR_DPI = 400.0  # title-band OCR resolution (up-sampled when the scan is coarser)
RULE_PPM = 8.0  # px per mm for the rule search
RULE_MIN_MM = 4.0  # shortest rule kept (the title block's cell borders)
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

    def ocr_lines(self, rules: Any = None) -> list[dict[str, Any]]:
        """Tesseract lines (paper mm) from the title-block bands. ``rules``: the :meth:`rule_sheet` — a vertical rule
        between two words of one Tesseract line separates two title-block cells."""
        from ..ocr.tess import ocr_words

        W, H = self.img.size
        vrules: list[tuple[float, float, float]] = []  # (x, y0, y1) in source px
        if rules is not None and len(getattr(rules, "segs", ())) > 0:
            k = self.dpi / MM_PER_INCH
            for x0_, y0_, x1_, y1_ in rules.segs.tolist():
                if abs(x1_ - x0_) < 0.05 and abs(y1_ - y0_) >= 4.0:
                    vrules.append((x0_ * k, min(y0_, y1_) * k, max(y0_, y1_) * k))
        f = OCR_DPI / self.dpi if self.dpi < OCR_DPI else min(1.0, OCR_MAX_DPI / self.dpi)
        bands = [(0, int(H * 0.78), W, H), (int(W * 0.72), 0, W, int(H * 0.78))]
        out: list[dict[str, Any]] = []
        for bx0, by0, bx1, by1 in bands:
            crop = self.img.crop((bx0, by0, bx1, by1)).convert("L")
            if f != 1.0:
                crop = crop.resize(
                    (max(1, int(crop.size[0] * f)), max(1, int(crop.size[1] * f))),
                    Image.Resampling.BOX if f < 1.0 else Image.Resampling.LANCZOS,
                )
            groups: dict[tuple[int, int, int], list[Any]] = defaultdict(list)
            for wd in ocr_words(crop, "heb+eng", 11):
                groups[wd.line].append(wd)
            mm = MM_PER_INCH / self.dpi / f
            pieces: list[list[Any]] = []
            for ws in groups.values():
                # Tesseract joins words of neighbouring title-block cells into one line ("שם הפרויקט: … הגיליון:"):
                # a gap wider than ~1.2 line heights starts a new piece
                ws.sort(key=lambda w: w.x0)
                h = max(1, max(w.y1 - w.y0 for w in ws))
                cur = [ws[0]]
                for w in ws[1:]:
                    a = cur[-1]
                    # source px of the gap between the two words (for the rule test)
                    gx0, gx1 = a.x1 / f + bx0, w.x0 / f + bx0
                    gy = ((a.y0 + a.y1) / 2) / f + by0
                    ruled = any(gx0 - 2 <= x <= gx1 + 2 and y0r <= gy <= y1r for x, y0r, y1r in vrules)
                    # a label ends with ':' (read as '.' on scans): in Hebrew order the word left of it is a new cell
                    label_end = w.text.endswith((":", ".")) and len(w.text) > 2
                    if w.x0 - a.x1 > 1.2 * h or ruled or label_end:
                        pieces.append(cur)
                        cur = [w]
                    else:
                        cur.append(w)
                pieces.append(cur)
            for ws in pieces:
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

    def rule_sheet(self, page_index: int = 0) -> Any:
        """A :class:`VectorSheet` holding only the long horizontal / vertical ink runs (≥ ``RULE_MIN_MM``) as line
        segments (paper mm): the title block's cell borders, legend rules, frames, straight walls."""
        import numpy as np
        from scipy import ndimage

        from .vectors import VectorBuilder

        g = self.img.convert("L")
        ppm = g.width / max(self.width_mm, 1e-6)
        if ppm > RULE_PPM:
            f = RULE_PPM / ppm
            g = g.resize((max(1, round(g.width * f)), max(1, round(g.height * f))), Image.Resampling.BOX)
            ppm = g.width / max(self.width_mm, 1e-6)
        ink = np.asarray(g, dtype=np.uint8) < 200
        n = max(3, int(RULE_MIN_MM * ppm))
        b = VectorBuilder()
        for axis, st in ((0, np.ones((1, n), bool)), (1, np.ones((n, 1), bool))):
            op = ndimage.binary_opening(ink, structure=st)
            lab, _ = ndimage.label(op)
            for sl in ndimage.find_objects(lab):
                if sl is None:
                    continue
                ys, xs = sl
                if axis == 0:  # horizontal run: thin in y
                    if ys.stop - ys.start > max(2, int(0.8 * ppm)):
                        continue
                    y = (ys.start + ys.stop) / 2 / ppm
                    b.add(np.array([[xs.start / ppm, y], [xs.stop / ppm, y]]), width_mm=(ys.stop - ys.start) / ppm)
                else:
                    if xs.stop - xs.start > max(2, int(0.8 * ppm)):
                        continue
                    x = (xs.start + xs.stop) / 2 / ppm
                    b.add(np.array([[x, ys.start / ppm], [x, ys.stop / ppm]]), width_mm=(xs.stop - xs.start) / ppm)
        return b.build(page_index, self.width_mm, self.height_mm)
