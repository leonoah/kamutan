"""Multiplicity marks next to sockets ("2X", "3X") read from their strokes.

The SHX reader often merges these two-character words with the socket's arc ("א 0%", "2]"),
so they are re-read geometrically with a glyph library harvested from the same sheet: digits
and ``X`` from confidently read short numeric spans (dimensions such as "130", "35") and the
legend's own "2X" qualifier. Each glyph near a socket is matched (normalised by the word's
height, three reading directions) to the library's nearest sample.
"""

from __future__ import annotations

import math
import re
from collections import defaultdict
from typing import Any

import numpy as np
from scipy.spatial import cKDTree
from scipy.spatial.distance import cdist

from ..ingest.pdf_vector import VectorSheet
from ..legend.parse import LegendEntry
from ..ocr.dictionary import TextSpan
from .geometry import BBox, Group, groups_of, resample, seg_lengths, segment_components

MAX_GLYPH_MM = 3.2
ACCEPT = 0.075
_WORD = re.compile(r"^[0-9X]{1,4}$")


def _glyph_points(segs: np.ndarray, center: np.ndarray, h: float, rot: int = 0) -> np.ndarray:
    pts, _ = resample(segs, max(h / 30, 0.02))
    p = (pts - center) / h
    if rot == 90:  # text reading bottom → top: rotate clockwise on paper to make it horizontal
        p = np.column_stack([-p[:, 1], p[:, 0]])
    elif rot == -90:
        p = np.column_stack([p[:, 1], -p[:, 0]])
    return p


class GlyphLibrary:
    def __init__(self) -> None:
        self.samples: dict[str, list[tuple[np.ndarray, cKDTree]]] = defaultdict(list)
        # Sprint 5 (perf): flattened samples for one batched reverse query per read, the sheet's segment arrays
        # and pair readings memoised across the sockets of a sheet (identical inputs → identical results)
        self._flat: list[tuple[str, np.ndarray, cKDTree, int, int]] | None = None
        self._all: np.ndarray | None = None
        self._offsets: np.ndarray = np.zeros(0, dtype=np.intp)
        self.sheet_cache: dict[int, tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]] = {}
        self.pair_memo: dict[tuple[bytes, bytes], tuple[float, str, str, float, float] | None] = {}

    def add(self, label: str, pts: np.ndarray) -> None:
        if len(pts) >= 6 and len(self.samples[label]) < 6:
            self.samples[label].append((pts, cKDTree(pts)))
            self._flat = self._all = None
            self.pair_memo.clear()

    @property
    def labels(self) -> set[str]:
        return set(self.samples)

    def _flatten(self) -> tuple[list[tuple[str, np.ndarray, cKDTree, int, int]], np.ndarray]:
        if self._flat is None or self._all is None:
            flat: list[tuple[str, np.ndarray, cKDTree, int, int]] = []
            off = 0
            for lab, lst in self.samples.items():
                for sp, st in lst:
                    flat.append((lab, sp, st, off, off + len(sp)))
                    off += len(sp)
            self._flat = flat
            self._all = np.concatenate([f[1] for f in flat]) if flat else np.zeros((0, 2))
            self._offsets = np.array([f[3] for f in flat], dtype=np.intp)
        return self._flat, self._all

    def read(self, pts: np.ndarray) -> tuple[str | None, float]:
        """Nearest library glyph by the symmetric mean chamfer distance (same order / ties as one query per
        sample: the reverse distances of all samples come from one batched query on the glyph's tree)."""
        if len(pts) == 0 or not self.samples:
            return None, 1.0
        flat, all_pts = self._flatten()
        # one dense distance matrix glyph × all samples (≈ 150 × 10k) instead of a KD query per sample
        dm = cdist(np.asarray(pts, dtype=np.float64), all_pts)
        rev = dm.min(axis=0)
        # per-sample nearest distances of the glyph's points (rows of a contiguous (samples, n) array, so each mean
        # is the same pairwise sum as the 1-D mean of one KD query)
        fwd = np.ascontiguousarray(np.minimum.reduceat(dm, self._offsets, axis=1).T)
        fmean = fwd.mean(axis=1)
        best: tuple[float, str | None] = (1.0, None)
        for k, (lab, _sp, _st, a, b) in enumerate(flat):
            d = float((fmean[k] + rev[a:b].mean()) / 2)
            if d < best[0]:
                best = (d, lab)
        return best[1], best[0]

    def read_kd(self, pts: np.ndarray) -> tuple[str | None, float]:
        """Reference implementation (one KD query per sample) — tests compare :meth:`read` against it."""
        if len(pts) == 0 or not self.samples:
            return None, 1.0
        tp = cKDTree(pts)
        best: tuple[float, str | None] = (1.0, None)
        for lab, lst in self.samples.items():
            for sp, st in lst:
                d = float((st.query(pts)[0].mean() + tp.query(sp)[0].mean()) / 2)
                if d < best[0]:
                    best = (d, lab)
        return best[1], best[0]

    def sheet_arrays(self, vs: VectorSheet) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """``(segs float64, mid x, mid y, lengths)`` of the sheet, computed once per sheet."""
        key = id(vs.segs)
        got = self.sheet_cache.get(key)
        if got is None:
            s = vs.segs.astype(np.float64)
            got = (s, (s[:, 0] + s[:, 2]) / 2, (s[:, 1] + s[:, 3]) / 2, seg_lengths(s))
            self.sheet_cache = {key: got}
        return got


