"""Sprint 4 (Worker-A): the understand stage integrates Worker-B's fixtures (feature-checked) — fixture records become
detections (contract-valid, floor rule + lifecycle applied), supersede the Sprint-2 plumbing text anchors, and the
extended records are written to ``fixtures.json.gz``."""

from __future__ import annotations

import gzip
import json
from typing import Any

import pytest

from kamutan_drawing.pipeline import understand as U
from kamutan_drawing.pipeline.understand import understand
from kamutan_drawing.symbols.detect import Detection

from .pipeline_util import validate
from .synth_legend import hebrew_font, legend_sheet_pdf
from .test_legend_symbols import _load

pytestmark = pytest.mark.skipif(hebrew_font() is None, reason="needs a TTF font with Hebrew glyphs (DejaVu Sans)")

REGIONS = [
    {
        "id": "r0",
        "floor": "ground",
        "polygonMm": [{"x": 0, "y": 0}, {"x": 420, "y": 0}, {"x": 420, "y": 297}, {"x": 0, "y": 297}],
        "scaleDenominator": 50,
    }
]


class FakeFixture:
    def __init__(self, i: int, cls: str, x: float, y: float, level: str = "green", score: float = 0.9) -> None:
        self.i, self.cls, self.x, self.y, self.level, self.score = i, cls, x, y, level, score

    def to_json(self, *, extended: bool = False) -> dict[str, Any]:
        d = {
            "id": f"d_fx_{self.i}",
            "class": self.cls,
            "legendEntryId": None,
            "centerMm": {"x": self.x, "y": self.y},
            "bboxMm": {"x": self.x - 5, "y": self.y - 4, "w": 10, "h": 8},
            "angleDeg": -90.0,
            "score": self.score,
            "level": self.level,
            "reasons": [] if self.level == "green" else ["זוהה מצורה בלבד"],
            "roomId": None,
            "floor": "ground",
            "lifecycle": "unknown",
            "supply": None,
            "annotations": [],
            "clusterId": None,
        }
        if extended:
            d.update({"source": "shape", "attachedTo": None, "label": None, "leaderMm": []})
        return d


