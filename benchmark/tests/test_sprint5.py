"""Sprint 5: kbench calibrate (isotonic map, green rule, split guard, ceiling rules, table) and kbench perf."""

from __future__ import annotations

import gzip
import hashlib
import itertools
import json
import re
import stat
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from kbench.calibrate import (
    CalibrateConfig,
    CalItem,
    SplitError,
    apply_score_map,
    bucket_stats,
    calibrate,
    ceiling_checks,
    check_dev,
    check_table,
    collect_items,
    isotonic_fit,
    load_splits,
    loso_calibrated,
    render_calibration_markdown,
    table_version,
)
from kbench.cli import main
from kbench.data import load_project
from kbench.perf import PerfThresholds, build_result, gate, pct, render_perf_markdown, run_worker_perf, summarize
from kbench.stats import wilson_lower
from kbench.worker import load_worker_predictions

REPO = Path(__file__).resolve().parents[2]
WORKER_SCHEMA = REPO / "workers/drawing/src/kamutan_drawing/calibration/schema.json"
SID, WID = "aaaa1111", "noah-aaaa1111-p0"  # electrical sheet
PSID, PWID = "bbbb2222", "noah-bbbb2222-p0"  # plumbing sheet
ASID, AWID = "cccc3333", "noah-cccc3333-p0"  # architecture sheet (rooms)


# ----------------------------------------------------------------------------- isotonic map


def test_isotonic_pav_known_case() -> None:
    # classic PAV: y = 1 0 1 1 on increasing x -> blocks {1,0} pooled at 0.5, then 1, 1
    pts = isotonic_fit([0.1, 0.2, 0.3, 0.4], [1, 0, 1, 1])
    assert pts == [[0.1, 0.5], [0.2, 0.5], [0.3, 1.0], [0.4, 1.0]]
    assert apply_score_map(pts, 0.25) == pytest.approx(0.75)  # linear between blocks
    assert apply_score_map(pts, 0.0) == pytest.approx(0.5)  # flat outside
    assert apply_score_map(pts, 1.0) == pytest.approx(1.0)
    assert float(apply_score_map(None, 0.42)) == pytest.approx(0.42)  # no map = identity


def test_isotonic_ties_clamp_and_thinning() -> None:
    pts = isotonic_fit([0.5, 0.5, 0.5, 0.5, 1.7], [1, 0, 0, 0, 1])
    assert pts == [[0.5, 0.25], [1.0, 1.0]]  # ties pooled, x clamped to 1
    rng = np.random.default_rng(1)
    x = np.linspace(0, 1, 2000)
    y = rng.random(2000) < x
    thin = isotonic_fit(x, y, max_knots=16)
    assert len(thin) <= 16 and thin[0][0] == 0.0 and thin[-1][0] == 1.0


@settings(max_examples=60, deadline=None)
@given(st.lists(st.tuples(st.floats(0, 1), st.booleans()), min_size=1, max_size=60))
def test_isotonic_monotone_and_mean_preserving(data: list[tuple[float, bool]]) -> None:
    x = [d[0] for d in data]
    y = [float(d[1]) for d in data]
    pts = isotonic_fit(x, y)
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    assert xs == sorted(xs) and len(set(xs)) == len(xs)
    assert all(b >= a for a, b in itertools.pairwise(ys))
    assert all(0 <= v <= 1 for v in xs + ys)
    # PAV preserves the mean of the fitted values at the data points
    fitted = apply_score_map(pts, np.round(np.asarray(x), 6))
    assert float(np.mean(fitted)) == pytest.approx(float(np.mean(y)), abs=1e-5)


# ----------------------------------------------------------------------------- green rule / stats


def _items(n: int, n_wrong: int = 0, cls: str = "socket_single", domain: str = "electrical", sheet: str = "s") -> list[CalItem]:
    return [
        CalItem("p", sheet, f"{sheet}:{i}", cls, domain, i >= n_wrong, i >= n_wrong, 0.5 + 0.4 * i / max(n, 1), None, "yellow")
        for i in range(n)
    ]


