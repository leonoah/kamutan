"""In-memory stores (unit tests)."""

from __future__ import annotations

import copy
import threading
from dataclasses import dataclass, field
from typing import Any

from .base import BlobNotFound, check_path, deep_merge, resolve_sentinels


@dataclass
class InMemoryBlobStore:
    blobs: dict[str, bytes] = field(default_factory=dict)
    content_types: dict[str, str] = field(default_factory=dict)
    generations: dict[str, int] = field(default_factory=dict)
    writes: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _gen: int = 0

    def read(self, path: str) -> bytes:
        try:
            return self.blobs[check_path(path)]
        except KeyError:
            raise BlobNotFound(path) from None

    def write(self, path: str, data: bytes, content_type: str, *, cache_control: str | None = None) -> None:
        with self._lock:
            self._put(check_path(path), data, content_type)

    def _put(self, path: str, data: bytes, content_type: str) -> None:
        self._gen += 1
        self.blobs[path] = bytes(data)
        self.content_types[path] = content_type
        self.generations[path] = self._gen
        self.writes += 1

    def read_versioned(self, path: str) -> tuple[bytes | None, str | None]:
        with self._lock:
            if path not in self.blobs:
                return None, None
            return self.blobs[path], str(self.generations[path])

    def write_if(self, path: str, data: bytes, content_type: str, *, expected: str | None) -> bool:
        with self._lock:
            cur = str(self.generations[path]) if path in self.blobs else None
            if cur != expected:
                return False
            self._put(check_path(path), data, content_type)
            return True

    def list(self, prefix: str) -> list[str]:
        return sorted(k for k in self.blobs if k.startswith(prefix))

    def delete(self, path: str) -> None:
        with self._lock:
            self.blobs.pop(path, None)
            self.content_types.pop(path, None)
            self.generations.pop(path, None)


@dataclass
class InMemoryDocStore:
    docs: dict[str, dict[str, Any]] = field(default_factory=dict)
    history: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def get(self, path: str) -> dict[str, Any] | None:
        with self._lock:
            d = self.docs.get(check_path(path))
            return copy.deepcopy(d) if d is not None else None

    def set(self, path: str, data: dict[str, Any], *, merge: bool = True) -> None:
        with self._lock:
            check_path(path)
            old = self.docs.get(path)
            new = resolve_sentinels(data, old)
            self.docs[path] = deep_merge(old, new) if (merge and old is not None) else new
            self.history.append((path, copy.deepcopy(new)))

    def list_docs(self, collection: str, limit: int = 2000) -> list[tuple[str, dict[str, Any]]]:
        """(doc id, doc) of the direct children of ``collection`` (Sprint 2: legend entries, symbol mappings)."""
        pre = check_path(collection) + "/"
        with self._lock:
            out = [
                (k[len(pre) :], copy.deepcopy(v)) for k, v in self.docs.items() if k.startswith(pre) and "/" not in k[len(pre) :]
            ]
        return sorted(out)[:limit]
