#!/usr/bin/env python3
"""Sprint 10 Data/QA: parse a designer BOQ (.xls, sheet כמויות) into gt/<project>/boq_truth.json (+ lines.md).

    uv run python -I tools/projects/build_boq_truth.py <project> <xls> [--out-dir DIR]

Same line format as gt/noah/boq_truth.json (kbench `boq_truth.schema.json`), plus the Sprint-10 quirks:

* **float codes** (``4.23999999999999``) → hundredths rounded, then confirmed against the chapter sequence
  (flag ``float_code_repaired``); one-decimal floats (``3.1``) → ``3.10`` by sequence (``trailing_zero_restored``);
* **duplicate codes** (Yahav 3.18 ×3, 7.03 ×2; Rubel 5.09 ×2): every occurrence is kept; the first scored occurrence
  keeps the plain code, later scored ones get a numeric suffix (``3.18.2``, ``3.18.3``) so codes stay unique and
  schema-valid (flag ``duplicate_code:<code>``, ``raw_code`` keeps the sheet value);
* **unit בוטל** → ``cancelled: true``, quantity 0 (``raw_quantity`` keeps the sheet value), moved to ``excluded_lines``;
* **"לא לסיכום / לספירה בסוף / אופציה, לא לסיכום"** → ``notForTotal: true`` (unit-price-only placeholder), moved to
  ``excluded_lines``;
* units **חדר** and **סט** are count-like (``category: count``);
* a scored line with quantity 0 (Rubel 4.06, 4.16; Achituv 4.06, 4.41; Yahav 4.06, 4.14) stays in ``lines`` with flag
  ``zero_quantity`` — the designer lists it, Kamutan should list it at 0;
* chapter titles + notes (``chapter_notes``), ``chapter_code_mismatch`` (06→7.xx, 07→8.xx, 08→9.xx as in Noah);
* the sheets חשמל / אינסטלציה / שינויים are NOT read here: in all three files they are byte-identical copies of Noah's
  (see designer_counts.json), so they are not this project's data.

``lines`` = the scored lines (what `kbench eval-boq` iterates). ``excluded_lines`` = cancelled + notForTotal.
The header row of these files has ' ' instead of 'סעיף' in column A, so the header is located by תאור העבודה + יחידה.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import xlrd

DATA = Path(os.environ.get("KAMUTAN_DATA_DIR", "/home/claude/kamutan-data"))
CHAPTER_RE = re.compile(r"^\s*פרק\s*0*(\d+)\s*[-–]?\s*(.*)$")
NOT_FOR_TOTAL_RE = re.compile(r"^\s*(לספירה בסיום,?\s*לא לסיכום|לא לסיכום,?\s*לספירה בסוף|אופציה,?\s*לא לסיכום)")
CANCELLED_UNITS = {"בוטל", "בוטלה", "מבוטל"}
COUNT_LIKE_UNITS = {"יחידה", "יח'", "חדר", "סט"}


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _norm(s: Any) -> str:
    return " ".join(str(s or "").replace("\xa0", " ").split())


def _category(unit: str, desc: str) -> str:
    if unit == 'מ"ר':
        if "חיפוי" in desc:
            return "cladding"
        if "ריצוף" in desc:
            return "flooring"
        return "area"
    if unit == 'מ"א':
        return "length"
    if unit == "קומפלט":
        return "lump_sum"
    if unit in COUNT_LIKE_UNITS:
        return "count"
    return "other"


def _base_code(x: float) -> str:
    major = int(x)
    return f"{major}.{round((x - major) * 100):02d}"


def split_code(x: float) -> tuple[int, int, list[str]]:
    """float cell → (major, minor hundredths, flags). 4.23999999999999 → (4, 24, [float_code_repaired])."""
    major = int(x)
    minor = round((x - major) * 100)
    flags: list[str] = []
    # 4.23999999999999 is a distinct stored double (repr has 14 decimals); a true 4.24 reprs as "4.24"
    if len(repr(x).split(".")[-1]) > 2:
        flags.append("float_code_repaired")
    return major, minor, flags


def read_sheet(path: Path, sheet_name: str = "כמויות") -> list[dict[str, Any]]:
    book = xlrd.open_workbook(str(path), formatting_info=True)
    sh = book.sheet_by_name(sheet_name)
    hdr_row = next(
        r
        for r in range(sh.nrows)
        if any(_norm(sh.cell_value(r, c)) in ("תאור העבודה", "תאור") for c in range(sh.ncols))
        and any(_norm(sh.cell_value(r, c)) == "יחידה" for c in range(sh.ncols))
    )
    hdr = {_norm(sh.cell_value(hdr_row, c)): c for c in range(sh.ncols)}
    c_code = hdr.get("סעיף", 0)
    c_desc = hdr.get("תאור העבודה", hdr.get("תאור", 1))
    c_unit = hdr["יחידה"]
    c_qty = next(c for k, c in hdr.items() if k.startswith("כמות"))
    title = ""
    for r in range(hdr_row):
        v = _norm(sh.cell_value(r, 0))
        if "שם הפרויקט" in v:
            title = v
    rows: list[dict[str, Any]] = [{"kind": "title", "text": title, "row": -1}]
    for r in range(hdr_row + 1, sh.nrows):
        code_cell = sh.cell(r, c_code)
        desc = _norm(sh.cell_value(r, c_desc))
        if code_cell.ctype == xlrd.XL_CELL_NUMBER:
            xf = book.xf_list[code_cell.xf_index]
            rows.append(
                {
                    "kind": "item",
                    "row": r,
                    "raw": code_cell.value,
                    "fmt": book.format_map[xf.format_key].format_str,
                    "desc": desc,
                    "unit": _norm(sh.cell_value(r, c_unit)),
                    "qty": sh.cell_value(r, c_qty),
                }
            )
            continue
        if not desc:
            continue
        m = CHAPTER_RE.match(desc)
        if m:
            rows.append({"kind": "chapter", "row": r, "number": int(m.group(1)), "title": desc})
        elif desc.startswith('סה"כ'):
            rows.append({"kind": "total", "row": r, "text": desc})
        elif desc.rstrip(":") == "הערות":
            continue
        else:
            rows.append({"kind": "note", "row": r, "text": desc})
    return rows


def build(project: str, xls: Path) -> dict[str, Any]:
    rows = read_sheet(xls)
    notes: list[str] = []
    chapter_notes: dict[str, list[str]] = {}
    lines: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    cur: dict[str, Any] | None = None
    prev: tuple[int, int] | None = None
    seen: Counter[str] = Counter()
    chapter_majors: dict[str, set[int]] = {}
    for row in rows:
        if row["kind"] == "chapter":
            cur = row
            prev = None
            chapter_majors[row["title"]] = set()
            continue
        if row["kind"] == "note" and cur is not None:
            chapter_notes.setdefault(cur["title"], []).append(row["text"])
            continue
        if row["kind"] != "item":
            continue
        if cur is None:
            notes.append(f"row {row['row']}: item before any chapter heading, skipped")
            continue
        major, minor, flags = split_code(row["raw"])
        chapter_majors[cur["title"]].add(major)
        code = f"{major}.{minor:02d}"
        if abs(row["raw"] * 10 - round(row["raw"] * 10)) < 1e-9 and minor % 10 == 0 and minor:
            flags.append("trailing_zero_restored")  # 3.1 → 3.10 (confirmed by the sequence and the 0.00 cell format)
        if prev is not None and prev[0] == major:
            if minor != prev[1] and minor != prev[1] + 1:
                if minor > prev[1] + 1:
                    flags.append("gap_before:" + ",".join(f"{major}.{m:02d}" for m in range(prev[1] + 1, minor)))
                else:
                    flags.append("non_monotonic")
        elif prev is not None:
            flags.append("major_changed_inside_chapter")
        prev = (major, minor)
        unit = row["unit"]
        desc = row["desc"]
        qty_raw = row["qty"]
        qty = float(qty_raw) if qty_raw not in ("", None) else 0.0
        cancelled = unit in CANCELLED_UNITS
        nft = bool(NOT_FOR_TOTAL_RE.match(desc))
        if "בוטל" in desc and not cancelled:
            flags.append("partial_cancellation_in_text")
        line: dict[str, Any] = {
            "code": code,
            "raw_code": row["raw"],
            "chapter": cur["title"],
            "description": desc,
            "unit": unit,
            "quantity": 0.0 if cancelled else qty,
            "evidence": [],
            "gt_status": "draft",
            "category": _category(unit, desc) if not cancelled else "other",
            "source": "boq_original",
            "source_row": row["row"],
            "flags": flags,
        }
        if cancelled:
            line["cancelled"] = True
            line["raw_quantity"] = qty
            flags.append("cancelled")
        if nft:
            line["notForTotal"] = True
            flags.append("not_for_total")
        if not cancelled and not nft and qty == 0:
            flags.append("zero_quantity")
        if cancelled or nft:
            excluded.append(line)
        else:
            seen[code] += 1
            if seen[code] > 1:
                line["code"] = f"{code}.{seen[code]}"
            lines.append(line)
    # every occurrence of a repeated raw code is flagged (scored or excluded)
    raw_counts = Counter(_base_code(ln["raw_code"]) for ln in [*lines, *excluded])
    for ln in [*lines, *excluded]:
        base = _base_code(ln["raw_code"])
        if raw_counts[base] > 1:
            ln["flags"].append(f"duplicate_code:{base}")
    # chapter numbering vs code majors
    for title, majors in chapter_majors.items():
        m = CHAPTER_RE.match(title)
        num = int(m.group(1)) if m else None
        if majors and majors != {num}:
            notes.append(f"chapter heading '{title}' numbered {num} but its codes use major(s) {sorted(majors)}")
            for ln in [*lines, *excluded]:
                if ln["chapter"] == title:
                    ln["flags"].append(f"chapter_code_mismatch:{num}")
    # duplicate descriptions
    dd = Counter(ln["description"] for ln in lines)
    for d, n in dd.items():
        if n > 1:
            codes = [ln["code"] for ln in lines if ln["description"] == d]
            notes.append(f"identical description on {codes}: '{d[:60]}'")
            for ln in lines:
                if ln["description"] == d:
                    ln["flags"].append("duplicate_description")
    title = next((r["text"] for r in rows if r["kind"] == "title"), "")
    unit_counts = Counter(ln["unit"] for ln in lines)
    notes.insert(
        0,
        f"{len(lines)} scored lines, {len(excluded)} excluded "
        f"({sum(1 for e in excluded if e.get('cancelled'))} cancelled/בוטל, "
        f"{sum(1 for e in excluded if e.get('notForTotal'))} notForTotal); units {dict(unit_counts)}",
    )
    notes.append(
        "Sheets חשמל (AutoCAD block counts), אינסטלציה (fixture matrix) and שינויים are byte-identical to Noah's "
        "(template leftovers) and were not imported; see designer_counts.json."
    )
    notes.append("All lines are draft (parsed from the designer xls; descriptions kept verbatim); evidence not attached.")
    return {
        "schema_version": "1.0",
        "project_id": project,
        "kind": "truth",
        "status": "draft",
        "gt_version": "gt-v1.0-draft",
        "source": {"file": xls.name, "sha256": _sha256(xls), "sheet": "כמויות", "title_row": title},
        "generated_by": "benchmark/tools/projects/build_boq_truth.py (Sprint 10 Data/QA; needs human verification)",
        "notes": notes,
        "lines": lines,
        "excluded_lines": excluded,
        "chapter_notes": chapter_notes,
        "change_orders": [],
    }


def render_md(doc: dict[str, Any]) -> str:
    o = [
        f"# {doc['project_id']} — designer BOQ lines (sheet כמויות)",
        "",
        f"Source: `{doc['source']['file']}` · sha256 `{doc['source']['sha256'][:12]}…` · {doc['notes'][0]}",
        "",
        (
            "Status: **scored** = in `lines` (kbench eval-boq iterates these); **cancelled** (unit בוטל) and **notForTotal** "
            "(לא לסיכום / לספירה בסוף) are in `excluded_lines` and never scored."
        ),
        "",
        "| code | raw | unit | qty | status | description | flags |",
        "| --- | --- | --- | ---: | --- | --- | --- |",
    ]
    for ln in sorted([*doc["lines"], *doc["excluded_lines"]], key=lambda ln: ln["source_row"]):
        st = "cancelled" if ln.get("cancelled") else ("notForTotal" if ln.get("notForTotal") else "scored")
        q = ln["raw_quantity"] if ln.get("cancelled") else ln["quantity"]
        fl = ", ".join(f for f in ln["flags"] if not f.startswith("chapter_code_mismatch"))
        desc = ln["description"].replace("|", "/")
        o.append(f"| {ln['code']} | {ln['raw_code']:g} | {ln['unit']} | {q:g} | {st} | {desc} | {fl} |")
    o += ["", "## Chapter notes", ""]
    for ch, ns in doc["chapter_notes"].items():
        o.append(f"**{ch}**")
        o += [f"- {n}" for n in ns]
        o.append("")
    o += ["## Parser notes", ""] + [f"- {n}" for n in doc["notes"]]
    return "\n".join(o) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("project")
    ap.add_argument("xls")
    ap.add_argument("--out-dir", default=None)
    a = ap.parse_args(argv)
    out = Path(a.out_dir or DATA / "gt" / a.project)
    out.mkdir(parents=True, exist_ok=True)
    doc = build(a.project, Path(a.xls))
    (out / "boq_truth.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    (out / "lines.md").write_text(render_md(doc), encoding="utf-8")
    print(f"{a.project}: {doc['notes'][0]} -> {out}")
    for n in doc["notes"][1:]:
        print("  -", n)
    return 0


if __name__ == "__main__":
    sys.exit(main())
