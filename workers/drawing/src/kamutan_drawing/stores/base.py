"""Blob (Cloud Storage) and document (Firestore) store interfaces.

The pipeline only talks to these two protocols. Implementations:

* :mod:`.memory` — in-memory, for unit tests;
* :mod:`.local` — local filesystem (``kamutan-ingest`` CLI, local web mock mode);
* :mod:`.gcp` — Cloud Storage + Firestore (Cloud Run, ADC credentials only).

Document writes use Firestore ``set(..., merge=True)`` semantics: nested maps are
merged key by key, lists and scalars are replaced. Two sentinels are supported in
values: :data:`SERVER_TIMESTAMP` and :class:`Increment`.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Any, Protocol


class BlobNotFound(KeyError):
    """The object does not exist."""


class _ServerTimestamp:
    def __repr__(self) -> str:
        return "SERVER_TIMESTAMP"


SERVER_TIMESTAMP: Any = _ServerTimestamp()


@dataclass(frozen=True)
class Increment:
    value: int = 1


class BlobStore(Protocol):
    def read(self, path: str) -> bytes:
        """Raise :class:`BlobNotFound` if missing."""
        ...

    def write(self, path: str, data: bytes, content_type: str, *, cache_control: str | None = None) -> None: ...

    def read_versioned(self, path: str) -> tuple[bytes | None, str | None]:
        """(data, version token) or (None, None) when missing."""
        ...

    def write_if(self, path: str, data: bytes, content_type: str, *, expected: str | None) -> bool:
        """Write only if the current version token equals ``expected`` (None = must not exist).

        Returns False on a lost race (the caller re-reads, merges and retries).
        """
        ...

    def list(self, prefix: str) -> list[str]: ...

    def delete(self, path: str) -> None: ...


class DocStore(Protocol):
    def get(self, path: str) -> dict[str, Any] | None: ...

    def set(self, path: str, data: dict[str, Any], *, merge: bool = True) -> None: ...


def check_path(path: str) -> str:
    """Reject traversal / absolute / control-character object paths."""
    if not path or path.startswith("/") or "\\" in path or "\x00" in path:
        raise ValueError("invalid object path")
    parts = path.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise ValueError("invalid object path")
    return path


def now_iso() -> str:
    return dt.datetime.now(dt.UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def resolve_sentinels(new: dict[str, Any], old: dict[str, Any] | None) -> dict[str, Any]:
    """Apply SERVER_TIMESTAMP / Increment locally (memory and local stores)."""
    out: dict[str, Any] = {}
    for k, v in new.items():
        prev = (old or {}).get(k)
        if v is SERVER_TIMESTAMP:
            out[k] = now_iso()
        elif isinstance(v, Increment):
            out[k] = (prev if isinstance(prev, int | float) else 0) + v.value
        elif isinstance(v, dict):
            out[k] = resolve_sentinels(v, prev if isinstance(prev, dict) else None)
        else:
            out[k] = v
    return out


def deep_merge(old: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    out = dict(old)
    for k, v in new.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out
