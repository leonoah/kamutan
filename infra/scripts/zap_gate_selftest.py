#!/usr/bin/env python3
"""Self-test for zap_gate.py (run in CI job `infra-scripts`): synthetic ZAP reports, no network."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
RULES = HERE.parents[1] / ".zap" / "rules.tsv"


def report(dirpath: Path, name: str, alerts: list[dict[str, str]]) -> Path:
    d = dirpath / name
    d.mkdir()
    p = d / "report_json.json"
    p.write_text(json.dumps({"site": [{"@name": "http://127.0.0.1", "alerts": alerts}]}), encoding="utf-8")
    return p


def gate(*paths: Path) -> int:
    cmd = [sys.executable, str(HERE / "zap_gate.py"), "--rules", str(RULES), *map(str, paths)]
    return subprocess.run(cmd, capture_output=True, text=True, check=False, env={"PATH": "/usr/bin:/bin"}).returncode


def main() -> int:
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        clean = report(tmp, "clean", [
            {"pluginid": "10055", "name": "CSP issue", "riskcode": "2", "count": "3"},
            {"pluginid": "10202", "name": "Absence of Anti-CSRF Tokens", "riskcode": "3", "count": "1"},  # IGNOREd
        ])
        high = report(tmp, "high", [{"pluginid": "40018", "name": "SQL Injection", "riskcode": "3", "count": "1"}])
        failrule = report(tmp, "failrule", [{"pluginid": "10038", "name": "CSP Header Not Set", "riskcode": "2", "count": "1"}])
        info_same_plugin = report(tmp, "info", [
            {"pluginid": "10038", "name": "Content Security Policy (CSP) Report-Only Header Found", "riskcode": "0", "count": "4"},
        ])
        empty = report(tmp, "empty", [])
        cases = [
            ("clean + ignored High passes", gate(clean, empty), 0),
            ("unignored High fails", gate(clean, high), 1),
            ("FAIL rule fails", gate(failrule), 1),
            ("informational alert under a FAIL plugin passes", gate(info_same_plugin), 0),
            ("missing report fails", gate(clean, tmp / "nope" / "report_json.json"), 1),
        ]
    bad = [c for c in cases if c[1] != c[2]]
    for name, got, want in cases:
        print(f"{'ok ' if got == want else 'BAD'} {name} (exit {got}, want {want})")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
