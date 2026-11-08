"""Dataset generation: one directory per sheet (PDF, DXF, GT, BOQ truth, rasters) + a manifest."""

from __future__ import annotations

import hashlib
import json
import os
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import __version__
from .catalog import NEW_TAXONOMY_CLASSES
from .library import write_library
from .render_dxf import render_dxf
from .render_pdf import render_pdf
from .render_raster import make_render, render_page
from .sheet import compose
from .spec import DIFFICULTIES, DISCIPLINES, make_spec, sheet_rng

MIX_DIFFICULTY = {"easy": 0.3, "medium": 0.4, "hard": 0.3}
MIX_DISCIPLINE = {"electrical": 0.3, "lighting": 0.25, "electrical_lighting": 0.15, "plumbing": 0.3}


@dataclass(frozen=True)
class Job:
    seed: int
    index: int
    difficulty: str
    discipline: str
    out: str
    rasters: int
    dxf: bool
    preview: bool


def _quota(n: int, mix: dict[str, float]) -> list[str]:
    keys = list(mix)
    counts = {k: int(n * mix[k]) for k in keys}
    i = 0
    while sum(counts.values()) < n:
        counts[keys[i % len(keys)]] += 1
        i += 1
    return [k for k in keys for _ in range(counts[k])]


def plan_jobs(
    n: int,
    seed: int,
    out: Path,
    *,
    rasters: int = 1,
    dxf: bool = True,
    preview: bool = True,
    difficulties: list[str] | None = None,
    disciplines: list[str] | None = None,
) -> list[Job]:
    """Balanced (difficulty, discipline) mix, shuffled deterministically from the seed."""
    dmix = {k: v for k, v in MIX_DIFFICULTY.items() if not difficulties or k in difficulties}
    cmix = {k: v for k, v in MIX_DISCIPLINE.items() if not disciplines or k in disciplines}
    diffs = _quota(n, dmix)
    discs = _quota(n, cmix)
    rng = sheet_rng(seed, -1, "mix")
    rng.shuffle(diffs)
    rng.shuffle(discs)
    return [Job(seed, i, diffs[i], discs[i], str(out), rasters, dxf, preview) for i in range(n)]


def _sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run_job(job: Job) -> dict[str, Any]:
    t0 = time.perf_counter()
    spec = make_spec(job.seed, job.index, job.difficulty, job.discipline, job.rasters)
    res = compose(spec)
    d = Path(job.out) / "sheets" / spec.sheet_id
    (d / "renders").mkdir(parents=True, exist_ok=True)
    pdf = d / f"{spec.sheet_id}.pdf"
    render_pdf(res.scene, pdf, title=res.gt["synth"]["title_fields"]["sheet_name"])
    t_pdf = time.perf_counter()
    blocks: dict[str, str | None] = {}
    if job.dxf:
        blocks = render_dxf(res.scene, d / f"{spec.sheet_id}.dxf", int(res.gt["kamutan"]["scale"]), spec.sheet_id)
    t_dxf = time.perf_counter()
    for f in res.gt["features"]:
        p = f["properties"]
        if p["kind"] in ("symbol", "context") and f["id"] in blocks:
            p["dxf_block"] = blocks[f["id"]]
    renders = []
    page = (res.scene.width, res.scene.height)
    for i, opts in enumerate(spec.rasters):
        name = f"{spec.sheet_id}_r{i}.{opts.get('format', 'png')}"
        renders.append(make_render(pdf, page, opts, d / "renders" / name, seed=job.seed * 100003 + job.index * 101 + i))
    if job.preview:
        render_page(pdf, 60).save(d / "preview.png", optimize=False)
    t_ras = time.perf_counter()
    res.gt["synth"]["renders"] = renders
    res.gt["kamutan"]["source_sha256"] = _sha(pdf)
    (d / "gt.json").write_text(json.dumps(res.gt, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    (d / "boq_truth.json").write_text(json.dumps(res.boq, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    (d / "renders.json").write_text(json.dumps(renders, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    t1 = time.perf_counter()
    n_sym = sum(1 for f in res.gt["features"] if f["properties"]["kind"] == "symbol")
    return {
        "file_id": spec.sheet_id,
        "file_name": f"sheets/{spec.sheet_id}/{spec.sheet_id}.pdf",
        "kind": "pdf",
        "bytes": pdf.stat().st_size,
        "sha256": res.gt["kamutan"]["source_sha256"],
        "discipline": res.gt["kamutan"]["discipline"],
        "disciplines": res.gt["kamutan"]["disciplines"],
        "floors": res.gt["kamutan"]["floors"],
        "orientation": "landscape",
        "paper": res.gt["synth"]["paper"],
        "scale": res.gt["kamutan"]["scale"],
        "difficulty": spec.difficulty,
        "text_mode": spec.text_mode,
        "symbols": n_sym,
        "dxf": f"sheets/{spec.sheet_id}/{spec.sheet_id}.dxf" if job.dxf else None,
        "gt": f"sheets/{spec.sheet_id}/gt.json",
        "boq_truth": f"sheets/{spec.sheet_id}/boq_truth.json",
        "renders": [f"sheets/{spec.sheet_id}/renders/{r['file']}" for r in renders],
        "_timing": {
            "total_s": round(t1 - t0, 3),
            "compose_pdf_s": round(t_pdf - t0, 3),
            "dxf_s": round(t_dxf - t_pdf, 3),
            "raster_s": round(t_ras - t_dxf, 3),
        },
    }


def generate(jobs: list[Job], out: Path, *, workers: int = 1, name: str = "synth") -> dict[str, Any]:
    out.mkdir(parents=True, exist_ok=True)
    write_library(out / "library.xlsx")
    t0 = time.perf_counter()
    if workers > 1:
        with ProcessPoolExecutor(max_workers=workers) as ex:
            rows = list(ex.map(run_job, jobs, chunksize=2))
    else:
        rows = [run_job(j) for j in jobs]
    wall = time.perf_counter() - t0
    timings = {r["file_id"]: r.pop("_timing") for r in rows}
    seed = jobs[0].seed if jobs else 0
    manifest = {
        "schema_version": "1.0",
        "project_id": name,
        "split": "synthetic",
        "data_location": f"outside git: {out}",
        "generator": f"kamutan-synth {__version__}",
        "seed": seed,
        "n": len(rows),
        "mix": {
            "difficulty": {k: sum(1 for r in rows if r["difficulty"] == k) for k in DIFFICULTIES},
            "discipline": {k: sum(1 for j in jobs if j.discipline == k) for k in DISCIPLINES},
        },
        "layout": "sheets/<sheet_id>/{<sheet_id>.pdf, <sheet_id>.dxf, gt.json, boq_truth.json, renders.json, renders/*, preview.png}",
        "library": "library.xlsx",
        "new_taxonomy_classes": NEW_TAXONOMY_CLASSES,
        "files": rows,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    tot = [t["total_s"] for t in timings.values()]
    stats = {
        "workers": workers,
        "wall_s": round(wall, 2),
        "sheets": len(rows),
        "per_sheet_s": {"mean": round(sum(tot) / max(1, len(tot)), 3), "max": round(max(tot, default=0.0), 3)},
        "cpu_count": os.cpu_count(),
        "sheets_timing": timings,
    }
    (out / "timings.json").write_text(json.dumps(stats, indent=1) + "\n", encoding="utf-8")
    return stats
