"""DEV: overlay of link groups on a sheet render.

    uv run python -m kamutan_drawing.links.debug [fileId ...]

reads the local artifacts (``$KAMUTAN_DEV_ARTIFACTS``, default /home/claude/kamutan-data/artifacts) and the
sample PDFs, recomputes the links from the stored primitives / text / detections / legend and writes
``/home/claude/kamutan-data/debug/links_{fileId}.png`` (arcs coloured per group, group label at the
first switch: kind + level; red crosses = dangling ends, orange rings = ambiguous ends).
"""

from __future__ import annotations

import gzip
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

ART = Path(os.environ.get("KAMUTAN_DEV_ARTIFACTS", "/home/claude/kamutan-data/artifacts"))
DATA = Path(os.environ.get("KAMUTAN_DATA_DIR", "/home/claude/kamutan-data/sample-noah"))
OUT = Path("/home/claude/kamutan-data/debug")
LEVEL_RGB = {"green": (0, 150, 0), "yellow": (210, 150, 0), "red": (220, 0, 0)}
PALETTE = [
    (31, 119, 180),
    (148, 103, 189),
    (23, 190, 207),
    (227, 119, 194),
    (140, 86, 75),
    (44, 160, 44),
    (255, 127, 14),
    (127, 127, 127),
]
KIND_ABBR = {"single": "S", "shared": "SH", "two_way": "2W", "sensor": "SEN", "add_to_existing": "ADD"}


def version_dir(fid: str) -> Path:
    return ART / "orgs/org-demo/projects/p-noah/sheets" / f"noah-{fid}-p0" / "versions" / "v1"


def compute(fid: str) -> tuple[dict[str, Any], dict[str, Any], float]:
    from . import link_from_artifacts

    vd = version_dir(fid)
    dets = json.loads(gzip.decompress((vd / "detections.json.gz").read_bytes()))
    leg = json.loads(gzip.decompress((vd / "legend.json.gz").read_bytes()))
    t = time.monotonic()
    doc, stats = link_from_artifacts(
        (vd / "primitives.msgpack.gz").read_bytes(), (vd / "text.json.gz").read_bytes(), dets, leg, scale_den=50
    )
    return doc, stats, time.monotonic() - t


def render(fid: str, doc: dict[str, Any], dets: list[dict[str, Any]], out: Path, ppm: float = 6.0) -> None:
    import pypdfium2 as pdfium
    from PIL import Image, ImageDraw

    pdf = pdfium.PdfDocument(str(DATA / f"sheet_{fid}.pdf"))
    img = pdf[0].render(scale=ppm * 25.4 / 72).to_pil().convert("RGB")
    img = Image.blend(img, Image.new("RGB", img.size, (255, 255, 255)), 0.55)
    dr = ImageDraw.Draw(img)
    by_id = {d["id"]: d for d in dets}
    arc_by = {a["id"]: a for a in doc["arcs"]}
    for gi, g in enumerate(doc["groups"]):
        col = PALETTE[gi % len(PALETTE)]
        for aid in g["arcIds"]:
            a = arc_by[aid]
            pts = [(p["x"] * ppm, p["y"] * ppm) for p in a["polylineMm"]]
            dr.line(pts, fill=col, width=3)
            for k, end in enumerate(a["ends"]):
                x, y = pts[0] if k == 0 else pts[-1]
                if end is None:
                    dr.line([(x - 6, y - 6), (x + 6, y + 6)], fill=(255, 0, 0), width=3)
                    dr.line([(x - 6, y + 6), (x + 6, y - 6)], fill=(255, 0, 0), width=3)
                elif a["ambiguous"][k]:
                    dr.ellipse([x - 8, y - 8, x + 8, y + 8], outline=(255, 140, 0), width=3)
        lv = LEVEL_RGB[g["level"]]
        for did in g["switchIds"]:
            b = by_id[did]["bboxMm"]
            dr.rectangle([b["x"] * ppm, b["y"] * ppm, (b["x"] + b["w"]) * ppm, (b["y"] + b["h"]) * ppm], outline=col, width=3)
        for did in g["luminaireIds"]:
            c = by_id[did]["centerMm"]
            dr.ellipse([c["x"] * ppm - 14, c["y"] * ppm - 14, c["x"] * ppm + 14, c["y"] * ppm + 14], outline=col, width=3)
        anchor = by_id[(g["switchIds"] or g["luminaireIds"])[0]]["centerMm"]
        label = f"{g['id'][3:]}:{KIND_ABBR.get(g['kind'], g['kind'])}{'F' if g.get('fan') else ''} {len(g['pointIds'])}p"
        x, y = anchor["x"] * ppm + 10, anchor["y"] * ppm - 22
        dr.rectangle([x - 2, y - 1, x + 7 * len(label), y + 13], fill=(255, 255, 255), outline=lv, width=2)
        dr.text((x, y), label, fill=lv)
    # unlinked switches / luminaires in grey
    used = {i for g in doc["groups"] for i in g["switchIds"] + g["luminaireIds"]}
    for d in dets:
        if d["id"] in used or not (d["class"].startswith(("switch", "luminaire")) or d["class"] == "ceiling_fan"):
            continue
        b = d["bboxMm"]
        dr.rectangle(
            [b["x"] * ppm, b["y"] * ppm, (b["x"] + b["w"]) * ppm, (b["y"] + b["h"]) * ppm], outline=(120, 120, 120), width=2
        )
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)


def main(argv: list[str]) -> int:
    ids = argv or ["b2046277", "1bbe4113"]
    for fid in ids:
        doc, stats, secs = compute(fid)
        dets = json.loads(gzip.decompress((version_dir(fid) / "detections.json.gz").read_bytes()))["detections"]
        out = OUT / f"links_{fid}.png"
        render(fid, doc, dets, out)
        print(fid, f"{secs:.1f}s", json.dumps(stats, ensure_ascii=False), out)
        for g in doc["groups"]:
            print(
                "  ",
                g["id"],
                g["kind"],
                g["level"],
                g["floor"],
                "fan" if g["fan"] else "",
                "sw",
                g["switchIds"],
                "pts",
                len(g["pointIds"]),
                g["luminaireIds"],
                g["reasons"],
            )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
