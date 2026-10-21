#!/usr/bin/env python3
"""DAST gate for OWASP ZAP JSON reports (SEC testing table: "DAST ... 0 High").

Fails (exit 1) when a report contains
  * a High alert (riskcode 3) whose plugin id is not IGNOREd in the rules file, or
  * any alert of a plugin marked FAIL in the rules file (security-header regressions).
Writes a Markdown summary (alert name, plugin id, risk, instance count; never request/response bodies)
to stdout and to $GITHUB_STEP_SUMMARY when set.

Usage: zap_gate.py --rules .zap/rules.tsv REPORT.json [REPORT.json ...]
A missing or unparsable report is an error (a scan that did not run must not pass the gate).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

RISK = {"0": "Info", "1": "Low", "2": "Medium", "3": "High"}


def load_rules(path: Path) -> dict[str, str]:
    rules: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        if not raw.strip() or raw.startswith("#"):
            continue
        parts = raw.split("\t")
        if len(parts) < 2 or parts[1].strip().upper() not in {"IGNORE", "WARN", "FAIL", "INFO", "OUTOFSCOPE"}:
            raise SystemExit(f"bad rules line: {raw!r}")
        rules[parts[0].strip()] = parts[1].strip().upper()
    return rules


def alerts(report: Path) -> list[dict[str, str]]:
    data = json.loads(report.read_text(encoding="utf-8"))
    out = []
    for site in data.get("site", []):
        for a in site.get("alerts", []):
            out.append(
                {
                    "site": str(site.get("@name", "")),
                    "plugin": str(a.get("pluginid", "")),
                    "name": str(a.get("name") or a.get("alert") or ""),
                    "risk": str(a.get("riskcode", "0")),
                    "count": str(a.get("count") or len(a.get("instances", []))),
                }
            )
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rules", type=Path, required=True)
    ap.add_argument("reports", type=Path, nargs="+")
    ns = ap.parse_args(argv)
    rules = load_rules(ns.rules)

    lines = ["## DAST (OWASP ZAP)", ""]
    failures: list[str] = []
    for rep in ns.reports:
        if not rep.is_file():
            failures.append(f"{rep}: report missing (scan did not run)")
            lines.append(f"### {rep.parent.name or rep.name}: report missing")
            continue
        try:
            found = alerts(rep)
        except (OSError, ValueError) as exc:
            failures.append(f"{rep}: unreadable report ({exc.__class__.__name__})")
            continue
        lines += [f"### {rep.parent.name or rep.stem}", "", "| Risk | Plugin | Alert | Instances | Rule | Gate |", "| --- | --- | --- | --- | --- | --- |"]
        for a in sorted(found, key=lambda x: (-int(x["risk"]), x["plugin"])):
            rule = rules.get(a["plugin"], "WARN")
            gate = "pass"
            if rule == "FAIL":
                gate = "**FAIL** (rule)"
            elif a["risk"] == "3" and rule != "IGNORE":
                gate = "**FAIL** (High)"
            if gate != "pass":
                failures.append(f"{rep.parent.name}: {a['plugin']} {a['name']} ({RISK.get(a['risk'], a['risk'])}) on {a['site']}")
            lines.append(f"| {RISK.get(a['risk'], a['risk'])} | {a['plugin']} | {a['name']} | {a['count']} | {rule} | {gate} |")
        if not found:
            lines.append("| - | - | no alerts | - | - | pass |")
        lines.append("")
    lines.append(f"**Gate: {'FAILED' if failures else 'passed'}** (0 High not ignored, no FAIL-rule alerts).")
    text = "\n".join(lines) + "\n"
    print(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(text)
    for f in failures:
        print(f"::error::DAST gate: {f}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
