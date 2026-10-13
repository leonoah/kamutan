"""Legend-conditioned symbol spotting on vector strokes (not pixels).

For every template (one per distinct legend drawing):

1. **poses** — each scene primitive like the template's anchor (an arc of similar radius and
   coverage, or a stroke of similar length) proposes a pose: position, rotation (8 × 45°, or
   the exact angle given by a partial arc / a stroke) and mirror; the scale comes from the
   radius ratio when the anchor is an arc and is otherwise the legend → plan scale;
2. **forward chamfer** — the template's resampled points are mapped by the pose and looked up
   in a KD-tree of the drawing's resampled strokes: mean capped distance + share of points
   that land on ink (``coverage``);
3. **reverse chamfer** — the drawing's ink inside the posed template box (strokes longer than
   the symbol excluded: walls, leaders) is mapped back into the template frame: extra ink
   (a filled half circle where the template is hollow, a cross through a circle) costs;
4. **non-maximum suppression** across all templates; the runner-up template at the same place
   is kept for the *margin*.

Regions excluded: legend tables (and their symbols), fixture tables, the title block.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from scipy.spatial import cKDTree

from ..ingest.pdf_vector import VectorSheet
from .arcs import Arc, extract_arcs
from .geometry import BBox, in_box, path_fill_areas, resample, seg_lengths
from .template import Template

STEP = 0.1
CAP_MM = 0.6
MAX_POSES = 60_000
CHUNK_POINTS = 1_500_000
MIN_FWD_COV = 0.72


@dataclass
class Scene:
    segs: np.ndarray  # (m,4) kept segments (paper mm)
    seg_ids: np.ndarray  # indices into the VectorSheet's segments
    seg_len: np.ndarray
    pts: np.ndarray
    pt_seg: np.ndarray  # local segment index of every point
    tree: cKDTree
    arcs: list[Arc]
    excluded: list[BBox]
    fill_xy: np.ndarray = field(default_factory=lambda: np.zeros((0, 2)))  # centroids of filled paths
    fill_area: np.ndarray = field(default_factory=lambda: np.zeros(0))
    fill_tree: cKDTree | None = None

    @property
    def n(self) -> int:
        return len(self.segs)


def build_scene(vs: VectorSheet, exclude: list[BBox], *, keep_mask: np.ndarray | None = None) -> Scene:
    s = vs.segs.astype(np.float64)
    mx, my = (s[:, 0] + s[:, 2]) / 2, (s[:, 1] + s[:, 3]) / 2
    keep = np.ones(len(s), bool) if keep_mask is None else keep_mask.copy()
    for b in exclude:
        keep &= ~in_box(mx, my, b)
    ids = np.where(keep)[0]
    segs = s[ids]
    pts, pt_seg = resample(segs, STEP) if len(segs) else (np.zeros((0, 2)), np.zeros(0, dtype=np.int64))
    tree = cKDTree(pts if len(pts) else np.zeros((1, 2)) + 1e9)
    keep_path = np.zeros(vs.n_paths, bool)
    if len(ids):
        keep_path[np.unique(vs.seg_path[ids])] = True
    arcs = [a for a in extract_arcs(vs, keep_path) if not any(b[0] <= a.cx <= b[2] and b[1] <= a.cy <= b[3] for b in exclude)]
    areas = path_fill_areas(vs.segs, vs.seg_path, vs.path_fill_mode, vs.n_paths)
    fp = np.where((areas > 0) & keep_path)[0]
    fp = fp[areas[fp] < 50.0]  # walls are filled too; symbols are small
    pb = vs.path_bbox[fp].astype(np.float64)
    fxy = np.column_stack([(pb[:, 0] + pb[:, 2]) / 2, (pb[:, 1] + pb[:, 3]) / 2]) if len(fp) else np.zeros((0, 2))
    return Scene(
        segs,
        ids,
        seg_lengths(segs),
        pts,
        pt_seg,
        tree,
        arcs,
        list(exclude),
        fill_xy=fxy,
        fill_area=areas[fp],
        fill_tree=cKDTree(fxy) if len(fp) else None,
    )


@dataclass
class Candidate:
    tpl: Template
    center: tuple[float, float]
    mat: np.ndarray  # 2x2 (scale · rotation · mirror)
    scale: float
    fwd: float  # mean capped forward distance (mm, template-size normalised by scale)
    cov: float  # share of template points on ink
    rev: float = CAP_MM  # mean reverse distance
    rev_cov: float = 0.0  # share of local ink explained by the template
    fill_diff: float = 0.0  # |solid area here − template solid area| / template box area
    quality: float = 0.0
    runner_up: float = 0.0  # quality of the best other template at this place
    runner_up_id: str | None = None

    @property
    def angle_deg(self) -> int:
        """Rotation, counter-clockwise as seen on paper (y down), 0..359."""
        m = self.mat / max(self.scale, 1e-9)
        det = float(np.linalg.det(m))
        a = m[:, 0] if det > 0 else m @ np.array([-1.0, 0.0])
        return round(-math.degrees(math.atan2(a[1], a[0]))) % 360

    @property
    def mirrored(self) -> bool:
        return float(np.linalg.det(self.mat)) < 0

    def bbox(self) -> BBox:
        c = np.array(
            [
                [-self.tpl.w / 2, -self.tpl.h / 2],
                [self.tpl.w / 2, -self.tpl.h / 2],
                [self.tpl.w / 2, self.tpl.h / 2],
                [-self.tpl.w / 2, self.tpl.h / 2],
            ]
        )
        q = c @ self.mat.T + np.array(self.center)
        return (float(q[:, 0].min()), float(q[:, 1].min()), float(q[:, 0].max()), float(q[:, 1].max()))


def _rot_to(v: np.ndarray, u: np.ndarray) -> np.ndarray:
    c = float(v @ u)
    s = float(v[0] * u[1] - v[1] * u[0])
    return np.array([[c, -s], [s, c]])


_MIR = np.array([[-1.0, 0.0], [0.0, 1.0]])


def _rot_angle(a_deg: float) -> np.ndarray:
    t = math.radians(a_deg)
    return np.array([[math.cos(t), -math.sin(t)], [math.sin(t), math.cos(t)]])


def propose(tpl: Template, scene: Scene, scale: float, scale_tol: float = 0.2) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Candidate poses: (centres (P,2), matrices (P,2,2), scales (P,))."""
    an = tpl.anchor
    mirrors = [False] if tpl.symmetric else [False, True]
    centers: list[np.ndarray] = []
    mats: list[np.ndarray] = []
    scales: list[float] = []
    if an.kind == "arc":
        for a in scene.arcs:
            k = a.r / an.r
            if not (scale * (1 - scale_tol) <= k <= scale * (1 + scale_tol)):
                continue
            full_t = an.coverage >= 320
            if full_t != a.full:
                continue
            if not full_t and abs(a.coverage - an.coverage) > 50:
                continue
            us = np.array(a.mid)
            for mir in mirrors:
                mm = _MIR if mir else np.eye(2)
                if full_t:
                    rots = [_rot_angle(d) for d in range(0, 360, 45)]
                else:
                    rots = [_rot_to(mm @ an.mid, us)]
                for r in rots:
                    m = k * (r @ mm)
                    centers.append(np.array([a.cx, a.cy]) - m @ an.center)
                    mats.append(m)
                    scales.append(k)
    else:
        lo, hi = an.length * scale * (1 - 0.12), an.length * scale * (1 + 0.12)
        cand = np.where((scene.seg_len >= lo) & (scene.seg_len <= hi))[0]
        for i in cand:
            sg = scene.segs[i]
            d = np.array([sg[2] - sg[0], sg[3] - sg[1]])
            ln = float(np.linalg.norm(d))
            d /= max(ln, 1e-9)
            mid = np.array([(sg[0] + sg[2]) / 2, (sg[1] + sg[3]) / 2])
            k = ln / an.length
            for us in (d, -d):
                for mir in mirrors:
                    mm = _MIR if mir else np.eye(2)
                    r = _rot_to(mm @ an.mid, us)
                    m = k * (r @ mm)
                    centers.append(mid - m @ an.center)
                    mats.append(m)
                    scales.append(k)
    if not centers:
        return np.zeros((0, 2)), np.zeros((0, 2, 2)), np.zeros(0)
    c = np.asarray(centers)
    m = np.asarray(mats)
    sc = np.asarray(scales)
    if len(c) > MAX_POSES:  # pathological sheets: keep a deterministic subset
        sel = np.linspace(0, len(c) - 1, MAX_POSES).astype(np.int64)
        c, m, sc = c[sel], m[sel], sc[sel]
    return c, m, sc


