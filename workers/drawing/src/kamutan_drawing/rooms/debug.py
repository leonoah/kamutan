"""Debug overlay PNG for room segmentation (dev tool; not used by the pipeline)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pypdfium2 as pdfium
from PIL import Image, ImageDraw, ImageFont
from shapely.geometry import MultiPolygon, Polygon

from ..ingest.pdf_vector import VectorSheet

PALETTE = [(230, 25, 75), (60, 180, 75), (0, 130, 200), (245, 130, 48), (145, 30, 180), (70, 240, 240), (240, 50, 230)]


def render_overlay(vs: VectorSheet, debug: dict[str, Any], out: Path, *, pdf: Path | None = None, px_per_mm: float = 5.0) -> None:
    w, h = int(vs.width_mm * px_per_mm), int(vs.height_mm * px_per_mm)
    if pdf is not None:
        doc = pdfium.PdfDocument(str(pdf))
        page = doc[vs.page_index]
        img = page.render(scale=px_per_mm * 25.4 / 72).to_pil().convert("RGB").resize((w, h))
        img = Image.blend(img, Image.new("RGB", (w, h), "white"), 0.55)
    else:
        img = Image.new("RGB", (w, h), "white")
    ov = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)

    def poly(p: Any, fill: tuple[int, ...], outline: tuple[int, ...] | None = None) -> None:
        geoms = p.geoms if isinstance(p, MultiPolygon) else [p]
        for g in geoms:
            if isinstance(g, Polygon) and not g.is_empty:
                d.polygon([(x * px_per_mm, y * px_per_mm) for x, y in g.exterior.coords], fill=fill, outline=outline)

    try:
        font: Any = ImageFont.truetype("DejaVuSans.ttf", 22)
    except OSError:
        font = ImageFont.load_default()
    for reg in debug.get("regions", []):
        ws = reg["walls"]
        poly(ws.walls, (0, 0, 0, 160))
        for b in ws.bridges:
            poly(b, (255, 0, 0, 200))
        for k, (fp, room) in enumerate(reg["faces"]):
            c = PALETTE[k % len(PALETTE)]
            poly(fp, (*c, 70), (*c, 255))
            cx, cy = fp.representative_point().coords[0]
            label = f"{room.id} {room.area_m2:.1f}m2 {room.level[0]}"
            d.text((cx * px_per_mm - 40, cy * px_per_mm), label, fill=(0, 0, 0, 255), font=font)
            if room.name:
                d.text((cx * px_per_mm - 40, cy * px_per_mm + 24), room.name[::-1], fill=(0, 0, 160, 255), font=font)
    img = Image.alpha_composite(img.convert("RGBA"), ov).convert("RGB")
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)


def main(argv: list[str] | None = None) -> None:
    """``python -m kamutan_drawing.rooms.debug [fileId ...]``: rooms + overlays for locally ingested samples.

    Reads ``$KAMUTAN_ARTIFACTS`` (default /home/claude/kamutan-data/artifacts, written by scripts/ingest_local.py),
    writes ``$KAMUTAN_DEBUG_DIR/rooms_{fileId}.png`` (default /home/claude/kamutan-data/debug) and prints the rooms.
    """
    import json
    import os
    import sys

    from ..pipeline.artifacts import decode_primitives, decode_text
    from ..types_sprint2 import text_items_from_json, vector_sheet_from_primitives
    from .segment import segment

    root = Path(os.environ.get("KAMUTAN_ARTIFACTS", "/home/claude/kamutan-data/artifacts"))
    out_dir = Path(os.environ.get("KAMUTAN_DEBUG_DIR", "/home/claude/kamutan-data/debug"))
    data_dir = Path(os.environ.get("KAMUTAN_DATA_DIR", "/home/claude/kamutan-data/sample-noah"))
    idx = {e["fileId"]: e for e in json.loads((root / "dev-index.json").read_text())}
    for fid in (argv if argv is not None else sys.argv[1:]) or sorted(idx):
        e = idx[fid]
        vs = vector_sheet_from_primitives(decode_primitives((root / e["primitives"]).read_bytes()))
        text = text_items_from_json(decode_text((root / e["text"]).read_bytes())["lines"])
        dbg: dict[str, Any] = {}
        rooms = segment(vs, text, e["regions"], e.get("scaleDenominator"), debug=dbg)
        print(fid, e.get("discipline"), len(rooms))
        for r in rooms:
            print(
                f"  {r.id} {r.floor} {r.name} name={r.name_confidence:.2f} {r.area_m2:.1f}m2 {r.perimeter_m:.1f}m {r.level} {r.reasons}"
            )
        pdf = data_dir / f"sheet_{fid}.pdf"
        render_overlay(vs, dbg, out_dir / f"rooms_{fid}.png", pdf=pdf if pdf.is_file() else None, px_per_mm=4)


if __name__ == "__main__":
    main()