def test_green_rule_conservative() -> None:
    cfg = CalibrateConfig()
    assert bucket_stats(_items(199), cfg)["greenAllowed"] is False  # too few
    s = bucket_stats(_items(200), cfg)
    assert s["greenAllowed"] is True and s["precision"] == 1.0 and s["fp"] == 0
    assert s["wilsonLb"] == pytest.approx(wilson_lower(200, 200), abs=1e-6)
    assert bucket_stats(_items(400, n_wrong=1), cfg)["greenAllowed"] is False  # precision < 1.0
    e = bucket_stats([], cfg)
    assert e == {"n": 0, "tp": 0, "fp": 0, "precision": None, "wilsonLb": None, "greenAllowed": False}
    # full mode: the Wilson LB decides
    assert bucket_stats(_items(400, n_wrong=1), cfg, mode="full")["greenAllowed"] is True
    assert bucket_stats(_items(100), cfg, mode="full")["greenAllowed"] is False


def test_calibrate_table_and_report() -> None:
    items = (
        _items(40, 10) + _items(5, 0, cls="panel", sheet="t") + _items(30, 3, cls="switch_single", domain="lighting", sheet="t")
    )
    table, rep = calibrate(items, CalibrateConfig(min_map_n=30), gt_version="gt-v9.9-draft", generated_at="2026-10-15T00:00:00Z")
    assert table["schema"] == "kamutan.calibration/1" and table["mode"] == "conservative"
    assert re.fullmatch(r"[A-Za-z0-9._-]{1,64}", table["version"]) and table["version"].startswith("cal-gt-v9.9-draft-")
    c = table["classes"]
    assert c["socket_single"]["n"] == 40 and c["socket_single"]["tp"] == 30 and c["socket_single"]["scoreMap"]
    assert c["panel"]["scoreMap"] is None  # n < min_map_n
    assert c["socket_double"] == {**c["socket_double"], "n": 0, "greenAllowed": False}  # taxonomy class without data
    assert set(table["domains"]) == {"electrical", "lighting", "plumbing", "tiling"}
    assert table["domains"]["electrical"]["n"] == 45
    assert not any(v["greenAllowed"] for v in c.values())
    assert check_table(table) == []
    assert rep["overall"]["raw"]["ece"] is not None and len(rep["overall"]["raw"]["bins"]) == 10
    md = render_calibration_markdown(table, rep)
    assert "| socket_single | electrical | 40 | 30 | 10 |" in md
    # reproducible: same items + generatedAt -> same table
    assert (
        calibrate(items, CalibrateConfig(min_map_n=30), gt_version="gt-v9.9-draft", generated_at="2026-10-15T00:00:00Z")[0]
        == table
    )


@pytest.mark.skipif(not WORKER_SCHEMA.exists(), reason="worker calibration schema not present")
def test_table_validates_against_worker_schema() -> None:
    schema = json.loads(WORKER_SCHEMA.read_text(encoding="utf-8"))
    table, _ = calibrate(_items(60, 5) + _items(250), CalibrateConfig(), gt_version="gt-v0.4.1-draft")
    assert check_table(table, schema) == []
    bad = json.loads(json.dumps(table))
    bad["version"] = "has+plus"
    bad["classes"]["socket_single"]["greenAllowed"] = True
    errs = check_table(bad, schema)
    assert any("schema" in e for e in errs) and any("conservative rule" in e for e in errs)


def test_loso_never_uses_own_sheet() -> None:
    # sheet A: all wrong at high score, sheet B: all right; LOSO map for A must come from B only
    a = [CalItem("p", "A", f"A{i}", "c", "electrical", False, False, 0.9, None, None) for i in range(40)]
    b = [CalItem("p", "B", f"B{i}", "c", "electrical", True, True, 0.9, None, None) for i in range(10)]
    b += [CalItem("p", "B", f"B{i + 10}", "c", "electrical", False, False, 0.2, None, None) for i in range(30)]
    cv = loso_calibrated(a + b, CalibrateConfig(min_map_n=30))
    assert cv[0] == pytest.approx(1.0)  # fitted on B: score 0.9 -> 1.0
    assert cv[40] == pytest.approx(0.9)  # B's training set (A only) has < 2 knots -> no map, raw score


