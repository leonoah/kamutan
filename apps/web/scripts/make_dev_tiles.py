"""Render a few sample PDFs into the Sprint 1 artifact layout, for the web app's mock/dev mode.

DEV ONLY. Output goes to /home/claude/kamutan-data/artifacts (never committed, never bundled);
Vite serves it at /dev-artifacts/ through a dev-server-only middleware (vite.config.ts).

Layout (docs/agents/SPRINT1_BRIEF.md):
  orgs/{orgId}/projects/{projectId}/sheets/{sheetId}/versions/{versionId}/
    tiles/{z}/{x}_{y}.webp   z = 0 is the most zoomed-out level that fits in one 256 px tile;
                             the max level renders at `dpi`. Edge tiles are NOT padded (exact pixel grid,
                             same as kamutan_drawing.render.raster.render_tiles).
    thumbnail.webp           max 512 px
    version.json             the `tiles` meta + page size, mirroring the Firestore version doc
plus dev-index.json at the root listing every rendered sheet.

Run:
  uv run --project workers/drawing python apps/web/scripts/make_dev_tiles.py [--dpi 300] [--only c054fd3a,...]

Memory note: this dev script renders each (A3) page once at full dpi and downsamples. The production worker
must render A0 region-wise (brief: "A0 must be tiled, never one full image").
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import pypdfium2 as pdfium
from PIL import Image

SAMPLES = Path("/home/claude/kamutan-data/sample-noah")
OUT = Path("/home/claude/kamutan-data/artifacts")
ORG, PROJECT, VERSION = "org-demo", "p-noah", "v1"
TILE = 256
MM_PER_INCH = 25.4

# file id → seed for the mock (classification as read by spikes/classify_sheets.py, SHEET_CLASSIFICATION.md)
DEFAULT_IDS = ["c054fd3a", "eb8be8a3", "1bbe4113", "b2046277", "24ab0ea0", "70a5c3e0"]


def levels_for(w: int, h: int) -> int:
    """Number of pyramid levels so that level 0 fits in one tile."""
    return max(0, math.ceil(math.log2(max(w, h) / TILE))) + 1


def render_one(file_id: str, dpi: float) -> dict:
    pdf = pdfium.PdfDocument(str(SAMPLES / f"sheet_{file_id}.pdf"))
    page = pdf[0]
    rotation = page.get_rotation()
    img = page.render(scale=dpi / 72.0, fill_color=(255, 255, 255, 255)).to_pil().convert("RGB")
    page.close()
    pdf.close()
    W, H = img.size
    n = levels_for(W, H)
    max_z = n - 1
    sheet_id = f"noah-{file_id}-p0"
    base = OUT / "orgs" / ORG / "projects" / PROJECT / "sheets" / sheet_id / "versions" / VERSION
    tiles_dir = base / "tiles"
    count = 0
    level = img
    for z in range(max_z, -1, -1):
        if z != max_z:
            level = level.reduce(2) if min(level.size) >= 2 else level
        lw, lh = level.size
        zdir = tiles_dir / str(z)
        zdir.mkdir(parents=True, exist_ok=True)
        for y in range(math.ceil(lh / TILE)):
            for x in range(math.ceil(lw / TILE)):
                box = (x * TILE, y * TILE, min(lw, (x + 1) * TILE), min(lh, (y + 1) * TILE))
                level.crop(box).save(zdir / f"{x}_{y}.webp", "WEBP", quality=82, method=4)
                count += 1
    thumb = img.copy()
    thumb.thumbnail((512, 512), Image.Resampling.LANCZOS)
    thumb.save(base / "thumbnail.webp", "WEBP", quality=80)
    meta = {
        "sheetId": sheet_id,
        "versionId": VERSION,
        "fileId": file_id,
        "page": {
            "widthMm": round(W / dpi * MM_PER_INCH, 3),
            "heightMm": round(H / dpi * MM_PER_INCH, 3),
            "rotation": rotation,
        },
        "tiles": {
            "prefix": f"orgs/{ORG}/projects/{PROJECT}/sheets/{sheet_id}/versions/{VERSION}/tiles",
            "format": "webp",
            "tileSize": TILE,
            "dpi": dpi,
            "levels": n,
            "widthPx": W,
            "heightPx": H,
        },
        "thumbnail": f"orgs/{ORG}/projects/{PROJECT}/sheets/{sheet_id}/versions/{VERSION}/thumbnail.webp",
        "tileCount": count,
    }
    (base / "version.json").write_text(json.dumps(meta, indent=2))
    return meta


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dpi", type=float, default=300)
    ap.add_argument("--only", default=",".join(DEFAULT_IDS))
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    index = []
    for fid in [s for s in args.only.split(",") if s]:
        meta = render_one(fid, args.dpi)
        index.append(meta)
        t = meta["tiles"]
        print(f"{fid}: {t['widthPx']}x{t['heightPx']} px, {t['levels']} levels, {meta['tileCount']} tiles")
    (OUT / "dev-index.json").write_text(json.dumps(index, indent=2))


if __name__ == "__main__":
    main()
