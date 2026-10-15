"""Worker-artifact adapter + evaluation (kamutan.detections/1, kamutan.rooms/1, kamutan.legend/1) on synthetic data."""

from __future__ import annotations

import gzip
import json
import os
import time
from pathlib import Path
from typing import Any

import pytest

from kbench.cli import main
from kbench.data import load_project
from kbench.matching import MatchParams
from kbench.metrics import EvalConfig
from kbench.stats import wilson_lower
from kbench.worker import (
    WorkerEvalConfig,
    detections_to_features,
    evaluate_worker,
    find_artifacts,
    legend_summary,
    load_truth_legends,
    load_worker_predictions,
    map_sheet_id,
    norm_name,
    render_worker_markdown,
    rooms_to_features,
)

SID = "aaaa1111"
WID = "noah-aaaa1111-p0"


def _props(fid: str, cls: str, **kw: Any) -> dict[str, Any]:
    p = {
        "id": fid,
        "class": cls,
        "kind": "symbol",
        "floor": "ground",
        "lifecycle": "new",
        "supply": "contractor",
        "annotator": "synthetic",
        "status": "draft-verified",
        "room_id": "R1",
    }
    p.update(kw)
    return p


def _pt(fid: str, x: float, y: float, cls: str, **kw: Any) -> dict[str, Any]:
    return {
        "type": "Feature",
        "id": fid,
        "geometry": {"type": "Point", "coordinates": [x, y]},
        "properties": _props(fid, cls, **kw),
    }


def _room(fid: str, rid: str, ring: list[list[float]], name: str, names: list[str]) -> dict[str, Any]:
    props = _props(fid, "room", kind="area", room_id=rid, name=name, names=names)
    return {"type": "Feature", "id": fid, "geometry": {"type": "Polygon", "coordinates": [ring]}, "properties": props}


def _sq(x0: float, y0: float, x1: float, y1: float) -> list[list[float]]:
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]


def write_truth(root: Path) -> Path:
    feats = [
        _pt(f"{SID}-socket_single-1", 10.0, 10.0, "socket_single", symbol_class="socket_single"),
        _pt(f"{SID}-socket_triple-1", 30.0, 10.0, "socket_triple", symbol_class="socket_double"),
        _pt(f"{SID}-socket_box_6-1", 50.0, 10.0, "socket_box_6", symbol_class=None, evidence="text_callout"),
        _pt(f"{SID}-switch_single-1", 70.0, 10.0, "switch_single", symbol_class="switch_single", floor="first", room_id="R2"),
        _room(f"{SID}-room-R1", "R1", _sq(0, 0, 60, 40), "סלון", ["סלון", "פינת אוכל"]),
        _room(f"{SID}-room-R2", "R2", _sq(60, 0, 100, 40), "ח. שינה", ["ח. שינה"]),
    ]
    obj = {
        "type": "FeatureCollection",
        "kamutan": {"schema_version": "1.0", "project_id": "t", "sheet_id": SID, "units": "mm", "y_axis": "down", "scale": 50},
        "features": feats,
    }
    (root / "sheets").mkdir(parents=True)
    (root / "sheets" / f"{SID}.geojson").write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
    leg = {
        "type": "FeatureCollection",
        "kamutan": {"schema_version": "1.0", "project_id": "t", "sheet_id": SID, "units": "mm", "y_axis": "down"},
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [_sq(200, 10, 206, 15)]},
                "properties": {
                    "class": "legend_entry",
                    "legend_class": "socket_single",
                    "label": "שקע בודד",
                    "symbol_bbox_mm": {"x": 200, "y": 10, "w": 6, "h": 5},
                },
            },
            {
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [_sq(200, 20, 206, 25)]},
                "properties": {
                    "class": "legend_entry",
                    "legend_class": "socket_power",
                    "label": "שקע כח",
                    "symbol_bbox_mm": {"x": 200, "y": 20, "w": 6, "h": 5},
                },
            },
        ],
    }
    (root / "legends").mkdir()
    (root / "legends" / f"legend_{SID}.geojson").write_text(json.dumps(leg, ensure_ascii=False), encoding="utf-8")
    return root


