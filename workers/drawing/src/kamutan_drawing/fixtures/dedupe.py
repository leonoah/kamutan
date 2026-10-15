"""Cross-sheet de-duplication of fixtures of one floor.

A WC is drawn on the master, the construction and the plumbing sheet of its floor; an AC position appears as a
socket on the electrical sheet and as a drain note on the plumbing sheet. Per floor:

1. sheets are ranked by authority — plumbing, master / architecture, construction, electrical, other; the first
   sheet is the base, each next sheet is merged into the running result;
2. **alignment** (translation): the room outlines of both sheets (``room_polygons``, :func:`..rooms.align.align_polygons`,
   FFT correlation, accepted at IoU ≥ 0.3); else (scale ratio from the scale denominators) every pair of same-family items votes
   (2 mm bins, 3×3 neighbourhood; optional room-centroid *anchors* vote too); accepted when ≥ 2 votes and ≥ 40 %
   of the smaller set is matched; else identity when the pages have the same size, else nothing is merged
   (``יישור גיליונות נכשל — ייתכן כפל`` on the secondary items);
3. **match** greedily by distance within the family radius (fixtures 0.5 m, AC 1.6 m real): the secondary copy
   is dropped and listed in ``duplicates`` of the kept item; a text-only item confirmed by a drawn shape on another
   sheet becomes ``shape+text`` (``זוהה מכיתוב בלבד`` removed, score ≥ 0.85).
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field

from . import model as M
from .model import FixtureDetection

AUTHORITY = ("plumbing", "architecture_master", "architecture", "master", "construction", "electrical")
FAMILY = {
    "fixture_wc_concealed": "wc",
    "fixture_wc_monoblock": "wc",
    "fixture_basin": "sink",
    "fixture_kitchen_sink": "sink",
    "fixture_shower": "shower",
    "fixture_bath": "bath",
    "fixture_washing_machine": "washer",
    "faucet_wall": "faucet",
    "faucet_basin": "faucet",
    "garden_tap": "tap",
    "ac_unit": "ac",
}
RADIUS_M = {"ac": 1.6, "tap": 1.0}
DEFAULT_RADIUS_M = 0.5
BIN_MM = 2.0
ROOM_ALIGN_MIN_IOU = 0.3  # IoU of the room outlines (0.5 mm bands) after the shift


@dataclass
class SheetFixtures:
    sheet_id: str
    discipline: str | None
    floor: str | None
    fixtures: list[FixtureDetection]
    scale_denominator: int | None = 50
    page_size: tuple[float, float] | None = None  # (widthMm, heightMm) for the identity fallback
    anchors: list[tuple[str, float, float]] = field(default_factory=list)  # (kind, x, y), e.g. room centroids
    room_polygons: list[list[tuple[float, float]]] = field(default_factory=list)  # this floor's rooms (paper mm)


def _rank(d: str | None) -> int:
    d = (d or "").lower()
    return AUTHORITY.index(d) if d in AUTHORITY else len(AUTHORITY)


def _vote(a: list[tuple[str, float, float]], b: list[tuple[str, float, float]], k: float) -> tuple[int, float, float]:
    """(support, tx, ty) of the best translation with b ≈ k·a + t."""
    bins: Counter[tuple[int, int]] = Counter()
    for fa, xa, ya in a:
        for fb, xb, yb in b:
            if fa != fb:
                continue
            bins[(round((xb - k * xa) / BIN_MM), round((yb - k * ya) / BIN_MM))] += 1
    if not bins:
        return 0, 0.0, 0.0
    best = max(bins, key=lambda c: sum(bins.get((c[0] + i, c[1] + j), 0) for i in (-1, 0, 1) for j in (-1, 0, 1)))
    sup = sum(bins.get((best[0] + i, best[1] + j), 0) for i in (-1, 0, 1) for j in (-1, 0, 1))
    return sup, best[0] * BIN_MM, best[1] * BIN_MM


def _points(sf: SheetFixtures) -> list[tuple[str, float, float]]:
    pts = [(FAMILY.get(f.cls, f.cls), f.center[0], f.center[1]) for f in sf.fixtures]
    return pts + [(f"anchor:{k}", x, y) for k, x, y in sf.anchors]


def _match(
    base: list[FixtureDetection],
    base_xy: list[tuple[float, float]],
    sec: list[FixtureDetection],
    k: float,
    t: tuple[float, float],
    mm_per_m: float,
) -> list[tuple[int, int, float]]:
    pairs: list[tuple[float, int, int]] = []
    for j, s in enumerate(sec):
        fs = FAMILY.get(s.cls, s.cls)
        x, y = k * s.center[0] + t[0], k * s.center[1] + t[1]
        for i, b in enumerate(base):
            if FAMILY.get(b.cls, b.cls) != fs:
                continue
            d = math.dist((x, y), base_xy[i])
            if d <= RADIUS_M.get(fs, DEFAULT_RADIUS_M) * mm_per_m:
                pairs.append((d, i, j))
    pairs.sort()
    used_i: set[int] = set()
    used_j: set[int] = set()
    out: list[tuple[int, int, float]] = []
    for d, i, j in pairs:
        if i in used_i or j in used_j:
            continue
        used_i.add(i)
        used_j.add(j)
        out.append((i, j, d))
    return out


def dedupe_floor(sheets: Sequence[SheetFixtures]) -> list[FixtureDetection]:
    """Fixtures of one floor counted once (see module docstring). Input objects are not modified; every returned
    item keeps the coordinates of its own sheet (``sheet_id``)."""
    import copy

    ordered = sorted(sheets, key=lambda s: (_rank(s.discipline), s.sheet_id))
    result: list[FixtureDetection] = []
    result_xy: list[tuple[float, float]] = []  # positions in the base sheet frame
    result_pts: list[tuple[str, float, float]] = []
    base_sheet: SheetFixtures | None = None
    for sf in ordered:
        fx = [copy.deepcopy(f) for f in sf.fixtures]
        for f in fx:
            f.sheet_id = f.sheet_id or sf.sheet_id
        if base_sheet is None:
            base_sheet = sf
            result = fx
            result_xy = [f.center for f in fx]
            result_pts = _points(sf)
            continue
        den_b = base_sheet.scale_denominator or 50
        den_s = sf.scale_denominator or 50
        k = den_s / den_b  # secondary paper mm → base paper mm
        mm_per_m = 1000.0 / den_b
        t: tuple[float, float] | None = None
        if k == 1.0 and sf.room_polygons and base_sheet.room_polygons:
            from ..rooms.align import align_polygons

            al = align_polygons(sf.room_polygons, base_sheet.room_polygons)
            if al is not None and al.iou >= ROOM_ALIGN_MIN_IOU:
                t = (al.dx, al.dy)
        sup, tx, ty = _vote(_points(sf), result_pts, k)
        if t is None and sup >= 2:
            cand = _match(result, result_xy, fx, k, (tx, ty), mm_per_m)
            if len(cand) >= max(1, math.ceil(0.4 * min(len(result), len(fx)))):
                t = (tx, ty)
        same_page = bool(base_sheet.page_size and sf.page_size) and all(
            abs(a - b) < 1.0 for a, b in zip(base_sheet.page_size or (), sf.page_size or (), strict=True)
        )
        if t is None and same_page and k == 1.0:
            t = (0.0, 0.0)
        if t is None:
            for f in fx:
                if M.R_ALIGN_FAILED not in f.reasons:
                    f.reasons.append(M.R_ALIGN_FAILED)
                    f.relevel()
            result.extend(fx)
            result_xy.extend((float("nan"), float("nan")) for _ in fx)
            continue
        pairs = _match(result, result_xy, fx, k, t, mm_per_m)
        dropped = set()
        for i, j, _ in pairs:
            keep, dup = result[i], fx[j]
            keep.duplicates.append(f"{dup.sheet_id}/{dup.id}")
            if keep.source == "text" and dup.source in ("shape", "shape+text"):
                if FAMILY.get(keep.cls) == "sink":
                    keep.cls = dup.cls  # "נק' מים+ביוב" does not tell a basin from a kitchen sink; the drawing does
                keep.source = "shape+text"
                keep.reasons = [r for r in keep.reasons if r not in (M.R_TEXT_ONLY, M.R_NO_LEADER)]
                keep.score = max(keep.score, 0.85)
                keep.relevel()
            elif keep.source == "shape" and dup.source in ("text", "shape+text"):
                keep.source = "shape+text"
                keep.reasons = [r for r in keep.reasons if r != M.R_SHAPE_ONLY]
                if FAMILY.get(dup.cls) == "wc" and dup.source != "shape":
                    keep.cls = dup.cls  # the label's WC type wins over the shape guess
                    keep.reasons = [r for r in keep.reasons if r != M.R_WC_TYPE_SHAPE]
                keep.score = max(keep.score, 0.85)
                keep.relevel()
            dropped.add(j)
        for j, f in enumerate(fx):
            if j in dropped:
                continue
            xy = (k * f.center[0] + t[0], k * f.center[1] + t[1])  # into the base frame
            result.append(f)
            result_xy.append(xy)
            result_pts.append((FAMILY.get(f.cls, f.cls), xy[0], xy[1]))
    return result


def anchors_from_rooms(rooms: Sequence[object]) -> list[tuple[str, float, float]]:
    """Alignment anchors from rooms (Room objects or rooms.json dicts): (name, centroid) of named rooms."""
    from shapely.geometry import Polygon

    out: list[tuple[str, float, float]] = []
    for r in rooms:
        if isinstance(r, dict):
            name, pts = r.get("name"), [(p["x"], p["y"]) for p in r.get("polygonMm", [])]
        else:
            name, pts = getattr(r, "name", None), list(getattr(r, "polygon_mm", []))
        if not name or len(pts) < 3:
            continue
        c = Polygon(pts).centroid
        out.append((str(name), float(c.x), float(c.y)))
    return out
