from __future__ import annotations

import copy
import json

import pytest

from kbench.cli import main as cli_main
from kbench.regression import Thresholds, compare


def _metrics(**over):
    m = {
        "gt_version": "gt-v1.0",
        "detection": {"micro": {"f1": 0.970}, "per_class": {"socket_single": {"f1": 0.95}, "switch_single": {"f1": 0.96}}},
        "items_correct": {"rate": 0.95},
        "calibration": {"ece": 0.02, "green": {"p_green": 0.985}},
        "review_burden": {"burden": 0.30},
        "boq": {"lines": [{"project_id": "noah", "code": "4.10", "correct": True},
                          {"project_id": "noah", "code": "4.01", "correct": False}]},
        "run": {"failures": [], "timing": {"p95_sheet_seconds": 10.0}},
        "ceiling_violations": [],
    }
    for path, v in over.items():
        d = m
        keys = path.split("__")
        for k in keys[:-1]:
            d = d[k]
        d[keys[-1]] = v
    return m


TH = Thresholds(core_classes=["socket_single", "switch_single"])


def _status(checks, name):
    return next(c.status for c in checks if c.name == name)


def test_identical_passes():
    code, checks = compare(_metrics(), _metrics(), TH)
    assert code == 0
    assert all(c.status in ("pass", "skip") for c in checks)


@pytest.mark.parametrize("cur,expected", [(0.966, 0), (0.9649, 1)])
def test_micro_f1_threshold(cur, expected):
    code, checks = compare(_metrics(detection__micro__f1=cur), _metrics(), TH)
    assert code == expected


def test_core_class_threshold():
    cur = _metrics()
    cur["detection"]["per_class"]["socket_single"]["f1"] = 0.936  # drop 1.4 pt -> pass
    assert compare(cur, _metrics(), TH)[0] == 0
    cur["detection"]["per_class"]["socket_single"]["f1"] = 0.934  # drop 1.6 pt -> block
    code, checks = compare(cur, _metrics(), TH)
    assert code == 1 and _status(checks, "f1[socket_single]") == "block"
    del cur["detection"]["per_class"]["switch_single"]  # class vanished -> treated as 0
    assert _status(compare(cur, _metrics(), TH)[1], "f1[switch_single]") == "block"


def test_p_green_rules():
    # any drop below 0.98 blocks
    assert compare(_metrics(calibration__green={"p_green": 0.979}), _metrics(), TH)[0] == 1
    # small drop staying above 0.98 passes
    assert compare(_metrics(calibration__green={"p_green": 0.982}), _metrics(), TH)[0] == 0
    # drop > 0.5 pt blocks even above 0.98
    base = _metrics(calibration__green={"p_green": 0.995})
    assert compare(_metrics(calibration__green={"p_green": 0.989}), base, TH)[0] == 1


def test_ece_and_items_correct():
    assert compare(_metrics(calibration__ece=0.031), _metrics(), TH)[0] == 1
    assert compare(_metrics(calibration__ece=0.029), _metrics(), TH)[0] == 0
    assert compare(_metrics(items_correct__rate=0.944), _metrics(), TH)[0] == 1


def test_smoke_line_regression():
    cur = _metrics()
    cur["boq"]["lines"][0]["correct"] = False
    code, checks = compare(cur, _metrics(), TH)
    assert code == 1 and "noah:4.10" in next(c.detail for c in checks if c.name == "smoke_lines")
    # a line that was already wrong may stay wrong
    cur = _metrics()
    assert compare(cur, _metrics(), TH)[0] == 0


def test_burden_warn_vs_block():
    code, checks = compare(_metrics(review_burden__burden=0.34), _metrics(), TH)
    assert code == 1 and _status(checks, "burden") == "block"
    cur = _metrics(review_burden__burden=0.34, calibration__green={"p_green": 0.99})
    code, checks = compare(cur, _metrics(), TH)
    assert code == 0 and _status(checks, "burden") == "warn"


def test_timing_failures_ceiling_and_version():
    assert compare(_metrics(run={"failures": [], "timing": {"p95_sheet_seconds": 12.5}}), _metrics(), TH)[0] == 1
    assert compare(_metrics(run={"failures": ["sheet X timeout"], "timing": {}}), _metrics(), TH)[0] == 1
    assert compare(_metrics(ceiling_violations=[{"rule": "raster_sheet_green"}]), _metrics(), TH)[0] == 1
    assert compare(_metrics(gt_version="gt-v1.1"), _metrics(), TH)[0] == 2


def test_cli_exit_codes(tmp_path, fixture_dirs):
    t, p = fixture_dirs
    out = tmp_path / "m.json"
    assert cli_main(["eval", "--truth", str(t), "--pred", str(p), "--out", str(out),
                     "--report", str(tmp_path / "r.md")]) == 0
    m = json.loads(out.read_text(encoding="utf-8"))
    assert (tmp_path / "r.md").read_text(encoding="utf-8").startswith("# kbench report")
    base = tmp_path / "base.json"
    base.write_text(json.dumps(m), encoding="utf-8")
    assert cli_main(["compare", "--current", str(out), "--baseline", str(base)]) == 0
    worse = copy.deepcopy(m)
    worse["detection"]["micro"]["f1"] -= 0.01
    wp = tmp_path / "worse.json"
    wp.write_text(json.dumps(worse), encoding="utf-8")
    gate = tmp_path / "gate.json"
    assert cli_main(["compare", "--current", str(wp), "--baseline", str(base), "--out", str(gate)]) == 1
    assert json.loads(gate.read_text(encoding="utf-8"))["result"] == "regression"
    assert cli_main(["validate", str(t)]) == 0
