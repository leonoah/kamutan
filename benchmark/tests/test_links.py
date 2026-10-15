"""Link-group truth, worker adapter (kamutan.links/1), metrics and implied composite counts — synthetic data only."""

from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Any

import pytest

from kbench.cli import main
from kbench.data import load_project
from kbench.links import (
    CompositeRules,
    evaluate_links,
    evaluate_sheet_links,
    group_from_dict,
    implied_composite_counts,
    load_pred_links,
    load_truth_links,
    render_links_markdown,
)
from kbench.validate import lint_links, validate_project

SID = "aaaa1111"

# id: (x, y, class, lifecycle)
POINTS: dict[str, tuple[float, float, str, str]] = {
    "s1": (10, 10, "switch_single", "new"),
    "s2": (12, 10, "switch_single", "new"),
    "w1": (50, 10, "switch_2way", "new"),
    "w2": (90, 10, "switch_2way", "new"),
    "a1": (60, 60, "switch_2way", "new"),
    "f1": (70, 70, "switch_fan", "new"),
    "L1": (30, 30, "luminaire_ceiling", "new"),
    "L2": (40, 30, "luminaire_ceiling", "new"),
    "L3": (50, 30, "luminaire_ceiling", "new"),
    "L4": (70, 30, "luminaire_wall", "new"),
    "L5": (100, 50, "luminaire_outdoor", "new"),
    "F1": (60, 90, "ceiling_fan", "existing"),
    "X1": (120, 90, "luminaire_ceiling", "existing"),
    "L6": (20, 100, "luminaire_ceiling", "new"),
}

GROUPS = [
    {"id": "G1", "kind": "shared", "switchIds": ["s1"], "luminaireIds": ["L1", "L2"]},
    {"id": "G2", "kind": "single", "switchIds": ["s2"], "luminaireIds": ["L3"]},
    {"id": "G3", "kind": "two_way", "switchIds": ["w1", "w2"], "luminaireIds": ["L4"]},
    {"id": "G4", "kind": "sensor", "switchIds": [], "luminaireIds": ["L5"]},
    {"id": "G5", "kind": "add_to_existing", "switchIds": ["a1"], "luminaireIds": ["F1"]},
    {"id": "G6", "kind": "single", "switchIds": ["f1"], "luminaireIds": ["L6"], "dispute_id": "GT-D-900"},
]


def _write_truth(root: Path, groups: list[dict[str, Any]] | None = None, unlinked: list[str] | None = None) -> Path:
    (root / "sheets").mkdir(parents=True)
    feats = [
        {
            "type": "Feature",
            "id": f"{SID}-{k}",
            "geometry": {"type": "Point", "coordinates": [x, y]},
            "properties": {
                "id": f"{SID}-{k}",
                "class": c,
                "kind": "symbol",
                "floor": "ground",
                "lifecycle": lc,
                "supply": "contractor",
                "annotator": "synthetic",
                "status": "draft-verified",
            },
        }
        for k, (x, y, c, lc) in POINTS.items()
    ]
    (root / "sheets" / f"{SID}.geojson").write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "kamutan": {
                    "schema_version": "1.0",
                    "project_id": "syn",
                    "sheet_id": SID,
                    "units": "mm",
                    "y_axis": "down",
                    "scale": 50,
                    "input_type": "vector",
                    "scale_conflict": False,
                    "kind": "truth",
                },
                "features": feats,
            }
        ),
        encoding="utf-8",
    )
    gs = []
    for g in groups if groups is not None else GROUPS:
        g = dict(g)
        g["switchIds"] = [f"{SID}-{i}" for i in g["switchIds"]]
        g["luminaireIds"] = [f"{SID}-{i}" for i in g["luminaireIds"]]
        g["pointIds"] = [f"pt:{i}" for i in g["luminaireIds"]]
        gs.append(g)
    unl = [{"id": f"{SID}-{i}", "reason": "existing, no arc"} for i in (unlinked if unlinked is not None else ["X1"])]
    doc = {
        "schema_version": "1.0",
        "format": "kamutan.links-truth/1",
        "project_id": "syn",
        "sheet_id": SID,
        "kind": "truth",
        "gt_version": "t",
        "status": "draft-verified",
        "points": [{"id": p, "luminaireIds": [p[3:]]} for g in gs for p in g["pointIds"]],
        "groups": gs,
        "unlinked_luminaires": unl,
    }
    (root / "links").mkdir()
    (root / "links" / f"{SID}.json").write_text(json.dumps(doc), encoding="utf-8")
    (root / "disputes.json").write_text(
        json.dumps(
            {
                "schema_version": "1.0",
                "project_id": "syn",
                "disputes": [
                    {"id": "GT-D-900", "title": "t", "lines": [], "link_groups": ["G6"], "status": "open — awaiting owner"}
                ],
            }
        ),
        encoding="utf-8",
    )
    return root


