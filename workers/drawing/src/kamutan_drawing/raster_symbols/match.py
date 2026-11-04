"""Shared matching machinery: template bank (rotations × scale), normalised cross-correlation, NMS, qualifiers."""

from __future__ import annotations

import importlib
import math
import re
from dataclasses import dataclass
from typing import Any

import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.signal import fftconvolve

from .image import Page
from .legend import Exemplar

BLUR_PX = 1.0
ANGLE_STEP = 45  # degrees: plan symbols follow the walls (0 / 45 / 90°); the blur tolerates ≈ ±10°
_QUAL_RE = re.compile(r"(?<![0-9])([23])\s*[Xx×]")


def cv2_module() -> Any | None:
    """OpenCV if installed (optional: ~20× faster template matching); the scipy fallback gives the same maps."""
    try:
        return importlib.import_module("cv2")
    except ImportError:
        return None


def blur(a: np.ndarray) -> np.ndarray:
    return np.asarray(ndimage.gaussian_filter(a.astype(np.float32), BLUR_PX), dtype=np.float32)


def ncc_map(scene: np.ndarray, tpl: np.ndarray) -> np.ndarray:
    """Zero-mean normalised cross-correlation, 'valid' region (top-left anchored), float32 inputs."""
    cv2 = cv2_module()
    if cv2 is not None:
        return np.asarray(cv2.matchTemplate(scene, tpl, cv2.TM_CCOEFF_NORMED))
    th, tw = tpl.shape
    t = tpl - tpl.mean()
    tn = float(np.sqrt((t * t).sum())) or 1.0
    num = fftconvolve(scene, t[::-1, ::-1], mode="valid")
    k = np.ones((th, tw), np.float32)
    s1 = fftconvolve(scene, k, mode="valid")
    s2 = fftconvolve(scene * scene, k, mode="valid")
    var = np.maximum(s2 - s1 * s1 / (th * tw), 1e-6)
    return np.asarray(num / (np.sqrt(var) * tn), dtype=np.float32)


