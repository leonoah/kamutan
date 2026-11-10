"""Leader lines: from a label block to the point(s) it names.

Annotation pens (thin, solid, not the furniture grey, straight pieces only — door swings are beziers) are
indexed once per sheet. Glyph strokes are dropped (both ends inside a text line box). A leader starts at a
*seed*: a segment ≥ 1.5 mm crossing the label block (its underline) or touching it (± 1.2 mm), and continues
end-to-end (gap ≤ 0.25 mm) through polyline vertices — a "V" leader branches at a vertex. The free ends
outside the block are the terminals. Networks of more than ``MAX_SEGS`` pieces (dimension chains, hatches,
another label's leader) are not followed.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

import numpy as np
from scipy.spatial import cKDTree

from ..ingest.pdf_vector import SEG_LINE, VectorSheet
from .labels import Label, TextItem

JOIN_MM = 0.25
SEED_PAD_MM = 1.2
MIN_SEED_MM = 1.5
MAX_SEGS = 24
MAX_LEN_MM = 400.0
WALL_PEN_MM = 0.45
DARK_MAX = 90
MAX_GLYPH_H_MM = 5.0


@dataclass
class Leader:
    terminal: tuple[float, float]
    polyline: list[tuple[float, float]] = field(default_factory=list)
    length: float = 0.0


def is_furniture_grey(rgb: np.ndarray) -> np.ndarray:
    r, g, b = rgb[:, 0].astype(int), rgb[:, 1].astype(int), rgb[:, 2].astype(int)
    return (abs(r - g) <= 6) & (abs(g - b) <= 6) & (r >= 90) & (r <= 235)


class LeaderIndex:
    """Annotation segments of one sheet with an endpoint KD-tree."""

    def __init__(self, vs: VectorSheet, text: Sequence[TextItem]) -> None:
        n = vs.n_paths
        solid = np.array([len(d) == 0 for d in vs.path_dash], bool) if n else np.zeros(0, bool)
        rgb = vs.path_stroke_rgba[:, :3].astype(int)
        dark = rgb.max(axis=1) <= DARK_MAX  # leaders are drawn in black / dark pens (not hatches or greys)
        ok_path = vs.path_stroked & solid & (vs.path_width_mm < WALL_PEN_MM) & dark
        sel = ok_path[vs.seg_path] & (vs.seg_kind == SEG_LINE) if vs.n_segs else np.zeros(0, bool)
        s = vs.segs[sel].astype(np.float64) if vs.n_segs else np.zeros((0, 4))
        ln = np.hypot(s[:, 2] - s[:, 0], s[:, 3] - s[:, 1]) if len(s) else np.zeros(0)
        keep = ln >= 0.25
        s, ln = s[keep], ln[keep]
        if len(s) and text:
            boxes = [t.bbox for t in text if 0.0 < t.bbox[3] - t.bbox[1] <= MAX_GLYPH_H_MM]
            inside = np.zeros(len(s), bool)
            for x0, y0, x1, y1 in boxes:
                a = (s[:, 0] >= x0 - 0.15) & (s[:, 0] <= x1 + 0.15) & (s[:, 1] >= y0 - 0.15) & (s[:, 1] <= y1 + 0.15)
                b = (s[:, 2] >= x0 - 0.15) & (s[:, 2] <= x1 + 0.15) & (s[:, 3] >= y0 - 0.15) & (s[:, 3] <= y1 + 0.15)
                inside |= a & b & (ln < max(1.0, 1.3 * (y1 - y0)))
            s, ln = s[~inside], ln[~inside]
        self.segs = s
        self.len = ln
        ends = np.concatenate([s[:, :2], s[:, 2:]]) if len(s) else np.zeros((0, 2))
        self.tree = cKDTree(ends) if len(ends) else None
        self.n = len(s)

    def _end(self, k: int) -> np.ndarray:
        i, side = k % self.n, k // self.n
        return self.segs[i, 2 * side : 2 * side + 2]

    def follow(self, label: Label, *, avoid: Sequence[tuple[float, float, float, float]] = ()) -> list[Leader]:
        """Terminals of the leader(s) leaving ``label`` (empty when none is found)."""
        if self.tree is None or self.n == 0:
            return []
        x0, y0, x1, y1 = label.bbox
        s = self.segs
        pad = SEED_PAD_MM
        # seeds: segments crossing / touching the padded block
        bx0, by0, bx1, by1 = x0 - pad, y0 - pad, x1 + pad, y1 + pad
        sx0, sx1 = np.minimum(s[:, 0], s[:, 2]), np.maximum(s[:, 0], s[:, 2])
        sy0, sy1 = np.minimum(s[:, 1], s[:, 3]), np.maximum(s[:, 1], s[:, 3])
        touch = (sx1 >= bx0) & (sx0 <= bx1) & (sy1 >= by0) & (sy0 <= by1) & (self.len >= MIN_SEED_MM)
        seeds = np.where(touch)[0].tolist()
        if not seeds:
            return []
        visited: dict[int, int] = {i: -1 for i in seeds}  # seg -> parent seg
        queue = list(seeds)
        while queue:
            i = queue.pop()
            for side in (0, 1):
                p = s[i, 2 * side : 2 * side + 2]
                for k in self.tree.query_ball_point(p, JOIN_MM):
                    j = k % self.n
                    if j in visited:
                        continue
                    visited[j] = i
                    queue.append(j)
                    if len(visited) > MAX_SEGS + len(seeds):
                        return []
        total = float(self.len[list(visited)].sum())
        if total > MAX_LEN_MM:
            return []
        out: list[Leader] = []
        for i in visited:
            for side in (0, 1):
                p = s[i, 2 * side : 2 * side + 2]
                nb = [k for k in self.tree.query_ball_point(p, JOIN_MM) if k % self.n != i]
                if nb:
                    continue
                px, py = float(p[0]), float(p[1])
                dx = max(x0 - px, 0.0, px - x1)
                dy = max(y0 - py, 0.0, py - y1)
                if (dx * dx + dy * dy) ** 0.5 < 2.0:
                    continue  # the end at the label
                if any(a[0] - 0.5 <= px <= a[2] + 0.5 and a[1] - 0.5 <= py <= a[3] + 0.5 for a in avoid):
                    continue  # ends on another note
                chain: list[tuple[float, float]] = [(px, py)]
                j = i
                other = s[j, 2 * (1 - side) : 2 * (1 - side) + 2]
                chain.append((float(other[0]), float(other[1])))
                guard = 0
                while visited.get(j, -1) != -1 and guard < MAX_SEGS:
                    j = visited[j]
                    q = s[j]
                    last = np.array(chain[-1])
                    far = q[2:] if np.hypot(*(q[:2] - last)) < np.hypot(*(q[2:] - last)) else q[:2]
                    chain.append((float(far[0]), float(far[1])))
                    guard += 1
                length = float(
                    sum(np.hypot(chain[k + 1][0] - chain[k][0], chain[k + 1][1] - chain[k][1]) for k in range(len(chain) - 1))
                )
                out.append(Leader((px, py), chain[::-1], length))
        return out


# ---------------------------------------------------------------------------------------------- boxed notes
# Sprint 11 (Worker-Areas): the designer's later plumbing sheets (Rubel / Achituv / Yahav) write every point as a *boxed
# note* — the text inside a thin coloured rectangle — with a straight leader in the same pen from the box edge to a
# filled dot at the point (a fan of leaders when one note names several points: "אינטרפוץ 3 דרך" × 3). The leaders are
# orange, not dark, so :class:`LeaderIndex` (dark pens only: Noah) never sees them.
FRAME_MIN_SAT = 80  # max(rgb) - min(rgb): a coloured pen
FRAME_MIN_W_MM = 4.0
FRAME_MIN_H_MM = 2.0
FRAME_MAX_W_MM = 160.0
FRAME_MAX_H_MM = 60.0
FRAME_EDGE_MM = 0.6  # a leader starts on the box outline (drawn by hand: up to 0.4 mm off a corner)
FRAME_MIN_LEADER_MM = 1.0


@dataclass
class Frame:
    box: tuple[float, float, float, float]
    rgb: tuple[int, int, int]
    pens: list[tuple[int, int, int]] = field(default_factory=list)  # every pen the box is drawn in (often twice)

    def holds(self, b: tuple[float, float, float, float], pad: float = 0.6) -> bool:
        """The text box ``b`` lies inside the frame (its centre inside, ≥ 60 % of its area)."""
        x0, y0, x1, y1 = self.box
        cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        if not (x0 - pad <= cx <= x1 + pad and y0 - pad <= cy <= y1 + pad):
            return False
        iw = min(b[2], x1 + pad) - max(b[0], x0 - pad)
        ih = min(b[3], y1 + pad) - max(b[1], y0 - pad)
        area = max(1e-6, (b[2] - b[0]) * (b[3] - b[1]))
        return iw > 0 and ih > 0 and iw * ih >= 0.6 * area

    def on_edge(self, x: float, y: float, tol: float = FRAME_EDGE_MM) -> bool:
        x0, y0, x1, y1 = self.box
        if not (x0 - tol <= x <= x1 + tol and y0 - tol <= y <= y1 + tol):
            return False
        return min(abs(x - x0), abs(x - x1), abs(y - y0), abs(y - y1)) <= tol

    def inside(self, x: float, y: float, margin: float = FRAME_EDGE_MM) -> bool:
        x0, y0, x1, y1 = self.box
        return x0 + margin < x < x1 - margin and y0 + margin < y < y1 - margin


class FrameIndex:
    """Note boxes (4-segment axis-aligned rectangles in a thin coloured pen) and the same-pen segments around them."""

    def __init__(self, vs: VectorSheet) -> None:
        self.frames: list[Frame] = []
        self._segs: dict[tuple[int, int, int] | None, np.ndarray] = {}
        self._trees: dict[tuple[int, int, int] | None, cKDTree] = {}
        n = vs.n_paths
        if not n or not vs.n_segs:
            return
        solid = np.array([len(d) == 0 for d in vs.path_dash], bool)
        rgb = vs.path_stroke_rgba[:, :3].astype(int)
        sat = (rgb.max(axis=1) - rgb.min(axis=1)) >= FRAME_MIN_SAT
        pen = vs.path_stroked & solid & (vs.path_width_mm < WALL_PEN_MM) & sat & (vs.path_fill_mode == 0)
        bb = vs.path_bbox.astype(float)
        w, h = bb[:, 2] - bb[:, 0], bb[:, 3] - bb[:, 1]
        cand = pen & (vs.path_seg_count == 4) & (w >= FRAME_MIN_W_MM) & (h >= FRAME_MIN_H_MM)
        cand &= (w <= FRAME_MAX_W_MM) & (h <= FRAME_MAX_H_MM)
        frame_paths = np.zeros(n, bool)
        seen: dict[tuple[int, int, int, int], Frame] = {}
        for i in np.where(cand)[0].tolist():
            a = int(vs.path_seg_start[i])
            s = vs.segs[a : a + 4].astype(float)
            if not bool((vs.seg_kind[a : a + 4] == SEG_LINE).all()):
                continue
            horiz = np.abs(s[:, 1] - s[:, 3]) <= 0.05
            vert = np.abs(s[:, 0] - s[:, 2]) <= 0.05
            if int(horiz.sum()) != 2 or int(vert.sum()) != 2:
                continue
            ln = np.hypot(s[:, 2] - s[:, 0], s[:, 3] - s[:, 1])
            if abs(float(ln[horiz].sum()) - 2 * w[i]) > 0.2 or abs(float(ln[vert].sum()) - 2 * h[i]) > 0.2:
                continue
            frame_paths[i] = True
            key = (round(bb[i, 0] * 4), round(bb[i, 1] * 4), round(bb[i, 2] * 4), round(bb[i, 3] * 4))
            pen_i = (int(rgb[i, 0]), int(rgb[i, 1]), int(rgb[i, 2]))
            if key in seen:  # the box is often drawn twice, sometimes in two pens (a dark red box under the orange one)
                if pen_i not in seen[key].pens:
                    seen[key].pens.append(pen_i)
                continue
            fr = Frame((float(bb[i, 0]), float(bb[i, 1]), float(bb[i, 2]), float(bb[i, 3])), pen_i, [pen_i])
            seen[key] = fr
            self.frames.append(fr)
        if not self.frames:
            return
        colours: list[tuple[int, int, int] | None] = [*sorted({c for f in self.frames for c in f.pens}), None]
        ok_path = pen & ~frame_paths
        sel = ok_path[vs.seg_path] & (vs.seg_kind == SEG_LINE)
        s_all = vs.segs[sel].astype(np.float64)
        c_all = rgb[vs.seg_path[sel]]
        ln_all = np.hypot(s_all[:, 2] - s_all[:, 0], s_all[:, 3] - s_all[:, 1]) if len(s_all) else np.zeros(0)
        for c in colours:  # None = every coloured pen (a leader drawn in another pen than its box)
            m = ln_all >= FRAME_MIN_LEADER_MM
            if c is not None:
                m = m & (c_all[:, 0] == c[0]) & (c_all[:, 1] == c[1]) & (c_all[:, 2] == c[2])
            s = s_all[m]
            if not len(s):
                continue
            # glyph strokes of the notes (the text is drawn in the box pen): both ends inside one box
            glyph = np.zeros(len(s), bool)
            for f in self.frames:
                x0, y0, x1, y1 = f.box
                e = FRAME_EDGE_MM
                a_in = (s[:, 0] > x0 + e) & (s[:, 0] < x1 - e) & (s[:, 1] > y0 + e) & (s[:, 1] < y1 - e)
                b_in = (s[:, 2] > x0 + e) & (s[:, 2] < x1 - e) & (s[:, 3] > y0 + e) & (s[:, 3] < y1 - e)
                glyph |= a_in & b_in
            s = s[~glyph]
            if len(s):
                self._segs[c] = s
                self._trees[c] = cKDTree(np.concatenate([s[:, :2], s[:, 2:]]))

    def frame_of(self, bbox: tuple[float, float, float, float]) -> Frame | None:
        """The smallest box holding a text box."""
        hits = [f for f in self.frames if f.holds(bbox)]
        if not hits:
            return None
        return min(hits, key=lambda f: (f.box[2] - f.box[0]) * (f.box[3] - f.box[1]))

    def follow(self, frame: Frame) -> list[Leader]:
        """Leaders leaving ``frame``: same-pen segments starting on its outline, followed end to end; the free ends
        are the terminals (the dots). A chain reaching another box is not a leader of this one."""
        out: list[Leader] = []
        for pen in frame.pens or [frame.rgb]:
            out.extend(self._follow_pen(frame, pen))
        if not out:  # the leader was drawn in another coloured pen (the dimension red): a short polyline only
            out = [ld for ld in self._follow_pen(frame, None) if len(ld.polyline) <= 3]
        # one terminal once (a box drawn twice gives every leader twice)
        uniq: list[Leader] = []
        for ld in sorted(out, key=lambda q: (q.terminal[1], q.terminal[0], q.length)):
            if all(np.hypot(ld.terminal[0] - u.terminal[0], ld.terminal[1] - u.terminal[1]) > 0.5 for u in uniq):
                uniq.append(ld)
        return uniq

    def _follow_pen(self, frame: Frame, pen: tuple[int, int, int] | None) -> list[Leader]:
        s = self._segs.get(pen)
        tree = self._trees.get(pen)
        if s is None or tree is None:
            return []
        n = len(s)
        out: list[Leader] = []
        for i in range(n):
            for side in (0, 1):
                px, py = float(s[i, 2 * side]), float(s[i, 2 * side + 1])
                qx, qy = float(s[i, 2 - 2 * side]), float(s[i, 3 - 2 * side])
                if not frame.on_edge(px, py) or frame.on_edge(qx, qy) or frame.inside(qx, qy):
                    continue
                chain = [(px, py), (qx, qy)]
                visited = {i}
                stack: list[tuple[int, tuple[float, float], list[tuple[float, float]]]] = [(i, (qx, qy), chain)]
                while stack and len(visited) <= MAX_SEGS:
                    _j, end, path = stack.pop()
                    nxt = [k for k in tree.query_ball_point(end, JOIN_MM) if k % n not in visited]
                    if not nxt:
                        if any(f is not frame and f.on_edge(end[0], end[1], 0.5) for f in self.frames):
                            continue
                        length = float(
                            sum(np.hypot(path[k + 1][0] - path[k][0], path[k + 1][1] - path[k][1]) for k in range(len(path) - 1))
                        )
                        if length <= MAX_LEN_MM:
                            out.append(Leader(end, list(path), length))
                        continue
                    for k in nxt:
                        m, sd = k % n, k // n
                        if m in visited:
                            continue
                        visited.add(m)
                        far = (float(s[m, 2 - 2 * sd]), float(s[m, 3 - 2 * sd]))
                        stack.append((m, far, [*path, far]))
        return out
