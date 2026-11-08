"""library.xlsx: the synthetic price list in the client BOQ layout (worker ``library.import``)."""

from __future__ import annotations

from pathlib import Path

from conftest import COMBOS, composed
from openpyxl import load_workbook

from kamutan_synth.library import price_list, write_library


def test_library_has_every_code_the_generator_writes(tmp_path: Path) -> None:
    p = tmp_path / "library.xlsx"
    write_library(p)
    ws = load_workbook(p).active
    assert ws is not None
    rows = list(ws.iter_rows(values_only=True))
    header = next(i for i, r in enumerate(rows) if r and r[0] == "סעיף")
    codes = {r[0] for r in rows[header + 1 :] if r and isinstance(r[0], str)}
    assert {"4.10", "3.10", "4.90"} <= codes  # TEXT codes keep their trailing zero
    assert codes == {c for c, *_ in price_list()}
    for i, (d, c) in enumerate(COMBOS):
        res = composed(11, i, d, c)
        assert {ln["code"] for ln in res.boq["lines"]} <= codes


def test_library_bytes_are_stable(tmp_path: Path) -> None:
    a, b = tmp_path / "a.xlsx", tmp_path / "b.xlsx"
    write_library(a)
    write_library(b)
    assert a.read_bytes() == b.read_bytes()
