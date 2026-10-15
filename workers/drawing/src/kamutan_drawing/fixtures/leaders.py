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
