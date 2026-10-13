"""Cloud Storage + Firestore adapters (production, Cloud Run).

Credentials: Application Default Credentials only (the Cloud Run runtime service
account ``kamutan-worker@``); never a key file from the repo or env (SEC-24).
The client libraries live in the optional ``gcp`` extra and are imported lazily, so
the rest of the package (and the test-suite) does not need them. Google APIs are not
reachable from the dev sandbox: these adapters are unit-tested with fake clients that
mimic the small API surface used here (``tests/test_stores.py``).
"""

from __future__ import annotations

import os
from typing import Any

from .base import SERVER_TIMESTAMP, BlobNotFound, Increment, check_path

DEFAULT_BUCKET = "kamutan-fba67.firebasestorage.app"


def _is_not_found(e: Exception) -> bool:
    return type(e).__name__ == "NotFound" or getattr(e, "code", None) == 404


def _is_precondition_failed(e: Exception) -> bool:
    return type(e).__name__ == "PreconditionFailed" or getattr(e, "code", None) == 412


class GcsBlobStore:
    def __init__(self, bucket: Any = None, *, bucket_name: str | None = None) -> None:
        if bucket is None:  # pragma: no cover - needs google-cloud-storage + ADC
            from google.cloud import storage  # type: ignore[attr-defined, unused-ignore]

            bucket = storage.Client().bucket(bucket_name or os.environ.get("KAMUTAN_BUCKET", DEFAULT_BUCKET))
        self._bucket = bucket

    def read(self, path: str) -> bytes:
        try:
            data: bytes = self._bucket.blob(check_path(path)).download_as_bytes()
            return data
        except Exception as e:
            if _is_not_found(e):
                raise BlobNotFound(path) from None
            raise

    def write(self, path: str, data: bytes, content_type: str, *, cache_control: str | None = None) -> None:
        blob = self._bucket.blob(check_path(path))
        if cache_control:
            blob.cache_control = cache_control
        blob.upload_from_string(data, content_type=content_type)

    def read_versioned(self, path: str) -> tuple[bytes | None, str | None]:
        blob = self._bucket.get_blob(check_path(path))
        if blob is None:
            return None, None
        gen = blob.generation
        try:
            data: bytes = blob.download_as_bytes(if_generation_match=gen)
        except Exception as e:
            if _is_precondition_failed(e) or _is_not_found(e):
                return self.read_versioned(path)
            raise
        return data, str(gen)

    def write_if(self, path: str, data: bytes, content_type: str, *, expected: str | None) -> bool:
        blob = self._bucket.blob(check_path(path))
        try:
            blob.upload_from_string(data, content_type=content_type, if_generation_match=int(expected) if expected else 0)
        except Exception as e:
            if _is_precondition_failed(e):
                return False
            raise
        return True

    def list(self, prefix: str) -> list[str]:
        return sorted(b.name for b in self._bucket.list_blobs(prefix=prefix))

    def delete(self, path: str) -> None:
        try:
            self._bucket.blob(check_path(path)).delete()
        except Exception as e:
            if not _is_not_found(e):
                raise


class FirestoreDocStore:
    def __init__(self, client: Any = None, *, server_timestamp: Any = None, increment: Any = None) -> None:
        if client is None:  # pragma: no cover - needs google-cloud-firestore + ADC
            from google.cloud import firestore

            client = firestore.Client()
            server_timestamp = firestore.SERVER_TIMESTAMP
            increment = firestore.Increment
        self._db = client
        self._ts = server_timestamp
        self._inc = increment

    def _convert(self, v: Any) -> Any:
        if v is SERVER_TIMESTAMP:
            return self._ts
        if isinstance(v, Increment):
            return self._inc(v.value)
        if isinstance(v, dict):
            return {k: self._convert(x) for k, x in v.items()}
        if isinstance(v, list):
            return [self._convert(x) for x in v]
        return v

    def get(self, path: str) -> dict[str, Any] | None:
        snap = self._db.document(check_path(path)).get()
        if not snap.exists:
            return None
        d: dict[str, Any] = snap.to_dict() or {}
        return d

    def set(self, path: str, data: dict[str, Any], *, merge: bool = True) -> None:
        self._db.document(check_path(path)).set(self._convert(data), merge=merge)
