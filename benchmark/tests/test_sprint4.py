"""Sprint 4: plumbing fixtures, implied plumbing BOQ, tiling rooms + expected tiling, tolerance-aware BOQ lines.

Synthetic data only.
"""

from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Any

import pytest
from conftest import make_point

from kbench.boq_lines import evaluate_boq_lines, render_boq_markdown
from kbench.cli import main
from kbench.data import Project, Sheet, load_classes
from kbench.plumbing import compare_implied, fixture_classes, implied_plumbing, render_implied_markdown
from kbench.tiling import (
    TilingRules,
    expected_lines,
    match_openings,
    render_tiling_markdown,
    types_of,
)

SID = "aaaa1111"


def _pt(fid: str, x: float, y: float, cls: str, **props: Any):
    f = make_point(fid, x, y, cls=cls, kind="symbol", authoritative=True, **props)
    f.sheet_id = SID
    return f


def _room(rid: str, ring: list[list[float]], names: list[str], floor: str = "first"):
    from kbench.data import Feature

    return Feature(
        id=f"{SID}-room-{rid}",
        sheet_id=SID,
        cls="room",
        geom_type="Polygon",
        coords=[ring + [ring[0]]],
        props={
            "id": f"{SID}-room-{rid}",
            "class": "room",
            "kind": "area",
            "room_id": rid,
            "name": names[0],
            "names": names,
            "floor": floor,
        },
    )


def test_classes_sprint4() -> None:
    c = load_classes()
    for k in (
        "fixture_shower",
        "fixture_bath",
        "fixture_kitchen_sink",
        "fixture_washing_machine",
        "garden_tap",
        "fixture_wc_concealed",
        "fixture_wc_monoblock",
        "fixture_basin",
        "faucet_basin",
        "faucet_wall",
    ):
        assert c[k]["domain"] == "plumbing" and c[k]["he"]
    assert c["ac_unit"]["domain"] == "hvac"
    assert "ac_unit" in fixture_classes() and "socket_single" not in fixture_classes()


def _plumbing_truth() -> Project:
    feats = [
        _room("master-bath", [[0, 0], [40, 0], [40, 40], [0, 40]], ["ח.רחצה הורים"]),
        _room("bath", [[50, 0], [90, 0], [90, 40], [50, 40]], ["ח.רחצה כללי"]),
        _pt("b1", 10, 10, "fixture_basin", room_id="master-bath"),
        _pt("fw1", 12, 10, "faucet_wall", room_id="master-bath"),
        _pt("b2", 60, 10, "fixture_basin", room_id="bath"),
        _pt("b3", 70, 10, "fixture_basin", room_id="bath", faucet="wall"),
        _pt("k1", 100, 10, "fixture_kitchen_sink"),
        _pt("s1", 20, 30, "fixture_shower", room_id="master-bath"),
        _pt("s2", 120, 30, "fixture_shower", floor="basement"),
        _pt("t1", 60, 30, "fixture_bath", room_id="bath"),
        _pt("w1", 30, 5, "fixture_wc_concealed"),
        _pt("w2", 130, 5, "fixture_wc_monoblock"),
        _pt("m1", 140, 5, "fixture_washing_machine"),
        _pt("g1", 150, 5, "garden_tap"),
        _pt("a1", 160, 5, "ac_unit"),
        _pt("a2", 170, 5, "ac_unit"),
        _pt("x1", 180, 5, "fixture_shower"),  # first floor, no master keyword: unrouted
    ]
    dup = make_point("dup", 160, 5, cls="ac_unit", kind="symbol", authoritative=False)
    dup.sheet_id = "elec"
    lines = [
        {"code": c, "description": d, "unit": "יחידה", "quantity": q, "gt_status": "draft"}
        for c, d, q in [
            ("3.01", "ניקוז למזגן", 2),
            ("3.02", "ברז קיר", 2),
            ("3.03", "ברז פרח", 3),
            ("3.08", "הזנה", 1),
            ("3.11", "מקלחון הורים", 1),
            ("3.12", "אמבטיה כללי", 1),
            ("3.13", "מקלחון מרתף", 1),
        ]
    ]
    return Project(
        root=None,
        sheets={SID: Sheet(SID, {"sheet_id": SID, "scale": 50}, feats), "elec": Sheet("elec", {"sheet_id": "elec"}, [dup])},
        boq={"lines": lines},
    )