def _det(n: int, x: float, y: float, cls: str, level: str = "green", score: float = 0.9, **kw: Any) -> dict[str, Any]:
    d: dict[str, Any] = {
        "id": f"d_{n}",
        "class": cls,
        "legendEntryId": None,
        "centerMm": {"x": x, "y": y},
        "bboxMm": {"x": x - 2, "y": y - 2, "w": 4, "h": 4},
        "angleDeg": 0,
        "score": score,
        "level": level,
        "reasons": [],
        "roomId": "r_1",
        "floor": "ground",
        "lifecycle": "new",
        "supply": None,
        "annotations": [],
        "clusterId": None,
    }
    d.update(kw)
    return d


def write_gz(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(json.dumps(obj, ensure_ascii=False).encode("utf-8")))


def write_pred(root: Path, dets: list[dict[str, Any]], rooms: list[dict[str, Any]] | None = None, version: str = "v1") -> Path:
    base = root / "orgs" / "o" / "projects" / "p" / "sheets" / WID / "versions" / version
    write_gz(base / "detections.json.gz", {"schema": "kamutan.detections/1", "detections": dets, "unknownClusters": []})
    if rooms is not None:
        write_gz(base / "rooms.json.gz", {"schema": "kamutan.rooms/1", "rooms": rooms})
    write_gz(
        base / "legend.json.gz",
        {
            "schema": "kamutan.legend/1",
            "legends": [],
            "entries": [
                {
                    "id": "le_1",
                    "symbolBboxMm": {"x": 200.5, "y": 10.2, "w": 6, "h": 5},
                    "label": "שקע בודד",
                    "suggestedClass": "socket_single",
                },
                {"id": "le_2", "symbolBboxMm": {"x": 230, "y": 60, "w": 6, "h": 5}, "label": "x", "suggestedClass": "speaker"},
            ],
        },
    )
    return base


def _room_pred(rid: str, ring: list[list[float]], name: str, area: float) -> dict[str, Any]:
    return {
        "id": rid,
        "name": name,
        "nameConfidence": 0.9,
        "floor": "ground",
        "polygonMm": [{"x": x, "y": y} for x, y in ring[:-1]],
        "areaM2": area,
        "perimeterM": 0.0,
        "confidence": 0.7,
        "level": "yellow",
        "reasons": ["x"],
    }


# ----------------------------------------------------------------------------- unit


def test_map_sheet_id() -> None:
    assert map_sheet_id(WID, {SID, "bbbb2222"}) == SID
    assert map_sheet_id("x", {SID}, {"x": SID}) == SID
    assert map_sheet_id(SID, {SID}) == SID
    assert map_sheet_id("noah-cccc3333-p0", {SID}) == "cccc3333"


def test_find_artifacts_newest_version(tmp_path: Path) -> None:
    old = write_pred(tmp_path, [_det(1, 1, 1, "socket_single")], version="v1")
    new = write_pred(tmp_path, [_det(1, 1, 1, "socket_single")], version="v2")
    t = time.time()
    os.utime(old / "detections.json.gz", (t - 100, t - 100))
    found = find_artifacts(tmp_path, "detections.json.gz")
    assert list(found) == [WID]
    assert found[WID] == new / "detections.json.gz"
    flat = tmp_path / "flat"
    write_gz(flat / SID / "detections.json.gz", {"schema": "kamutan.detections/1", "detections": []})
    assert list(find_artifacts(flat, "detections.json.gz")) == [SID]


