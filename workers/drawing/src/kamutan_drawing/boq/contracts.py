"""Python mirrors of packages/contracts (Sprint 3): job payloads, links / evidence artifacts, BOQ line fields.

Source of truth: ``packages/contracts/src/{jobs,boq}.ts`` (+ ``json-schema/``). ``tests/test_boq_contracts.py``
diffs these models against the generated JSON schemas (skipped while a schema is not generated yet).
"""

from __future__ import annotations

import logging
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

DOC_ID = r"^[A-Za-z0-9_-]+$"
TRACEPARENT = r"^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$"
_ID = r"[A-Za-z0-9_-]{1,128}"
_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_UUID_ANY = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
IMPORT_PATH_PATTERN = rf"^orgs/({_ID})/imports/({_UUID})\.(xls|xlsx)$"
ITEM_CODE = r"^[0-9A-Za-z.\-/]+$"
log = logging.getLogger(__name__)

DocId = Field(min_length=1, max_length=128, pattern=DOC_ID)
OptDocId = Annotated[str, Field(min_length=1, max_length=128, pattern=DOC_ID)] | None
Traceparent = Annotated[str, Field(pattern=TRACEPARENT)] | None

BOQ_BUILD_TYPE = "boq.build"
LIBRARY_IMPORT_TYPE = "library.import"
EVIDENCE_SCHEMA = "kamutan.boq-evidence/1"
LINKS_SCHEMA = "kamutan.links/1"
LINK_GROUP_KINDS = ("single", "two_way", "shared", "sensor", "add_to_existing")
Level = Literal["green", "yellow", "red"]


class BoqBuildJob(BaseModel):
    """Topic ``ingest``, type ``boq.build``: aggregate all current ready sheet versions of a project."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schemaVersion: Literal[1]
    type: Literal["boq.build"]
    jobId: str = DocId
    orgId: str = DocId
    projectId: str = DocId
    buildId: str = DocId
    traceparent: Traceparent

    @property
    def project_path(self) -> str:
        return f"orgs/{self.orgId}/projects/{self.projectId}"


class LibraryImportJob(BaseModel):
    """Topic ``ingest``, type ``library.import``: parse a past BOQ (.xls/.xlsx) into the org's item library."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schemaVersion: Literal[1]
    type: Literal["library.import"]
    jobId: str = DocId
    orgId: str = DocId
    projectId: OptDocId
    importId: str = Field(pattern=rf"^{_UUID_ANY}$", json_schema_extra={"format": "uuid"})
    storagePath: str = Field(pattern=IMPORT_PATH_PATTERN)
    sourceKind: Literal["xls", "xlsx"]
    traceparent: Traceparent

    @model_validator(mode="after")
    def _check(self) -> LibraryImportJob:
        if self.storagePath != f"orgs/{self.orgId}/imports/{self.importId}.{self.sourceKind}":
            raise ValueError("storagePath must be the import object of the job org/importId/sourceKind")
        return self


class LinkGroup(BaseModel):
    """``kamutan.links/1`` group (contracts ``LinkGroupSchema``)."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(max_length=128, pattern=r"^lk_[A-Za-z0-9_-]+$")
    floor: Annotated[str, Field(min_length=1, max_length=32)] | None = None
    fan: bool = False
    inferredSwitches: int = Field(default=0, ge=0)
    arcIds: list[Annotated[str, Field(max_length=128)]] = Field(default_factory=list, max_length=256)
    switchIds: list[Annotated[str, Field(min_length=1, max_length=128)]] = Field(max_length=16)
    pointIds: list[Annotated[str, Field(min_length=1, max_length=128)]] = Field(max_length=64)
    luminaireIds: list[Annotated[str, Field(min_length=1, max_length=128)]] = Field(max_length=256)
    kind: Literal["single", "two_way", "shared", "sensor", "add_to_existing"]
    confidence: float = Field(ge=0, le=1)
    level: Level
    reasons: list[Annotated[str, Field(min_length=1, max_length=200)]] = Field(max_length=32)


class LinksArtifact(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_: Literal["kamutan.links/1"] = Field(alias="schema")
    groups: list[LinkGroup] = Field(max_length=5000)


class EvidenceItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sheetId: str = DocId
    versionId: str = DocId
    detectionId: str = Field(min_length=1, max_length=128)
    linkGroupId: Annotated[str, Field(max_length=128, pattern=r"^lk_[A-Za-z0-9_-]+$")] | None
    floor: Annotated[str, Field(min_length=1, max_length=32)] | None


def parse_links(obj: Any) -> list[LinkGroup]:
    """Validated groups of a ``links.json.gz`` object. Fields outside contracts ``LinkGroupSchema`` (debug /
    bookkeeping such as ``floor`` or ``arcIds``) are ignored; invalid groups are dropped and logged (the artifact
    is worker-made but crosses a module boundary — never fail a build on one bad group)."""
    if not isinstance(obj, dict) or obj.get("schema") != LINKS_SCHEMA:
        return []
    keys = set(LinkGroup.model_fields)
    out: list[LinkGroup] = []
    for g in obj.get("groups") or []:
        if not isinstance(g, dict):
            continue
        try:
            out.append(LinkGroup.model_validate({k: v for k, v in g.items() if k in keys}))
        except (ValueError, TypeError):  # pydantic ValidationError is a ValueError
            log.warning("links: dropping an invalid group")
    return out
