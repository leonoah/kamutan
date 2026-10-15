"""Stroke geometry shared by legend parsing and symbol spotting (paper mm, y down).

Everything works on straight segments ``(k, 4) = x0, y0, x1, y1`` (beziers are already
flattened by :mod:`kamutan_drawing.ingest.pdf_vector`). Helpers:

* :func:`resample` — points every ``step`` mm along segments (both ends included);
* :func:`segment_components` — connected stroke groups (touching / crossing strokes,
  T-junctions included) via a KD-tree over the resampled points;
* :data:`ORIENTS` / :func:`orient_matrix` — the 16 orientations a symbol is searched in
  (8 rotations in 45° steps × mirror);
* :func:`stroke_signature` — a stable hash of a stroke set normalised for position and size.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

BBox = tuple[float, float, float, float]  # x0, y0, x1, y1

# (rotation degrees counter-clockwise as seen on paper, mirrored)
ORIENTS: tuple[tuple[int, bool], ...] = tuple((a, m) for m in (False, True) for a in range(0, 360, 45))


def orient_matrix(angle_deg: int, mirror: bool) -> np.ndarray:
    """2x2 matrix acting on (x, y-down) vectors: optional mirror (x → -x) then rotation.

    ``angle_deg`` is counter-clockwise *as seen on paper*; with y down that is a clockwise
    rotation in the math frame, hence the sign flip.
    """
    t = math.radians(angle_deg)
    c, s = math.cos(t), math.sin(t)
    rot = np.array([[c, s], [-s, c]])
    mir = np.array([[-1.0, 0.0], [0.0, 1.0]]) if mirror else np.eye(2)
    return rot @ mir


def seg_lengths(segs: np.ndarray) -> np.ndarray:
    if len(segs) == 0:
        return np.zeros(0)
    return np.hypot(segs[:, 2] - segs[:, 0], segs[:, 3] - segs[:, 1])


def resample(segs: np.ndarray, step: float) -> tuple[np.ndarray, np.ndarray]:
    """Points along every segment, spaced ≤ ``step``; returns ``(points (n,2), segment index (n,))``."""
    if len(segs) == 0:
        return np.zeros((0, 2)), np.zeros(0, dtype=np.int64)
    segs = np.asarray(segs, dtype=np.float64)
    lens = seg_lengths(segs)
    n = np.maximum(1, np.ceil(lens / step).astype(np.int64))  # pieces per segment
    counts = n + 1
    idx = np.repeat(np.arange(len(segs)), counts)
    starts = np.cumsum(counts) - counts
    k = np.arange(int(counts.sum())) - np.repeat(starts, counts)
    t = k / np.repeat(n, counts)
    p0 = segs[idx, :2]
    p1 = segs[idx, 2:]
    pts = p0 + (p1 - p0) * t[:, None]
    return pts, idx


def segment_components(segs: np.ndarray, tol: float = 0.12, step: float = 0.1) -> np.ndarray:
    """Label (per segment) of connected stroke groups: two segments are connected when any of
    their resampled points are within ``tol`` mm (shared ends, crossings, T-junctions)."""
    m = len(segs)
    if m == 0:
        return np.zeros(0, dtype=np.int64)
    pts, owner = resample(segs, step)
    tree = cKDTree(pts)
    pairs = tree.query_pairs(tol, output_type="ndarray")
    if len(pairs):
        a, b = owner[pairs[:, 0]], owner[pairs[:, 1]]
        keep = a != b
        a, b = a[keep], b[keep]
    else:
        a = b = np.zeros(0, dtype=np.int64)
    g = coo_matrix((np.ones(len(a), dtype=np.int8), (a, b)), shape=(m, m))
    _, labels = connected_components(g, directed=False)
    return np.asarray(labels, dtype=np.int64)


@dataclass(eq=False)
class Group:
    """A connected stroke group (indices into some segment array)."""

    segs: np.ndarray  # indices
    bbox: BBox

    @property
    def w(self) -> float:
        return self.bbox[2] - self.bbox[0]

    @property
    def h(self) -> float:
        return self.bbox[3] - self.bbox[1]

    @property
    def cx(self) -> float:
        return (self.bbox[0] + self.bbox[2]) / 2

    @property
    def cy(self) -> float:
        return (self.bbox[1] + self.bbox[3]) / 2


def groups_of(segs: np.ndarray, labels: np.ndarray, subset: np.ndarray | None = None) -> list[Group]:
    """Groups from component labels (``subset``: indices of ``segs`` that ``labels`` refer to)."""
    if len(labels) == 0:
        return []
    ids = np.arange(len(labels)) if subset is None else np.asarray(subset)
    order = np.argsort(labels, kind="stable")
    lab_sorted = labels[order]
    cuts = np.flatnonzero(np.diff(lab_sorted)) + 1
    out: list[Group] = []
    for part in np.split(order, cuts):
        si = ids[part]
        s = segs[si]
        bb = (
            float(min(s[:, 0].min(), s[:, 2].min())),
            float(min(s[:, 1].min(), s[:, 3].min())),
            float(max(s[:, 0].max(), s[:, 2].max())),
            float(max(s[:, 1].max(), s[:, 3].max())),
        )
        out.append(Group(si, bb))
    return out


def bbox_of(segs: np.ndarray) -> BBox:
    return (
        float(min(segs[:, 0].min(), segs[:, 2].min())),
        float(min(segs[:, 1].min(), segs[:, 3].min())),
        float(max(segs[:, 0].max(), segs[:, 2].max())),
        float(max(segs[:, 1].max(), segs[:, 3].max())),
    )


def bbox_union(a: BBox, b: BBox) -> BBox:
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


def bbox_overlap_share(a: BBox, b: BBox) -> float:
    """Area of a ∩ b divided by the area of ``a`` (degenerate boxes are padded by 0.05 mm)."""
    ax0, ay0, ax1, ay1 = a[0] - 0.05, a[1] - 0.05, a[2] + 0.05, a[3] + 0.05
    w = min(ax1, b[2] + 0.05) - max(ax0, b[0] - 0.05)
    h = min(ay1, b[3] + 0.05) - max(ay0, b[1] - 0.05)
    if w <= 0 or h <= 0:
        return 0.0
    return float(w * h / max((ax1 - ax0) * (ay1 - ay0), 1e-9))


def in_box(x: np.ndarray, y: np.ndarray, b: BBox, pad: float = 0.0) -> np.ndarray:
    return (x >= b[0] - pad) & (x <= b[2] + pad) & (y >= b[1] - pad) & (y <= b[3] + pad)


def bbox_dict(b: BBox) -> dict[str, float]:
    return {"x": round(b[0], 2), "y": round(b[1], 2), "w": round(b[2] - b[0], 2), "h": round(b[3] - b[1], 2)}


def normalised_points(segs: np.ndarray, step_rel: float = 0.04) -> tuple[np.ndarray, float]:
    """Points of a stroke set centred on its bbox centre and divided by its bbox's longer side."""
    b = bbox_of(segs)
    size = max(b[2] - b[0], b[3] - b[1], 1e-6)
    c = np.array([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2])
    pts, _ = resample(segs, step_rel * size)
    return (pts - c) / size, size


