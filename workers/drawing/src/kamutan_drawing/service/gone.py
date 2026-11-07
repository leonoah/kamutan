"""Sprint 8 (contracts NOTES "Requests to Worker-BOQ" #5): jobs of a deleted sheet set / project are dropped quietly.

The API deletes in two phases (``apps/api/src/db/housekeeping-repository.ts``): first a tombstone — ``deletedAt`` on
the sheet set, ``deletingAt`` on the project — then the objects and docs. A job that arrives (or is still running)
for such a set / project must not re-create anything: the worker checks at job start and again before each batch of
writes (sheet docs, artifact uploads, final status, BOQ evidence / snapshot / lines) and raises :class:`JobDropped`.
The push handler acks it (204: no Pub/Sub retry), nothing else is written (no error doc, no artifact, no BOQ), and one
INFO line with counts only is logged (no ids, no names).
"""

from __future__ import annotations

import logging
import time
from typing import Any

from ..stores.base import DocStore

log = logging.getLogger(__name__)

RECHECK_S = 5.0  # progress writes re-check at most this often


class JobDropped(Exception):
    """The job's sheet set / project is gone (doc missing or tombstoned). Not an error: ack, write nothing."""

    def __init__(self, what: str, *, written: int = 0) -> None:
        super().__init__(f"{what} deleted")
        self.what = what  # project | sheet_set
        self.written = written  # pages / lines already written before the delete was noticed


def tombstoned(doc: Any, field: str) -> bool:
    """Doc missing, or the API's delete tombstone set (``deletedAt`` / ``deletingAt`` not null)."""
    return not isinstance(doc, dict) or doc.get(field) is not None


def gone(docs: DocStore, project_path: str, sheet_set_path: str | None = None) -> str | None:
    """``"project"`` / ``"sheet_set"`` when that doc is missing or being deleted, else None."""
    if tombstoned(docs.get(project_path), "deletingAt"):
        return "project"
    if sheet_set_path is not None and tombstoned(docs.get(sheet_set_path), "deletedAt"):
        return "sheet_set"
    return None


def ensure_alive(docs: DocStore, project_path: str, sheet_set_path: str | None = None, *, written: int = 0) -> None:
    what = gone(docs, project_path, sheet_set_path)
    if what is not None:
        raise JobDropped(what, written=written)


def log_dropped(job_type: str, e: JobDropped) -> None:
    """The one log line of a dropped job: counts only (no ids, no names, no content)."""
    log.info("job dropped: %s deleted (type=%s, written before=%d)", e.what, job_type, e.written)


class AliveCache:
    """Re-check at most every :data:`RECHECK_S` (progress writes happen many times per page)."""

    def __init__(self, docs: DocStore, project_path: str, sheet_set_path: str | None) -> None:
        self.docs, self.project_path, self.sheet_set_path = docs, project_path, sheet_set_path
        self.t = time.monotonic()
        self.dead = False

    def alive(self) -> bool:
        if self.dead:
            return False
        if time.monotonic() - self.t >= RECHECK_S:
            self.t = time.monotonic()
            self.dead = gone(self.docs, self.project_path, self.sheet_set_path) is not None
        return not self.dead
