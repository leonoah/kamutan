"""Switch ↔ luminaire link graph → ``kamutan.links/1`` groups.

Input: the dashed chains of the sheet (:mod:`.arcs`), the sheet's detections (``kamutan.detections/1``
dicts), its text spans and legend document, the page vectors (for *ink* attachment).

1. **Attach** each chain end to a symbol. First by ink: the small (symbol-sized) strokes the end
   touches form a glyph; the detection whose box holds that glyph wins (switch banks at 2 mm pitch
   are told apart by which stem the arc ends on). Without touched ink, by distance: an end within
   ``0.35·size + 0.8`` mm of a symbol's box (arcs that stop short of / overshoot the symbol). Two
   candidates almost as good → the end is *ambiguous* (``קישור מפסק לא ודאי``); none → *dangling*
   (``קשת לא מסתיימת בסמל``), unless the end lands on another chain (a branch), which joins them.
2. A chain that runs *through* a luminaire centre is split there (luminaire → luminaire chains
   drawn as one curve, or two arcs whose dashes line up at the shared point).
3. **Components** of {detections, chains} = circuits. Luminaires joined by a chain and closer than
   ``point_merge_m`` (real metres at the plan scale) form one *point*.
4. **Kind** per circuit: no switch → ``sensor`` when the fixture's type row / a nearby note says
   motion sensor (גלאי / חיישן), else red ``נקודת מאור ללא מפסק``; every point existing ("נק'
   קיימת" next to it or lifecycle existing) → ``add_to_existing`` (``fan`` when a ceiling fan / fan
   switch / "מאוורר" note is involved); 1 switch → ``single`` (1 point) / ``shared`` (≥ 2 points);
   ≥ 2 switches → ``two_way``. A lone switch labelled "להוסיף …" is also ``add_to_existing``; ``fan``
   is set from the switch side (fan-switch class or a "מאוורר" note nearest the switch). Lone
   luminaires without arcs: existing → no group; motion sensor → ``sensor``; else listed in
   ``unlinkedLuminaireIds``. Switches without arcs make no group (counted in stats).
5. **Confidence**: 0.92, × 0.65 per ambiguous end, × 0.5 per dangling end, × 0.8 when chaining
   was ambiguous (crossing arcs), rule-specific penalties below. Green only when every arc end is
   attached unambiguously and no warning reason applies (brief level rule).
"""

from __future__ import annotations

import math
import re
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

import numpy as np
from scipy.spatial import cKDTree

from ..ingest.pdf_vector import VectorSheet
from ..symbols.geometry import resample, segment_components
from ..types_sprint2 import level_for
from .arcs import Chain

LINKS_SCHEMA = "kamutan.links/1"

R_AMBIG = "קישור מפסק לא ודאי"
R_DANGLING = "קשת לא מסתיימת בסמל"
R_CROSSING = "קשתות חוצות"
R_NO_SWITCH = "נקודת מאור ללא מפסק"
R_NO_ARC = "נקודת מאור ללא קישור למפסק"
R_MIXED = "נקודה קיימת ונקודה חדשה באותו מפסק"
R_MANY = "יותר משני מפסקים לנקודה"
R_SW_TYPE = "סוג מפסק לא תואם לקבוצה"
R_PARTNER = "מחלף ללא מחלף שני בגיליון"
R_SENSOR = "חיישן לפי כיתוב"
R_FLOOR = "קומה לא ודאית"
R_NO_POINT = "מפסק ללא נקודת מאור"
R_INFERRED = "מפסק לא זוהה (לפי קשת)"

# reasons that never stop a group from being green (none today; all chips are warnings)
INFO_REASONS: frozenset[str] = frozenset()

SWITCH_CLASSES = {"switch_single", "switch_2way", "switch_fan", "switch_cross"}
LUMINAIRE_CLASSES = {
    "luminaire_ceiling",
    "luminaire_wall",
    "luminaire_pendant",
    "luminaire_strip",
    "luminaire_outdoor",
    "ceiling_fan",
}
_EXISTING = re.compile(r"קיימ|קיים")
_SENSOR = re.compile(r"גלאי|חיישן|סנסור|גלאי\s*תנועה")
_FAN = re.compile(r"מאוורר|מאורר")
_ADD = re.compile(r"להוסיף|הוספת")


