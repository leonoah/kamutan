"""Stage-10 acceptance, Pipeline row (docs/agents/STAGE10_ACCEPTANCE_BRIEF.md), synthetic inputs only.

Scenarios E2E-04 / 05 / 07 / 14 / 15 of docs/spec/07_test_plan.md on generated drawings (``synth.py``). Product
defects are ``xfail(strict=True)`` with the defect id of /home/claude/kamutan-data/acceptance/pipeline/defects.md, so
the suite stays green and flips to XPASS (= fail) once a defect is fixed and the marker must be removed.
"""

from __future__ import annotations

import gzip
import json
import socket
import time
from pathlib import Path
from typing import Any, Self

import pytest

pytest.importorskip(
    "kamutan_drawing", reason="run in the worker env: cd workers/drawing && uv run pytest ../../benchmark/acceptance"
)

import synth
from kamutan_drawing.boq.build import run_boq_build
from kamutan_drawing.boq.contracts import BoqBuildJob
from kamutan_drawing.cli import IngestResult, ingest_file
from kamutan_drawing.service.pipeline import Options
from kamutan_drawing.stores.local import LocalBlobStore, LocalDocStore

ORG, PROJECT = "org-acc", "p-acc"
FAST = Options(ocr=False, dpi=100)
R_SCALE_CONFLICT = "קנה מידה סותר"
R_RASTER = "רסטר"
R_RASTER_SPEC = "גיליון רסטר"


def ingest(tmp: Path, name: str, data: bytes, *, set_id: str | None = None, opts: Options = FAST, **kw: Any) -> IngestResult:
    src = tmp / "in" / name
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_bytes(data)
    return ingest_file(src, tmp / "root", org=ORG, project=PROJECT, sheet_set_id=set_id or src.stem, options=opts, **kw)


def artifact(tmp: Path, version: dict[str, Any], key: str) -> Any:
    p = (version.get("artifacts") or {}).get(key)
    assert p, f"no {key} artifact on the version"
    return json.loads(gzip.decompress((tmp / "root" / p).read_bytes()))


def build_boq(tmp: Path, build_id: str = "b1") -> dict[str, dict[str, Any]]:
    """boq.build exactly as the worker runs it, with a tiny synthetic item library for chapter 05."""
    docs, blobs = LocalDocStore(tmp / "root"), LocalBlobStore(tmp / "root")
    for code, desc, unit in (
        ("5.01", "חיפוי קירות חדרי רחצה", 'מ"ר'),
        ("5.02", "ריצוף ריצפות חדרי רחצה", 'מ"ר'),
        ("5.03", "חיתוך גרונג במפגש אריחי קרמיקה בפינות חיצוניות", 'מ"א'),
        ("5.05", "איטום ריצפות חדרי הרחצה בשתי שכבות סיכה", "קומפלט"),
    ):
        docs.set(f"orgs/{ORG}/itemLibrary/it_{code.replace('.', '_')}", {"code": code, "chapter": "05", "description": desc,
                                                                         "unit": unit, "active": True})  # fmt: skip
    proj = f"orgs/{ORG}/projects/{PROJECT}"
    docs.set(
        f"jobs/build-{build_id}", {"orgId": ORG, "projectId": PROJECT, "type": "boq.build", "status": "queued", "attempts": 0}
    )
    docs.set(f"{proj}/boqBuilds/{build_id}", {"status": "queued", "jobId": f"build-{build_id}"})
    job = BoqBuildJob(schemaVersion=1, type="boq.build", jobId=f"build-{build_id}", orgId=ORG, projectId=PROJECT,
                      buildId=build_id, traceparent=None)  # fmt: skip
    run_boq_build(job, blobs, docs)
    return {lid: d for lid, d in docs.list_docs(f"{proj}/boqLines")}


# --------------------------------------------------------------------------------------------- E2E-04
@pytest.fixture(scope="module")
def scale_conflict(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, IngestResult]:
    tmp = tmp_path_factory.mktemp("e2e04")
    return tmp, ingest(tmp, "scale_conflict.pdf", synth.scale_conflict_pdf(conflict=True))


def test_e2e04_sheet_flags_scale_conflict(scale_conflict: tuple[Path, IngestResult]) -> None:
    _, res = scale_conflict
    assert res.outcome is not None and res.outcome.status == "succeeded", res.error
    sheet = res.sheets[0]["sheet"]
    cls = sheet.get("classification") or {}
    assert sheet.get("discipline") == "construction"
    assert sheet.get("scaleDenominator") == 50
    assert R_SCALE_CONFLICT in (cls.get("reasons") or []), cls
    assert cls.get("level") != "green"


