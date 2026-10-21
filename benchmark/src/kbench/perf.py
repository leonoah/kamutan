"""Sprint 5: ``kbench perf`` — worker pipeline timing on the Noah set (test plan "ביצועים", NFR).

Two ways in:

* ``--run``: runs the worker's own profiler ``workers/drawing/scripts/perf_local.py`` (Worker-Cal owns it) in the
  worker's environment (``uv run --project <worker-dir> --no-sync``; sync it first) on ``$KAMUTAN_DATA_DIR`` x
  ``--repeats``, into a scratch artifacts root (deleted afterwards unless ``--keep-root``);
* ``--raw FILE``: analyses an existing ``perf_local.py --json`` output.

Raw rows: ``{fileId, repeat, status, wallS, timingsMs: {stage: ms}, peakRssMb}``. ``timingsMs`` is the worker's
``stats.timingsMs`` (Sprint 5); a row without it falls back to wall-clock (``timing_source = "wall"``).

Summary: P50 / P95 / max per stage over all successful pages x repeats (nearest-rank percentile), wall-clock per
page, per-sheet mean / max, peak RSS, total set time per repeat. Gate (``--gate``, exit 1): no failed page; A3 page
P95 (wall-clock, every Noah sheet is A3) < ``--a3-p95-s`` (60 s); slowest repeat of the set < ``--set-s`` (600 s);
with ``--baseline``: page P95 not more than 20% above the baseline's (test plan regression table).
"""

from __future__ import annotations

import json
import math
import os
import platform
import shutil

# fixed argv list, never a shell
import subprocess  # nosec B404
import sys
import tempfile
import time
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import __version__

KNOWN_STAGES = ("render", "primitives", "ocr", "legend", "symbols", "rooms", "fixtures", "links", "artifacts", "boq", "total")
OK_STATUSES = ("ready", "succeeded", "skipped")
WORKER_SCRIPT = "scripts/perf_local.py"


@dataclass(frozen=True)
class PerfThresholds:
    a3_p95_s: float = 60.0
    set_s: float = 600.0
    p95_regression: float = 0.20


def pct(values: Sequence[float], q: float) -> float | None:
    """Nearest-rank percentile (q in 0..100); None for no values."""
    if not values:
        return None
    s = sorted(values)
    return float(s[max(0, min(len(s) - 1, math.ceil(q / 100 * len(s)) - 1))])


def _dist(values: Sequence[float]) -> dict[str, Any]:
    return {
        "n": len(values),
        "p50": _r(pct(values, 50)),
        "p95": _r(pct(values, 95)),
        "max": _r(max(values) if values else None),
        "mean": _r(sum(values) / len(values) if values else None),
    }


def _r(v: float | None, nd: int = 2) -> float | None:
    return None if v is None else round(v, nd)


def _slowest_stage(rows: Sequence[dict[str, Any]]) -> str | None:
    """Stage with the largest mean time over the rows of one sheet (``total`` excluded)."""
    sums: dict[str, float] = defaultdict(float)
    for r in rows:
        for k, v in (r.get("timingsMs") or {}).items():
            if k != "total":
                sums[k] += float(v)
    return max(sums, key=lambda k: sums[k]) if sums else None