class SpanLike(Protocol):
    bbox: tuple[float, float, float, float]
    text: str


@dataclass
class LinkParams:
    """Configurable rules (org rule set later; defaults from the Israeli lighting convention)."""

    point_merge_m: float = 0.3  # luminaires wired together and closer than this = one point
    ink_touch_mm: float = 1.0  # an arc end touches a glyph stroke within this distance (ends sit in small rings)
    symbol_max_mm: float = 12.0  # paths larger than this are not symbol ink (walls, dimension lines)
    tol_rel: float = 0.35  # end-to-box tolerance relative to the symbol size …
    tol_abs_mm: float = 0.8  # … plus this
    ambiguous_slack_mm: float = 0.6  # runner-up symbol this much farther → ambiguous end
    branch_mm: float = 1.0  # an end this close to another chain joins it
    pass_through_mm: float = 0.8  # a chain this close to a luminaire centre passes through it
    note_reach_mm: float = 14.0  # "נק' קיימת" / "מאוורר" / "גלאי" note → nearest symbol within this
    base_conf: float = 0.92
    distinct_glyph_mm: float = 1.0  # arc ends on one switch box but glyphs this far apart = 2 switches
    wire_colours: tuple[tuple[int, int, int], ...] = ()  # empty = learn from chains with both ends attached


@dataclass
class End:
    det: int | None = None  # index into dets
    chain: int | None = None  # branch onto another chain
    ambiguous: bool = False
    by_ink: bool = False
    glyph: tuple[float, float, float, float] | None = None  # the glyph the end touches (ink attachment)
    virtual: int | None = None  # an undetected switch inferred from a distinct glyph


@dataclass
class Arc:
    chain: Chain
    ends: list[End] = field(default_factory=lambda: [End(), End()])
    id: str = ""


# ------------------------------------------------------------------------------- ink
class Ink:
    """Symbol-sized strokes of the sheet (no text, no dashes, no walls / long lines)."""

    def __init__(self, vs: VectorSheet, skip_paths: set[int], max_mm: float) -> None:
        b = vs.path_bbox.astype(np.float64)
        diag = np.hypot(b[:, 2] - b[:, 0], b[:, 3] - b[:, 1])
        ok = (diag <= max_mm) & vs.path_stroked.astype(bool)
        if skip_paths:
            ok[np.fromiter(skip_paths, dtype=np.int64, count=len(skip_paths))] = False
        seg_ok = ok[vs.seg_path]
        self.segs = vs.segs[seg_ok].astype(np.float64)
        pts, owner = resample(self.segs, 0.15)
        self.pts, self.owner = pts, owner
        self.tree = cKDTree(pts) if len(pts) else None
        self.seg_tree = cKDTree((self.segs[:, :2] + self.segs[:, 2:]) / 2) if len(self.segs) else None

    def glyph_at(self, p: np.ndarray, touch: float, window: float = 6.0) -> tuple[float, float, float, float] | None:
        """Bounding box of the connected glyph whose strokes pass within ``touch`` of ``p``."""
        if self.tree is None or self.seg_tree is None:
            return None
        hit = self.tree.query_ball_point(p, touch)
        if not hit:
            return None
        local = np.array(sorted(set(self.seg_tree.query_ball_point(p, window))), dtype=np.int64)
        if not len(local):
            return None
        touched = {int(self.owner[h]) for h in hit}
        labels = segment_components(self.segs[local], tol=0.15)
        want = {int(labels[k]) for k, s in enumerate(local) if int(s) in touched}
        sel = self.segs[local[np.isin(labels, list(want))]]
        if not len(sel):
            return None
        return (
            float(min(sel[:, 0].min(), sel[:, 2].min())),
            float(min(sel[:, 1].min(), sel[:, 3].min())),
            float(max(sel[:, 0].max(), sel[:, 2].max())),
            float(max(sel[:, 1].max(), sel[:, 3].max())),
        )


# ------------------------------------------------------------------------------- helpers
def _box(d: dict[str, Any]) -> tuple[float, float, float, float]:
    b = d["bboxMm"]
    return (float(b["x"]), float(b["y"]), float(b["x"]) + float(b["w"]), float(b["y"]) + float(b["h"]))


