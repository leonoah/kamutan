"""Lighting circuits from circuit tags (Sprint 10, Worker-Lighting).

``circuits_for_sheet(vs, spans, detections, ...) -> kamutan.circuits/1 document`` (the ``understand`` stage writes it
as ``circuits.json.gz``); :mod:`.tags` parses tag texts, :mod:`.circuits` pairs fixtures ↔ switch positions and
classifies the circuits, :mod:`.boq` turns the circuits of a project into BOQ units (rule kind ``lighting_circuit``).
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from ..ingest.pdf_vector import VectorSheet
from .circuits import (
    CIRCUIT_KINDS,
    CIRCUITS_SCHEMA,
    BBox,
    CircuitParams,
    SpanLike,
    build_circuits,
    enclosing_rects,
    leader_lines,
)
from .tags import Tag, TagRead, parse_tags

CIRCUITS_FILE = "circuits.json.gz"
CIRCUIT_DISCIPLINES = {"lighting"}


def circuits_for_sheet(
    vs: VectorSheet | None,
    spans: Sequence[SpanLike],
    detections: Sequence[dict[str, Any]],
    *,
    sheet_id: str = "",
    regions: Sequence[dict[str, Any]] | None = None,
    exclude: Sequence[BBox] = (),
    params: CircuitParams | None = None,
) -> dict[str, Any]:
    """Circuits of one lighting sheet; the small closed rectangles of ``vs`` are the switch boxes / note frames and
    its short open polylines the leader lines."""
    rects: list[BBox] = []
    leaders: list[BBox] = []
    if vs is not None and vs.n_paths:
        closed = vs.path_closed.tolist()
        rects = enclosing_rects(vs.path_bbox.tolist(), closed=closed)
        leaders = leader_lines(vs.segs, vs.seg_path, closed)
    return build_circuits(
        spans, detections, sheet_id=sheet_id, rects=rects, leaders=leaders, regions=regions, exclude=exclude, params=params
    )


__all__ = [
    "CIRCUITS_FILE",
    "CIRCUITS_SCHEMA",
    "CIRCUIT_DISCIPLINES",
    "CIRCUIT_KINDS",
    "CircuitParams",
    "Tag",
    "TagRead",
    "build_circuits",
    "circuits_for_sheet",
    "parse_tags",
]
