"""DEV ONLY: ingest the sample-noah PDFs with the real worker pipeline into the local artifacts root.

    cd workers/drawing
    uv run python scripts/ingest_local.py [--only c054fd3a,eb8be8a3] [--force] [--dpi 300] [--no-ocr]

* input:  $KAMUTAN_DATA_DIR (default /home/claude/kamutan-data/sample-noah) — never copied anywhere;
* output: $KAMUTAN_DEV_ARTIFACTS (default /home/claude/kamutan-data/artifacts) with the Storage
  layout of production (``orgs/org-demo/projects/p-noah/sheets/noah-{id}-p0/versions/v1/tiles/{z}/{x}_{y}.webp``,
  ``thumbnail.webp``, ``primitives.msgpack.gz``, ``text.json.gz``), Firestore docs as JSON under
  ``_firestore/`` (stores.local), a ``version.json`` per version dir and ``dev-index.json`` at the
  root — the ids/paths the web mock mode uses (apps/web/src/api/mockSheets.ts, served by
  apps/web/build/devArtifacts.ts at /dev-artifacts/). Both directories are outside the repo.
* prints a per-sheet table and compares the classification with spikes/SHEET_CLASSIFICATION.md;
* Sprint 2: the understanding stage (legend → detect → rooms) writes ``legend.json.gz``,
  ``detections.json.gz``, ``rooms.json.gz`` + crops per version; their paths are in the index entry
  (top level and under ``artifacts``) and per-sheet legend / detection / room counts are printed and
  saved in ``understanding-report.json``. ``--no-understand`` skips the stage.

Already processed sheets (same sha256 + version) are skipped by the pipeline's idempotency;
``--force`` re-runs them.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path
from typing import Any

from kamutan_drawing.cli import IngestResult, ingest_file
from kamutan_drawing.service.pipeline import Options, PageOutcome

HERE = Path(__file__).resolve().parent
_data = Path(os.environ.get("KAMUTAN_DATA_DIR", "/home/claude/kamutan-data/sample-noah"))
SAMPLES = _data if list(_data.glob("sheet_*.pdf")) else _data / "sample-noah"
OUT = Path(os.environ.get("KAMUTAN_DEV_ARTIFACTS", "/home/claude/kamutan-data/artifacts"))
ORG, PROJECT, VERSION = "org-demo", "p-noah", "v1"
SPIKE_TABLE = HERE.parent / "spikes" / "SHEET_CLASSIFICATION.md"


def expected_from_spike() -> dict[str, dict[str, Any]]:
    """file id -> {discipline, floors} from the Sprint-0 spike table."""
    out: dict[str, dict[str, Any]] = {}
    if not SPIKE_TABLE.exists():
        return out
    for line in SPIKE_TABLE.read_text(encoding="utf-8").splitlines():
        m = re.match(r"\|\s*sheet_([0-9a-f]{8})\s*\|", line)
        if not m:
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        disc = re.findall(r"`([a-z_]+)`", cells[2])
        floors = re.findall(r"`([a-z0-9_-]+)`", cells[3])
        scale = re.search(r"1:(\d+)", cells[4])
        out[m.group(1)] = {
            "discipline": disc[0] if disc else None,
            "floors": floors,
            "scale": int(scale.group(1)) if scale else None,
        }
    return out


def reset_version(file_id: str) -> None:
    """--force: forget the previous run (job result + version artifacts) so the pipeline re-runs it."""
    set_id = f"noah-{file_id}"
    sid = f"{set_id}-p0"
    for p in (
        OUT / "_firestore" / "jobs" / f"ingest-{set_id}-{VERSION}.json",
        OUT / "_firestore" / "orgs" / ORG / "projects" / PROJECT / "sheets" / sid / "versions" / f"{VERSION}.json",
    ):
        p.unlink(missing_ok=True)
    shutil.rmtree(OUT / "orgs" / ORG / "projects" / PROJECT / "sheets" / sid / "versions" / VERSION, ignore_errors=True)


def index_entry(file_id: str, res: IngestResult, page: PageOutcome | None) -> dict[str, Any] | None:
    if not res.sheets:
        return None
    s = res.sheets[0]
    v, sheet = s["version"], s["sheet"]
    tiles = v.get("artifacts", {}).get("tiles")
    if not tiles:
        return None
    prefix = tiles["prefix"].rstrip("/")  # dev-index/web mock convention: no trailing slash
    vdir = OUT / prefix.rsplit("/tiles", 1)[0]
    tile_count = sum(1 for _ in (OUT / prefix).rglob("*.webp"))
    entry = {
        "sheetId": s["sheetId"],
        "versionId": VERSION,
        "fileId": file_id,
        "sheetSetId": res.sheet_set_id,
        "page": v.get("page"),
        "tiles": {**tiles, "prefix": prefix},
        "thumbnail": v["artifacts"]["thumbnail"],
        "primitives": v["artifacts"].get("primitives"),
        "text": v["artifacts"].get("text"),
        "legend": v["artifacts"].get("legend"),
        "detections": v["artifacts"].get("detections"),
        "rooms": v["artifacts"].get("rooms"),
        "artifacts": {k: v["artifacts"][k] for k in ("legend", "detections", "rooms") if v["artifacts"].get(k)},
        "tileCount": tile_count,
        "status": v.get("status"),
        "title": sheet.get("title"),
        "discipline": sheet.get("discipline"),
        "floors": sheet.get("floors"),
        "scaleDenominator": sheet.get("scaleDenominator"),
        "classification": sheet.get("classification"),
        "regions": v.get("regions", []),
        "stats": v.get("stats"),
        "workerVersion": v.get("workerVersion"),
        "seconds": page.seconds if page else None,
    }
    (vdir / "version.json").write_text(json.dumps(entry, ensure_ascii=False, indent=2))
    return entry


def understanding_row(file_id: str, entry: dict[str, Any] | None, page: PageOutcome | None) -> dict[str, Any] | None:
    """Per-sheet legend / detection / room summary from the version stats and the legend artifact."""
    if not entry or not entry.get("legend"):
        return None
    stats = entry.get("stats") or {}
    labels: list[str] = []
    try:
        leg = json.loads(gzip.decompress((OUT / entry["legend"]).read_bytes()))
        labels = [f"{e['label']} → {e['suggestedClass']}" for e in leg.get("entries", [])]
    except (OSError, ValueError, KeyError):
        pass
    und = ((page.result or {}).get("understanding") if page else None) or {}
    return {
        "fileId": file_id,
        "discipline": entry.get("discipline"),
        "legendEntries": stats.get("legendEntries", 0),
        "labels": labels,
        "detections": stats.get("detections") or {"total": 0, "green": 0, "yellow": 0, "red": 0, "unknown": 0, "byClass": {}},
        "rooms": stats.get("rooms", 0),
        "timings": und.get("timings"),
        "seconds": page.seconds if page else None,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="comma separated file ids (default: all sheet_*.pdf)")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--dpi", type=int, default=300)
    ap.add_argument("--no-ocr", action="store_true")
    ap.add_argument("--no-understand", action="store_true", help="skip legend / detect / rooms")
    a = ap.parse_args()
    files = sorted(SAMPLES.glob("sheet_*.pdf"))
    if a.only:
        want = {s.strip() for s in a.only.split(",") if s.strip()}
        files = [f for f in files if f.stem.removeprefix("sheet_") in want]
    if not files:
        print(f"no sample PDFs in {SAMPLES}", file=sys.stderr)
        return 2
    OUT.mkdir(parents=True, exist_ok=True)
    opts = Options(ocr=not a.no_ocr, dpi=a.dpi, understand=not a.no_understand)
    expected = expected_from_spike()
    index_path = OUT / "dev-index.json"
    try:
        index = {e["fileId"]: e for e in json.loads(index_path.read_text())}
    except (OSError, ValueError, KeyError, TypeError):
        index = {}
    rows = []
    und_rows: list[dict[str, Any]] = []
    t_all = time.monotonic()
    for f in files:
        fid = f.stem.removeprefix("sheet_")
        if a.force:
            reset_version(fid)
        t0 = time.monotonic()
        pages: list[PageOutcome] = []
        res = ingest_file(
            f, OUT, org=ORG, project=PROJECT, sheet_set_id=f"noah-{fid}", version_id=VERSION, options=opts, on_page=pages.append
        )
        wall = round(time.monotonic() - t0, 1)
        entry = index_entry(fid, res, pages[0] if pages else None)
        if entry is not None:
            index[fid] = entry
        exp = expected.get(fid, {})
        cls = (entry or {}).get("classification") or {}
        status = res.outcome.status if res.outcome else f"failed {res.error}"
        row = {
            "fileId": fid,
            "status": status,
            "discipline": (entry or {}).get("discipline"),
            "floors": (entry or {}).get("floors"),
            "scale": (entry or {}).get("scaleDenominator"),
            "level": cls.get("level"),
            "confidence": cls.get("confidence"),
            "regions": [r["floor"] for r in (entry or {}).get("regions", [])],
            "seconds": pages[0].seconds if pages else wall,
            "tiles": (entry or {}).get("tileCount"),
            "expected": exp,
            "agrees": bool(exp)
            and exp.get("discipline") == (entry or {}).get("discipline")
            and exp.get("floors") == (entry or {}).get("floors")
            and exp.get("scale") == (entry or {}).get("scaleDenominator"),
        }
        rows.append(row)
        und = understanding_row(fid, entry, pages[0] if pages else None)
        if und:
            und_rows.append(und)
            print(
                f"   legend={und['legendEntries']} rooms={und['rooms']} detections={und['detections']['total']} "
                f"(g{und['detections']['green']}/y{und['detections']['yellow']}/r{und['detections']['red']}) "
                f"byClass={und['detections']['byClass']} stage={und['timings']}",
                flush=True,
            )
        print(
            f"{fid}: {row['status']:9} {row['discipline']!s:20} {row['floors']!s:24} 1:{row['scale']} {row['level']!s:6} "
            f"conf={row['confidence']} regions={row['regions']} tiles={row['tiles']} {row['seconds']}s "
            f"{'agrees' if row['agrees'] else 'DIFFERS from spike ' + json.dumps(exp)}",
            flush=True,
        )
    index_path.write_text(json.dumps(sorted(index.values(), key=lambda e: e["fileId"]), ensure_ascii=False, indent=2))
    (OUT / "ingest-report.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    if und_rows:
        (OUT / "understanding-report.json").write_text(json.dumps(und_rows, ensure_ascii=False, indent=2))
    n_ok = sum(1 for r in rows if r["agrees"])
    print(f"\n{len(rows)} sheets in {time.monotonic() - t_all:.0f}s; classification agrees with the spike on {n_ok}/{len(rows)}")
    print(f"dev index: {index_path}")
    return 0 if all(r["status"] in ("succeeded", "skipped") for r in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