def _center(d: dict[str, Any]) -> np.ndarray:
    return np.array([float(d["centerMm"]["x"]), float(d["centerMm"]["y"])])


def _box_dist(p: np.ndarray, b: tuple[float, float, float, float]) -> float:
    dx = max(b[0] - p[0], 0.0, p[0] - b[2])
    dy = max(b[1] - p[1], 0.0, p[1] - b[3])
    return math.hypot(dx, dy)


def _overlap(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    """Share of box ``a`` inside box ``b`` (degenerate boxes padded by 0.1 mm)."""
    ax0, ay0, ax1, ay1 = a[0] - 0.05, a[1] - 0.05, a[2] + 0.05, a[3] + 0.05
    w = max(0.0, min(ax1, b[2]) - max(ax0, b[0]))
    h = max(0.0, min(ay1, b[3]) - max(ay0, b[1]))
    area = (ax1 - ax0) * (ay1 - ay0)
    return w * h / area if area > 0 else 0.0


def _poly_dist(p: np.ndarray, pts: np.ndarray) -> tuple[float, int]:
    """Distance from ``p`` to a polyline and the index of the segment reached."""
    a, b = pts[:-1], pts[1:]
    ab = b - a
    ll = (ab**2).sum(axis=1)
    t = np.clip(((p - a) * ab).sum(axis=1) / np.where(ll > 0, ll, 1.0), 0.0, 1.0)
    q = a + ab * t[:, None]
    d = np.hypot(q[:, 0] - p[0], q[:, 1] - p[1])
    k = int(np.argmin(d))
    return float(d[k]), k


class _UF:
    def __init__(self, n: int) -> None:
        self.p = list(range(n))

    def find(self, a: int) -> int:
        while self.p[a] != a:
            self.p[a] = self.p[self.p[a]]
            a = self.p[a]
        return a

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[max(ra, rb)] = min(ra, rb)


# ------------------------------------------------------------------------------- main
def split_pass_through(chains: Sequence[Chain], dets: Sequence[dict[str, Any]], idx: Iterable[int], reach: float) -> list[Chain]:
    """Split chains where they run through a luminaire centre (not at their own ends)."""
    centres = [(_center(dets[i])) for i in idx]
    out: list[Chain] = []
    for ch in chains:
        pieces = [ch.pts]
        x0, y0, x1, y1 = ch.bbox
        near = [c for c in centres if x0 - reach <= c[0] <= x1 + reach and y0 - reach <= c[1] <= y1 + reach]
        for c in near:
            nxt: list[np.ndarray] = []
            for pts in pieces:
                if len(pts) < 3:
                    nxt.append(pts)
                    continue
                d, k = _poly_dist(c, pts)
                if d > reach:
                    nxt.append(pts)
                    continue
                cum = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(pts, axis=0).T))])
                at = cum[k]
                if at < 1.5 or cum[-1] - at < 1.5:  # it ends there anyway
                    nxt.append(pts)
                    continue
                nxt.append(np.vstack([pts[: k + 1], c[None, :]]))
                nxt.append(np.vstack([c[None, :], pts[k + 1 :]]))
            pieces = nxt
        if len(pieces) == 1:
            out.append(ch)
            continue
        for pts in pieces:
            out.append(Chain(pts, ch.rgb, ch.width, ch.n_dashes, ch.ambiguous_joins, ch.exploded, ch.paths))
    return out


