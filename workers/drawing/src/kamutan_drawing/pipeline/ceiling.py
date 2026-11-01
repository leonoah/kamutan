"""Calibration ceiling enforced by the orchestrator on the understanding artifacts (Stage 10, A-LIVE-03).

Every producer inside the sandbox already routes its level through :func:`kamutan_drawing.calibration.calibrate`.
The sandbox output is untrusted, though, and the orchestrator is the one that writes ``stats.calibration`` (the
table version the UI shows in its header). A child that ran with another table (an older worker image, a table that
failed to load in a different way, an env override that only the parent sees) could upload green items under a
"conservative" header — exactly the live symptom (39 green detections under "כיול שמרני").

:func:`cap_document` re-applies the *orchestrator's* table to every green item of a detections / rooms / links /
fixtures document before upload: an item stays green only when the table allows its class (and the org threshold),
never on a raster sheet. It only ever lowers a level (green → yellow with the table's reason) and never touches
scores, ids or geometry. Pure.
"""

from __future__ import annotations

import gzip
import json
from collections import Counter
from typing import Any

from ..calibration import R_HUMAN, ROOM_KEY, CalibrationTable, link_key

# document key → (list key, class key of an item)
KINDS: dict[str, str] = {"detections": "detections", "rooms": "rooms", "links": "groups", "fixtures": "fixtures"}


def _class_key(kind: str, item: dict[str, Any]) -> str:
    if kind == "rooms":
        return ROOM_KEY
    if kind == "links":
        return link_key(item.get("kind"))
    return str(item.get("class") or "unknown")


def cap_items(
    kind: str,
    items: list[Any],
    table: CalibrationTable,
    *,
    raster: bool = False,
    green_threshold: float | None = None,
) -> int:
    """Lower (in place) every green item the table does not allow; returns how many were lowered."""
    n = 0
    for it in items:
        if not isinstance(it, dict) or it.get("level") != "green":
            continue
        reasons = [str(r) for r in (it.get("reasons") or [])]
        if R_HUMAN in reasons:  # a person accepted it (never at ingest; kept for re-used documents)
            continue
        raw = it.get("scoreRaw", it.get("score", it.get("confidence", 1.0)))
        try:
            raw_f = float(raw if raw is not None else 1.0)
        except (TypeError, ValueError):
            raw_f = 1.0
        c = table.calibrate(
            _class_key(kind, it), raw_f, reasons, level="green", raster=raster, green_threshold=green_threshold, warn=False
        )
        if c.level != "green":
            it["level"] = c.level
            it["reasons"] = c.reasons
            n += 1
    return n


def cap_document(
    kind: str, doc: dict[str, Any], table: CalibrationTable, *, raster: bool = False, green_threshold: float | None = None
) -> int:
    key = KINDS.get(kind)
    if key is None or not isinstance(doc, dict) or not isinstance(doc.get(key), list):
        return 0
    return cap_items(kind, doc[key], table, raster=raster, green_threshold=green_threshold)


def cap_gz_json(
    kind: str, data: bytes, table: CalibrationTable, *, raster: bool = False, green_threshold: float | None = None
) -> tuple[bytes, int]:
    """``(bytes, lowered)`` for a gzipped JSON artifact; the input bytes unchanged when nothing was lowered."""
    try:
        doc = json.loads(gzip.decompress(data))
    except (OSError, ValueError, EOFError):
        return data, 0
    n = cap_document(kind, doc, table, raster=raster, green_threshold=green_threshold)
    if not n:
        return data, 0
    return gzip.compress(json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode(), mtime=0), n


def detection_counts(dets: list[Any]) -> dict[str, Any]:
    """``stats.detections`` of a (capped) detections list — same shape as ``understand.detection_stats``."""
    items = [d for d in dets if isinstance(d, dict)]
    lv = Counter(str(d.get("level")) for d in items)
    return {
        "total": len(items),
        "green": lv.get("green", 0),
        "yellow": lv.get("yellow", 0),
        "red": lv.get("red", 0),
        "unknown": sum(1 for d in items if d.get("class") == "unknown"),
        "byClass": dict(sorted(Counter(str(d.get("class")) for d in items).items())),
    }
