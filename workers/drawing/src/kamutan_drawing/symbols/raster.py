"""Raster fallback (PNG / JPEG sheets): legend + symbol spotting on pixels, capped at yellow.

Same idea as the vector path, on a binarised image at ``WORK_PPM`` px/mm:

1. long horizontal ink runs (morphological opening) → the ruled legend table
   (:func:`kamutan_drawing.legend.tables.find_tables_segs`);
2. rows between rules; ink components larger than the text are symbols, lined up in columns;
   the label left of each symbol is read with Tesseract (``heb``);
3. each symbol crop is a template; normalised cross-correlation (FFT) over the drawing at four
   rotations (and mirrored), peaks above ``NCC_MIN``, non-maximum suppression across templates.

Every detection carries the "רסטר" reason and is never green (brief: rasters capped at yellow).
"""

from __future__ import annotations

import hashlib
import math
from typing import Any

import numpy as np
from PIL import Image
from scipy import ndimage

from ..legend.classes import suggest_class
from ..legend.parse import Legend, LegendEntry, LegendResult
from ..legend.tables import find_tables_segs
from ..ocr.dictionary import TextSpan
from .detect import R_RASTER, Detection, DetectResult, score_detection
from .geometry import BBox

WORK_PPM = 5.0  # px per mm for the raster search
NCC_MIN = 0.75
MAX_HITS_PER_TEMPLATE = 40  # more hits than this: the drawing is too plain to tell anything apart
MAX_TEMPLATES = 40


def _binarise(img: Image.Image, width_mm: float) -> tuple[np.ndarray, float]:
    """Ink mask at ``WORK_PPM``: thresholded at the native resolution, then max-pooled-ish (a thin
    1 px line at 300 dpi must survive the downscale)."""
    g = np.asarray(img.convert("L"), dtype=np.uint8)
    ink = (g < 160).astype(np.uint8) * 255
    ppm = img.width / max(width_mm, 1e-6)
    m = Image.fromarray(ink)
    if abs(ppm - WORK_PPM) > 0.5:
        m = m.resize(
            (max(1, round(img.width * WORK_PPM / ppm)), max(1, round(img.height * WORK_PPM / ppm))), Image.Resampling.BOX
        )
        ppm = WORK_PPM
    return np.asarray(m) > 40, ppm


def _hlines(ink: np.ndarray, ppm: float) -> np.ndarray:
    """Long horizontal ink runs as segments (mm)."""
    L = max(3, int(25.0 * ppm))
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


def _ocr_label(img_gray: Image.Image, box_px: tuple[int, int, int, int]) -> tuple[str, float]:
    try:
        from ..ocr.tess import ocr_words
    except ImportError:  # pragma: no cover
        return "", 0.0
    crop = img_gray.crop(box_px)
    if crop.width < 4 or crop.height < 4:
        return "", 0.0
    scale = max(1.0, 48.0 / max(crop.height, 1))
    if scale > 1.0:
        crop = crop.resize((int(crop.width * scale), int(crop.height * scale)), Image.Resampling.LANCZOS)
    try:
        words = ocr_words(crop, "heb", 7)
    except (OSError, RuntimeError, ValueError):  # tesseract missing / failed: no label, lower confidence
        return "", 0.0
    words = sorted(words, key=lambda w: -w.x1)
    if not words:
        return "", 0.0
    return " ".join(w.text for w in words), float(np.mean([w.conf for w in words]) / 100.0)