def test_e2e04_control_sheet_without_conflict(tmp_path: Path) -> None:
    res = ingest(tmp_path, "scale_ok.pdf", synth.scale_conflict_pdf(conflict=False))
    cls = res.sheets[0]["sheet"].get("classification") or {}
    assert R_SCALE_CONFLICT not in (cls.get("reasons") or []), cls


def test_e2e04_rooms_red_with_reason(scale_conflict: tuple[Path, IngestResult]) -> None:
    tmp, res = scale_conflict
    rooms = artifact(tmp, res.sheets[0]["version"], "rooms").get("rooms") or []
    assert rooms, "no rooms detected on the synthetic plan"
    for r in rooms:
        assert r.get("level") == "red" and R_SCALE_CONFLICT in (r.get("reasons") or []), r


def test_e2e04_area_lines_red_with_reason(scale_conflict: tuple[Path, IngestResult]) -> None:
    tmp, _ = scale_conflict
    lines = build_boq(tmp)
    area = {d["code"]: d for d in lines.values() if d.get("code") in ("5.01", "5.02")}
    assert area, f"no area line built: {sorted(str(d.get('code')) for d in lines.values())}"
    for code, d in area.items():
        assert d.get("level") == "red", (code, d.get("level"), d.get("reasons"))
        assert R_SCALE_CONFLICT in (d.get("reasons") or []), (code, d.get("reasons"))


# --------------------------------------------------------------------------------------------- E2E-05
@pytest.fixture(scope="module")
def raster(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, IngestResult]:
    tmp = tmp_path_factory.mktemp("e2e05")
    return tmp, ingest(tmp, "raster.png", synth.raster_png(), opts=Options(ocr=False, dpi=200))


def test_e2e05_raster_sheet_never_green(raster: tuple[Path, IngestResult]) -> None:
    tmp, res = raster
    assert res.outcome is not None and res.outcome.status == "succeeded", res.error
    sheet, version = res.sheets[0]["sheet"], res.sheets[0]["version"]
    cls = sheet.get("classification") or {}
    assert cls.get("level") != "green"
    assert R_RASTER in (cls.get("reasons") or []), cls
    dets = (
        (artifact(tmp, version, "detections").get("detections") or [])
        if (version.get("artifacts") or {}).get("detections")
        else []
    )
    assert all(d.get("level") != "green" for d in dets)


@pytest.mark.xfail(strict=True, reason="A-pipeline-11: the worker writes the reason 'רסטר', the spec/UI copy is 'גיליון רסטר'")
def test_e2e05_raster_reason_copy(raster: tuple[Path, IngestResult]) -> None:
    _, res = raster
    assert R_RASTER_SPEC in (res.sheets[0]["sheet"].get("classification") or {}).get("reasons", [])


# --------------------------------------------------------------------------------------------- E2E-07
@pytest.fixture(scope="module")
def blocks(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, IngestResult]:
    tmp = tmp_path_factory.mktemp("e2e07")
    return tmp, ingest(tmp, "blocks.dxf", synth.blocks_dxf(blocks=6, graphic_copies=2, exploded_extra=1))


def test_e2e07_dxf_ingests_and_keeps_inserts(blocks: tuple[Path, IngestResult]) -> None:
    from kamutan_drawing.pipeline.artifacts import decode_primitives

    tmp, res = blocks
    assert res.outcome is not None and res.outcome.status == "succeeded", res.error
    assert res.sheets[0]["sheet"].get("discipline") == "electrical"
    prim_path = (res.sheets[0]["version"].get("artifacts") or {}).get("primitives")
    assert prim_path
    prim = decode_primitives((tmp / "root" / prim_path).read_bytes())
    names = [i.get("name") for i in prim.get("inserts") or []]
    assert names.count("SOCKET") == 7  # 6 plan INSERTs + 1 in the legend


@pytest.mark.xfail(strict=True, reason="A-pipeline-05: DXF INSERT blocks are not used by symbol detection (0 sockets)")
def test_e2e07_block_symbols_are_counted(blocks: tuple[Path, IngestResult]) -> None:
    tmp, res = blocks
    dets = artifact(tmp, res.sheets[0]["version"], "detections").get("detections") or []
    assert sum(1 for d in dets if str(d.get("class", "")).startswith("socket")) >= 6