def test_table_version_sanitised() -> None:
    v = table_version("gt v0.4+x/" + "a" * 80, "0123456789ab")
    assert re.fullmatch(r"[A-Za-z0-9._-]{1,64}", v) and v.endswith("-0123456789ab")


# ----------------------------------------------------------------------------- split guard


def _splits(path: Path, projects: dict[str, Any], holdout: list[str], tamper: bool = False) -> Path:
    h = hashlib.sha256(json.dumps(sorted(holdout)).encode()).hexdigest()
    doc = {"schema": "kamutan.gt-splits/1", "projects": projects, "holdout": holdout, "holdout_sha256": "0" * 64 if tamper else h}
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


def test_split_guard(tmp_path: Path) -> None:
    s = load_splits(_splits(tmp_path / "s.json", {"noah": {"split": "dev"}, "x": {"split": "holdout"}}, ["x"]))
    check_dev(s, "noah")
    with pytest.raises(SplitError, match="HOLDOUT"):
        check_dev(s, "x")
    with pytest.raises(SplitError, match="not in the split file"):
        check_dev(s, "unknown")
    s2 = load_splits(_splits(tmp_path / "s2.json", {"y": {"split": "train"}}, []))
    with pytest.raises(SplitError, match="'dev' only"):
        check_dev(s2, "y")
    with pytest.raises(SplitError, match="holdout_sha256"):
        load_splits(_splits(tmp_path / "s3.json", {}, ["x"], tamper=True))


# ----------------------------------------------------------------------------- synthetic project


def _pt(fid: str, x: float, y: float, cls: str, **kw: Any) -> dict[str, Any]:
    p = {"id": fid, "class": cls, "kind": "symbol", "floor": "ground", "lifecycle": "new", "status": "draft-verified"} | kw
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [x, y]}, "properties": p}


def _sq(x0: float, y0: float, x1: float, y1: float) -> list[list[float]]:
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]


def _sheet(root: Path, sid: str, disc: str, feats: list[dict[str, Any]]) -> None:
    meta = {"sheet_id": sid, "project_id": "noah", "units": "mm", "y_axis": "down", "scale": 50, "input_type": "vector"}
    obj = {"type": "FeatureCollection", "kamutan": meta | {"discipline": disc}, "features": feats}
    (root / "sheets").mkdir(parents=True, exist_ok=True)
    (root / "sheets" / f"{sid}.geojson").write_text(json.dumps(obj), encoding="utf-8")


def write_gt(root: Path) -> Path:
    _sheet(
        root,
        SID,
        "electrical",
        [
            _pt("e1", 10, 10, "socket_single"),
            _pt("e2", 30, 10, "socket_double"),
            _pt("e3", 50, 10, "socket_single", lifecycle="existing"),
        ],
    )
    _sheet(root, PSID, "plumbing", [_pt("p1", 10, 10, "fixture_basin"), _pt("p2", 40, 10, "fixture_shower")])
    room = {
        "type": "Feature",
        "geometry": {"type": "Polygon", "coordinates": [_sq(0, 0, 40, 20)]},
        "properties": {"id": "r1", "class": "room", "kind": "area", "floor": "ground", "area_m2": 2.0, "room_id": "R1"},
    }
    room2 = json.loads(json.dumps(room))
    room2["geometry"]["coordinates"] = [_sq(50, 0, 90, 20)]
    room2["properties"] |= {"id": "r2", "room_id": "R2"}
    _sheet(root, ASID, "architecture", [room, room2])
    (root / "boq_truth.json").write_text(json.dumps({"project_id": "noah", "lines": []}), encoding="utf-8")
    (root / "GT_FREEZE.json").write_text(json.dumps({"gt_version": "gt-v0.9-test"}), encoding="utf-8")
    return root


