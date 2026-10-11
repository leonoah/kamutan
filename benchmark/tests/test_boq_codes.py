from __future__ import annotations

import json
from pathlib import Path

from hypothesis import given, settings
from hypothesis import strategies as st

from kbench.boq_xls import reconstruct_codes
from kbench.validate import schema_errors

SCHEMA_DIR = Path(__file__).resolve().parents[1] / "schema"


def test_trailing_zero_restored_from_sequence():
    out = reconstruct_codes([4.08, 4.09, 4.1, 4.11])
    assert [c for c, _ in out] == ["4.08", "4.09", "4.10", "4.11"]
    assert "trailing_zero_restored" in out[2][1]
    assert out[0][1] == [] and out[3][1] == []


def test_zero_minor_is_ambiguous_and_gaps_flagged():
    out = reconstruct_codes([4.0, 4.01, 4.12, 4.14])
    assert out[0] == ("4.00", ["ambiguous_code"])
    assert any(f.startswith("gap_before:4.02") for f in out[2][1])
    assert "gap_before:4.13" in out[3][1]


def test_unconfirmed_single_decimal_is_ambiguous():
    # 4.2 directly after 4.09: "4.20" by format, but the sequence does not confirm it
    out = reconstruct_codes([4.08, 4.09, 4.2])
    assert out[2][0] == "4.20"
    assert "trailing_zero_restored" not in out[2][1]


@settings(max_examples=200, deadline=None)
@given(st.integers(1, 30), st.integers(2, 40))
def test_float_roundtrip_reconstructs_sequential_codes(major, n):
    codes = [f"{major}.{i:02d}" for i in range(1, n + 1)]
    raw = [float(c) for c in codes]  # what xls stores
    out = reconstruct_codes(raw)
    assert [c for c, _ in out] == codes
    assert all("ambiguous_code" not in f for _, f in out)


def test_schemas_are_valid_json_schema():
    from jsonschema import Draft202012Validator

    for p in SCHEMA_DIR.glob("*.schema.json"):
        Draft202012Validator.check_schema(json.loads(p.read_text(encoding="utf-8")))


def test_schema_rejects_numeric_codes_and_bad_enums():
    boq = {"schema_version": "1.0", "project_id": "x",
           "lines": [{"code": 4.1, "description": "d", "unit": "יחידה", "quantity": 1}]}
    assert schema_errors(boq, "boq_truth.schema.json")
    boq["lines"][0]["code"] = "4.10"
    assert not schema_errors(boq, "boq_truth.schema.json")
    disputes = {"schema_version": "1.0", "project_id": "x",
                "disputes": [{"id": "GT-D-001", "title": "t", "lines": ["4.00"], "status": "open"}]}
    assert schema_errors(disputes, "disputes.schema.json")
    disputes["disputes"][0]["status"] = "open — awaiting owner"
    assert not schema_errors(disputes, "disputes.schema.json")
