"""Storage / status-store interfaces + in-memory fakes (unit tests, local runs)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


class BlobStorage(Protocol):
    def read_bytes(self, path: str) -> bytes: ...

    def write_bytes(self, path: str, data: bytes, content_type: str) -> None: ...


class StatusStore(Protocol):
    def update_job(self, job_id: str, fields: dict[str, Any]) -> None: ...

    def update_version(self, org_id: str, project_id: str, sheet_id: str, version_id: str, fields: dict[str, Any]) -> None: ...


class NotFound(KeyError):
    pass


@dataclass
class InMemoryStorage:
    blobs: dict[str, bytes] = field(default_factory=dict)
    content_types: dict[str, str] = field(default_factory=dict)

    def read_bytes(self, path: str) -> bytes:
        if path not in self.blobs:
            raise NotFound(path)
        return self.blobs[path]

    def write_bytes(self, path: str, data: bytes, content_type: str) -> None:
        self.blobs[path] = data
        self.content_types[path] = content_type


@dataclass
class InMemoryStore:
    jobs: dict[str, dict[str, Any]] = field(default_factory=dict)
    versions: dict[str, dict[str, Any]] = field(default_factory=dict)
    history: list[tuple[str, str, dict[str, Any]]] = field(default_factory=list)

    def update_job(self, job_id: str, fields: dict[str, Any]) -> None:
        self.jobs.setdefault(job_id, {}).update(fields)
        self.history.append(("job", job_id, dict(fields)))

    def update_version(self, org_id: str, project_id: str, sheet_id: str, version_id: str, fields: dict[str, Any]) -> None:
        key = f"orgs/{org_id}/projects/{project_id}/sheets/{sheet_id}/versions/{version_id}"
        self.versions.setdefault(key, {}).update(fields)
        self.history.append(("version", key, dict(fields)))
