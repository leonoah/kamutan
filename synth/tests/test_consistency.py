"""GT consistency: every drawn symbol is in the GT and vice versa; BOQ truth == GT counts; PDF ink; DXF INSERTs."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import COMBOS, composed

from kamutan_synth.check import check_dataset, check_dxf, check_pdf_ink, check_result
from kamutan_synth.generate import Job, run_job
from kamutan_synth.render_dxf import render_dxf
from kamutan_synth.render_pdf import render_pdf


@pytest.mark.parametrize(("difficulty", "discipline"), COMBOS)
@pytest.mark.parametrize("seed", [11, 12])
def test_scene_gt_bijection(seed: int, difficulty: str, discipline: str) -> None:
    res = composed(seed, COMBOS.index((difficulty, discipline)), difficulty, discipline)
    assert check_result(res) == []
    symbols = [f for f in res.gt["features"] if f["properties"]["kind"] == "symbol"]
    assert symbols, "a sheet without symbols is useless as a benchmark"
    # every drawn discipline symbol belongs to the sheet's discipline
    domains = set(res.gt["kamutan"]["disciplines"])
    assert {f["properties"]["domain"] for f in symbols} <= domains


@pytest.mark.parametrize(("difficulty", "discipline"), COMBOS[::2])
def test_pdf_ink_and_dxf_inserts(tmp_path: Path, difficulty: str, discipline: str) -> None:
    res = composed(21, COMBOS.index((difficulty, discipline)), difficulty, discipline)
    pdf = tmp_path / "s.pdf"
    render_pdf(res.scene, pdf)
    assert check_pdf_ink(pdf, res.gt) == []
    blocks = render_dxf(res.scene, tmp_path / "s.dxf", int(res.gt["kamutan"]["scale"]), res.spec.sheet_id)
    for f in res.gt["features"]:
        if f["id"] in blocks:
            f["properties"]["dxf_block"] = blocks[f["id"]]
    assert check_dxf(tmp_path / "s.dxf", res.gt) == []


def test_symbols_do_not_overlap_each_other() -> None:
    for i, (difficulty, discipline) in enumerate(COMBOS):
        if discipline == "plumbing":
            continue  # water points sit next to fixtures by design; pipes cross them
        res = composed(31, i, difficulty, discipline)
        boxes = [f["properties"]["bbox_mm"] for f in res.gt["features"] if f["properties"]["kind"] == "symbol"]
        for a in range(len(boxes)):
            for b in range(a + 1, len(boxes)):
                A, B = boxes[a], boxes[b]
                inter = max(0.0, min(A[2], B[2]) - max(A[0], B[0])) * max(0.0, min(A[3], B[3]) - max(A[1], B[1]))
                assert inter < 1e-6, (res.spec.sheet_id, a, b)


def test_boq_lines_follow_gt() -> None:
    res = composed(41, 0, "hard", "electrical_lighting")
    new = [
        f["properties"]
        for f in res.gt["features"]
        if f["properties"]["kind"] == "symbol" and f["properties"]["lifecycle"] == "new"
    ]
    total = sum(p["qty"] for p in new)
    counted = sum(ln["quantity"] for ln in res.boq["lines"] if ln["category"] == "count" and ln["code"] != "4.90")
    assert counted == total
    codes = [ln["code"] for ln in res.boq["lines"]]
    assert all(isinstance(c, str) for c in codes)
    assert codes == sorted(codes, key=lambda c: [int(x) for x in c.split(".")])


def test_dataset_check_on_generated_sheets(tmp_path: Path) -> None:
    rows = [
        run_job(Job(5, i, d, c, str(tmp_path), 1, True, False))
        for i, (d, c) in enumerate([("easy", "plumbing"), ("hard", "lighting")])
    ]
    for r in rows:
        r.pop("_timing")
    (tmp_path / "manifest.json").write_text(json.dumps({"files": rows}), encoding="utf-8")
    assert check_dataset(tmp_path) == []
