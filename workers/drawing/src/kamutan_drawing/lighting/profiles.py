"""LED lighting profiles of a lighting sheet (Sprint 13, Worker-Areas).

The designer draws a lighting profile as a thin pale-yellow filled bar at true length (``attributes.profile_bars``).
Convention read on the drawings (Achituv, Yahav; Rubel held out):

* bars that meet end to end (an L along two walls) are ONE profile; its length is the sum of the bars;
* the kind is written beside the bar, parallel to it: "פרופיל שקוע" (recessed in the gypsum ceiling), "פרופיל מוגן מים"
  (water-protected), "פרופיל חיצוני" (surface); a bar with no label is a surface profile;
* the one-word tag "שקוע" written right at a bar marks a recessed profile too (Rubel; the same word beside a spot,
  away from any bar, is that spot's tag);
* a note away from the bar speaks about it through its leader (the leader ends on the bar or on the feed symbol at
  its end): "פרופיל מוגן מים בניתוק", and "סרט לד שיודבק מתחת לשיש" — an LED tape, not a profile.

``profile_runs`` returns paper-mm data only; the BOQ turns it into metres with the sheet scale (boq/profiles.py).
"""

from __future__ import annotations

import math
import re
from collections.abc import Sequence
from typing import Any

import numpy as np

from ..ingest.pdf_vector import SEG_LINE, VectorSheet
from .attributes import profile_bars

SURFACE, RECESSED, WATER, TAPE = "surface", "recessed", "water", "tape"
JOIN_MM = 1.5  # two bars of one profile meet at a corner
LABEL_REACH_MM = 6.0  # the kind label runs beside its bar
TIP_REACH_MM = 5.0  # a note's leader ends on the profile or on the feed symbol at its end
SEED_PAD_MM = 1.5  # the leader starts at the note's underline / edge
LEADER_JOIN_MM = 0.3
LEADER_MAX_SEGS = 40
LEADER_PEN_MM = 0.45
_PROFILE = re.compile(r"פרופיל")
_WATER = re.compile(r"מוגן\s*מים|מו.ן\s*מים|מים\s*מוגן")
_RECESSED = re.compile(r"שקוע|שכוע")
_SURFACE = re.compile(r"חיצוני")
_TAPE = re.compile(r"סרט\s*לד")
_BARE_RECESSED = re.compile(r"שקוע")
_FEED = re.compile(r"הזנה")  # "הזנה לפרופיל שקוע" names the feed point, not the bar beside it

Bar = tuple[float, float, float, float]
Box = tuple[float, float, float, float]
NOTE_LINE_GAP_MM = 3.0  # lines of one note are stacked a line apart
NOTE_MAX_H_MM, NOTE_MAX_W_MM = 16.0, 90.0  # a note is a few lines, never a column of the sheet


def _seg_dist(px: float, py: float, b: Bar) -> float:
    x0, y0, x1, y1 = b
    dx, dy = x1 - x0, y1 - y0
    d2 = dx * dx + dy * dy
    t = 0.0 if d2 <= 0 else max(0.0, min(1.0, ((px - x0) * dx + (py - y0) * dy) / d2))
    return math.hypot(px - (x0 + t * dx), py - (y0 + t * dy))


