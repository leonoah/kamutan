"""Sprint 11 (Worker-Accuracy): look-alikes that differ only by a COUNT of parallel strokes — pure.

The power socket is a filled half disc on a stem crossed by two ticks; the 3-phase socket is the same drawing with
three. Chamfer fit cannot tell them apart reliably (the third tick is ~4 % of the ink: 0.870 vs 0.867 on Achituv), so
the count is read directly: :func:`tick_signature` of a legend drawing = its group of ≥ 2 equal, parallel, stroke-only
lines (direction, length, count); :func:`count_ticks` counts such lines at a posed candidate on the plan;
:func:`resolve_by_ticks` swaps a candidate to its runner-up template when the plan's count is the runner-up's and not
its own.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from ..types_sprint2 import VectorSheet
from .match import Candidate, Scene
from .template import Template

ANGLE_TOL_DEG = 12.0
LENGTH_TOL = 0.3  # a tick on the plan may be this much longer / shorter than the legend's
OFFSET_MERGE = 0.3  # mm: lines closer than this across their direction are one stroke drawn twice
MIN_TICK = 1.0  # mm
PAD = 0.4  # mm around the posed box
SIBLING_SIZE = 0.2  # sibling drawings differ in size by at most this share
SHARED_MAX = 3.3  # a tick shared by up to three stacked symbols is at most this many tick lengths long


@dataclass(frozen=True)
class TickSignature:
    direction: tuple[float, float]  # unit vector, template frame
    length: float  # mm
    count: int


def _stroke_lines(segs: np.ndarray, straight: np.ndarray, stroke: np.ndarray) -> np.ndarray:
    keep = straight & stroke
    return np.asarray(segs[keep], dtype=np.float64)


def _groups(lines: np.ndarray) -> list[tuple[np.ndarray, float, int]]:
    """(unit direction, median length, number of distinct offsets) per direction / length group of ``lines``."""
    if len(lines) == 0:
        return []
    d = lines[:, 2:] - lines[:, :2]
    ln = np.hypot(d[:, 0], d[:, 1])
    ok = ln >= MIN_TICK
    lines, d, ln = lines[ok], d[ok], ln[ok]
    if len(lines) == 0:
        return []
    ang = np.degrees(np.arctan2(d[:, 1], d[:, 0])) % 180.0
    out: list[tuple[np.ndarray, float, int]] = []
    used = np.zeros(len(lines), dtype=bool)
    for i in np.argsort(-ln):
        if used[i]:
            continue
        da = np.abs(ang - ang[i])
        same = (~used) & (np.minimum(da, 180.0 - da) <= ANGLE_TOL_DEG) & (np.abs(ln - ln[i]) <= LENGTH_TOL * ln[i])
        used |= same
        u = d[i] / ln[i]
        nrm = np.array([-u[1], u[0]])
        mid = (lines[same, :2] + lines[same, 2:]) / 2
        off = np.sort(mid @ nrm)
        along = mid @ u
        # ticks sit side by side: their midpoints line up across the direction
        if len(off) and float(along.max() - along.min()) > 0.5 * ln[i]:
            continue
        n = 1 + int(np.sum(np.diff(off) > OFFSET_MERGE)) if len(off) else 0
        out.append((u, float(np.median(ln[same])), n))
    return out


def tick_signature(t: Template, vs: VectorSheet) -> TickSignature | None:
    """The drawing's ticks: its largest group of ≥ 2 equal parallel stroke-only lines. None when it has none."""
    if not t.entries:
        return None
    idx = np.asarray(t.entries[0].seg_idx, dtype=np.int64)
    if len(idx) == 0:
        return None
    stroke = vs.path_fill_mode[vs.seg_path[idx]] == 0
    straight = vs.seg_kind[idx] == 0
    groups = [g for g in _groups(_stroke_lines(vs.segs[idx], straight, stroke)) if g[2] >= 2]
    if not groups:
        return None
    u, length, n = max(groups, key=lambda g: (g[2], g[1]))
    return TickSignature((float(u[0]), float(u[1])), length, n)


def count_ticks(sig: TickSignature, c: Candidate, scene: Scene, vs: VectorSheet) -> int:
    """Lines like the signature's ticks drawn at the posed candidate (stroke-only scene ink inside its box)."""
    x0, y0, x1, y1 = c.bbox()
    s = scene.segs
    mid = (s[:, :2] + s[:, 2:]) / 2
    inside = (mid[:, 0] >= x0 - PAD) & (mid[:, 0] <= x1 + PAD) & (mid[:, 1] >= y0 - PAD) & (mid[:, 1] <= y1 + PAD)
    if not inside.any():
        return 0
    ids = scene.seg_ids[inside]
    keep = (vs.path_fill_mode[vs.seg_path[ids]] == 0) & (vs.seg_kind[ids] == 0)
    lines = np.asarray(s[inside][keep], dtype=np.float64)
    if len(lines) == 0:
        return 0
    u = c.mat @ np.array(sig.direction)
    scale = float(np.hypot(u[0], u[1])) or 1.0
    u = u / scale
    want = sig.length * scale
    d = lines[:, 2:] - lines[:, :2]
    ln = np.hypot(d[:, 0], d[:, 1])
    cosang = np.abs(d @ u) / np.maximum(ln, 1e-9)
    # stacked sockets share their ticks: one line runs across two or three of them (Achituv dishwasher + grinder)
    ok = (cosang >= math.cos(math.radians(ANGLE_TOL_DEG))) & (ln >= (1 - LENGTH_TOL) * want) & (ln <= SHARED_MAX * want)
    if not ok.any():
        return 0
    nrm = np.array([-u[1], u[0]])
    off = np.sort(((lines[ok, :2] + lines[ok, 2:]) / 2) @ nrm)
    return 1 + int(np.sum(np.diff(off) > OFFSET_MERGE))


def _siblings(
    t: Template, sig: TickSignature, templates: list[Template], sigs: dict[str, TickSignature | None]
) -> list[Template]:
    """Templates that are the same kind of drawing with another number of the same ticks: same tick length, a
    similar size, solid or not alike."""
    out: list[Template] = []
    for o in templates:
        so = sigs.get(o.id)
        if o.id == t.id or so is None or so.count == sig.count:
            continue
        if abs(so.length - sig.length) > 0.1 * max(so.length, sig.length):
            continue
        if abs(o.size - t.size) > SIBLING_SIZE * max(o.size, t.size) or (o.fill_area > 0) != (t.fill_area > 0):
            continue
        out.append(o)
    return out


def resolve_by_ticks(cands: list[Candidate], templates: list[Template], scene: Scene, vs: VectorSheet) -> int:
    """Swap a candidate to its sibling template (:func:`_siblings`) when the plan shows the sibling's tick count and
    not its own. Returns the number of swaps."""
    sigs = {t.id: tick_signature(t, vs) for t in templates}
    swaps = 0
    for c in cands:
        mine = sigs.get(c.tpl.id)
        if mine is None:
            continue
        sibs = _siblings(c.tpl, mine, templates, sigs)
        if not sibs:
            continue
        n = count_ticks(mine, c, scene, vs)
        hit = [o for o in sibs if (so := sigs[o.id]) is not None and so.count == n]
        if n != mine.count and len(hit) == 1:
            c.runner_up_id, c.tpl = c.tpl.id, hit[0]
            swaps += 1
    return swaps