def _sig(pts: np.ndarray, aspect: int, cur: str, qualifier: str, grid: int, thr: float) -> str:
    ij = np.clip(((pts + 0.5) * grid).astype(np.int64), 0, grid - 1)
    counts = np.zeros((grid, grid))
    np.add.at(counts, (ij[:, 1], ij[:, 0]), 1.0)
    bits = "".join("1" if v >= thr else "0" for v in (counts / max(len(pts), 1)).ravel())
    return hashlib.sha256(f"v2|{aspect}|{cur}|{bits}|{qualifier}".encode()).hexdigest()[:16]


def stroke_signatures(
    segs: np.ndarray, qualifier: str = "", curved: np.ndarray | None = None, *, grid: int = 6, probes: bool = True
) -> list[str]:
    """Stable hash of a stroke set (first item) plus its *probe* variants.

    The hash is the share of the (normalised) stroke length per cell of a ``grid``² raster,
    thresholded at 3 %, plus the aspect class, the share of curved strokes and the symbol's own
    text (``2X``, ``TV``…); 16 hex chars. Float noise between sheets (a rotated page, another
    export) can still move ink across a cell border, so lookups of remembered mappings also try
    the probe variants (sub-cell shifts, neighbouring thresholds) — multi-probe hashing.
    """
    if len(segs) == 0:
        return ["0" * 16]
    pts, _ = normalised_points(segs, step_rel=0.01)
    b = bbox_of(segs)
    w, h = b[2] - b[0], b[3] - b[1]
    aspect = round(math.log2(max(w, 0.05) / max(h, 0.05)))
    cur = ""
    if curved is not None and len(curved):
        share = float(np.mean(curved))
        cur = "c0" if share < 0.15 else ("c1" if share < 0.6 else "c2")
    out = [_sig(pts, aspect, cur, qualifier, grid, 0.03)]
    if probes:
        d = 0.5 / grid / 4
        for dx in (-d, 0.0, d):
            for dy in (-d, 0.0, d):
                for thr in (0.02, 0.03, 0.045):
                    sg = _sig(pts + np.array([dx, dy]), aspect, cur, qualifier, grid, thr)
                    if sg not in out:
                        out.append(sg)
    return out


def stroke_signature(segs: np.ndarray, qualifier: str = "", curved: np.ndarray | None = None) -> str:
    return stroke_signatures(segs, qualifier, curved, probes=False)[0]


def chamfer(src: np.ndarray, tree: cKDTree, cap: float) -> tuple[float, np.ndarray]:
    """Mean (capped) distance of ``src`` points to the tree's points, and the per-point distances."""
    if len(src) == 0:
        return cap, np.zeros(0)
    d, _ = tree.query(src, k=1, distance_upper_bound=cap)
    d = np.minimum(d, cap)
    return float(d.mean()), d


def path_fill_areas(segs: np.ndarray, seg_path: np.ndarray, fill_mode: np.ndarray, n_paths: int) -> np.ndarray:
    """Solid area (mm²) of every filled path, 0 for unfilled ones.

    AutoCAD exports solid fills as many small triangles / slivers, often with doubled edges, so
    the area is summed per closed sub-path (a new sub-path starts where a segment does not
    continue the previous one), each in absolute value."""
    area = np.zeros(n_paths)
    m = len(segs)
    if m == 0:
        return area
    s = segs.astype(np.float64)
    cross = s[:, 0] * s[:, 3] - s[:, 2] * s[:, 1]
    new = np.ones(m, bool)
    new[1:] = (seg_path[1:] != seg_path[:-1]) | (np.abs(s[1:, 0] - s[:-1, 2]) + np.abs(s[1:, 1] - s[:-1, 3]) > 1e-3)
    sub = np.cumsum(new) - 1
    sub_area = np.zeros(int(sub[-1]) + 1)
    np.add.at(sub_area, sub, cross)
    sub_path = seg_path[new]
    np.add.at(area, sub_path, np.abs(sub_area) / 2)
    area[fill_mode <= 0] = 0.0
    return area
