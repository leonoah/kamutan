"""DEV ONLY: per-stage timing profile of the real worker pipeline on the sample sheets (Sprint 5, NFR A3 P95 < 60 s).

    cd workers/drawing
    KAMUTAN_DATA_DIR=/home/claude/kamutan-data/sample-noah \
      uv run python scripts/perf_local.py --out /tmp/perf-root [--repeats 3] [--only id,id] [--json report.json]

* input: ``$KAMUTAN_DATA_DIR`` (never copied); output root ``--out`` (Storage layout + ``_firestore``), outside the repo.
* every sheet is ingested through ``process_sheet_version`` exactly like the Cloud Run worker (one org, so the
  glyph dictionary warms up as in production; construction / architecture plans first so the MEP sheets
  borrow their walls). Repeat ``r`` writes version ``v{r}`` (fresh job → no idempotent skip).
* per page: ``stats.timingsMs`` of the version doc when the worker writes it (Sprint 5), else the page /
  understand task timings mapped onto the same stage names; wall-clock seconds of the page; peak RSS of the
  whole process tree (orchestrator + sandbox children, sampled every 50 ms from ``/proc``).
* prints P50 / P95 per stage over all pages × repeats, wall clock and CPU seconds per page (CPU = this process +
  its sandbox children; a better yardstick than wall clock on a box shared with other jobs), and the peak RSS.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any, Self

from kamutan_drawing.cli import ingest_file
from kamutan_drawing.service.pipeline import Options, PageOutcome

HERE = Path(__file__).resolve().parent
_data = Path(os.environ.get("KAMUTAN_DATA_DIR", "/home/claude/kamutan-data/sample-noah"))
SAMPLES = _data if list(_data.glob("sheet_*.pdf")) else _data / "sample-noah"
STAGES = ("render", "primitives", "ocr", "legend", "symbols", "rooms", "fixtures", "links", "artifacts", "total")
ORDER = {"construction": 0, "architecture": 1, "architecture_master": 2}


def _children(pid: int) -> list[int]:
    out: list[int] = []
    try:
        for tid in os.listdir(f"/proc/{pid}/task"):
            try:
                out += [int(c) for c in Path(f"/proc/{pid}/task/{tid}/children").read_text().split()]
            except OSError:
                continue
    except OSError:
        pass
    return out


def _rss_kb(pid: int) -> int:
    try:
        for line in Path(f"/proc/{pid}/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1])
    except OSError:
        pass
    return 0


class RssSampler:
    """Peak resident set size of this process + all its descendants (sum), sampled every ``period`` s."""

    def __init__(self, period: float = 0.05) -> None:
        self.period, self.peak_kb, self._stop = period, 0, threading.Event()
        self._t = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        me = os.getpid()
        while not self._stop.is_set():
            todo, total, seen = [me], 0, set()
            while todo:
                p = todo.pop()
                if p in seen:
                    continue
                seen.add(p)
                total += _rss_kb(p)
                todo += _children(p)
            self.peak_kb = max(self.peak_kb, total)
            self._stop.wait(self.period)

    def reset(self) -> int:
        k, self.peak_kb = self.peak_kb, 0
        return k

    def __enter__(self) -> Self:
        self._t.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._stop.set()
        self._t.join()


def _cpu_s() -> float:
    """User + system CPU seconds of this process and its waited-for children (the sandbox tasks) — less sensitive
    than wall clock to other load on a shared box."""
    import resource

    a, b = resource.getrusage(resource.RUSAGE_SELF), resource.getrusage(resource.RUSAGE_CHILDREN)
    return a.ru_utime + a.ru_stime + b.ru_utime + b.ru_stime


def legacy_timings(page: dict[str, Any], seconds: float) -> dict[str, int]:
    """Sprint-4 workers report task timings only: map them onto the Sprint-5 stage names (ms)."""
    pt = page.get("timings") or {}
    ut = ((page.get("understanding") or {}).get("timings")) or {}

    def ms(*vals: Any) -> int:
        return round(1000 * sum(float(v or 0) for v in vals))

    return {
        "render": ms(pt.get("render")),
        "primitives": ms(pt.get("ingest")),
        "ocr": ms(pt.get("ocr"), pt.get("classify"), pt.get("regions")),
        "legend": ms(ut.get("legend")),
        "symbols": ms(ut.get("detect")),
        "rooms": ms(ut.get("rooms")),
        "fixtures": ms(ut.get("fixtures"), ut.get("lifecycle")),
        "links": ms(ut.get("links")),
        "artifacts": ms(pt.get("write"), ut.get("write")),
        "total": ms(seconds),
    }


def pct(vals: list[float], q: float) -> float:
    """Nearest-rank percentile (q in 0..100)."""
    if not vals:
        return 0.0
    s = sorted(vals)
    return float(s[max(0, min(len(s) - 1, math.ceil(q / 100 * len(s)) - 1))])


def expected_disciplines() -> dict[str, str]:
    sys.path.insert(0, str(HERE))
    try:
        from ingest_local import expected_from_spike  # type: ignore[import-not-found]

        return {k: str(v.get("discipline")) for k, v in expected_from_spike().items()}
    except Exception:  # noqa: BLE001 - ordering is a nicety
        return {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True, help="artifacts root (outside the repo)")
    ap.add_argument("--repeats", type=int, default=1)
    ap.add_argument("--only", default="")
    ap.add_argument("--json", type=Path, default=None)
    ap.add_argument("--dpi", type=int, default=300)
    a = ap.parse_args()
    files = sorted(SAMPLES.glob("sheet_*.pdf"))
    if a.only:
        want = {s.strip() for s in a.only.split(",") if s.strip()}
        files = [f for f in files if f.stem.removeprefix("sheet_") in want]
    if not files:
        print(f"no sample PDFs in {SAMPLES}", file=sys.stderr)
        return 2
    disc = expected_disciplines()
    files.sort(key=lambda f: (ORDER.get(disc.get(f.stem.removeprefix("sheet_"), ""), 3), f.stem))
    a.out.mkdir(parents=True, exist_ok=True)
    opts = Options(dpi=a.dpi)
    rows: list[dict[str, Any]] = []
    with RssSampler() as rss:
        for r in range(1, a.repeats + 1):
            for f in files:
                fid = f.stem.removeprefix("sheet_")
                pages: list[PageOutcome] = []
                rss.reset()
                cpu0 = _cpu_s()
                t0 = time.monotonic()
                res = ingest_file(
                    f,
                    a.out,
                    org="org-perf",
                    project="p-noah",
                    sheet_set_id=f"noah-{fid}",
                    version_id=f"v{r}",
                    options=opts,
                    on_page=pages.append,
                )
                wall = time.monotonic() - t0
                cpu = _cpu_s() - cpu0
                p = pages[0] if pages else None
                v = res.sheets[0]["version"] if res.sheets else {}
                tm = (v.get("stats") or {}).get("timingsMs")
                if not tm and p is not None and p.result is not None:
                    tm = legacy_timings(p.result, p.seconds)
                row = {
                    "fileId": fid,
                    "repeat": r,
                    "status": p.status if p else "failed",
                    "discipline": (res.sheets[0]["sheet"].get("discipline") if res.sheets else None),
                    "wallS": round(wall, 2),
                    "cpuS": round(cpu, 2),
                    "timingsMs": tm or {},
                    "peakRssMb": round(rss.reset() / 1024, 1),
                    "calibration": (v.get("stats") or {}).get("calibration"),
                }
                rows.append(row)
                print(
                    f"r{r} {fid} {row['discipline']}: {row['wallS']} s (cpu {row['cpuS']} s), peak {row['peakRssMb']} MB, {row['timingsMs']}",
                    flush=True,
                )
    summary: dict[str, Any] = {}
    for st in STAGES:
        vals = [float(rw["timingsMs"].get(st, 0)) / 1000 for rw in rows if rw["status"] == "ready"]
        summary[st] = {"p50": round(pct(vals, 50), 2), "p95": round(pct(vals, 95), 2), "max": round(max(vals or [0]), 2)}
    walls = [rw["wallS"] for rw in rows]
    summary["wall"] = {"p50": round(pct(walls, 50), 2), "p95": round(pct(walls, 95), 2), "max": round(max(walls), 2)}
    cpus = [rw["cpuS"] for rw in rows]
    summary["cpu"] = {"p50": round(pct(cpus, 50), 2), "p95": round(pct(cpus, 95), 2), "max": round(max(cpus), 2)}
    summary["peakRssMb"] = max(rw["peakRssMb"] for rw in rows)
    summary["setSeconds"] = round(sum(walls) / max(1, a.repeats), 1)
    print("\nstage        P50 s   P95 s   max s")
    for st in (*STAGES, "wall", "cpu"):
        s = summary[st]
        print(f"{st:<12} {s['p50']:>6} {s['p95']:>7} {s['max']:>7}")
    print(f"peak RSS {summary['peakRssMb']} MB; 15-sheet set {summary['setSeconds']} s per repeat")
    if a.json:
        a.json.write_text(json.dumps({"rows": rows, "summary": summary}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
