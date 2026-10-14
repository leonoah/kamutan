"""Sanitary fixtures, faucets, garden taps and AC positions (Sprint 4, Worker-B). Pure functions, paper mm.

API for Worker-A (``pipeline/understand.py``) — exact signatures
-----------------------------------------------------------------
::

    from kamutan_drawing.fixtures import detect, fixtures_json, dedupe_floor, SheetFixtures

    fixtures: list[FixtureDetection] = detect(
        prims: VectorSheet,                      # the page primitives (same object rooms.segment gets)
        text: Sequence[TextLike],                # TextSpan / TextLine / SimpleText (bbox x0,y0,x1,y1 + text [+ conf])
        rooms: Sequence[Room | dict],            # rooms.segment(...) result of the SAME sheet ([] is fine)
        discipline: str | None,                  # sheet classification discipline
        *,
        regions: Sequence[Region | dict] | None = None,   # version regions (scale + floor per drawing)
        scale_denominator: int | None = None,             # sheet scale (fallback when a region has none)
        detections: Sequence[Detection | dict] | None = None,  # symbol detections (electrical: AC snaps to sockets)
        debug: dict | None = None,
    )
    det.to_json()            -> contracts Detection dict (id "d_fx_<n>", class, centerMm, bboxMm, angleDeg, score,
                                level, reasons, roomId, floor, lifecycle "unknown", supply None, annotations,
                                legendEntryId None, clusterId None) — append to detections.json.gz
    det.to_json(extended=True) adds source / attachedTo / label / leaderMm (needs the API agent's optional fields)
    fixtures_json(dets)      -> {"schema": "kamutan.fixtures/1", "fixtures": [...extended dicts]}

* Call it on every sheet (it gates by discipline itself: architecture/master/construction/plumbing → shapes +
  notes; plumbing → also faucets/garden taps/AC drains; electrical → AC only; others → []).
* Pass the rooms of the same sheet: room names gate the shapes (no tub in a bedroom) and every fixture gets
  ``roomId`` + ``floor``. Run ``lifecycle.classify`` on the fixture boxes like other detections if wanted.
* Worker-A's own plumbing text anchors (``symbols.detect._text_anchored``: fixture_wc_*, faucet_*, fixture_basin)
  duplicate these — drop them on sheets where ``detect`` runs.
* Cross-sheet: the same fixture is drawn on the master, construction and plumbing sheet of a floor. Count per
  floor with :func:`dedupe_floor` (project level, e.g. ``boq.build``): ``dedupe_floor([SheetFixtures(sheet_id,
  discipline, floor, fixtures, scale_denominator, page_size), ...]) -> list[FixtureDetection]`` (plumbing sheet
  wins, then master/architecture, then construction; matched copies are dropped, the kept one gets
  ``sheet_id`` and the reason ``מופיע בכמה גיליונות``).
"""

from .dedupe import SheetFixtures, anchors_from_rooms, dedupe_floor
from .detect import detect, fixtures_json
from .model import FIXTURE_CLASSES, FixtureDetection

__all__ = [
    "FIXTURE_CLASSES",
    "FixtureDetection",
    "SheetFixtures",
    "anchors_from_rooms",
    "dedupe_floor",
    "detect",
    "fixtures_json",
]
