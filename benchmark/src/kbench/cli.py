"""kbench command line.

    kbench validate DIR
    kbench eval --truth DIR --pred DIR [--truth DIR --pred DIR ...] --out metrics.json [--report report.md]
    kbench eval --truth DIR --pred-detections ARTIFACTS_DIR --out m.json [--report r.md] [--center-tol-mm 3]
    kbench compare --current metrics.json --baseline baseline.json [--thresholds t.json] [--out gate.json] [--report gate.md]
    kbench parse-boq-xls XLS --project ID --out boq_truth.json
    kbench manifest DATA_DIR --project ID --out manifest.json
    kbench eval-links --truth GT_DIR --pred-links ARTIFACTS_DIR --out links.json [--report links.md] [--center-tol-mm 3]
    kbench eval-boq --truth GT_DIR --pred-lines boq-lines.json --out boq.json [--report boq.md] [--scope 4. --scope 9.01]
    kbench excel-check --sample boq_sample.xls --export export.xlsx [--lines boq-lines.json] [--report r.md]
    kbench links-implied --truth GT_DIR [--out implied.json] [--skip-existing-points] [--skip-existing-switches] [--alt]
    kbench plumbing-implied --truth GT_DIR [--out implied.json] [--report r.md]
    kbench eval-fixtures --truth GT_DIR --pred-detections ARTIFACTS_DIR --out f.json [--report f.md] [--center-tol-mm 3]
    kbench eval-tiling-rooms --truth GT_DIR --pred-rooms ARTIFACTS_DIR --out t.json [--report t.md]
    kbench tiling-expected --truth GT_DIR [--height 2.6] [--clad-niches] [--courtyard none|landing|whole] [--out e.json]
    kbench calibrate --truth GT_DIR --pred-detections ARTIFACTS [--splits splits.json] [--table table.json] [--out c.json] [--report c.md]
    kbench perf (--run --worker-dir workers/drawing | --raw raw.json) [--repeats 3] [--out p.json] [--report p.md] [--gate]

Exit codes: 0 ok · 1 regression / validation errors · 2 usage / not comparable.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .data import load_project
from .matching import MatchParams
from .metrics import EvalConfig, evaluate
from .regression import Thresholds, checks_to_json, checks_to_markdown, compare
from .report import render_markdown


def _write_json(path: str, obj) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")


def cmd_validate(a: argparse.Namespace) -> int:
    from .validate import validate_project

    errors, warnings = validate_project(a.dir)
    for w in warnings:
        print(f"warning: {w}")
    for e in errors:
        print(f"error: {e}")
    print(f"{len(errors)} error(s), {len(warnings)} warning(s)")
    return 1 if errors else 0


def cmd_eval_worker(a: argparse.Namespace) -> int:
    from .worker import WorkerEvalConfig, evaluate_worker, load_truth_legends, load_worker_predictions, render_worker_markdown

    if len(a.truth) != 1:
        print("error: --pred-detections takes exactly one --truth", file=sys.stderr)
        return 2
    truth = load_project(a.truth[0])
    sheet_map = json.loads(Path(a.sheet_map).read_text(encoding="utf-8")) if a.sheet_map else None
    preds = load_worker_predictions(a.pred_detections, set(truth.sheets), sheet_map, rooms_root=a.pred_rooms)
    cfg = WorkerEvalConfig(
        base=EvalConfig(
            match=MatchParams(
                iou_threshold=a.iou, center_tol_mm=a.center_tol_mm, small_symbol_mm=a.small_symbol_mm, mode=a.match_mode
            ),
            exclude_disputed=False,
        ),
        room_iou=a.room_iou,
        legend_tol_mm=a.legend_tol_mm,
        include_missing_sheets=a.include_missing_sheets,
    )
    legends = load_truth_legends(a.truth_legends or Path(a.truth[0]) / "legends")
    m = {"kbench_version": __version__, "gt_version": a.gt_version, "model_version": a.model_version, "code_sha": a.code_sha}
    m |= evaluate_worker(truth, preds, cfg, legends)
    _write_json(a.out, m)
    if a.report:
        Path(a.report).write_text(render_worker_markdown(m), encoding="utf-8")
    s, g, r = m["symbols"]["detection"]["micro"], m["symbols_glyph_level"]["detection"]["micro"], m["rooms"]
    print(
        f"sheets={len(m['sheets']['symbols'])} micro-F1={s['f1']} glyph-F1={g['f1']} "
        f"green-P={m['symbols']['green']['detection_correct']['p']} burden={m['symbols']['review_burden']['burden']} "
        f"rooms matched={r['n_matched']}/{r['n_truth']} meanIoU={r['mean_iou']}"
    )
    return 0


def cmd_eval(a: argparse.Namespace) -> int:
    if a.pred_detections:
        return cmd_eval_worker(a)
    if not a.pred:
        print(
            "error: give --pred DIR (annotation-schema predictions) or --pred-detections DIR (worker artifacts)", file=sys.stderr
        )
        return 2
    if len(a.truth) != len(a.pred):
        print("error: --truth and --pred must be given the same number of times", file=sys.stderr)
        return 2
    cfg = EvalConfig(
        match=MatchParams(
            iou_threshold=a.iou, center_tol_mm=a.center_tol_mm, small_symbol_mm=a.small_symbol_mm, mode=a.match_mode
        ),
        exclude_disputed=not a.keep_disputed,
        include_draft_lines=a.include_draft,
    )
    pairs = [(load_project(t), load_project(p)) for t, p in zip(a.truth, a.pred)]
    m = evaluate(pairs, cfg)
    gtv = {p[0].boq.get("gt_version") for p in pairs if p[0].boq}
    m = {
        "kbench_version": __version__,
        "gt_version": a.gt_version or (gtv.pop() if len(gtv) == 1 else None),
        "model_version": a.model_version,
        "code_sha": a.code_sha,
        "run": {"failures": [], "timing": {}},
        **m,
    }
    _write_json(a.out, m)
    if a.report:
        Path(a.report).write_text(render_markdown(m), encoding="utf-8")
    mi = m["detection"]["micro"]
    ic = m["items_correct"]
    print(
        f"micro-F1={mi['f1']} items_correct={ic['rate']} line_EM={m['boq']['exact_match']['rate']} "
        f"ECE={m['calibration']['ece']} P_green={m['calibration']['green']['p_green']}"
    )
    return 1 if m["ceiling_violations"] else 0


def cmd_compare(a: argparse.Namespace) -> int:
    with open(a.current, encoding="utf-8") as f:
        cur = json.load(f)
    with open(a.baseline, encoding="utf-8") as f:
        base = json.load(f)
    code, checks = compare(cur, base, Thresholds.load(a.thresholds))
    if a.out:
        _write_json(a.out, checks_to_json(code, checks))
    md = checks_to_markdown(code, checks)
    if a.report:
        Path(a.report).write_text(md, encoding="utf-8")
    print(md)
    return code


def cmd_parse_boq_xls(a: argparse.Namespace) -> int:
    from .boq_xls import parse_block_counts, parse_boq_xls, parse_change_orders, parse_plumbing_matrix

    boq = parse_boq_xls(a.xls, a.project)
    boq["change_orders"] = parse_change_orders(a.xls)
    boq["auxiliary"] = {"autocad_block_counts": parse_block_counts(a.xls), "plumbing_matrix": parse_plumbing_matrix(a.xls)}
    _write_json(a.out, boq)
    flagged = [ln for ln in boq["lines"] if ln["flags"]]
    print(f"{len(boq['lines'])} lines, {len(flagged)} flagged, {len(boq['change_orders'])} change orders -> {a.out}")
    for ln in flagged:
        print(f"  {ln['code']:>6} (raw {ln['raw_code']!r}): {', '.join(ln['flags'])}")
    return 0


def cmd_manifest(a: argparse.Namespace) -> int:
    from .manifest import build_manifest

    meta = json.loads(Path(a.sheet_meta).read_text(encoding="utf-8")) if a.sheet_meta else None
    _write_json(a.out, build_manifest(a.data_dir, a.project, meta, a.split))
    print(f"manifest -> {a.out}")
    return 0


def _meta(a: argparse.Namespace) -> dict:
    return {"kbench_version": __version__, "gt_version": a.gt_version, "model_version": a.model_version, "code_sha": a.code_sha}


def cmd_eval_links(a: argparse.Namespace) -> int:
    from .links import evaluate_links, load_pred_links, load_truth_links, render_links_markdown

    truth = load_project(a.truth)
    docs = load_truth_links(a.truth)
    if not docs:
        print(f"error: no links/*.json under {a.truth}", file=sys.stderr)
        return 2
    sheet_map = json.loads(Path(a.sheet_map).read_text(encoding="utf-8")) if a.sheet_map else None
    pred = load_pred_links(a.pred_links, set(docs), sheet_map)
    m = _meta(a) | evaluate_links(docs, truth, pred, a.center_tol_mm)
    _write_json(a.out, m)
    if a.report:
        Path(a.report).write_text(render_links_markdown(m), encoding="utf-8")
    p = m["links"]["pooled"]
    print(
        f"groups exact R={p['group_exact_recall']['p']} P={p['group_exact_precision']['p']} "
        f"switch_acc={p['switch_assignment']['p']} kind_acc={p['kind_accuracy']['p']} green_P={p['green_precision']['p']} "
        f"missing={m['links']['missing_pred_sheets']}"
    )
    return 0


def cmd_eval_boq(a: argparse.Namespace) -> int:
    from .boq_lines import DEFAULT_SCOPE, evaluate_boq_lines, load_pred_lines, render_boq_markdown

    truth = load_project(a.truth)
    import hashlib

    expected = None
    if a.expected:
        ex = json.loads(Path(a.expected).read_text(encoding="utf-8"))
        expected = ex.get("lines") or ex.get("recommended_defaults", {}).get("expected") or ex
        expected = {k: float(v) for k, v in expected.items() if isinstance(v, (int, float))}
    m = _meta(a) | evaluate_boq_lines(truth, load_pred_lines(a.pred_lines), tuple(a.scope or DEFAULT_SCOPE), expected)
    m["source"] = {"pred_lines": str(a.pred_lines), "sha256": hashlib.sha256(Path(a.pred_lines).read_bytes()).hexdigest()}
    _write_json(a.out, m)
    if a.report:
        Path(a.report).write_text(render_boq_markdown(m), encoding="utf-8")
    g = m["boq_lines"]["gated"]
    print(
        f"gated lines={g['n_lines']} EM={g['exact_match']['p']} sumAE={g['sum_ae']} medPE={g['median_pe']} "
        f"green_P={m['boq_lines']['green_line_precision']['p']} extra={len(m['boq_lines']['extra_lines'])}"
    )
    return 0


def cmd_plumbing_implied(a: argparse.Namespace) -> int:
    from .plumbing import PlumbingRules, compare_implied, implied_plumbing, render_implied_markdown

    truth = load_project(a.truth)
    imp = implied_plumbing(truth, PlumbingRules(faucet_radius_mm=a.faucet_radius_mm))
    rows = compare_implied(truth, imp)
    if a.out:
        _write_json(a.out, {"implied": imp, "lines": rows})
    md = render_implied_markdown(rows, imp)
    if a.report:
        Path(a.report).write_text(md, encoding="utf-8")
    print(md)
    return 0


def cmd_eval_fixtures(a: argparse.Namespace) -> int:
    from .plumbing import fixture_classes, fixture_subset
    from .worker import WorkerEvalConfig, evaluate_worker, load_worker_predictions, render_worker_markdown

    truth = load_project(a.truth)
    sheet_map = json.loads(Path(a.sheet_map).read_text(encoding="utf-8")) if a.sheet_map else None
    preds = load_worker_predictions(a.pred_detections, set(truth.sheets), sheet_map, rooms_root=a.pred_rooms)
    classes = fixture_classes()
    t_sub = fixture_subset(truth, classes)
    t_sub.sheets = {k: v for k, v in t_sub.sheets.items() if any(f.cls != "room" for f in v.features)}
    preds.project = fixture_subset(preds.project, classes)
    cfg = WorkerEvalConfig(
        base=EvalConfig(match=MatchParams(center_tol_mm=a.center_tol_mm, mode="center"), exclude_disputed=False),
        room_iou=a.room_iou,
        include_missing_sheets=a.include_missing_sheets,
    )
    m = {
        "kbench_version": __version__,
        "gt_version": a.gt_version,
        "model_version": a.model_version,
        "code_sha": a.code_sha,
        "classes": sorted(classes),
    }
    m |= evaluate_worker(t_sub, preds, cfg, {})
    _write_json(a.out, m)
    if a.report:
        Path(a.report).write_text(render_worker_markdown(m, title="kbench — plumbing fixtures + AC"), encoding="utf-8")
    s = m["symbols"]["detection"]["micro"]
    print(
        f"fixture sheets={m['sheets']['symbols']} micro P={s['precision']} R={s['recall']} F1={s['f1']} "
        f"missing={m['sheets']['missing_predictions']}"
    )
    return 0


def cmd_eval_tiling_rooms(a: argparse.Namespace) -> int:
    from .tiling import TilingEvalConfig, evaluate_tiling_rooms, load_tiling_truth, render_tiling_markdown
    from .worker import load_worker_predictions

    truth = load_project(a.truth)
    tiling = load_tiling_truth(a.truth)
    sheet_map = json.loads(Path(a.sheet_map).read_text(encoding="utf-8")) if a.sheet_map else None
    preds = load_worker_predictions(a.pred_rooms, set(truth.sheets), sheet_map)
    cfg = TilingEvalConfig(room_iou=a.room_iou, opening_tol_mm=a.opening_tol_mm, width_tol_m=a.width_tol_m)
    m = _meta(a) | evaluate_tiling_rooms(truth, tiling, preds.project, cfg)
    _write_json(a.out, m)
    if a.report:
        Path(a.report).write_text(render_tiling_markdown(m), encoding="utf-8")
    t = m["tiling_rooms"]
    print(
        f"rooms matched={t['n_matched']}/{t['n_truth_rooms']} type_acc={t['type_accuracy']} wet={t['wet']} "
        f"openings={t['openings']} missing={t['missing_pred_sheets']}"
    )
    return 0


def cmd_tiling_expected(a: argparse.Namespace) -> int:
    from .tiling import TilingRules, expected_lines, load_tiling_truth

    tiling = load_tiling_truth(a.truth)
    rules = TilingRules(
        cladding_height_m=a.height, clad_niches=a.clad_niches, floor_courtyard=a.courtyard, cap_at_ceiling=not a.no_ceiling_cap
    )
    m = expected_lines(tiling, rules)
    if a.out:
        _write_json(a.out, m)
    print(json.dumps(m["lines"], ensure_ascii=False))
    return 0


def cmd_links_implied(a: argparse.Namespace) -> int:
    from .links import CompositeRules, implied_composite_counts, load_truth_links

    truth = load_project(a.truth)
    rules = CompositeRules(
        skip_all_existing_points=a.skip_existing_points,
        skip_all_existing_switches=a.skip_existing_switches,
        use_alt_readings=a.alt,
    )
    res = implied_composite_counts(load_truth_links(a.truth), truth, rules)
    boq = {ln["code"]: ln.get("quantity") for ln in truth.boq_lines()}
    res["vs_boq"] = {c: {"implied": n, "boq": boq.get(c)} for c, n in res["counts"].items()}
    if a.out:
        _write_json(a.out, res)
    for c, v in res["vs_boq"].items():
        print(f"{c}: implied {v['implied']} boq {v['boq']}")
    return 0


def cmd_excel_check(a: argparse.Namespace) -> int:
    from .boq_lines import load_pred_lines
    from .excel_check import check_export, render_checklist, sample_spec_from_xls

    spec = sample_spec_from_xls(a.sample)
    items = check_export(a.export, spec, load_pred_lines(a.lines) if a.lines else None)
    md = render_checklist(items)
    if a.out:
        _write_json(a.out, {"spec": spec, "checks": items})
    if a.report:
        Path(a.report).write_text(md, encoding="utf-8")
    print(md)
    return 1 if any(it["status"] == "fail" for it in items) else 0


def _gt_version_of(gt_dir: str | Path) -> str | None:
    p = Path(gt_dir) / "GT_FREEZE.json"
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8")).get("gt_version")
    return None


def _worker_schema(arg: str | None) -> dict | None:
    """The worker's table schema (Worker-Cal owns it): --schema, else the repo copy when present."""
    if arg == "none":
        return None
    p = Path(arg) if arg else Path(__file__).resolve().parents[3] / "workers/drawing/src/kamutan_drawing/calibration/schema.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def cmd_calibrate(a: argparse.Namespace) -> int:
    from .calibrate import (
        CalibrateConfig,
        SplitError,
        calibrate,
        ceiling_checks,
        check_dev,
        check_table,
        collect_items,
        load_splits,
        project_id_of,
        render_calibration_markdown,
    )
    from .worker import load_worker_predictions

    if len(a.truth) != len(a.pred_detections):
        print("error: --truth and --pred-detections must be given the same number of times", file=sys.stderr)
        return 2
    cfg = CalibrateConfig(
        center_tol_mm=a.center_tol_mm, room_iou=a.room_iou, room_area_tol=a.room_area_tol, min_map_n=a.min_map_n
    )
    splits_path = Path(a.splits) if a.splits else Path(a.truth[0]).resolve().parent / "splits.json"
    items, scopes, ceilings, gtv = [], {}, [], set()
    try:
        splits = load_splits(splits_path)
        for t_dir, p_dir in zip(a.truth, a.pred_detections):
            truth = load_project(t_dir)
            pid = project_id_of(truth)
            check_dev(splits, pid)  # never read a holdout project
            preds = load_worker_predictions(p_dir, set(truth.sheets))
            its, meta = collect_items(truth, preds, cfg)
            items += its
            scopes[pid] = meta
            ceilings.append(ceiling_checks(p_dir) | {"pred_root": str(p_dir)})
            gtv.add(a.gt_version or _gt_version_of(t_dir))
    except (SplitError, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    gt_version = a.gt_version or (gtv.pop() if len(gtv) == 1 else None)
    table, report = calibrate(
        items, cfg, gt_version=gt_version, n_projects=len(splits.get("projects", {})), generated_at=a.generated_at
    )
    report["split"] = {
        "path": str(splits_path),
        "split_version": splits.get("split_version"),
        "dev_projects": sorted(scopes),
        "n_holdout": len(splits.get("holdout", [])),
        "holdout_sha256": splits.get("holdout_sha256"),
    }
    report["scopes"] = scopes
    report["ceiling"] = {
        "n_sheets_checked": sum(c["n_sheets_checked"] for c in ceilings),
        "raster_sheets": sorted({s for c in ceilings for s in c["raster_sheets"]}),
        "scale_conflict_sheets": sorted({s for c in ceilings for s in c["scale_conflict_sheets"]}),
        "violations": [v for c in ceilings for v in c["violations"]],
        "pass": all(c["pass"] for c in ceilings),
        "per_root": ceilings,
    }
    errs = check_table(table, _worker_schema(a.schema))
    report["table_errors"] = errs
    if errs:
        for err in errs:
            print(f"error: table: {err}", file=sys.stderr)
        return 1
    if a.table:
        _write_json(a.table, table)
    if a.out:
        _write_json(
            a.out, {"kbench_version": __version__, "table": table, "report": report, "items": [it.__dict__ for it in items]}
        )
    if a.report:
        Path(a.report).parent.mkdir(parents=True, exist_ok=True)
        Path(a.report).write_text(render_calibration_markdown(table, report), encoding="utf-8")
    o = report["overall"]
    allowed = sorted(c for c, t in table["classes"].items() if t["greenAllowed"])
    print(
        f"items={len(items)} precision={o['precision']:.3f} wilsonLb={o['wilsonLb']:.3f} ECE raw={o['raw']['ece']:.3f} "
        f"cv={o['calibrated_loso_cv']['ece']:.3f} greenAllowed={allowed or 'none'} mode={table['mode']} "
        f"ceiling={'PASS' if report['ceiling']['pass'] else 'FAIL'} disallowed_greens="
        f"{report['conservative_check']['n_green_in_disallowed_classes']}"
    )
    if not report["ceiling"]["pass"]:
        for v in report["ceiling"]["violations"][:20]:
            print(f"ceiling violation: {v}", file=sys.stderr)
        return 1
    if a.fail_on_disallowed_green and report["conservative_check"]["n_green_in_disallowed_classes"]:
        return 1
    return 0


def cmd_perf(a: argparse.Namespace) -> int:
    from .perf import PerfThresholds, build_result, load_raw, render_perf_markdown, run_worker_perf

    run = None
    raw = list(a.raw or [])
    if a.run:
        import os

        data = a.data_dir or os.environ.get("KAMUTAN_DATA_DIR")
        if not data:
            print("error: --run needs --data-dir or KAMUTAN_DATA_DIR", file=sys.stderr)
            return 2
        data_p = Path(data)
        if not list(data_p.glob("sheet_*.pdf")) and (data_p / "sample-noah").is_dir():
            data_p = data_p / "sample-noah"
        raw_out = a.raw_out or str(Path(a.out or "perf.json").with_suffix(".raw.json"))
        worker = a.worker_dir or str(Path(__file__).resolve().parents[3] / "workers" / "drawing")
        try:
            run = run_worker_perf(worker, data_p, a.repeats, raw_out, root=a.root, keep_root=a.keep_root, only=a.only)
        except FileNotFoundError as e:
            print(f"error: {e}", file=sys.stderr)
            return 2
        if run["returncode"] != 0 and not Path(raw_out).exists():
            print(f"error: worker profiler exited {run['returncode']} without output", file=sys.stderr)
            return 1
        raw.append(raw_out)
    if not raw:
        print("error: give --run or --raw FILE", file=sys.stderr)
        return 2
    th = PerfThresholds(a3_p95_s=a.a3_p95_s, set_s=a.set_s)
    baseline = json.loads(Path(a.baseline).read_text(encoding="utf-8")) if a.baseline else None
    m = build_result(load_raw(raw), th, baseline, run, {"code_sha": a.code_sha, "raw": [str(p) for p in raw]})
    if a.out:
        _write_json(a.out, m)
    md = render_perf_markdown(m)
    if a.report:
        Path(a.report).parent.mkdir(parents=True, exist_ok=True)
        Path(a.report).write_text(md, encoding="utf-8")
    s = m["summary"]
    print(
        f"pages ok={s['n_ok']}/{s['n_rows']} page P50={s['page_wall_s']['p50']}s P95={s['page_wall_s']['p95']}s "
        f"set max={s['set_seconds_max']}s peak RSS={s['peak_rss_mb']}MB timing={s['timing_source']} "
        f"gate={'PASS' if m['gate']['pass'] else 'FAIL'}"
    )
    return 1 if (a.gate and not m["gate"]["pass"]) else 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="kbench", description="Kamutan accuracy benchmark")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("validate", help="JSON-schema + gt-lint a project directory")
    s.add_argument("dir")
    s.set_defaults(fn=cmd_validate)

    s = sub.add_parser("eval", help="score predictions against truth")
    s.add_argument("--truth", action="append", required=True)
    s.add_argument("--pred", action="append", default=[])
    s.add_argument(
        "--pred-detections", help="worker artifacts: DIR/<sheet>/detections.json.gz or the storage layout (kamutan.detections/1)"
    )
    s.add_argument("--pred-rooms", help="worker rooms.json.gz root if different from --pred-detections (kamutan.rooms/1)")
    s.add_argument("--truth-legends", help="legend_<sheet>.geojson directory (default TRUTH/legends)")
    s.add_argument("--sheet-map", help="JSON {worker sheet id: truth sheet id}; default: truth id contained in worker id")
    s.add_argument("--room-iou", type=float, default=0.5)
    s.add_argument("--legend-tol-mm", type=float, default=4.0)
    s.add_argument("--include-missing-sheets", action="store_true", help="score truth sheets that have no predictions (all FN)")
    s.add_argument("--out", required=True)
    s.add_argument("--report")
    s.add_argument("--iou", type=float, default=0.5)
    s.add_argument("--center-tol-mm", type=float, default=3.0)
    s.add_argument("--small-symbol-mm", type=float, default=8.0)
    s.add_argument("--match-mode", choices=["auto", "iou", "center"], default="auto")
    s.add_argument("--keep-disputed", action="store_true", help="do NOT exclude disputed lines (diagnostics only)")
    s.add_argument("--include-draft", action="store_true", help="treat draft truth lines as confirmed (smoke only)")
    s.add_argument("--gt-version")
    s.add_argument("--model-version")
    s.add_argument("--code-sha")
    s.set_defaults(fn=cmd_eval)

    s = sub.add_parser("compare", help="regression gate vs baseline metrics")
    s.add_argument("--current", required=True)
    s.add_argument("--baseline", required=True)
    s.add_argument("--thresholds")
    s.add_argument("--out")
    s.add_argument("--report")
    s.set_defaults(fn=cmd_compare)

    s = sub.add_parser("parse-boq-xls", help="legacy .xls BOQ -> boq_truth.json (codes as TEXT)")
    s.add_argument("xls")
    s.add_argument("--project", required=True)
    s.add_argument("--out", required=True)
    s.set_defaults(fn=cmd_parse_boq_xls)

    s = sub.add_parser("manifest", help="file ids + sha256 manifest (no content)")
    s.add_argument("data_dir")
    s.add_argument("--project", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--sheet-meta", help="JSON {sheet_id: {discipline, floors, ...}}")
    s.add_argument("--split", default="dev")
    s.set_defaults(fn=cmd_manifest)

    def meta_args(s: argparse.ArgumentParser) -> None:
        s.add_argument("--gt-version")
        s.add_argument("--model-version")
        s.add_argument("--code-sha")

    s = sub.add_parser("eval-links", help="score worker link groups (kamutan.links/1) against links/<sheet>.json truth")
    s.add_argument("--truth", required=True)
    s.add_argument("--pred-links", required=True, help="DIR/**/sheets/<s>/versions/<v>/links.json.gz (+ detections.json.gz)")
    s.add_argument("--sheet-map")
    s.add_argument("--center-tol-mm", type=float, default=3.0)
    s.add_argument("--out", required=True)
    s.add_argument("--report")
    meta_args(s)
    s.set_defaults(fn=cmd_eval_links)

    s = sub.add_parser("eval-boq", help="score the worker's boq-lines.json against boq_truth.json")
    s.add_argument("--truth", required=True)
    s.add_argument("--pred-lines", required=True)
    s.add_argument("--scope", action="append", help="code prefix ('4.') or exact code ('9.01'); default 4. + 9.01")
    s.add_argument("--expected", help="JSON {code: qty} (or tiling-expected output) shown as a second reference column")
    s.add_argument("--out", required=True)
    s.add_argument("--report")
    meta_args(s)
    s.set_defaults(fn=cmd_eval_boq)

    s = sub.add_parser("links-implied", help="composite BOQ counts implied by the link-group truth")
    s.add_argument("--truth", required=True)
    s.add_argument("--out")
    s.add_argument("--skip-existing-points", action="store_true")
    s.add_argument("--skip-existing-switches", action="store_true")
    s.add_argument("--alt", action="store_true", help="use alt readings of disputed groups")
    s.set_defaults(fn=cmd_links_implied)

    s = sub.add_parser("plumbing-implied", help="plumbing BOQ (chapter 03) implied by the fixture truth")
    s.add_argument("--truth", required=True)
    s.add_argument("--faucet-radius-mm", type=float, default=5.0)
    s.add_argument("--out")
    s.add_argument("--report")
    s.set_defaults(fn=cmd_plumbing_implied)

    s = sub.add_parser("eval-fixtures", help="plumbing fixture + AC detection metrics (worker detections)")
    s.add_argument("--truth", required=True)
    s.add_argument("--pred-detections", required=True)
    s.add_argument("--pred-rooms")
    s.add_argument("--sheet-map")
    s.add_argument("--center-tol-mm", type=float, default=3.0)
    s.add_argument("--room-iou", type=float, default=0.5)
    s.add_argument("--include-missing-sheets", action="store_true")
    s.add_argument("--out", required=True)
    s.add_argument("--report")
    meta_args(s)
    s.set_defaults(fn=cmd_eval_fixtures)

    s = sub.add_parser("eval-tiling-rooms", help="room type / wet / openings / perimeter vs tiling/wet_rooms.json")
    s.add_argument("--truth", required=True)
    s.add_argument("--pred-rooms", required=True)
    s.add_argument("--sheet-map")
    s.add_argument("--room-iou", type=float, default=0.5)
    s.add_argument("--opening-tol-mm", type=float, default=10.0)
    s.add_argument("--width-tol-m", type=float, default=0.05)
    s.add_argument("--out", required=True)
    s.add_argument("--report")
    meta_args(s)
    s.set_defaults(fn=cmd_eval_tiling_rooms)

    s = sub.add_parser("tiling-expected", help="tiling quantities (5.01/5.02/5.03/5.05) from the wet-room truth")
    s.add_argument("--truth", required=True)
    s.add_argument("--height", type=float, default=2.6)
    s.add_argument("--clad-niches", action="store_true")
    s.add_argument("--no-ceiling-cap", action="store_true")
    s.add_argument("--courtyard", choices=["none", "landing", "whole"], default="none")
    s.add_argument("--out")
    s.set_defaults(fn=cmd_tiling_expected)

    s = sub.add_parser("calibrate", help="conservative calibration table + report from DEV predictions (never holdout)")
    s.add_argument("--truth", action="append", required=True, help="GT project dir (repeat with --pred-detections)")
    s.add_argument("--pred-detections", action="append", required=True, help="worker artifacts root of that project")
    s.add_argument("--splits", help="kamutan.gt-splits/1 file (default: TRUTH/../splits.json)")
    s.add_argument("--table", help="write the kamutan.calibration/1 table here")
    s.add_argument("--schema", help="worker table schema.json (default: the repo copy; 'none' to skip)")
    s.add_argument("--out", help="full JSON (table + report + per-item records; keep outside git)")
    s.add_argument("--report")
    s.add_argument("--center-tol-mm", type=float, default=3.0)
    s.add_argument("--room-iou", type=float, default=0.5)
    s.add_argument("--room-area-tol", type=float, default=0.02)
    s.add_argument("--min-map-n", type=int, default=30, help="scored items needed to fit an isotonic map")
    s.add_argument("--generated-at", help="fixed generatedAt (reproducible tables)")
    s.add_argument("--gt-version", help="default: TRUTH/GT_FREEZE.json")
    s.add_argument(
        "--fail-on-disallowed-green",
        action="store_true",
        help="exit 1 if a prediction is green in a class the table does not allow",
    )
    s.set_defaults(fn=cmd_calibrate)

    s = sub.add_parser("perf", help="worker pipeline timing: P50/P95 per stage, peak RSS, set time (+ gate)")
    s.add_argument("--run", action="store_true", help="run workers/drawing/scripts/perf_local.py first")
    s.add_argument("--raw", action="append", help="perf_local.py --json output(s) to analyse")
    s.add_argument("--repeats", type=int, default=3)
    s.add_argument("--only", default="", help="comma separated file ids (--run)")
    s.add_argument("--data-dir", help="sample sheets (default $KAMUTAN_DATA_DIR[/sample-noah])")
    s.add_argument("--worker-dir", help="default: <repo>/workers/drawing (its uv env must be synced)")
    s.add_argument("--root", help="artifacts root for the run (default: a temp dir, deleted afterwards)")
    s.add_argument("--keep-root", action="store_true")
    s.add_argument("--raw-out", help="where --run writes the raw rows (default: OUT with .raw.json)")
    s.add_argument("--out")
    s.add_argument("--report")
    s.add_argument("--gate", action="store_true", help="exit 1 when a threshold fails")
    s.add_argument("--a3-p95-s", type=float, default=60.0)
    s.add_argument("--set-s", type=float, default=600.0)
    s.add_argument("--baseline", help="previous kbench perf JSON: block a page-P95 rise > 20%%")
    s.add_argument("--code-sha")
    s.set_defaults(fn=cmd_perf)

    s = sub.add_parser("excel-check", help="xlsx export vs the sample BOQ format (checklist)")
    s.add_argument("--sample", required=True, help="client's sample .xls (sheet כמויות)")
    s.add_argument("--export", required=True, help="exported .xlsx")
    s.add_argument("--lines", help="boq-lines.json: also check quantities")
    s.add_argument("--out")
    s.add_argument("--report")
    s.set_defaults(fn=cmd_excel_check)
    return p


def main(argv: list[str] | None = None) -> int:
    a = build_parser().parse_args(argv)
    return a.fn(a)
