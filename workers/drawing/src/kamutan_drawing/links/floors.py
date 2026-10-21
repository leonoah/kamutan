"""Effect of the user's floor confirmation on already computed artifacts (pure, no I/O).

When a sheet is ``confirmed`` on the sheet-confirmation screen, the floors (and, when given, the
regions with their floors) are authoritative: detections, rooms and link groups take the floor of
the confirmed region they lie in (a single confirmed floor applies to the whole sheet) and lose the
``קומה לא ודאית`` chip. Their level is re-derived: an item whose *only* warning was the floor
question goes back to green (a non-green detection / room always carries ≥ 1 reason, and the floor
rule only ever demoted green → yellow) — subject to the calibration table (Sprint 5: a class that may not be
green stays yellow with ``כיול שמרני…``) — a link group is re-levelled from its (raw) confidence and the
remaining reasons, then calibrated.

Used by the ``understand`` stage on reprocess (the orchestrator passes ``floorsConfirmed``) and by
Worker-BOQ's ``boq.build`` on stored artifacts, without re-parsing the sheet.
"""

from __future__ import annotations

import copy
from collections import Counter
from collections.abc import Mapping, Sequence
from typing import Any

from ..calibration import ROOM_KEY, default_table, link_key
from ..types_sprint2 import level_for

R_FLOOR = "קומה לא ודאית"


def _inside(x: float, y: float, poly: Sequence[Mapping[str, Any]]) -> bool:
    """Even-odd ray casting (polygon of ``{x, y}`` points)."""
    inside = False
    n = len(poly)
    for i in range(n):
        x0, y0 = float(poly[i]["x"]), float(poly[i]["y"])
        x1, y1 = float(poly[(i + 1) % n]["x"]), float(poly[(i + 1) % n]["y"])
        if (y0 > y) != (y1 > y) and x < (x1 - x0) * (y - y0) / ((y1 - y0) or 1e-12) + x0:
            inside = not inside
    return inside


def floor_resolver(sheet_doc: Mapping[str, Any], regions: Sequence[Mapping[str, Any]] | None = None) -> Any:
    """``f(x, y) -> floor | None`` from the confirmed regions (``regions`` argument, else
    ``sheet_doc["regions"]``), falling back to the single confirmed floor of the sheet."""
    regs = [r for r in (regions if regions is not None else sheet_doc.get("regions") or []) if r.get("floor")]
    floors = [str(f) for f in (sheet_doc.get("floors") or []) if f]
    only = floors[0] if len(set(floors)) == 1 else None

    def at(x: float, y: float) -> str | None:
        for r in regs:
            pts = r.get("polygonMm") or []
            if len(pts) >= 3 and _inside(x, y, pts):
                return str(r["floor"])
        return only

    return at


def _drop_floor(item: dict[str, Any], key: str) -> None:
    """Remove the floor chip; an item left without any reason was green before the floor rule demoted it — it goes
    back to green *through the calibration table* (conservative mode keeps a class without enough truth yellow,
    also on artifacts written before Sprint 5)."""
    reasons = [r for r in (item.get("reasons") or []) if r != R_FLOOR]
    if len(reasons) != len(item.get("reasons") or []):
        item["reasons"] = reasons
        if item.get("level") == "yellow" and not reasons:
            raw = item.get("scoreRaw", item.get("score", item.get("confidence", 1.0)))
            c = default_table().calibrate(key, float(raw if raw is not None else 1.0), [], level="green")
            item["level"], item["reasons"] = c.level, c.reasons


def apply_confirmed_floors(
    artifacts: Mapping[str, Any], sheet_doc: Mapping[str, Any] | None, regions: Sequence[Mapping[str, Any]] | None = None
) -> dict[str, Any]:
    """Return copies of ``artifacts`` (``{"detections": kamutan.detections/1, "rooms": kamutan.rooms/1,
    "links": kamutan.links/1}``, each optional) with the confirmed floors applied. Unconfirmed sheet
    (``sheet_doc.confirmed`` falsy) → plain copies. ``regions``: the version's regions (the API writes
    the confirmed ones there); defaults to ``sheet_doc["regions"]``."""
    out = {k: copy.deepcopy(v) for k, v in artifacts.items()}
    if not sheet_doc or not sheet_doc.get("confirmed"):
        return out
    at = floor_resolver(sheet_doc, regions)
    det_floor: dict[str, str | None] = {}
    dets = (out.get("detections") or {}).get("detections") or []
    for d in dets:
        c = d.get("centerMm") or {}
        fl = at(float(c.get("x", 0.0)), float(c.get("y", 0.0)))
        if fl is not None:
            d["floor"] = fl
        _drop_floor(d, str(d.get("class") or "unknown"))
        det_floor[str(d.get("id"))] = d.get("floor")
    for r in (out.get("rooms") or {}).get("rooms") or []:
        pts = r.get("polygonMm") or []
        if pts:
            fl = _room_floor(pts, at)
            if fl is not None:
                r["floor"] = fl
        _drop_floor(r, ROOM_KEY)
    for g in (out.get("links") or {}).get("groups") or []:
        members = [det_floor.get(i) for i in list(g.get("switchIds") or []) + list(g.get("luminaireIds") or [])]
        fl = Counter(f for f in members if f).most_common(1)
        if fl:
            g["floor"] = fl[0][0]
        if R_FLOOR in (g.get("reasons") or []):
            g["reasons"] = [r for r in g["reasons"] if r != R_FLOOR]
            # re-levelled from the raw confidence when the group carries it (Sprint 5); never adds keys (the BOQ
            # mirror of LinkGroup is strict)
            raw = float(g.get("confidenceRaw", g.get("confidence", 0.0)))
            c = default_table().calibrate(link_key(g.get("kind")), raw, g["reasons"], level=level_for(raw, g["reasons"]))
            g["level"], g["reasons"] = c.level, c.reasons
    return out


def _room_floor(pts: Sequence[Mapping[str, Any]], at: Any) -> str | None:
    try:
        from shapely.geometry import Polygon

        p = Polygon([(float(q["x"]), float(q["y"])) for q in pts]).representative_point()
        res: str | None = at(p.x, p.y)
        return res
    except (ValueError, TypeError, AttributeError):  # degenerate polygon: its first vertex
        res2: str | None = at(float(pts[0]["x"]), float(pts[0]["y"]))
        return res2


__all__ = ["R_FLOOR", "apply_confirmed_floors", "floor_resolver"]