def test_detection_mapping() -> None:
    d = _det(7, 12.5, 30.0, "socket_power", level="yellow", score=0.6, roomId="r_3", lifecycle="existing", annotations=["2X"])
    del d["centerMm"]
    (f,) = detections_to_features({"schema": "kamutan.detections/1", "detections": [d]}, SID)
    assert f.geom_type == "Point" and f.center == (12.5, 30.0)  # bbox centre fallback
    assert f.cls == "socket_power" and f.get("symbol_class") == "socket_power"
    assert f.get("confidence") == 0.6 and f.get("level") == "yellow"
    assert f.get("room_id") == "r_3" and f.get("lifecycle") == "existing" and f.get("annotations") == ["2X"]
    with pytest.raises(ValueError, match="schema"):
        detections_to_features({"schema": "other", "detections": []}, SID)


def test_rooms_mapping() -> None:
    (r,) = rooms_to_features({"schema": "kamutan.rooms/1", "rooms": [_room_pred("r_1", _sq(0, 0, 10, 10), "a", 0.25)]}, SID)
    assert r.geom_type == "Polygon" and r.coords[0][0] == r.coords[0][-1]
    assert r.get("area_m2") == 0.25 and r.get("worker_room_id") == "r_1"


def test_norm_name() -> None:
    assert norm_name("ח. שינה") == norm_name("ח.שינה") == norm_name(" ח שינה ")


# ----------------------------------------------------------------------------- evaluation


def _eval(
    tmp_path: Path, dets: list[dict[str, Any]], rooms: list[dict[str, Any]] | None = None, tol: float = 3.0
) -> dict[str, Any]:
    truth = load_project(write_truth(tmp_path / "truth"))
    write_pred(tmp_path / "pred", dets, rooms)
    preds = load_worker_predictions(tmp_path / "pred", set(truth.sheets))
    cfg = WorkerEvalConfig(base=EvalConfig(match=MatchParams(center_tol_mm=tol)))
    return evaluate_worker(truth, preds, cfg, load_truth_legends(tmp_path / "truth" / "legends"))


def test_center_tolerance(tmp_path: Path) -> None:
    dets = [_det(1, 12.9, 10.0, "socket_single"), _det(2, 33.1, 10.0, "socket_triple")]  # 2.9 mm and 3.1 mm away
    m = _eval(tmp_path, dets)
    pc = m["symbols"]["detection"]["per_class"]
    assert pc["socket_single"]["tp"] == 1
    assert pc["socket_triple"]["tp"] == 0 and pc["socket_triple"]["fp"] == 1 and pc["socket_triple"]["fn"] == 1
    m4 = _eval(tmp_path / "b", dets, tol=4.0)
    assert m4["symbols"]["detection"]["per_class"]["socket_triple"]["tp"] == 1


def test_semantic_vs_glyph_level(tmp_path: Path) -> None:
    # the worker sees the triple's glyph (legend row "socket_double"): wrong semantically, right at glyph level
    dets = [_det(1, 10, 10, "socket_single"), _det(2, 30, 10, "socket_double"), _det(3, 70, 10, "switch_single", floor="first")]
    m = _eval(tmp_path, dets)
    sem = m["symbols"]["detection"]
    assert sem["per_class"]["socket_double"]["fp"] == 1 and sem["per_class"]["socket_triple"]["fn"] == 1
    assert sem["confusion"]["socket_triple"]["socket_double"] == 1
    assert sem["per_class"]["socket_box_6"]["fn"] == 1  # text callout is an item semantically
    gl = m["symbols_glyph_level"]
    assert gl["detection"]["micro"] == {**gl["detection"]["micro"], "tp": 3, "fp": 0, "fn": 0}
    assert gl["n_truth_text_only_excluded"] == 1
    counts = {(r["floor"], r["class"]): (r["truth"], r["pred"]) for r in m["symbols"]["counts"]}
    assert counts[("ground", "socket_triple")] == (1, 0) and counts[("ground", "socket_double")] == (0, 1)
    assert counts[("first", "switch_single")] == (1, 1)