def _attach(
    p: np.ndarray,
    dets: Sequence[dict[str, Any]],
    cand_idx: list[int],
    tree: cKDTree | None,
    ink: Ink | None,
    prm: LinkParams,
) -> End:
    if tree is None:
        return End()
    near = tree.query_ball_point(p, 15.0)
    cands = [cand_idx[k] for k in near]
    if not cands:
        return End()
    # 1) by ink: the glyph the end touches
    if ink is not None:
        g = ink.glyph_at(p, prm.ink_touch_mm)
        if g is not None and (g[2] - g[0]) <= 15 and (g[3] - g[1]) <= 15:
            scored = sorted(((_overlap(g, _box(dets[i])), i) for i in cands), reverse=True)
            scored = [s for s in scored if s[0] >= 0.5]
            if scored:
                best = scored[0]
                amb = len(scored) > 1 and scored[1][0] >= best[0] - 0.15
                if amb:  # two boxes hold the glyph: prefer the one whose centre is nearer the glyph's
                    gc = np.array([(g[0] + g[2]) / 2, (g[1] + g[3]) / 2])
                    dd = sorted((float(np.hypot(*(_center(dets[i]) - gc))), i) for _, i in scored[:3])
                    if dd[1][0] - dd[0][0] > prm.ambiguous_slack_mm:
                        return End(det=dd[0][1], by_ink=True, glyph=g)
                return End(det=best[1], ambiguous=amb, by_ink=True, glyph=g)
    # 2) by distance to the box, relative to the symbol size
    within: list[tuple[float, float, int]] = []
    for i in cands:
        b = _box(dets[i])
        size = max(b[2] - b[0], b[3] - b[1])
        bd = _box_dist(p, b)
        if bd <= prm.tol_rel * size + prm.tol_abs_mm:
            within.append((float(np.hypot(*(_center(dets[i]) - p))), bd, i))
    if not within:
        return End()
    within.sort()
    amb = len(within) > 1 and within[1][0] <= within[0][0] + prm.ambiguous_slack_mm
    # an end that stops short of the box (not inside it) is a weaker attachment only when ambiguous
    return End(det=within[0][2], ambiguous=amb)


def _nearest_symbol_of_notes(
    spans: Sequence[SpanLike], pattern: re.Pattern[str], dets: Sequence[dict[str, Any]], idx: list[int], reach: float
) -> set[int]:
    """Detections (of ``idx``) that are the nearest one to a note matching ``pattern``."""
    out: set[int] = set()
    if not idx:
        return out
    for s in spans:
        if not pattern.search(s.text) or len(s.text) > 40:
            continue
        b = _note_block(s, spans)
        best: tuple[float, int] | None = None
        for i in idx:
            d = _box_dist(_center(dets[i]), (b[0], b[1], b[2], b[3]))
            if d <= reach and (best is None or d < best[0]):
                best = (d, i)
        if best is not None:
            out.add(best[1])
    return out


def _note_block(s: SpanLike, spans: Sequence[SpanLike]) -> tuple[float, float, float, float]:
    """The span plus the lines stacked right above / below it (a two-line note such as
    "מפסק / למאוורר" is one block; its nearest symbol is the one it labels)."""
    x0, y0, x1, y1 = s.bbox
    grown = True
    while grown:
        grown = False
        for o in spans:
            ox0, oy0, ox1, oy1 = o.bbox
            if (ox0, oy0, ox1, oy1) == (x0, y0, x1, y1) or len(o.text) > 40:
                continue
            sh, oh = s.bbox[3] - s.bbox[1], oy1 - oy0
            if not (0.6 * sh <= oh <= 1.6 * sh):  # another line of the same note has the same size
                continue
            h = min(sh, oh)
            ov = min(x1, ox1) - max(x0, ox0)
            gap = max(oy0 - y1, y0 - oy1)
            stacked = h > 0 and ov >= 0.5 * min(x1 - x0, ox1 - ox0) and -0.2 * h <= gap <= 0.8 * h and (y1 - y0) < 4 * sh
            if stacked and (ox0 < x0 or oy0 < y0 or ox1 > x1 or oy1 > y1):
                x0, y0, x1, y1 = min(x0, ox0), min(y0, oy0), max(x1, ox1), max(y1, oy1)
                grown = True
    return (x0, y0, x1, y1)


