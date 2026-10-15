"""Reference walls: the wall geometry of an architecture / construction sheet, reused on the MEP sheets of the
same floor (thin partitions are often single lines there, so rooms merge — Sprint-2 gap).

Flow (all pure; the service stores the JSON next to the architecture version and passes it to later sheets):

    refs = reference_walls(prims, regions, scale)            # on an architecture / construction sheet
    doc = reference_walls_json(refs)                         # kamutan.walls/1 (store as walls.json.gz)
    refs = reference_walls_from_json(doc)                    # on the MEP sheet
    rooms = segment(prims, text, regions, scale, reference_walls=refs)

``segment`` aligns each reference drawing of the region's floor onto the sheet's own walls (translation,
:func:`.align.align`, accepted at IoU ≥ ``MIN_IOU``) and adds the wall-like pieces the sheet lacks. Prefer a
construction sheet (new + kept walls) over a master sheet (which also shows demolished walls).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import shapely
from shapely.geometry import Polygon
from shapely.geometry.base import BaseGeometry

from ..ingest.pdf_vector import VectorSheet
from ..types_sprint2 import Region
from .align import Alignment, align
from .walls import extract_walls

MIN_IOU = 0.45
DEFAULT_SCALE = 50


@dataclass
class ReferenceWalls:
    floor: str | None
    scale_denominator: int
    walls: BaseGeometry  # paper mm in the reference sheet's own frame
    sheet_id: str | None = None
    region_id: str | None = None
    closures: BaseGeometry | None = None  # its door / window closures (same frame)


def reference_walls(
    prims: VectorSheet,
    regions: Sequence[Region | Mapping[str, Any]],
    scale_denominator: int | None,
    *,
    sheet_id: str | None = None,
    exclude_paths: set[int] | None = None,
) -> list[ReferenceWalls]:
    """Walls (+ door / window closures) of every drawing region of an architecture / construction sheet."""
    regs = [Region.coerce(r) for r in regions] or [
        Region.from_bbox("r0", (0.0, 0.0, prims.width_mm, prims.height_mm), None, scale_denominator)
    ]
    ex = set(exclude_paths) if exclude_paths is not None else set(prims.stats.get("textPaths", []) or [])
    out: list[ReferenceWalls] = []
    for reg in regs:
        den = reg.scale_denominator or scale_denominator or DEFAULT_SCALE
        b = reg.bbox
        box = (max(0.0, b.x), max(0.0, b.y), min(prims.width_mm, b.x1), min(prims.height_mm, b.y1))
        ws = extract_walls(prims, box, scale_den=den, exclude_paths=ex)
        if not ws.walls.is_empty:
            cl = shapely.union_all(ws.bridges) if ws.bridges else None
            out.append(ReferenceWalls(reg.floor, int(den), ws.walls, sheet_id, reg.id, cl))
    return out


FLOOR_MIN_IOU = 0.45  # a reference drawing of another floor must align at least this well …
FLOOR_MARGIN = 0.25  # … and this much better than the best reference of the region's own floor


def infer_region_floors(
    prims: VectorSheet,
    regions: Sequence[Region | Mapping[str, Any]],
    scale_denominator: int | None,
    refs: Sequence[ReferenceWalls],
    *,
    exclude_paths: set[int] | None = None,
    sheet_id: str | None = None,
) -> dict[str, tuple[str, float]]:
    """``{regionId: (floor, iou)}`` for the regions whose walls align clearly better with the reference drawings of
    *another* floor than with those of their own (title-block) floor — the stacked two-plan sheets whose title says
    "basement + ground" while the second plan is the first floor. Only references with a floor and the region's
    scale are compared; references of this very sheet are ignored. Regions not listed keep their floor."""
    others = [r for r in refs if r.floor and (sheet_id is None or r.sheet_id != sheet_id)]
    if not others:
        return {}
    out: dict[str, tuple[str, float]] = {}
    for own in reference_walls(prims, regions, scale_denominator, exclude_paths=exclude_paths):
        best: dict[str, float] = {}
        for r in others:
            if r.scale_denominator != own.scale_denominator:
                continue
            al = align(r.walls, own.walls)
            if al is not None:
                best[str(r.floor)] = max(best.get(str(r.floor), 0.0), al.iou)
        if not best:
            continue
        fl, iou = max(best.items(), key=lambda kv: (kv[1], kv[0]))
        cur = best.get(str(own.floor), 0.0) if own.floor else 0.0
        if own.region_id and fl != own.floor and iou >= FLOOR_MIN_IOU and iou >= cur + FLOOR_MARGIN:
            out[own.region_id] = (fl, round(iou, 3))
    return out


def align_reference(ref: ReferenceWalls, own_walls: BaseGeometry) -> Alignment | None:
    """Translation moving ``ref.walls`` onto ``own_walls`` (None when not accepted)."""
    al = align(ref.walls, own_walls)
    if al is None or al.iou < MIN_IOU:
        return None
    return al


def reference_walls_json(refs: Sequence[ReferenceWalls]) -> dict[str, Any]:
    """``kamutan.walls/1`` document: per drawing ``{floor, scaleDenominator, sheetId, regionId, polygonsMm}``;
    each polygon ``{exterior: [{x,y}], holes: [[{x,y}]]}`` simplified at 0.1 mm."""

    def ring(coords: Any) -> list[dict[str, float]]:
        return [{"x": round(float(x), 2), "y": round(float(y), 2)} for x, y in list(coords)[:-1]]

    def polys_json(g: BaseGeometry | None) -> list[dict[str, Any]]:
        if g is None or g.is_empty:
            return []
        g = g.simplify(0.1, preserve_topology=True)
        polys = [g] if isinstance(g, Polygon) else [p for p in getattr(g, "geoms", []) if isinstance(p, Polygon)]
        return [
            {"exterior": ring(p.exterior.coords), "holes": [ring(h.coords) for h in p.interiors]} for p in polys if p.area > 0
        ]

    drawings = [
        {
            "floor": r.floor,
            "scaleDenominator": r.scale_denominator,
            "sheetId": r.sheet_id,
            "regionId": r.region_id,
            "polygonsMm": polys_json(r.walls),
            "closuresMm": polys_json(r.closures),
        }
        for r in refs
    ]
    return {"schema": "kamutan.walls/1", "drawings": drawings}


def _geom_from_json(items: Sequence[Mapping[str, Any]]) -> BaseGeometry | None:
    polys = []
    for p in items:
        ext = [(float(q["x"]), float(q["y"])) for q in p.get("exterior", [])]
        holes = [[(float(q["x"]), float(q["y"])) for q in h] for h in p.get("holes", [])]
        if len(ext) >= 3:
            polys.append(shapely.make_valid(Polygon(ext, [h for h in holes if len(h) >= 3])))
    return shapely.union_all(polys) if polys else None


def reference_walls_from_json(doc: Mapping[str, Any]) -> list[ReferenceWalls]:
    out: list[ReferenceWalls] = []
    for d in doc.get("drawings", []):
        walls = _geom_from_json(d.get("polygonsMm", []))
        if walls is None:
            continue
        out.append(
            ReferenceWalls(
                d.get("floor"),
                int(d.get("scaleDenominator") or DEFAULT_SCALE),
                walls,
                d.get("sheetId"),
                d.get("regionId"),
                _geom_from_json(d.get("closuresMm", [])),
            )
        )
    return out
