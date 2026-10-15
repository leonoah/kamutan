"""Sanitary fixtures from their drawn shapes (the furniture pen).

On the sample sheets fixtures, furniture and stairs are drawn with a thin grey pen (152, 0.21 mm) — often
exploded into one tiny path per arc piece (the SHX text heuristic flags them as text, so *text paths are not
excluded here*). Pipeline:

1. **ink**: stroked, solid, thin (< 0.35 mm), grey pens (r = g = b, 90–235) inside the drawing regions;
2. **components**: segments within 0.08 mm of each other (STRtree) → connected components; each component
   also knows the smaller components lying inside its box (*children*: a seat inside a bowl, a drum inside
   a washer, a drain inside a tray);
3. **features** in real metres (region scale): oriented box L × W, curved share of the ink, hull fill
   (hull area / L·W: ellipse ≈ 0.79, D-shape ≈ 0.9, rectangle 1), diagonals (an "X" across the box),
   a round child (circle) and inner loops;
4. **rules** (``SHAPE_RULES`` below) → candidates with a score; overlapping candidates are resolved by score
   and a fixture is never inside another fixture (the seat ring of a WC is not a basin).

WC type from the shape alone: a tank (a straight-edged box ≥ 0.12 m deep across the back of the bowl, the
bowl being ≤ 60 % of the length) → monoblock, else concealed — always with ``סוג אסלה לפי צורה`` (yellow);
plumbing labels ("מרכז ניאגרה" / "מונובלוק") decide when present.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field

import numpy as np
import shapely
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from shapely.geometry import MultiPoint, Polygon

from ..ingest.pdf_vector import SEG_BEZIER, VectorSheet
from ..types_sprint2 import BBox
from .leaders import is_furniture_grey
from .model import R_WC_TYPE_SHAPE

JOIN_MM = 0.08
MAX_PEN_MM = 0.35
MIN_SIZE_M = 0.18
MAX_SIZE_M = 2.1


@dataclass
class Component:
    idx: np.ndarray  # segment rows (into the ink arrays)
    segs: np.ndarray  # (k,4) paper mm
    curved: np.ndarray  # (k,) bool
    box: tuple[float, float, float, float]
    children: list[Component] = field(default_factory=list)
    # features (metres) filled by :func:`features`
    L: float = 0.0
    W: float = 0.0
    angle: float = 0.0  # direction of the long side, degrees
    center: tuple[float, float] = (0.0, 0.0)
    curved_share: float = 0.0
    hull_fill: float = 0.0
    diagonals: int = 0
    round_child: float = 0.0  # diameter (m) of the largest round child, 0 when none
    rect: Polygon | None = None

    @property
    def length_mm(self) -> float:
        s = self.segs
        return float(np.hypot(s[:, 2] - s[:, 0], s[:, 3] - s[:, 1]).sum())


@dataclass
class ShapeHit:
    cls: str
    comp: Component
    score: float
    reasons: list[str] = field(default_factory=list)
    annotations: list[str] = field(default_factory=list)

    @property
    def center(self) -> tuple[float, float]:
        return self.comp.center

    @property
    def bbox(self) -> BBox:
        return BBox.from_xyxy(self.comp.box)


def furniture_segments(
    vs: VectorSheet, boxes: Sequence[tuple[float, float, float, float]], *, with_paths: bool = False
) -> tuple[np.ndarray, np.ndarray] | tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(segments (m,4), curved flags (m,)[, path index (m,)]) of the furniture pen inside the given boxes."""
    if vs.n_segs == 0:
        return (np.zeros((0, 4)), np.zeros(0, bool), np.zeros(0, int)) if with_paths else (np.zeros((0, 4)), np.zeros(0, bool))
    solid = np.array([len(d) == 0 for d in vs.path_dash], bool)
    pm = vs.path_stroked & solid & (vs.path_width_mm < MAX_PEN_MM) & is_furniture_grey(vs.path_stroke_rgba[:, :3])
    if not pm.any():
        return (np.zeros((0, 4)), np.zeros(0, bool), np.zeros(0, int)) if with_paths else (np.zeros((0, 4)), np.zeros(0, bool))
    sm = pm[vs.seg_path]
    s = vs.segs[sm].astype(np.float64)
    kind = vs.seg_kind[sm]
    path = vs.seg_path[sm]
    nseg = vs.path_seg_count[path]
    ln = np.hypot(s[:, 2] - s[:, 0], s[:, 3] - s[:, 1])
    # flattened arcs: bezier pieces, or many short pieces of one polyline
    curved = (kind == SEG_BEZIER) | ((ln < 0.6) & (nseg >= 8))
    inb = np.zeros(len(s), bool)
    cx, cy = (s[:, 0] + s[:, 2]) / 2, (s[:, 1] + s[:, 3]) / 2
    for x0, y0, x1, y1 in boxes:
        inb |= (cx >= x0) & (cx <= x1) & (cy >= y0) & (cy <= y1)
    keep = inb & (ln > 1e-3)
    if with_paths:
        return s[keep], curved[keep], path[keep]
    return s[keep], curved[keep]


