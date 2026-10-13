"""Shared Sprint-2 types (docs/agents/SPRINT2_BRIEF.md). Owned by Worker-B; Worker-A imports them.

Coordinates are paper millimetres, origin top-left, y down (same frame as
:class:`~kamutan_drawing.ingest.pdf_vector.VectorSheet`). Points serialise as ``{x, y}`` objects.

* :class:`BBox` — axis-aligned box ``x, y, w, h`` (contracts ``bboxMm``), with adapters from/to
  ``(x0, y0, x1, y1)`` tuples (the convention of the Sprint-1 code) and ``{x,y,w,h}`` dicts.
* :class:`Region` — one drawing region of a sheet (``classify/regions.py`` dicts
  ``{id, floor, polygonMm, scaleDenominator}``) with :meth:`Region.from_dict`.
* :class:`Room` — one ``kamutan.rooms/1`` room, :meth:`Room.to_json`.
* :class:`LifecycleResult` — existing / new / demolish / unknown per bbox.
* ``TextLine`` / ``TextSpan`` re-exports and :class:`TextLike` (anything with ``bbox`` + ``text``):
  :func:`kamutan_drawing.rooms.segment` accepts OCR ``TextLine``s, read ``TextSpan``s or
  ``text.json`` lines (:func:`text_items_from_json`).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

from .ingest.pdf_vector import VectorSheet
from .ocr.dictionary import TextSpan
from .ocr.glyphs import TextLine

__all__ = [
    "BBox",
    "Level",
    "Lifecycle",
    "LifecycleResult",
    "Region",
    "Room",
    "SimpleText",
    "TextLike",
    "TextLine",
    "TextSpan",
    "VectorSheet",
    "level_for",
    "text_items_from_json",
    "vector_sheet_from_primitives",
]

Level = Literal["green", "yellow", "red"]
Lifecycle = Literal["existing", "new", "demolish", "unknown"]

GREEN_MIN = 0.85
RED_BELOW = 0.5


def level_for(confidence: float, reasons: Sequence[str] = (), *, warn: bool | None = None) -> Level:
    """Brief rule: green >= 0.85 with no warning reason, red < 0.5, else yellow.

    ``warn`` defaults to ``bool(reasons)`` (every listed reason is treated as a warning).
    """
    has_warn = bool(reasons) if warn is None else warn
    if confidence < RED_BELOW:
        return "red"
    if confidence >= GREEN_MIN and not has_warn:
        return "green"
    return "yellow"


@dataclass(frozen=True)
class BBox:
    x: float
    y: float
    w: float
    h: float

    @property
    def x1(self) -> float:
        return self.x + self.w

    @property
    def y1(self) -> float:
        return self.y + self.h

    @property
    def cx(self) -> float:
        return self.x + self.w / 2

    @property
    def cy(self) -> float:
        return self.y + self.h / 2

    def as_xyxy(self) -> tuple[float, float, float, float]:
        return (self.x, self.y, self.x1, self.y1)

    def expand(self, d: float) -> BBox:
        return BBox(self.x - d, self.y - d, self.w + 2 * d, self.h + 2 * d)

    def to_json(self) -> dict[str, float]:
        return {"x": round(self.x, 2), "y": round(self.y, 2), "w": round(self.w, 2), "h": round(self.h, 2)}

    @classmethod
    def from_xyxy(cls, b: Sequence[float]) -> BBox:
        x0, y0, x1, y1 = (float(v) for v in b[:4])
        return cls(min(x0, x1), min(y0, y1), abs(x1 - x0), abs(y1 - y0))

    @classmethod
    def from_json(cls, d: Mapping[str, Any]) -> BBox:
        return cls(float(d["x"]), float(d["y"]), float(d["w"]), float(d["h"]))

    @classmethod
    def coerce(cls, v: BBox | Sequence[float] | Mapping[str, Any]) -> BBox:
        """Accept a BBox, an ``(x0,y0,x1,y1)`` sequence / ndarray, or a ``{x,y,w,h}`` mapping."""
        if isinstance(v, BBox):
            return v
        if isinstance(v, Mapping):
            return cls.from_json(v)
        return cls.from_xyxy(list(v))


@dataclass
class Region:
    """One drawing region (viewport) of a sheet; ``polygon_mm`` is a list of ``(x, y)``."""

    id: str
    polygon_mm: list[tuple[float, float]]
    floor: str | None = None
    scale_denominator: int | None = None

    @property
    def bbox(self) -> BBox:
        xs = [p[0] for p in self.polygon_mm]
        ys = [p[1] for p in self.polygon_mm]
        return BBox(min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys))

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> Region:
        """From a ``classify.regions`` / contracts region ``{id, floor, polygonMm, scaleDenominator}``."""
        poly = [(float(p["x"]), float(p["y"])) for p in d.get("polygonMm", [])]
        den = d.get("scaleDenominator")
        return cls(id=str(d.get("id", "r0")), polygon_mm=poly, floor=d.get("floor"), scale_denominator=int(den) if den else None)

    @classmethod
    def from_bbox(cls, rid: str, b: BBox | Sequence[float], floor: str | None = None, scale: int | None = None) -> Region:
        bb = BBox.coerce(b)
        return cls(rid, [(bb.x, bb.y), (bb.x1, bb.y), (bb.x1, bb.y1), (bb.x, bb.y1)], floor, scale)

    @classmethod
    def coerce(cls, v: Region | Mapping[str, Any]) -> Region:
        return v if isinstance(v, Region) else cls.from_dict(v)


@dataclass
class Room:
    id: str
    name: str | None
    name_confidence: float
    floor: str | None
    polygon_mm: list[tuple[float, float]]
    area_m2: float
    perimeter_m: float
    confidence: float
    level: Level
    reasons: list[str] = field(default_factory=list)
    region_id: str | None = None

    def to_json(self) -> dict[str, Any]:
        """``kamutan.rooms/1`` room object."""
        return {
            "id": self.id,
            "name": self.name,
            "nameConfidence": round(self.name_confidence, 3),
            "floor": self.floor,
            "polygonMm": [{"x": round(x, 2), "y": round(y, 2)} for x, y in self.polygon_mm],
            "areaM2": round(self.area_m2, 2),
            "perimeterM": round(self.perimeter_m, 2),
            "confidence": round(self.confidence, 3),
            "level": self.level,
            "reasons": list(self.reasons),
        }


@dataclass(frozen=True)
class LifecycleResult:
    lifecycle: Lifecycle
    confidence: float
    reasons: list[str] = field(default_factory=list)


@runtime_checkable
class TextLike(Protocol):
    """Anything with a page-mm ``bbox`` (x0,y0,x1,y1) and a ``text``; ``conf`` is optional."""

    bbox: Any
    text: str


@dataclass
class SimpleText:
    bbox: tuple[float, float, float, float]
    text: str
    conf: float = 1.0
    height: float = 0.0


def text_items_from_json(lines: Iterable[Mapping[str, Any]]) -> list[SimpleText]:
    """``text.json.gz`` lines (``{text, bboxMm: [x0,y0,x1,y1], confidence, heightMm}``) -> :class:`SimpleText`."""
    out: list[SimpleText] = []
    for ln in lines:
        b = ln.get("bboxMm")
        if not b or not ln.get("text"):
            continue
        bb = (float(b[0]), float(b[1]), float(b[2]), float(b[3]))
        out.append(SimpleText(bb, str(ln["text"]), float(ln.get("confidence", 1.0)), float(ln.get("heightMm", 0.0))))
    return out


def vector_sheet_from_primitives(o: Mapping[str, Any]) -> VectorSheet:
    """Rebuild a :class:`VectorSheet` from a decoded ``primitives.msgpack.gz`` (``pipeline.artifacts.decode_primitives``).

    Lets the rooms / lifecycle stages run outside the parser sandbox on stored artifacts.
    """
    import numpy as np

    from .pipeline.artifacts import decode_array

    p = o["paths"]
    n = int(p["n"])
    dash_flat = decode_array(o["dash"]["flat"]).astype(float).tolist()
    dash_len = decode_array(o["dash"]["len"]).astype(int).tolist()
    dashes: list[tuple[float, ...]] = []
    k = 0
    for ln in dash_len:
        dashes.append(tuple(dash_flat[k : k + ln]))
        k += ln
    while len(dashes) < n:
        dashes.append(())
    layer = decode_array(p["layer"]).astype(np.int32) if "layer" in p else None
    page = o["page"]
    return VectorSheet(
        page_index=int(page.get("index", 0)),
        width_mm=float(page["widthMm"]),
        height_mm=float(page["heightMm"]),
        path_stroke_rgba=decode_array(p["strokeRgba"]).reshape(n, 4).astype(np.uint8),
        path_fill_rgba=decode_array(p["fillRgba"]).reshape(n, 4).astype(np.uint8),
        path_stroked=decode_array(p["stroked"]).astype(bool),
        path_fill_mode=decode_array(p["fillMode"]).astype(np.int8),
        path_width_mm=decode_array(p["widthMm"]).astype(np.float32),
        path_dash=dashes,
        path_closed=decode_array(p["closed"]).astype(bool),
        path_bbox=decode_array(p["bbox"]).reshape(n, 4).astype(np.float32),
        path_seg_start=decode_array(p["segStart"]).astype(np.int32),
        path_seg_count=decode_array(p["segCount"]).astype(np.int32),
        segs=decode_array(o["segs"]["xy"]).reshape(-1, 4).astype(np.float32),
        seg_path=decode_array(o["segs"]["path"]).astype(np.int32),
        seg_kind=decode_array(o["segs"]["kind"]).astype(np.int8),
        curves=decode_array(o["curves"]["pts"]).reshape(-1, 8).astype(np.float32),
        curve_path=decode_array(o["curves"]["path"]).astype(np.int32),
        path_layer=layer,
        layers=list(o.get("layers", [])),
        stats={"textPaths": list(o.get("textPaths", []))},
    )
