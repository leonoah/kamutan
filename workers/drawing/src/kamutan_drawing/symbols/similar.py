"""Learn from correction: find drawings similar to one exemplar (job ``symbols.find_similar``).

The reviewer marks one symbol on a sheet (``bboxMm`` on a sheet version). Its strokes become a
template exactly like a legend symbol (:func:`kamutan_drawing.symbols.template.build_template`:
strokes centred on their bbox, resampled every 0.1 mm, an arc or long-stroke anchor, the 16
rotations / mirror poses, mirror skipped when the drawing is symmetric) and the same vector
spotter as the legend-conditioned detector searches one sheet or every current version of the
project (:mod:`kamutan_drawing.symbols.match`: poses from anchors, forward + reverse chamfer,
solid-fill difference, stroke-sharing NMS).

* **Exemplar strokes**: segments with both ends inside the box (+0.25 mm) whose path is
  symbol-sized (a wall polyline passing through the box is not part of the symbol).
* **Scale**: the template is searched at the legend → plan ratio 1 and, when both sheets have a
  scale and they differ, also at ``exemplar scale / target scale`` (a 1:50 symbol on a 1:100
  plan is drawn at half size when blocks are inserted in model units). Arc anchors tolerate ±20 %.
* **Scene** per target sheet: strokes in a colour of the exemplar (±90 RGB sum), minus the legend
  tables (from ``legend.json.gz``) and the title block.
* **Candidates**: quality ≥ ``min_score`` (geometric agreement 0..1, :func:`match.quality`); the
  exemplar instance itself is dropped; ``alreadyDetected`` = id of the nearest existing detection
  within :data:`DETECTED_RADIUS_MM` of the candidate centre (``currentClass`` = its class).
  Sorted by score (desc), then sheet / position — deterministic.

Pure: no I/O except :func:`render_thumb` (in-memory WebP). Runs inside the parser sandbox
(task ``find_similar``, :func:`run`), the orchestrator is :mod:`kamutan_drawing.service.similar`.
"""

from __future__ import annotations

import io
import math
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from ..ingest.pdf_vector import VectorSheet
from ..legend.parse import LegendEntry
from .geometry import BBox, bbox_of, seg_lengths, segment_components
from .match import Candidate, Scene, _nms, build_scene, spot_template
from .template import Template, build_template

DETECTED_RADIUS_MM = 3.0
EXEMPLAR_PAD_MM = 0.25
COLOUR_TOL = 90
COMPONENT_INSIDE = 0.6  # share of a stroke group's length inside the box for it to belong to the exemplar
MIN_SCORE = 0.5
MAX_CANDIDATES = 500
THUMB_PX = 96
THUMB_MARGIN_MM = 1.5
MAX_THUMBS = 300

Progress = Callable[[str, int], None]


@dataclass
class SheetData:
    """One sheet version as the search sees it (decoded stored artifacts)."""

    sheet_id: str
    version_id: str
    vs: VectorSheet
    scale_den: int | None = None
    detections: list[dict[str, Any]] = field(default_factory=list)
    exclude: list[BBox] = field(default_factory=list)  # legend tables, title block


@dataclass
class SimilarCandidate:
    sheet_id: str
    version_id: str
    center: tuple[float, float]
    bbox: BBox
    score: float
    angle_deg: int
    mirrored: bool
    already_detected: str | None
    current_class: str | None

    def to_json(self) -> dict[str, Any]:
        x0, y0, x1, y1 = self.bbox
        return {
            "sheetId": self.sheet_id,
            "versionId": self.version_id,
            "centerMm": {"x": round(self.center[0], 2), "y": round(self.center[1], 2)},
            "bboxMm": {"x": round(x0, 2), "y": round(y0, 2), "w": round(x1 - x0, 2), "h": round(y1 - y0, 2)},
            "score": round(self.score, 3),
            "alreadyDetected": self.already_detected,
            "currentClass": self.current_class,
        }


class ExemplarError(ValueError):
    """The exemplar box holds no usable drawing (empty, too small, only long lines)."""


