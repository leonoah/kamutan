"""Approach B — symbol-sized blobs: strip walls / long lines / large fills, keep connected ink groups whose size
fits a legend glyph, and classify each blob by the best glyph response around its centre (a blob is one symbol)."""

from __future__ import annotations

import numpy as np
from scipy import ndimage

from .image import Page
from .legend import Exemplar
from .match import Candidate, ResponseMap, candidate_at

NCC_MIN = 0.8


def blob_boxes(ink: np.ndarray, ppm: float, lo_mm: float, hi_mm: float) -> list[tuple[int, int, int, int]]:
    """(y0, y1, x0, x1) px of ink groups (strokes ≤ 0.4 mm apart joined) whose larger side is in [lo, hi]."""
    joined = ndimage.binary_closing(ink, structure=np.ones((3, 3), bool), iterations=max(1, round(0.2 * ppm)))
    lab, _ = ndimage.label(joined, structure=np.ones((3, 3), bool))
    out = []
    for sl in ndimage.find_objects(lab):
        if sl is None:
            continue
        h, w = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        big = max(h, w) / ppm
        if lo_mm <= big <= hi_mm and min(h, w) / ppm >= 0.3 * lo_mm:
            out.append((sl[0].start, sl[0].stop, sl[1].start, sl[1].stop))
    return out


def find(
    page: Page, exemplars: list[Exemplar], maps: dict[int, ResponseMap], scene_mask: np.ndarray, *, thr: float = NCC_MIN
) -> list[Candidate]:
    ppm = page.ppm
    if not maps:
        return []
    sizes = [max(v.tpl.shape) / ppm for rm in maps.values() for v in rm.variants]
    lo, hi = 0.5 * min(sizes), 1.3 * max(sizes)
    ink = scene_mask  # already stripped by the caller
    pad = round(1.0 * ppm)
    out: list[Candidate] = []
    for y0, y1, x0, x1 in blob_boxes(ink, ppm, lo, hi):
        ranked: list[Candidate] = []
        for rm in maps.values():
            sub = rm.score[max(0, y0 - pad) : y1 + pad, max(0, x0 - pad) : x1 + pad]
            if sub.size == 0:
                continue
            k = int(np.argmax(sub))
            yy, xx = divmod(k, sub.shape[1])
            ranked.append(candidate_at(rm, max(0, y0 - pad) + yy, max(0, x0 - pad) + xx, ppm))
        ranked.sort(key=lambda c: -c.score)
        if not ranked or ranked[0].score < thr:
            continue
        best = ranked[0]
        other = [c.score for c in ranked[1:] if exemplars[c.ex].cls != exemplars[best.ex].cls]
        best.runner_up = other[0] if other else 0.0
        out.append(best)
    return out
