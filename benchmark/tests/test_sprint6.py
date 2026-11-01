"""Sprint 6: BOQ coverage over every chapter (kbench.coverage) — synthetic data only."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from kbench.cli import main
from kbench.coverage import (
    STATUSES,
    classify_line,
    evaluate_boq_coverage,
    load_computability,
    norm_unit,
    render_coverage_markdown,
    unit_class,
)
from kbench.data import Project

M2, M1, U, LS = 'מ"ר', 'מ"א', "יחידה", "קומפלט"


def _truth() -> Project:
    lines = [
        {"code": "1.01", "description": "demo", "unit": LS, "quantity": 1.0, "category": "lump_sum"},
        {"code": "2.03", "description": "block", "unit": M2, "quantity": 2.0, "category": "area"},
        {"code": "4.06", "description": "box6", "unit": U, "quantity": 4.0},
        {"code": "4.21", "description": "3ph", "unit": U, "quantity": 3.0, "gt_status": "disputed", "dispute_id": "GT-D-001"},
        {"code": "4.28", "description": "panel", "unit": U, "quantity": 1.0},
        {"code": "5.07", "description": "clad", "unit": M2, "quantity": 1.2, "category": "cladding"},
        {"code": "7.02", "description": "valance", "unit": M1, "quantity": 4.3, "category": "length"},
        {"code": "7.05", "description": "curtain", "unit": M1, "quantity": 7.0, "category": "length"},
        {"code": "8.03", "description": "paint", "unit": LS, "quantity": 1.0, "category": "lump_sum"},
        {"code": "9.03", "description": "vent", "unit": U, "quantity": 1.0},
    ]
    return Project(
        root=None,
        boq={"lines": lines},
        disputes={"disputes": [{"id": "GT-D-001", "lines": ["4.21"], "status": "open — awaiting owner"}]},
    )


def _pred() -> list[dict[str, Any]]:
    return [
        {"code": "1.01", "qty": 1, "unit": LS, "level": "yellow", "origin": "suggested", "needsInput": False},  # exact
        {"code": "2.03", "qty": 1.6, "unit": "מ״ר", "level": "yellow", "origin": "geometry"},  # wrong qty (20%)
        {"code": "4.06", "qty": 3, "unit": "יח'", "level": "yellow", "origin": "text"},
        {"code": "4.06", "qty": 1, "unit": U, "level": "yellow", "origin": "detected"},  # pooled -> 4 exact
        {"code": "4.21", "qty": 2, "unit": U, "level": "yellow"},  # disputed, wrong qty
        {"code": "5.07", "qty": None, "unit": M2, "level": "red", "origin": "suggested", "needsInput": True,
         "quickAction": {"kind": "measure_area", "sheetId": "s1"}},  # suggested, right unit
        {"code": "7.02", "qty": 4.25, "unit": M1, "level": "yellow", "origin": "geometry"},  # PE 1.2% -> within
        {"code": "7.05", "qty": 7, "unit": U, "level": "yellow", "origin": "suggested", "needsInput": True},  # wrong unit
        {"code": "8.03", "qty": 1, "unit": LS, "level": "green", "origin": "suggested"},  # exact, but green suggested
        {"code": "9.99", "qty": 1, "unit": U, "level": "yellow"},  # extra
    ]  # fmt: skip


def test_units_normalise() -> None:
    assert norm_unit("מ״ר") == 'מ"ר' and unit_class("מ״ר") == unit_class('מ"ר') == "area"
    assert unit_class("יח'") == unit_class("יחידה") == "count"
    assert unit_class("קומפלט") == "lump_sum" and unit_class("xyz").startswith("other:")


def test_statuses_per_line() -> None:
    c = evaluate_boq_coverage(_truth(), _pred())["coverage"]
    s = {r["code"]: r["status"] for r in c["lines"]}
    assert s == {
        "1.01": "exact",
        "2.03": "wrong_qty",
        "4.06": "exact",
        "4.21": "wrong_qty",
        "4.28": "missing",
        "5.07": "suggested_right_unit",
        "7.02": "within_tol",
        "7.05": "suggested_wrong_unit",
        "8.03": "exact",
        "9.03": "missing",
    }
    rows = {r["code"]: r for r in c["lines"]}
    assert rows["4.06"]["pred"] == 4 and rows["4.06"]["n_pred_lines"] == 2 and rows["4.06"]["origins"] == ["detected", "text"]
    assert rows["5.07"]["pred"] is None and rows["5.07"]["quick_action"] == ["measure_area"]


def test_summaries_and_disputed_separately() -> None:
    c = evaluate_boq_coverage(_truth(), _pred(), computability={"4.28": "not_on_drawings", "7.02": "computable"})["coverage"]
    a, g, d = c["all"], c["gated"], c["disputed"]
    assert a["n_lines"] == 10 and a["present"]["k"] == 8 and a["missing"]["k"] == 2
    assert a["exact"]["k"] == 3 and a["exact_or_within_tol"]["k"] == 4 and a["suggested_right_unit"] == 1
    assert a["missing_codes"] == ["4.28", "9.03"]
    assert a["ok_from_suggested"] == 2  # 1.01 + 8.03 (estimator qty), not computed from the drawing
    assert g["n_lines"] == 9 and d["n_lines"] == 1 and d["status_counts"]["wrong_qty"] == 1
    assert sum(a["status_counts"].values()) == 10 and set(a["status_counts"]) == set(STATUSES)
    assert c["by_chapter"]["4"]["n_lines"] == 3 and c["by_chapter"]["4"]["missing_codes"] == ["4.28"]
    assert c["by_computability"]["not_on_drawings"]["missing"]["k"] == 1
    assert c["by_computability"]["unknown"]["n_lines"] == 8
    assert c["checks"]["suggested_lines_green"] == ["8.03"]
    assert c["checks"]["needs_input_without_quick_action"] == ["7.05"]
    assert c["checks"]["extra_codes"] == ["9.99"]
    t = c["target"]
    assert t["exact_or_within_tol"] == 4 and not t["present_all"] and not t["pass"]
    md = render_coverage_markdown({"coverage": c})
    assert "suggested_right_unit" in md and "FAIL" in md and "4.28" in md


def test_target_pass() -> None:
    pr = _truth()
    pred = [{"code": ln["code"], "qty": ln["quantity"], "unit": ln["unit"], "level": "yellow"} for ln in pr.boq_lines()]
    c = evaluate_boq_coverage(pr, pred, target_ok=10)["coverage"]
    assert c["target"]["pass"] and c["all"]["exact"]["k"] == 10
    assert not evaluate_boq_coverage(pr, pred, target_ok=11)["coverage"]["target"]["pass"]


def test_qty_override_is_ignored_and_codes_are_text() -> None:
    pr = _truth()
    pred = [{"code": "4.06", "qty": 3, "qtyOverride": 4, "unit": U}, {"code": "7.1", "qty": 4.3, "unit": M1}]
    rows = {r["code"]: r for r in evaluate_boq_coverage(pr, pred)["coverage"]["lines"]}
    assert rows["4.06"]["status"] == "wrong_qty" and rows["7.02"]["status"] == "missing"


def test_load_computability(tmp_path: Path) -> None:
    p = tmp_path / "s6.json"
    p.write_text(
        json.dumps(
            {
                "lines": [{"code": "4.28", "computability": "not_on_drawings"}],
                "coverage_reference": [
                    {"code": "4.28", "computability": "partial"},
                    {"code": "3.01", "computability": "computable"},
                ],
            }
        ),
        encoding="utf-8",
    )
    assert load_computability(p) == {"4.28": "partial", "3.01": "computable"}  # coverage_reference wins (read last)
    assert load_computability(tmp_path / "missing.json") == {} and load_computability(None) == {}


def test_cli_eval_boq_coverage(tmp_path: Path) -> None:
    t = tmp_path / "t"
    t.mkdir()
    pr = _truth()
    (t / "boq_truth.json").write_text(json.dumps(pr.boq), encoding="utf-8")
    (t / "disputes.json").write_text(json.dumps({"schema_version": "1.0", "project_id": "x", **(pr.disputes or {})}))
    (t / "s6_lines.json").write_text(json.dumps({"coverage_reference": [{"code": "9.03", "computability": "partial"}]}))
    pl = tmp_path / "boq-lines.json"
    pl.write_text(json.dumps({"lines": _pred()}), encoding="utf-8")
    out, rep = tmp_path / "m.json", tmp_path / "m.md"
    assert (
        main(["eval-boq", "--truth", str(t), "--pred-lines", str(pl), "--scope", "all", "--out", str(out), "--report", str(rep)])
        == 0
    )
    m = json.loads(out.read_text())
    assert m["boq_lines"]["scope"] == ["1.", "2.", "4.", "5.", "7.", "8.", "9."]
    assert m["boq_lines"]["gated"]["n_lines"] == 9
    assert m["coverage"]["all"]["n_lines"] == 10
    assert next(r for r in m["coverage"]["lines"] if r["code"] == "9.03")["computability"] == "partial"
    assert "## Coverage" in rep.read_text(encoding="utf-8")


def _line(q: float, unit: str) -> dict[str, Any]:
    return {"code": "x", "unit": unit, "quantity": q}


@settings(max_examples=150, deadline=None)
@given(
    q=st.floats(min_value=0.0, max_value=500.0, allow_nan=False),
    preds=st.lists(
        st.tuples(
            st.one_of(st.none(), st.floats(min_value=0.0, max_value=500.0, allow_nan=False)),
            st.sampled_from([U, M2, M1, LS, "יח'"]),
            st.booleans(),
        ),
        max_size=3,
    ),
    unit=st.sampled_from([U, M2, M1, LS]),
)
def test_status_invariants(q: float, preds: list[tuple[float | None, str, bool]], unit: str) -> None:
    pls = [{"code": "x", "qty": a, "unit": u, "origin": "suggested" if s else "detected"} for a, u, s in preds]
    r = classify_line(_line(q, unit), pls)
    assert r["status"] in STATUSES
    assert (r["status"] == "missing") == (not pls)
    if r["status"] == "exact":
        assert r["unit_ok"] and r["ae"] is not None and r["ae"] < 1e-9
    if r["status"] == "within_tol":
        assert unit in (M2, M1) and r["pe"] <= r["tolerance_pe"] + 1e-9
    if r["status"].startswith("suggested"):
        assert all(p["origin"] == "suggested" for p in pls)
    if r["ok"]:
        assert r["present"] and r["unit_ok"]


@pytest.mark.parametrize(("qty", "status"), [(57.0, "exact"), (58.5, "within_tol"), (59.0, "wrong_qty")])
def test_cladding_tolerance(qty: float, status: str) -> None:
    tl = {"code": "5.01", "unit": M2, "quantity": 57.0, "category": "cladding"}  # 3%
    assert classify_line(tl, [{"code": "5.01", "qty": qty, "unit": M2}])["status"] == status