def test_green_precision_and_burden(tmp_path: Path) -> None:
    dets = [
        _det(1, 10, 10, "socket_single", level="green", score=0.95),
        _det(2, 30, 10, "socket_double", level="green", score=0.9),  # class wrong
        _det(3, 70, 10, "switch_single", level="yellow", score=0.6, floor="first"),
        _det(4, 90, 30, "speaker", level="red", score=0.2),  # background FP
    ]
    m = _eval(tmp_path, dets)
    g = m["symbols"]["green"]
    assert g["n_green"] == 2 and g["detection_correct"]["k"] == 1
    assert g["detection_correct"]["wilson_lb95"] == pytest.approx(wilson_lower(1, 2))
    rb = m["symbols"]["review_burden"]
    assert rb["burden"] == pytest.approx(0.5) and rb["n_green"] == 2 and rb["n_red"] == 1
    lv = m["symbols"]["precision_by_level"]
    assert lv["red"]["p"] == 0.0 and lv["yellow"]["p"] == 1.0


def test_rooms_iou_area_name_and_room_remap(tmp_path: Path) -> None:
    rooms = [
        _room_pred("r_1", _sq(0, 0, 59, 40), "פינת אוכל", 5.9),  # IoU 59/60
        _room_pred("r_2", _sq(60, 0, 100, 20), "ח.שינה", 2.0),  # IoU 0.5 -> matched (>= 0.5)
        _room_pred("r_9", _sq(200, 200, 210, 210), "x", 0.25),
    ]
    dets = [
        _det(1, 10, 10, "socket_single", roomId="r_1"),
        _det(2, 70, 10, "switch_single", roomId="r_9", floor="first"),
    ]
    m = _eval(tmp_path, dets, rooms)
    rm = m["rooms"]
    assert rm["n_truth"] == 2 and rm["n_pred"] == 3 and rm["n_matched"] == 2
    pairs = {p["truth_room_id"]: p for p in rm["per_sheet"][SID]["pairs"]}
    assert pairs["R1"]["iou"] == pytest.approx(59 / 60) and pairs["R1"]["name_correct"]
    assert pairs["R1"]["area_pe"] == pytest.approx(abs(5.9 - 6.0) / 6.0)  # truth area from polygon at 1:50
    assert pairs["R2"]["name_correct"]
    assert rm["per_sheet"][SID]["unmatched_pred"] == [f"{SID}:r_9"]
    ic = m["symbols"]["items_correct"]
    assert ic["room_accuracy_measured_not_gated"] == pytest.approx(0.5)  # r_1 -> R1 right, r_9 unmatched


def test_legend_summary(tmp_path: Path) -> None:
    m = _eval(tmp_path, [])
    lg = m["legend"]
    assert lg["row_recall"] == 0.5 and lg["entry_precision"] == 0.5
    assert lg["class_accuracy"] == 1.0 and lg["label_exact_rate"] == 1.0
    assert lg["per_sheet"][SID]["missed_rows"] == ["socket_power"]
    assert legend_summary({}, {}, 4.0)["row_recall"] is None


def test_legend_match_inside_truth_box() -> None:
    row = {"properties": {"legend_class": "tv_point", "label": "TV", "symbol_bbox_mm": {"x": 40, "y": 0, "w": 16, "h": 5}}}
    pred = {"entries": [{"symbolBboxMm": {"x": 53, "y": 1, "w": 3, "h": 3}, "label": "TV", "suggestedClass": "tv_point"}]}
    res = legend_summary({SID: [row]}, {SID: pred}, 4.0)  # centres 6.5 mm apart, but inside the truth box
    assert res["row_recall"] == 1.0 and res["class_accuracy"] == 1.0