# ------------------------------------------------------------------------------- exemplar
def exemplar_segments(vs: VectorSheet, box: BBox, pad: float = EXEMPLAR_PAD_MM) -> np.ndarray:
    """Indices of the segments drawn inside ``box`` that belong to symbol-sized paths."""
    if vs.n_segs == 0:
        return np.zeros(0, dtype=np.int64)
    s = vs.segs.astype(np.float64)
    x0, y0, x1, y1 = box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad
    inside = (
        (s[:, 0] >= x0) & (s[:, 0] <= x1) & (s[:, 2] >= x0) & (s[:, 2] <= x1)
        & (s[:, 1] >= y0) & (s[:, 1] <= y1) & (s[:, 3] >= y0) & (s[:, 3] <= y1)
    )  # fmt: skip
    if not inside.any():
        return np.zeros(0, dtype=np.int64)
    size = max(box[2] - box[0], box[3] - box[1])
    grow = max(1.0, 0.5 * size)
    pb = vs.path_bbox.astype(np.float64)
    fits = (pb[:, 0] >= x0 - grow) & (pb[:, 1] >= y0 - grow) & (pb[:, 2] <= x1 + grow) & (pb[:, 3] <= y1 + grow)
    fits_seg = fits[vs.seg_path]
    keep = inside & fits_seg
    # a neighbour (switch bank at 2 mm pitch) only partly inside a loose box is not the exemplar:
    # connected stroke groups around the box count when most of their length is inside
    near = np.where(
        fits_seg
        & (np.maximum(s[:, 0], s[:, 2]) >= x0 - grow) & (np.minimum(s[:, 0], s[:, 2]) <= x1 + grow)
        & (np.maximum(s[:, 1], s[:, 3]) >= y0 - grow) & (np.minimum(s[:, 1], s[:, 3]) <= y1 + grow)
    )[0]  # fmt: skip
    if len(near) and len(near) <= 20_000:
        lab = segment_components(s[near])
        ln = seg_lengths(s[near])
        ins = keep[near]
        tot = np.bincount(lab, weights=ln)
        got = np.bincount(lab, weights=ln * ins)
        good = got >= COMPONENT_INSIDE * np.maximum(tot, 1e-9)
        sel = near[ins & good[lab]]
        if len(sel) >= 2:
            return np.sort(sel).astype(np.int64)
    return np.where(keep)[0].astype(np.int64)


def exemplar_template(vs: VectorSheet, box: BBox) -> Template:
    """Template of the strokes inside ``box`` (built exactly like a legend symbol's)."""
    idx = exemplar_segments(vs, box)
    if len(idx) < 2:
        raise ExemplarError("no strokes inside the exemplar box")
    entry = LegendEntry(
        n=0,
        legend_id="exemplar",
        kind="symbol",
        symbol_bbox=bbox_of(vs.segs[idx].astype(np.float64)),
        label_bbox=None,
        label="",
        label_conf=0.0,
        seg_idx=idx,
    )
    tpl = build_template("exemplar", entry, vs)
    if tpl is None:
        raise ExemplarError("exemplar drawing smaller than 1 mm")
    return tpl


def _template_colours(vs: VectorSheet, tpl: Template) -> set[tuple[int, int, int]]:
    paths = np.unique(vs.seg_path[tpl.entries[0].seg_idx])
    cols = {tuple(int(v) for v in vs.path_stroke_rgba[p, :3]) for p in paths if vs.path_stroked[p]}
    cols |= {tuple(int(v) for v in vs.path_fill_rgba[p, :3]) for p in paths if vs.path_fill_mode[p] > 0}
    return cols  # type: ignore[return-value]


def colour_mask(vs: VectorSheet, cols: set[tuple[int, int, int]]) -> np.ndarray | None:
    if not cols or vs.n_segs == 0:
        return None
    rgb = vs.path_stroke_rgba[vs.seg_path, :3].astype(np.int32)
    keep = np.zeros(vs.n_segs, bool)
    for c in cols:
        keep |= np.abs(rgb - np.array(c)).sum(axis=1) <= COLOUR_TOL
    return keep


