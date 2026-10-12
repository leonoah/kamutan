"""kbench command line.

    kbench validate DIR
    kbench eval --truth DIR --pred DIR [--truth DIR --pred DIR ...] --out metrics.json [--report report.md]
    kbench compare --current metrics.json --baseline baseline.json [--thresholds t.json] [--out gate.json] [--report gate.md]
    kbench parse-boq-xls XLS --project ID --out boq_truth.json
    kbench manifest DATA_DIR --project ID --out manifest.json

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


def cmd_eval(a: argparse.Namespace) -> int:
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


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="kbench", description="Kamutan accuracy benchmark")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("validate", help="JSON-schema + gt-lint a project directory")
    s.add_argument("dir")
    s.set_defaults(fn=cmd_validate)

    s = sub.add_parser("eval", help="score predictions against truth")
    s.add_argument("--truth", action="append", required=True)
    s.add_argument("--pred", action="append", required=True)
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
    return p


def main(argv: list[str] | None = None) -> int:
    a = build_parser().parse_args(argv)
    return a.fn(a)
