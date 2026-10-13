"""Symbol templates built from legend strokes.

A template is the legend symbol's strokes centred on their bbox centre, resampled every
``STEP`` mm, with an *anchor* primitive used to propose poses on the drawing:

* an arc (radius ≥ ``MIN_ANCHOR_R``) — a scene arc of similar radius / coverage gives the
  position, the scale (radius ratio) and, for partial arcs, the rotation;
* else the longest straight stroke — a scene stroke of similar length gives position and two
  candidate directions.

Look-alike legend entries (identical strokes, told apart only by their text such as ``BEZEK`` /
``TV`` / ``2X``) share one template (a *family*); the text near each detection picks the member.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from scipy.spatial import cKDTree

from ..ingest.pdf_vector import SEG_BEZIER, VectorSheet
from ..legend.parse import LegendEntry
from .arcs import Arc, arc_of_points, extract_arcs
from .geometry import ORIENTS, bbox_of, orient_matrix, path_fill_areas, resample, seg_lengths

STEP = 0.1
MIN_ANCHOR_R = 0.9
FAMILY_TOL = 0.025  # mean symmetric chamfer / size below which two templates are the same drawing


@dataclass
class Anchor:
    kind: str  # "arc" | "line"
    center: np.ndarray  # template frame
    r: float = 0.0
    coverage: float = 0.0
    mid: np.ndarray = field(default_factory=lambda: np.zeros(2))  # arc: unit mid direction; line: unit direction
    length: float = 0.0


@dataclass
class Template:
    id: str
    entries: list[LegendEntry]
    segs: np.ndarray  # (k,4) template frame (centre = bbox centre)
    pts: np.ndarray  # resampled points, template frame
    w: float
    h: float
    anchor: Anchor
    curved_share: float
    complexity: float  # how distinctive the strokes are (0..1)
    symmetric: bool  # mirror image equals itself (checked numerically)
    fill_area: float = 0.0  # mm² of filled (solid) parts, e.g. the power socket's half disc
    tree: Any = field(repr=False, default=None)  # cKDTree of ``pts``

    @property
    def diag(self) -> float:
        return math.hypot(self.w, self.h)

    @property
    def size(self) -> float:
        return max(self.w, self.h)

    def orients(self) -> list[tuple[int, bool]]:
        return [o for o in ORIENTS if not (self.symmetric and o[1])]


def _chamfer_sym(a: np.ndarray, b: np.ndarray) -> float:
    if len(a) == 0 or len(b) == 0:
        return 1e9
    ta, tb = cKDTree(a), cKDTree(b)
    return float((tb.query(a)[0].mean() + ta.query(b)[0].mean()) / 2)


def _best_orient_distance(a: np.ndarray, b: np.ndarray) -> float:
    return min(_chamfer_sym(a @ orient_matrix(ang, mir).T, b) for ang, mir in ORIENTS)


def _anchor(segs_abs: np.ndarray, kinds: np.ndarray, vs: VectorSheet, seg_idx: np.ndarray, center: np.ndarray) -> Anchor:
    # arcs: rebuild from the original beziers of the paths involved
    paths = np.zeros(vs.n_paths, bool)
    paths[np.unique(vs.seg_path[seg_idx])] = True
    arcs = [a for a in extract_arcs(vs, paths) if a.r >= MIN_ANCHOR_R]
    # keep arcs that are really inside the symbol bbox
    bb = bbox_of(segs_abs)
    arcs = [a for a in arcs if bb[0] - 0.2 <= a.cx <= bb[2] + 0.2 and bb[1] - 0.2 <= a.cy <= bb[3] + 0.2]
    if not arcs:  # polyline-drawn arcs (DXF): fit the curved pieces
        cur = segs_abs[kinds == SEG_BEZIER]
        if len(cur) >= 6:
            pts, _ = resample(cur, 0.2)
            a = arc_of_points(pts)
            if a is not None and a.r >= MIN_ANCHOR_R:
                arcs = [a]
    if arcs:
        a = max(arcs, key=lambda q: q.r * min(q.coverage, 360.0))
        return Anchor("arc", np.array([a.cx, a.cy]) - center, r=a.r, coverage=a.coverage, mid=np.array(a.mid))
    straight = segs_abs[kinds != SEG_BEZIER] if (kinds != SEG_BEZIER).any() else segs_abs
    lens = seg_lengths(straight)
    k = int(np.argmax(lens))
    s = straight[k]
    d = np.array([s[2] - s[0], s[3] - s[1]], dtype=np.float64)
    d /= max(np.linalg.norm(d), 1e-9)
    mid = np.array([(s[0] + s[2]) / 2, (s[1] + s[3]) / 2]) - center
    return Anchor("line", mid, mid=d, length=float(lens[k]))


def build_template(tid: str, entry: LegendEntry, vs: VectorSheet) -> Template | None:
    if entry.kind != "symbol" or len(entry.seg_idx) == 0:
        return None
    segs_abs = vs.segs[entry.seg_idx].astype(np.float64)
    kinds = vs.seg_kind[entry.seg_idx]
    bb = bbox_of(segs_abs)
    w, h = bb[2] - bb[0], bb[3] - bb[1]
    if max(w, h) < 1.0:
        return None
    center = np.array([(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2])
    segs = segs_abs - np.concatenate([center, center])
    pts, _ = resample(segs, STEP)
    anchor = _anchor(segs_abs, kinds, vs, entry.seg_idx, center)
    curved = float(np.mean(kinds == SEG_BEZIER)) if len(kinds) else 0.0
    # distinctiveness: total stroke length relative to size, number of directions, curves
    total = float(seg_lengths(segs).sum())
    angles = np.round(np.degrees(np.arctan2(segs[:, 3] - segs[:, 1], segs[:, 2] - segs[:, 0])) % 180 / 15)
    n_dirs = len(set(angles.tolist()))
    complexity = min(1.0, 0.15 * min(total / max(w, h), 4.0) + 0.08 * min(n_dirs, 5) + (0.25 if anchor.kind == "arc" else 0.0))
    mirrored = pts * np.array([-1.0, 1.0])
    symmetric = min(_chamfer_sym(mirrored @ orient_matrix(a, False).T, pts) for a in range(0, 360, 90)) < 0.03 * max(w, h)
    paths = np.unique(vs.seg_path[entry.seg_idx])
    fills = path_fill_areas(vs.segs, vs.seg_path, vs.path_fill_mode, vs.n_paths)
    t = Template(
        fill_area=float(fills[paths].sum()),
        id=tid,
        entries=[entry],
        segs=segs,
        pts=pts,
        w=w,
        h=h,
        anchor=anchor,
        curved_share=curved,
        complexity=round(complexity, 3),
        symmetric=symmetric,
    )
    t.tree = cKDTree(pts)
    return t


def build_templates(entries: list[LegendEntry], vs: VectorSheet) -> list[Template]:
    """One template per distinct legend drawing; look-alike entries are merged into families."""
    out: list[Template] = []
    for e in entries:
        t = build_template(f"t{e.n}", e, vs)
        if t is None:
            continue
        for o in out:
            same = abs(o.w - t.w) < 0.1 * max(o.w, t.w) + 0.15 and abs(o.h - t.h) < 0.1 * max(o.h, t.h) + 0.15
            turned = abs(o.w - t.h) < 0.1 * max(o.w, t.h) + 0.15 and abs(o.h - t.w) < 0.1 * max(o.h, t.w) + 0.15
            if (same or turned) and _best_orient_distance(t.pts, o.pts) < FAMILY_TOL * max(o.size, t.size):
                o.entries.append(e)
                break
        else:
            out.append(t)
    return out


def scene_arcs(vs: VectorSheet, keep_path: np.ndarray) -> list[Arc]:
    return extract_arcs(vs, keep_path)
