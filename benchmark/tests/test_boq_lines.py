"""BOQ-line evaluation of the worker's boq-lines.json — synthetic data only."""

from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Any

import pytest

from kbench.boq_lines import evaluate_boq_lines, in_scope, load_pred_lines, render_boq_markdown
from kbench.cli import main
from kbench.data import Project


def _truth() -> Project:
    lines = [
        {"code": "4.09", "description": "a", "unit": "יחידה", "quantity": 16.0, "gt_status": "draft"},
        {"code": "4.10", "description": "b", "unit": "יחידה", "quantity": 2.0, "gt_status": "draft"},
        {
            "code": "4.11",
            "description": "c",
            "unit": "יחידה",
            "quantity": 5.0,
            "gt_status": "draft",
            "breakdown": {"ground": 2.0, "first": 3.0},
        },
        {
            "code": "4.00",
            "description": "d",
            "unit": "יחידה",
            "quantity": 23.0,
            "gt_status": "disputed",
            "dispute_id": "GT-D-001",
        },
        {"code": "9.01", "description": "e", "unit": "יחידה", "quantity": 43.0, "gt_status": "draft"},
        {"code": "9.03", "description": "f", "unit": "יחידה", "quantity": 1.0, "gt_status": "draft"},
        {"code": "5.01", "description": "g", "unit": 'מ"ר', "quantity": 70.0, "gt_status": "draft"},
    ]
    return Project(
        root=None,
        boq={"lines": lines},
        disputes={"disputes": [{"id": "GT-D-001", "lines": ["4.00"], "status": "open — awaiting owner"}]},
    )


def _pred() -> list[dict[str, Any]]:
    return [
        {"id": "l1", "code": "4.09", "qty": 17, "unit": "יחידה", "level": "green", "byFloor": {"ground": 7, "first": 10}},
        {"id": "l2", "code": "4.1", "qty": 2, "unit": "יחידה", "level": "green"},  # TEXT code mismatch -> 4.10 not proposed
        {"id": "l3", "code": "4.11", "qty": 5, "unit": "יחידה", "level": "yellow", "byFloor": {"ground": 3, "first": 2}},
        {"id": "l4", "code": "4.00", "qty": 22, "unit": "יחידה", "level": "green"},
        {"id": "l5", "code": "9.01", "qty": 40, "unit": "יחידה", "level": "red", "qtyOverride": 43},
        {"id": "l6", "code": 4.2, "qty": 1, "unit": "יחידה", "level": "red"},
    ]


def test_scope() -> None:
    assert in_scope("4.10", ("4.", "9.01")) and in_scope("9.01", ("4.", "9.01"))
    assert not in_scope("9.03", ("4.", "9.01")) and not in_scope("40.1", ("4.",))


def test_line_metrics() -> None:
    b = evaluate_boq_lines(_truth(), _pred())["boq_lines"]
    rows = {r["code"]: r for r in b["lines"]}
    assert set(rows) == {"4.09", "4.10", "4.11", "4.00", "9.01"}
    assert rows["4.09"]["ae"] == 1 and rows["4.09"]["pe"] == pytest.approx(1 / 16)
    assert rows["4.10"]["proposed"] is False and rows["4.10"]["pred"] == 0  # "4.1" != "4.10"
    assert rows["9.01"]["pred"] == 40  # qtyOverride ignored (before review)
    g = b["gated"]
    assert g["n_lines"] == 4 and g["exact_match"]["k"] == 1  # only 4.11
    assert g["sum_ae"] == 1 + 2 + 0 + 3
    assert g["not_proposed"] == ["4.10"]
    assert b["disputed"]["n_lines"] == 1 and b["disputed"]["sum_ae"] == 1
    extra = {e["code"] for e in b["extra_lines"]}
    assert extra == {"4.1", "4.2"}
    assert any("4.2" in e for e in b["format_errors"])
    # green: 4.09 (wrong), 4.1 extra (wrong); 4.00 disputed -> excluded
    assert b["green_line_precision"]["k"] == 0 and b["green_line_precision"]["n"] == 2
    assert b["exact_by_level"]["yellow"]["k"] == 1
    fl = {(f["code"], f["floor"]): f for f in b["by_floor"]}
    assert fl[("4.11", "ground")]["pred"] == 3 and not fl[("4.11", "ground")]["exact"]
    assert b["by_floor_summary"]["n"] == 2 and b["by_floor_summary"]["k"] == 0
    assert "4.10" in render_boq_markdown({"boq_lines": b})


def test_duplicate_code_lines_are_summed() -> None:
    pred = [{"code": "4.09", "qty": 10, "level": "green"}, {"code": "4.09", "qty": 6, "level": "yellow"}]
    b = evaluate_boq_lines(_truth(), pred)["boq_lines"]
    r = next(x for x in b["lines"] if x["code"] == "4.09")
    assert r["pred"] == 16 and r["exact"] and r["n_pred_lines"] == 2 and r["level"] == ["green", "yellow"]


def test_load_formats(tmp_path: Path) -> None:
    p1 = tmp_path / "a.json"
    p1.write_text(json.dumps(_pred()), encoding="utf-8")
    p2 = tmp_path / "b.json.gz"
    with gzip.open(p2, "wt", encoding="utf-8") as f:
        json.dump({"lines": _pred()}, f)
    assert len(load_pred_lines(p1)) == len(load_pred_lines(p2)) == 6
    p3 = tmp_path / "c.json"
    p3.write_text(json.dumps({"nope": 1}), encoding="utf-8")
    with pytest.raises(ValueError):
        load_pred_lines(p3)


def test_cli_eval_boq(tmp_path: Path) -> None:
    t = tmp_path / "t"
    t.mkdir()
    pr = _truth()
    (t / "boq_truth.json").write_text(json.dumps(pr.boq), encoding="utf-8")
    (t / "disputes.json").write_text(
        json.dumps({"schema_version": "1.0", "project_id": "x", **(pr.disputes or {})}), encoding="utf-8"
    )
    pl = tmp_path / "boq-lines.json"
    pl.write_text(json.dumps(_pred()), encoding="utf-8")
    out = tmp_path / "m.json"
    assert (
        main(["eval-boq", "--truth", str(t), "--pred-lines", str(pl), "--out", str(out), "--report", str(tmp_path / "m.md")]) == 0
    )
    m = json.loads(out.read_text())
    assert m["boq_lines"]["gated"]["n_lines"] == 4
    assert main(["eval-boq", "--truth", str(t), "--pred-lines", str(pl), "--scope", "9.", "--out", str(out)]) == 0
    assert json.loads(out.read_text())["boq_lines"]["gated"]["n_lines"] == 2
