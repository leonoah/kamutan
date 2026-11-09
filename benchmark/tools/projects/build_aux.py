#!/usr/bin/env python3
"""Sprint 10 Data/QA: the GT side files that are not the BOQ lines — `designer_counts.json` and the `disputes.json`
seeds — for rubel / achituv / yahav.

    uv run python -I tools/projects/build_aux.py [project ...]

* `designer_counts.json`: the sheets חשמל (AutoCAD block count per floor), אינסטלציה (fixtures per bathroom) and שינויים
  (change orders) are read and hashed; in all three workbooks they are identical to each other and to Noah's workbook
  (template leftovers), so `status: not_available` and `per_floor_expected: {}`. The raw cells are kept for reference.
* `disputes.json`: GT-D-1xx seeds for the data quirks found in the xls (unit typos, zero-quantity lines, duplicate codes,
  duplicate descriptions, a numbering gap), all `open — awaiting owner`. Lines listed in `lines` are excluded from gating.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import xlrd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from catalogue import DATA, GT

AUX_SHEETS = ("חשמל", "אינסטלציה", "שינויים")


def sheet_cells(book: xlrd.Book, name: str) -> list[list[Any]]:
    if name not in book.sheet_names():
        return []
    sh = book.sheet_by_name(name)
    return [[sh.cell_value(r, c) for c in range(sh.ncols)] for r in range(sh.nrows)]


def designer_counts(project: str, xls: Path) -> dict[str, Any]:
    book = xlrd.open_workbook(str(xls))
    sheets = {n: sheet_cells(book, n) for n in AUX_SHEETS}
    digest = {n: hashlib.sha256(json.dumps(sheets[n], ensure_ascii=False).encode()).hexdigest()[:16] for n in AUX_SHEETS}
    return {
        "schema": "kamutan.designer-counts/1",
        "project_id": project,
        "source_file": xls.name,
        "status": "not_available",
        "reason": (
            "The sheets חשמל (AutoCAD block count per floor: karka / mgurim / martef), אינסטלציה (fixtures per bathroom) and "
            "שינויים (change orders) are identical in the rubel / achituv / yahav workbooks and equal Noah's (same block "
            "names and counts: 'שקע' 9/17/16, 'גז ברברה' 6, the 4-bathroom fixture matrix, the 22.12.10 change orders). "
            "They are template leftovers, not this project's counts, and are not usable as GT. Per-floor expectations for "
            "this project therefore cannot come from the designer's sheets; see expected_counts.json."
        ),
        "sheet_content_sha256_16": digest,
        "raw_sheets": sheets,
        "per_floor_expected": {},
    }


def _d(id_: str, title: str, summary: str, lines: list[str], **kw: Any) -> dict[str, Any]:
    return {
        "id": id_,
        "title": title,
        "summary": summary,
        "lines": lines,
        "values": kw.get("values", {}),
        "questions": kw.get("questions", []),
        "interim_rule": kw.get("interim_rule", "Informational."),
        "status": "open — awaiting owner",
        "resolution": None,
    }


SEEDS: dict[str, list[dict[str, Any]]] = {
    "rubel": [
        _d(
            "GT-D-101",
            "4.41–4.43 'סט: שירשור 12/16/17 נק' מאור' carry unit יחידה, 4.38–4.40 carry סט",
            "Same line family, two units. Scored as written; a `lighting_circuit` rule emitting סט on 4.41 would score wrong_unit.",
            ["4.41", "4.42", "4.43"],
            values={"boq_unit": {"4.38": "סט", "4.39": "סט", "4.40": "סט", "4.41": "יחידה", "4.42": "יחידה", "4.43": "יחידה"}},
            questions=["Is unit יחידה on 4.41–4.43 a typo for סט?"],
            interim_rule="Excluded from gating while open.",
        ),
        _d(
            "GT-D-102",
            "Zero-quantity scored lines 4.06 (שקע כח משולש) and 4.16 (הזנה לתנור חימום)",
            "Unit יחידה, qty 0, not בוטל. Kept in `lines` (flag zero_quantity): a missing predicted line scores 'missing' although Q̂ = 0 = Q.",
            [],
            values={"boq": {"4.06": 0, "4.16": 0}},
            questions=["Should a template line with qty 0 appear in Kamutan's BOQ at 0, or be dropped?"],
        ),
        _d(
            "GT-D-103",
            "9.01 and 9.03 have the identical description 'ביצוע חיזוקי עץ במחיצות גבס ע\"פ תכנית'",
            "Two lump-sum lines, same text; description-based matching cannot tell them apart.",
            [],
            questions=["Is 9.01 a copy-paste error (Noah's 9.01 is a different item)?"],
        ),
        _d(
            "GT-D-104",
            "Cancelled duplicate 5.09 (בוטל, raw qty 19) before the live 5.09 (21 m²)",
            "First 5.09 is unit בוטל with 19 still in the quantity cell; the second is the live cladding line (scored, keeps code 5.09).",
            [],
            values={"cancelled_raw_qty": 19, "live_qty": 21},
        ),
    ],
    "achituv": [
        _d(
            "GT-D-101",
            "7.04 'בניית תקרת גבס ע\"פ תכנית' unit יחידה, qty 16.5 — an area in m²",
            'Every other ceiling line of this designer is מ"ר (Rubel 7.01 25 m²). Scored as written, so a correct m² prediction scores wrong_unit.',
            ["7.04"],
            values={"boq": {"unit": "יחידה", "qty": 16.5}},
            questions=["Confirm 7.04 is 16.5 m²."],
            interim_rule="Excluded from gating while open.",
        ),
        _d(
            "GT-D-102",
            "Zero-quantity scored lines 4.06 (שקע כח משולש) and 4.41 (מאוורר תקרה)",
            "Kept with flag zero_quantity.",
            [],
            values={"boq": {"4.06": 0, "4.41": 0}},
            questions=["List at 0 or drop?"],
        ),
        _d(
            "GT-D-103",
            "4.30 'הכנה לבית חכם' קומפלט replaces the per-box 'קופסת עומק למפסקים' count",
            "Rubel counts deep boxes per switch box (4.36 = 26 יחידה); Achituv prices the same work as one קומפלט. One rule kind, two wordings.",
            [],
        ),
    ],
    "yahav": [
        _d(
            "GT-D-101",
            "7.03 'בניית תקרת גבס ע\"פ תכנית' unit יחידה, qty 77 — an area in m²",
            "77 'units' of gypsum ceiling is an area (brief: 'one BOQ says יחידה by mistake'). Scored as written.",
            ["7.03"],
            values={"boq": {"unit": "יחידה", "qty": 77}},
            questions=["Confirm 7.03 is 77 m²."],
            interim_rule="Excluded from gating while open.",
        ),
        _d(
            "GT-D-102",
            "Duplicate codes 3.18 ×3 (אדנית drain / fire-hose point / fire-hose supply) and 7.03 ×2 (ceiling / סינר)",
            "Kept as 3.18, 3.18.2, 3.18.3 and 7.03, 7.03.2 (sheet order). eval-boq pools predicted lines by TEXT code, so only the first of each can match by code.",
            [],
            questions=["Renumber 3.19/3.20 and 7.04 in the designer file?"],
        ),
        _d(
            "GT-D-103",
            "5.10 'קופינג לחלון מטבח באורך 100 ס\"מ' unit יחידה qty 2.5",
            'A fractional count: 2.5 units of a 100 cm sill = 2.5 m, probably מ"א.',
            ["5.10"],
            values={"boq": {"unit": "יחידה", "qty": 2.5}},
            interim_rule="Excluded from gating while open.",
        ),
        _d(
            "GT-D-104",
            "Zero-quantity scored lines 4.06 (שקע כח משולש) and 4.14 (אביזר D18)",
            "Kept with flag zero_quantity.",
            [],
            values={"boq": {"4.06": 0, "4.14": 0}},
            questions=["List at 0 or drop?"],
        ),
        _d(
            "GT-D-105",
            "Chapter 07 skips 8.04 (gap_before:8.04)",
            "8.03 → 8.05; the template's 8.04 (טיח מינרלי, Rubel) was deleted without renumbering.",
            [],
        ),
    ],
}


SPLITS = {
    "schema": "kamutan.gt-splits/1",
    "split_version": "splits-v2",
    "stage": "A",
    "defined_at": "2026-11-09T12:20:00+02:00",
    "defined_by": "agent:data-qa (Sprint 5; Sprint 10 added rubel / achituv / yahav; re-created after the 09.11 data loss)",
    "rule": (
        "Split by project (never by sheet) and by office (07_test_plan 'חלוקה train / dev / holdout'). Stage A: all GT projects "
        "are DEV (Noah is also the smoke set); no holdout exists yet. Holdout = future partner projects, at least one partner "
        "office entirely in holdout; adding them is a MAJOR gt version and needs QA-lead approval. Calibration (kbench "
        "calibrate) reads DEV only and refuses any project whose split is not 'dev'."
    ),
    "projects": {
        "noah": {"split": "dev", "office": "office-noah", "gt_dir": "noah", "gt_version": "gt-v0.1-draft (rebuilt 09.11)"},
        **{
            p: {
                "split": "dev",
                "office": "office-noah",
                "gt_dir": p,
                "gt_version": "gt-v1.0-draft",
                "note": "Sprint 10: same designer/office as Noah -> dev by the office rule; BOQ GT only (no sheet annotations)",
            }
            for p in ("rubel", "achituv", "yahav")
        },
    },
    "holdout": [],
    "holdout_sha256": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
}


def main() -> int:
    projects = sys.argv[1:] or ["rubel", "achituv", "yahav"]
    digests: dict[str, dict[str, str]] = {}
    for p in projects:
        xls = next((DATA / "projects" / p).glob("*.xls"))
        out = GT / p
        out.mkdir(parents=True, exist_ok=True)
        dc = designer_counts(p, xls)
        digests[p] = dc["sheet_content_sha256_16"]
        (out / "designer_counts.json").write_text(json.dumps(dc, ensure_ascii=False, indent=1), encoding="utf-8")
        (out / "disputes.json").write_text(
            json.dumps({"schema_version": "1.0", "project_id": p, "disputes": SEEDS.get(p, [])}, ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
        (out / "eval").mkdir(exist_ok=True)
        print(f"{p}: designer_counts (aux sheet digests {dc['sheet_content_sha256_16']}), {len(SEEDS.get(p, []))} dispute seeds")
    splits = GT / "splits.json"
    if not splits.exists():
        splits.write_text(json.dumps(SPLITS, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"wrote {splits}")
    if len(digests) > 1:
        same = all(d == next(iter(digests.values())) for d in digests.values())
        print("aux sheets identical across projects:", same)
    return 0


if __name__ == "__main__":
    sys.exit(main())
