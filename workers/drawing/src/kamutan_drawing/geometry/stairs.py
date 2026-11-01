"""Stairs on plans: flights of tread lines + the step numbers written on them.

A *flight* is a set of ≥ ``MIN_LINES`` parallel runs (plain or dashed, one pen colour) of nearly equal length
(the stair width, 0.6–2.5 m real) whose extents overlap along their direction and whose offsets step regularly by a
going of 0.18–0.42 m. Flights of one colour ≤ ``MERGE_GAP_M`` apart form one stair (a stair turning at a landing).
Step numbers ("1".."17", "-1".."-11") read inside / beside a flight give the tread count when they are a consistent
sequence (≥ half of 1..max present); otherwise the count is the number of gaps between the tread lines.
"""

from __future__ import annotations

import math
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from shapely.geometry import LineString, MultiPoint, Polygon
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from ..fixtures.labels import text_items
from .hatches import Chain, _components

MIN_LINES = 4
WIDTH_M = (0.6, 2.5)
GOING_M = (0.18, 0.42)
LEN_TOL = 0.15
GOING_CV = 0.2
MERGE_GAP_M = 1.0
_NUM = re.compile(r"^[+\-−–]?\d{1,2}$")


@dataclass
class Flight:
    chains: list[Chain]
    theta: float
    going_mm: float
    width_mm: float
    poly: Polygon
    cclass: str
    rgb: tuple[int, int, int]


@dataclass
class Stair:
    flights: list[Flight]
    poly: BaseGeometry
    cclass: str
    rgb: tuple[int, int, int]
    lines: int
    numbers: list[int] = field(default_factory=list)
    numbers_xy: list[tuple[float, float]] = field(default_factory=list)

    @property
    def numbered(self) -> bool:
        if not self.numbers:
            return False
        top = max(abs(n) for n in self.numbers)
        return top >= 2 and len({abs(n) for n in self.numbers}) >= 0.5 * top

    @property
    def gaps(self) -> int:
        return sum(len(f.chains) - 1 for f in self.flights)

    @property
    def treads(self) -> int:
        if self.numbered:
            return max(abs(n) for n in self.numbers)
        return self.gaps

    @property
    def descending(self) -> bool:
        neg = sum(1 for n in self.numbers if n < 0)
        return bool(self.numbers) and neg > len(self.numbers) / 2


def flights(runs: Sequence[Chain], mm_per_m: float) -> list[Flight]:
    lo, hi = WIDTH_M[0] * mm_per_m, WIDTH_M[1] * mm_per_m
    cand = [c for c in runs if lo <= c.length <= hi]
    out: list[Flight] = []
    if len(cand) < MIN_LINES:
        return out
    by_key: dict[tuple[str, int], list[Chain]] = {}
    for c in cand:
        th = math.degrees(math.atan2(c.b[1] - c.a[1], c.b[0] - c.a[0])) % 180.0
        by_key.setdefault((c.cclass, round(th / 2.0) % 90), []).append(c)
    g_lo, g_hi = GOING_M[0] * mm_per_m, GOING_M[1] * mm_per_m
    for (cc, _), cs in by_key.items():
        if len(cs) < MIN_LINES:
            continue
        th = math.degrees(math.atan2(cs[0].b[1] - cs[0].a[1], cs[0].b[0] - cs[0].a[0])) % 180.0
        cos_t, sin_t = math.cos(math.radians(th)), math.sin(math.radians(th))
        info = []
        for ch in cs:
            ta, tb = sorted((cos_t * ch.a[0] + sin_t * ch.a[1], cos_t * ch.b[0] + sin_t * ch.b[1]))
            d = -sin_t * (ch.a[0] + ch.b[0]) / 2 + cos_t * (ch.a[1] + ch.b[1]) / 2
            info.append((d, ta, tb, ch))
        info.sort(key=lambda t: t[0])
        pairs: list[tuple[int, int]] = []
        for i in range(len(info)):
            for j in range(i + 1, len(info)):
                dd = info[j][0] - info[i][0]
                if dd > g_hi:
                    break
                if dd < g_lo:
                    continue
                li, lj = info[i][2] - info[i][1], info[j][2] - info[j][1]
                if abs(li - lj) > LEN_TOL * max(li, lj):
                    continue
                ov = min(info[i][2], info[j][2]) - max(info[i][1], info[j][1])
                if ov >= 0.8 * min(li, lj):
                    pairs.append((i, j))
        for comp in _components(len(info), pairs):
            if len(comp) < MIN_LINES:
                continue
            comp.sort(key=lambda k: info[k][0])
            # a tread drawn as a double line (nosing) is one tread line
            dedup: list[int] = []
            for k in comp:
                if dedup and info[k][0] - info[dedup[-1]][0] < 0.4 * g_lo:
                    continue
                dedup.append(k)
            comp = dedup
            if len(comp) < MIN_LINES:
                continue
            ds = np.array([info[k][0] for k in comp])
            gaps = np.diff(ds)
            if len(gaps) == 0 or float(gaps.mean()) <= 0:
                continue
            if float(gaps.std() / gaps.mean()) > GOING_CV or not (g_lo <= float(np.median(gaps)) <= g_hi):
                continue
            chs = [info[k][3] for k in comp]
            pts = [p for ch in chs for p in (ch.a, ch.b)]
            hull = MultiPoint(pts).convex_hull
            if not isinstance(hull, Polygon):
                continue
            width = float(np.median([info[k][2] - info[k][1] for k in comp]))
            out.append(Flight(chs, th, float(np.median(gaps)), width, hull, cc, chs[0].rgb))
    return out


