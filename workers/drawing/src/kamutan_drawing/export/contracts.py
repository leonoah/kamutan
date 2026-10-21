"""Python mirror of the Sprint-5 contracts for the marked-PDF export (FR-29, E2E-13).

Source of truth: ``packages/contracts/src/{jobs,exports}.ts`` (API agent, Sprint 5); ``tests/test_export.py``
diffs the job model against ``json-schema/MarkedPdfJob.json`` (skipped while it is not generated):

* job (topic ``ingest``, contracts ``MarkedPdfJobSchema`` / ``json-schema/MarkedPdfJob.json``)
  ``{schemaVersion: 1, type: "export.marked_pdf", jobId, orgId, projectId, exportId, sheetIds: string[] | null,
  versionIds: {sheetId: versionId} | null, options: {legend: true, floorSplit, watermark: string | null,
  hideTitleBlock}, storagePath, traceparent}``;
* export doc ``orgs/{o}/projects/{p}/exports/{exportId}`` (contracts ``ExportRecordSchema``) ``{kind: 'xlsx' |
  'marked_pdf', status: queued | running | ready | failed, storagePath, pageCount, sizeBytes, createdBy,
  createdAt, finishedAt, error, …}`` — the worker writes ``status`` (running → ready | failed; the brief's
  "succeeded" is the contracts' ``ready``), ``storagePath``, ``pageCount``, ``sizeBytes``, ``versionIds``,
  ``error``, ``startedAt`` / ``finishedAt``;
* output object ``orgs/{o}/projects/{p}/exports/{exportId}/marked.pdf``.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

DOC_ID = r"^[A-Za-z0-9_-]+$"
TRACEPARENT = r"^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$"
MARKED_PDF_TYPE = "export.marked_pdf"
MAX_SHEETS = 200
WATERMARK_MAX = 200
_ID = r"[A-Za-z0-9_-]{1,128}"
MARKED_PDF_PATH = rf"^orgs/({_ID})/projects/({_ID})/exports/({_ID})/marked\.pdf$"

DocId = Field(min_length=1, max_length=128, pattern=DOC_ID)
SheetId = Annotated[str, Field(min_length=1, max_length=128, pattern=DOC_ID)]
Traceparent = Annotated[str, Field(pattern=TRACEPARENT)] | None


class MarkedPdfOptions(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    legend: Literal[True] = True
    floorSplit: bool = False
    # free text typed by the user (or built by the API for share links); rendered, never interpreted
    watermark: Annotated[str, Field(min_length=1, max_length=WATERMARK_MAX)] | None = None
    hideTitleBlock: bool = False


class MarkedPdfJob(BaseModel):
    """Topic ``ingest``, type ``export.marked_pdf`` (mirror of contracts ``MarkedPdfJobSchema``)."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schemaVersion: Literal[1]
    type: Literal["export.marked_pdf"]
    jobId: str = DocId
    orgId: str = DocId
    projectId: str = DocId
    exportId: str = DocId
    sheetIds: Annotated[list[SheetId], Field(min_length=1, max_length=MAX_SHEETS)] | None
    # sheetId → versionId to render (share links: the versions locked at link creation); null = current versions
    versionIds: dict[SheetId, SheetId] | None
    options: MarkedPdfOptions
    storagePath: str = Field(pattern=MARKED_PDF_PATH)
    traceparent: Traceparent

    @model_validator(mode="after")
    def _check(self) -> MarkedPdfJob:
        if self.storagePath != output_path(self.orgId, self.projectId, self.exportId):
            raise ValueError("storagePath must be the marked PDF of the job org/project/export")
        if self.versionIds is not None and len(self.versionIds) > MAX_SHEETS:
            raise ValueError("too many pinned versions")
        return self

    @property
    def project_path(self) -> str:
        return f"orgs/{self.orgId}/projects/{self.projectId}"


def export_doc_path(job: MarkedPdfJob) -> str:
    return f"{job.project_path}/exports/{job.exportId}"


def output_path(org_id: str, project_id: str, export_id: str) -> str:
    return f"orgs/{org_id}/projects/{project_id}/exports/{export_id}/marked.pdf"


__all__ = ["MARKED_PDF_TYPE", "MarkedPdfJob", "MarkedPdfOptions", "export_doc_path", "output_path"]