def _det(i: int, x: float, y: float, cls: str, score: float, level: str, **kw: Any) -> dict[str, Any]:
    d = {"id": f"d_{i}", "class": cls, "centerMm": {"x": x, "y": y}, "score": score, "level": level, "reasons": []}
    d |= {"floor": "ground", "lifecycle": "new", "roomId": None}
    return d | kw


def _write_gz(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(json.dumps(obj).encode()))


def write_artifacts(root: Path, raster_green: bool = False, conflict_yellow_room: bool = False) -> Path:
    base = root / "orgs/o/projects/p/sheets"
    _write_gz(
        base / WID / "versions/v1/detections.json.gz",
        {
            "schema": "kamutan.detections/1",
            "detections": [
                _det(0, 10.5, 10, "socket_single", 0.92, "green", scoreRaw=0.9),  # correct
                _det(1, 30, 10.2, "socket_single", 0.8, "yellow"),  # wrong class
                _det(2, 50, 10, "socket_single", 0.7, "yellow"),  # wrong lifecycle
                _det(3, 80, 80, "socket_double", 0.6, "yellow"),  # unmatched
            ],
        },
    )
    _write_gz(
        base / PWID / "versions/v1/detections.json.gz",
        {
            "schema": "kamutan.detections/1",
            "detections": [
                _det(0, 10, 10, "fixture_basin", 0.9, "green"),
                _det(1, 41, 10, "fixture_shower", 0.75, "yellow"),
                _det(2, 70, 70, "socket_single", 0.9, "green"),  # not annotated on plumbing sheets: out of scope
            ],
        },
    )
    rooms = [
        {"id": "r_1", "polygonMm": [{"x": x, "y": y} for x, y in _sq(0, 0, 40, 20)[:-1]], "areaM2": 2.01, "floor": "ground"},
        {"id": "r_2", "polygonMm": [{"x": x, "y": y} for x, y in _sq(50, 0, 90, 20)[:-1]], "areaM2": 2.5, "floor": "ground"},
    ]
    for r in rooms:
        r |= {"confidence": 0.8, "level": "red", "reasons": []}
    _write_gz(base / AWID / "versions/v1/rooms.json.gz", {"schema": "kamutan.rooms/1", "rooms": rooms})
    fs = root / "_firestore/orgs/o/projects/p/sheets"
    fs.mkdir(parents=True, exist_ok=True)
    reasons = ["רסטר"] if raster_green else []
    (fs / f"{WID}.json").write_text(json.dumps({"classification": {"reasons": reasons}}), encoding="utf-8")
    if conflict_yellow_room:
        (fs / f"{AWID}.json").write_text(json.dumps({"classification": {"reasons": ["קנה מידה סותר"]}}), encoding="utf-8")
        _write_gz(
            base / AWID / "versions/v1/rooms.json.gz",
            {"schema": "kamutan.rooms/1", "rooms": [rooms[0] | {"level": "yellow"}, rooms[1]]},
        )
    return root


def test_collect_items_scopes(tmp_path: Path) -> None:
    gt = write_gt(tmp_path / "gt/noah")
    art = write_artifacts(tmp_path / "art")
    truth = load_project(gt)
    items, meta = collect_items(truth, load_worker_predictions(art, set(truth.sheets)))
    by = {(it.sheet_id, it.pred_id.split(":")[-1]): it for it in items}
    assert meta["scopes"] == {
        "symbols_all_classes": [SID],
        "symbols_fixture_classes": [PSID],
        "rooms": [ASID],
        "link_groups": [],
    }
    assert by[(SID, "d_0")].correct and by[(SID, "d_0")].score_raw == 0.9 and by[(SID, "d_0")].score == 0.92
    assert not by[(SID, "d_1")].correct and not by[(SID, "d_1")].detection_correct  # class
    assert not by[(SID, "d_2")].correct and by[(SID, "d_2")].detection_correct  # lifecycle only
    assert by[(SID, "d_3")].reasons == ["unmatched"]
    assert (PSID, "d_2") not in by  # socket on a plumbing sheet is out of scope
    assert by[(PSID, "d_0")].correct and by[(PSID, "d_1")].correct and by[(PSID, "d_0")].domain == "plumbing"
    assert by[(ASID, "r_1")].correct and by[(ASID, "r_1")].domain == "tiling"
    assert by[(ASID, "r_2")].reasons == ["quantity"]  # 2.5 vs 2.0 m2
    assert len(items) == 8


