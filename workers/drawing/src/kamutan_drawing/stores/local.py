"""Local filesystem stores (``kamutan-ingest`` CLI and the web's local mock mode).

Layout under ``root`` (default ``/home/claude/kamutan-data/artifacts``):

* blobs: ``{root}/{object path}`` — the same paths as in the Storage bucket;
* docs: ``{root}/_firestore/{document path}.json`` — one JSON file per document.

Writes are atomic (temp file + rename); conditional writes and doc merges hold an
``fcntl`` lock so several local processes can share one root.
"""

from __future__ import annotations

import fcntl
import json
import os
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from .base import BlobNotFound, check_path, deep_merge, resolve_sentinels

DOCS_DIR = "_firestore"


def _atomic_write(p: Path, data: bytes) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=p.parent, prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, p)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


@contextmanager
def _locked(root: Path) -> Iterator[None]:
    root.mkdir(parents=True, exist_ok=True)
    with open(root / ".lock", "a+b") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


class LocalBlobStore:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)

    def _p(self, path: str) -> Path:
        p = self.root / check_path(path)
        if DOCS_DIR in Path(path).parts[:1]:
            raise ValueError("invalid object path")
        return p

    def read(self, path: str) -> bytes:
        try:
            return self._p(path).read_bytes()
        except FileNotFoundError:
            raise BlobNotFound(path) from None

    def write(self, path: str, data: bytes, content_type: str, *, cache_control: str | None = None) -> None:
        _atomic_write(self._p(path), data)

    @staticmethod
    def _token(p: Path) -> str | None:
        try:
            st = p.stat()
        except FileNotFoundError:
            return None
        return f"{st.st_mtime_ns}-{st.st_size}-{st.st_ino}"

    def read_versioned(self, path: str) -> tuple[bytes | None, str | None]:
        p = self._p(path)
        with _locked(self.root):
            tok = self._token(p)
            return (p.read_bytes(), tok) if tok is not None else (None, None)

    def write_if(self, path: str, data: bytes, content_type: str, *, expected: str | None) -> bool:
        p = self._p(path)
        with _locked(self.root):
            if self._token(p) != expected:
                return False
            _atomic_write(p, data)
            return True

    def list(self, prefix: str) -> list[str]:
        base = self.root / prefix.rsplit("/", 1)[0] if "/" in prefix else self.root
        if not base.exists():
            return []
        out = []
        for p in base.rglob("*"):
            if p.is_file() and not p.name.startswith(".tmp-"):
                rel = p.relative_to(self.root).as_posix()
                if rel.startswith(prefix) and not rel.startswith(DOCS_DIR + "/"):
                    out.append(rel)
        return sorted(out)

    def delete(self, path: str) -> None:
        self._p(path).unlink(missing_ok=True)


class LocalDocStore:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)

    def _p(self, path: str) -> Path:
        return self.root / DOCS_DIR / (check_path(path) + ".json")

    def get(self, path: str) -> dict[str, Any] | None:
        try:
            d: dict[str, Any] = json.loads(self._p(path).read_text())
            return d
        except FileNotFoundError:
            return None

    def set(self, path: str, data: dict[str, Any], *, merge: bool = True) -> None:
        p = self._p(path)
        with _locked(self.root):
            old = self.get(path)
            new = resolve_sentinels(data, old)
            doc = deep_merge(old, new) if (merge and old is not None) else new
            _atomic_write(p, json.dumps(doc, ensure_ascii=False, indent=1, sort_keys=True).encode())

    def list_docs(self, collection: str, limit: int = 2000) -> list[tuple[str, dict[str, Any]]]:
        """(doc id, doc) of the direct children of ``collection``."""
        d = self.root / DOCS_DIR / check_path(collection)
        if not d.is_dir():
            return []
        out = []
        for f in sorted(d.glob("*.json"))[:limit]:
            try:
                out.append((f.stem, json.loads(f.read_text())))
            except (OSError, ValueError):
                continue
        return out
