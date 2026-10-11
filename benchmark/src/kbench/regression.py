"""Regression gate: compare a metrics JSON against the baseline of `main`.

Thresholds follow the test plan table "ספי רגרסיה שחוסמים מיזוג" (values are fractions,
so 0.005 == 0.5 percentage points). Exit status: 0 = pass, 1 = blocking regression,
2 = not comparable (gt_version mismatch / malformed input).

Not implemented yet (documented in NOTES.md): the bootstrap significance test
(1,000 resamples by project) — with a single dev project it is meaningless, so every
threshold breach currently blocks.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .data import load_classes


@dataclass
class Thresholds:
    micro_f1_drop: float = 0.005
    core_class_f1_drop: float = 0.015
    items_correct_drop: float = 0.005
    p_green_floor: float = 0.98
    p_green_drop: float = 0.005
    ece_increase: float = 0.01
    burden_increase: float = 0.03
    p95_time_increase_rel: float = 0.20
    core_classes: list[str] = field(default_factory=list)

    @classmethod
    def load(cls, path: str | Path | None) -> "Thresholds":
        t = cls()
        if path:
            with open(path, encoding="utf-8") as f:
                for k, v in json.load(f).items():
                    if not hasattr(t, k):
                        raise ValueError(f"unknown threshold {k}")
                    setattr(t, k, v)
        if not t.core_classes:
            t.core_classes = sorted(c for c, v in load_classes().items() if v.get("core"))
        return t


@dataclass
class Check:
    name: str
    status: str  # pass | block | warn | skip
    baseline: Any
    current: Any
    detail: str = ""


def _get(d: dict, *path: str) -> Any:
    for p in path:
        if not isinstance(d, dict) or p not in d:
            return None
        d = d[p]
    return d


def _drop_check(name: str, base: float | None, cur: float | None, max_drop: float) -> Check:
    if base is None or cur is None:
        return Check(name, "skip", base, cur, "metric missing")
    drop = base - cur
    st = "block" if drop > max_drop + 1e-12 else "pass"
    return Check(name, st, base, cur, f"drop {drop:+.4f} (limit {max_drop})")


def compare(current: dict[str, Any], baseline: dict[str, Any], th: Thresholds) -> tuple[int, list[Check]]:
    gv_c = current.get("gt_version")
    gv_b = baseline.get("gt_version")
    if gv_c != gv_b:
        return 2, [Check("gt_version", "block", gv_b, gv_c, "comparison only allowed on the same gt_version")]
    checks: list[Check] = []

    checks.append(_drop_check("micro_f1", _get(baseline, "detection", "micro", "f1"),
                              _get(current, "detection", "micro", "f1"), th.micro_f1_drop))
    for c in th.core_classes:
        b = _get(baseline, "detection", "per_class", c, "f1")
        cur = _get(current, "detection", "per_class", c, "f1")
        if b is None and cur is None:
            continue
        if cur is None:
            cur = 0.0  # class disappeared from current run
        checks.append(_drop_check(f"f1[{c}]", b, cur, th.core_class_f1_drop))
    checks.append(_drop_check("items_correct", _get(baseline, "items_correct", "rate"),
                              _get(current, "items_correct", "rate"), th.items_correct_drop))

    pg_b = _get(baseline, "calibration", "green", "p_green")
    pg_c = _get(current, "calibration", "green", "p_green")
    if pg_b is None or pg_c is None:
        checks.append(Check("p_green", "skip", pg_b, pg_c, "metric missing"))
    else:
        drop = pg_b - pg_c
        block = (drop > 1e-12 and pg_c < th.p_green_floor) or drop > th.p_green_drop + 1e-12
        checks.append(Check("p_green", "block" if block else "pass", pg_b, pg_c,
                            f"drop {drop:+.4f}; blocks on any drop below {th.p_green_floor} or drop > {th.p_green_drop}"))

    e_b, e_c = _get(baseline, "calibration", "ece"), _get(current, "calibration", "ece")
    if e_b is None or e_c is None:
        checks.append(Check("ece", "skip", e_b, e_c, "metric missing"))
    else:
        inc = e_c - e_b
        checks.append(Check("ece", "block" if inc > th.ece_increase + 1e-12 else "pass", e_b, e_c,
                            f"increase {inc:+.4f} (limit {th.ece_increase})"))

    # smoke lines: any confirmed line that was correct in baseline and is wrong now
    base_ok = {(r["project_id"], r["code"]) for r in _get(baseline, "boq", "lines") or [] if r.get("correct")}
    cur_lines = {(r["project_id"], r["code"]): r for r in _get(current, "boq", "lines") or []}
    broken = sorted(f"{p}:{c}" for (p, c) in base_ok if not cur_lines.get((p, c), {}).get("correct", False))
    checks.append(Check("smoke_lines", "block" if broken else "pass", len(base_ok), len(base_ok) - len(broken),
                        ("newly wrong: " + ", ".join(broken)) if broken else ""))

    b_b, b_c = _get(baseline, "review_burden", "burden"), _get(current, "review_burden", "burden")
    if b_b is None or b_c is None:
        checks.append(Check("burden", "skip", b_b, b_c, "metric missing"))
    else:
        inc = b_c - b_b
        if inc > th.burden_increase + 1e-12:
            green_up = pg_b is not None and pg_c is not None and pg_c > pg_b
            checks.append(Check("burden", "warn" if green_up else "block", b_b, b_c,
                                f"increase {inc:+.4f}; P_green {'rose' if green_up else 'did not rise'}"))
        else:
            checks.append(Check("burden", "pass", b_b, b_c, f"increase {inc:+.4f}"))

    t_b = _get(baseline, "run", "timing", "p95_sheet_seconds")
    t_c = _get(current, "run", "timing", "p95_sheet_seconds")
    if t_b and t_c is not None:
        rel = (t_c - t_b) / t_b
        checks.append(Check("p95_sheet_time", "block" if rel > th.p95_time_increase_rel + 1e-12 else "pass",
                            t_b, t_c, f"relative {rel:+.1%}"))
    failures = _get(current, "run", "failures") or []
    checks.append(Check("run_failures", "block" if failures else "pass", None, len(failures),
                        "; ".join(map(str, failures))))
    if current.get("ceiling_violations"):
        checks.append(Check("ceiling_rules", "block", None, len(current["ceiling_violations"]),
                            "hard failure: raster green or scale-conflict area not red"))

    code = 1 if any(c.status == "block" for c in checks) else 0
    return code, checks


def checks_to_json(code: int, checks: list[Check]) -> dict[str, Any]:
    return {"exit_code": code, "result": {0: "pass", 1: "regression", 2: "not_comparable"}[code],
            "checks": [asdict(c) for c in checks]}


def checks_to_markdown(code: int, checks: list[Check]) -> str:
    head = {0: "PASS", 1: "BLOCKED — regression", 2: "NOT COMPARABLE"}[code]
    out = [f"# kbench regression gate: {head}", "", "| check | status | baseline | current | detail |",
           "| --- | --- | --- | --- | --- |"]
    for c in checks:
        out.append(f"| {c.name} | {c.status} | {_fmt(c.baseline)} | {_fmt(c.current)} | {c.detail} |")
    return "\n".join(out) + "\n"


def _fmt(v: Any) -> str:
    if isinstance(v, float):
        return f"{v:.4f}"
    return "—" if v is None else str(v)
