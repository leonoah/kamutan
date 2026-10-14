"""Python mirrors ↔ packages/contracts json-schema (Sprint 3). Each test skips while its schema is not generated."""

from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Any

import jsonschema
import pytest

from kamutan_drawing.boq import rules as R
from kamutan_drawing.boq.build import evidence_bytes
from kamutan_drawing.boq.contracts import BoqBuildJob, LibraryImportJob, LinkGroup

from .test_boq import P, build, det, group, lib_rows, seed_project
from .test_library_import import IMP, _job, synth_xlsx

CONTRACTS = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "json-schema"


def schema(name: str) -> dict[str, Any]:
    p = CONTRACTS / f"{name}.json"
    if not p.exists():
        pytest.skip(f"packages/contracts json-schema/{name}.json not generated")
    s: dict[str, Any] = json.loads(p.read_text())
    return s


def definition(name: str) -> dict[str, Any]:
    d: dict[str, Any] = schema(name)["definitions"][name]
    return d


def project(doc: dict[str, Any], name: str, **extra: Any) -> dict[str, Any]:
    """What the API's zod parse sees: the schema's properties only (Firestore docs carry bookkeeping fields)."""
    props = definition(name)["properties"]
    return {k: v for k, v in {**doc, **extra}.items() if k in props}


def _strip(p: str) -> str:
    return p.replace("\\/", "/")


def test_boq_build_job_mirror():
    ref = definition("BoqBuildJob")
    ours = BoqBuildJob.model_json_schema()
    assert set(ref["required"]) == set(ours["required"])
    assert set(ref["properties"]) == set(ours["properties"])
    for k in ("jobId", "orgId", "projectId", "buildId"):
        assert ref["properties"][k]["pattern"] == ours["properties"][k]["pattern"], k
    payload = {
        "schemaVersion": 1,
        "type": "boq.build",
        "jobId": "j",
        "orgId": "o",
        "projectId": "p",
        "buildId": "b",
        "traceparent": None,
    }
    jsonschema.validate(payload, schema("BoqBuildJob"))
    BoqBuildJob.model_validate(payload)


def test_library_import_job_mirror():
    ref = definition("LibraryImportJob")
    ours = LibraryImportJob.model_json_schema()
    assert set(ref["required"]) == set(ours["required"])
    assert set(ref["properties"]) == set(ours["properties"])
    assert _strip(ref["properties"]["storagePath"]["pattern"]) == ours["properties"]["storagePath"]["pattern"]
    assert ref["properties"]["importId"]["format"] == ours["properties"]["importId"]["format"] == "uuid"
    assert set(ref["properties"]["sourceKind"]["enum"]) == set(ours["properties"]["sourceKind"]["enum"])
    job, _, _ = _job(synth_xlsx())
    jsonschema.validate(job.model_dump(mode="json"), schema("LibraryImportJob"))


def test_ingest_topic_union_accepts_our_payloads():
    s = schema("IngestTopicJob")
    jsonschema.validate(
        {
            "schemaVersion": 1,
            "type": "boq.build",
            "jobId": "j",
            "orgId": "o",
            "projectId": "p",
            "buildId": "b",
            "traceparent": None,
        },
        s,
    )
    job, _, _ = _job(synth_xlsx())
    jsonschema.validate(job.model_dump(mode="json"), s)


def test_link_group_mirror():
    ref = definition("LinkGroup")
    ours = LinkGroup.model_json_schema()
    assert set(ref["required"]) == set(ours["required"]) and set(ref["properties"]) == set(ours["properties"])
    assert set(ref["properties"]["kind"]["enum"]) == set(ours["properties"]["kind"]["enum"])
    g = group("lk_1", "two_way", ["d_1", "d_2"], ["d_3"], level="yellow", reasons=["קישור מפסק לא ודאי"])
    jsonschema.validate({"schema": "kamutan.links/1", "groups": [g.model_dump()]}, schema("LinksArtifact"))


def test_default_rules_mirror_contracts_defaults():
    p = CONTRACTS / "defaults" / "boq-defaults.json"
    if not p.exists():
        pytest.skip("contracts boq-defaults.json not generated")
    ref = {r["id"]: r for r in json.loads(p.read_text())["rules"]}
    ours = {r["id"]: {**r, **R.DEFAULT_DOC_FIELDS} for r in R.DEFAULT_RULES}
    assert set(ours) == set(ref)
    for rid, r in ref.items():
        assert ours[rid] == r, rid
    s = schema("BoqRule")
    for r in R.DEFAULT_RULES:
        jsonschema.validate({**r, **R.DEFAULT_DOC_FIELDS, "updatedAt": None}, s)


