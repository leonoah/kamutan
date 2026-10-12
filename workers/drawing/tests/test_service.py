import base64
import hashlib
import json

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from kamutan_drawing.service.app import create_app
from kamutan_drawing.service.contracts import IngestSheetVersionJob
from kamutan_drawing.service.pipeline import JobError, process_sheet_version
from kamutan_drawing.service.ports import InMemoryStorage, InMemoryStore

from .synth import draw_word, make_pdf, stroke_line

ORG, PROJ = "org_1", "proj-1"


def _pdf() -> bytes:
    def draw(c, ps):
        stroke_line(c, (10, 10), (410, 10), ps)
        draw_word(c, ps, ["box", "he", "vav"], 50, 50, 3.0)

    return make_pdf(draw)


def _job(data: bytes, **over) -> dict:
    sha = hashlib.sha256(data).hexdigest()
    j = {
        "schemaVersion": 2,
        "type": "ingest.sheet_version",
        "jobId": "job1",
        "orgId": ORG,
        "projectId": PROJ,
        "sheetSetId": "set1",
        "sheetId": "sheet1",
        "versionId": "v1",
        "storagePath": f"orgs/{ORG}/projects/{PROJ}/sources/{sha}.pdf",
        "sha256": sha,
        "fileKind": "pdf",
        "traceparent": None,
    }
    j.update(over)
    return j


def _push(payload) -> dict:
    raw = json.dumps(payload).encode() if not isinstance(payload, bytes) else payload
    return {"message": {"data": base64.b64encode(raw).decode(), "messageId": "1"}, "subscription": "projects/p/subscriptions/s"}


def test_contract_accepts_valid_and_rejects_invalid():
    data = _pdf()
    job = IngestSheetVersionJob.model_validate(_job(data))
    assert job.derived_prefix == f"orgs/{ORG}/projects/{PROJ}/derived/v1/"
    for bad in (
        {"schemaVersion": 1},
        {"extra": 1},
        {"orgId": "bad/id"},
        {"storagePath": f"orgs/other/projects/{PROJ}/sources/{'0' * 64}.pdf"},  # foreign org
        {"traceparent": "nope"},
        {"fileKind": "jpg"},
    ):
        with pytest.raises(ValidationError):
            IngestSheetVersionJob.model_validate(_job(data, **bad))


def test_pipeline_writes_artifacts_under_org_prefix():
    data = _pdf()
    job = IngestSheetVersionJob.model_validate(_job(data))
    st, store = InMemoryStorage(), InMemoryStore()
    st.write_bytes(job.storagePath, data, "application/pdf")
    res = process_sheet_version(job, st, store, ocr=False)
    pre = job.derived_prefix
    assert pre + "primitives.npz" in st.blobs
    assert pre + "tiles/manifest.json" in st.blobs
    man = json.loads(st.blobs[pre + "tiles/manifest.json"])
    assert sum(1 for k in st.blobs if k.startswith(pre + "tiles/") and k.endswith(".png")) == man["cols"] * man["rows"]
    assert all(k == job.storagePath or k.startswith(pre) for k in st.blobs)
    assert store.jobs["job1"]["status"] == "succeeded" and store.jobs["job1"]["progress"] == 100
    vdoc = store.versions[f"orgs/{ORG}/projects/{PROJ}/sheets/sheet1/versions/v1"]
    assert vdoc["status"] == "ingested" and vdoc["stats"]["paper"] == "A3"
    assert res["stats"]["primitiveCount"] > 0
    stages = [h[2].get("stage") for h in store.history if h[0] == "job"]
    assert stages[:3] == ["fetch", "ingest", "render"]


def test_pipeline_text_stage_runs_with_tesseract():
    import shutil

    if not shutil.which("tesseract"):
        pytest.skip("tesseract not installed")
    data = _pdf()
    job = IngestSheetVersionJob.model_validate(_job(data))
    st, store = InMemoryStorage(), InMemoryStore()
    st.write_bytes(job.storagePath, data, "application/pdf")
    process_sheet_version(job, st, store, ocr=True)
    spans = json.loads(st.blobs[job.derived_prefix + "text_spans.json"])
    assert len(spans) == 1 and spans[0]["n_glyphs"] == 3


