"""Raster page preparation: black-ink mask at a fixed working resolution, long-line / thick-fill removal."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
from PIL import Image
from scipy import ndimage

WORK_PPM = 8.0  # px per mm for the search (≈ 200 dpi)
INK_MAX = 120  # grey level below which a pixel is black ink (grey furniture / hatching ≈ 150–215 is left out)
LONG_LINE_MM = 7.0  # straight runs at least this long are walls / dimension / leader lines, not symbol strokes
THICK_MM = 0.6  # ink thicker than this (both directions) is a wall fill or a solid area


@dataclass
class Page:
    gray: Image.Image  # native resolution, "L"
    native_ppm: float
    ink: np.ndarray  # bool, WORK_PPM
    ppm: float
    width_mm: float
    height_mm: float

    def px(self, mm: float) -> int:
        return max(1, round(mm * self.ppm))

    def native_box(self, box_mm: tuple[float, float, float, float]) -> tuple[int, int, int, int]:
        f = self.native_ppm
        return (int(box_mm[0] * f), int(box_mm[1] * f), int(box_mm[2] * f) + 1, int(box_mm[3] * f) + 1)


def load_page(img: Image.Image, width_mm: float) -> Page:
    gray = img.convert("L")
    native = gray.width / max(width_mm, 1e-6)
    g = np.asarray(gray, dtype=np.uint8)
    ink = (g < INK_MAX).astype(np.float32)
    w = max(1, round(gray.width * WORK_PPM / native))
    h = max(1, round(gray.height * WORK_PPM / native))
    if abs(native - WORK_PPM) > 0.05:
        small = np.asarray(Image.fromarray(ink).resize((w, h), Image.Resampling.BOX))
        mask = small > 0.3  # a 1 px line at 300 dpi keeps ~0.6 coverage after the box filter
    else:
        mask = ink > 0
    return Page(gray, native, mask, WORK_PPM, width_mm, gray.height / native)


def _line_se(length: int, angle_deg: float) -> np.ndarray:
    """Binary line structuring element (odd size) at an angle."""
    n = length | 1
    se = np.zeros((n, n), bool)
    c = n // 2
    t = np.linspace(-c, c, 2 * n)
    a = np.deg2rad(angle_deg)
    xs = np.clip(np.round(c + t * np.cos(a)).astype(int), 0, n - 1)
    ys = np.clip(np.round(c - t * np.sin(a)).astype(int), 0, n - 1)
    se[ys, xs] = True
    return se


def long_lines(
    ink: np.ndarray, ppm: float, length_mm: float = LONG_LINE_MM, angles: tuple[int, ...] = (0, 45, 90, 135)
) -> np.ndarray:
    """Pixels on straight runs ≥ ``length_mm`` (openings with line elements at a few angles)."""
    L = max(5, round(length_mm * ppm))
    out = np.zeros_like(ink)
    for a in angles:
        if a % 90 == 0:
            se = np.ones((1, L), bool) if a % 180 == 0 else np.ones((L, 1), bool)
        else:
            se = _line_se(int(L / np.sqrt(2)) + 1, a)
        out |= ndimage.binary_opening(ink, structure=se)
    return out


def thick_ink(ink: np.ndarray, ppm: float, thick_mm: float = THICK_MM) -> np.ndarray:
    k = max(2, round(thick_mm * ppm))
    return ndimage.binary_opening(ink, structure=np.ones((k, k), bool))


def strip_structure(ink: np.ndarray, ppm: float) -> np.ndarray:
    """Ink minus walls / long lines / large solid fills; what is left is symbols, text, hatching and short strokes."""
    lines = long_lines(ink, ppm)
    thick = thick_ink(ink, ppm)
    # small solid parts (a filled half-disc of a power socket, an arrow head) are kept: only large fills go
    lab, n = ndimage.label(thick)
    if n:
        sizes = ndimage.sum(np.ones_like(lab), lab, index=np.arange(1, n + 1))
        big = np.zeros(n + 1, bool)
        big[1:] = sizes > (3.5 * ppm) ** 2
        thick = big[lab]
    rm = ndimage.binary_dilation(lines | thick, structure=np.ones((3, 3), bool))
    return ink & ~rm


def text_mask(ink: np.ndarray, ppm: float) -> np.ndarray:
    """Pixels of components that sit in a run of ≥ 3 similar-sized components on one line (horizontal or vertical
    text: room names, dimensions, H=…). A lone symbol next to a "2X" has at most one such neighbour."""
    from scipy.spatial import cKDTree

    lab, n = ndimage.label(ink, structure=np.ones((3, 3), bool))
    if n == 0:
        return np.zeros_like(ink)
    objs = ndimage.find_objects(lab)
    idx, cy, cx, hh, ww = [], [], [], [], []
    for k, o in enumerate(objs, start=1):
        if o is None:
            continue
        h, w = (o[0].stop - o[0].start) / ppm, (o[1].stop - o[1].start) / ppm
        if 0.8 <= max(h, w) <= 4.5:
            idx.append(k)
            cy.append((o[0].start + o[0].stop) / 2 / ppm)
            cx.append((o[1].start + o[1].stop) / 2 / ppm)
            hh.append(h)
            ww.append(w)
    if len(idx) < 3:
        return np.zeros_like(ink)
    pts = np.c_[cx, cy]
    tree = cKDTree(pts)
    is_text = np.zeros(n + 1, bool)
    raw: Any = tree.query_ball_point(pts, 4.5)  # one index list per point (stub types it loosely)
    neighbours: list[list[int]] = [list(nb) for nb in raw]
    for i, nb in enumerate(neighbours):
        for axis in (0, 1):  # 0: horizontal line (same y, compare heights); 1: vertical line (same x, widths)
            size = hh[i] if axis == 0 else ww[i]
            other = [
                j
                for j in nb
                if j != i
                and abs(pts[j][1 - axis] - pts[i][1 - axis]) <= 0.3 * size
                and 0.7 <= (hh[j] if axis == 0 else ww[j]) / max(size, 1e-6) <= 1.45
                and abs(pts[j][axis] - pts[i][axis]) <= 1.6 * size
            ]
            if len(other) >= 2 or (other and any(is_text[idx[j]] for j in other)):
                is_text[idx[i]] = True
                break
    return np.asarray(is_text[lab])
