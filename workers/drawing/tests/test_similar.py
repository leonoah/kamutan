"""Sprint 4 (Worker-A): "learn from correction" — ``symbols.find_similar`` (search + job) on synthetic sheets."""

from __future__ import annotations

import base64
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient

from kamutan_drawing.errors import IngestError
from kamutan_drawing.legend.parse import parse_legends
from kamutan_drawing.parse.vectors import VectorBuilder
from kamutan_drawing.service.app import create_app
from kamutan_drawing.service.pipeline import process_sheet_version
from kamutan_drawing.service.similar import FindSimilarJob, run_find_similar, search_doc_path, thumbs_prefix
from kamutan_drawing.symbols.similar import (
    ExemplarError,
    SheetData,
    exemplar_segments,
    exemplar_template,
    find_similar,
    render_thumb,
    search_scales,
)

from .pipeline_util import FAST, ORG, PROJ, VER, job_payload, seed
from .synth_legend import PLACED, Placed, hebrew_font, legend_sheet_pdf
from .test_legend_symbols import _load

CONTRACTS = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "json-schema"
needs_font = pytest.mark.skipif(hebrew_font() is None, reason="needs a TTF font with Hebrew glyphs (DejaVu Sans)")


def _box(x: float, y: float, r: float = 2.6) -> tuple[float, float, float, float]:
    return (x - r, y - r, x + r, y + r)


