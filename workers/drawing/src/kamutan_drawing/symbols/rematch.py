"""Re-match human corrections to the detections of a newer sheet version (pure, no I/O).

Corrections (``orgs/{o}/projects/{p}/corrections/{corrId}``, written only by the API, brief Sprint 4) are
applied *after* automatic detection — in ``boq.build`` (Worker-BOQ) and by the API's review queue. When a
sheet is reprocessed the detection ids change, so a correction is found again by its **anchor**:

* ``anchorMm {x, y}`` (paper mm, the position of the corrected item at the time of the edit) within
  ``radiusMm`` (default :data:`DEFAULT_RADIUS_MM` = 3 mm paper) of a new detection's centre;
* the **class family** (:func:`class_family`: sockets, switches, luminaires, plumbing fixtures, faucets …)
  of the item the correction was made on must equal the new detection's family. The reference class is
  ``fromClass`` when the correction carries it, else ``class`` — except for ``reclassify`` (``class`` is the
  *target* class there) and ``add`` (matched against the added class: a detector that now finds the added
  item makes the manual add redundant). No reference class → any family;
* ties are broken by equal ``signature`` (stroke signature, when both have one), then distance, then id.

Assignment is one-to-one per *edited item*: corrections that name the same old ``detectionId`` (e.g. a
reclassify and a later move) travel together; distinct items never share a new detection (greedy by
distance over all item/detection pairs → deterministic).

:func:`rematch` returns one :class:`Rematched` per correction (input order) with ``status``:

* ``matched`` — ``detectionId`` is the new detection the correction applies to;
* ``unmatched`` — no compatible detection within the radius → the queue shows "תיקון לא הותאם" (red);
* ``already_detected`` — an ``add`` whose item the detector now finds itself (``detectionId``): do not
  add it a second time (the add's class still applies to that detection);
* ``added`` — an ``add`` with nothing detected there: the manual item stands;
* ``manual`` — ``measure`` / ``count``: manual quantities, not bound to detections;
* ``other_target`` — ``link`` / ``unlink`` and remove / accept / reject of a link group or room (no
  ``detectionId``): not a detection; their switch / point ids re-match with :func:`rematch_ids`;
* ``reverted`` — ``revertedAt`` set (undone): ignore;
* ``other_sheet`` — the correction belongs to another sheet than ``sheet_id``.

The same version (``versionId`` equal to the detections' version) re-matches exactly by ``detectionId``
first when that id still exists (``same_version_ids=True``).
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

DEFAULT_RADIUS_MM = 3.0
MAX_RADIUS_MM = 50.0
DETECTION_KINDS = frozenset({"remove", "reclassify", "move", "accept", "reject"})
GROUP_KINDS = frozenset({"link", "unlink"})
MANUAL_KINDS = frozenset({"measure", "count"})

# class → family; prefixes first, then explicit members. Unknown classes are their own family.
_FAMILY_PREFIX: tuple[tuple[str, str], ...] = (
    ("socket_", "socket"),
    ("switch_", "switch"),
    ("luminaire_", "luminaire"),
    ("fixture_wc", "wc"),
    ("fixture_", "fixture"),
    ("faucet_", "faucet"),
)
_FAMILY_EXPLICIT: dict[str, str] = {
    "ceiling_fan": "luminaire",
    "data_point": "comms",
    "tv_point": "comms",
    "phone_point": "comms",
    "bezek_point": "comms",
    "heater_feed": "feed",
    "water_heater_feed": "feed",
    "garden_tap": "faucet",
    "ac_unit": "hvac",
    "speaker": "comms",
    "intercom": "comms",
    "doorbell": "comms",
    "panel": "panel",
    "note_point": "marker",
    "waterproof_marker": "marker",
}


def class_family(cls: str | None) -> str | None:
    """Family of a detection class (``socket_double`` → ``socket``); None for no class."""
    if not cls:
        return None
    if cls in _FAMILY_EXPLICIT:
        return _FAMILY_EXPLICIT[cls]
    for prefix, fam in _FAMILY_PREFIX:
        if cls.startswith(prefix):
            return fam
    return cls


@dataclass(frozen=True)
class Rematched:
    correction_id: str
    status: str  # matched | unmatched | already_detected | added | manual | reverted | other_sheet
    detection_id: str | None = None
    distance_mm: float | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "correctionId": self.correction_id,
            "status": self.status,
            "detectionId": self.detection_id,
            "distanceMm": None if self.distance_mm is None else round(self.distance_mm, 2),
        }


def _xy(p: Any) -> tuple[float, float] | None:
    if not isinstance(p, Mapping):
        return None
    try:
        x, y = float(p["x"]), float(p["y"])
    except (KeyError, TypeError, ValueError):
        return None
    return (x, y) if math.isfinite(x) and math.isfinite(y) else None


def _center(d: Mapping[str, Any]) -> tuple[float, float] | None:
    c = _xy(d.get("centerMm"))
    if c is not None:
        return c
    b = d.get("bboxMm")
    if isinstance(b, Mapping):
        try:
            return (float(b["x"]) + float(b["w"]) / 2, float(b["y"]) + float(b["h"]) / 2)
        except (KeyError, TypeError, ValueError):
            return None
    return None


def _anchor(c: Mapping[str, Any]) -> tuple[float, float] | None:
    a = _xy(c.get("anchorMm"))
    if a is not None:
        return a
    g = c.get("geometry")
    if isinstance(g, Mapping) and g.get("type") == "point" and isinstance(g.get("mm"), list) and g["mm"]:
        return _xy(g["mm"][0])
    return None


def _radius(c: Mapping[str, Any], default: float) -> float:
    try:
        r = float(c.get("radiusMm") or default)
    except (TypeError, ValueError):
        r = default
    return min(max(r, 0.1), MAX_RADIUS_MM) if math.isfinite(r) else default


def reference_class(c: Mapping[str, Any]) -> str | None:
    """Class of the item the correction was made on (what the new detection must resemble)."""
    if c.get("fromClass"):
        return str(c["fromClass"])
    if c.get("kind") == "reclassify":
        return None
    return str(c["class"]) if c.get("class") else None


def rematch(
    corrections: Iterable[Mapping[str, Any]],
    new_detections: Sequence[Mapping[str, Any]],
    *,
    sheet_id: str | None = None,
    version_id: str | None = None,
    default_radius_mm: float = DEFAULT_RADIUS_MM,
    same_version_ids: bool = True,
) -> list[Rematched]:
    """Map corrections onto ``new_detections`` (``detections.json.gz`` items of one sheet version).

    ``corrections``: correction docs (brief Sprint-4 shape; the doc id as ``id``). ``sheet_id``: only
    corrections of this sheet are matched (others → ``other_sheet``). ``version_id``: the detections'
    version — a correction made on that same version keeps its ``detectionId`` when it still exists."""
    corrs = list(corrections)
    dets = [(str(d.get("id")), d, _center(d)) for d in new_detections if d.get("id") is not None]
    by_id = {i: (d, c) for i, d, c in dets}
    out: dict[int, Rematched] = {}
    # items to place: key → (indices of corrections, anchor, radius, family, signature, is_add)
    items: dict[str, dict[str, Any]] = {}
    for k, c in enumerate(corrs):
        cid = str(c.get("id") or c.get("correctionId") or f"#{k}")
        kind = str(c.get("kind") or "")
        if c.get("revertedAt"):
            out[k] = Rematched(cid, "reverted")
            continue
        if sheet_id is not None and c.get("sheetId") not in (None, sheet_id):
            out[k] = Rematched(cid, "other_sheet")
            continue
        if kind in MANUAL_KINDS:
            out[k] = Rematched(cid, "manual")
            continue
        old = c.get("detectionId")
        if kind in GROUP_KINDS or (kind in DETECTION_KINDS and old is None):
            out[k] = Rematched(cid, "other_target")
            continue
        if kind != "add" and kind not in DETECTION_KINDS:
            out[k] = Rematched(cid, "manual")
            continue
        if (
            same_version_ids
            and version_id is not None
            and c.get("versionId") == version_id
            and old is not None
            and str(old) in by_id
            and kind != "add"
        ):
            d, cen = by_id[str(old)]
            a = _anchor(c)
            dist = math.dist(a, cen) if (a is not None and cen is not None) else 0.0
            out[k] = Rematched(cid, "matched", str(old), dist)
            continue
        anchor = _anchor(c)
        if anchor is None:
            out[k] = Rematched(cid, "added" if kind == "add" else "unmatched")
            continue
        key = f"det:{old}" if (old is not None and kind != "add") else f"corr:{k}"
        it = items.setdefault(
            key,
            {
                "corr": [],
                "anchor": anchor,
                "radius": _radius(c, default_radius_mm),
                "family": None,
                "signature": None,
                "add": kind == "add",
            },
        )
        it["corr"].append(k)
        ref = reference_class(c) if kind != "add" else (str(c["class"]) if c.get("class") else None)
        if it["family"] is None and ref:
            it["family"] = class_family(ref)
        if it["signature"] is None and c.get("signature"):
            it["signature"] = str(c["signature"])
    # fixed same-version matches reserve their detections
    taken = {r.detection_id for r in out.values() if r.status == "matched" and r.detection_id}
    pairs: list[tuple[int, float, str, str]] = []
    for key, it in items.items():
        ax, ay = it["anchor"]
        for did, d, cen in dets:
            if cen is None or did in taken:
                continue
            dist = math.hypot(cen[0] - ax, cen[1] - ay)
            if dist > it["radius"]:
                continue
            if it["family"] is not None and class_family(str(d.get("class") or "")) != it["family"]:
                continue
            sig_bad = 0 if (it["signature"] and d.get("signature") == it["signature"]) else 1
            pairs.append((sig_bad, dist, key, did))
    pairs.sort(key=lambda p: (p[0], p[1], p[2], p[3]))
    placed: dict[str, tuple[str, float]] = {}
    used: set[str] = set()
    for _, dist, key, did in pairs:
        if key in placed or did in used:
            continue
        placed[key] = (did, dist)
        used.add(did)
    for key, it in items.items():
        hit = placed.get(key)
        for k in it["corr"]:
            c = corrs[k]
            cid = str(c.get("id") or c.get("correctionId") or f"#{k}")
            if it["add"]:
                out[k] = Rematched(cid, "already_detected", hit[0], hit[1]) if hit else Rematched(cid, "added")
            else:
                out[k] = Rematched(cid, "matched", hit[0], hit[1]) if hit else Rematched(cid, "unmatched")
    return [out[k] for k in range(len(corrs))]


def rematch_ids(
    ids: Iterable[str],
    old_detections: Sequence[Mapping[str, Any]],
    new_detections: Sequence[Mapping[str, Any]],
    *,
    radius_mm: float = DEFAULT_RADIUS_MM,
) -> dict[str, str | None]:
    """Old detection id → new detection id (or None) for the ids a ``link`` correction names
    (``switchIds`` / ``pointIds``): the old item's centre is the anchor, its class the family."""
    old = {str(d.get("id")): d for d in old_detections if d.get("id") is not None}
    want = [str(i) for i in ids]
    corrs = []
    for i in want:
        d = old.get(i)
        c = _center(d) if d is not None else None
        corrs.append(
            {
                "id": i,
                "kind": "accept",
                "detectionId": i,
                "anchorMm": {"x": c[0], "y": c[1]} if c else None,
                "radiusMm": radius_mm,
                "fromClass": (d or {}).get("class"),
                "signature": (d or {}).get("signature"),
            }
        )
    res = rematch(corrs, new_detections, same_version_ids=False)
    return {i: (r.detection_id if r.status == "matched" else None) for i, r in zip(want, res, strict=True)}


__all__ = ["DEFAULT_RADIUS_MM", "Rematched", "class_family", "reference_class", "rematch", "rematch_ids"]
