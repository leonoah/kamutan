"""Sprint 6 (Worker-Geometry): construction geometry of plan sheets → ``geometry.json.gz`` (``kamutan.geometry/1``).

* :func:`analyze` — one sheet (all its regions): stairs (tread count), hatched / filled regions by meaning (gypsum,
  block, concrete, demolished, waterproofing, ceiling, valance …), new wall runs by kind (block / gypsum single /
  gypsum double / concrete retaining / low wall) with length, height and area, the sunken ("English") courtyard
  (faces, height from the yard levels, floor), lowered gypsum ceilings (dashed X boxes), labelled lines (valances,
  cistern screens, window closures) and per-sheet ``measures``.
* :func:`geometry_units` — the build's documents → one quantity per measure key (sheet authority per floor, stairs
  de-duplicated across floors, keys the drawings do not carry returned as ``computable: false`` + reason).

Shape: ``workers/drawing/NOTES.md`` "Sprint 6 — Worker-Geometry". Levels go through ``calibration.calibrate`` with the
class keys ``geometry:<kind>`` (not in the table → yellow at best).
"""

from .analyze import GEOMETRY_SCHEMA, KEYS, PLAN_DISCIPLINES, analyze, measures
from .project import geometry_units

GEOMETRY_FILE = "geometry.json.gz"

__all__ = ["GEOMETRY_FILE", "GEOMETRY_SCHEMA", "KEYS", "PLAN_DISCIPLINES", "analyze", "geometry_units", "measures"]