def _write_pred(
    root: Path, groups: list[dict[str, Any]], offsets: dict[str, tuple[float, float]] | None = None, drop: set[str] | None = None
) -> Path:
    d = root / "orgs" / "o" / "projects" / "p" / "sheets" / f"noah-{SID}-p0" / "versions" / "v1"
    d.mkdir(parents=True)
    dets = []
    for k, (x, y, c, _lc) in POINTS.items():
        if drop and k in drop:
            continue
        dx, dy = (offsets or {}).get(k, (0.4, -0.3))
        dets.append({"id": f"d-{k}", "class": c, "centerMm": {"x": x + dx, "y": y + dy}, "score": 0.9, "level": "green"})
    with gzip.open(d / "detections.json.gz", "wt", encoding="utf-8") as f:
        json.dump({"schema": "kamutan.detections/1", "detections": dets}, f)
    pg = [
        {
            "id": g["id"],
            "kind": g["kind"],
            "switchIds": [f"d-{i}" for i in g["switchIds"]],
            "pointIds": [f"d-{i}" for i in g["luminaireIds"]],
            "luminaireIds": [f"d-{i}" for i in g["luminaireIds"]],
            "confidence": g.get("confidence", 0.9),
            "level": g.get("level", "green"),
            "reasons": g.get("reasons", []),
        }
        for g in groups
    ]
    with gzip.open(d / "links.json.gz", "wt", encoding="utf-8") as f:
        json.dump({"schema": "kamutan.links/1", "groups": pg}, f)
    return root


def _eval(tmp_path: Path, groups: list[dict[str, Any]], **kw: Any) -> dict[str, Any]:
    t = _write_truth(tmp_path / "t")
    p = _write_pred(tmp_path / "p", groups, **kw)
    docs = load_truth_links(t)
    return evaluate_links(docs, load_project(t), load_pred_links(p, set(docs)))["links"]


def test_truth_validates_and_lints(tmp_path: Path) -> None:
    t = _write_truth(tmp_path / "t")
    errors, _ = validate_project(t)
    assert errors == []


def test_lint_catches_double_and_orphan(tmp_path: Path) -> None:
    gs = [dict(g) for g in GROUPS]
    gs[1] = {"id": "G2", "kind": "single", "switchIds": ["s1"], "luminaireIds": ["L3"]}  # s1 twice, s2 orphan
    t = _write_truth(tmp_path / "t", gs, unlinked=[])  # X1 orphan
    errs = lint_links(t, {"GT-D-900"})
    assert any("s1 in G1 and G2" in e for e in errs)
    assert any("switch_single" not in e and f"{SID}-s2 is in no group" in e for e in errs)
    assert any(f"{SID}-X1 is in no group" in e for e in errs)


def test_perfect_prediction(tmp_path: Path) -> None:
    L = _eval(tmp_path, GROUPS)
    p = L["pooled"]
    assert p["group_exact_recall"]["p"] == 1.0 and p["group_exact_recall"]["n"] == 5  # disputed G6 not gated
    assert p["group_exact_precision"]["p"] == 1.0 and p["group_exact_precision"]["n"] == 5
    assert p["switch_assignment"]["k"] == p["switch_assignment"]["n"] == 5
    assert p["luminaire_assignment"]["n"] == 6
    assert p["kind_accuracy"]["p"] == 1.0
    assert p["green_precision"]["p"] == 1.0
    assert L["sheets"][SID]["disputed"][0]["exact"] is True
    assert "link groups" in render_links_markdown({"links": L})


def test_swapped_assignment_and_kind(tmp_path: Path) -> None:
    gs = [dict(g) for g in GROUPS[:5]]
    gs[0] = {"id": "P1", "kind": "shared", "switchIds": ["s1"], "luminaireIds": ["L1", "L2", "L3"]}  # L3 stolen
    gs[1] = {"id": "P2", "kind": "single", "switchIds": ["s2"], "luminaireIds": []}
    gs[2] = {"id": "P3", "kind": "single", "switchIds": ["w1", "w2"], "luminaireIds": ["L4"]}  # kind wrong
    L = _eval(tmp_path, gs)
    p = L["pooled"]
    assert p["group_exact_recall"]["k"] == 3  # G3 (sets equal, kind wrong), G4, G5
    assert p["switch_assignment"]["k"] == 3  # s1, s2 wrong
    assert p["kind_accuracy_exact_groups"]["k"] == 2
    assert p["green_precision"]["k"] == 3 and p["green_precision"]["n"] == 5
    kinds = [e for e in L["sheets"][SID]["errors"] if e["type"] == "kind"]
    assert any(e["truth_kind"] == "two_way" and e["pred_kind"] == "single" for e in kinds)


def test_detection_mapping_tolerance(tmp_path: Path) -> None:
    # luminaire L4 detected 5 mm off -> not mapped -> G3 cannot be exact; s1 not detected -> switch error
    L = _eval(tmp_path, GROUPS, offsets={"L4": (5.0, 0.0)}, drop={"s1"})
    s = L["sheets"][SID]
    assert s["group_exact"]["recall"]["k"] == 3
    types = {e["type"] for e in s["errors"]}
    assert "switch_wrong_points" in types  # w1/w2 see "?d-L4"
    assert any(e["type"] == "switch_not_detected" and e["id"] == f"{SID}-s1" for e in s["errors"])


