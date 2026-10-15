"""Python mirror of packages/contracts `IngestSheetVersionJob` (schemaVersion 3).

Source of truth: packages/contracts/src/jobs.ts (+ json-schema/IngestSheetVersionJob.json);
``tests/test_service.py::test_contract_mirrors_packages_contracts_json_schema`` diffs this model
against the generated JSON schema.

Two modes (docs/agents/SPRINT1_BRIEF.md):

* **initial** (``sheetId is None and pageIndex is None``): every page i of the upload becomes
  ``sheets/{sheetSetId}-p{i}`` with version ``versionId``;
* **reprocess** (both set): page ``pageIndex`` is re-run into ``sheets/{sheetId}/versions/{versionId}``.

``storagePath`` must be exactly the verified upload of the job's org/project/sheetSet/fileKind
(SEC-24: the worker never reads or writes outside the job's org).
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

SCHEMA_VERSION = 3
DOC_ID = r"^[A-Za-z0-9_-]+$"
_ID = r"[A-Za-z0-9_-]{1,128}"
UPLOAD_PATH_PATTERN = rf"^orgs/({_ID})/projects/({_ID})/uploads/({_ID})/source\.(pdf|dwg|dxf|png)$"
TRACEPARENT = r"^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$"

DocId = Field(min_length=1, max_length=128, pattern=DOC_ID)
FileKind = Literal["pdf", "dwg", "dxf", "png"]


def sheet_id_for(sheet_set_id: str, page_index: int) -> str:
    """Page i of an upload -> ``sheets/{sheetSetId}-p{i}`` (i is 0-based = ``pageIndex``)."""
    return f"{sheet_set_id}-p{page_index}"


class IngestSheetVersionJob(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schemaVersion: Literal[3]
    type: Literal["ingest.sheet_version"]
    jobId: str = DocId
    orgId: str = DocId
    projectId: str = DocId
    sheetSetId: str = DocId
    sheetId: Annotated[str, Field(min_length=1, max_length=128, pattern=DOC_ID)] | None
    pageIndex: Annotated[int, Field(ge=0, le=10_000)] | None
    versionId: str = DocId
    storagePath: str = Field(pattern=UPLOAD_PATH_PATTERN)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    fileKind: FileKind
    traceparent: Annotated[str, Field(pattern=TRACEPARENT)] | None

    @model_validator(mode="after")
    def _check(self) -> IngestSheetVersionJob:
        expected = f"orgs/{self.orgId}/projects/{self.projectId}/uploads/{self.sheetSetId}/source.{self.fileKind}"
        if self.storagePath != expected:
            raise ValueError("storagePath must be the upload of the job org/project/sheetSet/fileKind")
        if (self.sheetId is None) != (self.pageIndex is None):
            raise ValueError("sheetId and pageIndex must both be set (reprocess) or both be null (initial)")
        return self

    @property
    def is_reprocess(self) -> bool:
        return self.pageIndex is not None

    @property
    def project_path(self) -> str:
        return f"orgs/{self.orgId}/projects/{self.projectId}"

    def sheet_id(self, page_index: int) -> str:
        if self.sheetId is not None and page_index == self.pageIndex:
            return self.sheetId
        return sheet_id_for(self.sheetSetId, page_index)
