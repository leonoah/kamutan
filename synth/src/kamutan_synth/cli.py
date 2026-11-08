"""kamutan-synth CLI.

kamutan-synth generate --n 300 --seed 1 --out /home/claude/kamutan-data/synth/v1 [--jobs 4]
kamutan-synth check /home/claude/kamutan-data/synth/v1
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .check import check_dataset
from .generate import generate, plan_jobs
from .spec import DIFFICULTIES, DISCIPLINES


def _csv(v: str | None, allowed: tuple[str, ...]) -> list[str] | None:
    if not v:
        return None
    out = [x.strip() for x in v.split(",") if x.strip()]
    bad = [x for x in out if x not in allowed]
    if bad:
        raise argparse.ArgumentTypeError(f"unknown value(s) {bad}; allowed {allowed}")
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="kamutan-synth", description="Synthetic Hebrew MEP drawings with exact ground truth")
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("generate", help="generate a dataset")
    g.add_argument("--n", type=int, required=True)
    g.add_argument("--seed", type=int, required=True)
    g.add_argument("--out", type=Path, required=True)
    g.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 1)))
    g.add_argument("--rasters", type=int, default=1, help="perturbed raster renders per sheet (0 = none)")
    g.add_argument("--no-dxf", action="store_true")
    g.add_argument("--no-preview", action="store_true")
    g.add_argument("--difficulty", help=f"comma list of {DIFFICULTIES}")
    g.add_argument("--discipline", help=f"comma list of {DISCIPLINES}")
    g.add_argument("--name", default="", help="manifest project_id (default synth-<seed>-<n>)")
    c = sub.add_parser("check", help="re-check GT / BOQ consistency of a generated dataset")
    c.add_argument("dataset", type=Path)
    args = ap.parse_args(argv)
    if args.cmd == "generate":
        jobs = plan_jobs(
            args.n,
            args.seed,
            args.out,
            rasters=args.rasters,
            dxf=not args.no_dxf,
            preview=not args.no_preview,
            difficulties=_csv(args.difficulty, DIFFICULTIES),
            disciplines=_csv(args.discipline, DISCIPLINES),
        )
        stats = generate(jobs, args.out, workers=args.jobs, name=args.name or f"synth-{args.seed}-{args.n}")
        print(json.dumps({k: v for k, v in stats.items() if k != "sheets_timing"}))
        return 0
    problems = check_dataset(args.dataset)
    for p in problems[:200]:
        print(p)
    print(f"{len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