def test_implied_plumbing_rules() -> None:
    t = _plumbing_truth()
    imp = implied_plumbing(t)
    c = imp["counts"]
    assert c["3.01"] == 2  # the non-authoritative electrical copy is not counted
    assert c["3.02"] == 2 and c["3.03"] == 2  # b1 (faucet within 5 mm) + b3 (faucet=wall); b2 + kitchen sink
    assert c["3.04"] == 1 and c["3.07"] == 1 and c["3.05"] == 1 and c["3.06"] == 1
    assert c["3.11"] == 1 and c["3.12"] == 1 and c["3.13"] == 1
    assert imp["unrouted"] == ["x1"]
    rows = {r["code"]: r for r in compare_implied(t, imp)}
    assert rows["3.03"]["diff"] == -1 and rows["3.08"]["implied"] is None
    assert "n/a" in render_implied_markdown(list(rows.values()), imp)


def _write_gz(p: Path, obj: Any) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(gzip.compress(json.dumps(obj, ensure_ascii=False).encode("utf-8")))


def _write_truth_dir(root: Path, feats: list[dict[str, Any]]) -> None:
    (root / "sheets").mkdir(parents=True, exist_ok=True)
    (root / "sheets" / f"{SID}.geojson").write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "kamutan": {"sheet_id": SID, "scale": 50, "units": "mm", "y_axis": "down"},
                "features": feats,
            }
        ),
        encoding="utf-8",
    )


def _gfeat(fid: str, x: float, y: float, cls: str, **props: Any) -> dict[str, Any]:
    p = {
        "id": fid,
        "class": cls,
        "kind": "symbol",
        "floor": "ground",
        "lifecycle": "new",
        "supply": "contractor",
        "status": "draft-verified",
        "authoritative": True,
    } | props
    return {"type": "Feature", "id": fid, "geometry": {"type": "Point", "coordinates": [x, y]}, "properties": p}


def test_cli_eval_fixtures(tmp_path: Path) -> None:
    gt = tmp_path / "gt"
    _write_truth_dir(
        gt,
        [
            _gfeat("f1", 10, 10, "fixture_basin"),
            _gfeat("f2", 50, 10, "fixture_wc_concealed"),
            _gfeat("f3", 90, 10, "ac_unit"),
            _gfeat("s1", 20, 20, "socket_single"),
        ],
    )
    dets = [
        {"id": "d1", "class": "fixture_basin", "centerMm": {"x": 11, "y": 10}, "score": 0.9, "level": "green"},
        {"id": "d2", "class": "fixture_wc_monoblock", "centerMm": {"x": 50, "y": 11}, "score": 0.6, "level": "yellow"},
        {"id": "d3", "class": "socket_single", "centerMm": {"x": 20, "y": 20}, "score": 0.9, "level": "green"},
        {"id": "d4", "class": "fixture_shower", "centerMm": {"x": 200, "y": 20}, "score": 0.5, "level": "red"},
    ]
    _write_gz(tmp_path / "art" / SID / "detections.json.gz", {"schema": "kamutan.detections/1", "detections": dets})
    out = tmp_path / "f.json"
    assert (
        main(
            [
                "eval-fixtures",
                "--truth",
                str(gt),
                "--pred-detections",
                str(tmp_path / "art"),
                "--out",
                str(out),
                "--report",
                str(tmp_path / "f.md"),
            ]
        )
        == 0
    )
    m = json.loads(out.read_text(encoding="utf-8"))
    det = m["symbols"]["detection"]
    assert det["per_class"]["fixture_basin"]["tp"] == 1
    assert det["per_class"]["ac_unit"]["fn"] == 1
    assert det["per_class"]["fixture_shower"]["fp"] == 1
    assert "socket_single" not in det["per_class"]  # electrical classes are out of this subset
    assert det["micro"]["tp"] == 1 and det["micro"]["fp"] == 2 and det["micro"]["fn"] == 2
    assert "plumbing fixtures" in (tmp_path / "f.md").read_text(encoding="utf-8")


