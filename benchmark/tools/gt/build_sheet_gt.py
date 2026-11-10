"""By-eye annotation tables -> kbench sheet GT (Sprint 11 Data/QA). Code only; tables and GT stay outside git.

Input  `$KAMUTAN_DATA_DIR/gt/<project>/annot/<sha8>.txt` (written by hand while looking at grid tiles from
`render_tiles.py`; NEVER seeded from the detector):

    # project=achituv sheet=d4f897bc discipline=electrical floor=basement scale=50 completeness=complete
    # free comment
    socket_double 141 165.3 ; X2 H=120 ; lifecycle=existing

Output `gt/<project>/sheets/<sha8>.geojson` (+ `sheets/README.md` with the per-sheet completeness table).

Each eye position is refined to the centre of the drawn glyph ("ink snap"): the nearest connected ink component of
the page render within `--snap-mm`, if it is glyph sized. This uses only the drawing, not the detector.

    uv run python -I tools/gt/build_sheet_gt.py [--projects achituv ...] [--no-snap]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pypdfium2 as pdfium
from scipy import ndimage

MM_PER_PT = 25.4 / 72.0
GT_VERSION = "eye-s11-v1"
ANNOTATOR = "agent:data-qa-s11"
SNAP_PPMM = 12.0
HALF_WINDOW_MM = 9.0
LINEAR_CLASSES = {"conduit_cobra", "luminaire_strip"}


@dataclass
class Mark:
    cls: str
    x: float
    y: float
    notes: str = ""
    props: dict[str, str] = field(default_factory=dict)


@dataclass
class SheetAnnot:
    meta: dict[str, str]
    comments: list[str]
    marks: list[Mark]


def data_dir() -> Path:
    return Path(os.environ.get("KAMUTAN_DATA_DIR", "/home/claude/kamutan-data"))


def parse_annot(text: str) -> SheetAnnot:
    meta: dict[str, str] = {}
    comments: list[str] = []
    marks: list[Mark] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            body = line.lstrip("#").strip()
            if not meta and "project=" in body:
                meta = dict(tok.split("=", 1) for tok in body.split() if "=" in tok)
            else:
                comments.append(body)
            continue
        head, *rest = [part.strip() for part in line.split(";")]
        cls, xs, ys = head.split()
        props: dict[str, str] = {}
        notes: list[str] = []
        for part in rest:
            key, sep, value = part.partition("=")
            if sep and key.strip() in {"lifecycle", "uncertain", "supply", "symbol_class"}:
                props[key.strip()] = value.strip()
            elif part:
                notes.append(part)
        marks.append(Mark(cls, float(xs), float(ys), "; ".join(notes), props))
    if not meta:
        raise ValueError("annotation table has no '# project=… sheet=…' header")
    return SheetAnnot(meta, comments, marks)


class Page:
    """Lazy window renderer of the displayed page (rotation applied), paper mm, y down."""

    def __init__(self, pdf: Path) -> None:
        self._doc = pdfium.PdfDocument(str(pdf))
        self._page = self._doc[0]
        w_pt, h_pt = self._page.get_size()
        self.size_mm = (w_pt * MM_PER_PT, h_pt * MM_PER_PT)

    def window(self, x0: float, y0: float, x1: float, y1: float, ppmm: float) -> tuple[np.ndarray, float, float]:
        w_mm, h_mm = self.size_mm
        x0, y0, x1, y1 = max(0.0, x0), max(0.0, y0), min(w_mm, x1), min(h_mm, y1)
        crop = (x0 / MM_PER_PT, (h_mm - y1) / MM_PER_PT, (w_mm - x1) / MM_PER_PT, y0 / MM_PER_PT)
        bitmap = self._page.render(scale=ppmm * MM_PER_PT, crop=crop)
        return np.asarray(bitmap.to_pil().convert("RGB")), x0, y0


def ink_mask(rgb: np.ndarray) -> np.ndarray:
    """Symbol ink: saturated colour (red / purple / orange / green / blue / yellow fills). Grey walls, black
    architecture and white paper are not ink, so a glyph drawn on a wall still separates."""
    arr = rgb.astype(np.int16)
    spread = arr.max(axis=2) - arr.min(axis=2)
    return np.asarray(spread > 70)


def snap_to_ink(page: Page, x: float, y: float, snap_mm: float, max_glyph_mm: float = 9.0) -> tuple[float, float] | None:
    rgb, ox, oy = page.window(x - HALF_WINDOW_MM, y - HALF_WINDOW_MM, x + HALF_WINDOW_MM, y + HALF_WINDOW_MM, SNAP_PPMM)
    mask = ink_mask(rgb)
    if not mask.any():
        return None
    labels, count = ndimage.label(mask, structure=np.ones((3, 3), dtype=bool))
    if count == 0:
        return None
    px, py = (x - ox) * SNAP_PPMM, (y - oy) * SNAP_PPMM
    best: tuple[float, int] | None = None
    slices = ndimage.find_objects(labels)
    for index, sl in enumerate(slices, start=1):
        if sl is None:
            continue
        ys, xs = sl
        h_mm, w_mm = (ys.stop - ys.start) / SNAP_PPMM, (xs.stop - xs.start) / SNAP_PPMM
        if max(h_mm, w_mm) > max_glyph_mm or max(h_mm, w_mm) < 1.2:
            continue
        if ys.start == 0 or xs.start == 0 or ys.stop == mask.shape[0] or xs.stop == mask.shape[1]:
            continue
        cy, cx = (ys.start + ys.stop) / 2.0, (xs.start + xs.stop) / 2.0
        # distance from the eye point to the component (0 when the point is on / inside its bbox)
        dx = max(xs.start - px, 0.0, px - xs.stop)
        dy = max(ys.start - py, 0.0, py - ys.stop)
        gap = float(np.hypot(dx, dy)) / SNAP_PPMM
        centre = float(np.hypot(cx - px, cy - py)) / SNAP_PPMM
        if gap > 1.0 or centre > snap_mm:
            continue
        if best is None or centre < best[0]:
            best = (centre, index)
    if best is None:
        return None
    hit = slices[best[1] - 1]
    assert hit is not None
    ys, xs = hit
    return ox + (xs.start + xs.stop) / 2.0 / SNAP_PPMM, oy + (ys.start + ys.stop) / 2.0 / SNAP_PPMM


def build_sheet(project: str, annot_path: Path, snap: bool, snap_mm: float) -> tuple[dict[str, object], dict[str, object]]:
    annot = parse_annot(annot_path.read_text(encoding="utf-8"))
    sheet = annot.meta["sheet"]
    pdf = data_dir() / f"sample-{project}" / f"sheet_{sheet}.pdf"
    page = Page(pdf)
    floor = annot.meta.get("floor", "unknown")
    counters: Counter[str] = Counter()
    features: list[dict[str, object]] = []
    snapped = 0
    for mark in annot.marks:
        counters[mark.cls] += 1
        fid = f"{sheet}-{mark.cls}-{counters[mark.cls]}"
        x, y, source = mark.x, mark.y, "eye"
        if snap and mark.cls not in LINEAR_CLASSES and mark.cls != "ac_unit":
            hit = snap_to_ink(page, mark.x, mark.y, snap_mm)
            if hit is not None:
                x, y, source = round(hit[0], 2), round(hit[1], 2), "eye+ink-snap"
                snapped += 1
        lifecycle = mark.props.get("lifecycle", "new")
        props: dict[str, object] = {
            "id": fid,
            "class": mark.cls,
            "kind": "linear" if mark.cls in LINEAR_CLASSES else "symbol",
            "symbol_class": mark.props.get("symbol_class", mark.cls),
            "floor": floor,
            "lifecycle": lifecycle,
            "supply": "existing" if lifecycle == "existing" else "contractor",
            "annotator": ANNOTATOR,
            "status": "draft-verified",
            "source": "eye",
            "position_source": source,
            "eye_xy": [mark.x, mark.y],
            "uncertain": mark.props.get("uncertain", "false") == "true",
        }
        if mark.notes:
            props["notes"] = mark.notes
        features.append({"type": "Feature", "id": fid, "geometry": {"type": "Point", "coordinates": [x, y]}, "properties": props})
    completeness = annot.meta.get("completeness", "partial")
    doc: dict[str, object] = {
        "type": "FeatureCollection",
        "kamutan": {
            "schema_version": "1.0",
            "project_id": project,
            "sheet_id": sheet,
            "units": "mm",
            "y_axis": "down",
            "source_sha256": hashlib.sha256(pdf.read_bytes()).hexdigest(),
            "kind": "truth",
            "gt_version": GT_VERSION,
            "input_type": "vector",
            "page_size_mm": [round(page.size_mm[0], 3), round(page.size_mm[1], 3)],
            "scale": float(annot.meta.get("scale", 50)),
            "discipline": annot.meta.get("discipline", ""),
            "floors": [floor],
            "made_by": "independent by-eye annotation on gridded render tiles; legend read first; NOT seeded from the "
            "detector; positions refined to the drawn glyph (ink snap); detector output used only afterwards to "
            "re-look at disagreements",
            "completeness": completeness,
            "notes": " | ".join(annot.comments),
        },
        "features": features,
    }
    summary = {
        "sheet": sheet,
        "discipline": annot.meta.get("discipline", ""),
        "floor": floor,
        "completeness": completeness,
        "features": len(features),
        "snapped": snapped,
        "by_class": dict(sorted(counters.items())),
    }
    return doc, summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--projects", nargs="*", default=["noah", "rubel", "achituv", "yahav"])
    parser.add_argument("--no-snap", action="store_true")
    parser.add_argument("--snap-mm", type=float, default=3.0)
    args = parser.parse_args()
    for project in args.projects:
        root = data_dir() / "gt" / project
        tables = sorted((root / "annot").glob("*.txt"))
        if not tables:
            continue
        out_dir = root / "sheets"
        out_dir.mkdir(parents=True, exist_ok=True)
        rows = []
        for table in tables:
            doc, summary = build_sheet(project, table, not args.no_snap, args.snap_mm)
            (out_dir / f"{summary['sheet']}.geojson").write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
            rows.append(summary)
            print(project, json.dumps(summary, ensure_ascii=False))
        lines = [
            f"# {project} — per-symbol GT `{GT_VERSION}` (Sprint 11 Data/QA)",
            "",
            "Independent by-eye annotation (gridded render tiles, legend first). NOT seeded from the detector. Source tables:",
            "`../annot/<sheet>.txt`; rebuild with `benchmark/tools/gt/build_sheet_gt.py`.",
            "",
            "| sheet | discipline | floor | completeness | features | by class |",
            "| --- | --- | --- | --- | --- | --- |",
        ]
        for row in rows:
            lines.append(
                f"| {row['sheet']} | {row['discipline']} | {row['floor']} | {row['completeness']} | {row['features']} | "
                f"{json.dumps(row['by_class'])} |"
            )
        (out_dir / "README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
