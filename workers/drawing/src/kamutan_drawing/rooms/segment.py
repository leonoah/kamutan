"""Room segmentation: wall geometry → closed free-space faces → named rooms with area.

Per drawing region (paper mm):

1. walls (:mod:`.walls`): filled wall polygons / heavy pen / parallel pairs, plus door and window
   bridges, plus a small closing (openings < 0.9 m);
2. free space = region box − walls; its faces that do not reach the region border are *closed*
   rooms;
3. faces that leak to the border (an opening we could not bridge) are cut by the building
   envelope (large closing of the walls, holes filled); the pieces become rooms with the reason
   "חדר לא סגור" unless they are mostly open (exterior);
4. tiny (< 1 m²) and thin (< 0.5 m wide) faces are dropped;
5. names from text inside the face (:mod:`.names`), area / perimeter with the region scale.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import shapely
import shapely.prepared
from shapely.geometry import MultiPolygon, Point, Polygon, box
from shapely.geometry.base import BaseGeometry

from ..ingest.pdf_vector import VectorSheet
from ..types_sprint2 import Region, Room, level_for
from .names import NameMatch, match_room_name
from .walls import WallSet, extract_walls

DEFAULT_SCALE = 50
CLOSE_GAP_M = 0.45  # closing radius: openings < 0.9 m are closed
ENVELOPE_GAP_M = 2.5  # building envelope closing radius
MIN_AREA_M2 = 1.0
MIN_WIDTH_M = 0.5
MAX_OPEN_SHARE = 0.15  # of the perimeter not bounded by walls -> exterior, dropped
MAX_ROOM_SHARE = 0.6  # of the region area -> exterior / background
TEXT_CONF_DEFAULT = 0.7  # text items without a confidence (raw OCR TextLine)

R_NOT_CLOSED = "חדר לא סגור"
R_NO_NAME = "ללא שם"
R_SCALE = 'קנ"מ לא ודאי'
R_NAME_UNSURE = "שם חדר לא ודאי"
R_NAMES_MERGED = "כמה שמות בחלל אחד"
R_NO_WALLS = "לא זוהו קירות"


@dataclass
class _Face:
    poly: Polygon
    closed: bool
    open_share: float


def _bbox_xyxy(t: Any) -> tuple[float, float, float, float] | None:
    b = getattr(t, "bbox", None)
    if b is None:
        return None
    v = [float(x) for x in list(b)[:4]]
    return (min(v[0], v[2]), min(v[1], v[3]), max(v[0], v[2]), max(v[1], v[3]))


def _polys(g: BaseGeometry) -> list[Polygon]:
    if g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    if isinstance(g, MultiPolygon):
        return list(g.geoms)
    return [p for p in getattr(g, "geoms", []) if isinstance(p, Polygon)]


def _fill_holes(g: BaseGeometry) -> BaseGeometry:
    return shapely.union_all([Polygon(p.exterior) for p in _polys(g)]) if not g.is_empty else g


def _faces(ws: WallSet, bx: Polygon, mm_per_m: float) -> tuple[list[_Face], BaseGeometry]:
    r = CLOSE_GAP_M * mm_per_m
    w1 = shapely.union_all([ws.walls, *ws.bridges]) if ws.bridges else ws.walls
    w1c = w1.buffer(r, join_style="mitre", mitre_limit=2.0).buffer(-r, join_style="mitre", mitre_limit=2.0).union(w1)
    free = bx.difference(w1c)
    border = bx.exterior.buffer(0.5)
    big_r = ENVELOPE_GAP_M * mm_per_m
    env: BaseGeometry | None = None
    out: list[_Face] = []
    wb = w1c.buffer(0.5)
    for f in _polys(free):
        if not f.intersects(border):
            out.append(_Face(f, True, 0.0))
            continue
        if env is None:
            env = _fill_holes(w1c.buffer(big_r, quad_segs=4).buffer(-big_r, quad_segs=4))
        for piece in _polys(f.intersection(env)):
            if piece.area <= 0:
                continue
            per = piece.exterior.length
            walled = piece.exterior.intersection(wb).length
            out.append(_Face(piece, False, max(0.0, 1.0 - walled / max(per, 1e-6))))
    return out, w1c


def _width_ok(p: Polygon, mm_per_m: float) -> bool:
    return not p.buffer(-0.5 * MIN_WIDTH_M * mm_per_m).is_empty


def _names_in(p: Polygon, texts: list[tuple[Point, str, float]]) -> list[tuple[NameMatch, float]]:
    found: list[tuple[NameMatch, float]] = []
    pp = shapely.prepared.prep(p)
    for pt, text, conf in texts:
        if not pp.contains(pt):
            continue
        m = match_room_name(text)
        if m is not None:
            found.append((m, m.score * conf))
    found.sort(key=lambda t: -t[1])
    return found


def _simplify(p: Polygon) -> list[tuple[float, float]]:
    s = p.simplify(0.15, preserve_topology=True)
    ext = s.exterior if isinstance(s, Polygon) and not s.is_empty else p.exterior
    coords = [(float(x), float(y)) for x, y in ext.coords]
    if len(coords) > 1 and coords[0] == coords[-1]:
        coords = coords[:-1]
    return coords


def segment(
    prims: VectorSheet,
    text: Sequence[Any],
    region_polygons: Sequence[Region | dict[str, Any]],
    scale_denominator: int | None,
    *,
    exclude_paths: set[int] | None = None,
    debug: dict[str, Any] | None = None,
) -> list[Room]:
    """Rooms of one vector sheet (brief signature; see module docstring).

    ``text``: OCR ``TextLine`` / read ``TextSpan`` / :class:`~..types_sprint2.SimpleText` items (``bbox`` x0,y0,x1,y1
    page mm + ``text``; optional ``conf``). ``region_polygons``: :class:`Region` or contracts region dicts; empty =
    the whole page. ``exclude_paths``: path indices to ignore (SHX text strokes; defaults to
    ``prims.stats['textPaths']`` when present). ``debug``: filled with per-region geometry for overlays.
    """
    regions = [Region.coerce(r) for r in region_polygons] or [
        Region.from_bbox("r0", (0.0, 0.0, prims.width_mm, prims.height_mm), None, scale_denominator)
    ]
    ex = set(exclude_paths) if exclude_paths is not None else set(prims.stats.get("textPaths", []) or [])
    texts: list[tuple[Point, str, float]] = []
    for t in text:
        bb = _bbox_xyxy(t)
        s = str(getattr(t, "text", "") or "")
        if bb is None or not s.strip():
            continue
        conf = getattr(t, "conf", None)
        if conf is None:
            conf = getattr(t, "confidence", None)
        c = float(conf) if conf is not None else TEXT_CONF_DEFAULT
        texts.append((Point((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2), s, min(1.0, max(0.3, c))))

    rooms: list[Room] = []
    for reg in regions:
        scale_reasons: list[str] = []
        den = reg.scale_denominator or scale_denominator
        if den is None or den <= 0:
            den = DEFAULT_SCALE
            scale_reasons.append(R_SCALE)
        elif reg.scale_denominator and scale_denominator and reg.scale_denominator != scale_denominator:
            scale_reasons.append(R_SCALE)
        mm_per_m = 1000.0 / den
        rb = reg.bbox
        x0, y0 = max(0.0, rb.x), max(0.0, rb.y)
        x1, y1 = min(prims.width_mm, rb.x1), min(prims.height_mm, rb.y1)
        if x1 - x0 < 1 or y1 - y0 < 1:
            continue
        bx = box(x0, y0, x1, y1)
        ws = extract_walls(prims, (x0, y0, x1, y1), scale_den=den, exclude_paths=ex)
        if debug is not None:
            debug.setdefault("regions", []).append({"region": reg, "walls": ws, "faces": []})
        if ws.walls.is_empty:
            continue
        faces, _ = _faces(ws, bx, mm_per_m)
        reg_area = bx.area
        kept: list[tuple[_Face, float]] = []
        for f in faces:
            a_m2 = f.poly.area / (mm_per_m**2)
            if a_m2 < MIN_AREA_M2 or f.poly.area > MAX_ROOM_SHARE * reg_area:
                continue
            if not _width_ok(f.poly, mm_per_m):
                continue
            if not f.closed and f.open_share > MAX_OPEN_SHARE:
                continue
            kept.append((f, a_m2))
        # reading order: top to bottom, right to left
        kept.sort(key=lambda fa: (round(fa[0].poly.centroid.y / 20.0), -fa[0].poly.centroid.x))
        for f, a_m2 in kept:
            reasons: list[str] = []
            conf = 0.92 if f.closed else 0.6
            if not f.closed:
                reasons.append(R_NOT_CLOSED)
            names = _names_in(f.poly, texts)
            distinct: list[tuple[NameMatch, float]] = []
            for m, c in names:
                if all(m.name != d[0].name for d in distinct):
                    distinct.append((m, c))
            name: str | None = None
            name_conf = 0.0
            if distinct:
                # secondary names only when they are labels themselves (not words inside a note)
                top = [distinct[0], *[d for d in distinct[1:] if d[0].score >= 0.8 and d[1] >= 0.5 * distinct[0][1]]][:3]
                name = " / ".join(d[0].name for d in top)
                name_conf = float(top[0][1]) * (0.9 if len(top) > 1 else 1.0)
                if len(top) > 1:
                    reasons.append(R_NAMES_MERGED)
                if name_conf < 0.85:
                    reasons.append(R_NAME_UNSURE)
                    conf = min(conf, 0.8)
            else:
                reasons.append(R_NO_NAME)
                conf = min(conf, 0.7)
            if scale_reasons:
                reasons.extend(scale_reasons)
                conf = min(conf, 0.8)
            if ws.source == "parallel":
                conf = min(conf, 0.75)
            per_m = f.poly.exterior.length / mm_per_m
            room = Room(
                id=f"r_{len(rooms) + 1}",
                name=name,
                name_confidence=round(name_conf, 3),
                floor=reg.floor,
                polygon_mm=_simplify(f.poly),
                area_m2=float(a_m2),
                perimeter_m=float(per_m),
                confidence=conf,
                level=level_for(conf, reasons),
                reasons=reasons,
                region_id=reg.id,
            )
            rooms.append(room)
            if debug is not None:
                debug["regions"][-1]["faces"].append((f.poly, room))
    return rooms


def assign_room(rooms: Sequence[Room], x: float, y: float) -> Room | None:
    """Room containing the paper-mm point (helper for detections → ``roomId``); nearest within 1 mm else None."""
    pt = Point(x, y)
    best: tuple[float, Room] | None = None
    for r in rooms:
        if len(r.polygon_mm) < 3:
            continue
        d = Polygon(r.polygon_mm).distance(pt)
        if d == 0:
            return r
        if d <= 1.0 and (best is None or d < best[0]):
            best = (d, r)
    return best[1] if best else None


def rooms_json(rooms: Sequence[Room]) -> dict[str, Any]:
    """``kamutan.rooms/1`` document."""
    return {"schema": "kamutan.rooms/1", "rooms": [r.to_json() for r in rooms]}


__all__ = ["assign_room", "rooms_json", "segment"]