def test_missing_sheet_excluded_by_default(tmp_path: Path) -> None:
    truth = load_project(write_truth(tmp_path / "truth"))
    (tmp_path / "pred").mkdir()
    preds = load_worker_predictions(tmp_path / "pred", set(truth.sheets))
    m = evaluate_worker(truth, preds)
    assert m["sheets"]["symbols"] == [] and m["sheets"]["missing_predictions"] == [SID]
    m2 = evaluate_worker(truth, preds, WorkerEvalConfig(include_missing_sheets=True))
    assert m2["symbols"]["detection"]["micro"]["fn"] == 4
    assert "Symbols" in render_worker_markdown(m2)


def test_cli_pred_detections(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    write_truth(tmp_path / "truth")
    write_pred(tmp_path / "pred", [_det(1, 10.5, 10, "socket_single")], [_room_pred("r_1", _sq(0, 0, 60, 40), "סלון", 6.0)])
    out, rep = tmp_path / "m.json", tmp_path / "r.md"
    rc = main(
        [
            "eval",
            "--truth",
            str(tmp_path / "truth"),
            "--pred-detections",
            str(tmp_path / "pred"),
            "--out",
            str(out),
            "--report",
            str(rep),
        ]
    )
    assert rc == 0
    m = json.loads(out.read_text(encoding="utf-8"))
    assert m["symbols"]["detection"]["per_class"]["socket_single"]["tp"] == 1
    assert m["rooms"]["n_matched"] == 1 and m["rooms"]["mean_iou"] == pytest.approx(1.0)
    assert "micro-F1" in capsys.readouterr().out
    assert "## Rooms" in rep.read_text(encoding="utf-8")
    assert main(["eval", "--truth", str(tmp_path / "truth"), "--out", str(out)]) == 2


def test_glyph_map_maps_semantic_predictions(tmp_path: Path) -> None:
    # a worker that already predicts the semantic class (socket_triple) is scored as the glyph it saw
    dets = [_det(1, 10, 10, "socket_single"), _det(2, 30, 10, "socket_triple"), _det(3, 70, 10, "switch_single", floor="first")]
    m = _eval(tmp_path, dets)
    gl = m["symbols_glyph_level"]
    assert gl["pred_class_to_glyph"] == {"socket_triple": "socket_double"}
    assert gl["detection"]["per_class"]["socket_double"]["tp"] == 1
    assert m["symbols"]["detection"]["per_class"]["socket_triple"]["tp"] == 1


def test_room_types() -> None:
    from kbench.worker import room_types

    assert room_types("ח.שינה 2") == room_types("חדר שינה") == {"bedroom"}
    assert room_types("ש.אורחים") == room_types("שירותים") == {"wc"}
    assert room_types("סלון / פינת אוכל") == {"living", "dining"}
    assert room_types("ח.רחצה כללי") == {"bath"}
    assert room_types("") == set()


def test_ambiguous_glyph_resolved_by_nearest_truth(tmp_path: Path) -> None:
    from kbench.data import Feature, Project, Sheet
    from kbench.worker import resolve_ambiguous_glyphs

    def pt(fid: str, x: float, cls: str, glyph: str | None = None) -> Feature:
        return Feature(fid, SID, cls, "Point", [x, 0.0], {"id": fid, "class": cls, "kind": "symbol", "symbol_class": glyph})

    truth = Project(root=None)
    truth.sheets[SID] = Sheet(
        SID, {}, [pt("t1", 0, "luminaire_outdoor", "luminaire_wall"), pt("t2", 50, "luminaire_outdoor", "luminaire_ceiling")]
    )
    pred = Project(root=None)
    pred.sheets[SID] = Sheet(
        SID, {}, [pt("p1", 1, "luminaire_outdoor"), pt("p2", 51, "luminaire_outdoor"), pt("p3", 99, "luminaire_outdoor")]
    )
    assert resolve_ambiguous_glyphs(truth, pred, {}, 3.0) == 2
    assert [f.cls for f in pred.sheets[SID].features] == ["luminaire_wall", "luminaire_ceiling", "luminaire_outdoor"]