def components(segs: np.ndarray, curved: np.ndarray, mm_per_m: float) -> list[Component]:
    if len(segs) == 0:
        return []
    lines = np.asarray(shapely.linestrings(segs.reshape(-1, 2, 2)))
    tree = shapely.STRtree(lines)
    a, b = tree.query(lines, predicate="dwithin", distance=JOIN_MM)
    n = len(segs)
    g = coo_matrix((np.ones(len(a)), (a, b)), shape=(n, n))
    nc, lab = connected_components(g, directed=False)
    order = np.argsort(lab, kind="stable")
    bounds = np.searchsorted(lab[order], np.arange(nc + 1))
    out: list[Component] = []
    lo, hi = MIN_SIZE_M * mm_per_m * 0.5, MAX_SIZE_M * mm_per_m * 1.5
    for c in range(nc):
        idx = order[bounds[c] : bounds[c + 1]]
        s = segs[idx]
        xs = np.concatenate([s[:, 0], s[:, 2]])
        ys = np.concatenate([s[:, 1], s[:, 3]])
        box = (float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max()))
        ext = max(box[2] - box[0], box[3] - box[1])
        if ext < 0.05 * mm_per_m or ext > hi:
            continue
        out.append(Component(idx=idx, segs=s, curved=curved[idx], box=box))
    # children: smaller components inside a component's box
    out.sort(key=lambda c: (c.box[2] - c.box[0]) * (c.box[3] - c.box[1]), reverse=True)
    boxes = np.array([c.box for c in out]) if out else np.zeros((0, 4))
    for i, comp in enumerate(out):
        if max(comp.box[2] - comp.box[0], comp.box[3] - comp.box[1]) < lo:
            continue
        x0, y0, x1, y1 = comp.box
        inside = (boxes[:, 0] >= x0 - 0.2) & (boxes[:, 1] >= y0 - 0.2) & (boxes[:, 2] <= x1 + 0.2) & (boxes[:, 3] <= y1 + 0.2)
        inside[i] = False
        comp.children = [out[j] for j in np.where(inside)[0] if j > i]
    return out


def _is_round(c: Component, mm_per_m: float) -> float:
    """Diameter in metres if the component is a circle-like ring, else 0."""
    w, h = c.box[2] - c.box[0], c.box[3] - c.box[1]
    if min(w, h) <= 0 or max(w, h) / min(w, h) > 1.2:
        return 0.0
    ln = np.hypot(c.segs[:, 2] - c.segs[:, 0], c.segs[:, 3] - c.segs[:, 1])
    if ln.sum() <= 0 or float(ln[c.curved].sum() / ln.sum()) < 0.7:
        return 0.0
    perim = math.pi * (w + h) / 2
    if not (0.7 * perim <= ln.sum() <= 1.6 * perim):
        return 0.0
    return float((w + h) / 2 / mm_per_m)