def stairs(fls: Sequence[Flight], mm_per_m: float) -> list[Stair]:
    gap = MERGE_GAP_M * mm_per_m
    pairs = [
        (i, j)
        for i in range(len(fls))
        for j in range(i + 1, len(fls))
        if fls[i].cclass == fls[j].cclass and fls[i].poly.distance(fls[j].poly) <= gap
    ]
    out: list[Stair] = []
    for comp in _components(len(fls), pairs):
        fs = [fls[k] for k in comp]
        poly = unary_union([f.poly for f in fs])
        out.append(Stair(fs, poly, fs[0].cclass, fs[0].rgb, sum(len(f.chains) for f in fs)))
    return out


def number_tokens(spans: Sequence[Any]) -> list[tuple[float, float, int]]:
    """(x, y, n) of step numbers: lines made only of 1–2 digit integers ("-11 -10 -9", "17"); each token is placed
    along the line box by its character position."""
    out: list[tuple[float, float, int]] = []
    for t in text_items(spans):
        s = t.text.strip()
        toks = s.split()
        # a step-number line: all tokens numbers, or ≥ 4 tokens with at most one misread ("-11 -10 … -= -4")
        good = [tk for tk in toks if _NUM.match(tk)]
        if not toks or not (len(good) == len(toks) or (len(toks) >= 4 and len(good) >= len(toks) - 1)):
            continue
        n_chars = max(1, len(s))
        x0, y0, x1, y1 = t.bbox
        w = x1 - x0
        pos = 0
        for tk in toks:
            k = s.find(tk, pos)
            pos = k + len(tk)
            if not _NUM.match(tk):
                continue
            frac = (k + len(tk) / 2.0) / n_chars
            val = int(tk.replace("−", "-").replace("–", "-"))
            out.append((x0 + frac * w, (y0 + y1) / 2, val))
    return out


def attach_numbers(sts: Sequence[Stair], tokens: Sequence[tuple[float, float, int]], mm_per_m: float) -> None:
    from shapely.geometry import Point

    pad = 0.3 * mm_per_m
    for x, y, n in tokens:
        p = Point(x, y)
        best: tuple[float, Stair | None] = (pad + 1e-6, None)
        for st in sts:
            d = st.poly.distance(p)
            if d < best[0]:
                best = (d, st)
        if best[1] is not None and n != 0:
            best[1].numbers.append(n)
            best[1].numbers_xy.append((x, y))


def stair_line(st: Stair) -> LineString:
    pts = [p for f in st.flights for ch in f.chains for p in (ch.a, ch.b)]
    return LineString(pts[:2]) if len(pts) >= 2 else LineString([(0, 0), (0, 0)])