def _chains(bars: Sequence[Bar]) -> list[list[int]]:
    parent = list(range(len(bars)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, a in enumerate(bars):
        for j in range(i + 1, len(bars)):
            b = bars[j]
            ends = min(_seg_dist(a[0], a[1], b), _seg_dist(a[2], a[3], b), _seg_dist(b[0], b[1], a), _seg_dist(b[2], b[3], a))
            if ends <= JOIN_MM:
                parent[find(i)] = find(j)
    groups: dict[int, list[int]] = {}
    for i in range(len(bars)):
        groups.setdefault(find(i), []).append(i)
    return list(groups.values())


def label_kind(text: str, *, by_leader: bool = False) -> str | None:
    """Kind a text states for a profile bar; None when it says nothing about one. ``by_leader``: the text is a note
    whose leader points at the profile (a feed note "הזנה לשנאי עבור סרט לד" then names what it feeds)."""
    t = " ".join(text.split())
    if _TAPE.search(t):
        return TAPE if by_leader else None  # a tape note counts only through its leader
    if _FEED.search(t) and not by_leader:
        return None
    if _BARE_RECESSED.fullmatch(t):
        return None if by_leader else RECESSED  # the one-word tag written on a recessed profile (only right at a bar)
    if not _PROFILE.search(t):
        return None
    if _WATER.search(t):
        return WATER
    if _RECESSED.search(t):
        return RECESSED
    if _SURFACE.search(t):
        return SURFACE
    return None


def _note_block(box: Box, boxes: Sequence[Box]) -> Box:
    """The note a line belongs to: the lines stacked directly above / below it (≤ one line height apart, overlapping
    in x) — the leader starts at any of them."""
    x0, y0, x1, y1 = box
    grown = True
    while grown:
        grown = False
        h = NOTE_LINE_GAP_MM
        for bx0, by0, bx1, by1 in boxes:
            if bx1 < x0 or bx0 > x1 or by1 < y0 - h or by0 > y1 + h or (by1 - by0) > 2 * NOTE_LINE_GAP_MM:
                continue
            nx0, ny0, nx1, ny1 = min(x0, bx0), min(y0, by0), max(x1, bx1), max(y1, by1)
            if (nx0, ny0, nx1, ny1) != (x0, y0, x1, y1) and (ny1 - ny0) <= NOTE_MAX_H_MM and (nx1 - nx0) <= NOTE_MAX_W_MM:
                x0, y0, x1, y1 = nx0, ny0, nx1, ny1
                grown = True
    return (x0, y0, x1, y1)


class _Leaders:
    """Thin coloured annotation strokes (note underlines and leaders; never the pale-yellow profile pen)."""

    def __init__(self, vs: VectorSheet) -> None:
        rgb = vs.path_stroke_rgba[:, :3].astype(np.int32)
        chroma = rgb.max(axis=1) - rgb.min(axis=1) >= 60
        yellow = (rgb[:, 0] >= 200) & (rgb[:, 1] >= 200)
        ok_path = vs.path_stroked & (vs.path_fill_mode == 0) & (vs.path_width_mm < LEADER_PEN_MM) & chroma & ~yellow
        sel = ok_path[vs.seg_path] & (vs.seg_kind == SEG_LINE) if len(vs.seg_path) else np.zeros(0, bool)
        self.xy = vs.segs[sel].astype(np.float64)
        self.pen = [tuple(int(v) for v in rgb[k]) for k in vs.seg_path[sel]] if len(self.xy) else []

    def tips(self, bbox: tuple[float, float, float, float]) -> list[tuple[float, float]]:
        """Free ends of the strokes that start at the text box (same pen, joined end to end)."""
        if not len(self.xy):
            return []
        x0, y0, x1, y1 = bbox[0] - SEED_PAD_MM, bbox[1] - SEED_PAD_MM, bbox[2] + SEED_PAD_MM, bbox[3] + SEED_PAD_MM
        a, b = self.xy[:, :2], self.xy[:, 2:]
        mid = (a + b) / 2

        def inside(p: np.ndarray) -> np.ndarray:
            return (p[:, 0] >= x0) & (p[:, 0] <= x1) & (p[:, 1] >= y0) & (p[:, 1] <= y1)

        length = np.hypot(*(b - a).T)
        seeds = np.where((inside(a) | inside(b) | inside(mid)) & (length >= 1.5))[0].tolist()
        out: list[tuple[float, float]] = []
        for s0 in seeds:
            pen = self.pen[s0]
            same = np.array([p == pen for p in self.pen])
            seen = {s0}
            stack = [s0]
            while stack and len(seen) <= LEADER_MAX_SEGS:
                k = stack.pop()
                for end in (a[k], b[k]):
                    near = np.where(
                        same & ((np.hypot(*(a - end).T) <= LEADER_JOIN_MM) | (np.hypot(*(b - end).T) <= LEADER_JOIN_MM))
                    )[0].tolist()
                    for j in near:
                        if j not in seen:
                            seen.add(j)
                            stack.append(j)
            if len(seen) > LEADER_MAX_SEGS:
                continue  # a dimension chain / hatch, not a leader
            idx = np.array(sorted(seen))
            for k in idx:
                for end in (a[k], b[k]):
                    others = idx[idx != k]
                    joined = len(others) and bool(
                        (
                            (np.hypot(*(a[others] - end).T) <= LEADER_JOIN_MM)
                            | (np.hypot(*(b[others] - end).T) <= LEADER_JOIN_MM)
                        ).any()
                    )
                    if not joined and not (x0 <= end[0] <= x1 and y0 <= end[1] <= y1):
                        out.append((float(end[0]), float(end[1])))
        return out


def profile_runs(vs: VectorSheet | None, spans: Sequence[Any]) -> list[dict[str, Any]]:
    """The sheet's profiles: ``{id, kind, labelled, label, lengthMm, parts, centerMm}`` (paper mm)."""
    if vs is None:
        return []
    bars = profile_bars(vs)
    if not bars:
        return []
    chains = _chains(bars)
    best: dict[int, tuple[float, str, str]] = {}

    def offer(ci: int, d: float, kind: str, text: str) -> None:
        if ci not in best or d < best[ci][0]:
            best[ci] = (d, kind, text)

    def nearest(x: float, y: float) -> tuple[float, int]:
        return min((min(_seg_dist(x, y, bars[k]) for k in ch), ci) for ci, ch in enumerate(chains))

    leaders: _Leaders | None = None
    boxes = [(float(b[0]), float(b[1]), float(b[2]), float(b[3])) for s in spans if (b := getattr(s, "bbox", None)) is not None]
    for s in spans:
        text, bb = str(getattr(s, "text", "") or ""), getattr(s, "bbox", None)
        if bb is None or not text:
            continue
        box = (float(bb[0]), float(bb[1]), float(bb[2]), float(bb[3]))
        kind = label_kind(text)
        if kind is not None:  # a label written beside its bar
            d, ci = nearest((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
            if d <= LABEL_REACH_MM:
                offer(ci, d, kind, text)
                continue
        kind = label_kind(text, by_leader=True)
        if kind is None:
            continue
        leaders = leaders or _Leaders(vs)
        for tx, ty in leaders.tips(_note_block(box, boxes)):  # a note whose leader ends on the profile / its feed symbol
            d, ci = nearest(tx, ty)
            if d <= TIP_REACH_MM:
                offer(ci, -1.0 if kind == TAPE else LABEL_REACH_MM + d, kind, text)
    out: list[dict[str, Any]] = []
    for ci, ch in enumerate(sorted(chains, key=lambda c: (bars[c[0]][1], bars[c[0]][0]))):
        hit = best.get(chains.index(ch))
        parts = [bars[k] for k in ch]
        length = sum(math.hypot(b[2] - b[0], b[3] - b[1]) for b in parts)
        xs = [v for b in parts for v in (b[0], b[2])]
        ys = [v for b in parts for v in (b[1], b[3])]
        out.append(
            {
                "id": f"pf_{ci + 1}",
                "kind": hit[1] if hit else SURFACE,
                "labelled": hit is not None,
                "label": hit[2][:80] if hit else None,
                "lengthMm": round(length, 2),
                "parts": [[round(v, 2) for v in b] for b in parts],
                "centerMm": {"x": round((min(xs) + max(xs)) / 2, 2), "y": round((min(ys) + max(ys)) / 2, 2)},
            }
        )
    return out