def features(c: Component, mm_per_m: float) -> None:
    s = c.segs
    pts = np.concatenate([s[:, :2], s[:, 2:]])
    mp = MultiPoint([tuple(p) for p in pts[:: max(1, len(pts) // 400)]] + [tuple(pts[i]) for i in (0, -1)])
    hull = mp.convex_hull
    rr = hull.minimum_rotated_rectangle
    if not isinstance(rr, Polygon) or rr.is_empty or rr.area <= 0:
        x0, y0, x1, y1 = c.box
        rr = shapely.box(x0, y0, max(x1, x0 + 1e-3), max(y1, y0 + 1e-3))
    xy = np.asarray(rr.exterior.coords)[:4]
    e0, e1 = xy[1] - xy[0], xy[2] - xy[1]
    l0, l1 = float(np.hypot(*e0)), float(np.hypot(*e1))
    long_e = e0 if l0 >= l1 else e1
    c.L, c.W = max(l0, l1) / mm_per_m, min(l0, l1) / mm_per_m
    c.angle = math.degrees(math.atan2(long_e[1], long_e[0])) % 180.0
    cen = rr.centroid
    c.center = (float(cen.x), float(cen.y))
    c.rect = rr
    ln = np.hypot(s[:, 2] - s[:, 0], s[:, 3] - s[:, 1])
    c.curved_share = float(ln[c.curved].sum() / max(ln.sum(), 1e-9))
    c.hull_fill = float(hull.area / max(rr.area, 1e-9)) if isinstance(hull, Polygon) else 0.0
    # diagonals: straight pieces along either diagonal of the oriented box covering ≥ 60 % of it
    diag = 0
    for a, b in ((xy[0], xy[2]), (xy[1], xy[3])):
        d = b - a
        dl = float(np.hypot(*d))
        if dl <= 0:
            continue
        u = d / dl
        nrm = np.array([-u[1], u[0]])
        st = ~c.curved
        p0, p1 = s[st, :2] - a, s[st, 2:] - a
        off = np.maximum(np.abs(p0 @ nrm), np.abs(p1 @ nrm))
        along = np.abs((p1 - p0) @ u)
        cover = along[off < 0.02 * dl + 0.15].sum()
        if cover >= 0.6 * dl:
            diag += 1
    c.diagonals = diag
    c.round_child = max([_is_round(ch, mm_per_m) for ch in c.children] + [0.0])


def _between(v: float, lo: float, hi: float) -> bool:
    return lo <= v <= hi


def classify(c: Component, mm_per_m: float) -> list[ShapeHit]:
    """Candidate classes of one component (several may fire; the caller keeps the best)."""
    L, W = c.L, c.W
    if W <= 0:
        return []
    asp = L / W
    hits: list[ShapeHit] = []
    rnd = _is_round(c, mm_per_m)
    # washing machine: ~0.6 m square with a drum (circle) inside (a child ring, or curved ink of its own)
    square = _between(L, 0.5, 0.78) and _between(W, 0.48, 0.75) and asp <= 1.2 and c.hull_fill >= 0.93
    if square and (c.round_child >= 0.4 * W or _between(c.curved_share, 0.12, 0.6)):
        hits.append(ShapeHit("fixture_washing_machine", c, 0.72))
    # shower tray: square-ish box 0.7–1.4 m with an X (and often a drain circle)
    if _between(L, 0.7, 1.5) and _between(W, 0.65, 1.2) and asp <= 1.6 and c.diagonals >= 2 and c.hull_fill >= 0.9:
        sc = 0.62 + (0.1 if c.round_child > 0 else 0.0)
        hits.append(ShapeHit("fixture_shower", c, sc))
    # bath: 1.4–2.0 × 0.6–0.95 m box with a rounded inner tub
    if _between(L, 1.35, 2.05) and _between(W, 0.5, 0.98) and _between(asp, 1.5, 3.2) and c.hull_fill >= 0.88:
        tub = any(
            ch.curved.any() and max(ch.box[2] - ch.box[0], ch.box[3] - ch.box[1]) >= 0.6 * L * mm_per_m for ch in c.children
        )
        if 0.08 <= c.curved_share <= 0.6 or tub:
            hits.append(ShapeHit("fixture_bath", c, 0.7))
    # basin: oval / round bowl 0.3–0.7 m
    if rnd == 0.0 and _between(L, 0.28, 0.75) and _between(W, 0.22, 0.62) and asp <= 1.75 and c.curved_share >= 0.55:
        if _between(c.hull_fill, 0.7, 0.86):
            hits.append(ShapeHit("fixture_basin", c, 0.72))
    elif rnd and _between(rnd, 0.3, 0.6):
        hits.append(ShapeHit("fixture_basin", c, 0.6))
    # WC: elongated bowl 0.45–0.85 × 0.3–0.52 m, partly curved (bowl) and partly straight (back / tank)
    bowl = _between(L, 0.45, 0.85) and _between(W, 0.28, 0.52) and _between(asp, 1.2, 2.3)
    if bowl and _between(c.curved_share, 0.15, 0.9) and c.hull_fill >= 0.78:
        mono = _has_tank(c, mm_per_m)
        hits.append(ShapeHit("fixture_wc_monoblock" if mono else "fixture_wc_concealed", c, 0.66, reasons=[R_WC_TYPE_SHAPE]))
    # kitchen sink: box 0.4–1.25 × 0.38–0.66 m with a drain (small ring) and a little curved ink (bowl corners)
    if _between(L, 0.4, 1.25) and _between(W, 0.38, 0.66) and c.hull_fill >= 0.9 and c.diagonals == 0:
        drains = [_is_round(ch, mm_per_m) for ch in c.children]
        if any(0.03 <= d <= 0.15 for d in drains) and c.curved_share <= 0.5:
            hits.append(ShapeHit("fixture_kitchen_sink", c, 0.6))
    return hits


def _has_tank(c: Component, mm_per_m: float) -> bool:
    """A straight-edged tank box across one end of the bowl: straight ink concentrated in one end band
    (≥ 0.12 m deep) spanning ≥ 70 % of the width while the other end is curved."""
    if c.rect is None:
        return False
    xy = np.asarray(c.rect.exterior.coords)[:4]
    e0, e1 = xy[1] - xy[0], xy[2] - xy[1]
    u = e0 / np.hypot(*e0) if np.hypot(*e0) >= np.hypot(*e1) else e1 / np.hypot(*e1)
    s = c.segs
    mid = (s[:, :2] + s[:, 2:]) / 2
    t = (mid - np.array(c.center)) @ u
    half = c.L * mm_per_m / 2
    ln = np.hypot(s[:, 2] - s[:, 0], s[:, 3] - s[:, 1])
    best = False
    for sign in (1.0, -1.0):
        band = sign * t >= half - 0.22 * mm_per_m
        other = sign * t <= -(half - 0.25 * mm_per_m)
        st = band & ~c.curved
        # straight ink across the width inside the band
        d = s[st, 2:] - s[st, :2]
        across = np.abs(d @ np.array([-u[1], u[0]])).sum()
        if across >= 1.4 * c.W * mm_per_m and ln[other & c.curved].sum() > 0.3 * ln[other].sum() + 1e-9:
            best = True
    return best and c.L >= 0.62


def _circles(segs: np.ndarray, curved: np.ndarray, paths: np.ndarray, mm_per_m: float) -> list[tuple[float, float, float]]:
    """(cx, cy, r) paper mm of full circles drawn as curved runs of one path (r 0.12–0.27 m: washer drums)."""
    out: list[tuple[float, float, float]] = []
    idx = np.where(curved)[0]
    if not len(idx):
        return out
    order = idx[np.argsort(paths[idx], kind="stable")]
    pp = paths[order]
    cuts = np.flatnonzero(np.diff(pp)) + 1
    for grp in np.split(order, cuts):
        if len(grp) < 8:
            continue
        pts = np.concatenate([segs[grp, :2], segs[grp, 2:]])
        x, y = pts[:, 0], pts[:, 1]
        a = np.stack([x, y, np.ones_like(x)], 1)
        sol, *_ = np.linalg.lstsq(a, x * x + y * y, rcond=None)
        cx, cy = sol[0] / 2, sol[1] / 2
        r = float(np.sqrt(max(sol[2] + cx * cx + cy * cy, 0.0)))
        if not (0.12 * mm_per_m <= r <= 0.27 * mm_per_m):
            continue
        if float(np.abs(np.hypot(x - cx, y - cy) - r).max()) > 0.06 * r:
            continue
        ang = np.sort(np.degrees(np.arctan2(y - cy, x - cx)) % 360.0)
        gaps = np.diff(np.concatenate([ang, [ang[0] + 360.0]]))
        if gaps.max() > 60.0:
            continue
        out.append((float(cx), float(cy), r))
    return out


def _square_around(cx: float, cy: float, r: float, segs: np.ndarray, curved: np.ndarray, mm_per_m: float) -> Component | None:
    """A 0.5–0.8 m square box (axis of the nearby straight ink) around a drum circle → washer component."""
    st = ~curved
    s = segs[st]
    mid = (s[:, :2] + s[:, 2:]) / 2
    near = np.hypot(mid[:, 0] - cx, mid[:, 1] - cy) <= 0.6 * mm_per_m
    s = s[near]
    if len(s) < 4:
        return None
    d = s[:, 2:] - s[:, :2]
    ln = np.hypot(d[:, 0], d[:, 1])
    ok = ln >= 0.3 * mm_per_m
    s, d, ln = s[ok], d[ok], ln[ok]
    if len(s) < 4:
        return None
    ang = np.degrees(np.arctan2(d[:, 1], d[:, 0])) % 90.0
    for th in np.unique(np.round(ang / 3.0) * 3.0):
        u = np.array([math.cos(math.radians(th)), math.sin(math.radians(th))])
        v = np.array([-u[1], u[0]])
        sides = []
        for axis, other in ((u, v), (v, u)):
            par = np.abs((d / ln[:, None]) @ axis) >= 0.97
            off = ((s[:, :2] + s[:, 2:]) / 2 - np.array([cx, cy])) @ other
            lo, hi = 0.22 * mm_per_m, 0.42 * mm_per_m
            pos = par & (off >= lo) & (off <= hi)
            neg = par & (off <= -lo) & (off >= -hi)
            if not (pos.any() and neg.any()):
                break
            sides.append((float(off[pos].min()), float(off[neg].max())))
        if len(sides) == 2:
            (a1, a0), (b1, b0) = sides  # offsets along v (for u-parallel sides) and along u
            corners = [np.array([cx, cy]) + u * bu + v * av for bu, av in ((b0, a0), (b1, a0), (b1, a1), (b0, a1))]
            xs = [p[0] for p in corners]
            ys = [p[1] for p in corners]
            comp = Component(
                idx=np.zeros(0, int), segs=s, curved=np.zeros(len(s), bool), box=(min(xs), min(ys), max(xs), max(ys))
            )
            side_u, side_v = (b1 - b0) / mm_per_m, (a1 - a0) / mm_per_m
            comp.L, comp.W = max(side_u, side_v), min(side_u, side_v)
            comp.center = (float(np.mean(xs)), float(np.mean(ys)))
            comp.angle = th
            comp.rect = Polygon([tuple(p) for p in corners])
            comp.hull_fill = 1.0
            comp.round_child = 2 * r / mm_per_m
            if comp.L <= 0.8 and comp.W >= 0.48 and comp.L / max(comp.W, 1e-6) <= 1.25:
                return comp
    return None


def detect_shapes(vs: VectorSheet, boxes: Sequence[tuple[float, float, float, float]], mm_per_m: float) -> list[ShapeHit]:
    segs, curved, paths = furniture_segments(vs, boxes, with_paths=True)  # type: ignore[misc]
    comps = components(segs, curved, mm_per_m)
    hits: list[ShapeHit] = []
    for c in comps:
        if max(c.box[2] - c.box[0], c.box[3] - c.box[1]) < MIN_SIZE_M * mm_per_m:
            continue
        features(c, mm_per_m)
        if c.L > MAX_SIZE_M:
            continue
        hits.extend(classify(c, mm_per_m))
    # washers whose square is merged into a larger furniture network (niche outlines): drum circle + square
    for cx, cy, r in _circles(segs, curved, paths, mm_per_m):
        if any(h.cls == "fixture_washing_machine" and math.dist(h.center, (cx, cy)) < 0.2 * mm_per_m for h in hits):
            continue
        sq = _square_around(cx, cy, r, segs, curved, mm_per_m)
        if sq is not None:
            hits.append(ShapeHit("fixture_washing_machine", sq, 0.68))
    return resolve(hits)


CROSS_ARM_MM = (2.5, 8.0)  # paper mm: a plumbing point mark "+" (two single strokes crossing at their middles)


def cross_marks(vs: VectorSheet, boxes: Sequence[tuple[float, float, float, float]]) -> list[tuple[float, float]]:
    """Centres of "+" point marks (paper mm): two dark single-segment paths, perpendicular, 2.5–8 mm long, crossing
    at their midpoints (± 0.4 mm). Plumbing sheets mark each drain / water point with one (AC drains, sinks); the
    SHX heuristic flags them as text, so text paths are included on purpose."""
    if vs.n_segs == 0:
        return []
    p = vs.seg_path
    single = vs.path_seg_count[p] == 1
    dark = vs.path_stroked[p] & (vs.path_stroke_rgba[p, :3].max(axis=1) < 80)
    s = vs.segs.astype(np.float64)
    d = s[:, 2:] - s[:, :2]
    ln = np.hypot(d[:, 0], d[:, 1])
    m = single & dark & (ln >= CROSS_ARM_MM[0]) & (ln <= CROSS_ARM_MM[1]) & (vs.seg_kind != SEG_BEZIER)
    mid = (s[:, :2] + s[:, 2:]) / 2
    inb = np.zeros(len(s), bool)
    for x0, y0, x1, y1 in boxes:
        inb |= (mid[:, 0] >= x0) & (mid[:, 0] <= x1) & (mid[:, 1] >= y0) & (mid[:, 1] <= y1)
    idx = np.where(m & inb)[0]
    if len(idx) < 2:
        return []
    u = d[idx] / ln[idx, None]
    pts = np.asarray(shapely.points(mid[idx]), dtype=object)
    tree = shapely.STRtree(pts)
    a, b = tree.query(pts, predicate="dwithin", distance=0.4)
    out: list[tuple[float, float]] = []
    for i, j in zip(a, b, strict=True):
        if i >= j or abs(float(u[i] @ u[j])) > 0.1 or abs(ln[idx[i]] - ln[idx[j]]) > 1.0:
            continue
        c = (mid[idx[i]] + mid[idx[j]]) / 2
        if all(math.dist(c, q) > 0.5 for q in out):
            out.append((float(c[0]), float(c[1])))
    return out


def sink_boxes(vs: VectorSheet, boxes: Sequence[tuple[float, float, float, float]], mm_per_m: float) -> list[Component]:
    """Box-like furniture outlines sized like a sink / basin top (0.35–1.25 × 0.3–0.75 m): where a text-only sink
    note is placed when its leader is not followed."""
    segs, curved = furniture_segments(vs, boxes)  # type: ignore[misc]
    out: list[Component] = []
    for c in components(segs, curved, mm_per_m):
        if max(c.box[2] - c.box[0], c.box[3] - c.box[1]) < 0.3 * mm_per_m:
            continue
        features(c, mm_per_m)
        if _between(c.L, 0.35, 1.25) and _between(c.W, 0.3, 0.75) and c.hull_fill >= 0.85:
            out.append(c)
    return out


ENCLOSURE_L_M = (0.7, 2.0)
ENCLOSURE_W_M = (0.6, 1.5)


def enclosures(vs: VectorSheet, boxes: Sequence[tuple[float, float, float, float]], mm_per_m: float) -> list[Component]:
    """Shower-zone candidates: straight furniture-pen outlines (a glass screen / tray drawn as a rectangle, often
    open on the wall side) 0.7–2.0 × 0.6–1.5 m. The caller picks the one in the shower's room nearest its note."""
    segs, curved = furniture_segments(vs, boxes)  # type: ignore[misc]
    out: list[Component] = []
    for c in components(segs, curved, mm_per_m):
        w, h = c.box[2] - c.box[0], c.box[3] - c.box[1]
        if max(w, h) < ENCLOSURE_L_M[0] * mm_per_m:
            continue
        features(c, mm_per_m)
        if not (_between(c.L, *ENCLOSURE_L_M) and _between(c.W, *ENCLOSURE_W_M)):
            continue
        if c.curved_share > 0.35 or c.L / max(c.W, 1e-6) > 2.2:
            continue
        # an outline, not a hatch: its ink is about the box perimeter (3–4 sides + a drain / X at most)
        if c.length_mm > 2.6 * (c.L + c.W) * mm_per_m * 2:
            continue
        out.append(c)
    return out


def resolve(hits: list[ShapeHit]) -> list[ShapeHit]:
    """Best class per component; then no fixture inside (or mostly overlapping) a better / larger one."""
    best: dict[int, ShapeHit] = {}
    for h in hits:
        k = id(h.comp)
        if k not in best or h.score > best[k].score:
            best[k] = h
    cands = sorted(best.values(), key=lambda h: (-(h.comp.L * h.comp.W), -h.score))
    kept: list[ShapeHit] = []
    for h in cands:
        x0, y0, x1, y1 = h.comp.box
        cx, cy = h.center
        clash = False
        for kh in kept:
            a0, b0, a1, b1 = kh.comp.box
            inside = a0 - 0.5 <= cx <= a1 + 0.5 and b0 - 0.5 <= cy <= b1 + 0.5
            ov = max(0.0, min(x1, a1) - max(x0, a0)) * max(0.0, min(y1, b1) - max(y0, b0))
            if inside or ov > 0.4 * min((x1 - x0) * (y1 - y0), (a1 - a0) * (b1 - b0)):
                clash = True
                break
        if not clash:
            kept.append(h)
    return kept
