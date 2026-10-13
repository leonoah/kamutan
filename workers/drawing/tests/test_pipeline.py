"""`process_sheet_version` end to end (real sandbox, in-memory stores, synthetic inputs)."""

from __future__ import annotations

import gzip
import json
import shutil
from dataclasses import replace

import pytest
from PIL import Image

from kamutan_drawing.classify.sheet import R_RASTER
from kamutan_drawing.errors import IngestError
from kamutan_drawing.pipeline.artifacts import decode_primitives, decode_text, glyph_store_path
from kamutan_drawing.render.tiles import Pyramid
from kamutan_drawing.service.pipeline import STAGES, WORKER_VERSION, process_sheet_version

from .pipeline_util import (
    FAST,
    ORG,
    PROJ,
    SET,
    TILE_RE,
    VER,
    job_payload,
    lighting_dxf,
    multipage_pdf,
    raster_png,
    seed,
    validate_job,
    validate_sheet,
    validate_version,
)

BASE = f"orgs/{ORG}/projects/{PROJ}"


def _vpath(sid: str, vid: str = VER) -> str:
    return f"{BASE}/sheets/{sid}/versions/{vid}"


@pytest.fixture(scope="module")
def pdf_run():
    data = multipage_pdf(2)
    job, blobs, docs = seed(data, job_payload(data))
    out = process_sheet_version(job, blobs, docs, FAST)
    return data, job, blobs, docs, out


def test_pdf_split_into_sheets_with_contract_docs(pdf_run):
    _, _, _, docs, out = pdf_run
    assert out.status == "succeeded" and [p.status for p in out.pages] == ["ready", "ready"]
    for i in (0, 1):
        sid = f"{SET}-p{i}"
        v = docs.get(_vpath(sid))
        s = docs.get(f"{BASE}/sheets/{sid}")
        assert v is not None and s is not None
        validate_version(v, VER, sid)
        validate_sheet(s, sid)
        assert v["status"] == "ready" and v["progress"] == {"stage": "done", "pct": 100} and v["error"] is None
        assert v["workerVersion"] == WORKER_VERSION and v["jobId"] == "job1"
        assert s["pageIndex"] == i and s["sheetSetId"] == SET and s["currentVersionId"] == VER and s["confirmed"] is False
        assert v["page"]["widthMm"] == pytest.approx(420, abs=1) and v["page"]["heightMm"] == pytest.approx(297, abs=1)
        assert v["stats"]["paths"] > 0 and v["stats"]["segments"] > 0
        assert set(s["classification"]) == {"discipline", "floors", "sheetTitle", "scaleText", "confidence", "level", "reasons"}
    jd = docs.get("jobs/job1")
    validate_job(jd, "job1")
    assert jd["status"] == "succeeded" and jd["progress"] == {"stage": "done", "pct": 100} and jd["attempts"] == 1
    ss = docs.get(f"{BASE}/sheetSets/{SET}")
    assert ss["status"] == "ready" and ss["pageCount"] == 2


def test_tiles_match_the_contract_pyramid(pdf_run):
    _, _, blobs, docs, _ = pdf_run
    sid = f"{SET}-p0"
    pre = f"{_vpath(sid)}/"
    meta = docs.get(_vpath(sid))["artifacts"]
    t = meta["tiles"]
    assert t["prefix"] == pre + "tiles/" and t["format"] == "webp" and t["tileSize"] == 256 and t["dpi"] == 72
    pyr = Pyramid.for_page(420.0, 297.0, 72)
    assert (t["widthPx"], t["heightPx"]) == (pyr.width_px, pyr.height_px) == (1191, 842)
    assert t["levels"] == 4  # 1191 -> 596 -> 298 -> 149 (z=0 fits one tile)
    tiles = [k for k in blobs.blobs if k.startswith(pre + "tiles/")]
    assert all(TILE_RE.search(k) for k in tiles) and len(tiles) == pyr.tile_count()
    assert {TILE_RE.search(k).groups() for k in tiles if TILE_RE.search(k).group(1) == "0"} == {("0", "0", "0")}  # type: ignore[union-attr]
    # full-resolution edge tile is cropped (not padded) and every tile is a webp
    from io import BytesIO

    last = Image.open(BytesIO(blobs.blobs[pre + "tiles/3/4_3.webp"]))
    assert last.format == "WEBP" and last.size == (1191 - 4 * 256, 842 - 3 * 256)
    thumb = Image.open(BytesIO(blobs.blobs[meta["thumbnail"]]))
    assert thumb.format == "WEBP" and max(thumb.size) == 512
    assert blobs.content_types[meta["thumbnail"]] == "image/webp"
    prim = decode_primitives(blobs.blobs[meta["primitives"]])
    assert prim["schema"] == "kamutan.primitives/1" and prim["paths"]["n"] > 0
    assert decode_text(blobs.blobs[meta["text"]])["schema"] == "kamutan.text/1"


