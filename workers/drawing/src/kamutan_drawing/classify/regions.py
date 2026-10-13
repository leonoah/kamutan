"""Floor regions: one sheet can hold several drawings (e.g. lighting basement + ground).

Drawing viewports are found from the geometry itself: the walls (filled paths) — or, when
a sheet has no fills, the non-text strokes — are painted on a 2 mm occupancy grid,
excluding the title block, the frame and text; the grid is dilated by 6 mm and its
connected components above 15 % of the largest one are the drawing regions.

Each region gets a floor: from a floor label next to it ("קומת מרתף", "קומה א'"), else —
when the title block lists exactly as many floors as there are regions — in title order
(top to bottom, then right to left), with a reason so the user confirms it (decision #10).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
from scipy import ndimage

from ..ingest.pdf_vector import VectorSheet
from ..ocr.dictionary import TextSpan
from ..scale.detect import detect_scale
from .sheet import _floors_in_order

GRID_MM = 2.0
DILATE_MM = 10.0
MIN_SHARE = 0.10  # of the largest region's extent
MIN_PAGE_SHARE = 0.01
MIN_FILLS = 30
MIN_FILL_AREA = 2.0  # mm²: walls, not arrowheads or symbol dots
LABEL_REACH_MM = 30.0
MAX_REGIONS = 8  # contracts MAX_REGIONS

R_FLOOR_ORDER = "שיוך קומות לאזורים לפי סדר הכותרת"
R_FLOOR_MISMATCH = "מספר הקומות בכותרת שונה ממספר האזורים בגיליון"
R_FLOOR_LABEL = "קומה לפי כיתוב ליד השרטוט"
R_REGION_SCALE = "קנה מידה של אזור שונה מהכותרת"
R_REGION_NO_SCALE = "אזור ללא קנה מידה לא נשמר"


@dataclass
class RegionResult:
    regions: list[dict[str, Any]]
    yellow: list[str] = field(default_factory=list)
    info: list[str] = field(default_factory=list)


def _inside(b: tuple[float, float, float, float], box: tuple[float, float, float, float] | None, pad: float = 0.0) -> bool:
    if box is None:
        return False
    cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    return box[0] - pad <= cx <= box[2] + pad and box[1] - pad <= cy <= box[3] + pad


def detect_regions(
    vs: VectorSheet,
    *,
    exclude_paths: set[int] | None = None,
    title_block: tuple[float, float, float, float] | None = None,
) -> list[tuple[float, float, float, float]]:
    W, H = vs.width_mm, vs.height_mm
    gw, gh = max(1, int(np.ceil(W / GRID_MM))), max(1, int(np.ceil(H / GRID_MM)))
    if vs.n_paths == 0:
        return []
    b = vs.path_bbox.astype(np.float64)
    ext_w, ext_h = b[:, 2] - b[:, 0], b[:, 3] - b[:, 1]
    keep = (ext_w < 0.8 * W) & (ext_h < 0.8 * H)
    if exclude_paths:
        ex = np.zeros(vs.n_paths, bool)
        ex[list(exclude_paths)] = True
        keep &= ~ex
    if title_block is not None:
        tb = title_block
        cx, cy = (b[:, 0] + b[:, 2]) / 2, (b[:, 1] + b[:, 3]) / 2
        keep &= ~((cx >= tb[0] - 1) & (cx <= tb[2] + 1) & (cy >= tb[1] - 1) & (cy <= tb[3] + 1))
    filled = keep & (vs.path_fill_mode > 0) & (ext_w * ext_h >= MIN_FILL_AREA)
    sel = filled if filled.sum() >= MIN_FILLS else keep & (np.maximum(ext_w, ext_h) >= 3.0)
    idx = np.where(sel)[0]
    if len(idx) == 0:
        return []
    grid = np.zeros((gh, gw), bool)
    gx0 = np.clip((b[idx, 0] / GRID_MM).astype(int), 0, gw - 1)
    gy0 = np.clip((b[idx, 1] / GRID_MM).astype(int), 0, gh - 1)
    gx1 = np.clip((b[idx, 2] / GRID_MM).astype(int), 0, gw - 1)
    gy1 = np.clip((b[idx, 3] / GRID_MM).astype(int), 0, gh - 1)
    big = (gx1 - gx0) * (gy1 - gy0) > 400  # long strokes: mark the segments, not the bbox
    for k in np.where(~big)[0]:
        grid[gy0[k] : gy1[k] + 1, gx0[k] : gx1[k] + 1] = True
    for k in np.where(big)[0]:
        i = int(idx[k])
        s0, n = int(vs.path_seg_start[i]), int(vs.path_seg_count[i])
        for x0, y0, x1, y1 in vs.segs[s0 : s0 + n]:
            m = int(max(abs(x1 - x0), abs(y1 - y0)) / GRID_MM) + 2
            xs = np.clip((np.linspace(x0, x1, m) / GRID_MM).astype(int), 0, gw - 1)
            ys = np.clip((np.linspace(y0, y1, m) / GRID_MM).astype(int), 0, gh - 1)
            grid[ys, xs] = True
    r = round(DILATE_MM / GRID_MM)
    dil = ndimage.binary_dilation(grid, structure=np.ones((2 * r + 1, 2 * r + 1), bool))
    lab, n = ndimage.label(dil)
    if n == 0:
        return []
    boxes: list[tuple[float, float, float, float]] = []
    for sl in ndimage.find_objects(lab):
        if sl is None:
            continue
        sub = grid[sl]
        ys, xs = np.where(sub)
        if len(xs) == 0:
            continue
        ys = ys + sl[0].start
        xs = xs + sl[1].start
        boxes.append(
            (
                max(0.0, xs.min() * GRID_MM - 1.0),
                max(0.0, ys.min() * GRID_MM - 1.0),
                min(W, (xs.max() + 1) * GRID_MM + 1.0),
                min(H, (ys.max() + 1) * GRID_MM + 1.0),
            )
        )
    boxes = _merge_overlapping(boxes)
    if not boxes:
        return []
    area = [(b[2] - b[0]) * (b[3] - b[1]) for b in boxes]
    amax = max(area)
    seeds = [b for b, a in zip(boxes, area, strict=True) if a >= MIN_SHARE * amax and a >= MIN_PAGE_SHARE * W * H]
    out = _grow(seeds, b[keep], W, H)
    # reading order: top to bottom, then right to left (Hebrew sheets)
    out.sort(key=lambda bb: (round(bb[1] / 50.0), -bb[2]))
    return out


def _extent(pb: np.ndarray, x0: float, y0: float, x1: float, y1: float) -> tuple[float, float, float, float] | None:
    cx, cy = (pb[:, 0] + pb[:, 2]) / 2, (pb[:, 1] + pb[:, 3]) / 2
    m = (cx >= x0) & (cx < x1) & (cy >= y0) & (cy < y1)
    if not m.any():
        return None
    q = pb[m]
    return (
        float(max(x0, q[:, 0].min())),
        float(max(y0, q[:, 1].min())),
        float(min(x1, q[:, 2].max())),
        float(min(y1, q[:, 3].max())),
    )


def _grow(
    seeds: list[tuple[float, float, float, float]], pb: np.ndarray, W: float, H: float
) -> list[tuple[float, float, float, float]]:
    """Seeds (wall clusters) -> drawing regions.

    One seed: the extent of all drawing geometry. Seeds separable along y (or x): the page
    is cut into bands midway between consecutive seeds and each band's geometry extent is
    a region (a legend table that straddles a cut is split, which is harmless: it is not a
    floor). Otherwise the seed boxes themselves.
    """
    if not seeds:
        return []
    if len(seeds) == 1:
        e = _extent(pb, 0.0, 0.0, W, H)
        return [e] if e else seeds
    for axis in (1, 0):  # 1: stacked vertically (y), 0: side by side (x)
        lo, hi = axis, axis + 2
        ss = sorted(seeds, key=lambda b: b[lo])
        if all(ss[i][hi] <= ss[i + 1][lo] for i in range(len(ss) - 1)):
            cuts = [0.0] + [(ss[i][hi] + ss[i + 1][lo]) / 2 for i in range(len(ss) - 1)] + [H if axis == 1 else W]
            out = []
            for i in range(len(ss)):
                if axis == 1:
                    e = _extent(pb, 0.0, cuts[i], W, cuts[i + 1])
                else:
                    e = _extent(pb, cuts[i], 0.0, cuts[i + 1], H)
                out.append(e or ss[i])
            return out
    return seeds


def _merge_overlapping(boxes: list[tuple[float, float, float, float]]) -> list[tuple[float, float, float, float]]:
    """Union boxes that overlap by more than 30 % of the smaller one (nested drawings, insets)."""
    bs = list(boxes)
    changed = True
    while changed:
        changed = False
        for i in range(len(bs)):
            for j in range(i + 1, len(bs)):
                a, b = bs[i], bs[j]
                iw = min(a[2], b[2]) - max(a[0], b[0])
                ih = min(a[3], b[3]) - max(a[1], b[1])
                if iw <= 0 or ih <= 0:
                    continue
                small = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
                if iw * ih > 0.3 * small:
                    bs[i] = (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))
                    del bs[j]
                    changed = True
                    break
            if changed:
                break
    return bs


def _poly(b: tuple[float, float, float, float]) -> list[dict[str, float]]:
    """Rectangle as contracts ``PointMm`` objects ``{x, y}`` (Firestore cannot store nested arrays)."""
    x0, y0, x1, y1 = (round(v, 2) for v in b)
    return [{"x": x0, "y": y0}, {"x": x1, "y": y0}, {"x": x1, "y": y1}, {"x": x0, "y": y1}]


def assign_floors(
    vs: VectorSheet,
    spans: list[TextSpan],
    floors: list[str],
    scale_den: int | None,
    *,
    exclude_paths: set[int] | None = None,
    title_block: tuple[float, float, float, float] | None = None,
) -> RegionResult:
    boxes = detect_regions(vs, exclude_paths=exclude_paths, title_block=title_block)
    res = RegionResult(regions=[])
    if not boxes:
        H = title_block[1] if (title_block and title_block[1] > 0.5 * vs.height_mm) else vs.height_mm
        boxes = [(0.0, 0.0, vs.width_mm, H)]
    free = [s for s in spans if not _inside(s.bbox, title_block, 1.0)]
    label_floor: list[str | None] = []
    for bb in boxes:
        best: tuple[float, str] | None = None
        for s in free:
            t = s.text
            if not ("קומ" in t or "מרתף" in t or "גג" in t) or len(t) > 40:
                continue
            fl = _floors_in_order(t)
            if len(fl) != 1:
                continue
            cx, cy = (s.bbox[0] + s.bbox[2]) / 2, (s.bbox[1] + s.bbox[3]) / 2
            dx = max(bb[0] - cx, 0.0, cx - bb[2])
            dy = max(bb[1] - cy, 0.0, cy - bb[3])
            d = float(np.hypot(dx, dy))
            if d <= LABEL_REACH_MM and (best is None or (d, -s.height) < (best[0], 0.0)):
                best = (d, fl[0])
        label_floor.append(best[1] if best else None)
    assigned: list[str] = []
    # Labels next to a drawing ("קומת מרתף") only decide between several drawings, and only when
    # they agree with the title block: notes such as "קו קומה א'" (floor line) or "במרתף" sit next
    # to plans of other floors (sample sheets 8d51ed5a, b2046277).
    distinct_labels = (
        len(boxes) > 1
        and all(label_floor)
        and len(set(label_floor)) == len(label_floor)
        and (not floors or set(label_floor) <= set(floors))
    )
    if len(boxes) > 1 and not distinct_labels:
        # fewer floors named than drawings found: merge the smallest drawing into its nearest
        # neighbour until the counts match (one named floor -> one region)
        target = max(1, len(floors))
        while len(boxes) > target:
            areas = [(b[2] - b[0]) * (b[3] - b[1]) for b in boxes]
            k = int(np.argmin(areas))
            a = boxes.pop(k)
            label_floor.pop(k)
            j = int(np.argmin([np.hypot((a[0] + a[2] - b[0] - b[2]) / 2, (a[1] + a[3] - b[1] - b[3]) / 2) for b in boxes]))
            b = boxes[j]
            boxes[j] = (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))
    if distinct_labels:
        assigned = [f for f in label_floor if f]
        res.info.append(R_FLOOR_LABEL)
    elif len(boxes) == 1:
        assigned = [floors[0] if floors else (label_floor[0] or "unknown")]
        if len(floors) > 1:
            res.yellow.append(R_FLOOR_MISMATCH)
    elif len(floors) == len(boxes):
        assigned = list(floors)
        res.yellow.append(R_FLOOR_ORDER)
    else:
        assigned = [lf or "unknown" for lf in label_floor]
        res.yellow.append(R_FLOOR_MISMATCH)
    for i, (bb, floor) in enumerate(zip(boxes[:MAX_REGIONS], assigned, strict=False)):
        den = scale_den
        if scale_den:
            inner = [s for s in spans if _inside(s.bbox, bb)]
            sc = detect_scale(scale_den, inner, vs) if len(inner) >= 3 else None
            if sc is not None and sc.from_dimensions is not None and sc.from_dimensions != scale_den:
                den = sc.from_dimensions
                res.yellow.append(R_REGION_SCALE)
        if den is None:  # contracts Region needs a scale; the user sets it when confirming
            res.info.append(R_REGION_NO_SCALE)
            continue
        res.regions.append({"id": f"r{i}", "floor": floor[:32], "polygonMm": _poly(bb), "scaleDenominator": int(den)})
    return res