def forward(
    tpl: Template, scene: Scene, centers: np.ndarray, mats: np.ndarray, scales: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Mean capped distance (in template mm) and on-ink share per pose."""
    P = len(centers)
    n = len(tpl.pts)
    fwd = np.full(P, CAP_MM)
    cov = np.zeros(P)
    if P == 0 or n == 0:
        return fwd, cov
    per = max(1, CHUNK_POINTS // n)
    tol = 0.12 + 0.02 * tpl.size
    for s0 in range(0, P, per):
        sl = slice(s0, min(P, s0 + per))
        q = np.einsum("pij,nj->pni", mats[sl], tpl.pts) + centers[sl][:, None, :]
        d, _ = scene.tree.query(q.reshape(-1, 2), k=1, distance_upper_bound=CAP_MM * 3)
        d = d.reshape(-1, n) / scales[sl][:, None]
        d = np.minimum(d, CAP_MM)
        fwd[sl] = d.mean(axis=1)
        cov[sl] = (d <= tol).mean(axis=1)
    return fwd, cov


def reverse(tpl: Template, scene: Scene, center: np.ndarray, mat: np.ndarray, scale: float) -> tuple[float, float]:
    """Ink near the posed template, mapped back into the template frame."""
    rad = 0.5 * tpl.diag * scale + 0.3
    idx = scene.tree.query_ball_point(center, rad)
    if not idx:
        return CAP_MM, 0.0
    idx = np.asarray(idx)
    idx = idx[idx < len(scene.pts)]
    if len(idx) == 0:
        return CAP_MM, 0.0
    long_ = scene.seg_len[scene.pt_seg[idx]] > 1.6 * tpl.size * scale + 0.5
    idx = idx[~long_]
    if len(idx) == 0:
        return 0.0, 1.0
    inv = np.linalg.inv(mat)
    q = (scene.pts[idx] - center) @ inv.T
    m = 0.15
    inside = (np.abs(q[:, 0]) <= tpl.w / 2 + m) & (np.abs(q[:, 1]) <= tpl.h / 2 + m)
    q = q[inside]
    if len(q) == 0:
        return CAP_MM, 0.0
    d, _ = tpl.tree.query(q, k=1, distance_upper_bound=CAP_MM * 2)
    d = np.minimum(d, CAP_MM)
    tol = 0.12 + 0.02 * tpl.size
    return float(d.mean()), float((d <= tol).mean())


def fill_difference(tpl: Template, scene: Scene, center: np.ndarray, mat: np.ndarray, scale: float) -> float:
    if scene.fill_tree is None:
        found = 0.0
    else:
        idx = scene.fill_tree.query_ball_point(center, 0.5 * tpl.diag * scale + 0.2)
        found = 0.0
        if idx:
            idx = np.asarray(idx)
            q = (scene.fill_xy[idx] - center) @ np.linalg.inv(mat).T
            inside = (np.abs(q[:, 0]) <= tpl.w / 2 + 0.1) & (np.abs(q[:, 1]) <= tpl.h / 2 + 0.1)
            found = float(scene.fill_area[idx][inside].sum()) / max(scale * scale, 1e-9)
    return abs(found - tpl.fill_area) / max(tpl.w * tpl.h, 1e-6)


def quality(fwd: float, cov: float, rev: float, rev_cov: float, fill_diff: float = 0.0) -> float:
    """0..1 geometric agreement (1 = the template sits exactly on the strokes, no extra ink)."""
    q_f = max(0.0, 1.0 - fwd / 0.3) * min(1.0, cov / 0.97)
    q_r = max(0.0, 1.0 - rev / 0.3) * min(1.0, rev_cov / 0.9)
    return float((0.6 * q_f + 0.4 * q_r) * max(0.0, 1.0 - 4.0 * fill_diff))


def spot_template(tpl: Template, scene: Scene, scale: float = 1.0) -> list[Candidate]:
    centers, mats, scales = propose(tpl, scene, scale)
    if len(centers) == 0:
        return []
    fwd, cov = forward(tpl, scene, centers, mats, scales)
    ok = np.where(cov >= MIN_FWD_COV)[0]
    out: list[Candidate] = []
    for i in ok[np.argsort(-cov[ok])][:5000]:
        rv, rc = reverse(tpl, scene, centers[i], mats[i], float(scales[i]))
        c = Candidate(
            tpl, (float(centers[i][0]), float(centers[i][1])), mats[i], float(scales[i]), float(fwd[i]), float(cov[i]), rv, rc
        )
        c.fill_diff = fill_difference(tpl, scene, centers[i], mats[i], float(scales[i]))
        c.quality = quality(c.fwd, c.cov, c.rev, c.rev_cov, c.fill_diff)
        out.append(c)
    return out


@dataclass
class SpotResult:
    detections: list[Candidate] = field(default_factory=list)
    scale: float = 1.0
    scale_estimated: bool = False


def _posed(c: Candidate) -> np.ndarray:
    return np.asarray(c.tpl.pts @ c.mat.T + np.array(c.center))


def _nms(cands: list[Candidate], min_quality: float) -> list[Candidate]:
    """Non-maximum suppression on *shared strokes*, not on centre distance.

    Two candidates are the same instance when ≥ 50 % of either one's posed template lies on the
    other's (a 2-way switch contains the strokes of a single switch; two switches of a bank 2 mm
    apart share none, so both survive). Of two overlapping candidates the more specific template —
    clearly more strokes, all of the other's explained — wins unless its fit is much worse; the
    loser's quality becomes the winner's runner-up (→ margin)."""
    cands = sorted(cands, key=lambda c: -c.quality)
    kept: list[Candidate] = []
    trees: list[cKDTree] = []
    tol = 0.25
    for c in cands:
        pc = _posed(c)
        tc: cKDTree | None = None
        hit = None
        for k, (kc, tk) in enumerate(zip(kept, trees, strict=True)):
            reach = 0.5 * (c.tpl.diag * c.scale + kc.tpl.diag * kc.scale)
            if math.hypot(c.center[0] - kc.center[0], c.center[1] - kc.center[1]) > reach:
                continue
            share_c = float((tk.query(pc, k=1, distance_upper_bound=tol)[0] <= tol).mean())
            if tc is None:
                tc = cKDTree(pc)
            share_k = float((tc.query(_posed(kc), k=1, distance_upper_bound=tol)[0] <= tol).mean())
            if share_c >= 0.5 or share_k >= 0.5:
                hit = (k, share_c, share_k)
                break
        if hit is None:
            if c.quality >= min_quality:
                kept.append(c)
                trees.append(tc if tc is not None else cKDTree(pc))
            continue
        k, share_c, share_k = hit
        kc = kept[k]
        more_specific = len(c.tpl.pts) >= 1.25 * len(kc.tpl.pts) and share_k >= 0.7
        if c.tpl.id != kc.tpl.id and more_specific and c.quality >= max(min_quality, kc.quality - 0.15):
            c.runner_up, c.runner_up_id = kc.quality, kc.tpl.id
            kept[k] = c
            trees[k] = tc if tc is not None else cKDTree(pc)
            continue
        if c.tpl.id != kc.tpl.id and c.quality > kc.runner_up:
            kc.runner_up = c.quality
            kc.runner_up_id = c.tpl.id
    return kept


def estimate_scale(templates: list[Template], scene: Scene) -> float | None:
    """Legend → plan symbol scale from arc radii (mode of plausible ratios), None if unclear."""
    ratios: list[float] = []
    for t in templates:
        if t.anchor.kind != "arc":
            continue
        for a in scene.arcs:
            if (a.full == (t.anchor.coverage >= 320)) and (a.full or abs(a.coverage - t.anchor.coverage) < 30):
                k = a.r / t.anchor.r
                if 0.2 <= k <= 5.0:
                    ratios.append(math.log2(k))
    if len(ratios) < 5:
        return None
    hist, edges = np.histogram(ratios, bins=np.arange(-2.4, 2.45, 0.1))
    k = int(np.argmax(hist))
    return float(2 ** ((edges[k] + edges[k + 1]) / 2))


def spot(templates: list[Template], scene: Scene, *, min_quality: float = 0.45) -> SpotResult:
    res = SpotResult()
    cands: list[Candidate] = []
    for t in templates:
        cands.extend(spot_template(t, scene, 1.0))
    strong = sum(1 for c in cands if c.quality >= 0.7)
    if strong < 2:  # the legend may be drawn at another size than the plan symbols
        k = estimate_scale(templates, scene)
        if k is not None and abs(math.log2(k)) > 0.15:
            alt: list[Candidate] = []
            for t in templates:
                alt.extend(spot_template(t, scene, k))
            if sum(1 for c in alt if c.quality >= 0.7) > strong:
                cands, res.scale, res.scale_estimated = alt, k, True
    res.detections = _nms(cands, min_quality)
    return res