def test_disputed_resolved_is_gated(tmp_path: Path) -> None:
    t = _write_truth(tmp_path / "t")
    d = json.loads((t / "disputes.json").read_text())
    d["disputes"][0]["status"] = "resolved"
    (t / "disputes.json").write_text(json.dumps(d))
    p = _write_pred(tmp_path / "p", GROUPS)
    docs = load_truth_links(t)
    L = evaluate_links(docs, load_project(t), load_pred_links(p, set(docs)))["links"]
    assert L["pooled"]["group_exact_recall"]["n"] == 6


def test_group_from_dict_unmapped() -> None:
    g = group_from_dict({"id": "x", "kind": "single", "switchIds": ["a"], "luminaireIds": ["b"]}, {"a": "A"})
    assert g.switches == frozenset({"A"}) and g.luminaires == frozenset({"?b"})
    m = evaluate_sheet_links([group_from_dict({"id": "t", "kind": "single", "switchIds": ["A"], "luminaireIds": ["B"]})], [g])
    assert m["group_exact"]["recall"]["k"] == 0


def test_implied_counts(tmp_path: Path) -> None:
    t = _write_truth(tmp_path / "t")
    docs = load_truth_links(t)
    res = implied_composite_counts(docs, load_project(t), CompositeRules())
    c = res["counts"]
    assert c["4.11"] == 1 and c["4.10"] == 1 and c["4.15"] == 1 and c["4.12"] == 1
    assert c["4.14"] == 1 and c["4.09"] == 2  # G2 + G6 (fan switch counted as 4.14, the rest of G6 is a single point)
    assert c["9.01"] == 7  # L1..L6 + X1 (fan F1 excluded)
    # three points on one switch -> 4.16; duplicate group skipped
    doc = docs[SID]
    doc["groups"][0]["luminaireIds"].append(f"{SID}-L3")
    doc["groups"][0]["pointIds"].append(f"pt:{SID}-L3")
    doc["groups"][2]["cross_sheet_duplicate_of"] = {"sheet_id": "zzz", "group_id": "Z1"}
    c2 = implied_composite_counts(docs, load_project(t))["counts"]
    assert c2["4.16"] == 1 and "4.10" not in c2
    assert c2["9.01"] == 7 + 1 - 1  # L3 now listed twice in groups, L4 is a cross-sheet duplicate


def test_implied_existing_rules(tmp_path: Path) -> None:
    gs = [{"id": "G1", "kind": "single", "switchIds": ["s1"], "luminaireIds": ["X1"]}]
    t = _write_truth(tmp_path / "t", gs, unlinked=[])
    docs = load_truth_links(t)
    doc = docs[SID]
    assert implied_composite_counts(docs, load_project(t))["counts"].get("4.09") == 1
    assert "4.09" not in implied_composite_counts(docs, load_project(t), CompositeRules(skip_all_existing_points=True))["counts"]
    assert doc["groups"][0]["kind"] == "single"


def test_alt_readings(tmp_path: Path) -> None:
    gs = [dict(g) for g in GROUPS]
    gs[5] = dict(
        gs[5],
        alt_readings=[
            {"label": "x", "groups": [{"switchIds": [f"{SID}-f1"], "luminaireIds": [f"{SID}-F1"], "kind": "add_to_existing"}]}
        ],
    )
    t = _write_truth(tmp_path / "t", gs)
    docs = load_truth_links(t)
    c = implied_composite_counts(docs, load_project(t), CompositeRules(use_alt_readings=True))["counts"]
    assert c["4.14"] == 1 and c["4.09"] == 1


def test_cli_eval_links_and_implied(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    t = _write_truth(tmp_path / "t")
    p = _write_pred(tmp_path / "p", GROUPS)
    out = tmp_path / "m.json"
    assert (
        main(["eval-links", "--truth", str(t), "--pred-links", str(p), "--out", str(out), "--report", str(tmp_path / "m.md")])
        == 0
    )
    assert json.loads(out.read_text())["links"]["pooled"]["group_exact_recall"]["p"] == 1.0
    assert main(["links-implied", "--truth", str(t), "--out", str(tmp_path / "i.json")]) == 0
    assert "4.11: implied 1" in capsys.readouterr().out
    assert main(["eval-links", "--truth", str(tmp_path), "--pred-links", str(p), "--out", str(out)]) == 2


def test_wrong_schema_rejected(tmp_path: Path) -> None:
    t = _write_truth(tmp_path / "t")
    p = _write_pred(tmp_path / "p", GROUPS)
    f = next(p.rglob("links.json.gz"))
    with gzip.open(f, "wt", encoding="utf-8") as fh:
        json.dump({"schema": "other", "groups": []}, fh)
    with pytest.raises(ValueError, match="kamutan.links/1"):
        load_pred_links(p, set(load_truth_links(t)))
