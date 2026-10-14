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

    m = _meta(a) | evaluate_boq_lines(truth, load_pred_lines(a.pred_lines), tuple(a.scope or DEFAULT_SCOPE))
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