def _tiling() -> dict[str, Any]:
    return {
        "schema": "kamutan.tiling-truth/1",
        "scale": 50,
        "rooms": [
            {
                "room_id": "bath",
                "sheet_id": SID,
                "floor": "first",
                "type": "bathroom",
                "wet": True,
                # 40 x 40 mm at 1:50 = 2 x 2 m, with a 10 x 10 mm niche bite -> reflex corner
                "polygon_mm": [[0, 0], [40, 0], [40, 30], [30, 30], [30, 40], [0, 40]],
                "area_m2": 3.75,
                "perimeter_m": 8.0,
                "external_corners": 1,
                "ceiling_height_m": 2.65,
                "sub_areas_m2": {"laundry_niche": 0.25},
                "sub_polygons_mm": {"laundry_niche": [[30, 0], [40, 0], [40, 10], [30, 10]]},
                "openings": [
                    {"kind": "door", "width_m": 0.7, "center_mm": [15, 40]},
                    {"kind": "window", "width_m": 1.0, "center_mm": [0, 20]},
                ],
            },
            {
                "room_id": "yard",
                "sheet_id": SID,
                "floor": "basement",
                "type": "courtyard",
                "wet": False,
                "polygon_mm": [[100, 0], [140, 0], [140, 20], [100, 20]],
                "area_m2": 2.0,
                "perimeter_m": 6.0,
                "external_corners": 0,
                "ceiling_height_m": None,
                "sub_areas_m2": {"landing": 0.5},
                "openings": [],
            },
        ],
    }


def test_expected_lines_rules() -> None:
    t = _tiling()
    e = expected_lines(t, TilingRules(cladding_height_m=2.5, clad_niches=True))["lines"]
    # 8.0 * 2.5 - door 0.7*2.1 - window 1.0*(2.1-1.0)
    assert e["5.01"] == pytest.approx(20.0 - 1.47 - 1.1, abs=0.01)
    assert e["5.03"] == pytest.approx(2.5) and e["5.05"] == 1.0 and e["5.02"] == pytest.approx(3.75)
    e2 = expected_lines(t, TilingRules(cladding_height_m=3.0, clad_niches=False, floor_courtyard="landing"))["lines"]
    # capped at the 2.65 ceiling; niche walls on the outline = 10 + 10 mm = 1.0 m
    assert e2["5.01"] == pytest.approx(7.0 * 2.65 - 0.7 * 2.1 - 1.0 * 1.1, abs=0.01)
    assert e2["5.02"] == pytest.approx(4.25)


def test_match_openings() -> None:
    t = [{"kind": "door", "width_m": 0.7, "center_mm": [15, 40]}, {"kind": "window", "width_m": 1.0, "center_mm": [0, 20]}]
    p = [
        {"kind": "door", "widthM": 0.75, "centerMm": {"x": 16, "y": 40}},
        {"kind": "window", "widthM": 1.2, "centerMm": {"x": 30, "y": 20}},
    ]
    m = match_openings(t, p, tol_mm=10, width_tol_m=0.05)
    assert m["n_matched"] == 1 and m["pairs"][0]["width_ok"] is True


def test_types_of() -> None:
    assert types_of("ח.רחצה הורים") == {"bathroom"}
    assert types_of("ש.אורחים") == {"wc"}
    assert types_of("חצר אנגלית") == {"courtyard"}
    assert types_of("סלון", "מטבח") == {"living", "kitchen"}


