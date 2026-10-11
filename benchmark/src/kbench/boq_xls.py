"""Parse a legacy .xls BOQ (Israeli contractor format) into boq_truth.json.

The .xls stores item codes as floats, so "4.10" arrives as 4.1 and "4.00" as 4.0.
Codes are reconstructed per chapter as TEXT:

* the chapter scheme is two-digit minors (x.01 .. x.NN) when any code has a non-zero
  hundredths digit; codes are then formatted ``f"{major}.{minor:02d}"``;
* every reconstructed code is checked against its predecessor in the chapter:
  ``minor == prev + 1`` confirms it; a single-decimal float that the sequence confirms
  (4.09 -> 4.1) gets flag ``trailing_zero_restored``; anything the sequence does not
  confirm gets ``ambiguous_code``; skipped numbers produce ``gap_before:<codes>``;
* a minor of 0 (``4.0``) is always ``ambiguous_code`` (could be "4.00", "4", or a typo);
* the chapter heading number vs code major is checked (``chapter_code_mismatch``).
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any

HEADER_CODE = "סעיף"
CHAPTER_RE = re.compile(r"^\s*פרק\s*0*(\d+)\s*[-–]?\s*(.*)$")


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _split_float_code(x: float) -> tuple[int, int, bool]:
    """(major, minor as hundredths, had_hundredths_digit)."""
    major = int(x)
    hundredths = round((x - major) * 100)
    if abs((x - major) * 100 - hundredths) > 1e-6:
        raise ValueError(f"code {x!r} has more than two decimals")
    return major, hundredths, hundredths % 10 != 0


def reconstruct_codes(raw: list[float]) -> list[tuple[str, list[str]]]:
    """Reconstruct TEXT codes for one chapter's raw float codes (in sheet order)."""
    parts = [_split_float_code(x) for x in raw]
    two_digit = any(h for _, _, h in parts) or len(parts) > 9
    out: list[tuple[str, list[str]]] = []
    prev_minor: int | None = None
    prev_major: int | None = None
    for x, (major, minor, had_h) in zip(raw, parts):
        flags: list[str] = []
        if not two_digit:
            code = f"{major}.{minor // 10}" if minor else f"{major}"
            flags.append("one_digit_scheme")
        else:
            code = f"{major}.{minor:02d}"
        if minor == 0:
            flags.append("ambiguous_code")
        expected = (prev_minor + 1) if (prev_minor is not None and prev_major == major) else None
        if expected is not None and minor != expected:
            if minor > expected:
                missing = [f"{major}.{m:02d}" for m in range(expected, minor)]
                flags.append("gap_before:" + ",".join(missing))
            else:
                flags.append("ambiguous_code")
                flags.append("non_monotonic")
        if two_digit and not had_h and minor != 0:
            if expected is not None and minor == expected:
                flags.append("trailing_zero_restored")
            elif "ambiguous_code" not in flags:
                flags.append("ambiguous_code")
        out.append((code, flags))
        prev_minor, prev_major = minor, major
    return out


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
    return "count"


def parse_boq_xls(path: str | Path, project_id: str, sheet_name: str = "כמויות") -> dict[str, Any]:
    import xlrd

    path = Path(path)
    book = xlrd.open_workbook(str(path))
    sh = book.sheet_by_name(sheet_name)
    header_row = next(r for r in range(sh.nrows) if str(sh.cell_value(r, 0)).strip() == HEADER_CODE)
    hdr = {str(sh.cell_value(header_row, c)).strip(): c for c in range(sh.ncols)}
    c_code, c_desc, c_unit = hdr[HEADER_CODE], hdr["תאור העבודה"], hdr["יחידה"]
    c_qty = next(c for k, c in hdr.items() if k.startswith("כמות"))

    chapters: list[dict[str, Any]] = []
    cur: dict[str, Any] | None = None
    for r in range(header_row + 1, sh.nrows):
        code_cell = sh.cell(r, c_code)
        desc = str(sh.cell_value(r, c_desc)).strip()
        m = CHAPTER_RE.match(desc) if code_cell.ctype != xlrd.XL_CELL_NUMBER else None
        if m:
            cur = {"number": int(m.group(1)), "title": desc, "rows": [], "notes": []}
            chapters.append(cur)
            continue
        if code_cell.ctype == xlrd.XL_CELL_NUMBER and cur is not None:
            cur["rows"].append({"row": r, "raw": code_cell.value, "desc": desc,
                                "unit": str(sh.cell_value(r, c_unit)).strip(),
                                "qty": sh.cell_value(r, c_qty)})
        elif cur is not None and desc and not desc.startswith('סה"כ') and desc not in ("הערות:", "הערות"):
            cur["notes"].append(desc.replace("\xa0", " "))

    lines: list[dict[str, Any]] = []
    notes: list[str] = []
    for ch in chapters:
        recon = reconstruct_codes([row["raw"] for row in ch["rows"]])
        majors = {int(row["raw"]) for row in ch["rows"]}
        mismatch = majors and majors != {ch["number"]}
        if mismatch:
            notes.append(f"chapter heading '{ch['title']}' numbered {ch['number']} but its codes use major(s) {sorted(majors)}")
        for row, (code, flags) in zip(ch["rows"], recon):
            if mismatch:
                flags = flags + [f"chapter_code_mismatch:{ch['number']}"]
            qty = row["qty"]
            line = {
                "code": code,
                "raw_code": row["raw"],
                "chapter": ch["title"],
                "description": row["desc"],
                "unit": row["unit"],
                "quantity": float(qty) if qty != "" else 0.0,
                "evidence": [],
                "gt_status": "draft",
                "category": _category(row["unit"], row["desc"]),
                "source": "boq_original",
                "source_row": row["row"],
                "flags": flags,
            }
            lines.append(line)
    codes = [ln["code"] for ln in lines]
    dupes = sorted({c for c in codes if codes.count(c) > 1})
    if dupes:
        notes.append(f"duplicate reconstructed codes: {dupes}")
    return {
        "schema_version": "1.0",
        "project_id": project_id,
        "kind": "truth",
        "status": "draft",
        "gt_version": "gt-v0.1-draft",
        "source": {"file": path.name, "sha256": _sha256(path), "sheet": sheet_name},
        "generated_by": "kbench parse-boq-xls (pre-annotation; needs human verification)",
        "notes": notes,
        "lines": lines,
        "chapter_notes": {ch["title"]: ch["notes"] for ch in chapters if ch["notes"]},
    }