@pytest.fixture(scope="module")
def synth(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("similar")
    src, vs, spans = _load(legend_sheet_pdf(), tmp)
    exclude = parse_legends(vs, spans).exclusion_boxes()
    yield vs, exclude
    src.close()


# ------------------------------------------------------------------------------ search (pure)
@needs_font
def test_socket_exemplar_finds_sockets_in_every_orientation(synth):
    vs, exclude = synth
    sheet = SheetData("s1", "v1", vs, 50, [], exclude)
    cands, stats = find_similar(sheet, _box(150, 60), [sheet], min_score=0.5)
    strong = [c for c in cands if c.score >= 0.8]
    sockets = [p for p in PLACED if p.kind in ("socket", "socket2x") and (p.x, p.y) != (150, 60)]
    for p in sockets:
        assert any(math.dist(c.center, (p.x, p.y)) < 2.5 for c in strong), p
    # the exemplar itself is not a candidate; other drawings are not strong candidates
    assert not any(math.dist(c.center, (150, 60)) < 2.5 for c in cands)
    others = [p for p in PLACED if p.kind not in ("socket", "socket2x")]
    assert not any(math.dist(c.center, (p.x, p.y)) < 2.5 for c in strong for p in others)
    # legend rows are excluded from the scene
    assert not any(200 <= c.center[1] <= 236 and 20 <= c.center[0] <= 110 for c in cands)
    assert [c.score for c in cands] == sorted((c.score for c in cands), reverse=True)
    assert stats["template"]["anchor"] == "arc" and stats["perSheet"] == {"s1": len(cands)}


@needs_font
def test_already_detected_and_current_class(synth):
    vs, exclude = synth
    dets = [
        {"id": "d_7", "class": "socket_double", "centerMm": {"x": 300.8, "y": 80.4}},
        {"id": "d_8", "class": "socket_single", "bboxMm": {"x": 198.0, "y": 58.0, "w": 4.0, "h": 4.0}},
        {"id": "d_9", "class": "socket_single", "centerMm": {"x": 260.0, "y": 80.0}},  # 10 mm away: not it
        # an AC position snapped onto the socket (derived fixture record): the socket is the detection there
        {"id": "d_fx_0", "class": "ac_unit", "centerMm": {"x": 300.0, "y": 80.0}},
    ]
    sheet = SheetData("s1", "v1", vs, 50, dets, exclude)
    cands, _ = find_similar(sheet, _box(150, 60), [sheet], exemplar_class="socket_single")
    by_pos = {(round(c.center[0] / 10), round(c.center[1] / 10)): c for c in cands}
    assert by_pos[(30, 8)].already_detected == "d_7" and by_pos[(30, 8)].current_class == "socket_double"
    assert by_pos[(20, 6)].already_detected == "d_8"
    assert by_pos[(25, 8)].already_detected is None and by_pos[(25, 8)].current_class is None
    j = by_pos[(30, 8)].to_json()
    assert set(j) == {"sheetId", "versionId", "centerMm", "bboxMm", "score", "alreadyDetected", "currentClass"}


@needs_font
def test_loose_box_on_a_switch_bank_keeps_only_the_marked_switch(synth):
    vs, _ = synth
    alone = exemplar_template(vs, (317.0, 127.0, 323.8, 131.2))
    # bank at (230,110) / (230,112.4): a box around the first one reaches into the second
    bank = exemplar_template(vs, (227.0, 107.0, 233.8, 111.2))
    sg = vs.segs
    naive = np.where((sg[:, [0, 2]].min(1) >= 226.75) & (sg[:, [0, 2]].max(1) <= 234.05)
                     & (sg[:, [1, 3]].min(1) >= 106.75) & (sg[:, [1, 3]].max(1) <= 111.45))[0]  # fmt: skip
    assert abs(len(bank.entries[0].seg_idx) - len(alone.entries[0].seg_idx)) <= 2
    assert len(naive) > len(bank.entries[0].seg_idx)  # the neighbour's lever end was inside the box
    assert abs(bank.w - alone.w) < 0.2 and abs(bank.h - alone.h) < 0.2


@needs_font
def test_empty_box_and_walls_only_are_not_an_exemplar(synth):
    vs, _ = synth
    with pytest.raises(ExemplarError):
        exemplar_template(vs, (60.0, 100.0, 64.0, 104.0))  # blank paper
    # a box on a wall line only: the wall path is far larger than the box → not part of the symbol
    assert len(exemplar_segments(vs, (250.0, 38.0, 254.0, 42.0))) == 0


def _shape(b: VectorBuilder, cx: float, cy: float, s: float = 1.0, ang: float = 0.0) -> None:
    """A distinctive straight-line drawing (flag on a pole) — polylines only, like a DXF block."""
    t = math.radians(ang)
    rot = np.array([[math.cos(t), math.sin(t)], [-math.sin(t), math.cos(t)]])

    def P(*pts: tuple[float, float]) -> np.ndarray:
        return np.array(pts) * s @ rot.T + np.array([cx, cy])

    b.add(P((0, 3), (0, -3)), width_mm=0.25)
    b.add(P((0, -3), (2.5, -2), (0, -1)), width_mm=0.25)
    b.add(P((-1.2, 3), (1.2, 3)), width_mm=0.25)


def test_scale_difference_between_sheets():
    a = VectorBuilder()
    _shape(a, 50, 50)
    _shape(a, 90, 50, ang=90)
    sheet_a = a.build(0, 200, 150)
    bb = VectorBuilder()
    _shape(bb, 40, 40, s=0.5)  # same block on a 1:100 plan: half size on paper
    _shape(bb, 80, 60, s=0.5, ang=180)
    _shape(bb, 120, 60, s=1.0)  # paper-size symbol (annotative block)
    sheet_b = bb.build(0, 200, 150)
    ex = SheetData("a", "v1", sheet_a, 50)
    tb = SheetData("b", "v1", sheet_b, 100)
    assert search_scales(50, 100) == [1.0, 0.5] and search_scales(50, 50) == [1.0] and search_scales(None, 100) == [1.0]
    cands, _ = find_similar(ex, (48.0, 46.0, 53.5, 54.0), [ex, tb], min_score=0.6)
    got = [(c.sheet_id, c.center[0], c.center[1]) for c in cands if c.score >= 0.8]
    assert any(s == "a" and math.dist((x, y), (90, 50)) <= 2 for s, x, y in got)
    b_pts = [(x, y) for s, x, y in got if s == "b"]
    for want in ((40, 40), (80, 60), (120, 60)):
        assert any(math.dist(p, want) <= 2 for p in b_pts), want
    # same scale on both sheets: the half-size copies are not proposed
    tb.scale_den = 50
    cands, _ = find_similar(ex, (48.0, 46.0, 53.5, 54.0), [tb], min_score=0.6)
    assert not any(math.dist(c.center, (40, 40)) <= 2 for c in cands if c.score >= 0.8)


def test_render_thumb_is_a_small_webp():
    b = VectorBuilder()
    _shape(b, 50, 50)
    data = render_thumb(b.build(0, 200, 150), (47.0, 46.0, 53.0, 54.0))
    assert data[:4] == b"RIFF" and data[8:12] == b"WEBP" and len(data) < 8000


# ------------------------------------------------------------------------------ job (orchestrator + sandbox)
def _ingest(data: bytes, set_id: str, docs=None, blobs=None):
    payload = job_payload(data, sheetSetId=set_id, jobId=f"ing-{set_id}",
                          storagePath=f"orgs/{ORG}/projects/{PROJ}/uploads/{set_id}/source.pdf")  # fmt: skip
    job, blobs, docs = seed(data, payload, docs=docs, blobs=blobs)
    process_sheet_version(job, blobs, docs, FAST)
    return blobs, docs


def _payload(scope: str = "sheet", jid: str = "sim1", sheet: str = "seta-p0", **over: Any) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "type": "symbols.find_similar",
        "jobId": jid,
        "orgId": ORG,
        "projectId": PROJ,
        "searchId": f"s-{jid}",
        "exemplar": {
            "sheetId": sheet,
            "versionId": VER,
            "bboxMm": {"x": 147.4, "y": 57.4, "w": 5.2, "h": 5.2},
            "class": "socket_single",
        },
        "scope": scope,
        "maxCandidates": 500,
        "traceparent": None,
        **over,
    }


