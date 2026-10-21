"""Sprint 2 (Worker-A): the understanding stage inside `process_sheet_version` (real sandbox, in-memory stores)."""

from __future__ import annotations

import gzip
import json
from dataclasses import replace

import pytest

from kamutan_drawing.service import pipeline as P
from kamutan_drawing.service.pipeline import STAGES, process_sheet_version

from .pipeline_util import FAST, ORG, PROJ, SET, VER, job_payload, seed, validate, validate_version
from .synth_legend import PLACED, hebrew_font, legend_sheet_pdf

pytestmark = pytest.mark.skipif(hebrew_font() is None, reason="needs a TTF font with Hebrew glyphs (DejaVu Sans)")

BASE = f"orgs/{ORG}/projects/{PROJ}"
SID = f"{SET}-p0"


def _vpath(vid: str = VER) -> str:
    return f"{BASE}/sheets/{SID}/versions/{vid}"


def _gz(blobs, path):
    return json.loads(gzip.decompress(blobs.read(path)))


@pytest.fixture(scope="module")
def run():
    data = legend_sheet_pdf()
    job, blobs, docs = seed(data, job_payload(data))
    out = process_sheet_version(job, blobs, docs, FAST)
    return data, job, blobs, docs, out


def test_version_doc_gets_artifacts_and_stats(run):
    _, _, blobs, docs, out = run
    assert out.status == "succeeded"
    v = docs.get(_vpath())
    validate_version(v, VER, SID)
    pre = f"{BASE}/sheets/{SID}/versions/{VER}/"
    assert v["artifacts"]["legend"] == pre + "legend.json.gz"
    assert v["artifacts"]["detections"] == pre + "detections.json.gz"
    assert v["artifacts"]["rooms"] == pre + "rooms.json.gz"
    st = v["stats"]
    assert st["legendEntries"] == 6 and st["detections"]["total"] == len(PLACED)
    assert st["detections"]["byClass"] == {
        "luminaire_ceiling": 2,
        "socket_double": 1,
        "socket_power": 2,
        "socket_single": 3,
        "switch_2way": 1,
        "switch_single": 4,
    }
    assert st["detections"]["green"] + st["detections"]["yellow"] + st["detections"]["red"] == st["detections"]["total"]
    # Sprint 5 (Worker-Cal): calibration + per-stage timings on the version; conservative table → no green
    from kamutan_drawing.calibration import default_table
    from kamutan_drawing.service.pipeline import TIMING_STAGES

    assert st["calibration"] == default_table().stats() and st["calibration"]["mode"] == "conservative"
    assert tuple(st["timingsMs"]) == TIMING_STAGES and st["timingsMs"]["total"] >= st["timingsMs"]["symbols"] > 0
    assert st["detections"]["green"] == 0
    if v.get("titleBlock") is not None:
        x0, y0, x1, y1 = v["titleBlock"]["bboxMm"]
        tb = v["titleBlockMm"]
        assert (x0, y0) == (tb["x"], tb["y"]) and x1 > x0 and y1 > y0
    det = _gz(blobs, v["artifacts"]["detections"])
    validate("DetectionsArtifact", det)
    validate("LegendArtifact", _gz(blobs, v["artifacts"]["legend"]))
    validate("RoomsArtifact", _gz(blobs, v["artifacts"]["rooms"]))
    for e in _gz(blobs, v["artifacts"]["legend"])["entries"]:
        assert blobs.read(pre + e["thumb"])[:4] == b"RIFF"


def test_progress_goes_through_legend_detect_rooms(run):
    _, _, _, docs, _ = run
    seen = [d["progress"]["stage"] for p, d in docs.history if p == _vpath() and "progress" in d]
    assert [STAGES.index(s) for s in seen] == sorted(STAGES.index(s) for s in seen)
    assert {"legend", "detect", "rooms"} <= set(seen) and seen[-1] == "done"


def test_legend_entries_written_as_suggested(run):
    _, _, _, docs, _ = run
    entries = docs.list_docs(f"{BASE}/legendEntries")
    assert len(entries) == 6
    for eid, e in entries:
        validate("LegendEntry", {**e, "id": eid, "updatedAt": "2026-10-13T00:00:00.000Z"})
        assert e["status"] == "suggested" and e["class"] is None and e["sheetId"] == SID and e["versionId"] == VER
        assert e["thumbPath"].endswith(f"/legend/{eid}.webp")


