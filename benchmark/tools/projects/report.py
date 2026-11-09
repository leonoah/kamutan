#!/usr/bin/env python3
"""Sprint 10 Data/QA: baseline report per project + side-by-side with Noah + catalogue diff.

    uv run python tools/projects/report.py [--label baseline] [--projects noah rubel achituv yahav]

Reads gt/<p>/eval/<label>.json (library imported from the header-repaired xlsx) and <label>_orig.json (original xls),
plus s10qa/<p>/<label>/artifacts/ingest-report.json, classifies every truth line with catalogue.py and writes
gt/<p>/eval/baseline.md (ingest table, per-chapter table, catalogue diff, per-line table) and
gt/eval_sprint10_<label>.md (the projects side by side with Noah + the merged catalogue diff).
kbench's own markdown (written by run_eval.sh as <label>.md) is renamed to <label>.kbench.md.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from catalogue import DATA, GT, classify

CHAPTER_LABELS = {
    "1": "01 הריסה",
    "2": "02 בנייה",
    "3": "03 אינסטלציה",
    "4": "04 חשמל",
    "5": "05 ריצוף/חיפוי/איטום",
    "7": "06 גבס (7.xx)",
    "8": "07 טיח וצבע (8.xx)",
    "9": "08 שונות (9.xx)",
}
ABBR = {
    "exact": "✔",
    "within_tol": "≈",
    "suggested_right_unit": "sugg",
    "suggested_wrong_unit": "sugg/unit",
    "wrong_unit": "unit",
    "wrong_qty": "✘",
    "missing": "—",
}
HDR = (
    "| run | lines | present | exact | exact or within | of which from a suggested default | computed from drawings | "
    "suggested, right unit | wrong qty/unit | missing |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
)
SUPPORT_ORDER = ["none", "suggested", "partial", "rule"]


def load(p: str, name: str) -> dict[str, Any] | None:
    f = GT / p / "eval" / f"{name}.json"
    md = GT / p / "eval" / f"{name}.md"
    if md.exists() and md.read_text(encoding="utf-8").startswith("# kbench"):
        md.rename(GT / p / "eval" / f"{name}.kbench.md")
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else None


def summary_row(name: str, m: dict[str, Any]) -> str:
    a = m["coverage"]["all"]
    sc = a["status_counts"]
    wrong = sc["wrong_qty"] + sc["wrong_unit"] + sc["suggested_wrong_unit"]
    return (
        f"| {name} | {a['n_lines']} | {a['present']['k']} | {a['exact']['k']} | {a['exact_or_within_tol']['k']} | "
        f"{a['ok_from_suggested']} | {a['exact_or_within_tol']['k'] - a['ok_from_suggested']} | "
        f"{sc['suggested_right_unit']} | {wrong} | {a['missing']['k']} |"
    )


def ingest_table(p: str, label: str) -> list[str]:
    """Per-sheet ingest outcome from s10qa/<p>/<label>/artifacts/ingest-report.json + sample-<p>/files.tsv."""
    root = DATA / "s10qa" / p / label
    rep = root / "artifacts" / "ingest-report.json"
    if not rep.exists():
        return ["(no ingest report)"]
    names: dict[str, str] = {}
    tsv = DATA / f"sample-{p}" / "files.tsv"
    if tsv.exists():
        for ln in tsv.read_text(encoding="utf-8").splitlines():
            k, v = ln.split("\t")
            names[k.removeprefix("sheet_")] = v
    rows = json.loads(rep.read_text(encoding="utf-8"))
    o = [
        "| sheet id | file | status | discipline | floors | scale | level | regions | s |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    n_fail = 0
    for r in rows:
        st = r["status"]
        if isinstance(st, dict) or str(st).startswith("failed"):
            n_fail += 1
            code = st.get("code") if isinstance(st, dict) else re.sub(r".*'code': '([a-z_]+)'.*", r"\1", str(st), flags=re.DOTALL)
            st = f"**failed: {'memory limit' if 'memory' in str(code) else code}**"
        o.append(
            f"| {r['fileId']} | {names.get(r['fileId'], '?')} | {st} | {r.get('discipline')} | {r.get('floors')} | "
            f"{r.get('scale')} | {r.get('level')} | {r.get('regions')} | {r.get('seconds')} |"
        )
    wall = ""
    log = root / "ingest.log"
    if log.exists():
        for ln in log.read_text(encoding="utf-8", errors="replace").splitlines():
            if ln.startswith("ingest exit"):
                wall = ln
    o += [
        "",
        (
            f"{len(rows)} sheets, **{n_fail} failed** (parse_memory_limit / parse_crashed = SIGKILL in the sandboxed parser; "
            f"owned by the Sprint-10 Perf agent, not analysed here). {wall}"
        ),
    ]
    return o


def chapter_table(m: dict[str, Any], truth_lines: dict[str, dict[str, Any]]) -> list[str]:
    o = [
        "| chapter | lines | present | exact | within | wrong qty/unit | suggested | missing | zero-qty lines |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    by: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in m["coverage"]["lines"]:
        by[r["chapter"]].append(r)
    for ch in sorted(by, key=lambda c: (len(c), c)):
        rs = by[ch]
        st = Counter(r["status"] for r in rs)
        zero = [r["code"] for r in rs if "zero_quantity" in truth_lines[r["code"]].get("flags", [])]
        o.append(
            f"| {CHAPTER_LABELS.get(ch, ch)} | {len(rs)} | {sum(r['present'] for r in rs)} | {st['exact']} | "
            f"{st['within_tol']} | {st['wrong_qty'] + st['wrong_unit'] + st['suggested_wrong_unit']} | "
            f"{st['suggested_right_unit']} | {st['missing']} | {', '.join(zero) or '-'} |"
        )
    return o


def line_table(m: dict[str, Any], m_orig: dict[str, Any] | None, truth_lines: dict[str, dict[str, Any]]) -> list[str]:
    o = [
        "| code | unit | BOQ | kind | support | pred | status | origin | level | 2nd build pred |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    orig = {r["code"]: r for r in m_orig["coverage"]["lines"]} if m_orig else {}
    for r in m["coverage"]["lines"]:
        t = truth_lines[r["code"]]
        k, _, s = classify(t["description"])
        pred = "-" if r["pred"] is None else f"{r['pred']:g}"
        ro = orig.get(r["code"])
        po = "" if not ro else ("-" if ro["pred"] is None else f"{ro['pred']:g} {ABBR[ro['status']]}")
        o.append(
            f"| {r['code']} | {r['unit']} | {r['truth']:g} | {k} | {s} | {pred} | {ABBR[r['status']]} {r['status']} | "
            f"{','.join(r['origins']) or '-'} | {','.join(r['levels']) or '-'} | {po} |"
        )
    return o


def catalogue_diff(items: list[tuple[str, dict[str, Any], dict[str, Any] | None]]) -> list[str]:
    """items = [(project, truth_line, coverage_row)] → table group × kind × support with per-project lines/status."""
    groups: dict[str, dict[str, list[tuple[str, dict[str, Any], dict[str, Any] | None]]]] = defaultdict(lambda: defaultdict(list))
    for p, t, r in items:
        k, g, s = classify(t["description"])
        groups[g][f"{k}|{s}"].append((p, t, r))
    o = [
        "| group | kind | Kamutan support | lines (project code=qty · baseline status) | missing / all |",
        "| --- | --- | --- | --- | --- |",
    ]
    totals: Counter[str] = Counter()
    miss: Counter[str] = Counter()
    for g in sorted(groups):
        for ks in sorted(groups[g], key=lambda x: (SUPPORT_ORDER.index(x.split("|")[1]), x)):
            k, s = ks.split("|")
            rows = groups[g][ks]
            cells = [f"{p[:2]} {t['code']}={t['quantity']:g}{ABBR[r['status']] if r else '?'}" for p, t, r in rows]
            n_missing = sum(1 for _, _, r in rows if r and r["status"] == "missing")
            totals[s] += len(rows)
            miss[s] += n_missing
            o.append(f"| {g} | `{k}` | **{s}** | {' · '.join(cells)} | {n_missing}/{len(rows)} |")
    o += [
        "",
        "Lines per support class (missing / all): "
        + ", ".join(f"**{s}** {miss[s]}/{totals[s]}" for s in SUPPORT_ORDER if totals[s]),
    ]
    return o


# Pre-loss Noah reference (workers/drawing/NOTES.md "Sprint 9 … Noah — clean full re-ingest" and the Sprint-10
# Worker-Accuracy "before" run). Kept as constants: the eval files themselves were lost with the data volume on 09.11.
PRELOSS_NOAH: list[tuple[str, dict[str, int | None]]] = [
    (
        "noah pre-loss s9leg_after (demo room settings)",
        {"present": 77, "exact": 61, "ok": 63, "gated_ok": 54, "disputed_exact": 9},
    ),
    (
        "noah pre-loss s10acc_before_nors (no room settings)",
        {"present": 77, "exact": 59, "ok": 60, "gated_ok": None, "disputed_exact": None},
    ),
]
GATE_HDR = (
    "| run | lines | gated lines | gated exact | gated exact or within | disputed lines | disputed exact |\n"
    "| --- | --- | --- | --- | --- | --- | --- |"
)


def gate_row(name: str, m: dict[str, Any]) -> str:
    c = m["coverage"]
    g, d = c["gated"], c["disputed"]
    return (
        f"| {name} | {c['all']['n_lines']} | {g['n_lines']} | {g['exact']['k']} | {g['exact_or_within_tol']['k']} | "
        f"{d['n_lines']} | {d['exact']['k']} |"
    )


def variants(p: str) -> list[tuple[str, str]]:
    """(suffix, description) of the builds run_eval.sh makes for a project; the first is the headline build."""
    if p == "noah":
        return [("", "demo room settings (Noah library)"), ("_nors", "no room settings")]
    return [("", "project library (header-repaired import)"), ("_orig", "original xls import")]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="baseline")
    ap.add_argument("--projects", nargs="*", default=["noah", "rubel", "achituv", "yahav"])
    a = ap.parse_args()
    side = [
        f"# Sprint 10 — baselines side by side (`{a.label}`: clean CLI ingest, no corrections, `KAMUTAN_AV_SCAN=off`)",
        "",
        (
            "Noah is the regression anchor (its own library, two builds: demo room settings / none). The three new projects "
            "use their own BOQ as the library and an empty room-settings file (`_orig` = the xls as shipped)."
        ),
        "",
        HDR,
    ]
    gates = ["", "## Gated / disputed (lines of open GT-D disputes are never gated)", "", GATE_HDR]
    all_items: list[tuple[str, dict[str, Any], dict[str, Any] | None]] = []
    for p in a.projects:
        runs = [(suf, desc, load(p, f"{a.label}{suf}")) for suf, desc in variants(p)]
        truth_f = GT / p / "boq_truth.json"
        if not runs[0][2] or not truth_f.exists():
            side.append(f"| {p} | (no {a.label}.json yet) | | | | | | | | |")
            continue
        m = runs[0][2]
        truth = json.loads(truth_f.read_text(encoding="utf-8"))
        tl = {ln["code"]: ln for ln in truth["lines"]}
        rows = {r["code"]: r for r in m["coverage"]["lines"]}
        for suf, desc, mm in runs:
            if mm:
                side.append(summary_row(f"{p}{suf} — {desc}", mm))
                gates.append(gate_row(f"{p}{suf}", mm))
        if p == "noah":
            for name, ref in PRELOSS_NOAH:
                side.append(f"| {name} | 77 | {ref['present']} | {ref['exact']} | {ref['ok']} | | | | | |")
                gates.append(
                    f"| {name} | 77 | 66 | | {ref['gated_ok'] if ref['gated_ok'] is not None else ''} | 11 | {ref['disputed_exact'] if ref['disputed_exact'] is not None else ''} |"
                )
        else:
            all_items += [(p, tl[c], rows.get(c)) for c in tl]
        o = [
            f"# {p} — Sprint 10 baseline (`{a.label}`)",
            "",
            (
                f"Model `{m.get('model_version')}` · pred `{m['source']['pred_lines']}` · truth {len(tl)} scored lines "
                f"(+{len(truth.get('excluded_lines', []))} excluded: בוטל / לא לסיכום, never scored)."
            ),
            "",
            (
                "Runs: `benchmark/tools/projects/run_eval.sh <project> <label>` = fresh `ingest_local.py --force` of every PDF, "
                "then `boq_local.py --no-corrections`, then `kbench eval-boq --scope all`. Builds: "
                + "; ".join(f"`{a.label}{suf}` = {desc}" for suf, desc, _ in runs)
                + "."
            ),
            "",
            HDR,
        ]
        o += [summary_row(f"{a.label}{suf} — {desc}", mm) for suf, desc, mm in runs if mm]
        if p == "noah":
            o += [f"| {name} | 77 | {ref['present']} | {ref['exact']} | {ref['ok']} | | | | | |" for name, ref in PRELOSS_NOAH]
        o += ["", GATE_HDR] + [gate_row(f"{a.label}{suf}", mm) for suf, _, mm in runs if mm]
        o += ["", "## Ingest (fresh `ingest_local.py --force`)", ""] + ingest_table(p, a.label)
        o += ["", f"## Per chapter ({runs[0][1]})", ""] + chapter_table(m, tl)
        c = m["coverage"]["checks"]
        o += [
            "",
            (
                f"Predicted lines by origin: {dict(sorted(m['coverage']['pred_origin_counts'].items()))} · "
                f"extra codes (not in the client BOQ): {', '.join(c['extra_codes']) or 'none'} · "
                f"green suggested lines: {', '.join(c['suggested_lines_green']) or 'none'}"
            ),
        ]
        if p != "noah":
            o += [
                "",
                "## Catalogue diff (this project)",
                "",
                (
                    "`support`: **rule** = a rule kind + default rule exists for this line type; **partial** = a rule kind "
                    "exists but not the designer's parameter (points per two-way, cobra Ø+length, 3-phase by appliance, panel "
                    "kind, profile length…); **suggested** = only a suggested/one-off default; **none** = nothing in Kamutan "
                    "can produce it."
                ),
                "",
            ] + catalogue_diff([(p, tl[c], rows.get(c)) for c in tl])
        second = runs[1][2]
        o += [
            "",
            "## Per line",
            "",
            (
                "Status: ✔ exact · ≈ within tol · sugg = suggested right unit · ✘ wrong qty · unit = wrong unit · — missing. "
                f"Last column = the `{a.label}{runs[1][0]}` build."
            ),
            "",
        ] + line_table(m, second, tl)
        out_md = GT / p / "eval" / ("baseline.md" if a.label == "baseline" else f"{a.label}.summary.md")
        out_md.write_text("\n".join(o) + "\n", encoding="utf-8")
        print(f"wrote {out_md}")
    side += gates
    if all_items:
        side += ["", "## Catalogue diff — new projects merged (ru = rubel, ac = achituv, ya = yahav)", ""]
        side += catalogue_diff(all_items)
    (GT / f"eval_sprint10_{a.label}.md").write_text("\n".join(side) + "\n", encoding="utf-8")
    print("\n".join(side[:14]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