def _job(docs, scope: str = "sheet", jid: str = "sim1", sheet: str = "seta-p0", **over: Any) -> FindSimilarJob:
    """jobs/{jobId} + similarSearches/{searchId} (queued), as the API creates them."""
    job = FindSimilarJob.model_validate(_payload(scope, jid, sheet, **over))
    docs.set(f"jobs/{jid}", {"orgId": ORG, "projectId": PROJ, "type": "symbols.find_similar", "status": "queued", "attempts": 0})
    docs.set(
        search_doc_path(job),
        {
            "id": job.searchId,
            "status": "queued",
            "exemplar": job.model_dump(mode="json", by_alias=True)["exemplar"],
            "scope": job.scope,
            "correctionId": None,
            "jobId": jid,
            "requestedBy": "u1",
            "createdAt": "2026-10-14T00:00:00.000Z",
            "finishedAt": None,
            "candidates": [],
            "thumbs": 0,
            "error": None,
        },
        merge=False,
    )
    return job


@pytest.fixture(scope="module")
def project():
    if hebrew_font() is None:
        pytest.skip("needs DejaVu Sans")
    blobs, docs = _ingest(legend_sheet_pdf(), "seta")
    more = [Placed("socket", 160, 70, 45, "socket_single"), Placed("switch", 300, 120, 0, "switch_single")]
    blobs, docs = _ingest(legend_sheet_pdf(more), "setb", docs, blobs)
    return blobs, docs


def test_job_sheet_and_project_scope(project):
    blobs, docs = project
    job = _job(docs, "sheet", "sim-sheet")
    out = run_find_similar(job, blobs, docs)
    assert out["status"] == "succeeded"
    doc = docs.get(search_doc_path(job))
    assert doc["status"] == "succeeded" and doc["scope"] == "sheet" and doc["exemplar"]["class"] == "socket_single"
    assert doc["requestedBy"] == "u1" and doc["finishedAt"] and doc["error"] is None  # API fields kept
    cands = doc["candidates"]
    assert {c["sheetId"] for c in cands} == {"seta-p0"} and len(cands) >= 3
    assert doc["thumbs"] == len(cands) and [c["id"] for c in cands] == [f"c_{i}" for i in range(len(cands))]
    for c in cands:
        assert c["thumb"] == f"{c['id']}.webp"
        path = thumbs_prefix(job) + c["thumb"]
        assert blobs.read(path)[8:12] == b"WEBP" and blobs.content_types[path] == "image/webp"
    # the detector's own sockets on that sheet are reported as already detected
    assert sum(1 for c in cands if c["alreadyDetected"]) >= 3
    assert all(c["currentClass"] for c in cands if c["alreadyDetected"])
    jd = docs.get("jobs/sim-sheet")
    assert jd["status"] == "succeeded" and jd["result"]["candidates"] == len(cands) and jd["result"]["sheets"] == 1
    # project scope: the other sheet's 45° socket is found too
    job2 = _job(docs, "project", "sim-proj")
    run_find_similar(job2, blobs, docs)
    c2 = docs.get(search_doc_path(job2))["candidates"]
    assert any(c["sheetId"] == "setb-p0" and math.dist((c["centerMm"]["x"], c["centerMm"]["y"]), (160, 70)) < 2.5 for c in c2)
    # redelivery of a finished search: no-op
    assert run_find_similar(job2, blobs, docs)["status"] == "skipped"


def test_job_errors(project):
    blobs, docs = project
    job = _job(docs, jid="sim-bad", sheet="nope-p0")
    with pytest.raises(IngestError) as e:
        run_find_similar(job, blobs, docs)
    assert e.value.code == "invalid_payload" and not e.value.retryable
    assert docs.get("jobs/sim-bad")["status"] == "failed"
    job = _job(docs, jid="sim-foreign")
    docs.set("jobs/sim-foreign", {"orgId": "other"})
    with pytest.raises(IngestError):
        run_find_similar(job, blobs, docs)
    assert docs.get(search_doc_path(job))["status"] == "queued"
    # the API did not create the search doc: nothing to fill
    job = FindSimilarJob.model_validate(_payload(jid="sim-nodoc"))
    docs.set("jobs/sim-nodoc", {"orgId": ORG, "projectId": PROJ})
    with pytest.raises(IngestError) as e:
        run_find_similar(job, blobs, docs)
    assert e.value.code == "invalid_payload"
    # a box on blank paper: an empty result, not a failure
    job = _job(docs, jid="sim-empty",
               exemplar={"sheetId": "seta-p0", "versionId": VER, "bboxMm": {"x": 60, "y": 100, "w": 4, "h": 4}, "class": None})  # fmt: skip
    run_find_similar(job, blobs, docs)
    doc = docs.get(search_doc_path(job))
    assert doc["status"] == "succeeded" and doc["candidates"] == [] and doc["thumbs"] == 0
    assert docs.get("jobs/sim-empty")["result"]["reason"] == "empty_exemplar"


