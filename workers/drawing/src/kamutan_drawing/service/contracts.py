"""Python mirror of packages/contracts `IngestSheetVersionJob` (schemaVersion 2).

Source of truth: packages/contracts/src/jobs.ts (+ json-schema/IngestSheetVersionJob.json).
Kept hand-written for Sprint 0; a CI diff against the generated JSON schema is a TODO
(see NOTES.md).
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

DOC_ID = r"^[A-Za-z0-9_-]+$"
SOURCE_PATH_RE = re.compile(
    r"^orgs/([A-Za-z0-9_-]{1,128})/projects/([A-Za-z0-9_-]{1,128})/sources/([a-f0-9]{64})\.(pdf|dwg|dxf|png)$"
)

DocId = Field(min_length=1, max_length=128, pattern=DOC_ID)


class IngestSheetVersionJob(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schemaVersion: Literal[2]
    type: Literal["ingest.sheet_version"]
    jobId: str = DocId
    orgId: str = DocId
    projectId: str = DocId
    sheetSetId: str = DocId
    sheetId: str = DocId
    versionId: str = DocId
    storagePath: str = Field(pattern=SOURCE_PATH_RE.pattern)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    fileKind: Literal["pdf", "dwg", "dxf", "png"]
    traceparent: str | None = Field(pattern=r"^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$")

    @model_validator(mode="after")
    def _path_belongs_to_job(self) -> IngestSheetVersionJob:
        prefix = f"orgs/{self.orgId}/projects/{self.projectId}/sources/{self.sha256}."
        if not self.storagePath.startswith(prefix):
            raise ValueError("storagePath must belong to the job org/project/sha256")
        return self

    @property
    def derived_prefix(self) -> str:
        """Every artifact of this job is written under this prefix (org-scoped, SEC-24)."""
        return f"orgs/{self.orgId}/projects/{self.projectId}/derived/{self.versionId}/"
