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
   (a filled half circle where the template is hollow, a cross through a circle) costs. Not
   counted (Sprint 8): leader terminators (tiny filled dots / arrowheads — fill is compared by
   area in :func:`fill_difference`) and the last leg of a leader that ends on such a dot inside
   the symbol (a straight-line path that runs on well beyond the symbol: the note's leader);
4. **non-maximum suppression** across all templates; the runner-up template at the same place
   is kept for the *margin*.

Regions excluded: legend tables (and their symbols), fixture tables, the title block.
"""

from __future__ import annotations

import math
from collections.abc import Callable
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
TERMINATOR_MM = 0.8  # a filled path this small is a leader's dot / arrowhead, not symbol ink
RUN_ON_MM = 1.0  # a leader's path reaches at least this far past the posed symbol box
# Sprint 11 (Worker-Accuracy): a "more specific" drawing may replace a kept one only when the strokes it adds are
# really drawn here — at least this share of its points that the kept drawing does not explain lie on ink
EXTRA_ON_INK = 0.6
EXTRA_MIN_SHARE = 0.03  # fewer added points than this share of the drawing: nothing to check
EXTRA_INK_TOL = 0.35  # mm
EXPLODED_FILL = 6  # filled paths in one legend drawing from which its solid counts as exploded
EXPLODED_FILL_BAND = 0.4  # share of the template's solid area that an exploded instance may differ by
INK_CELL = 0.2  # mm: grid on which a drawing's distinct ink is counted (an exploded fill repeats the same strokes)
RING_YIELD = 0.5  # Sprint 10: a ring family yields to a containing, more specific drawing within this quality gap


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
    # Sprint 8: per kept segment — part of a leader terminator (tiny filled path); a straight segment of a
    # straight-line path that ends on a terminator (a leader's last leg); its path's bbox. None = every ink counts
    seg_terminator: np.ndarray | None = None
    seg_leader_end: np.ndarray | None = None
    seg_path_box: np.ndarray | None = None

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
    # leader terminators / straight polylines (Sprint 8, see :func:`reverse`)
    box = vs.path_bbox.astype(np.float64)
    dim = np.maximum(box[:, 2] - box[:, 0], box[:, 3] - box[:, 1])
    terminator = (vs.path_fill_mode > 0) & (dim <= TERMINATOR_MM)
    curved = np.zeros(vs.n_paths, bool)
    if len(vs.seg_kind):
        curved[np.unique(vs.seg_path[vs.seg_kind != 0])] = True
    sp = vs.seg_path[ids] if len(ids) else np.zeros(0, dtype=np.int64)
    leader_end = np.zeros(len(ids), bool)
    tp = np.where(terminator)[0]
    if len(tp) and len(ids):
        tt = cKDTree(np.column_stack([(box[tp, 0] + box[tp, 2]) / 2, (box[tp, 1] + box[tp, 3]) / 2]))
        cand = ~curved[sp] & ~terminator[sp]
        d0, _ = tt.query(segs[:, :2], k=1, distance_upper_bound=TERMINATOR_MM)
        d1, _ = tt.query(segs[:, 2:], k=1, distance_upper_bound=TERMINATOR_MM)
        leader_end = cand & (np.isfinite(d0) | np.isfinite(d1))
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
        seg_terminator=terminator[sp],
        seg_leader_end=leader_end,
        seg_path_box=box[sp],
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
        # Sprint 10 (Perf): a scene point farther than CAP_MM · scale is capped to CAP_MM below anyway, so the search
        # stops there (was 3 · CAP_MM for every pose; same values, ~3x fewer KD nodes visited on dense sheets)
        bound = CAP_MM * min(3.0, float(scales[sl].max()))
        d, _ = scene.tree.query(q.reshape(-1, 2), k=1, distance_upper_bound=bound)
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
    if len(idx) and scene.seg_terminator is not None and scene.seg_leader_end is not None and scene.seg_path_box is not None:
        ps = scene.pt_seg[idx]
        corners = np.array([[-tpl.w / 2, -tpl.h / 2], [tpl.w / 2, -tpl.h / 2], [tpl.w / 2, tpl.h / 2], [-tpl.w / 2, tpl.h / 2]])
        q = corners @ mat.T + center
        x0, y0 = q.min(axis=0) - RUN_ON_MM
        x1, y1 = q.max(axis=0) + RUN_ON_MM
        pb = scene.seg_path_box[ps]
        runs_on = scene.seg_leader_end[ps] & ((pb[:, 0] < x0) | (pb[:, 1] < y0) | (pb[:, 2] > x1) | (pb[:, 3] > y1))
        idx = idx[~(scene.seg_terminator[ps] | runs_on)]
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
    found = 0.0
    pieces = 0
    if scene.fill_tree is not None:
        idx = scene.fill_tree.query_ball_point(center, 0.5 * tpl.diag * scale + 0.2)
        if idx:
            idx = np.asarray(idx)
            q = (scene.fill_xy[idx] - center) @ np.linalg.inv(mat).T
            inside = (np.abs(q[:, 0]) <= tpl.w / 2 + 0.1) & (np.abs(q[:, 1]) <= tpl.h / 2 + 0.1)
            found = float(scene.fill_area[idx][inside].sum()) / max(scale * scale, 1e-9)
            pieces = int(inside.sum())
    diff = abs(found - tpl.fill_area)
    n_tpl = getattr(tpl, "fill_pieces", 0)
    if n_tpl >= EXPLODED_FILL and pieces >= EXPLODED_FILL and pieces != n_tpl:
        # Sprint 11: a solid exported as many small filled pieces, cut differently here than in the legend (another
        # number of pieces — Rubel / Yahav cameras: 8.0 mm² in the legend, 5.6–10.4 mm² on the plan): only a
        # difference beyond the band says "another drawing". A copy cut the same way (same pieces) is compared
        # exactly, as before — the power / 3-phase sockets' half discs.
        diff = max(0.0, diff - EXPLODED_FILL_BAND * tpl.fill_area)
    return diff / max(tpl.w * tpl.h, 1e-6)


def quality(fwd: float, cov: float, rev: float, rev_cov: float, fill_diff: float = 0.0) -> float:
    """0..1 geometric agreement (1 = the template sits exactly on the strokes, no extra ink)."""
    q_f = max(0.0, 1.0 - fwd / 0.3) * min(1.0, cov / 0.97)
    q_r = max(0.0, 1.0 - rev / 0.3) * min(1.0, rev_cov / 0.9)
    return float((0.6 * q_f + 0.4 * q_r) * max(0.0, 1.0 - 4.0 * fill_diff))


def spot_template(
    tpl: Template, scene: Scene, scale: float = 1.0, accept: Callable[[Candidate], bool] | None = None
) -> list[Candidate]:
    """``accept`` (Sprint 10 (Perf)): the pose veto of :func:`spot`, applied before the reverse fit — it may only
    read the pose (``tpl``, ``center``, ``mat``, ``scale``) and the forward fit (``fwd``, ``cov``)."""
    centers, mats, scales = propose(tpl, scene, scale)
    if len(centers) == 0:
        return []
    fwd, cov = forward(tpl, scene, centers, mats, scales)
    ok = np.where(cov >= MIN_FWD_COV)[0]
    out: list[Candidate] = []
    for i in ok[np.argsort(-cov[ok])][:5000]:
        c = Candidate(tpl, (float(centers[i][0]), float(centers[i][1])), mats[i], float(scales[i]), float(fwd[i]), float(cov[i]))
        # Sprint 10 (Perf): the veto first — on a sheet with a survey underlay it rejects ~80 % of the poses, whose
        # reverse fit was the largest single cost of `understand` (Rubel ground floors: parse_cpu_limit)
        if accept is not None and not accept(c):
            continue
        c.rev, c.rev_cov = reverse(tpl, scene, centers[i], mats[i], float(scales[i]))
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


def _ink_cells(t: Template) -> int:
    """Distinct ink of a template: occupied :data:`INK_CELL` cells of its points (cached on the template)."""
    n = getattr(t, "_ink_cells", None)
    if n is None:
        n = len(np.unique(np.round(np.asarray(t.pts) / INK_CELL).astype(np.int64), axis=0)) if len(t.pts) else 0
        try:
            t._ink_cells = n  # type: ignore[attr-defined]
        except AttributeError:  # pragma: no cover - slotted / frozen template
            pass
    return int(n)


def _extra_on_ink(pc: np.ndarray, tk: cKDTree, scene: Scene | None, tol: float) -> float:
    """Share of the posed points ``pc`` that the kept drawing (``tk``) does not explain and that lie on scene ink.
    1.0 when there is no scene or (almost) nothing is added."""
    if scene is None or scene.n == 0 or len(pc) == 0:
        return 1.0
    # distinct ink again: the added strokes are few points beside an exploded fill's thousands
    cells = np.unique(np.round(pc / INK_CELL).astype(np.int64), axis=0) * INK_CELL
    extra = cells[tk.query(cells, k=1, distance_upper_bound=2 * tol)[0] > 2 * tol]
    if len(extra) < EXTRA_MIN_SHARE * len(cells):
        return 1.0
    return float((scene.tree.query(extra, k=1, distance_upper_bound=EXTRA_INK_TOL)[0] <= EXTRA_INK_TOL).mean())


def _nms(
    cands: list[Candidate], min_quality: float, passive: frozenset[str] = frozenset(), scene: Scene | None = None
) -> list[Candidate]:
    """Non-maximum suppression on *shared strokes*, not on centre distance.

    Two candidates are the same instance when ≥ 50 % of either one's posed template lies on the
    other's (a 2-way switch contains the strokes of a single switch; two switches of a bank 2 mm
    apart share none, so both survive). Of two overlapping candidates the more specific template —
    clearly more strokes, all of the other's explained — wins unless its fit is much worse; the
    loser's quality becomes the winner's runner-up (→ margin).

    ``passive`` (Sprint 10): template ids of classless *markers* ("ראה הערה" cross, "מוגן מים" mark). They only
    annotate, so they never suppress a class-bearing symbol: they are taken after every other candidate, never
    replace a kept one, and still count as its runner-up (a marker that fits better leaves a negative margin →
    "דומה לסמל אחר"). Yahav: a power socket's stem + ticks fitted the "+" of the see-note cross a little better, and
    the socket was lost.

    ``scene`` (Sprint 11): with it, the more specific template replaces a kept one only when its *added* strokes are
    on ink (:data:`EXTRA_ON_INK`). Rubel: a plain ceiling point (circle + cross) was replaced by "point + fan" — the
    same drawing plus a thin box that is 6 % of its points, so its fit stayed within the slack — 41 fans for 6."""
    cands = sorted(cands, key=lambda c: (c.tpl.id in passive, -c.quality))
    kept: list[Candidate] = []
    trees: list[cKDTree] = []
    # Sprint 10 (Perf): per kept candidate its posed points, centre and half diagonal, so the centre-distance test is
    # one numpy expression and the posed points are not recomputed for every overlap (same order, same results)
    posed: list[np.ndarray] = []
    kxy = np.zeros((0, 2))
    khalf = np.zeros(0)
    tol = 0.25
    for c in cands:
        pc = _posed(c)
        tc: cKDTree | None = None
        hit = None
        if kept:
            dist = np.hypot(kxy[:, 0] - c.center[0], kxy[:, 1] - c.center[1])
            near = np.flatnonzero(dist <= 0.5 * c.tpl.diag * c.scale + khalf + 1e-9)  # loose: the scalar test decides
        else:
            near = np.zeros(0, dtype=np.int64)
        for k in near.tolist():
            kc, tk = kept[k], trees[k]
            reach = 0.5 * (c.tpl.diag * c.scale + kc.tpl.diag * kc.scale)
            if math.hypot(c.center[0] - kc.center[0], c.center[1] - kc.center[1]) > reach:
                continue  # the exact scalar test, as before (the numpy prefilter only narrows the loop)
            # Sprint 11: a solid made of many filled pieces fits anywhere inside itself (its own points land on fill
            # ink), and such shifted poses share < 50 % of their points with the right one: two poses of the same
            # exploded drawing whose boxes overlap are one instance (Rubel: 2–3 cameras per camera)
            if (
                c.tpl.id == kc.tpl.id
                and getattr(c.tpl, "fill_pieces", 0) >= EXPLODED_FILL
                and math.hypot(c.center[0] - kc.center[0], c.center[1] - kc.center[1]) < c.tpl.size * max(c.scale, kc.scale)
            ):
                hit = (k, 1.0, 1.0)
                break
            share_c = float((tk.query(pc, k=1, distance_upper_bound=tol)[0] <= tol).mean())
            if tc is None:
                tc = cKDTree(pc)
            share_k = float((tc.query(posed[k], k=1, distance_upper_bound=tol)[0] <= tol).mean())
            if share_c >= 0.5 or share_k >= 0.5:
                hit = (k, share_c, share_k)
                break
        if hit is None:
            if c.quality >= min_quality:
                kept.append(c)
                trees.append(tc if tc is not None else cKDTree(pc))
                posed.append(pc)
                kxy = np.vstack([kxy, [c.center]])
                khalf = np.append(khalf, 0.5 * c.tpl.diag * c.scale)
            continue
        k, share_c, share_k = hit
        kc = kept[k]
        # Sprint 11: "clearly more strokes" counts distinct ink, not sample points — a disc whose fill is exploded
        # into many small paths has thousands of points on the same ink (Rubel: the wall light, 3757 points / 339
        # cells, was "more specific" than the ceiling point, 2403 / 319, and took 61 + 38 of them)
        more_specific = _ink_cells(c.tpl) >= 1.25 * _ink_cells(kc.tpl) and share_k >= 0.7
        # Sprint 10: a bare ring (circled-letter family) fits every circle; a drawing that contains the ring and
        # explains more ink (a camera: circle + cone) wins whenever it fits acceptably
        slack = RING_YIELD if getattr(kc.tpl, "ring", None) is not None else 0.15
        if (
            c.tpl.id != kc.tpl.id
            and more_specific
            and c.tpl.id not in passive
            and c.quality >= max(min_quality, kc.quality - slack)
            and _extra_on_ink(pc, trees[k], scene, tol) >= EXTRA_ON_INK
        ):
            c.runner_up, c.runner_up_id = kc.quality, kc.tpl.id
            kept[k] = c
            trees[k] = tc if tc is not None else cKDTree(pc)
            posed[k] = pc
            kxy[k] = c.center
            khalf[k] = 0.5 * c.tpl.diag * c.scale
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


def spot(
    templates: list[Template],
    scene: Scene,
    *,
    min_quality: float = 0.45,
    accept: Callable[[Candidate], bool] | None = None,
    passive: frozenset[str] = frozenset(),
) -> SpotResult:
    """``accept``: a per-candidate veto applied *before* NMS (Sprint 10: colour consistency), so a rejected
    candidate never suppresses the right template at the same place. It sees the pose and the forward fit only
    (it runs before the reverse fit, see :func:`spot_template`)."""
    res = SpotResult()

    def run(scale: float) -> list[Candidate]:
        out: list[Candidate] = []
        for t in templates:
            out.extend(spot_template(t, scene, scale, accept))
        return out

    cands = run(1.0)
    strong = sum(1 for c in cands if c.quality >= 0.7)
    if strong < 2:  # the legend may be drawn at another size than the plan symbols
        k = estimate_scale(templates, scene)
        if k is not None and abs(math.log2(k)) > 0.15:
            alt = run(k)
            if sum(1 for c in alt if c.quality >= 0.7) > strong:
                cands, res.scale, res.scale_estimated = alt, k, True
    res.detections = _nms(cands, min_quality, passive, scene)
    return res
