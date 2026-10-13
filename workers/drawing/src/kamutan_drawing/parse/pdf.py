"""PDF pages with pypdfium2 (runs inside the sandbox).

Security (SEC-17): forms are never initialised (``init_forms`` is not called), so no
JavaScript, actions or form appearance streams run; embedded files and links are never
opened. Only geometry, the text layer and the rendered pixels are used.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
from PIL import Image

from .. import errors as E
from ..errors import IngestError
from ..ingest.pdf_vector import PT_TO_MM, VectorSheet, _page_to_mm, extract_page

MAX_PAGES = 100
MAX_PAGE_MM = 5000.0
MAX_SEGMENTS = 6_000_000


def open_pdf(path: str) -> pdfium.PdfDocument:
    try:
        return pdfium.PdfDocument(path)
    except pdfium.PdfiumError as e:
        msg = str(e).lower()
        if "password" in msg or "security" in msg:
            raise IngestError(E.FILE_ENCRYPTED, "PDF is password protected") from None
        raise IngestError(E.FILE_UNREADABLE, "PDF could not be opened") from None


def probe(path: str) -> list[dict[str, Any]]:
    doc = open_pdf(path)
    try:
        n = len(doc)
        if n == 0:
            raise IngestError(E.FILE_UNREADABLE, "PDF has no pages")
        if n > MAX_PAGES:
            raise IngestError(E.TOO_MANY_PAGES, f"PDF has more than {MAX_PAGES} pages")
        pages = []
        for i in range(n):
            pg = doc[i]
            try:
                w, h = pg.get_width() * PT_TO_MM, pg.get_height() * PT_TO_MM
                if max(w, h) > MAX_PAGE_MM or min(w, h) <= 1:
                    raise IngestError(E.PAGE_TOO_LARGE, "PDF page size is out of range")
                pages.append({"index": i, "widthMm": round(w, 3), "heightMm": round(h, 3), "rotation": pg.get_rotation() % 360})
            finally:
                pg.close()
        return pages
    finally:
        doc.close()


@dataclass
class PdfPageSource:
    doc: pdfium.PdfDocument
    page: pdfium.PdfPage
    index: int
    width_mm: float
    height_mm: float
    rotation: int

    @classmethod
    def open(cls, path: str, index: int) -> PdfPageSource:
        doc = open_pdf(path)
        if not 0 <= index < len(doc):
            raise IngestError(E.FILE_UNREADABLE, "PDF page out of range")
        page = doc[index]
        return cls(doc, page, index, page.get_width() * PT_TO_MM, page.get_height() * PT_TO_MM, page.get_rotation() % 360)

    def close(self) -> None:
        self.page.close()
        self.doc.close()

    def vectors(self) -> VectorSheet:
        vs = extract_page(self.page, self.index)
        if vs.n_segs > MAX_SEGMENTS:
            raise IngestError(E.TOO_COMPLEX, "PDF page has too many vector segments")
        return vs

    def render(self, px_per_mm: float, x0: int, y0: int, w: int, h: int) -> Image.Image:
        """Pixels [x0, x0+w) x [y0, y0+h) of the page rendered at ``px_per_mm`` (rotation applied)."""
        full_w = max(1, round(self.width_mm * px_per_mm))
        full_h = max(1, round(self.height_mm * px_per_mm))
        bmp = pdfium.PdfBitmap.new_native(w, h, format=pdfium_c.FPDFBitmap_BGR, rev_byteorder=True)
        bmp.fill_rect((255, 255, 255, 255), 0, 0, w, h)
        flags = pdfium_c.FPDF_ANNOT | pdfium_c.FPDF_REVERSE_BYTE_ORDER
        pdfium_c.FPDF_RenderPageBitmap(bmp.raw, self.page.raw, -x0, -y0, full_w, full_h, 0, flags)
        img = bmp.to_pil().convert("RGB")
        bmp.close()
        return img

    def text_layer(self) -> list[dict[str, Any]]:
        """Real text objects (TrueType etc.) as lines in paper mm; empty for SHX-only drawings."""
        to_mm, _, _ = _page_to_mm(self.page)
        out: list[dict[str, Any]] = []
        try:
            tp = self.page.get_textpage()
        except pdfium.PdfiumError:
            return out
        try:
            n = tp.count_rects()
            for i in range(min(n, 20000)):
                l, b, r, t = tp.get_rect(i)
                txt = " ".join(tp.get_text_bounded(l, b, r, t).split())
                if not txt:
                    continue
                pts = np.array([[l, b, 1.0], [r, t, 1.0], [l, t, 1.0], [r, b, 1.0]]) @ to_mm.T
                x0, y0 = pts[:, 0].min(), pts[:, 1].min()
                x1, y1 = pts[:, 0].max(), pts[:, 1].max()
                vertical = (y1 - y0) > 2.5 * (x1 - x0) and len(txt) > 2
                out.append(
                    {
                        "text": txt,
                        "bboxMm": [round(float(v), 3) for v in (x0, y0, x1, y1)],
                        "angle": 90.0 if vertical else 0.0,
                        "heightMm": round(float((x1 - x0) if vertical else (y1 - y0)), 3),
                        "confidence": 0.95,
                    }
                )
        finally:
            tp.close()
        return out
