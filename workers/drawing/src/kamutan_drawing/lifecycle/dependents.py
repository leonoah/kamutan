"""Upload-order dependency (Sprint 5): re-understand MEP sheets when a wall source of their floor becomes ready.

Electrical / lighting / plumbing sheets borrow the walls of the construction / architecture / master plans of the
same floor (``rooms.reference``: thin partitions, door / window closures, and the region-floor inference of stacked
plans). The service hands a sheet the wall sources that are *current when it is processed*, so a construction plan
uploaded after the electrical plan of its floor does not reach it until the electrical sheet is reprocessed.

This module decides — purely — which sheet versions to re-run, and records the decision as an idempotent, debounced
request; the requests are turned into reprocess jobs by whoever owns version creation (the API, see NOTES.md).

* **who depends on whom** (:func:`borrows_from`): a sheet borrows from wall sources of a strictly better rank
  (construction 0 < architecture 1 < master 2 < every other discipline); construction plans borrow from nobody.
  The rank strictly increases along every edge, so an automatic reprocess can never trigger itself (no loops): a
  reprocessed electrical sheet is not a wall source, a reprocessed master sheet only triggers MEP sheets.
* **which dependents** (:func:`dependents_to_reprocess`): the other sheets of the project that borrow from the
  source, whose floors overlap the source's (unknown floors count as overlapping; an unconfirmed sheet is always
  included because its region floors are inferred from the wall sources of *every* floor), and whose current
  version did not already use this source version (``referenceSources`` on the version doc; unknown = not used).
  Sheets with no current version, failed versions and the source itself are skipped.
* **debounce** (:func:`merge_request`): one request per dependent sheet, ``reprocessRequests/{sheetId}``. A new
  source pushes ``notBefore`` to now + :data:`DEBOUNCE_S`, but never past ``firstRequestedAt`` +
  :data:`MAX_WAIT_S`; re-delivering the same source version changes nothing (idempotent).
* **firing** (:func:`due_requests`): a pending request whose ``notBefore`` has passed fires — unless the dependent's
  current version changed meanwhile and already used every requested source (``drop``), or the dependent is being
  processed right now (``wait``). The reprocess job carries ``reprocessReason`` (:func:`reprocess_reason`).

The service hook is :func:`schedule_dependents` (reads the project's sheets / versions, writes the requests).
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

WALL_SOURCE_RANK = {"construction": 0, "architecture": 1, "architecture_master": 2, "master": 2}
NON_SOURCE_RANK = 9
# sheets that never take walls from others (no rooms / walls are read from them)
NO_BORROW = frozenset({"construction", "legend", "schedule", "details", "title", "cover"})
DEBOUNCE_S = 120.0
MAX_WAIT_S = 900.0
MAX_SOURCES = 32
REQUESTS = "reprocessRequests"
REASON_KIND = "reference_walls"
REASON_MESSAGE = "תוכנית קירות של אותה קומה עודכנה — הגיליון עובד מחדש"

Decision = Literal["fire", "wait", "drop"]


@dataclass(frozen=True)
class SheetState:
    """What the decision needs from ``sheets/{sid}`` + its current ``versions/{vid}``."""

    sheet_id: str
    discipline: str | None
    floors: tuple[str, ...] = ()
    confirmed: bool = False
    version_id: str | None = None
    version_status: str | None = None  # queued | processing | ready | failed
    reference_sources: frozenset[str] | None = None  # "sheetId/versionId" the version borrowed walls from (None = unknown)

    @property
    def source_key(self) -> str | None:
        return f"{self.sheet_id}/{self.version_id}" if self.version_id else None


def rank(discipline: str | None) -> int:
    return WALL_SOURCE_RANK.get(str(discipline), NON_SOURCE_RANK)


def is_wall_source(discipline: str | None) -> bool:
    return str(discipline) in WALL_SOURCE_RANK


def borrows_from(dependent: str | None, source: str | None) -> bool:
    """True when a sheet of discipline ``dependent`` takes walls from a ``source`` sheet (``service`` order)."""
    if not is_wall_source(source) or str(dependent) in NO_BORROW:
        return False
    return rank(source) < rank(dependent)


def _floors_overlap(a: Sequence[str], b: Sequence[str]) -> bool:
    return not a or not b or bool(set(a) & set(b))


def dependents_to_reprocess(source: SheetState, sheets: Iterable[SheetState]) -> list[SheetState]:
    """The sheets whose current version must be re-understood now that ``source`` (ready) exists. Sorted by id."""
    if source.version_status != "ready" or not source.version_id or not is_wall_source(source.discipline):
        return []
    key = source.source_key
    out: list[SheetState] = []
    for s in sheets:
        if s.sheet_id == source.sheet_id or not s.version_id or s.version_status == "failed":
            continue
        if not borrows_from(s.discipline, source.discipline):
            continue
        if s.confirmed and not _floors_overlap(s.floors, source.floors):
            continue  # floors authoritative and different: the source's walls are never used
        if s.reference_sources is not None and key in s.reference_sources:
            continue  # already processed with this source version
        out.append(s)
    return sorted(out, key=lambda s: s.sheet_id)


def merge_request(
    existing: Mapping[str, Any] | None, dependent: SheetState, source: SheetState, now: float
) -> dict[str, Any] | None:
    """The request doc after adding ``source`` for ``dependent`` (``None`` = unchanged: idempotent re-delivery).

    Doc ``reprocessRequests/{dependent.sheet_id}``: ``{sheetId, status: pending, dependentVersionId, sources:
    ["sheetId/versionId"…], reason, firstRequestedAt, notBefore, updatedAt}`` (times in epoch seconds)."""
    key = source.source_key
    if key is None:
        return None
    pending = dict(existing) if existing and existing.get("status") == "pending" else None
    if pending is not None:
        sources = [str(x) for x in pending.get("sources") or []]
        if key in sources and pending.get("dependentVersionId") == dependent.version_id:
            return None
        first = _num(pending.get("firstRequestedAt"), now)
        sources = [x for x in sources if x != key and not x.startswith(f"{source.sheet_id}/")] + [key]
    else:
        first, sources = now, [key]
    return {
        "sheetId": dependent.sheet_id,
        "status": "pending",
        "dependentVersionId": dependent.version_id,
        "sources": sources[-MAX_SOURCES:],
        "reason": REASON_KIND,
        "firstRequestedAt": first,
        "notBefore": min(now + DEBOUNCE_S, first + MAX_WAIT_S),
        "updatedAt": now,
    }


def due_requests(requests: Mapping[str, Mapping[str, Any]], sheets: Mapping[str, SheetState], now: float) -> dict[str, Decision]:
    """``{sheetId: fire | wait | drop}`` for the pending requests (not-yet-due ones are left out)."""
    out: dict[str, Decision] = {}
    for sid, req in sorted(requests.items()):
        if req.get("status") != "pending" or _num(req.get("notBefore"), math.inf) > now:
            continue
        s = sheets.get(sid)
        if s is None or not s.version_id:
            out[sid] = "drop"  # the sheet was deleted
        elif s.version_status in ("queued", "processing"):
            out[sid] = "wait"  # it is being processed; decide again when it is ready
        elif (
            s.version_id != req.get("dependentVersionId")
            and s.reference_sources is not None
            and set(req.get("sources") or []) <= set(s.reference_sources)
        ):
            out[sid] = "drop"  # reprocessed meanwhile (by a user) with every requested source
        else:
            out[sid] = "fire"
    return out


def reprocess_reason(req: Mapping[str, Any]) -> dict[str, Any]:
    """``reprocessReason`` of the version created for a fired request (contract request, see NOTES.md)."""
    return {"kind": REASON_KIND, "sources": [str(x) for x in req.get("sources") or []][:MAX_SOURCES], "message": REASON_MESSAGE}


def _num(v: Any, default: float) -> float:
    return float(v) if isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v) else default


# ------------------------------------------------------------------------------------------------ service hook
def sheet_state(sheet_id: str, sheet: Mapping[str, Any], version: Mapping[str, Any] | None) -> SheetState:
    refs = version.get("referenceSources") if version else None
    return SheetState(
        sheet_id=sheet_id,
        discipline=str(sheet["discipline"]) if isinstance(sheet.get("discipline"), str) else None,
        floors=tuple(str(f) for f in sheet.get("floors") or [] if isinstance(f, str)),
        confirmed=bool(sheet.get("confirmed")),
        version_id=str(sheet["currentVersionId"]) if isinstance(sheet.get("currentVersionId"), str) else None,
        version_status=str(version.get("status")) if version and isinstance(version.get("status"), str) else None,
        reference_sources=frozenset(str(x) for x in refs) if isinstance(refs, list) else None,
    )


def project_states(docs: Any, project_path: str) -> dict[str, SheetState]:
    """Every sheet of the project with its current version (``DocStore.get`` / ``list_docs``)."""
    lister = getattr(docs, "list_docs", None)
    if lister is None:
        return {}
    out: dict[str, SheetState] = {}
    for sid, sheet in lister(f"{project_path}/sheets"):
        if not isinstance(sheet, dict):
            continue
        vid = sheet.get("currentVersionId")
        version = docs.get(f"{project_path}/sheets/{sid}/versions/{vid}") if isinstance(vid, str) and vid else None
        out[str(sid)] = sheet_state(str(sid), sheet, version)
    return out


def schedule_dependents(docs: Any, project_path: str, sheet_id: str, *, now: float) -> list[str]:
    """Service hook, called when ``sheets/{sheet_id}``'s current version became ready: record (or extend) one
    debounced request per dependent sheet. Returns the dependent sheet ids whose request was written."""
    states = project_states(docs, project_path)
    src = states.get(sheet_id)
    if src is None:
        return []
    written: list[str] = []
    for dep in dependents_to_reprocess(src, states.values()):
        path = f"{project_path}/{REQUESTS}/{dep.sheet_id}"
        doc = merge_request(docs.get(path), dep, src, now)
        if doc is not None:
            docs.set(path, doc, merge=False)
            written.append(dep.sheet_id)
    return written


__all__ = [
    "DEBOUNCE_S",
    "MAX_WAIT_S",
    "REQUESTS",
    "SheetState",
    "borrows_from",
    "dependents_to_reprocess",
    "due_requests",
    "merge_request",
    "project_states",
    "reprocess_reason",
    "schedule_dependents",
    "sheet_state",
]