def search_scales(exemplar_den: int | None, target_den: int | None) -> list[float]:
    """Template scales to try on a target sheet: 1 and, if the sheets' scales differ, their ratio."""
    out = [1.0]
    if exemplar_den and target_den and exemplar_den != target_den:
        k = exemplar_den / target_den
        if 0.2 <= k <= 5.0:
            out.append(k)
    return out


def _nearest_detection(dets: list[dict[str, Any]], c: tuple[float, float], family: str | None = None) -> dict[str, Any] | None:
    """The detection at the candidate: within :data:`DETECTED_RADIUS_MM`; among those, one of the exemplar's
    class family first, then a symbol before a derived fixture record (an AC position snapped onto its
    socket, ``d_fx_…``), then the nearest."""
    from .rematch import class_family

    best: dict[str, Any] | None = None
    best_key: tuple[int, int, float] | None = None
    for d in dets:
        cm = d.get("centerMm")
        if not isinstance(cm, dict):
            bb = d.get("bboxMm") or {}
            try:
                cm = {"x": float(bb["x"]) + float(bb["w"]) / 2, "y": float(bb["y"]) + float(bb["h"]) / 2}
            except (KeyError, TypeError, ValueError):
                continue
        try:
            dist = math.hypot(float(cm["x"]) - c[0], float(cm["y"]) - c[1])
        except (KeyError, TypeError, ValueError):
            continue
        if dist > DETECTED_RADIUS_MM:
            continue
        key = (
            0 if family is None or class_family(str(d.get("class") or "")) == family else 1,
            1 if str(d.get("id", "")).startswith("d_fx_") else 0,
            dist,
        )
        if best_key is None or key < best_key:
            best, best_key = d, key
    return best


# ------------------------------------------------------------------------------- search
def search_sheet(
    tpl: Template,
    target: SheetData,
    *,
    exemplar_den: int | None,
    colours: set[tuple[int, int, int]],
    min_score: float = MIN_SCORE,
    scene: Scene | None = None,
) -> list[Candidate]:
    sc = scene if scene is not None else build_scene(target.vs, target.exclude, keep_mask=colour_mask(target.vs, colours))
    cands: list[Candidate] = []
    for k in search_scales(exemplar_den, target.scale_den):
        cands.extend(spot_template(tpl, sc, k))
    return _nms(cands, min_score)


def find_similar(
    exemplar: SheetData,
    box: BBox,
    targets: list[SheetData],
    *,
    min_score: float = MIN_SCORE,
    max_candidates: int = MAX_CANDIDATES,
    progress: Progress | None = None,
    exemplar_class: str | None = None,
) -> tuple[list[SimilarCandidate], dict[str, Any]]:
    """Candidates similar to the drawing in ``box`` on ``exemplar`` over ``targets`` (may include the
    exemplar's own sheet). Returns (candidates sorted by score desc, stats)."""
    from .rematch import class_family

    t0 = time.monotonic()
    family = class_family(exemplar_class)
    tpl = exemplar_template(exemplar.vs, box)
    colours = _template_colours(exemplar.vs, tpl)
    ex_center = (float(box[0] + box[2]) / 2, float(box[1] + box[3]) / 2)
    seg = exemplar.vs.segs[tpl.entries[0].seg_idx].astype(np.float64)
    sb = bbox_of(seg)
    tpl_center = ((sb[0] + sb[2]) / 2, (sb[1] + sb[3]) / 2)
    out: list[SimilarCandidate] = []
    per_sheet: dict[str, int] = {}
    for i, tg in enumerate(targets):
        if progress:
            progress("similar", 5 + int(85 * i / max(1, len(targets))))
        found = search_sheet(tpl, tg, exemplar_den=exemplar.scale_den, colours=colours, min_score=min_score)
        same = tg.sheet_id == exemplar.sheet_id and tg.version_id == exemplar.version_id
        n = 0
        for c in found:
            if same and (math.dist(c.center, tpl_center) <= 1.0 or math.dist(c.center, ex_center) <= 0.5):
                continue  # the exemplar itself
            hit = _nearest_detection(tg.detections, c.center, family)
            out.append(
                SimilarCandidate(
                    sheet_id=tg.sheet_id,
                    version_id=tg.version_id,
                    center=c.center,
                    bbox=c.bbox(),
                    score=float(c.quality),
                    angle_deg=c.angle_deg,
                    mirrored=c.mirrored,
                    already_detected=str(hit["id"]) if hit is not None and hit.get("id") is not None else None,
                    current_class=str(hit["class"]) if hit is not None and hit.get("class") else None,
                )
            )
            n += 1
        per_sheet[tg.sheet_id] = n
    out.sort(key=lambda c: (-round(c.score, 3), c.sheet_id, round(c.center[1], 1), round(c.center[0], 1)))
    truncated = len(out) > max_candidates
    out = out[:max_candidates]
    stats = {
        "sheets": len(targets),
        "candidates": len(out),
        "truncated": truncated,
        "perSheet": per_sheet,
        "template": {
            "wMm": round(tpl.w, 2),
            "hMm": round(tpl.h, 2),
            "anchor": tpl.anchor.kind,
            "symmetric": bool(tpl.symmetric),
            "complexity": tpl.complexity,
        },
        "seconds": round(time.monotonic() - t0, 3),
    }
    return out, stats


