#!/usr/bin/env python3
"""Copy the כמויות sheet of a designer .xls into a one-sheet .xlsx whose header cell A4 says 'סעיף' (the shipped files
have ' ' there, so the library importer of 09.11 10:27 could not find the BOQ header and fell back to the שינויים sheet).
Codes keep number format 0.00 (the importer reads displayed decimals → TEXT codes), everything else is copied as is.
Derived customer artifact — stays outside git.

    uv run python -I tools/projects/patch_xls.py <in.xls> <out.xlsx>
"""

from __future__ import annotations

import sys
from pathlib import Path

import openpyxl
import xlrd


def main() -> int:
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    book = xlrd.open_workbook(str(src), formatting_info=True)
    sh = book.sheet_by_name("כמויות")
    wb = openpyxl.Workbook()
    ws = wb.active
    assert ws is not None
    ws.title = "כמויות"
    hdr_fixed = False
    for r in range(sh.nrows):
        is_header_row = any(str(sh.cell_value(r, cc)).strip() == "תאור העבודה" for cc in range(sh.ncols))
        for c in range(sh.ncols):
            cell = sh.cell(r, c)
            if cell.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK):
                continue
            v = cell.value
            if cell.ctype == xlrd.XL_CELL_NUMBER:
                fmt = book.format_map[book.xf_list[cell.xf_index].format_key].format_str
                out = ws.cell(row=r + 1, column=c + 1, value=v)
                if c == 0 or fmt == "0.00":
                    out.number_format = "0.00"
                elif fmt != "General":
                    out.number_format = fmt
            else:
                if not hdr_fixed and c == 0 and str(v).strip() == "" and is_header_row:
                    v = "סעיף"
                    hdr_fixed = True
                ws.cell(row=r + 1, column=c + 1, value=v)
    dst.parent.mkdir(parents=True, exist_ok=True)
    wb.save(dst)
    print(f"{dst} header_fixed={hdr_fixed} rows={sh.nrows}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
