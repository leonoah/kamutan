"""Regenerate the SYNTHETIC fixtures (no real drawing content).

    uv run python tests/fixtures/make_fixtures.py

Hand-computed expected metrics for this fixture live in tests/test_metrics.py.
"""

from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).parent / "synthetic"


def box(x0, y0, x1, y1):
    return {"type": "Polygon", "coordinates": [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]}


def feat(fid, cls, geom, boq_code, kind="symbol", **extra):
    props = {
        "id": fid,
        "class": cls,
        "kind": kind,
        "legend_entry": None,
        "room_id": None,
        "floor": "ground",
        "lifecycle": "new",
        "supply": "contractor",
        "link_group": [],
        "boq_code": boq_code,
        "annotator": "synthetic",
        "status": "verified",
    }
    props.update(extra)
    return {"type": "Feature", "id": fid, "geometry": geom, "properties": props}


def sheet(kind, features):
    return {
        "type": "FeatureCollection",
        "kamutan": {
            "schema_version": "1.0",
            "project_id": "synth",
            "sheet_id": "S1",
            "page_size_mm": [420, 297],
            "units": "mm",
            "y_axis": "down",
            "scale": 50,
            "input_type": "vector",
            "kind": kind,
        },
        "features": features,
    }


def main() -> None:
    truth = sheet(
        "truth",
        [
            feat("g1", "socket_single", box(10, 10, 14, 14), "4.00"),
            feat("g2", "socket_single", box(30, 10, 34, 14), "4.00"),
            feat("g3", "socket_double", box(50, 10, 54, 14), "4.01"),
            feat("g4", "luminaire_ceiling", box(70, 10, 74, 14), "9.01"),
            feat("g5", "floor_tiling", box(100, 100, 140, 140), "5.02", kind="area", room_id="r1"),
            feat("g6", "socket_power", box(90, 10, 94, 14), "4.03"),
            feat("ctx", "region", box(0, 0, 200, 200), None, kind="context"),
        ],
    )
    pred = sheet(
        "prediction",
        [
            feat("p1", "socket_single", box(10.5, 10.5, 14.5, 14.5), "4.00", confidence=0.95, level="green"),
            feat("p2", "socket_double", box(30, 10, 34, 14), "4.01", confidence=0.6, level="yellow"),
            feat("p3", "socket_double", box(50.2, 10, 54.2, 14), "4.01", confidence=0.9, level="green"),
            feat("p4", "luminaire_ceiling", box(200, 200, 204, 204), "9.01", confidence=0.3, level="red"),
            feat(
                "p5", "floor_tiling", box(100, 100, 140, 140.5), "5.02", kind="area", room_id="r1", confidence=0.8, level="yellow"
            ),
            feat("p6", "socket_power", box(90, 10, 94, 14), "4.03", confidence=0.99, level="green"),
        ],
    )
    truth_boq = {
        "schema_version": "1.0",
        "project_id": "synth",
        "kind": "truth",
        "gt_version": "gt-synth-1",
        "lines": [
            {
                "code": "1.01",
                "description": "lump",
                "unit": "קומפלט",
                "quantity": 1,
                "gt_status": "confirmed",
                "derivation": "lump_sum",
            },
            {
                "code": "4.00",
                "description": "single",
                "unit": "יחידה",
                "quantity": 2,
                "evidence": ["g1", "g2"],
                "gt_status": "confirmed",
            },
            {
                "code": "4.01",
                "description": "double",
                "unit": "יחידה",
                "quantity": 1,
                "evidence": ["g3"],
                "gt_status": "confirmed",
            },
            {
                "code": "4.03",
                "description": "power",
                "unit": "יחידה",
                "quantity": 1,
                "evidence": ["g6"],
                "gt_status": "disputed",
                "dispute_id": "GT-D-001",
            },
            {"code": "4.10", "description": "draft line", "unit": "יחידה", "quantity": 5, "gt_status": "draft"},
            {
                "code": "5.02",
                "description": "flooring",
                "unit": 'מ"ר',
                "quantity": 4.0,
                "evidence": ["g5"],
                "gt_status": "confirmed",
                "category": "flooring",
                "derivation": "sum(area)",
            },
            {
                "code": "9.01",
                "description": "luminaires",
                "unit": "יחידה",
                "quantity": 1,
                "evidence": ["g4"],
                "gt_status": "confirmed",
            },
        ],
    }
    pred_boq = {
        "schema_version": "1.0",
        "project_id": "synth",
        "kind": "prediction",
        "lines": [
            {"code": "4.00", "description": "single", "unit": "יחידה", "quantity": 1},
            {"code": "4.01", "description": "double", "unit": "יחידה", "quantity": 2},
            {"code": "4.03", "description": "power", "unit": "יחידה", "quantity": 1},
            {"code": "4.1", "description": "wrong code text", "unit": "יחידה", "quantity": 5},
            {"code": "5.02", "description": "flooring", "unit": 'מ"ר', "quantity": 4.05},
            {"code": "7.77", "description": "extra", "unit": "יחידה", "quantity": 3},
            {"code": "9.01", "description": "luminaires", "unit": "יחידה", "quantity": 1},
        ],
    }
    disputes = {
        "schema_version": "1.0",
        "project_id": "synth",
        "disputes": [
            {
                "id": "GT-D-001",
                "title": "synthetic dispute",
                "lines": ["4.03"],
                "status": "open — awaiting owner",
                "resolution": None,
            }
        ],
    }
    for sub, sh, boq_name, boq in (("truth", truth, "boq_truth.json", truth_boq), ("pred", pred, "boq.json", pred_boq)):
        d = HERE / sub
        (d / "sheets").mkdir(parents=True, exist_ok=True)
        (d / "sheets" / "S1.geojson").write_text(json.dumps(sh, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        (d / boq_name).write_text(json.dumps(boq, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    (HERE / "truth" / "disputes.json").write_text(json.dumps(disputes, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
