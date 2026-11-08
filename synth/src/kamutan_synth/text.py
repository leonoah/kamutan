"""Text: bidi (logical -> visual), fonts (TTF text / TTF outlines / our stroke font), measuring.

Three text modes, chosen per sheet:
* ``ttf``     - real PDF text objects (a text layer) in a legal Hebrew TTF (DejaVu Sans, Liberation Sans, FreeSans);
* ``outline`` - the same TTF glyphs exported as filled vector outlines (no text layer, like "text as geometry" PDFs);
* ``stroke``  - our own single-stroke font (``strokefont``), drawn as polylines like AutoCAD SHX text.

Strings are kept in *logical* order everywhere; renderers call :func:`to_visual` (PDF draws glyphs left to right).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from fontTools.pens.basePen import BasePen
from fontTools.ttLib import TTFont

from . import strokefont

Pt = tuple[float, float]

# name -> (candidate paths, licence). All three carry Hebrew glyphs and allow embedding / redistribution.
TTF_FONTS: dict[str, tuple[tuple[str, ...], str]] = {
    "DejaVuSans": (
        ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans.ttf"),
        "Bitstream Vera / DejaVu licence (free, embedding and redistribution allowed)",
    ),
    "LiberationSans": (
        (
            "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
            "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
            "/usr/share/fonts/liberation-sans/LiberationSans-Regular.ttf",
        ),
        "SIL Open Font License 1.1",
    ),
    "FreeSans": (
        ("/usr/share/fonts/truetype/freefont/FreeSans.ttf", "/usr/share/fonts/gnu-free/FreeSans.ttf"),
        "GNU GPL v3 with the font exception (embedding in documents allowed)",
    ),
}

_HEB = re.compile(r"[֐-׿]")
_LTR_RUN = re.compile(r"[0-9A-Za-zØ±](?:[0-9A-Za-zØ.=,:/+%×\-]*[0-9A-Za-zØ])?")
_MIRROR = str.maketrans("()[]{}<>", ")(][}{><")


def has_hebrew(s: str) -> bool:
    return bool(_HEB.search(s))


def to_visual(logical: str) -> str:
    """Logical -> visual (left-to-right glyph) order for a single line.

    A line with Hebrew is an RTL paragraph: the order of runs is reversed, Hebrew/neutral runs are reversed
    character-wise (brackets mirrored) and digit/Latin runs (``H=110``, ``2X``, ``1:50``, ``Ø20``) keep their order.
    """
    if not has_hebrew(logical):
        return logical
    parts: list[str] = []
    pos = 0
    for m in _LTR_RUN.finditer(logical):
        if m.start() > pos:
            parts.append(logical[pos : m.start()][::-1].translate(_MIRROR))
        parts.append("\x00" + m.group(0))
        pos = m.end()
    if pos < len(logical):
        parts.append(logical[pos:][::-1].translate(_MIRROR))
    return "".join(p.removeprefix("\x00") for p in reversed(parts))


def available_ttf() -> dict[str, str]:
    """Installed legal TTFs with Hebrew: name -> path."""
    out: dict[str, str] = {}
    for name, (paths, _lic) in TTF_FONTS.items():
        for p in paths:
            if Path(p).is_file():
                out[name] = p
                break
    return out


class _FlatPen(BasePen):
    """Flattens glyph outlines into closed polygons (font units)."""

    def __init__(self, glyphset: object) -> None:
        super().__init__(glyphset)
        self.contours: list[list[Pt]] = []
        self._cur: list[Pt] = []

    def _moveTo(self, pt: Pt) -> None:
        self._cur = [pt]

    def _lineTo(self, pt: Pt) -> None:
        self._cur.append(pt)

    def _curveToOne(self, p1: Pt, p2: Pt, p3: Pt) -> None:
        p0 = self._cur[-1]
        for i in range(1, 5):
            t = i / 4
            a = (1 - t) ** 3
            b = 3 * (1 - t) ** 2 * t
            c = 3 * (1 - t) * t * t
            d = t**3
            self._cur.append((a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]))

    def _qCurveToOne(self, p1: Pt, p2: Pt) -> None:
        p0 = self._cur[-1]
        for i in range(1, 4):
            t = i / 3
            a = (1 - t) ** 2
            b = 2 * (1 - t) * t
            c = t * t
            self._cur.append((a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1]))

    def _closePath(self) -> None:
        if len(self._cur) > 2:
            self.contours.append(self._cur)
        self._cur = []

    def _endPath(self) -> None:
        self._closePath()


@dataclass
class TTFMetrics:
    name: str
    path: str
    upem: int
    cap: float  # cap height as a fraction of the em
    widths: dict[str, float]  # char -> advance in em
    outlines: dict[str, list[list[Pt]]]  # char -> contours in em units (y up)


@lru_cache(maxsize=8)
def ttf_metrics(name: str, path: str) -> TTFMetrics:
    f = TTFont(path, lazy=True)
    upem = int(f["head"].unitsPerEm)
    os2 = f["OS/2"]
    cap = float(getattr(os2, "sCapHeight", 0) or 0.72 * upem) / upem
    return TTFMetrics(name, path, upem, cap, {}, {})


_TTF_HANDLES: dict[str, TTFont] = {}


def _ttf(path: str) -> TTFont:
    f = _TTF_HANDLES.get(path)
    if f is None:
        f = TTFont(path)
        _TTF_HANDLES[path] = f
    return f


def _char_info(m: TTFMetrics, ch: str) -> tuple[float, list[list[Pt]]]:
    if ch in m.widths:
        return m.widths[ch], m.outlines[ch]
    f = _ttf(m.path)
    cmap = f.getBestCmap()
    gname = cmap.get(ord(ch)) or cmap.get(ord("?"), ".notdef")
    gs = f.getGlyphSet()
    pen = _FlatPen(gs)
    gs[gname].draw(pen)
    adv = float(f["hmtx"][gname][0]) / m.upem
    contours = [[(x / m.upem, y / m.upem) for x, y in c] for c in pen.contours]
    m.widths[ch] = adv
    m.outlines[ch] = contours
    return adv, contours


@dataclass(frozen=True)
class FontSpec:
    mode: str  # ttf | outline | stroke
    ttf_name: str = "DejaVuSans"
    ttf_path: str = ""
    width_factor: float = 1.0  # stroke font only (narrow CAD fonts ~0.8)

    def metrics(self) -> TTFMetrics:
        return ttf_metrics(self.ttf_name, self.ttf_path)


def text_width(visual: str, h: float, font: FontSpec) -> float:
    """Width in mm of a visual-order string of cap height ``h``."""
    if font.mode == "stroke":
        return strokefont.advance(visual) * h * font.width_factor
    m = font.metrics()
    size = h / m.cap
    return sum(_char_info(m, c)[0] for c in visual) * size


def stroke_polylines(visual: str, h: float, font: FontSpec) -> list[list[Pt]]:
    """Polylines of the stroke font in a local frame: origin at the baseline start, x right, y DOWN (paper)."""
    out: list[list[Pt]] = []
    x = 0.0
    wf = font.width_factor
    for c in visual:
        adv, strokes = strokefont.glyph(c)
        for s in strokes:
            out.append([(x + px * h * wf, -py * h) for px, py in s])
        x += (adv + 0.08) * h * wf
    return out


def outline_glyphs(visual: str, h: float, font: FontSpec) -> list[list[list[Pt]]]:
    """Per glyph, its contours (non-zero winding) in the same local frame as :func:`stroke_polylines`."""
    m = font.metrics()
    size = h / m.cap
    out: list[list[list[Pt]]] = []
    x = 0.0
    for c in visual:
        adv, contours = _char_info(m, c)
        if contours:
            out.append([[(x + px * size, -py * size) for px, py in cont] for cont in contours])
        x += adv * size
    return out


def anchor_offset(width: float, h: float, align: str, valign: str) -> Pt:
    """Offset of the baseline start from the anchor point (local, y down)."""
    dx = {"l": 0.0, "c": -width / 2, "r": -width}[align]
    dy = {"b": 0.0, "m": h / 2, "t": h}[valign]
    return dx, dy


def text_corners(pos: Pt, width: float, h: float, angle: float, align: str, valign: str) -> list[Pt]:
    """Four corners (paper mm, y down) of the text box incl. a 0.3 h descender band."""
    dx, dy = anchor_offset(width, h, align, valign)
    ca, sa = math.cos(math.radians(angle)), math.sin(math.radians(angle))
    pts = [(dx, dy + 0.3 * h), (dx + width, dy + 0.3 * h), (dx + width, dy - 1.05 * h), (dx, dy - 1.05 * h)]
    return [(pos[0] + x * ca + y * sa, pos[1] - x * sa + y * ca) for x, y in pts]
