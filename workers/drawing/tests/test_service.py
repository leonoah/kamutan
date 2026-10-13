import base64
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from kamutan_drawing.service.app import create_app
from kamutan_drawing.service.contracts import IngestSheetVersionJob

from .pipeline_util import FAST, ORG, PROJ, SET, job_payload, multipage_pdf, seed

CONTRACTS = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "json-schema"


def _push(payload) -> dict:
    raw = json.dumps(payload).encode() if not isinstance(payload, bytes) else payload
    return {"message": {"data": base64.b64encode(raw).decode(), "messageId": "1"}, "subscription": "projects/p/subscriptions/s"}


def test_contract_accepts_valid_and_rejects_invalid():
    data = b"%PDF-1.7"
    job = IngestSheetVersionJob.model_validate(job_payload(data))
    assert not job.is_reprocess and job.sheet_id(3) == f"{SET}-p3"
    re = IngestSheetVersionJob.model_validate(job_payload(data, sheetId="custom", pageIndex=2))
    assert re.is_reprocess and re.sheet_id(2) == "custom"
    for bad in (
        {"schemaVersion": 2},
        {"extra": 1},
        {"orgId": "bad/id"},
        {"storagePath": f"orgs/other/projects/{PROJ}/uploads/{SET}/source.pdf"},  # foreign org
        {"storagePath": f"orgs/{ORG}/projects/{PROJ}/uploads/other-set/source.pdf"},  # foreign set
        {"storagePath": f"orgs/{ORG}/projects/{PROJ}/uploads/{SET}/source.dxf"},  # kind mismatch
        {"storagePath": f"orgs/{ORG}/projects/{PROJ}/uploads/{SET}/../x/source.pdf"},
        {"storagePath": f"orgs/{ORG}/projects/{PROJ}/sources/{'0' * 64}.pdf"},  # Sprint-0 layout
        {"traceparent": "nope"},
        {"fileKind": "jpg"},
        {"sheetId": "s-p0"},  # sheetId without pageIndex
        {"pageIndex": 0},
        {"pageIndex": -1, "sheetId": "s"},
    ):
        with pytest.raises(ValidationError):
            IngestSheetVersionJob.model_validate(job_payload(data, **bad))


def test_contract_mirrors_packages_contracts_json_schema():
    p = CONTRACTS / "IngestSheetVersionJob.json"
    if not p.exists():
        pytest.skip("packages/contracts json-schema not generated")
    ref = json.loads(p.read_text())["definitions"]["IngestSheetVersionJob"]
    ours = IngestSheetVersionJob.model_json_schema()
    assert set(ref["required"]) == set(ours["required"])
    assert set(ref["properties"]) == set(ours["properties"])
    assert ref["properties"]["schemaVersion"]["const"] == ours["properties"]["schemaVersion"]["const"]
    for k in ("jobId", "orgId", "projectId", "sheetSetId", "versionId", "sha256", "storagePath"):
        assert ref["properties"][k]["pattern"].replace("\\/", "/") == ours["properties"][k]["pattern"], k
    for k in ("sheetId", "pageIndex", "traceparent"):
        r = next(a for a in ref["properties"][k]["anyOf"] if a.get("type") != "null")
        o = next(a for a in ours["properties"][k]["anyOf"] if a.get("type") != "null")
        assert {kk: v for kk, v in r.items() if kk != "type"} == {kk: v for kk, v in o.items() if kk not in ("type",)}, k
    assert set(ref["properties"]["fileKind"]["enum"]) == set(ours["properties"]["fileKind"]["enum"])
    # and the jsonschema itself accepts what pydantic accepts
    import jsonschema

    jsonschema.validate(job_payload(b"%PDF"), json.loads(p.read_text()))


def test_push_endpoint():
    data = multipage_pdf(1)
    payload = job_payload(data)
    _, blobs, docs = seed(data, payload)
    client = TestClient(create_app(blobs, docs, FAST))
    health = client.get("/healthz").json()
    assert health["ok"] is True and set(health["sandbox"]) == {"landlockAbi", "netns", "dropRoot", "dwg2dxf"}
    r = client.post("/pubsub/ingest", json=_push(payload))
    assert r.status_code == 204
    assert docs.get("jobs/job1")["status"] == "succeeded"
    assert client.post("/pubsub/ingest", json=_push(payload)).status_code == 204  # redelivery
    # permanently bad messages are acked (2xx) so Pub/Sub does not redeliver forever
    r = client.post("/pubsub/ingest", json={"message": {"data": "!!notbase64"}})
    assert r.status_code == 200 and r.json()["reason"] == "bad_envelope"
    r = client.post("/pubsub/ingest", json=_push(b"\xff\xfe"))
    assert r.status_code == 200 and r.json()["reason"] == "bad_envelope"
    r = client.post("/pubsub/ingest", json=_push({**payload, "orgId": "x y"}))
    assert r.status_code == 200 and r.json()["reason"] == "invalid_payload"
    r = client.post("/pubsub/ingest", json=_push({**payload, "jobId": "unknown-job"}))
    assert r.status_code == 200 and r.json()["reason"] == "invalid_payload"
    other = job_payload(b"other bytes", jobId="job2", sheetSetId="set2")
    seed(None, other, docs=docs, blobs=blobs)
    r = client.post("/pubsub/ingest", json=_push(other))
    assert r.status_code == 200 and r.json()["reason"] == "source_not_found"
    assert docs.get("jobs/job2")["status"] == "failed"


def test_push_endpoint_transient_error_returns_500(monkeypatch):
    data = multipage_pdf(1)
    payload = job_payload(data)
    _, blobs, docs = seed(data, payload)

    def boom(*a, **k):
        raise RuntimeError("disk full")

    monkeypatch.setattr("kamutan_drawing.service.pipeline.run_task", boom)
    client = TestClient(create_app(blobs, docs, FAST))
    r = client.post("/pubsub/ingest", json=_push(payload))
    assert r.status_code == 500
    jd = docs.get("jobs/job1")
    assert jd["error"]["code"] == "internal" and jd["status"] == "queued" and "disk full" not in jd["error"]["message"]