def test_ceiling_checks(tmp_path: Path) -> None:
    assert ceiling_checks(write_artifacts(tmp_path / "a"))["pass"]
    r = ceiling_checks(write_artifacts(tmp_path / "b", raster_green=True))
    assert not r["pass"] and r["raster_sheets"] == [WID]
    assert {v["rule"] for v in r["violations"]} == {"raster_sheet_green"} and len(r["violations"]) == 1
    r = ceiling_checks(write_artifacts(tmp_path / "c", conflict_yellow_room=True))
    assert not r["pass"] and r["violations"] == [{"rule": "scale_conflict_area_not_red", "sheet": AWID, "item": "r_1"}]


def test_cli_calibrate(tmp_path: Path) -> None:
    gt = write_gt(tmp_path / "gt/noah")
    art = write_artifacts(tmp_path / "art")
    _splits(tmp_path / "gt/splits.json", {"noah": {"split": "dev"}}, [])
    table, out, rep = tmp_path / "t/table.json", tmp_path / "c.json", tmp_path / "c.md"
    argv = ["calibrate", "--truth", str(gt), "--pred-detections", str(art), "--table", str(table), "--out", str(out)]
    assert main([*argv, "--report", str(rep), "--generated-at", "2026-10-15T00:00:00Z"]) == 0
    t = json.loads(table.read_text(encoding="utf-8"))
    assert t["gtVersion"] == "gt-v0.9-test" and t["classes"]["socket_single"]["n"] == 3
    assert "noah" not in json.dumps(t)  # class statistics only: no project names / ids
    assert "Ceiling rules" in rep.read_text(encoding="utf-8")
    assert json.loads(out.read_text(encoding="utf-8"))["report"]["split"]["dev_projects"] == ["noah"]
    # greens exist in classes the table does not allow -> optional failure
    assert main([*argv, "--fail-on-disallowed-green"]) == 1
    # holdout is refused before anything is read
    _splits(tmp_path / "gt/splits.json", {"noah": {"split": "holdout"}}, ["noah"])
    assert main(argv) == 2
    # ceiling violation -> hard failure
    _splits(tmp_path / "gt/splits.json", {"noah": {"split": "dev"}}, [])
    art2 = write_artifacts(tmp_path / "art2", raster_green=True)
    assert main(["calibrate", "--truth", str(gt), "--pred-detections", str(art2)]) == 1


# ----------------------------------------------------------------------------- perf


def _rows(walls: list[list[float]], timings: bool = True) -> list[dict[str, Any]]:
    rows = []
    for r, ws in enumerate(walls, 1):
        for i, w in enumerate(ws):
            tm = {"render": 1000.0, "ocr": 1000 * (w - 2), "total": 1000 * (w - 0.1)} if timings else {}
            rows.append({"fileId": f"f{i}", "repeat": r, "status": "ready", "wallS": w, "timingsMs": tm, "peakRssMb": 300 + i})
    return rows


def test_pct_nearest_rank() -> None:
    v = list(range(1, 21))
    assert pct(v, 50) == 10 and pct(v, 95) == 19 and pct(v, 100) == 20 and pct([], 50) is None
    assert pct([5.0], 95) == 5.0