def test_pipeline_errors():
    data = _pdf()
    st, store = InMemoryStorage(), InMemoryStore()
    job = IngestSheetVersionJob.model_validate(_job(data))
    with pytest.raises(JobError) as e:
        process_sheet_version(job, st, store, ocr=False)
    assert e.value.code == "source_not_found" and store.jobs["job1"]["status"] == "failed"
    st.write_bytes(job.storagePath, b"not the same bytes", "application/pdf")
    with pytest.raises(JobError) as e:
        process_sheet_version(job, st, store, ocr=False)
    assert e.value.code == "sha256_mismatch"
    bad = b"%PDF-1.4 garbage"
    jb = IngestSheetVersionJob.model_validate(_job(bad))
    st.write_bytes(jb.storagePath, bad, "application/pdf")
    with pytest.raises(JobError) as e:
        process_sheet_version(jb, st, store, ocr=False)
    assert e.value.code == "pdf_unreadable"
    jd = IngestSheetVersionJob.model_validate(_job(data, fileKind="dxf", storagePath=job.storagePath.replace(".pdf", ".dxf")))
    st.write_bytes(jd.storagePath, data, "application/dxf")
    with pytest.raises(JobError) as e:
        process_sheet_version(jd, st, store, ocr=False)
    assert e.value.code == "unsupported_kind"


def test_push_endpoint():
    data = _pdf()
    st, store = InMemoryStorage(), InMemoryStore()
    job = _job(data)
    st.write_bytes(job["storagePath"], data, "application/pdf")
    client = TestClient(create_app(st, store, ocr=False))
    assert client.get("/healthz").json() == {"ok": True}
    r = client.post("/pubsub/ingest", json=_push(job))
    assert r.status_code == 204
    assert store.jobs["job1"]["status"] == "succeeded"
    # permanently bad messages are acked (2xx) so Pub/Sub does not redeliver forever
    r = client.post("/pubsub/ingest", json={"message": {"data": "!!notbase64"}})
    assert r.status_code == 200 and r.json()["reason"] == "bad_envelope"
    r = client.post("/pubsub/ingest", json=_push({**job, "orgId": "x y"}))
    assert r.status_code == 200 and r.json()["reason"] == "invalid_payload"
    r = client.post(
        "/pubsub/ingest",
        json=_push(
            {
                **job,
                "jobId": "job2",
                "versionId": "v2",
                "sha256": "a" * 64,
                "storagePath": f"orgs/{ORG}/projects/{PROJ}/sources/{'a' * 64}.pdf",
            }
        ),
    )
    assert r.status_code == 200 and r.json()["reason"] == "source_not_found"


def test_push_endpoint_transient_error_returns_500(monkeypatch):
    data = _pdf()
    st, store = InMemoryStorage(), InMemoryStore()
    job = _job(data)
    st.write_bytes(job["storagePath"], data, "application/pdf")

    def boom(*a, **k):
        raise RuntimeError("disk full")

    monkeypatch.setattr("kamutan_drawing.service.pipeline.render_page", boom)
    client = TestClient(create_app(st, store, ocr=False))
    r = client.post("/pubsub/ingest", json=_push(job))
    assert r.status_code == 500
    assert store.jobs["job1"]["error"]["code"] == "internal"


def test_contract_mirrors_packages_contracts_json_schema():
    from pathlib import Path

    p = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "json-schema" / "IngestSheetVersionJob.json"
    if not p.exists():
        pytest.skip("packages/contracts json-schema not generated")
    ref = json.loads(p.read_text())["definitions"]["IngestSheetVersionJob"]
    ours = IngestSheetVersionJob.model_json_schema()
    assert set(ref["required"]) == set(ours["required"])
    assert set(ref["properties"]) == set(ours["properties"])
    for k in ("jobId", "orgId", "sha256", "storagePath"):
        assert ref["properties"][k]["pattern"].replace("\\/", "/") == ours["properties"][k]["pattern"]
    assert set(ref["properties"]["fileKind"]["enum"]) == set(ours["properties"]["fileKind"]["enum"])
