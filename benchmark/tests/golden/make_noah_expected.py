"""Generate the Noah golden expectations (15 sheets) OUTSIDE git.

Sources (all in the repo, no drawing content is copied beyond what they already hold):
  * workers/drawing/spikes/SHEET_CLASSIFICATION.md  — discipline / floors / scale / conf per sheet
  * benchmark/manifests/noah.json                     — file sha256 + manifest discipline/floors
  * workers/drawing/spikes/results/extract_stats.json — page size and vector/text counts (Sprint-0 extractor)

    python benchmark/tests/golden/make_noah_expected.py [--out /home/claude/kamutan-data/gt/noah/golden]

Floors: where the title block and the manifest disagree (split-level naming, see SHEET_CLASSIFICATION.md
notes) both readings are accepted (``floorsAcceptAny``) until the owner answers. Confidence, title and
text counts are advisory; discipline, floors, scale, page size and path counts are hard checks.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
CLASSIFICATION_MD = REPO / "workers/drawing/spikes/SHEET_CLASSIFICATION.md"
MANIFEST = REPO / "benchmark/manifests/noah.json"
EXTRACT_STATS = REPO / "workers/drawing/spikes/results/extract_stats.json"
DEFAULT_OUT = Path("/home/claude/kamutan-data/gt/noah/golden")

_CODE = re.compile(r"`([a-z_]+)`")


def parse_table(md: str) -> list[dict[str, str]]:
    rows = []
    for line in md.splitlines():
        if not line.startswith("| sheet_"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        keys = ["file_id", "name", "discipline", "floors", "scale", "dim_scale", "date", "conf", "manifest", "agrees"]
        rows.append(dict(zip(keys, cells, strict=True)))
    return rows


def build(row: dict[str, str], manifest_file: dict, stats: dict) -> dict:
    fid = row["file_id"]
    short = fid.removeprefix("sheet_")
    discipline = _CODE.findall(row["discipline"])[0]
    tb_floors = _CODE.findall(row["floors"])
    mf_floors = list(manifest_file.get("floors", []))
    scale = int(row["scale"].split(":")[1])
    conf = float(row["conf"])
    title_head = row["name"].split("/")[0].strip()

    cls: dict = {
        "discipline": discipline,
        "disciplineAliases": sorted({manifest_file.get("discipline", discipline)} - {discipline}),
        "minConfidence": round(max(0.0, conf - 0.15), 2),
        "confidenceAdvisory": True,
        "sheetTitleContains": [title_head],
        "sheetTitleAdvisory": True,
    }
    notes = "Derived from the Sprint-0 classification spike; gtStatus=draft until a human verifies."
    if sorted(tb_floors) == sorted(mf_floors):
        cls["floors"] = tb_floors
    else:
        cls["floorsAcceptAny"] = [tb_floors, mf_floors]
        notes += (
            f" Floors disputed: title block says {tb_floors}, manifest says {mf_floors}"
            " (split-level naming, SHEET_CLASSIFICATION.md notes) — both accepted until the owner answers."
        )

    expect: dict = {
        "status": "ready",
        "classification": cls,
        "scale": {"denominator": scale, "tolerance": 0},
        "page": {"widthMm": round(stats["width_mm"], 2), "heightMm": round(stats["height_mm"], 2), "toleranceMm": 1.0},
        "stats": {
            "paths": {"value": stats["n_paths"], "relTol": 0.02},
            "segments": {"value": stats["n_segments"], "relTol": 0.05},
            "textLines": {"value": stats["n_text_lines"], "relTol": 0.15, "advisory": True},
            "glyphs": {"value": stats["n_glyphs"], "relTol": 0.15, "advisory": True},
        },
        "tiles": {"format": "webp", "tileSize": 256, "dpi": 300, "minLevels": 5},
    }
    return {
        "schemaVersion": 1,
        "sheet": fid,
        "match": short,
        "source": {"file": manifest_file["file_name"], "sha256": manifest_file["sha256"], "pageIndex": 0},
        "derivedFrom": [
            "workers/drawing/spikes/SHEET_CLASSIFICATION.md",
            "benchmark/manifests/noah.json",
            "workers/drawing/spikes/results/extract_stats.json (Sprint-0 pdf_vector counts)",
        ],
        "gtStatus": "draft",
        "notes": notes,
        "expect": expect,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    a = ap.parse_args(argv)
    if REPO in a.out.resolve().parents or a.out.resolve() == REPO:
        print("refusing to write golden expectations inside the git repo", file=sys.stderr)
        return 2
    rows = parse_table(CLASSIFICATION_MD.read_text(encoding="utf-8"))
    files = {f["file_id"]: f for f in json.loads(MANIFEST.read_text(encoding="utf-8"))["files"]}
    stats = json.loads(EXTRACT_STATS.read_text(encoding="utf-8"))
    a.out.mkdir(parents=True, exist_ok=True)
    for row in rows:
        fid = row["file_id"]
        exp = build(row, files[fid], stats[fid.removeprefix("sheet_")])
        (a.out / f"{fid}.json").write_text(json.dumps(exp, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(rows)} expected files to {a.out}")
    return 0 if len(rows) == 15 else 1


if __name__ == "__main__":
    sys.exit(main())
