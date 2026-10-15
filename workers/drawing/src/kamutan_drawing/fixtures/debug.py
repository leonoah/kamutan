"""Debug overlays for fixtures (dev tool; not used by the pipeline).

``uv run python -m kamutan_drawing.fixtures.debug [fileId …]`` reads the locally ingested samples
(``$KAMUTAN_ARTIFACTS``, default /home/claude/kamutan-data/artifacts), runs rooms + fixtures and writes
``$KAMUTAN_DEBUG_DIR/fixtures_{fileId}.png`` (default /home/claude/kamutan-data/debug) + a per-room table.
"""

from __future__ import annotations

import json
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import pypdfium2 as pdfium
from PIL import Image, ImageDraw, ImageFont

from ..ingest.pdf_vector import VectorSheet
from .model import FixtureDetection

COLORS = {
    "fixture_wc_concealed": (220, 20, 60),
    "fixture_wc_monoblock": (255, 120, 0),
    "fixture_basin": (0, 120, 255),
    "fixture_kitchen_sink": (0, 180, 180),
    "fixture_shower": (140, 0, 220),
    "fixture_bath": (100, 60, 200),
    "fixture_washing_machine": (0, 150, 0),
    "faucet_wall": (200, 0, 160),
    "faucet_basin": (60, 60, 220),
    "garden_tap": (40, 160, 40),
    "ac_unit": (230, 180, 0),
}
SHORT = {
    "fixture_wc_concealed": "WC-c",
    "fixture_wc_monoblock": "WC-m",
    "fixture_basin": "basin",
    "fixture_kitchen_sink": "k-sink",
    "fixture_shower": "shower",
    "fixture_bath": "bath",
    "fixture_washing_machine": "washer",
    "faucet_wall": "f-wall",
    "faucet_basin": "f-flower",
    "garden_tap": "g-tap",
    "ac_unit": "AC",
}


def _font(size: int) -> Any:
    try:
        return ImageFont.truetype("DejaVuSans.ttf", size)
    except OSError:
        return ImageFont.load_default()


def render(
    vs: VectorSheet,
    fixtures: list[FixtureDetection],
    out: Path,
    *,
    pdf: Path | None = None,
    rooms: list[Any] | None = None,
    debug: dict[str, Any] | None = None,
    px_per_mm: float = 5.0,
    crop: tuple[float, float, float, float] | None = None,
) -> None:
    w, h = int(vs.width_mm * px_per_mm), int(vs.height_mm * px_per_mm)
    if pdf is not None:
        doc = pdfium.PdfDocument(str(pdf))
        img = doc[vs.page_index].render(scale=px_per_mm * 25.4 / 72).to_pil().convert("RGB").resize((w, h))
        img = Image.blend(img, Image.new("RGB", (w, h), "white"), 0.5)
    else:
        img = Image.new("RGB", (w, h), "white")
    ov = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    f = _font(int(3.2 * px_per_mm))
    small = _font(int(2.4 * px_per_mm))

    def P(x: float, y: float) -> tuple[float, float]:
        return (x * px_per_mm, y * px_per_mm)

    for r in rooms or []:
        pts = r.polygon_mm if hasattr(r, "polygon_mm") else [(p["x"], p["y"]) for p in r["polygonMm"]]
        d.polygon([P(*p) for p in pts], outline=(120, 120, 120, 200), width=2)
    if debug:
        for lb, leads in debug.get("labels", []):
            x0, y0, x1, y1 = lb.bbox
            d.rectangle([P(x0, y0), P(x1, y1)], outline=(255, 0, 255, 160), width=2)
            for ld in leads:
                d.line([P(*p) for p in ld.polyline], fill=(255, 0, 255, 220), width=3)
                tx, ty = ld.terminal
                d.ellipse([P(tx - 0.8, ty - 0.8), P(tx + 0.8, ty + 0.8)], outline=(255, 0, 255, 255), width=3)
    for fx in fixtures:
        c = COLORS.get(fx.cls, (0, 0, 0))
        b = fx.bbox
        lw = 4 if fx.level == "green" else 3
        d.rectangle([P(b.x, b.y), P(b.x1, b.y1)], outline=(*c, 255), width=lw)
        tag = f"{SHORT.get(fx.cls, fx.cls)} {fx.score:.2f}{fx.level[0]}"
        if fx.source != "shape":
            tag += " T" if fx.source == "text" else " S+T"
        dy = -3.6 if fx.cls.startswith("faucet") else 0.3
        d.text(P(b.x, b.y1 + dy), tag, fill=(*c, 255), font=f)
        if fx.attached_to:
            d.text(P(b.x, b.y1 + dy + 3.2), f"→{fx.attached_to}", fill=(*c, 255), font=small)
    img = Image.alpha_composite(img.convert("RGBA"), ov).convert("RGB")
    if crop is not None:
        img = img.crop((crop[0] * px_per_mm, crop[1] * px_per_mm, crop[2] * px_per_mm, crop[3] * px_per_mm))
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)


def load_local(fid: str, root: Path) -> tuple[dict[str, Any], VectorSheet, list[Any]]:
    from ..pipeline.artifacts import decode_primitives, decode_text
    from ..types_sprint2 import text_items_from_json, vector_sheet_from_primitives

    idx = {e["fileId"]: e for e in json.loads((root / "dev-index.json").read_text())}
    e = idx[fid]
    vs = vector_sheet_from_primitives(decode_primitives((root / e["primitives"]).read_bytes()))
    text = text_items_from_json(decode_text((root / e["text"]).read_bytes())["lines"])
    return e, vs, text


def main(argv: list[str] | None = None) -> None:
    from ..rooms import segment
    from .detect import detect

    root = Path(os.environ.get("KAMUTAN_ARTIFACTS", "/home/claude/kamutan-data/artifacts"))
    out_dir = Path(os.environ.get("KAMUTAN_DEBUG_DIR", "/home/claude/kamutan-data/debug"))
    data_dir = Path(os.environ.get("KAMUTAN_DATA_DIR", "/home/claude/kamutan-data/sample-noah"))
    idx = {e["fileId"]: e for e in json.loads((root / "dev-index.json").read_text())}
    for fid in (argv if argv is not None else sys.argv[1:]) or sorted(idx):
        e, vs, text = load_local(fid, root)
        rooms = segment(vs, text, e["regions"], e.get("scaleDenominator"))
        dbg: dict[str, Any] = {}
        fx = detect(
            vs, text, rooms, e.get("discipline"), regions=e["regions"], scale_denominator=e.get("scaleDenominator"), debug=dbg
        )
        print(f"{fid} {e.get('discipline')} fixtures={len(fx)} {dict(Counter(f.cls for f in fx))}")
        by_room: dict[str, list[str]] = defaultdict(list)
        names = {r.id: f"{r.id} {r.name}" for r in rooms}
        for f in fx:
            by_room[names.get(f.room_id or "", "-")].append(
                f"{SHORT.get(f.cls, f.cls)}({f.level[0]}{',T' if f.source == 'text' else ''})"
            )
        for rn, lst in sorted(by_room.items()):
            print(f"   {rn}: {', '.join(lst)}")
        pdf = data_dir / f"sheet_{fid}.pdf"
        render(vs, fx, out_dir / f"fixtures_{fid}.png", pdf=pdf if pdf.is_file() else None, rooms=rooms, debug=dbg, px_per_mm=4)


if __name__ == "__main__":
    main()
