"""Room segmentation (Sprint 2/4, Worker-B). Entry points: :func:`segment` (brief signature), :func:`apply_fixtures`,
:mod:`.reference` (walls borrowed from the architecture sheet), :mod:`.align` (sheet-to-sheet translation)."""

from .reference import (
    ReferenceWalls,
    infer_region_floors,
    reference_walls,
    reference_walls_from_json,
    reference_walls_json,
)
from .segment import apply_fixtures, assign_room, rooms_json, segment

__all__ = [
    "ReferenceWalls",
    "apply_fixtures",
    "assign_room",
    "infer_region_floors",
    "reference_walls",
    "reference_walls_from_json",
    "reference_walls_json",
    "rooms_json",
    "segment",
]
