"""Markdown rendering of a metrics JSON."""

from __future__ import annotations

from typing import Any


def _f(v: Any, pct: bool = False) -> str:
    if v is None:
        return "—"
    if isinstance(v, float):
        return f"{v * 100:.1f}%" if pct else f"{v:.4f}"
    return str(v)


def render_markdown(m: dict[str, Any]) -> str:
    out: list[str] = []
    out.append("# kbench report")
    out.append("")
    out.append(
        f"- gt_version: `{m.get('gt_version')}` · model_version: `{m.get('model_version')}` · code_sha: `{m.get('code_sha')}`"
    )
    ds = m["dataset"]
    out.append(f"- projects: {', '.join(p['project_id'] for p in ds['projects'])} · predicted items: {ds['n_pred_items']}")
    ex = ds["excluded"]
    disp = {k: v for k, v in ex["disputed_codes"].items() if v}
    if disp:
        out.append(f"- excluded (open disputes): lines {disp}; GT items {ex['gt_items']}, predicted items {ex['pred_items']}")
    out.append("")

    det = m["detection"]
    mi = det["micro"]
    out.append("## Detection")
    out.append(
        f"micro P {_f(mi['precision'])} · R {_f(mi['recall'])} · **F1 {_f(mi['f1'])}** "
        f"(TP {mi['tp']} / FP {mi['fp']} / FN {mi['fn']}) · macro-F1 {_f(det['macro']['f1'])} "
        f"over {len(det['macro']['classes'])} classes with ≥{det['macro']['min_support']} GT"
    )
    out.append("")
    out.append("| class | support | TP | FP | FN | P | R | F1 |")
    out.append("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for c, v in det["per_class"].items():
        out.append(
            f"| {c} | {v['support']} | {v['tp']} | {v['fp']} | {v['fn']} | {_f(v['precision'])} | {_f(v['recall'])} | {_f(v['f1'])} |"
        )
    out.append("")

    ic = m["items_correct"]
    out.append("## Items correct before review")
    out.append(
        f"**{_f(ic['rate'], True)}** (Wilson LB95 {_f(ic['wilson_lb95'], True)}) = {ic['n_correct']} / "
        f"({ic['n_predicted']} predicted + {ic['n_fn']} FN). Error reasons: {ic['error_reasons'] or '—'}"
    )
    out.append("")

    b = m["boq"]
    out.append("## BOQ lines")
    em = b["exact_match"]
    ce = b["count_error"]
    out.append(
        f"exact-match {_f(em['rate'], True)} ({em['n_correct']}/{em['n_lines']}, not proposed {em['n_not_proposed']}) · "
        f"count lines with AE>0: {ce['n_lines_ae_gt_0']}/{ce['n_lines']} · median PE {_f(ce['median_pe'])} · "
        f"P90 PE {_f(ce['p90_pe'])} · extra lines {len(b['extra_lines'])}"
    )
    if ce["sum_ae_by_chapter"]:
        out.append("")
        out.append("| chapter | ΣAE |")
        out.append("| --- | --- |")
        for ch, v in ce["sum_ae_by_chapter"].items():
            out.append(f"| {ch} | {v:g} |")
    wrong = [r for r in b["lines"] if not r["correct"]]
    if wrong:
        out.append("")
        out.append("| code | unit | truth | predicted | AE | PE |")
        out.append("| --- | --- | --- | --- | --- | --- |")
        for r in wrong[:50]:
            out.append(f"| {r['code']} | {r['unit']} | {r['quantity']:g} | {_f(r['predicted'])} | {r['ae']:g} | {_f(r['pe'])} |")
    out.append("")

    cal = m["calibration"]
    g = cal["green"]
    out.append("## Calibration")
    out.append(f"ECE {_f(cal['ece'])} · MCE {_f(cal['mce'])} · Brier {_f(cal['brier'])} · scored items {cal['n_scored']}")
    out.append(
        f"- P_green {_f(g['p_green'], True)} on n={g['n']}, Wilson LB95 {_f(g['wilson_lb95'], True)} "
        f"(target {g['target']}; ≥{g['min_n_at_zero_errors']} greens needed even with 0 errors; "
        f"sufficient sample: {g['sufficient_sample']}) → **{'PASS' if g['pass'] else 'FAIL'}**"
    )
    if g["green_in_ineligible_classes"]:
        out.append(f"- green emitted for classes not eligible under conservative calibration: {g['green_in_ineligible_classes']}")
    rel = cal["reliability"]
    if rel["bins"]:
        out.append("")
        out.append("| bin | n | mean conf | accuracy |")
        out.append("| --- | --- | --- | --- |")
        for i, bn in enumerate(rel["bins"]):
            out.append(f"| {i + 1} | {bn['n']} | {bn['conf']:.3f} | {bn['acc']:.3f} |")
    out.append("")

    rb = m["review_burden"]
    out.append("## Review burden")
    out.append(
        f"burden {_f(rb['burden'], True)} (green {rb['n_green']} / yellow {rb['n_yellow']} / red {rb['n_red']}) · "
        f"yield of review {_f(rb['yield_of_review'], True)} · risk AUC {_f(rb['risk_auc'])}"
    )
    out.append("")
    if m.get("ceiling_violations"):
        out.append(f"## Ceiling rule violations (hard failure): {len(m['ceiling_violations'])}")
        for v in m["ceiling_violations"][:20]:
            out.append(f"- {v['rule']}: {v['sheet_id']} / {v['item']}")
        out.append("")
    return "\n".join(out)
