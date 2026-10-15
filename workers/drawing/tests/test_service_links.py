"""Sprint 3: the ingest orchestrator uploads Worker-A's links artifact and passes the sheet confirmation."""

from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Any

import pytest

from kamutan_drawing.errors import IngestError
from kamutan_drawing.service import pipeline as P
from kamutan_drawing.service.pipeline import process_sheet_version

from .pipeline_util import FAST, ORG, PROJ, SET, VER, job_payload, seed
from .synth_legend import hebrew_font, legend_sheet_pdf

pytestmark = pytest.mark.skipif(hebrew_font() is None, reason="needs a TTF font with Hebrew glyphs (DejaVu Sans)")

PRE = f"orgs/{ORG}/projects/{PROJ}/sheets/{SET}-p0/versions/{VER}/"
LINKS = {"schema": "kamutan.links/1", "groups": [{"id": "lk_1", "switchIds": ["d_1"], "pointIds": ["d_2"], "luminaireIds": ["d_2"],
         "kind": "single", "confidence": 0.9, "level": "green", "reasons": []}]}  # fmt: skip
STATS = {"groups": 1, "green": 1, "yellow": 0, "red": 0, "byKind": {"single": 1, "bogus": 3}, "arcs": 2, "danglingEnds": -4}


def _patched(monkeypatch: pytest.MonkeyPatch, seen: list[dict[str, Any]], name: str = "links.json.gz") -> None:
    real = P.run_task

    def fake(task: str, args: dict[str, Any], **kw: Any) -> Any:
        res = real(task, args, **kw)
        if task == "understand":
            seen.append(dict(args))
            (Path(kw["workdir"]) / str(res["outDir"]) / "links.json.gz").write_bytes(gzip.compress(json.dumps(LINKS).encode()))
            res = {**res, "linksFile": name, "linkStats": STATS}
        return res

    monkeypatch.setattr(P, "run_task", fake)


def test_links_artifact_uploaded_and_stats_written(monkeypatch):
    seen: list[dict[str, Any]] = []
    _patched(monkeypatch, seen)
    data = legend_sheet_pdf()
    job, blobs, docs = seed(data, job_payload(data))
    process_sheet_version(job, blobs, docs, FAST)
    assert seen and seen[0]["floorsConfirmed"] is False
    v = docs.get(PRE[:-1])
    assert v["artifacts"]["links"] == PRE + "links.json.gz"
    assert json.loads(gzip.decompress(blobs.read(PRE + "links.json.gz"))) == LINKS
    assert blobs.content_types[PRE + "links.json.gz"] == "application/gzip"
    st = v["stats"]["links"]
    assert st["groups"] == 1 and st["byKind"] == {"single": 1} and st["danglingEnds"] == 0


def test_floors_confirmed_passed_on_reprocess(monkeypatch):
    seen: list[dict[str, Any]] = []
    data = legend_sheet_pdf()
    job, blobs, docs = seed(data, job_payload(data))
    process_sheet_version(job, blobs, docs, FAST)
    docs.set(f"orgs/{ORG}/projects/{PROJ}/sheets/{SET}-p0", {"confirmed": True})
    docs.set(
        PRE.replace(VER, "v2")[:-1],
        {"status": "queued", "progress": {"stage": "ingest", "pct": 0}, "artifacts": {}, "regions": []},
    )
    job2, blobs, docs = seed(
        None, job_payload(data, jobId="job2", sheetId=f"{SET}-p0", pageIndex=0, versionId="v2"), docs=docs, blobs=blobs
    )
    _patched(monkeypatch, seen)
    process_sheet_version(job2, blobs, docs, FAST)
    assert seen[-1]["floorsConfirmed"] is True


def test_links_bad_name_rejected(monkeypatch):
    _patched(monkeypatch, [], name="../evil.json.gz")
    data = legend_sheet_pdf()
    job, blobs, docs = seed(data, job_payload(data))
    with pytest.raises(IngestError):
        process_sheet_version(job, blobs, docs, FAST)
    assert not any(p.endswith("evil.json.gz") for p in blobs.blobs)