def sensor_entries(legend_doc: dict[str, Any] | None, spans: Sequence[SpanLike]) -> set[str]:
    """Legend / fixture-type entries whose table row mentions a motion sensor (notes column)."""
    out: set[str] = set()
    if not legend_doc:
        return out
    legends = {lg["id"]: lg["bboxMm"] for lg in legend_doc.get("legends", [])}
    sens = [s for s in spans if _SENSOR.search(s.text)]
    for e in legend_doc.get("entries", []):
        if _SENSOR.search(str(e.get("label", ""))):
            out.add(str(e["id"]))
            continue
        lb, lg = e.get("labelBboxMm"), legends.get(e.get("legendId"))
        if not lb or not lg:
            continue
        y0, y1 = float(lb["y"]), float(lb["y"]) + float(lb["h"])
        x0, x1 = float(lg["x"]), float(lg["x"]) + float(lg["w"])
        for s in sens:
            cy = (s.bbox[1] + s.bbox[3]) / 2
            cx = (s.bbox[0] + s.bbox[2]) / 2
            if y0 - 0.5 <= cy <= y1 + 0.5 and x0 - 1 <= cx <= x1 + 1:
                out.add(str(e["id"]))
    return out


def build_links(
    chains: Sequence[Chain],
    dets: Sequence[dict[str, Any]],
    *,
    vs: VectorSheet | None = None,
    skip_paths: set[int] | None = None,
    spans: Sequence[SpanLike] = (),
    legend_doc: dict[str, Any] | None = None,
    scale_den: int | None = None,
    params: LinkParams | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """``(links document, stats)`` for one sheet."""
    prm = params or LinkParams()
    sw = [i for i, d in enumerate(dets) if d.get("class") in SWITCH_CLASSES]
    lum = [i for i, d in enumerate(dets) if d.get("class") in LUMINAIRE_CLASSES]
    cand_idx = sw + lum
    tree = cKDTree(np.array([_center(dets[i]) for i in cand_idx])) if cand_idx else None
    chains = split_pass_through(chains, dets, lum, prm.pass_through_mm)
    ink = Ink(vs, skip_paths or set(), prm.symbol_max_mm) if vs is not None else None

    arcs: list[Arc] = []
    for ch in chains:
        a = Arc(ch)
        a.ends = [_attach(ch.pts[0], dets, cand_idx, tree, ink, prm), _attach(ch.pts[-1], dets, cand_idx, tree, ink, prm)]
        if a.ends[0].det is not None and a.ends[0].det == a.ends[1].det:
            continue  # a dashed outline of one symbol, not a wire
        arcs.append(a)
    # wiring = chains with ≥ 1 attached end, in a wiring pen (learned from chains attached at both ends)
    pens = Counter((a.chain.rgb, a.chain.width) for a in arcs if a.ends[0].det is not None and a.ends[1].det is not None)
    # the wiring pen dominates the attached chains; another pen needs a comparable share (≥ 30 %)
    top = max(pens.values(), default=0)
    wire_pens = {p for p, n in pens.items() if n >= max(2, 0.3 * top)}
    if prm.wire_colours:
        wire_pens |= {(a.chain.rgb, a.chain.width) for a in arcs if a.chain.rgb in prm.wire_colours}
    kept: list[Arc] = []
    for a in arcs:
        both = a.ends[0].det is not None and a.ends[1].det is not None
        one = a.ends[0].det is not None or a.ends[1].det is not None
        pen = (a.chain.rgb, a.chain.width)
        curved_wire = a.chain.curvature() > 0.05 and (a.chain.n_dashes >= 5 or not a.chain.exploded)
        if (both and (pen in wire_pens or curved_wire)) or (one and pen in wire_pens):
            kept.append(a)
    arcs = kept
    # branches: a dangling end on another wire
    for k, a in enumerate(arcs):
        for e_i in (0, 1):
            e = a.ends[e_i]
            if e.det is not None:
                continue
            p = a.chain.pts[0] if e_i == 0 else a.chain.pts[-1]
            best: tuple[float, int] | None = None
            for j, b in enumerate(arcs):
                if j == k:
                    continue
                d, _ = _poly_dist(p, b.chain.pts)
                if d <= prm.branch_mm and (best is None or d < best[0]):
                    best = (d, j)
            if best is not None:
                e.chain = best[1]
    for n, a in enumerate(sorted(arcs, key=lambda a: (round(float(a.chain.pts[0][1]), 1), round(float(a.chain.pts[0][0]), 1)))):
        a.id = f"a_{n + 1}"
    arcs.sort(key=lambda a: int(a.id[2:]))

    n_virt = _infer_switches(arcs, dets, set(sw), prm.distinct_glyph_mm)
    # components over detections (0..D-1), arcs (D..D+A-1) and inferred switches (D+A..)
    D, A = len(dets), len(arcs)
    uf = _UF(D + A + n_virt)
    for k, a in enumerate(arcs):
        for e in a.ends:
            if e.det is not None:
                uf.union(D + k, e.det)
            elif e.virtual is not None:
                uf.union(D + k, D + A + e.virtual)
            elif e.chain is not None:
                uf.union(D + k, D + e.chain)
    comps: dict[int, list[int]] = {}
    for i in cand_idx:
        comps.setdefault(uf.find(i), []).append(i)
    arcs_of: dict[int, list[int]] = {}
    for k in range(len(arcs)):
        arcs_of.setdefault(uf.find(D + k), []).append(k)
    for root in arcs_of:  # circuits whose arcs touch no symbol at all are not wiring
        comps.setdefault(root, [])
    virt_count: Counter[int] = Counter(uf.find(D + A + v) for v in range(n_virt))

    # evidence from notes / legend
    existing = {i for i in lum if dets[i].get("lifecycle") == "existing"}
    existing_notes = _nearest_symbol_of_notes(spans, _EXISTING, dets, sw + lum, prm.note_reach_mm)
    existing |= existing_notes & set(lum)
    existing_sw = {i for i in sw if dets[i].get("lifecycle") == "existing" or i in existing_notes}
    sens_entries = sensor_entries(legend_doc, spans)
    sensor = {i for i in lum if dets[i].get("legendEntryId") in sens_entries}
    sensor |= _nearest_symbol_of_notes(spans, _SENSOR, dets, lum, prm.note_reach_mm)
    fan_notes = _nearest_symbol_of_notes(spans, _FAN, dets, sw + lum, prm.note_reach_mm)
    add_notes = _nearest_symbol_of_notes(spans, _ADD, dets, sw, prm.note_reach_mm)
    merge_mm = prm.point_merge_m * 1000.0 / float(scale_den or 50)

    points: list[dict[str, Any]] = []
    point_of: dict[int, str] = {}
    groups: list[dict[str, Any]] = []
    unlinked_switches = 0
    unlinked_lums: list[int] = []

    def make_points(members: list[int], comp_arcs: list[int]) -> list[str]:
        ls = [i for i in members if i in set(lum)]
        puf = _UF(len(ls))
        pos = {i: k for k, i in enumerate(ls)}
        for k in comp_arcs:
            a, b = arcs[k].ends[0].det, arcs[k].ends[1].det
            if a in pos and b in pos and float(np.hypot(*(_center(dets[a]) - _center(dets[b])))) <= merge_mm:
                puf.union(pos[a], pos[b])
        clusters: dict[int, list[int]] = {}
        for i in ls:
            clusters.setdefault(puf.find(pos[i]), []).append(i)
        ids = []
        for cl in sorted(clusters.values(), key=lambda c: min(c)):
            pid = f"pt_{len(points) + 1}"
            c = np.mean([_center(dets[i]) for i in cl], axis=0)
            lc = "existing" if all(i in existing for i in cl) else "new"
            points.append(
                {
                    "id": pid,
                    "luminaireIds": [dets[i]["id"] for i in cl],
                    "centerMm": {"x": round(float(c[0]), 2), "y": round(float(c[1]), 2)},
                    "lifecycle": lc,
                }
            )
            for i in cl:
                point_of[i] = pid
            ids.append(pid)
        return ids

    for root in sorted(comps, key=lambda r: min(comps[r]) if comps[r] else D + min(arcs_of.get(r, [0]))):
        members = sorted(comps[root])
        comp_arcs = sorted(arcs_of.get(root, []))
        s_ids = [i for i in members if i in set(sw)]
        l_ids = [i for i in members if i in set(lum)]
        if not comp_arcs:
            if s_ids and not l_ids:
                unlinked_switches += len(s_ids)
                continue
            # a lone luminaire: existing → unchanged point; motion sensor → its own group; else it is
            # listed as unlinked (a new point always has a switch arc on a plan that draws them —
            # most often an existing point whose "נק' קיימת" note was not read, or a duplicate)
            if all(i in existing for i in l_ids):
                make_points(l_ids, [])
                continue
            if not any(i in sensor for i in l_ids):
                make_points(l_ids, [])
                unlinked_lums.extend(l_ids)
                continue
        n_v = virt_count.get(root, 0)
        n_sw = len(s_ids) + n_v
        if not n_sw and not l_ids:
            continue  # dashes between nothing we know
        reasons: list[str] = []
        conf = prm.base_conf
        n_amb = sum(1 for k in comp_arcs for e in arcs[k].ends if e.det is not None and e.ambiguous)
        n_dang = sum(1 for k in comp_arcs for e in arcs[k].ends if e.det is None and e.chain is None and e.virtual is None)
        n_cross = sum(1 for k in comp_arcs if arcs[k].chain.ambiguous_joins)
        if n_amb:
            conf *= 0.65**n_amb
            reasons.append(R_AMBIG)
        if n_dang:
            conf *= 0.5**n_dang
            reasons.append(R_DANGLING)
        if n_cross:
            conf *= 0.8
            reasons.append(R_CROSSING)
        if n_v:
            conf *= 0.75
            reasons.append(R_INFERRED)
        pids = make_points(l_ids, comp_arcs)
        pts_existing = [p for p in points if p["id"] in pids and p["lifecycle"] == "existing"]
        # a *fan switch* (4.14) is told by the switch (class / "מפסק למאוורר" note), not by the point:
        # "להוסיף מחלף" on a light+fan point is a two-way added to an existing point (4.12)
        fan = any(dets[i]["class"] == "switch_fan" or i in fan_notes for i in s_ids)
        if not n_sw:
            if any(i in sensor for i in l_ids):
                kind = "sensor"
                if not any(dets[i].get("legendEntryId") in sens_entries for i in l_ids):
                    reasons.append(R_SENSOR)
                    conf *= 0.85
            else:
                kind = "single"
                reasons.append(R_NO_ARC if not comp_arcs else R_NO_SWITCH)
                conf = min(conf, 0.4)
        elif not l_ids:
            kind = "single"
            reasons.append(R_NO_POINT)
            conf = min(conf, 0.45)
        elif pids and (len(pts_existing) == len(pids) or (n_sw == 1 and s_ids and s_ids[0] in add_notes)):
            # every point existing, or the only switch is labelled "להוסיף …" (adding to what exists)
            kind = "add_to_existing"
            if len([i for i in s_ids if i not in existing_sw]) + n_v > 1:  # switches marked "קיים" are not added
                reasons.append(R_MANY)
                conf *= 0.75
        else:
            if pts_existing:
                reasons.append(R_MIXED)
                conf *= 0.7
            if n_sw == 1:
                kind = "single" if len(pids) == 1 else "shared"
                if s_ids and dets[s_ids[0]]["class"] == "switch_2way" and s_ids[0] not in add_notes:
                    reasons.append(R_PARTNER)
                    conf *= 0.8
            else:
                kind = "two_way"
                if n_sw > 2:
                    reasons.append(R_MANY)
                    conf *= 0.75
                if any(dets[i]["class"] == "switch_single" for i in s_ids):
                    reasons.append(R_SW_TYPE)
                    conf *= 0.85
        member_dets = [dets[i] for i in s_ids + l_ids]
        if any(R_FLOOR in (d.get("reasons") or []) for d in member_dets):
            reasons.append(R_FLOOR)
        floors = Counter(d.get("floor") for d in member_dets if d.get("floor"))
        conf = max(0.0, min(1.0, conf))
        reasons = list(dict.fromkeys(reasons))
        level = level_for(conf, reasons, warn=any(r not in INFO_REASONS for r in reasons))
        groups.append(
            {
                "id": "",
                "kind": kind,
                "switchIds": [dets[i]["id"] for i in s_ids],
                "pointIds": pids,
                "luminaireIds": [dets[i]["id"] for i in l_ids],
                "confidence": round(conf, 3),
                "level": level,
                "reasons": reasons,
                "floor": floors.most_common(1)[0][0] if floors else None,
                "fan": bool(fan),
                "inferredSwitches": n_v,
                "arcIds": [arcs[k].id for k in comp_arcs],
            }
        )
    for n, g in enumerate(groups):
        g["id"] = f"lk_{n + 1}"
    arcs_json = [
        {
            "id": a.id,
            "polylineMm": [{"x": round(float(x), 2), "y": round(float(y), 2)} for x, y in _simplify(a.chain.pts)],
            "ends": [dets[e.det]["id"] if e.det is not None else None for e in a.ends],
            "ambiguous": [bool(e.ambiguous) for e in a.ends],
            "inferredSwitch": [e.virtual is not None for e in a.ends],
        }
        for a in arcs
    ]
    doc = {
        "schema": LINKS_SCHEMA,
        "groups": groups,
        "points": points,
        "arcs": arcs_json,
        "unlinkedLuminaireIds": [dets[i]["id"] for i in sorted(unlinked_lums)],
    }
    return doc, link_stats(doc, unlinked_switches=unlinked_switches)


def _infer_switches(arcs: list[Arc], dets: Sequence[dict[str, Any]], sw: set[int], distinct_mm: float) -> int:
    """Arc ends attached to one switch detection but touching distinct glyphs (a bank where one
    switch was not detected): the glyph nearest the detection keeps it, every other glyph becomes
    an inferred switch. Returns the number of inferred switches (``End.virtual`` set)."""
    by_det: dict[int, list[tuple[End, np.ndarray]]] = {}
    for a in arcs:
        for e in a.ends:
            if e.det in sw and e.glyph is not None:
                g = e.glyph
                by_det.setdefault(e.det, []).append((e, np.array([(g[0] + g[2]) / 2, (g[1] + g[3]) / 2])))
    n = 0
    for det, ends in sorted(by_det.items()):
        clusters: list[tuple[np.ndarray, list[End]]] = []
        for e, gc in ends:
            for c, members in clusters:
                if float(np.hypot(*(c - gc))) <= distinct_mm:
                    members.append(e)
                    break
            else:
                clusters.append((gc, [e]))
        if len(clusters) < 2:
            continue
        dc = _center(dets[det])
        clusters.sort(key=lambda c: float(np.hypot(*(c[0] - dc))))
        for _c, members in clusters[1:]:
            for e in members:
                e.det, e.virtual, e.ambiguous = None, n, False
            n += 1
    return n


def link_stats(doc: dict[str, Any], *, unlinked_switches: int = 0) -> dict[str, Any]:
    gs = doc.get("groups", [])
    lv = Counter(g["level"] for g in gs)
    return {
        "groups": len(gs),
        "green": lv.get("green", 0),
        "yellow": lv.get("yellow", 0),
        "red": lv.get("red", 0),
        "byKind": dict(sorted(Counter(g["kind"] for g in gs).items())),
        "arcs": len(doc.get("arcs", [])),
        "danglingEnds": sum(
            1
            for a in doc.get("arcs", [])
            for e, inf in zip(a.get("ends", []), a.get("inferredSwitch", [False, False]), strict=False)
            if e is None and not inf
        ),
        "inferredSwitches": sum(int(g.get("inferredSwitches", 0)) for g in gs),
        "unlinkedSwitches": unlinked_switches,
        "unlinkedLuminaires": len(doc.get("unlinkedLuminaireIds", [])),
    }


def _simplify(pts: np.ndarray, tol: float = 0.1) -> np.ndarray:
    """Douglas–Peucker (keeps the polyline small in the artifact)."""
    if len(pts) <= 2:
        return pts
    keep = np.zeros(len(pts), dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a, b = pts[i], pts[j]
        ab = b - a
        n = float(np.hypot(*ab))
        seg = pts[i + 1 : j]
        if n < 1e-9:
            d = np.hypot(*(seg - a).T)
        else:
            d = np.abs((seg[:, 0] - a[0]) * ab[1] - (seg[:, 1] - a[1]) * ab[0]) / n
        k = int(np.argmax(d))
        if d[k] > tol:
            m = i + 1 + k
            keep[m] = True
            stack.append((i, m))
            stack.append((m, j))
    return pts[keep]


__all__ = ["LINKS_SCHEMA", "LinkParams", "build_links", "link_stats", "sensor_entries", "split_pass_through"]
