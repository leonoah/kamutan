"""DXF path feasibility: ezdxf installs and round-trips real Hebrew TEXT and blocks.

(DWG needs LibreDWG `dwg2dxf`, not available in this sandbox - see NOTES.md.)
"""

import pytest

ezdxf = pytest.importorskip("ezdxf")


def test_ezdxf_hebrew_text_and_block_roundtrip(tmp_path):
    doc = ezdxf.new("R2018")
    blk = doc.blocks.new(name="SOCKET")
    blk.add_circle((0, 0), radius=2)
    msp = doc.modelspace()
    msp.add_text("שקע כח", dxfattribs={"height": 2.5, "layer": "TEXT"}).set_placement((10, 10))
    msp.add_blockref("SOCKET", (50, 20))
    p = tmp_path / "t.dxf"
    doc.saveas(p)
    d2 = ezdxf.readfile(p)
    texts = [e.dxf.text for e in d2.modelspace().query("TEXT")]
    refs = [e.dxf.name for e in d2.modelspace().query("INSERT")]
    assert texts == ["שקע כח"]
    assert refs == ["SOCKET"]