def test_cli_eval_tiling_rooms(tmp_path: Path) -> None:
    gt = tmp_path / "gt"
    _write_truth_dir(
        gt,
        [
            {
                "type": "Feature",
                "id": "r1",
                "geometry": {"type": "Polygon", "coordinates": [[[200, 0], [260, 0], [260, 40], [200, 40], [200, 0]]]},
                "properties": {
                    "id": "r1",
                    "class": "room",
                    "kind": "area",
                    "room_id": "bed",
                    "name": "ח.שינה",
                    "names": ["ח.שינה"],
                },
            }
        ],
    )
    (gt / "tiling").mkdir()
    (gt / "tiling" / "wet_rooms.json").write_text(json.dumps(_tiling()), encoding="utf-8")
    rooms = [
        {
            "id": "p1",
            "polygonMm": [{"x": x, "y": y} for x, y in [[0, 0], [40, 0], [40, 40], [0, 40]]],
            "type": "bathroom",
            "wet": True,
            "perimeterM": 8.2,
            "externalCorners": 0,
            "areaM2": 4.0,
            "openings": [{"kind": "door", "widthM": 0.7, "centerMm": {"x": 15, "y": 40}}],
        },
        {
            "id": "p2",
            "polygonMm": [{"x": x, "y": y} for x, y in [[200, 0], [260, 0], [260, 40], [200, 40]]],
            "type": "bathroom",
            "wet": True,
        },
    ]
    _write_gz(tmp_path / "art" / SID / "rooms.json.gz", {"schema": "kamutan.rooms/1", "rooms": rooms})
    out = tmp_path / "t.json"
    assert (
        main(
            [
                "eval-tiling-rooms",
                "--truth",
                str(gt),
                "--pred-rooms",
                str(tmp_path / "art"),
                "--out",
                str(out),
                "--report",
                str(tmp_path / "t.md"),
            ]
        )
        == 0
    )
    t = json.loads(out.read_text(encoding="utf-8"))["tiling_rooms"]
    assert t["n_truth_rooms"] == 3 and t["n_matched"] == 2
    assert t["type_accuracy"] == pytest.approx(0.5)  # bedroom predicted as bathroom
    assert t["n_pred_typed"] == 2 and t["type_accuracy_name_fallback"] == pytest.approx(0.5)
    assert t["wet"]["tp"] == 1 and t["wet"]["fp"] == 1 and t["wet"]["fn"] == 0
    assert t["openings"]["recall"] == pytest.approx(0.5) and t["openings"]["precision"] == pytest.approx(1.0)
    assert t["corners_ae_sum"] == 1
    assert "yard" in " ".join(t["unmatched_truth"])
    assert "rooms for tiling" in render_tiling_markdown({"tiling_rooms": t})


def test_boq_lines_tolerance_and_expected() -> None:
    truth = Project(
        root=None,
        boq={
            "lines": [
                {"code": "5.01", "unit": 'מ"ר', "quantity": 57.0, "category": "cladding", "gt_status": "draft"},
                {"code": "5.02", "unit": 'מ"ר', "quantity": 18.1, "category": "flooring", "gt_status": "draft"},
                {"code": "5.03", "unit": 'מ"א', "quantity": 15.6, "category": "length", "gt_status": "draft"},
                {"code": "5.05", "unit": "קומפלט", "quantity": 3.0, "category": "lump_sum", "gt_status": "draft"},
            ]
        },
    )
    pred = [
        {"code": "5.01", "qty": 58.5},
        {"code": "5.02", "qty": 18.6},
        {"code": "5.03", "qty": 15.6},
        {"code": "5.05", "qty": 4},
    ]
    b = evaluate_boq_lines(truth, pred, ("5.",), expected={"5.01": 57.63})["boq_lines"]
    r = {x["code"]: x for x in b["lines"]}
    assert r["5.01"]["within_tol"] and not r["5.01"]["exact"]  # 2.6% <= 3% cladding
    assert not r["5.02"]["within_tol"]  # 2.8% > 2% flooring
    assert r["5.03"]["exact"] and not r["5.05"]["within_tol"]
    assert r["5.01"]["pred_vs_expected_pe"] == pytest.approx(abs(58.5 - 57.63) / 57.63, abs=1e-6)
    assert b["gated"]["within_tolerance"]["k"] == 2
    assert "within tol" in render_boq_markdown({"boq_lines": b})


def test_transfers_translate_truth_rooms() -> None:
    from kbench.tiling import truth_rooms

    t = _tiling() | {"transfers": [{"sheet_id": "bbbb2222", "from": SID, "floor": "first", "d_mm": [100.0, 5.0]}]}
    proj = Project(root=None, sheets={SID: Sheet(SID, {"sheet_id": SID}, [])})
    tr = truth_rooms(proj, t)
    moved = tr["bbbb2222"]
    assert [r.room_id for r in moved] == ["bath"]  # the basement yard is on another floor
    assert moved[0].poly.bounds == (100.0, 5.0, 140.0, 45.0)
    assert moved[0].detail is not None and moved[0].detail["openings"][0]["center_mm"] == [115.0, 45.0]
