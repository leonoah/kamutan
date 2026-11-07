"""Height marks the SHX glyph reader cannot read: rotated "U.K=75 / O.K=210" beside an opening, "H=140" split from
its note (Sprint 7, Worker-Accuracy item 3).

Openings carry their sill / head as AutoCAD text written along the wall ("U.K=75" = sill 0.75 m, "O.K=210" = head
2.10 m; the basement door "0.K=210"). That text is usually vertical, and the glyph reader (:mod:`kamutan_drawing.ocr`)
reads rotated words as horizontal noise ("= L N", "סכ"). Here, per *anchor* (an opening closure line, a door closure
wall run, a low wall / screen without a read height) the dark, text-sized strokes in a box around it are rendered
alone (walls, hatches and grey glazing drop out), turned 0° / 90° / 270°, and read by Tesseract with a character
whitelist ``UOKH.=0123456789``. Marks:

* ``U.K=nn`` → sill ``sill_m``; ``O.K=nnn`` (also ``0.K``) → head ``head_m``; ``H=nnn`` → ``h_m``; values in cm,
  10–420 accepted;
* a box whose readings disagree (two different heads, two different H) gives no mark (two openings side by side).

Pure apart from the Tesseract subprocess; a missing / failing Tesseract gives no marks (callers keep the assumed
heights and their reasons). ``ocr`` (tests) = ``(image, psm) -> text``.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw

from ..ingest.pdf_vector import VectorSheet

log = logging.getLogger(__name__)

PX_PER_MM = 30
PAD_MM = 12.0  # the mark sits beside the opening / wall (≤ 11 mm on the sample)
TEXT_MAX_MM = 3.5  # a glyph path is at most this big
DARK_MAX = 100  # text pens are black / dark; glazing hatches and grid lines are grey (201)
MIN_SEGS = 8  # fewer strokes in the box hold no mark
MAX_ANCHORS = 12  # per sheet (3 Tesseract calls each, ≈ 0.3 s per call)
ROTATIONS = (0, 270, 90)
WHITELIST = "UOKH.=0123456789"
CM_RANGE = (10, 420)

OcrFn = Callable[[Image.Image, int], str]

_UK = re.compile(r"U\.?\s*K\.?\s*=\s*(\d{2,3})")
_OK = re.compile(r"(?<![0-9])[O0]\.?\s*K\.?\s*=\s*(\d{2,3})")
_H = re.compile(r"(?<![A-Z])H\s*=\s*(\d{2,3})")


@dataclass
class Marks:
    sill_m: float | None = None
    head_m: float | None = None
    h_m: float | None = None
    text: str = ""

    @property
    def opening_m(self) -> float | None:
        """Opening height: head − sill (a door has no sill mark: from the floor)."""
        if self.head_m is None:
            return None
        h = self.head_m - (self.sill_m or 0.0)
        return round(h, 3) if h > 0.1 else None

    @property
    def empty(self) -> bool:
        return self.sill_m is None and self.head_m is None and self.h_m is None


def _cm(v: str) -> float | None:
    n = int(v)
    return n / 100.0 if CM_RANGE[0] <= n <= CM_RANGE[1] else None


def parse_marks(text: str) -> Marks:
    """Marks of one OCR text (all rotations of one box joined); conflicting values → that mark is dropped."""
    t = text.upper().replace(",", ".")

    def one(rx: re.Pattern[str]) -> float | None:
        vals = {v for m in rx.finditer(t) if (v := _cm(m.group(1))) is not None}
        return next(iter(vals)) if len(vals) == 1 else None

    return Marks(one(_UK), one(_OK), one(_H), " ".join(text.split())[:120])


def _text_segments(vs: VectorSheet) -> np.ndarray:
    """Mask over ``vs.segs``: strokes of small dark paths (glyph strokes)."""
    if vs.n_paths == 0:
        return np.zeros(0, bool)
    bb = vs.path_bbox
    ext = np.maximum(bb[:, 2] - bb[:, 0], bb[:, 3] - bb[:, 1])
    dark = vs.path_stroke_rgba[:, :3].astype(int).max(axis=1) < DARK_MAX
    ok = (ext <= TEXT_MAX_MM) & dark & vs.path_stroked
    return np.asarray(ok[vs.seg_path], bool)


def _render(s: np.ndarray, box: tuple[float, float, float, float], rot: int) -> Image.Image:
    x0, y0, x1, y1 = box
    w, h = int((x1 - x0) * PX_PER_MM) + 40, int((y1 - y0) * PX_PER_MM) + 40
    img = Image.new("L", (w, h), 255)
    dr = ImageDraw.Draw(img)
    for a, b, c, d in s.tolist():
        dr.line([((a - x0) * PX_PER_MM + 20, (b - y0) * PX_PER_MM + 20), ((c - x0) * PX_PER_MM + 20, (d - y0) * PX_PER_MM + 20)],
                fill=0, width=4)  # fmt: skip
    return img.rotate(rot, expand=True, fillcolor=255) if rot else img


def _tesseract(img: Image.Image, psm: int) -> str:
    from ..ocr.tess import run_tesseract

    return run_tesseract(img, "eng", psm, ["-c", f"tessedit_char_whitelist={WHITELIST}"])


def read_marks(
    vs: VectorSheet,
    anchors: Sequence[tuple[float, float, float, float]],
    *,
    ocr: OcrFn | None = None,
    pad: float = PAD_MM,
) -> list[Marks]:
    """One :class:`Marks` per anchor bbox (x0, y0, x1, y1 paper mm), in order; empty marks when nothing is read."""
    out = [Marks() for _ in anchors]
    if not anchors or vs.n_segs == 0:
        return out
    read = ocr or _tesseract
    mask = _text_segments(vs)
    segs = vs.segs
    lo_x, hi_x = np.minimum(segs[:, 0], segs[:, 2]), np.maximum(segs[:, 0], segs[:, 2])
    lo_y, hi_y = np.minimum(segs[:, 1], segs[:, 3]), np.maximum(segs[:, 1], segs[:, 3])
    for k, (ax0, ay0, ax1, ay1) in enumerate(anchors[:MAX_ANCHORS]):
        box = (ax0 - pad, ay0 - pad, ax1 + pad, ay1 + pad)
        m = mask & (lo_x >= box[0]) & (hi_x <= box[2]) & (lo_y >= box[1]) & (hi_y <= box[3])
        if int(m.sum()) < MIN_SEGS:
            continue
        s = segs[m]
        texts: list[str] = []
        for rot in ROTATIONS:
            try:
                texts.append(read(_render(s, box, rot), 6))
            except Exception:
                log.warning("height-mark OCR failed", exc_info=True)
                return out
        out[k] = parse_marks("\n".join(texts))
        if out[k].empty:  # Sprint 8 (Worker-LLM) hook — keep: unparsed box → llm_gateway.hard_text (no-op when off)
            out[k] = _llm_mark(s, box) or out[k]
    return out


def _llm_mark(s: np.ndarray, box: tuple[float, float, float, float]) -> Marks | None:
    """The page's LLM session (``llm_gateway.hard_text``): pass 1 records the stroke render as a ``mark`` crop,
    pass 2 returns its reading. None when no session is active (the default) or nothing usable was read."""
    from ..llm_gateway import hard_text

    sess = hard_text.current()
    if sess is None:
        return None
    txt = sess.mark(box, _render(s, box, 0))
    if not txt:
        return None
    mk = parse_marks(txt)
    return None if mk.empty else mk