def parse_change_orders(path: str | Path, sheet_name: str = "שינויים") -> list[dict[str, Any]]:
    import xlrd

    book = xlrd.open_workbook(str(path))
    if sheet_name not in book.sheet_names():
        return []
    sh = book.sheet_by_name(sheet_name)
    header_row = next(r for r in range(sh.nrows) if str(sh.cell_value(r, 0)).strip() == HEADER_CODE)
    hdr = {str(sh.cell_value(header_row, c)).strip(): c for c in range(sh.ncols)}
    floors = {"קומת כניסה": "ground", "קומה א'": "first", "מרתף": "basement"}
    out = []
    for r in range(header_row + 1, sh.nrows):
        cell = sh.cell(r, 0)
        if cell.ctype != xlrd.XL_CELL_NUMBER:
            continue
        major, minor, _ = _split_float_code(cell.value)
        bd = {fl: float(sh.cell_value(r, hdr[h])) for h, fl in floors.items()
              if h in hdr and sh.cell_value(r, hdr[h]) != ""}
        out.append({
            "code": f"{major}.{minor:02d}", "raw_code": cell.value,
            "description": str(sh.cell_value(r, 1)).strip(), "unit": str(sh.cell_value(r, 2)).strip(),
            "quantity": float(sh.cell_value(r, hdr['כמות סה"כ']) or 0.0), "breakdown": bd,
            "gt_status": "draft", "source": "boq_original", "source_row": r,
            "flags": ["change_order", "code_namespace_unverified"],
            "date": str(sh.cell_value(r, hdr["תאריך"])) if "תאריך" in hdr else None,
        })
    return out


def parse_block_counts(path: str | Path, sheet_name: str = "חשמל") -> dict[str, Any]:
    """AutoCAD 'block count' export pasted into the workbook (per floor titles)."""
    import xlrd

    book = xlrd.open_workbook(str(path))
    if sheet_name not in book.sheet_names():
        return {}
    sh = book.sheet_by_name(sheet_name)
    out: dict[str, list[dict[str, Any]]] = {}
    title = None
    for r in range(sh.nrows):
        v = str(sh.cell_value(r, 0))
        if v.strip().startswith("Title"):
            title = v.strip().replace("Title", "").strip(" -")
            out[title] = []
        elif "|" in v and title:
            name = v.split("|")[0].strip()
            qty = int(v.split("|")[5].strip())
            out[title].append({"block_name_truncated": name, "qty": qty})
    return out


def parse_plumbing_matrix(path: str | Path, sheet_name: str = "אינסטלציה") -> dict[str, Any]:
    import xlrd

    book = xlrd.open_workbook(str(path))
    if sheet_name not in book.sheet_names():
        return {}
    sh = book.sheet_by_name(sheet_name)
    cols = {c: str(sh.cell_value(0, c)).strip() for c in range(1, sh.ncols) if sh.cell_value(0, c) != ""}
    rows = {}
    for r in range(1, sh.nrows):
        name = str(sh.cell_value(r, 0)).strip()
        if not name:
            continue
        rows[name] = {cols[c]: sh.cell_value(r, c) for c in cols if sh.cell_value(r, c) != ""}
    return {"columns": list(cols.values()), "rows": rows}
