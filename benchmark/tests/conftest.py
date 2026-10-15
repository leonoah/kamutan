from __future__ import annotations

from pathlib import Path

import pytest

from kbench.data import Feature

FIX = Path(__file__).parent / "fixtures" / "synthetic"


@pytest.fixture
def fixture_dirs() -> tuple[Path, Path]:
    return FIX / "truth", FIX / "pred"


def make_box(
    fid: str, x: float, y: float, w: float = 4.0, h: float = 4.0, cls: str = "socket_single", sheet: str = "S1", **props
) -> Feature:
    p = {
        "id": fid,
        "class": cls,
        "floor": "ground",
        "lifecycle": "new",
        "supply": "contractor",
        "annotator": "synthetic",
        "status": "verified",
    }
    p.update(props)
    coords = [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]]
    return Feature(id=fid, sheet_id=sheet, cls=cls, geom_type="Polygon", coords=coords, props=p)


def make_point(fid: str, x: float, y: float, cls: str = "socket_single", **props) -> Feature:
    p = {
        "id": fid,
        "class": cls,
        "floor": "ground",
        "lifecycle": "new",
        "supply": "contractor",
        "annotator": "synthetic",
        "status": "verified",
    }
    p.update(props)
    return Feature(id=fid, sheet_id="S1", cls=cls, geom_type="Point", coords=[x, y], props=p)
