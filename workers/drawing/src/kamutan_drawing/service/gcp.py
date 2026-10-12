"""Google Cloud adapters (Cloud Storage + Firestore) - Sprint 0 stubs.

Credentials come only from ADC / GOOGLE_APPLICATION_CREDENTIALS (never from files
in the repo). Google APIs are blocked in the dev sandbox, so these adapters are
not exercised by the test-suite; the client libraries are optional dependencies
(`google-cloud-storage`, `google-cloud-firestore`) installed in the Cloud Run image.
"""

from __future__ import annotations

import os
from typing import Any

DEFAULT_BUCKET = os.environ.get("KAMUTAN_BUCKET", "kamutan-fba67.firebasestorage.app")


class GcsStorage:  # pragma: no cover - needs Google APIs
    def __init__(self, bucket: str = DEFAULT_BUCKET):
        from google.cloud import storage  # type: ignore[import-not-found]

        self._bucket = storage.Client().bucket(bucket)

    def read_bytes(self, path: str) -> bytes:
        return self._bucket.blob(path).download_as_bytes()

    def write_bytes(self, path: str, data: bytes, content_type: str) -> None:
        self._bucket.blob(path).upload_from_string(data, content_type=content_type)


class FirestoreStore:  # pragma: no cover - needs Google APIs
    def __init__(self) -> None:
        from google.cloud import firestore  # type: ignore[import-not-found]

        self._db = firestore.Client()
        self._ts = firestore.SERVER_TIMESTAMP

    def update_job(self, job_id: str, fields: dict[str, Any]) -> None:
        self._db.document(f"jobs/{job_id}").set({**fields, "updatedAt": self._ts}, merge=True)

    def update_version(self, org_id: str, project_id: str, sheet_id: str, version_id: str, fields: dict[str, Any]) -> None:
        path = f"orgs/{org_id}/projects/{project_id}/sheets/{sheet_id}/versions/{version_id}"
        self._db.document(path).set({**fields, "updatedAt": self._ts}, merge=True)