def _local_groups(segs: np.ndarray, idx: np.ndarray) -> list[Group]:
    if len(idx) == 0:
        return []
    lab = segment_components(segs[idx], tol=0.08)
    return [g for g in groups_of(segs, lab, idx) if max(g.w, g.h) <= MAX_GLYPH_MM]


def build_library(vs: VectorSheet, spans: list[TextSpan], entries: list[LegendEntry]) -> GlyphLibrary:
    lib = GlyphLibrary()
    s = vs.segs.astype(np.float64)
    lens = seg_lengths(s)
    mid = np.column_stack([(s[:, 0] + s[:, 2]) / 2, (s[:, 1] + s[:, 3]) / 2])
    tree = cKDTree(mid) if len(mid) else None
    if tree is None:
        return lib

    def harvest(word: str, box: BBox) -> None:
        cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
        r = 0.5 * math.hypot(box[2] - box[0], box[3] - box[1]) + 0.3
        idx = np.asarray(tree.query_ball_point([cx, cy], r), dtype=np.int64)
        idx = idx[(lens[idx] <= MAX_GLYPH_MM)]
        idx = idx[
            (mid[idx, 0] >= box[0] - 0.2)
            & (mid[idx, 0] <= box[2] + 0.2)
            & (mid[idx, 1] >= box[1] - 0.2)
            & (mid[idx, 1] <= box[3] + 0.2)
        ]
        gs = sorted(_local_groups(s, idx), key=lambda g: g.cx)
        if len(gs) != len(word):
            return
        h = max(g.h for g in gs)
        if h < 0.5:
            return
        for ch, g in zip(word, gs, strict=True):
            lib.add(ch, _glyph_points(s[g.segs], np.array([g.cx, g.cy]), h))

    for sp in spans:
        if sp.rotation != 0 or sp.conf < 0.85:
            continue
        w = sp.text.replace(" ", "").upper()
        if _WORD.match(w):
            harvest(w, sp.bbox)
    for e in entries:
        if e.multiplicity is not None and len(e.qual_seg_idx):
            gs = sorted(_local_groups(s, e.qual_seg_idx), key=lambda g: g.cx)
            gs = [g for g in gs if g.h >= 0.6 * max(q.h for q in gs)]  # drop the dash
            if len(gs) == 2:
                h = max(g.h for g in gs)
                for ch, g in zip(f"{e.multiplicity}X", gs, strict=True):
                    lib.add(ch, _glyph_points(s[g.segs], np.array([g.cx, g.cy]), h))
    return lib


