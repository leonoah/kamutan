"""BOQ-line evaluation of the worker's computed lines (Sprint 3) against ``boq_truth.json``.

Prediction input: the worker's local ``boq-lines.json`` (a JSON list of ``BoqLine`` objects, or ``{"lines": [...]}`` /
``{"boqLines": [...]}``, optionally gzip). Fields used: ``code`` (TEXT), ``qty`` (computed quantity, *before* review:
``qtyOverride`` is ignored), ``byFloor``, ``level``, ``unit``, ``description``.

Definitions (docs/spec/07_test_plan.md "שגיאת ספירה לשורת BOQ" / "line exact-match"):

- scope: truth lines whose code starts with one of ``scope`` (default chapter 4 + ``9.01``, the lines the worker builds).
- per line: ``AE = |Q̂ − Q|``, ``PE = AE / max(Q, 1)``; a line not proposed has Q̂ = 0. Codes compare as TEXT
  ("4.1" does not satisfy "4.10"); a numeric code in the prediction is reported as a format error.
- gating set: in-scope lines that are not disputed (open dispute or ``gt_status=disputed``). Disputed lines are
  reported with the same numbers but never gate.
- exact-match rate = #gated lines with Q̂ == Q / #gated lines, with the Wilson LB95.
- extra lines: predicted codes that are not truth lines (reported, not in the denominator).
- per floor: for truth lines with a non-empty ``breakdown``, Q̂ per floor from ``byFloor``.
- green-line precision: predicted lines with level green whose code is a gated truth line or an extra line; correct =
  exact quantity on a gated truth line (an extra green line is wrong).
"""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path
from typing import Any

from .data import Project, unit_kind
from .metrics import EvalConfig, line_tolerance
from .stats import percentile, wilson_lower
from .worker import read_json_any

DEFAULT_SCOPE = ("4.", "9.01")


def load_pred_lines(path: str | Path) -> list[dict[str, Any]]:
    obj = read_json_any(Path(path))
    if isinstance(obj, dict):
        for k in ("lines", "boqLines", "boq_lines"):
            if isinstance(obj.get(k), list):
                return list(obj[k])
        raise ValueError(f"{path}: no 'lines' list")
    if not isinstance(obj, list):
        # Malformed prediction *data*: ValueError is the documented contract.
        raise ValueError(f"{path}: expected a list of lines")  # noqa: TRY004
    return list(obj)


def in_scope(code: str, scope: tuple[str, ...]) -> bool:
    return any(code == s or (s.endswith(".") and code.startswith(s)) for s in scope)


def _rate(k: int, n: int) -> dict[str, Any]:
    return {"k": k, "n": n, "p": round(k / n, 4) if n else None, "wilson_lb95": wilson_lower(k, n)}