def test_written_docs_validate():
    links = [group("lk_1", "single", ["d_1"], ["d_2"]).model_dump()]
    blobs, docs = seed_project([det(i, "socket_single", i * 20, 0) for i in range(3)] + [det(9, "socket_prep")],
                               [det(1, "switch_single"), det(2, "luminaire_ceiling", 5, 5)], links)  # fmt: skip
    docs.set(f"{P}/boqBuilds/b1", {"jobId": "j-b1", "requestedBy": "u1", "createdAt": "2026-10-14T10:00:00.000Z"})
    build(blobs, docs, "b1")
    line_s = schema("BoqLine")
    lines = docs.list_docs(f"{P}/boqLines")
    assert lines
    for lid, d in lines:
        jsonschema.validate(project(d, "BoqLine", id=lid), line_s)
    ev = json.loads(gzip.decompress(blobs.read(f"{P}/boq/b1/evidence.json.gz")))
    jsonschema.validate(ev, schema("BoqEvidenceArtifact"))
    b = docs.get(f"{P}/boqBuilds/b1")
    jsonschema.validate(project(b, "BoqBuild", id="b1"), schema("BoqBuild"))
    jsonschema.validate(project(docs.get(P)["boq"], "ProjectBoqSummary"), schema("ProjectBoqSummary"))
    for rid, r in docs.list_docs("orgs/o1/boqRules"):
        jsonschema.validate({**r, "id": rid}, schema("BoqRule"))
    assert evidence_bytes([], "b").startswith(b"\x1f\x8b")


def test_import_docs_validate():
    from kamutan_drawing.library_import.importer import run_library_import

    from .test_library_import import LIMITS

    job, blobs, docs = _job(synth_xlsx())
    run_library_import(job, blobs, docs, limits=LIMITS)
    item_s = schema("ItemLibraryItem")
    for iid, d in docs.list_docs("orgs/o1/itemLibrary"):
        jsonschema.validate(project(d, "ItemLibraryItem", id=iid), item_s)
    tpl = docs.get("orgs/o1/boqTemplates/tpl_default")
    jsonschema.validate({**tpl, "id": "tpl_default"}, schema("BoqTemplate"))
    assert docs.get(f"orgs/o1/libraryImports/{IMP}")["status"] == "succeeded"
    assert lib_rows()  # shared fixture import


# ----------------------------------------------------------------------------- Sprint 4
def test_sprint4_docs_validate():
    from .test_boq_s4 import BATH, seed_s4

    blobs, docs = seed_s4()
    docs.set(f"{P}/boqBuilds/b1", {"jobId": "j-b1", "requestedBy": "u1", "createdAt": "2026-10-14T10:00:00.000Z"})
    out = build(blobs, docs, "b1")
    line_s = schema("BoqLine")
    seen = set()
    for lid, d in docs.list_docs(f"{P}/boqLines"):
        jsonschema.validate(project(d, "BoqLine", id=lid), line_s)
        seen |= {k for k in ("orderQty", "wasteFactor", "manualCount") if k in d}
    assert seen == {"orderQty", "wasteFactor", "manualCount"}
    for k in seen:  # the fields are in the contract, not stripped by `project`
        assert k in definition("BoqLine")["properties"], k
    ev = json.loads(gzip.decompress(blobs.read(out.evidence_ref)))
    jsonschema.validate(ev, schema("BoqEvidenceArtifact"))
    assert any("quantity" in e and "roomId" in e for items in ev["lines"].values() for e in items)
    b = docs.get(f"{P}/boqBuilds/b1")
    jsonschema.validate(project(b, "BoqBuild", id="b1"), schema("BoqBuild"))
    for u in b["unmatchedCorrections"]:
        jsonschema.validate(u, schema("UnmatchedCorrection"))
    for cid, c in docs.list_docs(f"{P}/corrections"):
        jsonschema.validate({**c, "id": cid}, schema("Correction"))
    for _, rs in docs.list_docs(f"{P}/roomSettings"):
        jsonschema.validate(rs, schema("RoomSettings"))
    jsonschema.validate({"schema": "kamutan.rooms/1", "rooms": [BATH]}, schema("RoomsArtifact"))


def test_room_defaults_mirror_contracts():
    """tiling.default_settings == contracts defaultRoomSettings (values copied from corrections.ts)."""
    from kamutan_drawing.boq.tiling import DEFAULT_WASTE_FACTOR, default_settings

    src = (
        (CONTRACTS.parent / "src" / "corrections.ts").read_text()
        if (CONTRACTS.parent / "src" / "corrections.ts").exists()
        else ""
    )
    if "defaultRoomSettings" not in src:
        pytest.skip("contracts defaultRoomSettings not present")
    assert f"DEFAULT_WASTE_FACTOR = {DEFAULT_WASTE_FACTOR}" in src
    assert "DEFAULT_CLADDING_HEIGHT_M = 2.6" in src and "facts.hasShowerOrBath ?? type !== 'wc'" in src
    assert default_settings("bathroom", True)["includeInWaterproofing"] is True  # fixtures unknown: bathroom yes …
    assert default_settings("wc", True)["includeInWaterproofing"] is False  # … wc no
    assert default_settings("wc", True, has_shower_or_bath=True)["includeInWaterproofing"] is True
    assert default_settings("bathroom", True, ceiling_m=2.2)["claddingHeightM"] == 2.2
    assert default_settings("bathroom", True, niche=True) == {**default_settings("kitchen", False), "floorTiled": True}
    assert default_settings("kitchen", False)["claddingHeightM"] == 0.0