def read_marks_near(
    vs: VectorSheet, lib: GlyphLibrary, box: BBox, reach: float, exclude: BBox | None = None
) -> list[tuple[int, float, tuple[float, float]]]:
    """Multiplicity words written next to ``box``: [(n, reading distance, word centre)]; n = 0 for an
    X-like word whose digit could not be read."""
    if "X" not in lib.labels:
        return []
    s, mx, my, lens = lib.sheet_arrays(vs)
    sel = (mx >= box[0] - reach) & (mx <= box[2] + reach) & (my >= box[1] - reach) & (my <= box[3] + reach)
    sel &= lens <= MAX_GLYPH_MM
    if exclude is not None:
        sel &= ~((mx >= exclude[0]) & (mx <= exclude[2]) & (my >= exclude[1]) & (my <= exclude[3]))
    idx = np.where(sel)[0]
    gs = [g for g in _local_groups(s, idx) if max(g.w, g.h) >= 0.6]
    if len(gs) < 2:
        return []
    found: list[tuple[int, float, tuple[float, float]]] = []
    # words: pairs of neighbouring glyphs of similar size
    for i, a in enumerate(gs):
        for b in gs[i + 1 :]:
            h = max(a.h, b.h, a.w, b.w)
            if abs(max(a.h, a.w) - max(b.h, b.w)) > 0.45 * h:
                continue
            dx, dy = b.cx - a.cx, b.cy - a.cy
            if math.hypot(dx, dy) > 1.9 * h:
                continue
            # the word's baseline may be at any angle (walls at 45°): read along it, both directions,
            # keep the better reading of the two (memoised: neighbouring sockets see the same glyph pairs)
            mkey = (a.segs.tobytes(), b.segs.tobytes())
            if mkey in lib.pair_memo:
                best = lib.pair_memo[mkey]
            else:
                best = _read_pair(s, a, b, dx, dy, lib)
                lib.pair_memo[mkey] = best
            if best is None:
                continue
            d, word, _, dmin, _ = best
            centre = ((a.cx + b.cx) / 2, (a.cy + b.cy) / 2)
            m = re.fullmatch(r"([2-4])X|X([2-4])", word)
            if m and d <= ACCEPT:
                found.append((int(m.group(1) or m.group(2)), d, centre))
            elif "X" in word and dmin <= 0.6 * ACCEPT:
                found.append((0, d, centre))  # n = 0: an X next to an unreadable glyph
    return found


def _read_pair(
    s: np.ndarray, a: Group, b: Group, dx: float, dy: float, lib: GlyphLibrary
) -> tuple[float, str, str, float, float] | None:
    """Best two-glyph reading of (a, b) along their baseline, both directions."""
    theta = math.atan2(dy, dx)
    best: tuple[float, str, str, float, float] | None = None
    for flip in (0.0, math.pi):
        t = theta + flip
        c_, s_ = math.cos(-t), math.sin(-t)
        rot = np.array([[c_, -s_], [s_, c_]])
        ra = (resample(s[a.segs], 0.03)[0] - np.array([a.cx, a.cy])) @ rot.T
        rb = (resample(s[b.segs], 0.03)[0] - np.array([b.cx, b.cy])) @ rot.T
        gh = max(float(np.ptp(ra[:, 1])), float(np.ptp(rb[:, 1])))
        if gh < 0.6:
            continue
        pa, pb = ra / gh, rb / gh
        pa -= (pa.max(axis=0) + pa.min(axis=0)) / 2
        pb -= (pb.max(axis=0) + pb.min(axis=0)) / 2
        la, da = lib.read(pa)
        lb, db = lib.read(pb)
        if la is None or lb is None:
            continue
        xa = float((np.array([a.cx, a.cy]) @ rot.T)[0])
        xb = float((np.array([b.cx, b.cy]) @ rot.T)[0])
        word = la + lb if xa <= xb else lb + la
        d = max(da, db)
        if best is None or d < best[0]:
            best = (d, word, la if da <= db else lb, min(da, db), d)
    return best