def test_job_payload_validation():
    base = _payload("project")
    FindSimilarJob.model_validate(base)
    for bad in (
        {"scope": "org"},
        {"exemplar": {**base["exemplar"], "bboxMm": {"x": 1, "y": 1, "w": 0, "h": 3}}},
        {"exemplar": {**base["exemplar"], "sheetId": "../x"}},
        {"extra": 1},
        {"maxCandidates": 501},
        {"searchId": None},
    ):
        with pytest.raises(ValueError):
            FindSimilarJob.model_validate({**base, **bad})
    no_class = {**base, "exemplar": {k: v for k, v in base["exemplar"].items() if k != "class"}}
    with pytest.raises(ValueError):
        FindSimilarJob.model_validate(no_class)  # class is required (nullable)
    assert FindSimilarJob.model_validate(base).search_id == "s-sim1"


def test_push_route_dispatches_find_similar(project):
    blobs, docs = project
    _job(docs, jid="sim-push")
    payload = _payload(jid="sim-push")
    env = {"message": {"data": base64.b64encode(json.dumps(payload).encode()).decode(), "messageId": "1"}, "subscription": "s"}
    client = TestClient(create_app(blobs, docs, FAST))
    r = client.post("/pubsub/ingest", json=env)
    assert r.status_code == 204
    assert docs.get(f"orgs/{ORG}/projects/{PROJ}/similarSearches/s-sim-push")["status"] == "succeeded"
    bad = {**payload, "scope": "galaxy"}
    env["message"]["data"] = base64.b64encode(json.dumps(bad).encode()).decode()
    r = client.post("/pubsub/ingest", json=env)
    assert r.status_code == 200 and r.json()["reason"] == "invalid_payload"


def test_find_similar_timing_budget(project):
    """15 sheets must finish in < 20 s: the search on one synthetic sheet stays far below 1 s."""
    blobs, docs = project
    job = _job(docs, "project", "sim-time")
    out = run_find_similar(job, blobs, docs)
    assert out["stats"]["searchMs"] < 5000 and out["stats"]["sheets"] == 2


# ------------------------------------------------------------------------------ contracts mirror
def _schema(name: str) -> dict[str, Any]:
    p = CONTRACTS / f"{name}.json"
    if not p.exists():
        pytest.skip(f"packages/contracts json-schema/{name}.json not generated")
    s: dict[str, Any] = json.loads(p.read_text())
    return s


def test_find_similar_job_mirror():
    import jsonschema

    s = _schema("FindSimilarJob")
    ref = s["definitions"]["FindSimilarJob"]
    ours = FindSimilarJob.model_json_schema(by_alias=True)
    assert set(ref["required"]) == set(ours["required"])
    assert set(ref["properties"]) == set(ours["properties"])
    ex_ref = ref["properties"]["exemplar"]
    ex_ours = ours["$defs"]["SimilarExemplar"]
    assert set(ex_ref["required"]) == set(ex_ours["required"]) and set(ex_ref["properties"]) == set(ex_ours["properties"])
    assert set(ex_ref["properties"]["bboxMm"]["required"]) == set(ours["$defs"]["BBoxMm"]["required"])
    assert ref["properties"]["maxCandidates"]["maximum"] == ours["properties"]["maxCandidates"]["maximum"] == 500
    assert set(ref["properties"]["scope"]["enum"]) == {"sheet", "project"}
    for k in ("jobId", "orgId", "projectId", "searchId"):
        assert ref["properties"][k]["pattern"] == ours["properties"][k]["pattern"], k
    payload = _payload()
    jsonschema.validate(payload, s)
    FindSimilarJob.model_validate(payload)
    # every class the contracts allow is accepted by the worker mirror
    for cls in ex_ref["properties"]["class"]["anyOf"][0]["enum"]:
        FindSimilarJob.model_validate({**payload, "exemplar": {**payload["exemplar"], "class": cls}})


def test_similar_search_doc_matches_contract(project):
    import jsonschema

    s = _schema("SimilarSearch")
    blobs, docs = project
    job = _job(docs, "sheet", "sim-contract")
    run_find_similar(job, blobs, docs)
    doc = dict(docs.get(search_doc_path(job)))
    props = s["definitions"]["SimilarSearch"]["properties"]
    assert set(doc) <= set(props), set(doc) - set(props)  # the worker writes contract fields only
    jsonschema.validate(doc, s)
    assert doc["candidates"]
    for c in doc["candidates"]:
        jsonschema.validate(c, _schema("SimilarCandidate"))
