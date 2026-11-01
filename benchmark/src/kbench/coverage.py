"""BOQ coverage over every chapter (Sprint 6): is each client-BOQ line present in the system's BOQ, and how good is it?

Input: the truth project (``boq_truth.json`` + ``disputes.json``), the worker's ``boq-lines.json`` and optionally the
computability reference ``s6_lines.json`` (``coverage_reference``: computable / partial / not_on_drawings per code).

Per truth line (all chapters, codes compared as TEXT), the predicted lines with the same code are pooled:
``Q̂`` = sum of the non-null ``qty`` (*before review*: ``qtyOverride`` is ignored). A predicted line is *suggested* when
``origin == "suggested"`` or ``needsInput`` is true. Units compare by kind after normalisation (gershayim / geresh,
``יח'`` = ``יחידה``): count, area, length, lump sum.

Status (mutually exclusive, first match wins):

- ``exact``: right unit, Q̂ == Q (lump sums too);
- ``within_tol``: right unit, area/length line, PE = |Q̂ − Q| / Q within the line tolerance (cladding 3%, flooring 2%,
  length 2%, other area 2%, or the line's ``tolerance_pe``);
- ``suggested_right_unit``: only suggested lines, right unit, quantity null or outside tolerance;
- ``suggested_wrong_unit``: only suggested lines, wrong unit;
- ``wrong_unit``: a computed line with the wrong unit;
- ``wrong_qty``: a computed line with the right unit, quantity outside tolerance (or null);
- ``missing``: no predicted line with that code ("silent omission").

Cumulative metrics: present = not missing; exact; exact-or-within-tolerance; suggested-with-right-unit; missing.
Reported over all truth lines, the gated set (not disputed) and the disputed set (GT-D-*) separately, per chapter, per
computability class and per origin. Checks: a suggested line must never be green; a ``needsInput`` line should carry a
``quickAction``. Target (Sprint-6 brief): exact-or-within ≥ 45 and present == all lines.
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from .data import Project, unit_kind
from .metrics import EvalConfig, line_tolerance
from .stats import wilson_lower

STATUSES = (
    "exact",
    "within_tol",
    "suggested_right_unit",
    "suggested_wrong_unit",
    "wrong_unit",
    "wrong_qty",
    "missing",
)
COMPUTABILITY = ("computable", "partial", "not_on_drawings")
DEFAULT_TARGET_OK = 45
# code major -> client chapter (Noah: chapters 06-08 use codes 7.xx-9.xx, NOTES "Known gaps")
CHAPTER_LABELS = {
    "1": "01 demolition",
    "2": "02 construction",
    "3": "03 plumbing",
    "4": "04 electrical",
    "5": "05 tiling",
    "7": "06 gypsum (7.xx)",
    "8": "07 plaster & paint (8.xx)",
    "9": "08 misc (9.xx)",
}


def norm_unit(unit: Any) -> str:
    u = str(unit or "").strip().replace("״", '"').replace("׳", "'").replace("''", '"')
    u = " ".join(u.split())
    if u in ("יחי'", "יח׳", "יחידות", "יח'"):
        return "יחידה"
    return u


def unit_class(unit: Any) -> str:
    u = norm_unit(unit)
    k = unit_kind(u)
    return k if k != "other" else f"other:{u}"


def is_suggested(p: dict[str, Any]) -> bool:
    return p.get("origin") == "suggested" or bool(p.get("needsInput"))


def _num(v: Any) -> float | None:
    if v is None or isinstance(v, bool):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def load_computability(path: str | Path | None) -> dict[str, str]:
    """{code: computable|partial|not_on_drawings} from ``s6_lines.json`` (``coverage_reference`` or ``lines``)."""
    if not path or not Path(path).is_file():
        return {}
    d = json.loads(Path(path).read_text(encoding="utf-8"))
    out: dict[str, str] = {}
    for key in ("lines", "coverage_reference"):
        for x in d.get(key) or []:
            if isinstance(x, dict) and isinstance(x.get("code"), str) and x.get("computability"):
                out[x["code"]] = str(x["computability"])
    return out


def classify_line(tl: dict[str, Any], pls: list[dict[str, Any]], cfg: EvalConfig | None = None) -> dict[str, Any]:
    cfg = cfg or EvalConfig()
    q = _num(tl.get("quantity")) or 0.0
    tkind = unit_class(tl.get("unit"))
    qs = [v for v in (_num(p.get("qty")) for p in pls) if v is not None]
    qh = sum(qs) if qs else None
    suggested = bool(pls) and all(is_suggested(p) for p in pls)
    unit_ok = bool(pls) and all(unit_class(p.get("unit") or tl.get("unit")) == tkind for p in pls)
    measured = tkind in ("area", "length")
    tol = line_tolerance(tl, cfg) if measured else 0.0
    ae = None if qh is None else abs(qh - q)
    pe = None if ae is None else (ae / q if q else (0.0 if ae < 1e-9 else 1.0))
    exact = unit_ok and ae is not None and ae < 1e-9
    within = unit_ok and measured and pe is not None and pe <= tol + 1e-9
    if not pls:
        status = "missing"
    elif exact:
        status = "exact"
    elif within:
        status = "within_tol"
    elif suggested:
        status = "suggested_right_unit" if unit_ok else "suggested_wrong_unit"
    elif not unit_ok:
        status = "wrong_unit"
    else:
        status = "wrong_qty"
    origins = sorted({str(p.get("origin") or "detected") for p in pls})
    levels = sorted({str(p.get("level")) for p in pls if p.get("level") is not None})
    return {
        "truth": q,
        "pred": qh,
        "ae": None if ae is None else round(ae, 6),
        "pe": None if pe is None else round(pe, 6),
        "tolerance_pe": tol,
        "unit": tl.get("unit"),
        "pred_units": sorted({str(p.get("unit")) for p in pls if p.get("unit") is not None}),
        "unit_ok": unit_ok,
        "suggested": suggested,
        "origins": origins,
        "levels": levels,
        "needs_input": any(bool(p.get("needsInput")) for p in pls),
        "quick_action": sorted({str((p.get("quickAction") or {}).get("kind")) for p in pls if p.get("quickAction")}),
        "n_pred_lines": len(pls),
        "status": status,
        "present": bool(pls),
        "exact": status == "exact",
        "ok": status in ("exact", "within_tol"),
    }


def _rate(k: int, n: int) -> dict[str, Any]:
    return {"k": k, "n": n, "p": round(k / n, 4) if n else None, "wilson_lb95": wilson_lower(k, n)}


def _summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    n = len(rows)
    st = Counter(r["status"] for r in rows)
    return {
        "n_lines": n,
        "present": _rate(sum(r["present"] for r in rows), n),
        "exact": _rate(st["exact"], n),
        "exact_or_within_tol": _rate(st["exact"] + st["within_tol"], n),
        "within_tol_only": st["within_tol"],
        # exact/within lines that came only from suggested lines (estimator / default qty, e.g. lump sum 1): "without
        # touch" but not computed from the drawing; reported so the headline is not read as drawing accuracy
        "ok_from_suggested": sum(1 for r in rows if r["ok"] and r["suggested"]),
        "suggested_right_unit": st["suggested_right_unit"],
        "missing": _rate(st["missing"], n),
        "status_counts": {s: st[s] for s in STATUSES},
        "missing_codes": [r["code"] for r in rows if r["status"] == "missing"],
    }


def evaluate_boq_coverage(
    truth: Project,
    pred_lines: list[dict[str, Any]],
    computability: dict[str, str] | None = None,
    target_ok: int = DEFAULT_TARGET_OK,
) -> dict[str, Any]:
    cfg = EvalConfig()
    computability = computability or {}
    disputed = truth.open_dispute_codes()
    pred: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for ln in pred_lines:
        pred[str(ln.get("code"))].append(ln)
    truth_lines = truth.boq_lines()
    tcodes = {str(t["code"]) for t in truth_lines}
    rows: list[dict[str, Any]] = []
    for tl in truth_lines:
        code = str(tl["code"])
        r = {"code": code, "chapter": code.split(".")[0], "description": tl.get("description")}
        r |= classify_line(tl, pred.get(code, []), cfg)
        r["disputed"] = code in disputed
        r["dispute_id"] = tl.get("dispute_id")
        r["computability"] = computability.get(code)
        rows.append(r)
    gated = [r for r in rows if not r["disputed"]]
    disp = [r for r in rows if r["disputed"]]
    chapters: dict[str, Any] = {}
    for ch in sorted({r["chapter"] for r in rows}, key=lambda c: (len(c), c)):
        chapters[ch] = _summary([r for r in rows if r["chapter"] == ch])
    by_comp: dict[str, Any] = {}
    for c in (*COMPUTABILITY, None):
        sub = [r for r in rows if r["computability"] == c]
        if sub:
            by_comp[str(c) if c else "unknown"] = _summary(sub)
    origin_counts = Counter(str(p.get("origin") or "detected") for p in pred_lines)
    green_suggested = sorted({str(p.get("code")) for p in pred_lines if is_suggested(p) and p.get("level") == "green"})
    no_action = sorted({str(p.get("code")) for p in pred_lines if p.get("needsInput") and not p.get("quickAction")})
    extra = sorted({c for c in pred if c not in tcodes})
    allsum = _summary(rows)
    ok = allsum["exact"]["k"] + allsum["within_tol_only"]
    return {
        "coverage": {
            "all": allsum,
            "gated": _summary(gated),
            "disputed": _summary(disp),
            "by_chapter": chapters,
            "by_computability": by_comp,
            "pred_origin_counts": dict(origin_counts),
            "checks": {
                "suggested_lines_green": green_suggested,
                "needs_input_without_quick_action": no_action,
                "extra_codes": extra,
            },
            "target": {
                "exact_or_within_tol_min": target_ok,
                "exact_or_within_tol": ok,
                "present_all": allsum["present"]["k"] == len(rows),
                "pass": ok >= target_ok and allsum["present"]["k"] == len(rows) and not green_suggested,
            },
            "lines": rows,
        }
    }


def render_coverage_markdown(m: dict[str, Any]) -> str:
    c = m["coverage"]

    def r(x: dict[str, Any]) -> str:
        return f"{x['k']}/{x['n']}"

    out = [
        "## Coverage — every chapter",
        "",
        (
            "Status per line: exact · within tolerance · suggested (right unit) · suggested (wrong unit) · wrong unit · "
            "wrong qty · missing. Before review (`qtyOverride` ignored)."
        ),
        "",
        (
            "| set | lines | present | exact | exact or within tol | of which from a suggested line | suggested, right unit | "
            "wrong unit / qty | missing |"
        ),
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for name, s in (("all", c["all"]), ("gated (not disputed)", c["gated"]), ("disputed (GT-D-*)", c["disputed"])):
        sc = s["status_counts"]
        out.append(
            f"| {name} | {s['n_lines']} | {r(s['present'])} | {r(s['exact'])} | {r(s['exact_or_within_tol'])} | "
            f"{s['ok_from_suggested']} | "
            f"{s['suggested_right_unit']} | {sc['wrong_unit'] + sc['suggested_wrong_unit']} / {sc['wrong_qty']} | "
            f"{s['missing']['k']} |"
        )
    t = c["target"]
    out += [
        "",
        (
            f"Target: exact-or-within ≥ {t['exact_or_within_tol_min']} → **{t['exact_or_within_tol']}**; all lines present → "
            f"**{t['present_all']}**; no green suggested line → **{not c['checks']['suggested_lines_green']}** ⇒ "
            f"**{'PASS' if t['pass'] else 'FAIL'}**"
        ),
        "",
        "| code major (chapter) | lines | present | exact | exact or within | suggested right unit | missing codes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for ch, s in c["by_chapter"].items():
        out.append(
            f"| {ch} ({CHAPTER_LABELS.get(ch, '?')}) | {s['n_lines']} | {r(s['present'])} | {r(s['exact'])} | "
            f"{r(s['exact_or_within_tol'])} | "
            f"{s['suggested_right_unit']} | {', '.join(s['missing_codes']) or '-'} |"
        )
    if c["by_computability"]:
        out += [
            "",
            "| drawings carry it? | lines | present | exact or within | suggested right unit | missing |",
            "| --- | --- | --- | --- | --- | --- |",
        ]
        for k, s in c["by_computability"].items():
            out.append(
                f"| {k} | {s['n_lines']} | {r(s['present'])} | {r(s['exact_or_within_tol'])} | "
                f"{s['suggested_right_unit']} | {s['missing']['k']} |"
            )
    ch = c["checks"]
    out += [
        "",
        f"Predicted lines by origin: {dict(sorted(c['pred_origin_counts'].items()))}",
        f"Suggested lines that are green (must be none): {', '.join(ch['suggested_lines_green']) or 'none'}",
        f"needsInput without quickAction: {', '.join(ch['needs_input_without_quick_action']) or 'none'}",
        f"Extra codes (not in the client BOQ): {', '.join(ch['extra_codes']) or 'none'}",
        "",
        "| code | unit | truth | pred | PE | status | origin | level | computability | disputed |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for x in c["lines"]:
        pred = "-" if x["pred"] is None else f"{x['pred']:g}"
        pe = "-" if x["pe"] is None else f"{x['pe']:.3f}"
        out.append(
            f"| {x['code']} | {x['unit']} | {x['truth']:g} | {pred} | {pe} | {x['status']} | {','.join(x['origins']) or '-'} | "
            f"{','.join(x['levels']) or '-'} | {x['computability'] or '-'} | {x['dispute_id'] or ('yes' if x['disputed'] else '')} |"
        )
    return "\n".join(out) + "\n"