def test_perf_summary_and_gate() -> None:
    rows = _rows([[10, 20, 30], [12, 22, 70]])
    s = summarize(rows)
    assert s["n_ok"] == 6 and s["timing_source"] == "timingsMs"
    assert s["stages_s"]["ocr"]["max"] == 68 and s["stages_s"]["render"]["p50"] == 1.0
    assert list(s["stages_s"]) == ["render", "ocr", "total"]
    assert s["page_wall_s"]["p95"] == 70 and s["set_seconds_per_repeat"] == [60.0, 104.0]
    assert s["per_sheet"]["f2"]["wall_max_s"] == 70 and s["per_sheet"]["f2"]["slowest_stage"] == "ocr"
    assert s["peak_rss_mb"] == 302
    assert s["page_cpu_s"]["n"] == 0
    rows2 = _rows([[10, 20]])
    rows2[1]["timingsMs"] = {"render": 9000.0, "ocr": 1000.0, "total": 10000.0}
    assert summarize(rows2)["per_sheet"]["f0"]["slowest_stage"] == "ocr"  # per sheet, not the last row
    assert summarize(rows2)["per_sheet"]["f1"]["slowest_stage"] == "render"
    rows[0]["cpuS"] = 4.0
    assert summarize(rows)["page_cpu_s"] == {"n": 1, "p50": 4.0, "p95": 4.0, "max": 4.0, "mean": 4.0}
    g = gate(s, PerfThresholds())
    assert not g["pass"] and [c["pass"] for c in g["checks"]] == [True, False, True]
    assert gate(s, PerfThresholds(a3_p95_s=80, set_s=100))["checks"][2]["pass"] is False
    # regression vs baseline (> 20% rise of the page P95)
    base = {"summary": {"page_wall_s": {"p95": 50.0}}}
    assert gate(s, PerfThresholds(a3_p95_s=100), base)["checks"][-1]["pass"] is False
    assert gate(s, PerfThresholds(a3_p95_s=100), {"summary": {"page_wall_s": {"p95": 60.0}}})["checks"][-1]["pass"]


def test_perf_wall_fallback_and_failures() -> None:
    rows = _rows([[10, 20]], timings=False) + [{"fileId": "fx", "repeat": 1, "status": "failed", "wallS": 3}]
    m = build_result(rows, PerfThresholds())
    s = m["summary"]
    assert s["timing_source"] == "wall" and s["stages_s"] == {} and s["page_total_s"]["max"] == 20
    assert s["failed"] == [{"fileId": "fx", "repeat": 1, "status": "failed"}]
    assert not m["gate"]["pass"] and m["gate"]["checks"][0]["pass"] is False
    assert "Gate: **FAIL**" in render_perf_markdown(m)


def test_cli_perf_raw(tmp_path: Path) -> None:
    raw = tmp_path / "raw.json"
    raw.write_text(json.dumps({"rows": _rows([[10, 20, 30]])}), encoding="utf-8")
    out, rep = tmp_path / "p.json", tmp_path / "p.md"
    assert main(["perf", "--raw", str(raw), "--out", str(out), "--report", str(rep), "--gate"]) == 0
    assert json.loads(out.read_text(encoding="utf-8"))["gate"]["pass"] is True
    assert main(["perf", "--raw", str(raw), "--gate", "--a3-p95-s", "25"]) == 1
    assert main(["perf", "--raw", str(raw), "--a3-p95-s", "25"]) == 0  # report only without --gate
    assert main(["perf"]) == 2


def test_run_worker_perf_with_fake_uv(tmp_path: Path) -> None:
    worker = tmp_path / "worker"
    (worker / "scripts").mkdir(parents=True)
    (worker / "scripts/perf_local.py").write_text(
        "import json, os, sys\n"
        "a = sys.argv[1:]\n"
        "out = a[a.index('--json') + 1]\n"
        "rows = [{'fileId': os.environ['KAMUTAN_DATA_DIR'][-4:], 'repeat': 1, 'status': 'ready', 'wallS': 1.5,\n"
        "         'timingsMs': {'total': 1400}, 'peakRssMb': 10, 'repeats': a[a.index('--repeats') + 1]}]\n"
        "json.dump({'rows': rows}, open(out, 'w'))\n",
        encoding="utf-8",
    )
    fake_uv = tmp_path / "uv"
    fake_uv.write_text(
        f"#!{sys.executable}\nimport subprocess, sys\na = sys.argv[1:]\ni = a.index('python')\n"
        f"sys.exit(subprocess.call([{sys.executable!r}] + a[i + 1:]))\n",
        encoding="utf-8",
    )
    fake_uv.chmod(fake_uv.stat().st_mode | stat.S_IEXEC)
    raw = tmp_path / "raw.json"
    run = run_worker_perf(worker, tmp_path / "data", 2, raw, uv=str(fake_uv))
    assert run["returncode"] == 0 and "--no-sync" in run["argv"] and not Path(run["root"]).exists()
    rows = json.loads(raw.read_text(encoding="utf-8"))["rows"]
    assert rows[0]["fileId"] == "data" and rows[0]["repeats"] == "2"
    with pytest.raises(FileNotFoundError):
        run_worker_perf(tmp_path / "nope", tmp_path, 1, raw)