# ------------------------------------------------------------------------------- thumbs
def render_thumb(vs: VectorSheet, box: BBox, px: int = THUMB_PX, margin: float = THUMB_MARGIN_MM) -> bytes:
    """Small WebP of the strokes around ``box`` (segments painted one by one: no subpath joins)."""
    from PIL import Image, ImageDraw

    x0, y0, x1, y1 = box[0] - margin, box[1] - margin, box[2] + margin, box[3] + margin
    side = max(x1 - x0, y1 - y0, 1.0)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    x0, y0 = cx - side / 2, cy - side / 2
    ppm = px / side
    img = Image.new("RGB", (px, px), (255, 255, 255))
    if vs.n_segs:
        s = vs.segs
        vis = np.where(
            (np.maximum(s[:, 0], s[:, 2]) >= x0) & (np.minimum(s[:, 0], s[:, 2]) <= x0 + side)
            & (np.maximum(s[:, 1], s[:, 3]) >= y0) & (np.minimum(s[:, 1], s[:, 3]) <= y0 + side)
        )[0]  # fmt: skip
        dr = ImageDraw.Draw(img)
        rgb = vs.path_stroke_rgba[:, :3]
        for i in vis:
            p = int(vs.seg_path[i])
            col = tuple(int(v) for v in (rgb[p] if vs.path_stroked[p] else vs.path_fill_rgba[p, :3]))
            a = s[i]
            dr.line(
                [((a[0] - x0) * ppm, (a[1] - y0) * ppm), ((a[2] - x0) * ppm, (a[3] - y0) * ppm)],
                fill=col,  # type: ignore[arg-type]
                width=max(1, round(float(vs.path_width_mm[p]) * ppm)),
            )
    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=75)
    return buf.getvalue()


# ------------------------------------------------------------------------------- sandbox entry
def _load_sheet(d: Path, sheet_id: str, version_id: str, scale_den: int | None) -> SheetData:
    import gzip
    import json

    from ..classify.sheet import span_from_line
    from ..pipeline.artifacts import decode_primitives, decode_text
    from ..titleblock.classify import read_title_block
    from ..types_sprint2 import vector_sheet_from_primitives

    vs = vector_sheet_from_primitives(decode_primitives((d / "primitives.msgpack.gz").read_bytes()))
    exclude: list[BBox] = []
    if (d / "legend.json.gz").exists():
        leg = json.loads(gzip.decompress((d / "legend.json.gz").read_bytes()))
        for lg in leg.get("legends") or []:
            b = lg.get("bboxMm") or {}
            try:
                x, y, w, h = float(b["x"]), float(b["y"]), float(b["w"]), float(b["h"])
            except (KeyError, TypeError, ValueError):
                continue
            exclude.append((x - 1.0, y - 1.0, x + w + 1.0, y + h + 1.0))
    if (d / "text.json.gz").exists():
        text = decode_text((d / "text.json.gz").read_bytes())
        spans = [span_from_line(ln) for ln in text.get("lines", [])]
        try:
            tb = read_title_block(spans, vs).bbox
        except Exception:  # noqa: BLE001 - a missing title block only widens the search
            tb = None
        if tb is not None:
            exclude.append(tuple(float(v) for v in tb))  # type: ignore[arg-type]
    dets: list[dict[str, Any]] = []
    if (d / "detections.json.gz").exists():
        doc = json.loads(gzip.decompress((d / "detections.json.gz").read_bytes()))
        dets = [x for x in doc.get("detections") or [] if isinstance(x, dict)]
    return SheetData(sheet_id, version_id, vs, scale_den, dets, exclude)