def test_writes_only_under_the_job_org(pdf_run):
    _, job, blobs, _, _ = pdf_run
    for k in blobs.blobs:
        assert k == job.storagePath or k.startswith(f"{BASE}/sheets/") or k == glyph_store_path(ORG), k


def test_progress_stages_are_ordered(pdf_run):
    _, _, _, docs, _ = pdf_run
    seen = [d["progress"]["stage"] for p, d in docs.history if p == _vpath(f"{SET}-p1") and "progress" in d]
    order = [STAGES.index(s) for s in seen]
    assert order == sorted(order) and seen[0] == "ingest" and seen[-1] == "done"
    assert {"render", "classify"} <= set(seen)
    statuses = [d["status"] for p, d in docs.history if p == _vpath(f"{SET}-p1") and "status" in d]
    assert statuses[0] == "queued" and "processing" in statuses and statuses[-1] == "ready"
    jstat = [d["status"] for p, d in docs.history if p == "jobs/job1" and "status" in d]
    assert jstat[-2:] == ["running", "succeeded"]
    pcts = [d["progress"]["pct"] for p, d in docs.history if p == "jobs/job1" and "progress" in d]
    assert pcts == sorted(pcts) or pcts[0] == 0


def test_redelivery_is_idempotent(pdf_run):
    _, job, blobs, docs, _ = pdf_run
    writes = blobs.writes
    out = process_sheet_version(job, blobs, docs, FAST)
    assert out.status == "skipped" and blobs.writes == writes
    assert docs.get(_vpath(f"{SET}-p0"))["status"] == "ready" and docs.get("jobs/job1")["status"] == "succeeded"


def test_redelivery_after_a_crash_resumes_unfinished_pages():
    data = multipage_pdf(2)
    job, blobs, docs = seed(data, job_payload(data))
    process_sheet_version(job, blobs, docs, FAST)
    # simulate: worker died after page 0 (job still running, page 1 not finished)
    docs.set("jobs/job1", {"status": "running"})
    docs.set(_vpath(f"{SET}-p1"), {"status": "processing"})
    out = process_sheet_version(job, blobs, docs, FAST)
    assert [p.status for p in out.pages] == ["skipped", "ready"]
    assert docs.get("jobs/job1")["attempts"] == 2