def test_link_group_items(tmp_path: Path) -> None:
    gt = write_gt(tmp_path / "gt/noah")
    lsid = "dddd4444"
    _sheet(
        gt,
        lsid,
        "lighting",
        [
            _pt("s1", 10, 10, "switch_single"),
            _pt("l1", 30, 10, "luminaire_ceiling"),
            _pt("s2", 10, 40, "switch_single"),
            _pt("l2", 30, 40, "luminaire_ceiling"),
            _pt("s3", 10, 70, "switch_single"),
            _pt("l3", 30, 70, "luminaire_ceiling"),
        ],
    )
    (gt / "links").mkdir()
    groups = [
        {"id": "g1", "kind": "single", "switchIds": ["s1"], "luminaireIds": ["l1"]},
        {"id": "g2", "kind": "single", "switchIds": ["s2"], "luminaireIds": ["l2"]},
        {"id": "g3", "kind": "single", "switchIds": ["s3"], "luminaireIds": ["l3"], "dispute_id": "GT-D-9"},
    ]
    (gt / "links" / f"{lsid}.json").write_text(json.dumps({"sheet_id": lsid, "groups": groups}), encoding="utf-8")
    art = write_artifacts(tmp_path / "art")
    vd = art / f"orgs/o/projects/p/sheets/noah-{lsid}-p0/versions/v1"
    dets = [
        _det(i, x, y, c, 0.8, "yellow")
        for i, (x, y, c) in enumerate(
            [
                (10, 10, "switch_single"),
                (30, 10, "luminaire_ceiling"),
                (10, 40, "switch_single"),
                (30, 40, "luminaire_ceiling"),
                (10, 70, "switch_single"),
                (30, 70, "luminaire_ceiling"),
            ]
        )
    ]
    _write_gz(vd / "detections.json.gz", {"schema": "kamutan.detections/1", "detections": dets})
    pg = [
        {"id": "k1", "kind": "single", "switchIds": ["d_0"], "luminaireIds": ["d_1"], "confidence": 0.9, "level": "green"},
        {
            "id": "k2",
            "kind": "two_way",
            "switchIds": ["d_2"],
            "luminaireIds": ["d_1", "d_3"],
            "confidence": 0.6,
            "level": "yellow",
        },
        {"id": "k3", "kind": "single", "switchIds": ["d_4"], "luminaireIds": ["d_5"], "confidence": 0.9, "level": "green"},
    ]
    _write_gz(vd / "links.json.gz", {"schema": "kamutan.links/1", "groups": pg})
    truth = load_project(gt)
    items, meta = collect_items(truth, load_worker_predictions(art, set(truth.sheets)))
    links = {it.pred_id: it for it in items if it.cls.startswith("link:")}
    assert meta["scopes"]["link_groups"] == [lsid]
    assert set(links) == {f"{lsid}:k1", f"{lsid}:k2"}  # k3 touches the disputed truth group
    assert links[f"{lsid}:k1"].correct and links[f"{lsid}:k1"].cls == "link:single"
    assert not links[f"{lsid}:k2"].correct and links[f"{lsid}:k2"].domain == "lighting"
    table, _ = calibrate(items, CalibrateConfig())
    assert table["classes"]["link:two_way"]["n"] == 1 and table["classes"]["link:sensor"]["n"] == 0