def rotate_mask(m: np.ndarray, angle: float, scale: float, mirror: bool = False) -> np.ndarray:
    """Rotated / scaled copy of a bool mask on a square canvas (the diagonal), as float32 0..1."""
    a = m[:, ::-1] if mirror else m
    img = Image.fromarray(a.astype(np.uint8) * 255)
    if abs(scale - 1.0) > 1e-3:
        img = img.resize((max(2, round(img.width * scale)), max(2, round(img.height * scale))), Image.Resampling.BILINEAR)
    d = math.ceil(math.hypot(img.width, img.height)) + 2
    canvas = Image.new("L", (d, d), 0)
    canvas.paste(img, ((d - img.width) // 2, (d - img.height) // 2))
    r = canvas.rotate(angle, resample=Image.Resampling.BILINEAR)
    out = np.asarray(r, dtype=np.float32) / 255.0
    ys, xs = np.nonzero(out > 0.2)
    if len(ys) == 0:
        return out
    return np.asarray(out[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1])


def is_symmetric_mirror(m: np.ndarray) -> bool:
    f = m[:, ::-1]
    return float(np.abs(blur(f) - blur(m)).mean()) < 0.03 or float(np.abs(blur(m[::-1]) - blur(m)).mean()) < 0.03


@dataclass
class Variant:
    ex: int  # exemplar index
    angle: int
    mirror: bool
    tpl: np.ndarray  # blurred float32
    ink_share: float = 0.0  # share of the template box that is ink (before the blur)


def rotation_period(m: np.ndarray) -> int:
    """90 / 180 / 360: smallest rotation that maps the glyph onto itself (circle + cross → 90)."""
    b = blur(m)
    for p in (90, 180):
        r = blur(rotate_mask(m, p, 1.0) > 0.3)
        if r.shape == b.shape and float(np.abs(r - b).mean()) < 0.03:
            return p
    return 360


def build_bank(exemplars: list[Exemplar], scale: float, *, step: int = ANGLE_STEP) -> list[Variant]:
    bank: list[Variant] = []
    for i, x in enumerate(exemplars):
        if x.base is not None or not x.usable:
            continue  # qualified members are found through their base glyph; unread labels are left out
        g = x.glyph
        mirrors = (False,) if is_symmetric_mirror(g) else (False, True)
        period = rotation_period(g)
        for mi in mirrors:
            for a in range(0, period, step):
                t = rotate_mask(g, a, scale, mi)
                if t.shape[0] < 4 or t.shape[1] < 4 or t.std() == 0:
                    continue
                bank.append(Variant(i, a, mi, blur(t), float((t > 0.3).mean())))
    return bank


@dataclass
class Candidate:
    ex: int
    score: float
    center: tuple[float, float]  # mm
    size: tuple[float, float]  # mm (w, h) of the posed template
    angle: int
    runner_up: float = 0.0  # best score of a different glyph at the same place


def peaks(m: np.ndarray, thr: float, win: int) -> list[tuple[int, int, float]]:
    if m.size == 0:
        return []
    mx = ndimage.maximum_filter(m, size=max(3, win))
    ys, xs = np.nonzero((m >= thr) & (m == mx))
    return [(int(y), int(x), float(m[y, x])) for y, x in zip(ys, xs, strict=True)]


def nms(cands: list[Candidate], exemplars: list[Exemplar], frac: float = 0.6) -> list[Candidate]:
    """Best first; a candidate closer than ``frac`` × size to a kept one is suppressed (its score becomes the
    kept one's runner-up when it is another class)."""
    from scipy.spatial import cKDTree

    cands = sorted(cands, key=lambda c: -c.score)
    if not cands:
        return []
    pts = np.asarray([c.center for c in cands])
    reach = frac * max(max(c.size) for c in cands)
    tree = cKDTree(pts)
    alive = np.ones(len(cands), bool)
    kept: list[Candidate] = []
    for i, c in enumerate(cands):
        if not alive[i]:
            continue
        kept.append(c)
        for j in tree.query_ball_point(pts[i], reach):
            if j <= i or not alive[j]:
                continue
            o = cands[j]
            if math.dist(c.center, o.center) < frac * max(max(c.size), max(o.size)):
                alive[j] = False
                if exemplars[o.ex].cls != exemplars[c.ex].cls:
                    c.runner_up = max(c.runner_up, o.score)
    return kept


@dataclass
class ResponseMap:
    ex: int
    score: np.ndarray  # best NCC over the glyph's poses, indexed by the template CENTRE (scene shape)
    pose: np.ndarray  # index into ``variants`` of the best pose
    variants: list[Variant]


def response_maps(scene: np.ndarray, bank: list[Variant]) -> dict[int, ResponseMap]:
    """Per glyph: max over its poses of the full-sheet NCC, re-anchored at the template centre."""
    H, W = scene.shape
    out: dict[int, ResponseMap] = {}
    for v in bank:
        th, tw = v.tpl.shape
        if th >= H or tw >= W:
            continue
        rm = out.get(v.ex)
        if rm is None:
            rm = out[v.ex] = ResponseMap(v.ex, np.full((H, W), -1.0, np.float32), np.zeros((H, W), np.int16), [])
        k = len(rm.variants)
        rm.variants.append(v)
        m = ncc_map(scene, v.tpl)
        oy, ox = th // 2, tw // 2
        dst = rm.score[oy : oy + m.shape[0], ox : ox + m.shape[1]]
        better = m > dst
        dst[better] = m[better]
        rm.pose[oy : oy + m.shape[0], ox : ox + m.shape[1]][better] = k
    return out


INK_RATIO = (0.6, 1.7)  # ink in the posed box / ink in the template: a solid fill or an empty edge is no symbol


def ink_ok(c: Candidate, rm: ResponseMap, ink: np.ndarray, ppm: float) -> bool:
    v = rm.variants[0]
    for q in rm.variants:
        if q.angle == c.angle:
            v = q
            break
    th, tw = v.tpl.shape
    y0, x0 = round(c.center[1] * ppm - th / 2), round(c.center[0] * ppm - tw / 2)
    sub = ink[max(0, y0) : y0 + th, max(0, x0) : x0 + tw]
    if sub.size == 0 or v.ink_share <= 0:
        return False
    r = float(sub.mean()) / v.ink_share
    return INK_RATIO[0] <= r <= INK_RATIO[1]


def candidate_at(rm: ResponseMap, y: int, x: int, ppm: float) -> Candidate:
    v = rm.variants[int(rm.pose[y, x])]
    th, tw = v.tpl.shape
    return Candidate(rm.ex, float(rm.score[y, x]), (x / ppm, y / ppm), (tw / ppm, th / ppm), v.angle)


def downsample(mask: np.ndarray, f: int = 2) -> np.ndarray:
    """Max-pool a bool mask by ``f`` (thin strokes survive)."""
    h, w = (mask.shape[0] // f) * f, (mask.shape[1] // f) * f
    return np.asarray(mask[:h, :w].reshape(h // f, f, w // f, f).max(axis=(1, 3)))


def estimate_scale(scene_mask: np.ndarray, exemplars: list[Exemplar], *, scales: tuple[float, ...] = (0.8, 1.0, 1.25)) -> float:
    """Legend → plan scale factor. CAD legends are usually drawn at the plan's symbol size (1.0); another factor
    wins only with clearly more strong axis-aligned hits (≥ 1.5×) of the classified glyphs (at half resolution)."""
    use = [x for x in exemplars if x.base is None and x.cls and x.glyph.size >= 64]
    use = sorted(use, key=lambda x: -x.glyph.size)[:6]
    if not use:
        return 1.0
    scene = blur(downsample(scene_mask))
    counts: dict[float, int] = {}
    for s in scales:
        n = 0
        for x in use:
            for a in (0, 90, 180, 270):
                t = blur(downsample(rotate_mask(x.glyph, a, s) > 0.3))
                if t.shape[0] >= scene.shape[0] or t.shape[1] >= scene.shape[1] or t.std() == 0:
                    continue
                n += len(peaks(ncc_map(scene, t), 0.7, max(t.shape)))
        counts[s] = n
    best = max(counts, key=lambda k: counts[k])
    return best if counts[best] >= 1.5 * max(1, counts.get(1.0, 0)) else 1.0


def read_multiplicity(page: Page, center: tuple[float, float], reach_mm: float = 7.0) -> int | None:
    """ "2X" / "3X" written next to a socket: Tesseract (eng) on a crop around it."""
    try:
        from ..ocr.tess import ocr_words
    except ImportError:  # pragma: no cover
        return None
    box = (center[0] - reach_mm, center[1] - reach_mm, center[0] + reach_mm, center[1] + reach_mm)
    x0, y0, x1, y1 = page.native_box(box)
    crop = page.gray.crop((max(0, x0), max(0, y0), x1, y1))
    s = max(1.0, 24.0 / page.native_ppm)  # ≥ 24 px per mm: 2.5 mm text ≈ 60 px
    if s > 1:
        crop = crop.resize((int(crop.width * s), int(crop.height * s)), Image.Resampling.LANCZOS)
    for rot in (0, 90, 270):  # the mark may be written along a vertical wall
        img = crop if rot == 0 else crop.rotate(rot, expand=True, fillcolor=255)
        try:
            words = ocr_words(img, "eng", 11)
        except (OSError, RuntimeError, ValueError):
            return None
        for w in words:
            m = _QUAL_RE.search(w.text.replace(" ", ""))
            if m and w.conf >= 30:
                return int(m.group(1))
    return None