def test_reprocess_keeps_user_regions_and_confirmed_fields(pdf_run):
    data, _, blobs, docs, _ = pdf_run
    sid = f"{SET}-p1"
    docs.set(
        f"{BASE}/sheets/{sid}",
        {"confirmed": True, "discipline": "plumbing", "floors": ["first"], "scaleDenominator": 100, "currentVersionId": "v2"},
    )
    user_regions = [
        {
            "id": "u1",
            "floor": "first",
            "polygonMm": [{"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 10, "y": 10}],
            "scaleDenominator": 100,
        }
    ]
    docs.set(
        _vpath(sid, "v2"),
        {"status": "queued", "progress": {"stage": "ingest", "pct": 0}, "regions": user_regions, "artifacts": {}},
    )
    job, blobs, docs = seed(
        None, job_payload(data, jobId="job2", sheetId=sid, pageIndex=1, versionId="v2"), docs=docs, blobs=blobs
    )
    out = process_sheet_version(job, blobs, docs, FAST)
    assert [(p.index, p.status) for p in out.pages] == [(1, "ready")]
    v = docs.get(_vpath(sid, "v2"))
    assert v["status"] == "ready" and v["regions"] == user_regions
    s = docs.get(f"{BASE}/sheets/{sid}")
    assert (s["discipline"], s["floors"], s["scaleDenominator"], s["currentVersionId"]) == ("plumbing", ["first"], 100, "v2")
    assert s["classification"]["level"] in ("green", "yellow", "red")
    assert docs.get(f"{BASE}/sheets/{SET}-p0")["currentVersionId"] == VER  # other pages untouched


def test_dxf_real_text_layers_blocks_and_floor_regions():
    data = lighting_dxf()
    job, blobs, docs = seed(data, job_payload(data, "dxf"))
    out = process_sheet_version(job, blobs, docs, FAST)
    assert out.status == "succeeded" and out.kind == "dxf"
    sid = f"{SET}-p0"
    v, s = docs.get(_vpath(sid)), docs.get(f"{BASE}/sheets/{sid}")
    validate_version(v, VER, sid)
    validate_sheet(s, sid)
    assert s["discipline"] == "lighting" and s["floors"] == ["basement", "ground"] and s["scaleDenominator"] == 50
    regions = v["regions"]
    assert [r["floor"] for r in regions] == ["basement", "ground"] and all(r["scaleDenominator"] == 50 for r in regions)
    assert regions[0]["polygonMm"][0]["y"] < regions[1]["polygonMm"][0]["y"]  # basement drawn above ground
    text = decode_text(blobs.read(v["artifacts"]["text"]))
    assert text["source"] == "dxf" and any("תאורה" in ln["text"] for ln in text["lines"])
    prim = decode_primitives(blobs.read(v["artifacts"]["primitives"]))
    assert {"WALLS", "LIGHTING"} <= set(prim["layers"]) and sum(1 for i in prim["inserts"] if i["name"] == "LAMP") == 8
    assert v["artifacts"]["tiles"]["levels"] >= 2


@pytest.mark.parametrize("fmt", ["PNG", "JPEG"])
def test_raster_is_capped_at_yellow(fmt):
    data = raster_png(fmt)
    job, blobs, docs = seed(data, job_payload(data, "png"))
    out = process_sheet_version(job, blobs, docs, FAST)
    assert out.status == "succeeded"
    sid = f"{SET}-p0"
    v, s = docs.get(_vpath(sid)), docs.get(f"{BASE}/sheets/{sid}")
    validate_version(v, VER, sid)
    t = v["artifacts"]["tiles"]
    assert (t["widthPx"], t["heightPx"], t["dpi"]) == (1400, 990, 100)  # native resolution is the max level
    assert v["page"]["widthMm"] == pytest.approx(1400 / 100 * 25.4, abs=0.01)
    assert s["classification"]["level"] != "green" and R_RASTER in s["classification"]["reasons"]


@pytest.mark.skipif(not shutil.which("tesseract"), reason="tesseract not installed")
def test_raster_with_ocr_stays_yellow_at_best():
    data = raster_png()
    job, blobs, docs = seed(data, job_payload(data, "png"))
    process_sheet_version(job, blobs, docs, replace(FAST, ocr=True))
    cls = docs.get(f"{BASE}/sheets/{SET}-p0")["classification"]
    assert cls["level"] in ("yellow", "red") and R_RASTER in cls["reasons"]


def test_dwg_without_converter_is_a_typed_unsupported_kind(monkeypatch):
    from kamutan_drawing.parse.dwg import dwg2dxf_path

    if dwg2dxf_path():
        pytest.skip("dwg2dxf installed here")
    data = b"AC1032" + b"\x00" * 2000
    job, blobs, docs = seed(data, job_payload(data, "dwg"))
    with pytest.raises(IngestError) as e:
        process_sheet_version(job, blobs, docs, FAST)
    assert e.value.code == "unsupported_kind" and not e.value.retryable
    jd = docs.get("jobs/job1")
    assert jd["status"] == "failed" and jd["error"]["code"] == "unsupported_kind" and "DWG" in jd["error"]["message"]
    assert docs.get(f"{BASE}/sheetSets/{SET}")["status"] == "failed"


def test_job_document_must_exist_and_belong_to_the_org():
    data = multipage_pdf(1)
    job, blobs, docs = seed(data, job_payload(data))
    docs.docs.pop("jobs/job1")
    with pytest.raises(IngestError) as e:
        process_sheet_version(job, blobs, docs, FAST)
    assert e.value.code == "invalid_payload" and docs.docs == {}
    job, blobs, docs = seed(data, job_payload(data), orgId="someone-else")
    with pytest.raises(IngestError) as e:
        process_sheet_version(job, blobs, docs, FAST)
    assert e.value.code == "invalid_payload" and list(docs.docs) == ["jobs/job1"] and docs.get("jobs/job1")["status"] == "queued"


@pytest.mark.parametrize(
    ("make", "kind", "code"),
    [
        (lambda: None, "pdf", "source_not_found"),
        (lambda: b"%PDF-1.4 garbage, not a document", "pdf", "file_unreadable"),
        (lambda: raster_png(), "pdf", "file_type_mismatch"),
        (lambda: b"MZ\x90\x00" + b"\x00" * 600, "pdf", "unsupported_format"),
        (lambda: b"0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n", "dxf", "file_unreadable"),
    ],
)
def test_typed_failures_are_recorded(make, kind, code):
    data = make()
    payload = job_payload(data or b"x", kind)
    job, blobs, docs = seed(data, payload)
    with pytest.raises(IngestError) as e:
        process_sheet_version(job, blobs, docs, FAST)
    assert e.value.code == code and not e.value.retryable
    jd = docs.get("jobs/job1")
    validate_job(jd, "job1")
    assert jd["status"] == "failed" and jd["error"]["code"] == code
    assert len(jd["error"]["message"]) <= 300


def test_sha256_mismatch():
    data = multipage_pdf(1)
    job, blobs, docs = seed(data, job_payload(data))
    blobs.write(job.storagePath, data + b"\n", "application/pdf")
    with pytest.raises(IngestError) as e:
        process_sheet_version(job, blobs, docs, FAST)
    assert e.value.code == "sha256_mismatch"


def test_internal_errors_are_retryable_until_attempts_run_out(monkeypatch):
    data = multipage_pdf(1)

    def boom(*a, **k):
        raise RuntimeError("disk full")

    monkeypatch.setattr("kamutan_drawing.service.pipeline.run_task", boom)
    job, blobs, docs = seed(data, job_payload(data))
    with pytest.raises(IngestError) as e:
        process_sheet_version(job, blobs, docs, FAST)
    assert e.value.code == "internal" and e.value.retryable
    assert docs.get("jobs/job1")["status"] == "queued"  # Pub/Sub will redeliver
    docs.set("jobs/job1", {"attempts": 4})
    with pytest.raises(IngestError) as e:
        process_sheet_version(job, blobs, docs, FAST)
    assert not e.value.retryable and docs.get("jobs/job1")["status"] == "failed" and docs.get("jobs/job1")["attempts"] == 5


def test_classification_never_contains_title_block_pii(pdf_run):
    _, _, blobs, docs, _ = pdf_run
    for p, d in docs.docs.items():
        if "/sheets/" in p and "/versions/" not in p:
            assert set(d["classification"]) == {
                "discipline",
                "floors",
                "sheetTitle",
                "scaleText",
                "confidence",
                "level",
                "reasons",
            }
    for k, b in blobs.blobs.items():
        if k.endswith("text.json.gz"):
            assert set(json.loads(gzip.decompress(b))) == {"schema", "source", "lines"}