@pytest.fixture(scope="module")
def sheet(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("fx")
    src, vs, spans = _load(legend_sheet_pdf(), tmp)
    yield vs, spans
    src.close()


def _gz(p):
    return json.loads(gzip.decompress(p.read_bytes()))


def test_fixtures_become_detections_and_supersede_text_anchors(sheet, tmp_path, monkeypatch):
    vs, spans = sheet
    seen: dict[str, Any] = {}

    def fake_detect(prims, text, rooms, discipline, **kw):
        seen.update(discipline=discipline, kw=kw, rooms=rooms)
        return [FakeFixture(0, "fixture_wc_concealed", 60, 60), FakeFixture(1, "faucet_wall", 70, 60, "yellow", 0.6)]

    real_detect = U.detect_symbols

    def detect_with_anchor(*a, **kw):
        res = real_detect(*a, **kw)
        res.detections.append(
            Detection(cls="faucet_wall", center=(80.0, 80.0), bbox=(79, 79, 81, 81), source="text", id="d_99", level="yellow")
        )
        return res

    monkeypatch.setattr(U, "fixtures_detect", fake_detect)
    monkeypatch.setattr(U, "HAVE_FIXTURES", True)
    monkeypatch.setattr(U, "detect_symbols", detect_with_anchor)
    out = tmp_path / "out"
    res = understand(
        vs, spans, sheet_id="s1-p0", discipline="plumbing", scale_den=50, regions=REGIONS, text_paths=set(), out_dir=out
    )
    assert seen["discipline"] == "plumbing" and seen["kw"]["scale_denominator"] == 50 and seen["kw"]["regions"] == REGIONS
    assert isinstance(seen["kw"]["detections"], list)
    det = _gz(out / "detections.json.gz")
    validate("DetectionsArtifact", det)
    by_id = {d["id"]: d for d in det["detections"]}
    assert "d_99" not in by_id  # the Sprint-2 text anchor is superseded
    wc, fau = by_id["d_fx_0"], by_id["d_fx_1"]
    assert wc["class"] == "fixture_wc_concealed" and wc["level"] == "green" and wc["angleDeg"] == 270
    assert fau["level"] == "yellow" and fau["reasons"] == ["זוהה מצורה בלבד"]
    assert wc["lifecycle"] == "new"  # plumbing plan default, like the symbols
    assert res["fixtureStats"] == {"total": 2, "byClass": {"faucet_wall": 1, "fixture_wc_concealed": 1}}
    assert res["fixturesFile"] == "fixtures.json.gz" and "fixtures.json.gz" not in {f["path"] for f in res["files"]}
    fx = _gz(out / "fixtures.json.gz")
    assert [f["id"] for f in fx["fixtures"]] == ["d_fx_0", "d_fx_1"] and fx["fixtures"][0]["lifecycle"] == "new"
    assert res["detectionStats"]["byClass"]["fixture_wc_concealed"] == 1


def test_floor_rule_demotes_fixtures_like_symbols(sheet, tmp_path, monkeypatch):
    vs, spans = sheet
    monkeypatch.setattr(U, "fixtures_detect", lambda *a, **k: [FakeFixture(0, "fixture_bath", 200, 100)])
    monkeypatch.setattr(U, "HAVE_FIXTURES", True)
    two = [
        {**REGIONS[0], "id": "r0", "polygonMm": [{"x": 0, "y": 0}, {"x": 210, "y": 0}, {"x": 210, "y": 297}, {"x": 0, "y": 297}]},
        {**REGIONS[0], "id": "r1", "floor": "first",
         "polygonMm": [{"x": 210, "y": 0}, {"x": 420, "y": 0}, {"x": 420, "y": 297}, {"x": 210, "y": 297}]},
    ]  # fmt: skip
    out = tmp_path / "o"
    understand(vs, spans, sheet_id="s", discipline="architecture", scale_den=50, regions=two, text_paths=set(), out_dir=out)
    d = _gz(out / "detections.json.gz")["detections"][0]
    assert d["level"] == "yellow" and "קומה לא ודאית" in d["reasons"]
    out2 = tmp_path / "o2"
    understand(vs, spans, sheet_id="s", discipline="architecture", scale_den=50, regions=two, text_paths=set(), out_dir=out2,
               floors_confirmed=True)  # fmt: skip
    assert _gz(out2 / "detections.json.gz")["detections"][0]["level"] == "green"


def test_fixture_failure_or_off_keeps_the_rest(sheet, tmp_path, monkeypatch):
    vs, spans = sheet

    def boom(*a, **k):
        raise RuntimeError("bad sheet")

    monkeypatch.setattr(U, "fixtures_detect", boom)
    monkeypatch.setattr(U, "HAVE_FIXTURES", True)
    res = understand(vs, spans, sheet_id="s", discipline="electrical", scale_den=50, regions=REGIONS, text_paths=set(),
                     out_dir=tmp_path / "a")  # fmt: skip
    assert res["detectionStats"]["total"] > 0 and "fixturesFile" not in res
    called = []
    monkeypatch.setattr(U, "fixtures_detect", lambda *a, **k: called.append(1) or [])
    understand(vs, spans, sheet_id="s", discipline="electrical", scale_den=50, regions=REGIONS, text_paths=set(), fixtures=False)
    understand(vs, spans, sheet_id="s", discipline="lighting", scale_den=50, regions=REGIONS, text_paths=set())
    assert called == []  # off, and lighting sheets never run fixtures


def test_real_fixtures_module_runs_on_synthetic_sheet(sheet):
    if not U.HAVE_FIXTURES:
        pytest.skip("fixtures package not present")
    vs, spans = sheet
    res = understand(vs, spans, sheet_id="s", discipline="plumbing", scale_den=50, regions=REGIONS, text_paths=set())
    assert res["timings"]["fixtures"] >= 0.0