@pytest.mark.xfail(strict=True, reason="A-pipeline-05: INSERT block counts are parsed but never compared with the graphic count")
def test_e2e07_block_vs_graphic_mismatch_is_yellow_with_both_numbers(blocks: tuple[Path, IngestResult]) -> None:
    tmp, res = blocks
    dets = artifact(tmp, res.sheets[0]["version"], "detections").get("detections") or []
    sockets = [d for d in dets if str(d.get("class", "")).startswith("socket")]
    reasons = " ".join(r for d in sockets for r in (d.get("reasons") or []))
    flagged = [d for d in sockets if d.get("level") == "yellow" and "6" in " ".join(d.get("reasons") or [])
               and "7" in " ".join(d.get("reasons") or [])]  # fmt: skip
    assert flagged, f"no yellow block-vs-graphic mismatch with both counts (6 blocks, 7 graphic); reasons: {reasons[:300]}"


# --------------------------------------------------------------------------------------------- E2E-14
def test_e2e14_truncated_file_in_a_set(tmp_path: Path) -> None:
    files = {f"s{i}.pdf": synth.plain_sheet_pdf(f"ת. חשמל / קומת קרקע {i}") for i in range(4)}
    files["s_trunc.pdf"] = synth.truncated(synth.plain_sheet_pdf("ת. חשמל / קומת מרתף"))
    out: dict[str, IngestResult] = {}
    t0 = time.monotonic()
    for name, data in files.items():
        out[name] = ingest(tmp_path, name, data)
    assert time.monotonic() - t0 < 300, "the set must not hang"
    ok = [n for n, r in out.items() if r.outcome is not None and r.outcome.status == "succeeded"]
    bad = {n: r for n, r in out.items() if n not in ok}
    assert sorted(ok) == [f"s{i}.pdf" for i in range(4)]
    assert list(bad) == ["s_trunc.pdf"]
    r = bad["s_trunc.pdf"]
    assert r.error is not None and r.error.get("code") == "file_unreadable", r.error
    assert r.seconds < 30
    docs = LocalDocStore(tmp_path / "root")
    ss = docs.get(f"orgs/{ORG}/projects/{PROJECT}/sheetSets/s_trunc") or {}
    job = docs.get("jobs/ingest-s_trunc-v1") or {}
    assert job.get("status") == "failed" and ss.get("status") == "failed", (job, ss)
    assert (job.get("error") or {}).get("message") and (ss.get("error") or {}).get("code") == "file_unreadable"


# --------------------------------------------------------------------------------------------- E2E-15
class _Egress:
    def __init__(self) -> None:
        self.calls: list[Any] = []

    def __enter__(self) -> Self:
        self._orig = socket.socket.connect
        spy = self

        def connect(s: socket.socket, addr: Any) -> None:
            if s.family in (socket.AF_INET, socket.AF_INET6):
                spy.calls.append(addr)
            spy._orig(s, addr)

        socket.socket.connect = connect  # type: ignore[method-assign,assignment]
        return self

    def __exit__(self, *exc: object) -> None:
        socket.socket.connect = self._orig  # type: ignore[method-assign]


def test_e2e15_gateway_org_off_makes_no_request() -> None:
    """Provider configured (anthropic + key) but the org disabled the LLM: the gateway never builds a request."""
    import httpx
    from kamutan_drawing.llm_gateway import from_env

    sent: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        sent.append(req)
        return httpx.Response(500)

    transport = httpx.MockTransport(handler)
    env = {"KAMUTAN_LLM_PROVIDER": "anthropic", "KAMUTAN_LLM_API_KEY": "sk-test-not-a-key", "KAMUTAN_LLM_MODEL": "m"}
    gw = from_env(lambda org: {"llmEnabled": False}, transport=transport, env=env)
    img = synth.raster_png()
    with _Egress() as eg:
        r = gw.call(ORG, "legend_label", [img], {"currentReading": "שקע"}, {"type": "object"}, region_kind="legend_row")
    assert r.status == "disabled"
    assert sent == [] and eg.calls == []


def test_e2e15_ingest_with_llm_off_has_no_egress(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("KAMUTAN_LLM_PROVIDER", raising=False)
    with _Egress() as eg:
        res = ingest(tmp_path, "blocks.dxf", synth.blocks_dxf())
    assert res.outcome is not None and res.outcome.status == "succeeded"
    assert eg.calls == []
