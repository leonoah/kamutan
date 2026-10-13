"""Vector glyph segmentation for SHX-stroked text.

AutoCAD exports SHX text as plain stroke paths (no text layer). Every stroke of a
letter is usually its own PDF path object, consecutive in the content stream.
This module turns the primitive soup into:

    strokes (paths) -> connected components -> text lines -> glyphs

and computes, for each glyph, a scale/translation-normalised shape signature:

* ``key``  – exact hash of the stroke set quantised to 1/``QUANT`` of the line
  height, relative to the line baseline (so ``ו`` and ``ן`` / ``'`` and ``י``
  stay distinct, which a per-glyph bbox normalisation would merge);
* ``feat`` – a small blurred bitmap (rows x cols) of the same normalised strokes,
  used for tolerant clustering when exact keys differ by rounding.

Coordinates are paper mm, y down (see ``ingest.pdf_vector``).
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

import numpy as np
from scipy.ndimage import gaussian_filter
from scipy.spatial import cKDTree

from ..ingest.pdf_vector import VectorSheet

# --- tunables (mm unless noted) ---
MAX_STROKE_EXTENT = 8.0  # a path longer than this is never part of a glyph
MAX_GLYPH_EXTENT = 8.0  # connected component larger than this is not text
TOUCH_TOL = 0.06  # strokes of one letter share endpoints (exactly, in SHX)
DENSIFY_STEP = 0.10  # sampling step for T-junction detection
QUANT = 8  # key quantisation: 1/QUANT of line height
FEAT_ROWS, FEAT_COLS = 24, 16  # bitmap: y in [-1.6, 0.8] H, x in [0, 1.6] H
FEAT_Y0, FEAT_Y1, FEAT_X1 = -1.6, 0.8, 1.6


@dataclass
class Component:
    paths: list[int]
    bbox: np.ndarray  # x0,y0,x1,y1
    style: tuple[int, int, int, float]  # r,g,b,width

    @property
    def w(self) -> float:
        return float(self.bbox[2] - self.bbox[0])

    @property
    def h(self) -> float:
        return float(self.bbox[3] - self.bbox[1])


@dataclass
class Glyph:
    comps: list[int]
    bbox: np.ndarray
    segs: np.ndarray  # (k,4) mm in *line frame* (rotated so text is horizontal)
    key: str = ""
    feat: np.ndarray | None = None
    page_bbox: np.ndarray | None = None  # page mm (x0,y0,x1,y1), unrotated
    key_v1: str = ""  # older signature (all flattened pieces), kept for the spike comparison
    cluster: int = -1
    label: str | None = None
    # stroke polylines in the line frame (bezier interiors dropped): [(has_curve, (k,2) vertices)]
    polys: list[tuple[bool, np.ndarray]] = field(default_factory=list)
    paths: list[int] = field(default_factory=list)  # VectorSheet path indices of the strokes


@dataclass
class TextLine:
    sheet: str
    glyphs: list[Glyph]
    bbox: np.ndarray  # page mm (x0,y0,x1,y1)
    baseline: float  # in line frame
    topline: float
    height: float
    rotation: int  # 0, 90 or -90: rotation applied to bring text horizontal
    style: tuple[int, int, int, float]
    text: str = ""
    meta: dict = field(default_factory=dict)


class _DSU:
    def __init__(self, n: int):
        self.p = np.arange(n)

    def find(self, a: int) -> int:
        p = self.p
        while p[a] != a:
            p[a] = p[p[a]]
            a = p[a]
        return a

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[max(ra, rb)] = min(ra, rb)


def _style_of(vs: VectorSheet, i: int) -> tuple[int, int, int, float]:
    r, g, b = (int(v) for v in vs.path_stroke_rgba[i][:3])
    return (r, g, b, round(float(vs.path_width_mm[i]), 3))


def path_segments(vs: VectorSheet, i: int) -> np.ndarray:
    s = int(vs.path_seg_start[i])
    return vs.segs[s : s + int(vs.path_seg_count[i])]


def candidate_paths(vs: VectorSheet) -> np.ndarray:
    b = vs.path_bbox
    ext = np.maximum(b[:, 2] - b[:, 0], b[:, 3] - b[:, 1])
    return np.where(vs.path_stroked & (vs.path_fill_mode == 0) & (ext < MAX_STROKE_EXTENT) & (vs.path_seg_count > 0))[0]


def connected_components(vs: VectorSheet, cand: np.ndarray | None = None) -> list[Component]:
    """Union touching strokes of the same style (colour + width)."""
    if cand is None:
        cand = candidate_paths(vs)
    pts: list[np.ndarray] = []
    owner: list[np.ndarray] = []
    for k, i in enumerate(cand):
        sg = path_segments(vs, int(i)).astype(np.float64)
        L = np.hypot(sg[:, 2] - sg[:, 0], sg[:, 3] - sg[:, 1])
        n = np.maximum(1, np.ceil(L / DENSIFY_STEP).astype(int))
        for (x0, y0, x1, y1), m in zip(sg, n):
            t = np.linspace(0.0, 1.0, m + 1)[:, None]
            pts.append(np.hstack([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]))
            owner.append(np.full(m + 1, k))
    if not pts:
        return []
    P = np.vstack(pts)
    O = np.concatenate(owner)
    styles = [_style_of(vs, int(i)) for i in cand]
    dsu = _DSU(len(cand))
    pairs = cKDTree(P).query_pairs(TOUCH_TOL, output_type="ndarray")
    if len(pairs):
        a, b = O[pairs[:, 0]], O[pairs[:, 1]]
        m = a != b
        for x, y in np.unique(np.sort(np.stack([a[m], b[m]], 1), axis=1), axis=0):
            if styles[x] == styles[y]:
                dsu.union(int(x), int(y))
    groups: dict[int, list[int]] = {}
    for k in range(len(cand)):
        groups.setdefault(dsu.find(k), []).append(k)
    # Underlines / overlines touching the letters glue a whole word into one
    # component: drop long straight horizontal strokes from wide components and redo.
    drop: set[int] = set()
    for ks in groups.values():
        if len(ks) < 2:
            continue
        ids = [int(cand[k]) for k in ks]
        bb = vs.path_bbox[ids]
        w = bb[:, 2].max() - bb[:, 0].min()
        h = bb[:, 3].max() - bb[:, 1].min()
        if w < 1.8 * h:
            continue
        here = []
        for k, i in zip(ks, ids):
            j = ids.index(i)
            pw, ph = bb[j, 2] - bb[j, 0], bb[j, 3] - bb[j, 1]
            if pw > 0.6 * w and ph < 0.05 * max(h, 1e-3) and vs.path_seg_count[i] <= 2:
                here.append(k)
        # only when real letter strokes remain ('=' or '-' pairs are not underlines)
        if here and len(here) < len(ks) and h >= 1.0:
            drop.update(here)
    if drop:
        keep = np.array([i for k, i in enumerate(cand) if k not in drop])
        return connected_components(vs, keep)
    comps = []
    for ks in groups.values():
        ids = [int(cand[k]) for k in ks]
        bb = vs.path_bbox[ids]
        bbox = np.array([bb[:, 0].min(), bb[:, 1].min(), bb[:, 2].max(), bb[:, 3].max()])
        if max(bbox[2] - bbox[0], bbox[3] - bbox[1]) >= MAX_GLYPH_EXTENT:
            continue
        comps.append(Component(paths=ids, bbox=bbox, style=styles[ks[0]]))
    return comps


def _rot_bbox(b: np.ndarray, rot: int) -> np.ndarray:
    """bbox in the frame where text rotated by ``rot`` becomes horizontal."""
    x0, y0, x1, y1 = b
    if rot == 0:
        return np.array([x0, y0, x1, y1])
    if rot == 90:  # text reads bottom->top; rotate frame clockwise: (x,y)->(-y,x)
        return np.array([-y1, x0, -y0, x1])
    # rot == -90: text reads top->bottom: (x,y)->(y,-x)
    return np.array([y0, -x1, y1, -x0])


def _rot_segs(s: np.ndarray, rot: int) -> np.ndarray:
    if rot == 0:
        return s.copy()
    x0, y0, x1, y1 = s[:, 0], s[:, 1], s[:, 2], s[:, 3]
    if rot == 90:
        return np.stack([-y0, x0, -y1, x1], 1)
    return np.stack([y0, -x0, y1, -x1], 1)


def _link_lines(boxes: np.ndarray, styles: list, max_gap_factor: float = 1.2, min_vov: float = 0.5) -> list[list[int]]:
    """Group boxes (already in line frame) into horizontal lines.

    Phase 1 links letter-sized boxes that overlap vertically and are close
    horizontally. Phase 2 attaches small marks (geresh, gershayim, dots, colon
    dots) to the single best line whose vertical band contains them, so that a
    mark can never glue two different lines (e.g. a heading and a symbol below).
    """
    n = len(boxes)
    if n == 0:
        return []
    dsu = _DSU(n)
    h = np.maximum(boxes[:, 3] - boxes[:, 1], 1e-3)
    w = boxes[:, 2] - boxes[:, 0]
    cx = (boxes[:, 0] + boxes[:, 2]) / 2
    cy = (boxes[:, 1] + boxes[:, 3]) / 2
    tree = cKDTree(np.stack([cx, cy], 1))
    r = float(np.percentile(h, 95)) * 3 + 1.0
    pairs = tree.query_pairs(r)
    small_cand: dict[int, list[int]] = defaultdict(list)
    linked = np.zeros(n, dtype=bool)
    for i, j in pairs:
        if styles[i] != styles[j]:
            continue
        hi = max(h[i], h[j])
        gap = max(boxes[i, 0], boxes[j, 0]) - min(boxes[i, 2], boxes[j, 2])
        if min(h[i], h[j]) < 0.45 * hi:
            sm, bg = (i, j) if h[i] < h[j] else (j, i)
            if w[sm] <= 0.8 * hi and gap <= 0.6 * hi and boxes[bg, 1] - 0.35 * hi <= cy[sm] <= boxes[bg, 3] + 0.15 * hi:
                small_cand[sm].append(bg)
            continue
        ov = min(boxes[i, 3], boxes[j, 3]) - max(boxes[i, 1], boxes[j, 1])
        if ov < min_vov * min(h[i], h[j]):
            continue
        if gap > max_gap_factor * hi:
            continue
        dsu.union(i, j)
        linked[i] = linked[j] = True
    # phase 2: attach each small mark to one line only (letters already in a line
    # through phase 1 are not "marks" of some bigger neighbour, e.g. a legend symbol)
    gmax: dict[int, float] = defaultdict(float)
    for k in range(n):
        r_ = dsu.find(k)
        gmax[r_] = max(gmax[r_], float(h[k]))
    for sm, bigs in small_cand.items():
        if linked[sm] and gmax[dsu.find(sm)] >= 0.45 * max(h[b] for b in bigs):
            continue  # sm is a letter of its own line, not a mark of a bigger neighbour
        best, score = None, None
        for bg in bigs:
            y0, y1 = boxes[bg, 1], boxes[bg, 3]
            out = 0.0 if y0 <= cy[sm] <= y1 else min(abs(cy[sm] - y0), abs(cy[sm] - y1)) / h[bg]
            gap = max(boxes[sm, 0], boxes[bg, 0]) - min(boxes[sm, 2], boxes[bg, 2])
            sc = (round(out, 3), max(gap, 0.0))
            if score is None or sc < score:
                best, score = bg, sc
        if best is not None:
            dsu.union(sm, best)
    groups: dict[int, list[int]] = {}
    for k in range(n):
        groups.setdefault(dsu.find(k), []).append(k)
    return list(groups.values())


def _line_metrics(boxes: np.ndarray) -> tuple[float, float, float]:
    """baseline (max y of most glyphs), topline, height in line frame (y down)."""
    h = boxes[:, 3] - boxes[:, 1]
    big = h >= 0.6 * np.percentile(h, 75)
    sel = boxes[big] if big.sum() else boxes
    base = float(np.median(sel[:, 3]))
    top = float(np.median(sel[:, 1]))
    return base, top, max(base - top, 1e-3)


def _merge_stacked(boxes: np.ndarray, H: float) -> list[list[int]]:
    """Merge components of one line that overlap horizontally (ה's leg, ק, ':', '=')."""
    order = list(np.argsort(boxes[:, 0]))
    groups: list[list[int]] = []
    gb: list[np.ndarray] = []
    for k in order:
        b = boxes[k]
        if groups:
            g = gb[-1]
            pad = 0.05 * H  # zero-width strokes (':' dots, ק/ה legs) need a margin
            ov = min(g[2], b[2]) - max(g[0], b[0]) + 2 * pad
            wmin = min(g[2] - g[0], b[2] - b[0]) + 2 * pad
            raw_gap = b[0] - g[2]
            if ov > 0.5 * wmin or raw_gap <= 0.05 * H:  # stacked, or strokes of one letter that almost touch (מ, ע)
                groups[-1].append(k)
                gb[-1] = np.array([min(g[0], b[0]), min(g[1], b[1]), max(g[2], b[2]), max(g[3], b[3])])
                continue
        groups.append([k])
        gb.append(b.copy())
    return groups


def path_polylines(vs: VectorSheet, i: int) -> list[tuple[bool, np.ndarray]]:
    """Vertices of a path's subpaths, keeping only end points of flattened beziers.

    Returns [(has_curve, (k,2) vertices)], one per continuous run.
    """
    from ..ingest.pdf_vector import BEZIER_STEPS, SEG_BEZIER

    s0 = int(vs.path_seg_start[i])
    n = int(vs.path_seg_count[i])
    segs = vs.segs[s0 : s0 + n]
    kinds = vs.seg_kind[s0 : s0 + n]
    out: list[tuple[bool, np.ndarray]] = []
    cur: list[np.ndarray] = []
    curve = False
    bez_run = 0
    last = None
    for (x0, y0, x1, y1), k in zip(segs, kinds):
        if last is not None and (abs(last[0] - x0) > 1e-4 or abs(last[1] - y0) > 1e-4):
            out.append((curve, np.array(cur)))
            cur, curve, bez_run = [], False, 0
        if not cur:
            cur.append(np.array([x0, y0]))
        if k == SEG_BEZIER:
            curve = True
            bez_run += 1
            if bez_run % BEZIER_STEPS == 0:
                cur.append(np.array([x1, y1]))
        else:
            bez_run = 0
            cur.append(np.array([x1, y1]))
        last = (x1, y1)
    if cur:
        out.append((curve, np.array(cur)))
    return out


def stroke_key(polys: list[tuple[bool, np.ndarray]], x0: float, baseline: float, H: float, quant: int = QUANT) -> str:
    """Hash of the glyph's strokes: quantised vertices of each stroke (bezier
    interiors dropped), direction-canonical, sorted. Robust to how finely
    curves were flattened and to the order strokes were emitted."""
    parts = set()
    for curve, v in polys:
        q = np.round(np.column_stack([(v[:, 0] - x0) / H, (v[:, 1] - baseline) / H]) * quant).astype(int)
        # drop consecutive duplicates created by quantisation
        keep = [0] + [k for k in range(1, len(q)) if (q[k] != q[k - 1]).any()]
        q = q[keep]
        a = tuple(map(tuple, q))
        b = tuple(reversed(a))
        t = min(a, b)
        parts.add(("c" if curve else "l") + "|".join(f"{p[0]},{p[1]}" for p in t))
    return ";".join(sorted(parts)) or "dot"


def _rot_pts(v: np.ndarray, rot: int) -> np.ndarray:
    if rot == 0:
        return v
    if rot == 90:
        return np.column_stack([-v[:, 1], v[:, 0]])
    return np.column_stack([v[:, 1], -v[:, 0]])


def glyph_signature(segs_line: np.ndarray, x0: float, baseline: float, H: float) -> tuple[str, np.ndarray]:
    s = segs_line.astype(np.float64).copy()
    s[:, [0, 2]] = (s[:, [0, 2]] - x0) / H
    s[:, [1, 3]] = (s[:, [1, 3]] - baseline) / H
    q = np.round(s * QUANT).astype(int)
    tup = set()
    for a, b, c, d in q:
        if (a, b) == (c, d):
            continue
        tup.add((a, b, c, d) if (a, b) <= (c, d) else (c, d, a, b))
    # merge collinear chains is overkill; quantised set of unit pieces is enough
    key = ";".join(",".join(map(str, t)) for t in sorted(tup)) or "dot"
    # bitmap feature
    img = np.zeros((FEAT_ROWS, FEAT_COLS), dtype=np.float32)
    sx = FEAT_COLS / FEAT_X1
    sy = FEAT_ROWS / (FEAT_Y1 - FEAT_Y0)
    for x_0, y_0, x_1, y_1 in s:
        L = max(abs(x_1 - x_0) * sx, abs(y_1 - y_0) * sy)
        n = int(np.ceil(L * 2)) + 1
        t = np.linspace(0, 1, n)
        xs = ((x_0 + (x_1 - x_0) * t) * sx).astype(int)
        ys = ((y_0 + (y_1 - y_0) * t - FEAT_Y0) * sy).astype(int)
        m = (xs >= 0) & (xs < FEAT_COLS) & (ys >= 0) & (ys < FEAT_ROWS)
        img[ys[m], xs[m]] = 1.0
    img = gaussian_filter(img, 0.8)
    nrm = np.linalg.norm(img)
    return key, (img / nrm if nrm > 0 else img).ravel()


def extract_text_lines(vs: VectorSheet, sheet: str = "") -> list[TextLine]:
    comps = connected_components(vs)
    if not comps:
        return []
    styles = [c.style for c in comps]
    used = np.zeros(len(comps), dtype=bool)
    lines: list[TextLine] = []
    # passes: horizontal lines; vertical text (tighter gaps: rotated glyphs are
    # adjacent, while a column of table numbers is widely spaced); finally
    # isolated letter-sized singletons (row numbers "1".."9", single letters).
    passes = ((0, 1.3, 2), (90, 0.6, 3), (-90, 0.6, 3), (0, 1.3, 1))
    for rot, gap_f, min_n in passes:
        idx = np.where(~used)[0]
        if len(idx) == 0:
            break
        boxes = np.array([_rot_bbox(comps[i].bbox, rot) for i in idx])
        for grp in _link_lines(boxes, [styles[i] for i in idx], max_gap_factor=gap_f):
            if len(grp) < min_n:
                continue
            if len(grp) == 1:
                bw, bh = boxes[grp[0], 2] - boxes[grp[0], 0], boxes[grp[0], 3] - boxes[grp[0], 1]
                if not (1.0 <= bh <= 6.0 and bw <= 1.3 * bh):
                    continue
            gboxes = boxes[grp]
            base, top, H = _line_metrics(gboxes)
            glyphs: list[Glyph] = []
            for sub in _merge_stacked(gboxes, H):
                ci = [int(idx[grp[k]]) for k in sub]
                segs = np.vstack([_rot_segs(path_segments(vs, p), rot) for c in ci for p in comps[c].paths])
                gb = gboxes[sub]
                bbox = np.array([gb[:, 0].min(), gb[:, 1].min(), gb[:, 2].max(), gb[:, 3].max()])
                key_v1, feat = glyph_signature(segs, bbox[0], base, H)
                polys = [(cv, _rot_pts(v, rot)) for c in ci for p in comps[c].paths for cv, v in path_polylines(vs, p)]
                key = stroke_key(polys, bbox[0], base, H)
                cb = np.array([comps[c].bbox for c in ci])
                pbb = np.array([cb[:, 0].min(), cb[:, 1].min(), cb[:, 2].max(), cb[:, 3].max()])
                glyphs.append(
                    Glyph(
                        comps=ci,
                        bbox=bbox,
                        segs=segs,
                        key=key,
                        feat=feat,
                        page_bbox=pbb,
                        key_v1=key_v1,
                        polys=polys,
                        paths=[p for c in ci for p in comps[c].paths],
                    )
                )
            glyphs.sort(key=lambda g: g.bbox[0])
            pb = np.array([comps[int(idx[k])].bbox for k in grp])
            lines.append(
                TextLine(
                    sheet=sheet,
                    glyphs=glyphs,
                    bbox=np.array([pb[:, 0].min(), pb[:, 1].min(), pb[:, 2].max(), pb[:, 3].max()]),
                    baseline=base,
                    topline=top,
                    height=H,
                    rotation=rot,
                    style=comps[int(idx[grp[0]])].style,
                )
            )
            used[[idx[k] for k in grp]] = True
    return lines