class _Correlator:
    """NCC of many templates against one scene: the scene FFT and its integral images are cached."""

    def __init__(self, scene: np.ndarray, max_t: int) -> None:
        self.scene = scene
        H, W = scene.shape
        self.shape = (H + max_t, W + max_t)
        self.F = np.fft.rfft2(scene, self.shape)
        self.ii = np.pad(scene.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
        self.ii2 = np.pad((scene * scene).cumsum(0).cumsum(1), ((1, 0), (1, 0)))

    def _box(self, ii: np.ndarray, th: int, tw: int) -> np.ndarray:
        return np.asarray(ii[th:, tw:] - ii[:-th, tw:] - ii[th:, :-tw] + ii[:-th, :-tw])

    def ncc(self, tpl: np.ndarray) -> np.ndarray:
        """Map of NCC values ('valid' region, top-left anchored)."""
        th, tw = tpl.shape
        H, W = self.scene.shape
        t = tpl - tpl.mean()
        tn = math.sqrt(float((t * t).sum())) or 1.0
        full = np.fft.irfft2(self.F * np.fft.rfft2(t[::-1, ::-1], self.shape), self.shape)
        num = full[th - 1 : H, tw - 1 : W]
        s1 = self._box(self.ii, th, tw)
        s2 = self._box(self.ii2, th, tw)
        var = np.maximum(s2 - s1 * s1 / (th * tw), 1e-6)
        return np.asarray(num / (np.sqrt(var) * tn))


def _signature(tpl: np.ndarray, label: str) -> str:
    small = np.asarray(Image.fromarray((tpl * 255).astype(np.uint8)).resize((8, 8), Image.Resampling.BOX)) > 40
    bits = "".join("1" if v else "0" for v in small.ravel())
    return hashlib.sha256(f"r1|{bits}".encode()).hexdigest()[:16]


def detect_raster(
    img: Image.Image,
    spans: list[TextSpan],
    *,
    width_mm: float,
    regions: list[dict[str, Any]] | None = None,
    scale_den: int | None = None,
    discipline: str | None = None,
    title_block: BBox | None = None,
) -> DetectResult:
    res = DetectResult()
    ink, ppm = _binarise(img, width_mm)
    gray = img.convert("L")  # labels are read at the native resolution
    native = img.width / max(width_mm, 1e-6)

    def nat(box: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
        f = native / ppm
        return (int(box[0] * f), int(box[1] * f), int(box[2] * f), int(box[3] * f))

    tables = find_tables_segs(_hlines(ink, ppm), exclude=[title_block] if title_block else None)
    legend = LegendResult()
    templates: list[tuple[LegendEntry, np.ndarray]] = []
    n = 0
    rules_mask = ndimage.binary_dilation(
        ndimage.binary_opening(ink, structure=np.ones((1, max(3, int(25.0 * ppm))), bool)), structure=np.ones((3, 1), bool)
    )
    for t in tables:
        lid = f"lg{len(legend.legends)}"
        entries: list[LegendEntry] = []
        x0, x1 = int(t.bbox[0] * ppm) + 2, int(t.bbox[2] * ppm) - 2
        ty0, ty1 = max(0, int(t.bbox[1] * ppm) - int(3 * ppm)), int(t.bbox[3] * ppm) + int(3 * ppm)
        rm = rules_mask[ty0:ty1, x0:x1]
        tab = ink[ty0:ty1, x0:x1] & ~rm
        # give back rule pixels where a symbol crosses the rule (ink right above and right below)
        above = np.zeros_like(tab)
        below = np.zeros_like(tab)
        for k in range(1, 5):
            above[k:] |= tab[:-k]
            below[:-k] |= tab[k:]
        tab |= rm & above & below & ink[ty0:ty1, x0:x1]
        lab, _ = ndimage.label(tab, structure=np.ones((3, 3), bool))
        objs = [
            (o[0].start + ty0, o[0].stop + ty0, o[1].start + x0, o[1].stop + x0)
            for o in ndimage.find_objects(lab)
            if o is not None
        ]
        if not objs:
            continue
        th = float(np.percentile([o[1] - o[0] for o in objs], 75))  # letter height (dots and accents are smaller)
        # symbols: clearly larger than the text, lined up in columns (≥ 2 rows per column)
        big = [o for o in objs if max(o[1] - o[0], o[3] - o[2]) > 1.45 * th and (o[1] - o[0]) > 1.1 * th]
        if len(big) < 2:
            continue
        xs = sorted(big, key=lambda o: (o[2] + o[3]) / 2)
        cols: list[list[tuple[int, int, int, int]]] = [[xs[0]]]
        for o in xs[1:]:
            if (o[2] + o[3]) / 2 - (cols[-1][-1][2] + cols[-1][-1][3]) / 2 > 6 * ppm:
                cols.append([o])
            else:
                cols[-1].append(o)
        cols = [c for c in cols if len(c) >= 2]
        col_ranges = sorted((min(o[2] for o in c), max(o[3] for o in c)) for c in cols)
        bands = list(zip(t.rule_ys[:-1], t.rule_ys[1:], strict=True))
        for ya, yb in bands:
            r0, r1 = int(ya * ppm), int(yb * ppm)
            prev = x0
            for c0, c1 in col_ranges:
                mem = [o for o in big if c0 <= (o[2] + o[3]) / 2 <= c1 and r0 <= (o[0] + o[1]) / 2 <= r1]
                if not mem:
                    prev = c1
                    continue
                # re-attach pieces cut by the rule removal (objects overlapping the symbol's columns)
                sy0, sy1 = min(o[0] for o in mem), max(o[1] for o in mem)
                sx0, sx1 = min(o[2] for o in mem), max(o[3] for o in mem)
                for o in objs:
                    ov = min(sx1, o[3]) - max(sx0, o[2])
                    if ov > 0.5 * (o[3] - o[2]) and o[1] >= sy0 - 3 and o[0] <= sy1 + 3:
                        sy0, sy1, sx0, sx1 = min(sy0, o[0]), max(sy1, o[1]), min(sx0, o[2]), max(sx1, o[3])
                lab_objs = [o for o in objs if prev < o[2] and o[3] < sx0 - 1 and r0 <= (o[0] + o[1]) / 2 <= r1]
                prev = c1
                if not lab_objs:
                    continue
                lab_x0, lab_x1 = min(o[2] for o in lab_objs) - 2, max(o[3] for o in lab_objs) + 2
                lab_y0, lab_y1 = min(o[0] for o in lab_objs) - 2, max(o[1] for o in lab_objs) + 2
                label, conf = _ocr_label(gray, nat((lab_x0, lab_y0, lab_x1, lab_y1)))
                cls, cconf = suggest_class(label, conf)
                tpl = ink[sy0:sy1, sx0:sx1].astype(np.float64)
                if tpl.size < 16:
                    continue
                e = LegendEntry(
                    n=n,
                    legend_id=lid,
                    kind="symbol",
                    symbol_bbox=(sx0 / ppm, sy0 / ppm, sx1 / ppm, sy1 / ppm),
                    label_bbox=(lab_x0 / ppm, lab_y0 / ppm, lab_x1 / ppm, lab_y1 / ppm),
                    label=label,
                    label_conf=round(conf, 3),
                    suggested_class=cls,
                    class_conf=cconf,
                    signature=_signature(tpl, label),
                )
                entries.append(e)
                templates.append((e, tpl))
                n += 1
        if len(entries) >= 3:
            legend.legends.append(Legend(lid, "symbols", t.bbox, "מקרא", 0.6, entries))
        else:
            templates = [tp for tp in templates if tp[0] not in entries]
    res.legend = legend
    if not templates:
        return res
    scene = ink.astype(np.float64)
    for b in legend.exclusion_boxes() + ([title_block] if title_block else []):
        scene[max(0, int(b[1] * ppm)) : int(b[3] * ppm) + 1, max(0, int(b[0] * ppm)) : int(b[2] * ppm) + 1] = 0.0
    found: list[tuple[float, LegendEntry, BBox, int]] = []
    usable = [(e, t) for e, t in templates[:MAX_TEMPLATES] if e.suggested_class is not None]
    if not usable:
        return res
    corr = _Correlator(scene, max(max(t.shape) for _, t in usable) + 1)
    for e, tpl in usable:
        variants: list[tuple[np.ndarray, int]] = [(np.rot90(tpl, k), 90 * k) for k in range(4)]
        mirrored = tpl[:, ::-1]
        if mirrored.shape == tpl.shape and float(np.abs(mirrored - tpl).mean()) > 0.05:
            variants += [(np.rot90(mirrored, k), 90 * k) for k in range(4)]
        for tv, ang in variants:
            if tv.shape[0] >= scene.shape[0] or tv.shape[1] >= scene.shape[1] or tv.std() == 0:
                continue
            m = corr.ncc(tv)
            peaks = (m >= NCC_MIN) & (m == ndimage.maximum_filter(m, size=max(3, int(0.6 * min(tv.shape)))))
            for y, x in zip(*np.nonzero(peaks), strict=True):
                b = (x / ppm, y / ppm, (x + tv.shape[1]) / ppm, (y + tv.shape[0]) / ppm)
                found.append((float(m[y, x]), e, b, ang))
    per: dict[int, int] = {}
    for f in found:
        per[id(f[1])] = per.get(id(f[1]), 0) + 1
    found = [f for f in found if per[id(f[1])] <= MAX_HITS_PER_TEMPLATE * 8]  # 8 orientations
    found.sort(key=lambda q: -q[0])
    kept: list[tuple[float, LegendEntry, BBox, int]] = []
    for f in found:
        cx, cy = (f[2][0] + f[2][2]) / 2, (f[2][1] + f[2][3]) / 2
        if any(
            math.hypot(cx - (k[2][0] + k[2][2]) / 2, cy - (k[2][1] + k[2][3]) / 2)
            < 0.5 * max(f[2][2] - f[2][0], f[2][3] - f[2][1])
            for k in kept
        ):
            continue
        kept.append(f)
    from .detect import _region_of

    per_kept: dict[int, int] = {}
    for f in kept:
        per_kept[id(f[1])] = per_kept.get(id(f[1]), 0) + 1
    kept = [f for f in kept if per_kept[id(f[1])] <= MAX_HITS_PER_TEMPLATE]

    for i, (v, e, b, ang) in enumerate(kept):
        c = ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)
        d = Detection(
            cls=e.suggested_class or "unknown",
            center=c,
            bbox=b,
            angle=ang,
            entry=e,
            quality=min(1.0, v),
            margin=0.3,
            source="raster",
            class_conf=e.class_conf,
            reasons=[R_RASTER],
        )
        r = _region_of(c, regions or []) if regions else None
        d.in_region = r is not None or not regions
        d.floor = (r or {}).get("floor") if r else None
        score_detection(d, raster=True, scale_uncertain=scale_den is None, confirmed=False)
        d.id = f"d_{i}"
        res.detections.append(d)
    res.stats = {"templates": len(templates), "candidates": len(found)}
    return res
