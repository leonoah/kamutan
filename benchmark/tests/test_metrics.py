"""End-to-end metric checks on the synthetic fixture; expected values computed by hand
(see tests/fixtures/make_fixtures.py for the layout)."""

from __future__ import annotations

import copy

import pytest

from kbench.data import Project, Sheet, load_project
from kbench.metrics import EvalConfig, evaluate
from conftest import make_box


@pytest.fixture
def result(fixture_dirs):
    t, p = fixture_dirs
    return evaluate([(load_project(t), load_project(p))])


def test_detection(result):
    det = result["detection"]
    assert (det["micro"]["tp"], det["micro"]["fp"], det["micro"]["fn"]) == (3, 2, 2)
    assert det["micro"]["f1"] == pytest.approx(0.6)
    pc = det["per_class"]
    assert pc["socket_single"]["precision"] == 1.0 and pc["socket_single"]["recall"] == 0.5
    assert pc["socket_single"]["f1"] == pytest.approx(2 / 3)
    assert pc["socket_double"]["f1"] == pytest.approx(2 / 3)
    assert pc["luminaire_ceiling"]["f1"] == 0.0
    assert pc["floor_tiling"]["f1"] == 1.0
    assert "socket_power" not in pc  # disputed line 4.03 excluded
    # wrong-class detection: FP in predicted class + FN in true class + confusion entry
    assert det["confusion"]["socket_single"]["socket_double"] == 1
    assert det["confusion"]["luminaire_ceiling"]["<missed>"] == 1
    assert det["confusion"]["<background>"]["luminaire_ceiling"] == 1
    assert det["macro"]["f1"] is None  # no class reaches 20 GT items


def test_items_correct(result):
    ic = result["items_correct"]
    assert (ic["n_correct"], ic["n_predicted"], ic["n_fn"]) == (3, 5, 1)
    assert ic["rate"] == pytest.approx(0.5)
    assert ic["error_reasons"] == {"boq_code": 1, "class": 1, "unmatched": 1}
    assert 0 < ic["wilson_lb95"] < 0.5


def test_boq_lines(result):
    b = result["boq"]
    lines = {r["code"]: r for r in b["lines"]}
    assert set(lines) == {"1.01", "4.00", "4.01", "5.02", "9.01"}  # no disputed, no draft
    assert lines["4.00"]["ae"] == 1 and lines["4.00"]["pe"] == pytest.approx(0.5)
    assert lines["4.01"]["pe"] == pytest.approx(1.0)
    assert lines["5.02"]["correct"] and lines["5.02"]["pe"] == pytest.approx(0.0125)
    assert not lines["1.01"]["correct"] and not lines["1.01"]["proposed"]
    assert b["exact_match"]["rate"] == pytest.approx(0.4)
    assert b["count_error"]["sum_ae_by_chapter"] == {"4": 2.0, "9": 0.0}
    assert b["count_error"]["n_lines_ae_gt_0"] == 2
    assert b["count_error"]["median_pe"] == pytest.approx(0.5)
    assert {e["code"] for e in b["extra_lines"]} == {"4.1", "7.77"}


def test_codes_are_text_not_numbers(fixture_dirs):
    t, p = fixture_dirs
    r = evaluate([(load_project(t), load_project(p))], EvalConfig(include_draft_lines=True))
    lines = {x["code"]: x for x in r["boq"]["lines"]}
    # prediction "4.1" must NOT satisfy truth "4.10"
    assert not lines["4.10"]["proposed"]
    assert "4.1" in {e["code"] for e in r["boq"]["extra_lines"]}


def test_numeric_code_rejected(tmp_path, fixture_dirs):
    import json
    import shutil

    t, _ = fixture_dirs
    d = tmp_path / "t"
    shutil.copytree(t, d)
    boq = json.loads((d / "boq_truth.json").read_text(encoding="utf-8"))
    boq["lines"][0]["code"] = 1.01
    (d / "boq_truth.json").write_text(json.dumps(boq), encoding="utf-8")
    with pytest.raises(ValueError, match="TEXT"):
        load_project(d)