def _num(v: Any) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def evaluate_boq_lines(
    truth: Project,
    pred_lines: list[dict[str, Any]],
    scope: tuple[str, ...] = DEFAULT_SCOPE,
    expected: dict[str, float] | None = None,
) -> dict[str, Any]:
    """``expected``: optional {code: quantity} implied by the drawing truth under stated rules (e.g. tiling
    quantities from ``tiling/expected_tiling.json``); reported as a second reference column, never gated."""
    cfg = EvalConfig()
    disputed = truth.open_dispute_codes()
    format_errors: list[str] = []
    pred: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for ln in pred_lines:
        code = ln.get("code")
        if not isinstance(code, str):
            format_errors.append(f"line {ln.get('id')}: code {code!r} is not TEXT")
            code = str(code)
        pred[code].append(ln)

    truth_lines = {ln["code"]: ln for ln in truth.boq_lines()}
    rows: list[dict[str, Any]] = []
    floors: list[dict[str, Any]] = []
    for code, tl in truth_lines.items():
        if not in_scope(code, scope):
            continue
        pls = pred.get(code, [])
        q = _num(tl.get("quantity"))
        qh = sum(_num(p.get("qty")) for p in pls)
        ae = abs(qh - q)
        levels = sorted({str(p.get("level")) for p in pls})
        kind = unit_kind(str(tl.get("unit", "")))
        measured = kind in ("area", "length")
        tol = line_tolerance(tl, cfg) if measured else 0.0
        pe_area = ae / q if q else (0.0 if ae < 1e-9 else 1.0)
        row = {
            "code": code,
            "description": tl.get("description"),
            "unit": tl.get("unit"),
            "truth": q,
            "pred": qh,
            "ae": round(ae, 6),
            "pe": round(ae / max(q, 1.0), 6),
            "exact": ae < 1e-9,
            "measured": measured,
            "tolerance_pe": tol,
            "within_tol": (pe_area <= tol + 1e-9) if measured else ae < 1e-9,
            "expected": (expected or {}).get(code),
            "pred_vs_expected_pe": (
                round(abs(qh - expected[code]) / expected[code], 6) if expected and expected.get(code) else None
            ),
            "proposed": bool(pls),
            "disputed": code in disputed,
            "dispute_id": tl.get("dispute_id"),
            "truth_status": tl.get("gt_status"),
            "level": levels[0] if len(levels) == 1 else (levels or None),
            "n_pred_lines": len(pls),
            "unit_mismatch": bool(pls) and any((p.get("unit") or tl.get("unit")) != tl.get("unit") for p in pls),
            "pred_by_floor": _sum_floors(pls),
        }
        rows.append(row)
        bd = tl.get("breakdown") or {}
        for fl, tq in bd.items():
            fq = row["pred_by_floor"].get(fl, 0.0)
            floors.append(
                {
                    "code": code,
                    "floor": fl,
                    "truth": _num(tq),
                    "pred": fq,
                    "ae": abs(fq - _num(tq)),
                    "exact": abs(fq - _num(tq)) < 1e-9,
                    "disputed": row["disputed"],
                }
            )

    extra = [
        {
            "code": c,
            "qty": sum(_num(p.get("qty")) for p in pls),
            "level": pls[0].get("level"),
            "description": pls[0].get("description"),
            "in_scope": in_scope(c, scope),
        }
        for c, pls in sorted(pred.items())
        if c not in truth_lines
    ]

    gated = [r for r in rows if not r["disputed"]]
    disp = [r for r in rows if r["disputed"]]

    def summary(rs: list[dict[str, Any]]) -> dict[str, Any]:
        pes = [r["pe"] for r in rs]
        return {
            "n_lines": len(rs),
            "exact_match": _rate(sum(r["exact"] for r in rs), len(rs)),
            "within_tolerance": _rate(sum(r["within_tol"] for r in rs), len(rs)),
            "sum_ae": round(sum(r["ae"] for r in rs), 6),
            "median_pe": percentile(pes, 50),
            "p90_pe": percentile(pes, 90),
            "n_ae_gt_0": sum(1 for r in rs if r["ae"] > 0),
            "not_proposed": [r["code"] for r in rs if not r["proposed"]],
        }

    gated_codes = {r["code"] for r in gated}
    exact_codes = {r["code"] for r in gated if r["exact"]}
    green_rows = []
    for c, pls in pred.items():
        for p in pls:
            if p.get("level") != "green" or c in disputed:
                continue
            if c in gated_codes or c not in truth_lines:
                green_rows.append(c in exact_codes)
    per_level: dict[str, Any] = {}
    for lvl in ("green", "yellow", "red"):
        sub = [r for r in gated if r["level"] == lvl]
        per_level[lvl] = _rate(sum(r["exact"] for r in sub), len(sub))
    by_chapter: dict[str, float] = defaultdict(float)
    for r in gated:
        by_chapter[r["code"].split(".")[0]] += r["ae"]
    return {
        "boq_lines": {
            "scope": list(scope),
            "gated": summary(gated),
            "disputed": summary(disp),
            "all_in_scope": summary(rows),
            "sum_ae_by_chapter": dict(by_chapter),
            "green_line_precision": _rate(sum(green_rows), len(green_rows)),
            "exact_by_level": per_level,
            "extra_lines": extra,
            "by_floor": floors,
            "by_floor_summary": _rate(
                sum(1 for f in floors if f["exact"] and not f["disputed"]), sum(1 for f in floors if not f["disputed"])
            ),
            "format_errors": format_errors,
            "lines": rows,
        }
    }


def _sum_floors(pls: list[dict[str, Any]]) -> dict[str, float]:
    out: dict[str, float] = defaultdict(float)
    for p in pls:
        for fl, v in (p.get("byFloor") or {}).items():
            out[str(fl)] += _num(v)
    return dict(out)


def render_boq_markdown(m: dict[str, Any]) -> str:
    b = m["boq_lines"]
    g, d = b["gated"], b["disputed"]

    def r(x: dict[str, Any]) -> str:
        return f"{x['k']}/{x['n']} = {x['p']}" + (f" (LB95 {x['wilson_lb95']:.3f})" if x.get("wilson_lb95") is not None else "")

    out = [
        "# kbench — BOQ lines",
        "",
        f"gt_version: {m.get('gt_version')} · model: {m.get('model_version')} · scope: {', '.join(b['scope'])}",
        "",
        "| set | lines | exact match | within tol | ΣAE | median PE | P90 PE | lines AE>0 | not proposed |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for name, s in (("gated", g), ("disputed (not gated)", d)):
        wt = r(s["within_tolerance"]) if "within_tolerance" in s else "-"
        out.append(
            f"| {name} | {s['n_lines']} | {r(s['exact_match'])} | {wt} | {s['sum_ae']} | {s['median_pe']} | {s['p90_pe']} | "
            f"{s['n_ae_gt_0']} | {', '.join(s['not_proposed']) or '-'} |"
        )
    out += [
        "",
        f"Green-line precision: {r(b['green_line_precision'])}",
        f"Per-floor cells exact: {r(b['by_floor_summary'])}",
        "",
        "| code | truth | pred | AE | PE | exact / within tol | expected (GT rules) | level | disputed |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for x in b["lines"]:
        ok = "yes" if x["exact"] else ("within tol" if x.get("within_tol") else "no")
        exp = "-" if x.get("expected") is None else f"{x['expected']:g}"
        out.append(
            f"| {x['code']} | {x['truth']:g} | {x['pred']:g} | {x['ae']:g} | {x['pe']:.3f} | {ok} | {exp} | "
            f"{x['level']} | {x['dispute_id'] or ('yes' if x['disputed'] else '')} |"
        )
    if b["extra_lines"]:
        out += ["", "Extra lines (not in truth): " + ", ".join(f"{e['code']}={e['qty']:g}" for e in b["extra_lines"])]
    if b["format_errors"]:
        out += ["", "Format errors: " + "; ".join(b["format_errors"])]
    return "\n".join(out) + "\n"


def write_json(path: str | Path, obj: Any) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
