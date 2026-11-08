"""The synthetic price list (``catalog.py``) as a client-style BOQ workbook for the worker's ``library.import``.

Layout as the worker's ``library_import/parse.py`` reads it: title rows, the header
``סעיף | תאור העבודה | יחידה | כמות סה"כ | מחיר יח' | סה"כ ₪``, chapter rows ``פרק NN - title``, item rows with TEXT
codes (also formatted ``0.00`` so "4.10" never becomes 4.1). Quantities are empty (a price list, not a project BOQ).
"""

from __future__ import annotations

import datetime as dt
import io
import re
import zipfile
from pathlib import Path

from openpyxl import Workbook

from .catalog import CHAPTERS, CLASSES, PIPE_LINES, REPLACE_LINE

FIXED = dt.datetime(2026, 1, 1, 0, 0, 0)
UNIT_COUNT = "יחידה"
UNIT_LENGTH = 'מ"א'


def price_list() -> list[tuple[str, str, str, float]]:
    """(code, description, unit, unit price) for every line the generator can write, sorted by code."""
    rows: dict[str, tuple[str, str, str, float]] = {}
    for c in CLASSES.values():
        rows[c.boq] = (c.boq, c.boq_desc, UNIT_COUNT, 100.0 + 10 * len(rows))
    for code, desc in PIPE_LINES.values():
        rows[code] = (code, desc, UNIT_LENGTH, 40.0 + 5 * len(rows))
    rows[REPLACE_LINE[0]] = (REPLACE_LINE[0], REPLACE_LINE[1], UNIT_COUNT, 80.0)
    return [rows[k] for k in sorted(rows, key=lambda c: [int(x) for x in c.split(".")])]


def write_library(path: Path) -> None:
    wb = Workbook()
    ws = wb.active
    assert ws is not None
    ws.title = "כתב כמויות"
    ws.sheet_view.rightToLeft = True
    ws.append(["כתב כמויות ומחירים"])
    ws.append(["שם הפרויקט: מחירון סינתטי (kamutan-synth)"])
    ws.append([])
    ws.append(["סעיף", "תאור העבודה", "יחידה", 'כמות סה"כ', "מחיר יח'", 'סה"כ ₪'])
    chapter = ""
    for code, desc, unit, price in price_list():
        major = code.split(".")[0]
        if major != chapter:
            chapter = major
            ws.append([None, CHAPTERS[major].replace(" (סינתטי)", "")])
        ws.append([code, desc, unit, None, price, None])
        ws.cell(ws.max_row, 1).number_format = "@"
    ws.column_dimensions["B"].width = 60
    wb.properties.created = FIXED
    wb.properties.modified = FIXED
    wb.properties.creator = "kamutan-synth"
    buf = io.BytesIO()
    wb.save(buf)
    # normalise zip entry timestamps -> byte-identical output
    src = zipfile.ZipFile(io.BytesIO(buf.getvalue()))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst:
        for info in src.infolist():
            data = src.read(info.filename)
            if info.filename == "docProps/core.xml":  # openpyxl stamps "modified" with the save time
                data = re.sub(rb"(<dcterms:modified[^>]*>)[^<]*", rb"\g<1>2026-01-01T00:00:00Z", data)
            zi = zipfile.ZipInfo(info.filename, date_time=(1980, 1, 1, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            dst.writestr(zi, data)
    path.write_bytes(out.getvalue())