def test_keep_disputed(fixture_dirs):
    t, p = fixture_dirs
    r = evaluate([(load_project(t), load_project(p))], EvalConfig(exclude_disputed=False))
    assert r["detection"]["per_class"]["socket_power"]["tp"] == 1
    # the line itself is gt_status=disputed (not confirmed), so it is still not a gating BOQ line
    assert "4.03" not in {x["code"] for x in r["boq"]["lines"]}
    assert r["items_correct"]["n_predicted"] == 6


def test_calibration_and_burden(result):
    cal = result["calibration"]
    assert cal["ece"] == pytest.approx(0.25)
    g = cal["green"]
    assert (g["n"], g["correct"], g["p_green"]) == (2, 2, 1.0)
    assert g["min_n_at_zero_errors"] == 189
    assert g["sufficient_sample"] is False and g["pass"] is False  # minimum-sample rule
    assert g["green_in_ineligible_classes"] == ["socket_double", "socket_single"]
    rb = result["review_burden"]
    assert rb["burden"] == pytest.approx(0.6)
    assert rb["yield_of_review"] == 1.0
    assert rb["risk_auc"] == 1.0
    assert result["ceiling_violations"] == []


def _project(meta, feats):
    sh = Sheet("S1", meta, feats)
    return Project(root=None, sheets={"S1": sh}, boq={"project_id": "x", "lines": []})


def test_ceiling_rules():
    truth = _project({"input_type": "raster", "scale": 50}, [make_box("g1", 10, 10)])
    pred = _project({"input_type": "raster"}, [make_box("p1", 10, 10, confidence=0.99, level="green")])
    r = evaluate([(truth, pred)])
    assert [v["rule"] for v in r["ceiling_violations"]] == ["raster_sheet_green"]

    area_g = make_box("g2", 0, 0, 40, 40, cls="floor_tiling", kind="area")
    area_p = make_box("p2", 0, 0, 40, 40, cls="floor_tiling", kind="area", confidence=0.7, level="yellow")
    truth = _project({"input_type": "vector", "scale": 50, "scale_conflict": True}, [area_g])
    pred = _project({}, [area_p])
    r = evaluate([(truth, pred)])
    assert [v["rule"] for v in r["ceiling_violations"]] == ["scale_conflict_area_not_red"]


def test_green_pass_with_enough_samples():
    n = 200
    g = [make_box(f"g{i}", (i % 20) * 10, (i // 20) * 10) for i in range(n)]
    p = [make_box(f"p{i}", (i % 20) * 10, (i // 20) * 10, confidence=0.99, level="green") for i in range(n)]
    r = evaluate([(_project({"scale": 50}, g), _project({}, p))])
    gr = r["calibration"]["green"]
    assert gr["sufficient_sample"] and gr["pass"]
    assert gr["eligible_classes"] == ["socket_single"]
    assert gr["green_in_ineligible_classes"] == []
    assert r["calibration"]["green"]["by_domain"]["electrical"]["checked"] is True


def test_area_item_tolerances():
    # flooring 2%: 40 x 40.6 = +1.5% ok ; cladding 3% ; flooring +2.5% fails
    g = make_box("g", 0, 0, 40, 40, cls="floor_tiling", kind="area")
    ok = make_box("p", 0, 0, 40, 40.6, cls="floor_tiling", kind="area")
    bad = make_box("p", 0, 0, 40, 41.0, cls="floor_tiling", kind="area")
    r_ok = evaluate([(_project({"scale": 50}, [g]), _project({}, [ok]))])
    r_bad = evaluate([(_project({"scale": 50}, [g]), _project({}, [bad]))])
    assert r_ok["items_correct"]["rate"] == 1.0
    assert r_bad["items_correct"]["error_reasons"] == {"quantity": 1}
    gc = copy.deepcopy(g)
    gc.cls, gc.props["class"] = "wall_cladding", "wall_cladding"
    pc = make_box("p", 0, 0, 40, 41.0, cls="wall_cladding", kind="area")
    assert evaluate([(_project({"scale": 50}, [gc]), _project({}, [pc]))])["items_correct"]["rate"] == 1.0