# ------------------------------------------------------------------ symbol qualifiers (BEZEK / TV / TEL / רשת)
QUAL_ACCEPT = 0.09
QUAL_MARGIN = 0.02


def _cloud(segs: np.ndarray) -> np.ndarray | None:
    if len(segs) == 0:
        return None
    pts, _ = resample(segs, 0.05)
    c = (pts.max(axis=0) + pts.min(axis=0)) / 2
    size = float(max(np.ptp(pts[:, 0]), np.ptp(pts[:, 1])))
    if size < 0.5:
        return None
    return (pts - c) / size


def qualifier_clouds(vs: VectorSheet, entries: list[LegendEntry]) -> list[tuple[LegendEntry, np.ndarray, Any]]:
    """Normalised strokes of the text written with each legend symbol (its *qualifier*), dash dropped."""
    s = vs.segs.astype(np.float64)
    out: list[tuple[LegendEntry, np.ndarray, Any]] = []
    for e in entries:
        if len(e.qual_seg_idx) < 2 or e.multiplicity is not None:
            continue
        gs = _local_groups(s, e.qual_seg_idx)
        if not gs:
            continue
        hmax = max(g.h for g in gs)
        keep = [g for g in gs if g.h >= 0.5 * hmax]  # the dash joining text and symbol is flat
        cl = _cloud(s[np.concatenate([g.segs for g in keep])]) if keep else None
        if cl is not None:
            out.append((e, cl, cKDTree(cl)))
    return out


def read_qualifier(
    vs: VectorSheet, clouds: list[tuple[LegendEntry, np.ndarray, Any]], box: BBox, reach: float, exclude: BBox | None = None
) -> tuple[LegendEntry | None, float]:
    """Which legend qualifier is written next to ``box`` — compared stroke-wise in 8 orientations
    (vertical and 45° text included), so it works where the text reader fails."""
    if len(clouds) < 1:
        return None, 1.0
    s = vs.segs.astype(np.float64)
    mx, my = (s[:, 0] + s[:, 2]) / 2, (s[:, 1] + s[:, 3]) / 2
    sel = (mx >= box[0] - reach) & (mx <= box[2] + reach) & (my >= box[1] - reach) & (my <= box[3] + reach)
    sel &= seg_lengths(s) <= MAX_GLYPH_MM
    if exclude is not None:
        sel &= ~((mx >= exclude[0]) & (mx <= exclude[2]) & (my >= exclude[1]) & (my <= exclude[3]))
    idx = np.where(sel)[0]
    gs = [g for g in _local_groups(s, idx) if max(g.w, g.h) >= 0.5]
    if not gs:
        return None, 1.0
    # words: glyphs chained by gaps below 1 mm
    words: list[list[Group]] = []
    for g in sorted(gs, key=lambda q: (q.cx, q.cy)):
        for w in words:
            if any(max(abs(g.cx - q.cx) - (g.w + q.w) / 2, abs(g.cy - q.cy) - (g.h + q.h) / 2) < 1.0 for q in w):
                w.append(g)
                break
        else:
            words.append([g])
    best: list[tuple[float, LegendEntry]] = []
    for w in words:
        cl = _cloud(s[np.concatenate([g.segs for g in w])])
        if cl is None or len(cl) < 10:
            continue
        tw = cKDTree(cl)
        for e, qc, qt in clouds:
            d = 1.0
            for k in range(8):
                t = math.radians(45 * k)
                rot = np.array([[math.cos(t), -math.sin(t)], [math.sin(t), math.cos(t)]])
                r = cl @ rot.T
                tr = cKDTree(r)
                d = min(d, float((qt.query(r)[0].mean() + tr.query(qc)[0].mean()) / 2))
            best.append((d, e))
        _ = tw
    if not best:
        return None, 1.0
    best.sort(key=lambda q: q[0])
    d0, e0 = best[0]
    others = [d for d, e in best if e is not e0]
    if d0 <= QUAL_ACCEPT and (not others or min(others) - d0 >= QUAL_MARGIN):
        return e0, d0
    return None, d0
