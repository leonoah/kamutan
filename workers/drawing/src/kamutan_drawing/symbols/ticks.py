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


# ----------------------------------------------------------------------------- lines across a solid disc
# Sprint 11: the ceiling point is a filled disc with a cross through its centre; the wall light is the same disc with
# one line through the centre and a bar TANGENT to it (on the wall side). Their fits differ by < 0.01. The position of
# the lines relative to the disc is read directly.
CENTRE_MAX = 0.3  # a line passing within this share of the radius of the disc's centre goes "through the centre"
TANGENT_MIN, TANGENT_MAX = 0.7, 1.35  # … and one at about one radius is a tangent bar
DISC_LINE_MIN, DISC_LINE_MAX = 0.9, 3.4  # line length in radii
DISC_REACH = 0.3  # mm beyond the expected radius: a filled piece centred farther from the candidate is a neighbour's


@dataclass(frozen=True)
class DiscSignature:
    radius: float  # mm, from the solid's area
    centre: int  # distinct lines through the centre
    tangent: int  # distinct tangent bars


def _disc_lines(lines: np.ndarray, c: np.ndarray, r: float) -> tuple[int, int]:
    if len(lines) == 0 or r <= 0:
        return 0, 0
    d = lines[:, 2:] - lines[:, :2]
    ln = np.hypot(d[:, 0], d[:, 1])
    mid = (lines[:, :2] + lines[:, 2:]) / 2
    ok = (ln >= DISC_LINE_MIN * r) & (ln <= DISC_LINE_MAX * r) & (np.hypot(mid[:, 0] - c[0], mid[:, 1] - c[1]) <= 1.5 * r)
    if not ok.any():
        return 0, 0
    d, ln, mid = d[ok], ln[ok], mid[ok]
    u = d / ln[:, None]
    off = (mid[:, 0] - c[0]) * -u[:, 1] + (mid[:, 1] - c[1]) * u[:, 0]  # signed distance of the line from the centre
    ang = np.degrees(np.arctan2(u[:, 1], u[:, 0])) % 180.0
    seen: list[tuple[float, float]] = []
    n_c = n_t = 0
    for a, o in zip(ang.tolist(), off.tolist(), strict=True):
        key_o = abs(o)
        if any(min(abs(a - a2), 180.0 - abs(a - a2)) <= ANGLE_TOL_DEG and abs(key_o - o2) <= OFFSET_MERGE for a2, o2 in seen):
            continue
        seen.append((a, key_o))
        if key_o <= CENTRE_MAX * r:
            n_c += 1
        elif TANGENT_MIN * r <= key_o <= TANGENT_MAX * r:
            n_t += 1
    return n_c, n_t


def _fill_centre(vs: VectorSheet, paths: np.ndarray, seg_ids: np.ndarray | None = None) -> tuple[np.ndarray, float] | None:
    """(centre, radius) of the solid made of the filled ``paths`` (bbox centre of their ink; radius from the bbox).
    ``seg_ids``: use only these segments of the paths."""
    filled = paths[vs.path_fill_mode[paths] != 0]
    if len(filled) == 0:
        return None
    if seg_ids is None:
        s = vs.segs[np.isin(vs.seg_path, filled)]
    else:
        s = vs.segs[seg_ids[np.isin(vs.seg_path[seg_ids], filled)]]
    if len(s) == 0:
        return None
    x0, x1 = float(min(s[:, 0].min(), s[:, 2].min())), float(max(s[:, 0].max(), s[:, 2].max()))
    y0, y1 = float(min(s[:, 1].min(), s[:, 3].min())), float(max(s[:, 1].max(), s[:, 3].max()))
    if abs((x1 - x0) - (y1 - y0)) > 0.15 * max(x1 - x0, y1 - y0):
        return None  # not a disc
    return np.array([(x0 + x1) / 2, (y0 + y1) / 2]), (x1 - x0 + y1 - y0) / 4


def disc_signature(t: Template, vs: VectorSheet) -> DiscSignature | None:
    if not t.entries:
        return None
    idx = np.asarray(t.entries[0].seg_idx, dtype=np.int64)
    if len(idx) == 0:
        return None
    got = _fill_centre(vs, np.unique(vs.seg_path[idx]))
    if got is None:
        return None
    c, r = got
    stroke = (vs.path_fill_mode[vs.seg_path[idx]] == 0) & (vs.seg_kind[idx] == 0)
    n_c, n_t = _disc_lines(np.asarray(vs.segs[idx][stroke], dtype=np.float64), c, r)
    return DiscSignature(r, n_c, n_t) if n_c + n_t else None


def disc_lines_at(sig: DiscSignature, c: Candidate, scene: Scene, vs: VectorSheet) -> tuple[int, int] | None:
    """(lines through the centre, tangent bars) drawn at the candidate; None when no disc of that size is there."""
    x0, y0, x1, y1 = c.bbox()
    s = scene.segs
    mid = (s[:, :2] + s[:, 2:]) / 2
    inside = (mid[:, 0] >= x0 - PAD) & (mid[:, 0] <= x1 + PAD) & (mid[:, 1] >= y0 - PAD) & (mid[:, 1] <= y1 + PAD)
    if not inside.any():
        return None
    # the disc's own pieces only: a neighbouring fitting 3 mm away must not stretch the solid's box
    r_want = sig.radius * c.scale
    ids_in = scene.seg_ids[inside]
    paths_in = vs.seg_path[ids_in]
    keep_paths = [
        int(pth)
        for pth in np.unique(paths_in)
        if vs.path_fill_mode[pth] != 0
        and float(np.hypot(*(mid[inside][paths_in == pth].mean(axis=0) - np.asarray(c.center)))) <= r_want + DISC_REACH
    ]
    ids = ids_in[np.isin(paths_in, keep_paths)]
    got = _fill_centre(vs, np.asarray(keep_paths, dtype=np.int64), ids) if keep_paths else None
    if got is None:
        return None
    centre, r = got
    if abs(r - sig.radius * c.scale) > 0.2 * sig.radius * c.scale:
        return None
    near = np.hypot(mid[:, 0] - centre[0], mid[:, 1] - centre[1]) <= 2.0 * r
    ids2 = scene.seg_ids[near]
    stroke = (vs.path_fill_mode[vs.seg_path[ids2]] == 0) & (vs.seg_kind[ids2] == 0)
    return _disc_lines(np.asarray(s[near][stroke], dtype=np.float64), centre, r)


def resolve_by_disc_lines(cands: list[Candidate], templates: list[Template], scene: Scene, vs: VectorSheet) -> int:
    """Swap a candidate to the sibling disc drawing (same radius, similar size) whose line layout the plan shows."""
    sigs = {t.id: disc_signature(t, vs) for t in templates}
    swaps = 0
    for c in cands:
        mine = sigs.get(c.tpl.id)
        if mine is None:
            continue
        sibs = [
            o
            for o in templates
            if o.id != c.tpl.id
            and (so := sigs.get(o.id)) is not None
            and (so.centre, so.tangent) != (mine.centre, mine.tangent)
            and abs(so.radius - mine.radius) <= 0.1 * mine.radius
            and abs(o.size - c.tpl.size) <= SIBLING_SIZE * max(o.size, c.tpl.size)
        ]
        if not sibs:
            continue
        seen = disc_lines_at(mine, c, scene, vs)
        if seen is None or seen == (mine.centre, mine.tangent):
            continue
        hit = [o for o in sibs if (so := sigs[o.id]) is not None and (so.centre, so.tangent) == seen]
        if len(hit) == 1:
            c.runner_up_id, c.tpl = c.tpl.id, hit[0]
            swaps += 1
    return swaps