def load_raw(paths: Sequence[str | Path]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for p in paths:
        doc = json.loads(Path(p).read_text(encoding="utf-8"))
        rows += list(doc["rows"] if isinstance(doc, dict) else doc)
    return rows


def summarize(rows: Sequence[dict[str, Any]]) -> dict[str, Any]:
    ok = [r for r in rows if str(r.get("status")) in OK_STATUSES]
    failed = [{"fileId": r.get("fileId"), "repeat": r.get("repeat"), "status": r.get("status")} for r in rows if r not in ok]
    stage_names = [s for s in KNOWN_STAGES if any(s in (r.get("timingsMs") or {}) for r in ok)]
    stage_names += sorted({k for r in ok for k in (r.get("timingsMs") or {})} - set(stage_names))
    stages = {st: _dist([float(r["timingsMs"][st]) / 1000 for r in ok if st in (r.get("timingsMs") or {})]) for st in stage_names}
    n_wall_only = sum(1 for r in ok if not r.get("timingsMs"))
    page_s = [float(r.get("wallS") or 0.0) for r in ok]
    # per-page processing time: the worker's own total when it reports one, else wall-clock
    total_s = [float((r.get("timingsMs") or {}).get("total", 1000 * float(r.get("wallS") or 0))) / 1000 for r in ok]
    per_sheet: dict[str, dict[str, Any]] = {}
    by_sheet: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in ok:
        by_sheet[str(r.get("fileId"))].append(r)
    for fid, rs in sorted(by_sheet.items()):
        w = [float(r.get("wallS") or 0) for r in rs]
        per_sheet[fid] = {
            "discipline": rs[0].get("discipline"),
            "n": len(rs),
            "wall_mean_s": _r(sum(w) / len(w)),
            "wall_max_s": _r(max(w)),
            "peak_rss_mb": _r(max(float(r.get("peakRssMb") or 0) for r in rs), 1),
            "slowest_stage": _slowest_stage(rs),
        }
    by_rep: dict[int, float] = defaultdict(float)
    for r in rows:
        by_rep[int(r.get("repeat") or 1)] += float(r.get("wallS") or 0)
    sets = [round(v, 1) for _, v in sorted(by_rep.items())]
    rss = [float(r.get("peakRssMb") or 0) for r in rows]
    return {
        "n_rows": len(rows),
        "n_ok": len(ok),
        "failed": failed,
        "timing_source": "wall" if n_wall_only == len(ok) else ("mixed" if n_wall_only else "timingsMs"),
        "n_rows_wall_only": n_wall_only,
        "stages_s": stages,
        "page_wall_s": _dist(page_s),
        "page_total_s": _dist(total_s),
        # CPU seconds of the page (worker process tree), when the profiler reports it: less sensitive to a shared box
        "page_cpu_s": _dist([float(r["cpuS"]) for r in ok if r.get("cpuS") is not None]),
        "per_sheet": per_sheet,
        "set_seconds_per_repeat": sets,
        "set_seconds_max": max(sets) if sets else None,
        "peak_rss_mb": _r(max(rss) if rss else None, 1),
        "repeats": sorted(by_rep),
    }


def gate(summary: dict[str, Any], th: PerfThresholds, baseline: dict[str, Any] | None = None) -> dict[str, Any]:
    checks = []

    def add(name: str, value: Any, limit: Any, ok: bool, note: str = "") -> None:
        checks.append({"check": name, "value": value, "limit": limit, "pass": bool(ok), "note": note})

    add("no failed page", len(summary["failed"]), 0, not summary["failed"])
    p95 = summary["page_wall_s"]["p95"]
    add("A3 page P95 (wall-clock) < limit", p95, th.a3_p95_s, p95 is not None and p95 < th.a3_p95_s, "every Noah sheet is A3")
    sm = summary["set_seconds_max"]
    add("15-sheet set (slowest repeat) < limit", sm, th.set_s, sm is not None and sm < th.set_s)
    if baseline is not None:
        b = (baseline.get("summary") or baseline).get("page_wall_s", {}).get("p95")
        lim = None if b is None else round(b * (1 + th.p95_regression), 2)
        add(
            f"page P95 regression <= {int(th.p95_regression * 100)}%",
            p95,
            lim,
            lim is None or (p95 is not None and p95 <= lim),
            f"baseline P95 {b}",
        )
    return {"pass": all(c["pass"] for c in checks), "checks": checks}


def environment() -> dict[str, Any]:
    cpu = None
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                cpu = line.split(":", 1)[1].strip()
                break
    except OSError:
        pass
    try:
        load = os.getloadavg()
    except OSError:
        load = None
    return {
        "nproc": os.cpu_count(),
        "cpu": cpu,
        "platform": platform.platform(),
        "python": sys.version.split()[0],
        "loadavg_at_start": None if load is None else [round(x, 2) for x in load],
    }


def run_worker_perf(
    worker_dir: str | Path,
    data_dir: str | Path,
    repeats: int,
    raw_out: str | Path,
    *,
    root: str | Path | None = None,
    keep_root: bool = False,
    only: str = "",
    uv: str = "uv",
) -> dict[str, Any]:
    """Run the worker's ``scripts/perf_local.py``; returns {argv, seconds, returncode, root}."""
    worker_dir = Path(worker_dir).resolve()
    script = worker_dir / WORKER_SCRIPT
    if not script.exists():
        raise FileNotFoundError(f"{script} not found (the worker profiler owned by Worker-Cal)")
    tmp = None
    if root is None:
        tmp = tempfile.mkdtemp(prefix="kbench-perf-")
        root = tmp
    argv = [
        shutil.which(uv) or uv,
        "run",
        "--project",
        str(worker_dir),
        "--no-sync",
        "python",
        str(script),
        "--out",
        str(root),
        "--repeats",
        str(repeats),
        "--json",
        str(Path(raw_out).resolve()),
    ]
    if only:
        argv += ["--only", only]
    env = {k: v for k, v in os.environ.items() if k != "VIRTUAL_ENV"} | {"KAMUTAN_DATA_DIR": str(data_dir)}
    t0 = time.monotonic()
    try:
        # fixed argv list (uv + the worker's own script), never a shell
        proc = subprocess.run(argv, cwd=worker_dir, env=env, check=False)  # nosec B603
    finally:
        if tmp is not None and not keep_root:
            shutil.rmtree(tmp, ignore_errors=True)
    return {"argv": argv, "seconds": round(time.monotonic() - t0, 1), "returncode": proc.returncode, "root": str(root)}


def render_perf_markdown(m: dict[str, Any]) -> str:
    s, g = m["summary"], m.get("gate")
    env = m.get("environment") or {}

    def f(v: Any) -> str:
        return "-" if v is None else str(v)

    L = [
        "# kbench perf — worker pipeline timing",
        "",
        (
            f"{s['n_ok']}/{s['n_rows']} pages ok over repeats {s['repeats']}; timing source **{s['timing_source']}** "
            f"({s['n_rows_wall_only']} wall-clock-only rows). Box: {env.get('nproc')} vCPU {f(env.get('cpu'))}, "
            f"load at start {env.get('loadavg_at_start')}."
        ),
        "",
        "| stage | n | P50 s | P95 s | max s | mean s |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for st, d in s["stages_s"].items():
        L.append(f"| {st} | {d['n']} | {f(d['p50'])} | {f(d['p95'])} | {f(d['max'])} | {f(d['mean'])} |")
    w = s["page_wall_s"]
    L.append(f"| **page wall-clock** | {w['n']} | {f(w['p50'])} | {f(w['p95'])} | {f(w['max'])} | {f(w['mean'])} |")
    c = s.get("page_cpu_s") or {"n": 0}
    if c["n"]:
        L.append(f"| page CPU | {c['n']} | {f(c['p50'])} | {f(c['p95'])} | {f(c['max'])} | {f(c['mean'])} |")
    L += [
        "",
        f"- 15-sheet set per repeat (s): {s['set_seconds_per_repeat']} (max {s['set_seconds_max']})",
        f"- peak RSS (process tree): {s['peak_rss_mb']} MB",
        f"- failed pages: {s['failed'] or 'none'}",
        "",
        "| sheet | discipline | n | mean s | max s | peak RSS MB | slowest stage |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for fid, d in s["per_sheet"].items():
        L.append(
            f"| {fid} | {f(d['discipline'])} | {d['n']} | {d['wall_mean_s']} | {d['wall_max_s']} | {d['peak_rss_mb']} | "
            f"{f(d['slowest_stage'])} |"
        )
    if g:
        L += [
            "",
            f"## Gate: **{'PASS' if g['pass'] else 'FAIL'}**",
            "",
            "| check | value | limit | result | note |",
            "| --- | --- | --- | --- | --- |",
        ]
        for c in g["checks"]:
            L.append(f"| {c['check']} | {f(c['value'])} | {f(c['limit'])} | {'pass' if c['pass'] else 'FAIL'} | {c['note']} |")
    L.append("")
    return "\n".join(L)


def build_result(
    rows: Sequence[dict[str, Any]],
    th: PerfThresholds,
    baseline: dict[str, Any] | None = None,
    run: dict[str, Any] | None = None,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    summary = summarize(rows)
    return {
        "kbench_version": __version__,
        **(meta or {}),
        "environment": environment(),
        "run": run,
        "thresholds": th.__dict__,
        "summary": summary,
        "gate": gate(summary, th, baseline),
        "rows": list(rows),
    }