def run(args: dict[str, Any], progress: Progress) -> dict[str, Any]:
    """Sandbox task ``find_similar``. ``args``: exemplar {dir, sheetId, versionId, scaleDenominator,
    bboxMm {x,y,w,h}}, targets [{dir, sheetId, versionId, scaleDenominator}] (dirs relative, holding
    ``primitives.msgpack.gz`` + optional ``text.json.gz`` / ``legend.json.gz`` / ``detections.json.gz``),
    outDir, minScore, maxCandidates, thumbs (bool). Writes ``{outDir}/c_{n}.webp`` per candidate (first
    :data:`MAX_THUMBS`) and returns ``{candidates, thumbs: {n: file}, stats}``."""
    wd = Path.cwd().resolve()

    def inside(rel: str) -> Path:
        p = (wd / rel).resolve()
        if wd not in p.parents:
            raise ValueError("path escapes the sandbox directory")
        return p

    def den(v: Any) -> int | None:
        try:
            k = int(v)
        except (TypeError, ValueError):
            return None
        return k if k > 0 else None

    ex = args["exemplar"]  # {dir, sheetId, versionId, scaleDenominator, bboxMm, class}
    b = ex["bboxMm"]
    box: BBox = (float(b["x"]), float(b["y"]), float(b["x"]) + float(b["w"]), float(b["y"]) + float(b["h"]))
    progress("similar", 1)
    sheets: dict[tuple[str, str], SheetData] = {}
    exemplar = _load_sheet(inside(str(ex["dir"])), str(ex["sheetId"]), str(ex["versionId"]), den(ex.get("scaleDenominator")))
    sheets[(exemplar.sheet_id, exemplar.version_id)] = exemplar
    targets: list[SheetData] = []
    for t in args.get("targets") or []:
        key = (str(t["sheetId"]), str(t["versionId"]))
        if key not in sheets:
            sheets[key] = _load_sheet(inside(str(t["dir"])), key[0], key[1], den(t.get("scaleDenominator")))
        targets.append(sheets[key])
    try:
        cands, stats = find_similar(
            exemplar,
            box,
            targets,
            min_score=float(args.get("minScore", MIN_SCORE)),
            max_candidates=int(args.get("maxCandidates", MAX_CANDIDATES)),
            progress=progress,
            exemplar_class=str(ex["class"]) if ex.get("class") else None,
        )
    except ExemplarError:  # nothing to learn from: an empty result, not a failure
        cands, stats = [], {"sheets": len(targets), "candidates": 0, "truncated": False, "reason": "empty_exemplar"}
    progress("similar", 92)
    out = inside(str(args.get("outDir", "similar-out")))
    out.mkdir(parents=True, exist_ok=True)
    thumbs: dict[str, str] = {}
    if args.get("thumbs", True):
        for n, c in enumerate(cands[:MAX_THUMBS]):
            name = f"c_{n}.webp"
            (out / name).write_bytes(render_thumb(sheets[(c.sheet_id, c.version_id)].vs, c.bbox))
            thumbs[str(n)] = name
    progress("similar", 98)
    return {
        "candidates": [c.to_json() for c in cands],
        "thumbs": thumbs,
        "stats": stats,
        "outDir": out.relative_to(wd).as_posix(),
    }


__all__ = [
    "DETECTED_RADIUS_MM",
    "ExemplarError",
    "SheetData",
    "SimilarCandidate",
    "exemplar_template",
    "find_similar",
    "render_thumb",
    "run",
    "search_scales",
]
