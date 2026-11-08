"""Speed: about 2 s per sheet or less (PDF + DXF + one raster + preview), single process."""

from __future__ import annotations

import os
import time
from pathlib import Path

from kamutan_synth.generate import plan_jobs, run_job

BUDGET_S = float(os.environ.get("KAMUTAN_SYNTH_SPEED_BUDGET_S", "2.0"))


def test_mean_time_per_sheet(tmp_path: Path) -> None:
    jobs = plan_jobs(6, 123, tmp_path)
    run_job(jobs[0])  # warm-up: imports, font caches
    t0 = time.perf_counter()
    for j in jobs:
        run_job(j)
    mean = (time.perf_counter() - t0) / len(jobs)
    assert mean <= BUDGET_S, f"{mean:.2f} s/sheet > {BUDGET_S} s"