def test_confirmed_and_ignored_entries_are_kept_and_linked(run):
    data, _, blobs, docs, _ = run
    entries = dict(docs.list_docs(f"{BASE}/legendEntries"))
    sock = next(k for k, e in entries.items() if e["suggestedClass"] == "socket_single")
    powr = next(k for k, e in entries.items() if e["suggestedClass"] == "socket_power")
    docs.set(
        f"{BASE}/legendEntries/{sock}", {"status": "confirmed", "class": "socket_prep", "itemCode": "4.10", "confirmedBy": "u1"}
    )
    docs.set(f"{BASE}/legendEntries/{powr}", {"status": "ignored"})
    docs.set(_vpath("v2"), {"status": "queued", "progress": {"stage": "ingest", "pct": 0}, "artifacts": {}, "regions": []})
    job, blobs, docs = seed(
        None, job_payload(data, jobId="job2", sheetId=SID, pageIndex=0, versionId="v2"), docs=docs, blobs=blobs
    )
    process_sheet_version(job, blobs, docs, FAST)
    assert docs.get(f"{BASE}/legendEntries/{sock}")["status"] == "confirmed"  # never overwritten
    assert docs.get(f"{BASE}/legendEntries/{sock}")["class"] == "socket_prep"
    assert docs.get(f"{BASE}/legendEntries/{powr}")["status"] == "ignored"
    v2 = docs.get(_vpath("v2"))
    det = _gz(blobs, v2["artifacts"]["detections"])
    by = v2["stats"]["detections"]["byClass"]
    assert by.get("socket_prep") == 4 and "socket_power" not in by
    assert {d["legendEntryId"] for d in det["detections"] if d["class"] == "socket_prep"} == {sock}


def test_stage_can_be_switched_off():
    data = legend_sheet_pdf()
    job, blobs, docs = seed(data, job_payload(data))
    process_sheet_version(job, blobs, docs, replace(FAST, understand=False))
    v = docs.get(_vpath())
    assert v["status"] == "ready" and "legend" not in v["artifacts"] and "detections" not in (v["stats"] or {})
    assert not docs.list_docs(f"{BASE}/legendEntries")


def test_low_confidence_labels_go_to_the_llm_gateway(monkeypatch):
    from kamutan_drawing.llm_gateway import FakeProvider, LlmGateway, docstore_settings_reader
    from kamutan_drawing.stores import InMemoryBlobStore

    data = legend_sheet_pdf()
    job, blobs, docs = seed(data, job_payload(data))
    docs.set(f"orgs/{ORG}", {"settings": {"llmEnabled": True, "llmMonthlyBudgetUsd": 5.0}})
    fake = FakeProvider(responder=lambda system, user, images: json.dumps({"label": "שקע כפול"}, ensure_ascii=False))
    gw = LlmGateway(provider=fake, org_settings_reader=docstore_settings_reader(docs), blobs=InMemoryBlobStore(), max_tokens=256)
    monkeypatch.setattr(P, "LLM_LABEL_BELOW", 1.01)  # every label counts as unsure
    process_sheet_version(job, blobs, docs, replace(FAST, llm=gw, llm_max_labels=2))
    assert len(fake.calls) == 2 and all(len(c["images"]) == 1 for c in fake.calls)
    entries = [e for _, e in docs.list_docs(f"{BASE}/legendEntries")]
    refined = [e for e in entries if e["label"] == "שקע כפול"]
    assert len(refined) == 2 and all(e["suggestedClass"] == "socket_double" and e["labelConfidence"] <= 0.84 for e in refined)
    leg = _gz(blobs, docs.get(_vpath())["artifacts"]["legend"])
    validate("LegendArtifact", leg)
    assert sum(1 for e in leg["entries"] if e["label"] == "שקע כפול") == 2


def test_gateway_disabled_by_default_changes_nothing(run):
    _, _, _, docs, _ = run
    assert all(e["labelConfidence"] > 0.9 for _, e in docs.list_docs(f"{BASE}/legendEntries") if e["status"] == "suggested")
