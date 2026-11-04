"""Legend rows on a raster sheet → symbol exemplars (pixel crops) with an OCR'd label and a suggested class.

The ruled legend table is found from long horizontal ink runs (same table finder as the vector path). Each band
between two rules is one row; Tesseract (``heb``) reads the row and every ink component that is not covered by a
Hebrew word is a symbol part. Symbol parts are grouped left-to-right; the Hebrew words between a symbol and the
next symbol to its left are its label (RTL: label left of symbol). A symbol whose crop contains another symbol of
the same legend (e.g. "2X" + socket next to the plain socket) becomes a *qualified* member of that glyph's family.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from itertools import pairwise

import numpy as np
from PIL import Image
from scipy import ndimage

from ..legend.classes import RULES, norm_label
from ..legend.classes import suggest_class as _suggest
from ..legend.parse import Legend, LegendEntry, LegendResult
from ..legend.tables import Table, find_tables_segs
from ..ocr.textutil import levenshtein
from .image import Page

BBox = tuple[float, float, float, float]
_HEB = re.compile(r"[א-ת]")
MIN_GLYPH_MM = (2.0, 2.4)  # (smaller, larger side): type numbers / letters in a types table are not symbols
_QUAL = re.compile(r"([23])\s*[XxאX×]")


@dataclass
class Exemplar:
    entry: LegendEntry
    mask: np.ndarray  # bool crop at the page's working resolution (symbol pixels only)
    base: int | None = None  # index of the exemplar whose glyph this one carries plus a qualifier ("2X")
    core: tuple[int, int, int, int] | None = None  # (y0, y1, x0, x1) of the base glyph inside ``mask``
    members: list[int] = field(default_factory=list)  # qualified members of this glyph (indices)
    negative: bool = False  # a legend marker without a class ("ראה הערה", "אביזר מוגן מים"): suppresses look-alikes

    @property
    def usable(self) -> bool:
        return bool(self.entry.suggested_class) or self.negative

    @property
    def cls(self) -> str | None:
        return self.entry.suggested_class

    @property
    def glyph(self) -> np.ndarray:
        if self.core is None:
            return self.mask
        y0, y1, x0, x1 = self.core
        return self.mask[y0:y1, x0:x1]


def _hsegs(ink: np.ndarray, ppm: float, min_mm: float = 25.0) -> np.ndarray:
    L = max(3, int(min_mm * ppm))
    op = ndimage.binary_opening(ink, structure=np.ones((1, L), bool))
    lab, _ = ndimage.label(op)
    out = []
    for sl in ndimage.find_objects(lab):
        if sl is None:
            continue
        ys, xs = sl
        if ys.stop - ys.start > max(2, int(0.6 * ppm)):
            continue
        y = (ys.start + ys.stop - 1) / 2 / ppm
        out.append((xs.start / ppm, y, (xs.stop - 1) / ppm, y))
    return np.asarray(out, dtype=np.float64).reshape(-1, 4)


def _ocr_band(page: Page, box_mm: BBox) -> list[tuple[str, float, BBox]]:
    """Hebrew-ish words of one legend row: (text, conf 0..1, bbox mm)."""
    try:
        from ..ocr.tess import ocr_words
    except ImportError:  # pragma: no cover
        return []
    x0, y0, x1, y1 = page.native_box(box_mm)
    crop = page.gray.crop((x0, y0, x1, y1))
    if crop.width < 8 or crop.height < 8:
        return []
    s = max(1.0, 64.0 / crop.height)
    big = crop.resize((int(crop.width * s), int(crop.height * s)), Image.Resampling.LANCZOS) if s > 1 else crop
    try:
        words = ocr_words(big, "heb", 7)
    except (OSError, RuntimeError, ValueError):
        return []
    f = s * page.native_ppm
    out = []
    for w in words:
        out.append(
            (w.text, w.conf / 100.0, (box_mm[0] + w.x0 / f, box_mm[1] + w.y0 / f, box_mm[0] + w.x1 / f, box_mm[1] + w.y1 / f))
        )
    return out


def is_marker(label: str) -> bool:
    """The label is one of the no-class legend rows (markers / routing), not an unread label."""
    t = _correct(label)
    for r in RULES:
        if all(k in t for k in r.keywords):
            return not r.cls
    return False


_VOCAB = sorted({w for r in RULES for k in r.keywords for w in k.split() if len(w) >= 3})


def _correct(label: str) -> str:
    """OCR slips on raster labels: a word one edit away from a class keyword word becomes that word."""
    out = []
    for w in norm_label(label).split():
        if len(w) >= 3 and w not in _VOCAB:
            best = [v for v in _VOCAB if abs(len(v) - len(w)) <= 1 and levenshtein(v, w) <= 1]
            if len(best) == 1:
                w = best[0]
        out.append(w)
    return " ".join(out)


def suggest_class(label: str, conf: float) -> tuple[str | None, float]:
    """The label as read wins; the corrected reading only fills a gap or turns a row into a no-class marker
    ("אביזר מגן מים" → marker, not an outdoor luminaire)."""
    cls, c = _suggest(label, conf)
    fixed = _correct(label)
    if fixed == norm_label(label):
        return cls, c
    if is_marker(label):
        return None, 0.0
    if cls is None:
        return _suggest(fixed, conf * 0.9)
    return cls, c


def _ocr_label(page: Page, box_mm: BBox) -> tuple[str, float]:
    try:
        from ..ocr.tess import ocr_words
    except ImportError:  # pragma: no cover
        return "", 0.0
    x0, y0, x1, y1 = page.native_box(box_mm)
    crop = page.gray.crop((x0, y0, x1, y1))
    if crop.width < 8 or crop.height < 8:
        return "", 0.0
    s = max(1.0, 56.0 / crop.height)
    big = crop.resize((int(crop.width * s), int(crop.height * s)), Image.Resampling.LANCZOS)
    a = np.asarray(big, dtype=np.uint8)
    a = np.where(a < 150, 0, 255).astype(np.uint8)
    pad = np.full((a.shape[0] + 40, a.shape[1] + 40), 255, np.uint8)
    pad[20:-20, 20:-20] = a
    try:
        words = ocr_words(Image.fromarray(pad), "heb", 7)
    except (OSError, RuntimeError, ValueError):
        return "", 0.0
    words = sorted((w for w in words if _HEB.search(w.text)), key=lambda w: -w.x1)
    if not words:
        return "", 0.0
    return " ".join(w.text for w in words), float(np.mean([w.conf for w in words]) / 100.0)


def _signature(mask: np.ndarray) -> str:
    small = np.asarray(Image.fromarray(mask.astype(np.uint8) * 255).resize((8, 8), Image.Resampling.BOX)) > 40
    bits = "".join("1" if v else "0" for v in small.ravel())
    return hashlib.sha256(f"r2|{bits}".encode()).hexdigest()[:16]


def _table_rows(page: Page, t: Table) -> list[tuple[float, float]]:
    ys = sorted(t.rule_ys)
    return [(a, b) for a, b in pairwise(ys) if b - a >= 3.0]


def find_exemplars(page: Page, *, title_block: BBox | None = None) -> tuple[LegendResult, list[Exemplar]]:
    ink, ppm = page.ink, page.ppm
    tables = find_tables_segs(_hsegs(ink, ppm), exclude=[title_block] if title_block else None)
    res = LegendResult()
    exemplars: list[Exemplar] = []
    n = 0
    for ti, t in enumerate(tables):
        bx0, by0, bx1, by1 = t.bbox
        X0, X1 = max(0, int(bx0 * ppm) - 2), min(ink.shape[1], int(bx1 * ppm) + 3)
        Y0, Y1 = max(0, int(by0 * ppm) - int(4 * ppm)), min(ink.shape[0], int(by1 * ppm) + int(4 * ppm))
        sub = ink[Y0:Y1, X0:X1].copy()
        # rules (long horizontals) and table borders / column separators (long verticals) out
        hr = ndimage.binary_opening(sub, structure=np.ones((1, int(20 * ppm)), bool))
        vr = ndimage.binary_opening(sub, structure=np.ones((int(9 * ppm), 1), bool))
        rm = hr | vr
        keep = sub & ~rm
        # give back rule pixels where a symbol stroke crosses the rule (ink right above and below, or left and right)
        above = np.zeros_like(keep)
        below = np.zeros_like(keep)
        left = np.zeros_like(keep)
        right = np.zeros_like(keep)
        for k in range(1, 4):
            above[k:] |= keep[:-k]
            below[:-k] |= keep[k:]
            left[:, k:] |= keep[:, :-k]
            right[:, :-k] |= keep[:, k:]
        sub = keep | (hr & above & below) | (vr & ~hr & left & right)
        lab, _ = ndimage.label(sub, structure=np.ones((3, 3), bool))
        objs = ndimage.find_objects(lab)
        comps = []  # (label id, y0, y1, x0, x1) in page px
        for k, o in enumerate(objs, start=1):
            if o is None:
                continue
            comps.append((k, o[0].start + Y0, o[0].stop + Y0, o[1].start + X0, o[1].stop + X0))
        entries: list[LegendEntry] = []
        lid = f"lg{len(res.legends)}"
        rows: list[
            tuple[list[tuple[str, float, BBox]], list[tuple[list[tuple[int, int, int, int, int]], int, int, int, int]]]
        ] = []
        for ya, yb in _table_rows(page, t):
            r0, r1 = ya * ppm, yb * ppm
            row = [c for c in comps if r0 <= (c[1] + c[2]) / 2 <= r1]
            if not row:
                continue
            words = _ocr_band(page, (bx0, ya + 0.3, bx1, yb - 0.3))
            heb = [w for w in words if len(_HEB.findall(w[0])) >= 2 and w[1] >= 0.3]
            if not heb:
                continue  # spacer band between two legend rows
            hh = [c[2] - c[1] for c in row]
            text_h = float(np.median(hh)) if hh else 0.0

            def in_word(
                c: tuple[int, int, int, int, int], heb: list[tuple[str, float, BBox]] = heb, text_h: float = text_h
            ) -> bool:
                cx, cy = (c[3] + c[4]) / 2 / ppm, (c[1] + c[2]) / 2 / ppm
                if c[2] - c[1] > 1.7 * text_h and c[2] - c[1] > 3.6 * ppm:
                    return False  # clearly taller than the text: a symbol even if the OCR box covers it
                return any(w[2][0] - 0.3 <= cx <= w[2][2] + 0.3 and w[2][1] - 0.6 <= cy <= w[2][3] + 0.6 for w in heb)

            sym = sorted((c for c in row if not in_word(c)), key=lambda c: c[3])
            clusters: list[list[tuple[int, int, int, int, int]]] = []
            for c in sym:
                if clusters and c[3] - max(q[4] for q in clusters[-1]) < 1.2 * ppm:
                    clusters[-1].append(c)
                else:
                    clusters.append([c])
            boxes = []
            for cl in clusters:
                y0, y1 = min(c[1] for c in cl), max(c[2] for c in cl)
                x0, x1 = min(c[3] for c in cl), max(c[4] for c in cl)
                if max(y1 - y0, x1 - x0) < MIN_GLYPH_MM[1] * ppm or min(y1 - y0, x1 - x0) < MIN_GLYPH_MM[0] * ppm:
                    continue  # dots, apostrophes, OCR leftovers
                boxes.append((cl, y0, y1, x0, x1))
            rows.append((heb, boxes))
        # symbols stand in columns: keep clusters whose right edge or centre lines up with >= 2 others
        allb = [bx for _, bxs in rows for bx in bxs]
        tol = 2.5 * ppm

        def aligned(
            bx: tuple[list[tuple[int, int, int, int, int]], int, int, int, int],
            allb: list[tuple[list[tuple[int, int, int, int, int]], int, int, int, int]] = allb,
            tol: float = tol,
        ) -> bool:
            c = (bx[3] + bx[4]) / 2
            nr = sum(1 for o in allb if o is not bx and abs(o[4] - bx[4]) <= tol)
            nc = sum(1 for o in allb if o is not bx and abs((o[3] + o[4]) / 2 - c) <= tol)
            return max(nr, nc) >= 2

        for heb, bxs in rows:
            boxes = [bx for bx in bxs if aligned(bx)]
            for i, (cl, y0, y1, x0, x1) in enumerate(boxes):
                lim = boxes[i - 1][4] if i > 0 else int(bx0 * ppm)
                lw = [w for w in heb if w[2][0] * ppm >= lim - 2 and w[2][2] * ppm <= x0 + 2]
                lw.sort(key=lambda w: -w[2][0])
                label = " ".join(w[0] for w in lw)
                conf = float(np.mean([w[1] for w in lw])) if lw else 0.0
                ids = {c[0] for c in cl}
                m = np.isin(lab[y0 - Y0 : y1 - Y0, x0 - X0 : x1 - X0], list(ids))
                cls, cconf = suggest_class(label, conf) if label else (None, 0.0)
                if lw:  # second reading: the label crop alone, binarised with a white margin
                    lb0 = (min(w[2][0] for w in lw) - 0.4, y0 / ppm, max(w[2][2] for w in lw) + 0.4, y1 / ppm)
                    l2, c2 = _ocr_label(page, lb0)
                    k2, kc2 = suggest_class(l2, c2) if l2 else (None, 0.0)
                    if k2 is not None and (cls is None or kc2 > cconf):
                        label, conf, cls, cconf = l2, c2, k2, kc2
                qual = ""
                q = _QUAL.search(label)
                if q:
                    qual = f"{q.group(1)}X"
                lb = (
                    (min(w[2][0] for w in lw), min(w[2][1] for w in lw), max(w[2][2] for w in lw), max(w[2][3] for w in lw))
                    if lw
                    else None
                )
                e = LegendEntry(
                    n=n,
                    legend_id=lid,
                    kind="symbol",
                    symbol_bbox=(x0 / ppm, y0 / ppm, x1 / ppm, y1 / ppm),
                    label_bbox=lb,
                    label=label,
                    label_conf=round(conf, 3),
                    qualifier=qual,
                    suggested_class=cls,
                    class_conf=cconf,
                    signature=_signature(m),
                )
                n += 1
                entries.append(e)
                exemplars.append(Exemplar(e, m, negative=cls is None and is_marker(label)))
        if len(entries) >= 3:
            res.legends.append(Legend(lid, "symbols", t.bbox, "מקרא", 0.6, entries))
        else:
            exemplars = [x for x in exemplars if x.entry not in entries]
        del ti
    _link_families(exemplars)
    return res, exemplars


def _ncc_inside(small: np.ndarray, big: np.ndarray) -> tuple[float, int, int]:
    """Best normalised correlation of ``small`` slid inside ``big`` (both bool, small fits)."""
    from scipy.signal import correlate

    a = ndimage.gaussian_filter(small.astype(np.float64), 0.8)
    b = ndimage.gaussian_filter(big.astype(np.float64), 0.8)
    h, w = a.shape
    if h > b.shape[0] or w > b.shape[1]:
        return 0.0, 0, 0
    a0 = a - a.mean()
    num = correlate(b, a0, mode="valid", method="fft")
    ones = np.ones_like(a)
    s1 = correlate(b, ones, mode="valid", method="fft")
    s2 = correlate(b * b, ones, mode="valid", method="fft")
    var = np.maximum(s2 - s1 * s1 / a.size, 1e-9)
    m = num / (np.sqrt(var) * (np.sqrt((a0 * a0).sum()) or 1.0))
    k = int(np.argmax(m))
    y, x = divmod(k, m.shape[1])
    return float(m[y, x]), y, x


def _link_families(ex: list[Exemplar]) -> None:
    """A symbol crop that contains another legend symbol (+ text) is a qualified member of that glyph."""
    for i, a in enumerate(ex):
        for j, b in enumerate(ex):
            if i == j or b.base is not None:
                continue
            ha, wa = a.mask.shape
            hb, wb = b.mask.shape
            if hb > ha + 2 or wb > wa + 2 or hb * wb > 0.8 * ha * wa or hb * wb < 0.3 * ha * wa:
                continue
            v, y, x = _ncc_inside(b.mask, a.mask)
            if v >= 0.75:
                a.base, a.core = j, (y, y + hb, x, x + wb)
                b.members.append(i)
                if not a.entry.qualifier:
                    a.entry.qualifier = "2X" if a.cls in ("socket_double", "socket_power_double") else "Q"
                break
