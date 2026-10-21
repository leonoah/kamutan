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


# ------------------------------------------------------------------------------------------- Sprint 4 (v4)

TYPE_COLORS = {
    "bathroom": (0, 150, 255),
    "wc": (0, 200, 220),
    "kitchen": (255, 160, 0),
    "bedroom": (120, 200, 120),
    "living": (240, 220, 120),
    "corridor": (200, 200, 200),
    "stairs": (170, 170, 170),
    "storage": (190, 150, 110),
    "balcony": (150, 220, 200),
    "courtyard": (120, 220, 120),
    "other": (220, 180, 220),
    "niche": (0, 90, 200),
}


def render_v4(
    vs: VectorSheet,
    rooms: list[Any],
    out: Path,
    *,
    pdf: Path | None = None,
    fixtures: list[Any] | None = None,
    borrowed: list[Any] | None = None,
    px_per_mm: float = 4.0,
) -> None:
    """Rooms coloured by type (wet rooms hatched darker), walls (exterior thick), openings with widths,
    external corners (red dots), borrowed walls (magenta), fixtures (small boxes)."""
    w, h = int(vs.width_mm * px_per_mm), int(vs.height_mm * px_per_mm)
    if pdf is not None:
        doc = pdfium.PdfDocument(str(pdf))
        img = doc[vs.page_index].render(scale=px_per_mm * 25.4 / 72).to_pil().convert("RGB").resize((w, h))
        img = Image.blend(img, Image.new("RGB", (w, h), "white"), 0.6)
    else:
        img = Image.new("RGB", (w, h), "white")
    ov = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    try:
        font: Any = ImageFont.truetype("DejaVuSans.ttf", int(2.6 * px_per_mm))
        small: Any = ImageFont.truetype("DejaVuSans.ttf", int(2.0 * px_per_mm))
    except OSError:
        font = small = ImageFont.load_default()

    def P(x: float, y: float) -> tuple[float, float]:
        return (x * px_per_mm, y * px_per_mm)

    for g in borrowed or []:
        geoms = g.geoms if hasattr(g, "geoms") else [g]
        for p in geoms:
            if isinstance(p, Polygon):
                d.polygon([P(x, y) for x, y in p.exterior.coords], fill=(255, 0, 255, 150))
    for r in rooms:
        c = TYPE_COLORS.get(r.type, (200, 200, 200))
        d.polygon([P(x, y) for x, y in r.polygon_mm], fill=(*c, 110 if r.wet else 55), outline=(*c, 255))
        for wl in r.walls:
            a, b = wl["aMm"], wl["bMm"]
            if wl.get("open"):  # Sprint 5: a niche mouth (open side, not clad)
                d.line([P(a["x"], a["y"]), P(b["x"], b["y"])], fill=(230, 0, 0, 255), width=3)
                continue
            d.line(
                [P(a["x"], a["y"]), P(b["x"], b["y"])],
                fill=(0, 0, 0, 255) if wl["exterior"] else (90, 90, 90, 255),
                width=4 if wl["exterior"] else 2,
            )
        for op in r.openings:
            cx, cy = op["centerMm"]["x"], op["centerMm"]["y"]
            col = (255, 110, 0, 255) if op["kind"] == "door" else (0, 170, 255, 255)
            d.ellipse([P(cx - 1.0, cy - 1.0), P(cx + 1.0, cy + 1.0)], fill=col)
            d.text(P(cx + 1.2, cy - 1.0), f"{op['kind'][0]}{op['widthM']:.2f}", fill=col, font=small)
        for x, y in r.external_corners_mm:
            d.ellipse([P(x - 0.8, y - 0.8), P(x + 0.8, y + 0.8)], fill=(230, 0, 0, 255))
        pt = Polygon(r.polygon_mm).representative_point()
        tx, ty = pt.x, pt.y
        lines = [f"{r.id} {r.type}{' WET' if r.wet else ''}", f"{r.area_m2:.1f}m2 P{r.perimeter_m:.1f} c{r.external_corners}"]
        for k, s in enumerate(lines):
            d.text(P(tx - 8, ty - 3 + 3.2 * k), s, fill=(0, 0, 0, 255), font=font)
    for f in fixtures or []:
        b = f.bbox
        d.rectangle([P(b.x, b.y), P(b.x1, b.y1)], outline=(200, 0, 0, 255), width=2)
    img = Image.alpha_composite(img.convert("RGBA"), ov).convert("RGB")
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)


def main_v4(argv: list[str] | None = None) -> None:
    """``python -m kamutan_drawing.rooms.debug --v4 [fileId ...]``: rooms with tiling geometry (+ fixtures, and
    walls borrowed from the construction / master sheet of the same floor on MEP sheets) →
    ``rooms_v4_{fileId}.png`` and a table of wet rooms."""
    import json
    import os
    import sys

    from ..fixtures.debug import load_local
    from ..fixtures.detect import detect
    from .reference import reference_walls
    from .segment import apply_fixtures, segment

    root = Path(os.environ.get("KAMUTAN_ARTIFACTS", "/home/claude/kamutan-data/artifacts"))
    out_dir = Path(os.environ.get("KAMUTAN_DEBUG_DIR", "/home/claude/kamutan-data/debug"))
    data_dir = Path(os.environ.get("KAMUTAN_DATA_DIR", "/home/claude/kamutan-data/sample-noah"))
    idx = {e["fileId"]: e for e in json.loads((root / "dev-index.json").read_text())}
    refs_all: list[tuple[int, Any]] = []
    for fid, e in sorted(idx.items()):
        if e.get("discipline") in ("construction", "architecture_master"):
            _, vs_r, _ = load_local(fid, root)
            refs_all.extend(
                (0 if e["discipline"] == "construction" else 1, r)
                for r in reference_walls(vs_r, e["regions"], e.get("scaleDenominator"), sheet_id=fid)
            )
    refs_all.sort(key=lambda q: q[0])
    args = argv if argv is not None else sys.argv[1:]
    for fid in [a for a in args if not a.startswith("--")] or sorted(idx):
        e, vs, text = load_local(fid, root)
        mep = e.get("discipline") not in ("construction", "architecture_master", "demolition")
        refs = [r for _, r in refs_all if r.sheet_id != fid] if mep else None
        dbg: dict[str, Any] = {}
        rooms = segment(vs, text, e["regions"], e.get("scaleDenominator"), reference_walls=refs, debug=dbg)
        fx = detect(vs, text, rooms, e.get("discipline"), regions=e["regions"], scale_denominator=e.get("scaleDenominator"))
        apply_fixtures(rooms, fx)
        borrowed = [rg["walls"].borrowed for rg in dbg.get("regions", []) if rg["walls"].borrowed is not None]
        print(f"{fid} {e.get('discipline')} rooms={len(rooms)} borrowed={len(borrowed)}")
        for r in rooms:
            ops = ", ".join(f"{o['kind']} {o['widthM']:.2f}" for o in r.openings)
            print(
                f"  {r.id} {r.floor} {r.name} [{r.type}{' wet' if r.wet else ''}] {r.area_m2:.1f}m2 P={r.perimeter_m:.1f}m "
                f"walls={len(r.walls)} corners={r.external_corners} openings=[{ops}] {r.level} {r.reasons}"
            )
        pdf = data_dir / f"sheet_{fid}.pdf"
        render_v4(vs, rooms, out_dir / f"rooms_v4_{fid}.png", pdf=pdf if pdf.is_file() else None, fixtures=fx, borrowed=borrowed)


if __name__ == "__main__":
    import sys as _sys

    if "--v4" in _sys.argv:
        main_v4()
    else:
        main()
