"""Build the DRAFT ground truth for the sample project "noah" (pre-annotation).

Reads   $KAMUTAN_DATA_DIR/sample-noah/boq_sample.xls
Writes  $KAMUTAN_DATA_DIR/gt/noah/{boq_truth.json, disputes.json}

Everything written is status=draft and must be verified by a human. Outputs stay
outside git (customer-derived). The dispute register mirrors 07_test_plan.md.

    uv run python scripts/build_noah_draft_gt.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from kbench.boq_xls import parse_block_counts, parse_boq_xls, parse_change_orders, parse_plumbing_matrix
from kbench.validate import schema_errors

OPEN = "open — awaiting owner"

DISPUTES = [
    {
        "id": "GT-D-001",
        "title": "Sockets: AutoCAD block count 42 vs BOQ 51",
        "summary": "AutoCAD block-count sheet: 'שקע' 9 (karka) + 17 (mgurim) + 16 (martef) = 42. "
        "BOQ: 4.00 single 23 + 4.01 double 15 + 4.02 triple 5 + 4.03 power 8 = 51 "
        "(plus 4.04 power-double 1 and 4.21 three-phase 3).",
        "lines": ["4.00", "4.01", "4.02", "4.03", "4.04", "4.21"],
        "values": {
            "autocad_block_count": {"ground": 9, "first": 17, "basement": 16, "total": 42},
            "boq": {"4.00": 23, "4.01": 15, "4.02": 5, "4.03": 8, "4.04": 1, "4.21": 3},
        },
        "questions": [
            "Are the Excel and the drawings from the same revision?",
            "Does a single 'שקע' block also represent double and triple sockets?",
            "Are power sockets a different block?",
        ],
        "interim_rule": "Two independent manual counts per socket type on the sheets; record both truths. "
        "If unanswered by end of sprint 1, the manual drawing count is truth for detection "
        "tests and the Excel is truth only for export-format tests.",
        "status": OPEN,
        "resolution": None,
        "evidence": ["draft_counts.md#sockets"],
    },
    {
        "id": "GT-D-002",
        "title": "Luminaires: AutoCAD count 56 vs BOQ 9.01 = 43",
        "summary": "AutoCAD lamp count 9 (ground) + 32 (first) + 15 (basement) = 56; line 9.01 'התקנת גופי התאורה' = 43.",
        "lines": ["9.01"],
        "values": {"autocad_block_count": {"ground": 9, "first": 32, "basement": 15, "total": 56}, "boq": {"9.01": 43}},
        "questions": [
            "Does 9.01 include only new fixtures, or are some fixtures client-supplied / existing (supply property)?",
            "Check against the lighting table on the lighting sheets.",
        ],
        "interim_rule": "Annotate supply (contractor/client/existing) on every luminaire; keep both counts.",
        "status": OPEN,
        "resolution": None,
        "evidence": ["draft_counts.md#luminaires"],
    },
    {
        "id": "GT-D-003",
        "title": "WCs / concealed cisterns: matrix 4 + 4 vs BOQ 3.04 = 3 and 3.07 monoblock = 1",
        "summary": "Plumbing matrix: 4 wall-hung WCs and 4 concealed cisterns; BOQ: 3.04 concealed = 3, 3.07 monoblock = 1.",
        "lines": ["3.04", "3.07"],
        "values": {"plumbing_matrix": {"wc_wall_hung": 4, "concealed_cistern": 4}, "boq": {"3.04": 3, "3.07": 1}},
        "questions": ["Was one WC changed to monoblock after the matrix was issued?"],
        "status": OPEN,
        "resolution": None,
        "evidence": ["draft_counts.md#plumbing"],
    },
    {
        "id": "GT-D-004",
        "title": "Faucets: matrix basin 3 + wall 1 vs BOQ 3.03 = 4 and 3.02 = 3",
        "summary": "Matrix: basin (פרח) faucet 3, wall faucet 1; BOQ: 3.03 (basin faucet) = 4 and 3.02 (wall faucet) = 3.",
        "lines": ["3.02", "3.03"],
        "values": {"plumbing_matrix": {"faucet_basin": 3, "faucet_wall": 1}, "boq": {"3.03": 4, "3.02": 3}},
        "questions": ["Are the kitchen sink and the laundry sink included in 3.02 / 3.03?"],
        "status": OPEN,
        "resolution": None,
        "evidence": ["draft_counts.md#plumbing"],
    },
]


def main() -> int:
    data_dir = Path(os.environ.get("KAMUTAN_DATA_DIR", "/home/claude/kamutan-data"))
    xls = data_dir / "sample-noah" / "boq_sample.xls"
    out = data_dir / "gt" / "noah"
    out.mkdir(parents=True, exist_ok=True)

    boq = parse_boq_xls(xls, "noah")
    boq["change_orders"] = parse_change_orders(xls)
    boq["auxiliary"] = {"autocad_block_counts": parse_block_counts(xls), "plumbing_matrix": parse_plumbing_matrix(xls)}
    boq["notes"].append("All lines are draft (pre-annotation from the customer xls); evidence ids not yet attached.")
    boq["notes"].append(
        "Change orders (sheet 'שינויים') use codes that collide with / do not exist in the main BOQ "
        "(1.01 different description, 6.09 while gypsum codes are 7.xx) — kept separately, unverified."
    )
    by_code = {ln["code"]: ln for ln in boq["lines"]}
    for d in DISPUTES:
        for code in d["lines"]:
            ln = by_code[code]
            ln["gt_status"] = "disputed"
            ln["dispute_id"] = d["id"]
    disputes = {"schema_version": "1.0", "project_id": "noah", "disputes": DISPUTES}

    errs = schema_errors(boq, "boq_truth.schema.json") + schema_errors(disputes, "disputes.schema.json")
    if errs:
        print("\n".join(errs), file=sys.stderr)
        return 1
    for name, obj in (("boq_truth.json", boq), ("disputes.json", disputes)):
        with open(out / name, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
            f.write("\n")
    print(f"wrote {out}/boq_truth.json ({len(boq['lines'])} lines) and disputes.json ({len(DISPUTES)} disputes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
