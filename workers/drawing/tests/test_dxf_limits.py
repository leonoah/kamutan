"""DXF complexity guards (security-gate findings F-1/F-2/F-3), checked without the fuzz suite."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from kamutan_drawing.errors import IngestError
from kamutan_drawing.parse.dxf import expanded_entity_count, extract_page, load_doc, page_layouts

from .fuzz import gen


def _doc(tmp_path: Path, data: bytes):
    p = tmp_path / "x.dxf"
    p.write_bytes(data)
    return load_doc(str(p))


def test_empty_file_is_unreadable(tmp_path: Path) -> None:  # F-1
    with pytest.raises(IngestError) as e:
        _doc(tmp_path, b"")
    assert e.value.code == "file_unreadable"


def test_document_without_entities_is_unreadable(tmp_path: Path) -> None:
    doc = _doc(tmp_path, gen.dxf_doc())
    with pytest.raises(IngestError) as e:
        page_layouts(doc)
    assert e.value.code == "file_unreadable"


@pytest.mark.parametrize("cycle", [1, 3])
def test_cyclic_blocks_are_too_complex(tmp_path: Path, cycle: int) -> None:  # F-2
    doc = _doc(tmp_path, gen.dxf_recursive_blocks(cycle))
    t0 = time.monotonic()
    with pytest.raises(IngestError) as e:
        extract_page(doc, 0)
    assert e.value.code == "too_complex" and time.monotonic() - t0 < 2


def test_block_fanout_is_too_complex_before_exploding(tmp_path: Path) -> None:  # F-3
    doc = _doc(tmp_path, gen.dxf_fanout_blocks(9, 10))  # 10^9 virtual entities from ~1 KB
    t0 = time.monotonic()
    with pytest.raises(IngestError) as e:
        extract_page(doc, 0)
    assert e.value.code == "too_complex" and time.monotonic() - t0 < 2


def test_moderate_fanout_is_counted_exactly(tmp_path: Path) -> None:
    doc = _doc(tmp_path, gen.dxf_fanout_blocks(3, 10))
    layout = page_layouts(doc)[0][1]
    n = expanded_entity_count(doc, layout)
    assert n == 1000 + 1111  # 10^3 lines + 1 + 10 + 100 + 1000 INSERT entities
