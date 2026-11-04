"""Approach A — legend-crop template matching over the whole sheet with a rotation (45°, mirrored when the glyph
is not symmetric) × scale (estimated once per sheet) search: every local maximum of a glyph's response map above
``NCC_MIN`` is a candidate."""

from __future__ import annotations

from .image import Page
from .legend import Exemplar
from .match import Candidate, ResponseMap, candidate_at, peaks

NCC_MIN = 0.8


def find(page: Page, exemplars: list[Exemplar], maps: dict[int, ResponseMap], *, thr: float = NCC_MIN) -> list[Candidate]:
    out: list[Candidate] = []
    for ex, rm in maps.items():
        win = max(3, int(0.6 * min(min(v.tpl.shape) for v in rm.variants)))
        for y, x, _ in peaks(rm.score, thr, win):
            out.append(candidate_at(rm, y, x, page.ppm))
        del ex
    return out
