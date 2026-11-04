"""Raster (PNG / JPEG) symbol detection — Sprint 7 spike, behind ``KAMUTAN_RASTER_SYMBOLS=1`` (default off).

Pipeline: legend rows from pixels + Tesseract (:mod:`.legend`) → legend-to-plan scale estimate → candidates by
approach A (:mod:`.template`, whole-sheet NCC with a 15° rotation search) or B (:mod:`.blobs`, symbol-sized blobs
matched in a window) → NMS across glyphs (unclassified legend glyphs act as negatives) → 2X / 3X read by Tesseract
next to sockets → :class:`~kamutan_drawing.symbols.detect.Detection` scored with ``raster=True`` (reason
"גיליון רסטר", never green through the calibration ceiling). ``KAMUTAN_RASTER_SYMBOLS_METHOD`` = ``blobs``
(default) | ``template``; both read the same per-glyph response maps (full-sheet NCC, 45° poses). OpenCV is used when importable (not a dependency), else a scipy FFT fallback.

Go / No-go numbers: workers/drawing/NOTES.md "Sprint 7 — raster symbol spike".
"""

from __future__ import annotations

import os
import time
from typing import Any

from PIL import Image

from ..legend.classes import apply_multiplicity
from ..symbols.detect import R_RASTER, Detection, DetectResult, score_detection
from ..symbols.geometry import BBox
from . import blobs, template
from .image import load_page, strip_structure, text_mask
from .legend import Exemplar, find_exemplars
from .match import Candidate, blur, build_bank, estimate_scale, ink_ok, nms, read_multiplicity, response_maps

ENV_FLAG = "KAMUTAN_RASTER_SYMBOLS"
ENV_METHOD = "KAMUTAN_RASTER_SYMBOLS_METHOD"
MIN_MARGIN = 0.04  # best glyph must beat a different-class glyph at the same place by this much
MAX_PER_CLASS = 80  # more hits than this for one glyph: the glyph is too plain (a bare circle / line) to count
MULT_CLASSES = ("socket_single", "socket_power")


TEXT_SHARE_MAX = 0.1  # share of the candidate's central box covered by text-line ink (ink fills ≈ 25 % of a box)


def drop_text(cands: list[Candidate], tmask: Any, ppm: float) -> list[Candidate]:
    """Candidates sitting mostly on text-line ink are letters / digits, not symbols."""
    out = []
    for c in cands:
        w, h = c.size
        x0, x1 = int((c.center[0] - 0.35 * w) * ppm), int((c.center[0] + 0.35 * w) * ppm) + 1
        y0, y1 = int((c.center[1] - 0.35 * h) * ppm), int((c.center[1] + 0.35 * h) * ppm) + 1
        sub = tmask[max(0, y0) : y1, max(0, x0) : x1]
        if sub.size and float(sub.mean()) > TEXT_SHARE_MAX:
            continue
        out.append(c)
    return out


def enabled(env: dict[str, str] | None = None) -> bool:
    return (env if env is not None else os.environ).get(ENV_FLAG, "0").strip() == "1"


def method(env: dict[str, str] | None = None) -> str:
    m = (env if env is not None else os.environ).get(ENV_METHOD, "blobs").strip()
    return m if m in ("blobs", "template") else "blobs"


def _region_of(c: tuple[float, float], regions: list[dict[str, Any]]) -> dict[str, Any] | None:
    from ..symbols.detect import _region_of as ro

    return ro(c, regions)


def detect_raster_symbols(
    img: Image.Image,
    *,
    width_mm: float,
    regions: list[dict[str, Any]] | None = None,
    scale_den: int | None = None,
    title_block: BBox | None = None,
    how: str | None = None,
    read_marks: bool = True,
) -> DetectResult:
    t0 = time.monotonic()
    res = DetectResult()
    page = load_page(img, width_mm)
    legend, exemplars = find_exemplars(page, title_block=title_block)
    res.legend = legend
    t_legend = time.monotonic() - t0
    if not any(x.cls for x in exemplars):
        res.stats = {"exemplars": len(exemplars), "method": how or method(), "seconds": {"legend": round(t_legend, 2)}}
        return res
    scene = page.ink.copy()
    ppm = page.ppm
    for b in legend.exclusion_boxes(pad=2.0) + ([title_block] if title_block else []):
        scene[max(0, int(b[1] * ppm)) : int(b[3] * ppm) + 1, max(0, int(b[0] * ppm)) : int(b[2] * ppm) + 1] = False
    scale = float(os.environ.get("KAMUTAN_RASTER_SYMBOLS_SCALE", "0")) or estimate_scale(scene, exemplars)
    t_scale = time.monotonic() - t0 - t_legend
    m = how or method()
    # NCC on the full ink (stripping walls also cuts the sockets that sit on them: recall 50 → 11 TP on Noah);
    # the stripped ink seeds the blobs and the text-line mask
    work = strip_structure(scene, ppm)
    maps = response_maps(blur(scene), build_bank(exemplars, scale))
    t_maps = time.monotonic() - t0 - t_legend - t_scale
    cands = template.find(page, exemplars, maps) if m == "template" else blobs.find(page, exemplars, maps, work)
    cands = [c for c in drop_text(cands, text_mask(work, ppm), ppm) if ink_ok(c, maps[c.ex], scene, ppm)]
    kept = nms(cands, exemplars)
    t_match = time.monotonic() - t0 - t_legend - t_scale - t_maps
    dets = _to_detections(page, kept, exemplars, regions or [], scale_den, read_marks=read_marks)
    res.detections = dets
    res.stats = {
        "method": m,
        "exemplars": len(exemplars),
        "classified": sum(1 for x in exemplars if x.cls),
        "scale": scale,
        "candidates": len(cands),
        "seconds": {
            "legend": round(t_legend, 2),
            "scale": round(t_scale, 2),
            "maps": round(t_maps, 2),
            "match": round(t_match, 2),
            "total": round(time.monotonic() - t0, 2),
        },
    }
    return res


def _to_detections(
    page: Any,
    kept: list[Candidate],
    exemplars: list[Exemplar],
    regions: list[dict[str, Any]],
    scale_den: int | None,
    *,
    read_marks: bool,
) -> list[Detection]:
    per: dict[int, int] = {}
    for c in kept:
        per[c.ex] = per.get(c.ex, 0) + 1
    out: list[Detection] = []
    for c in sorted(kept, key=lambda q: (q.center[1], q.center[0])):
        x = exemplars[c.ex]
        if not x.cls or per[c.ex] > MAX_PER_CLASS:
            continue  # negatives (markers / unread labels) and over-firing glyphs
        margin = c.score - c.runner_up
        if margin < MIN_MARGIN:
            continue
        entry, cls = x.entry, x.cls
        if read_marks and cls in MULT_CLASSES:
            n = read_multiplicity(page, c.center)
            if n is not None:
                cls = apply_multiplicity(cls, n)
                mem = [exemplars[i] for i in x.members if exemplars[i].cls == cls]
                if mem:
                    entry = mem[0].entry
        w, h = c.size
        d = Detection(
            cls=cls,
            center=c.center,
            bbox=(c.center[0] - w / 2, c.center[1] - h / 2, c.center[0] + w / 2, c.center[1] + h / 2),
            angle=c.angle,
            entry=entry,
            quality=min(1.0, c.score),
            margin=max(0.0, margin),
            source="raster",
            class_conf=entry.class_conf,
            reasons=[R_RASTER],
        )
        r = _region_of(c.center, regions) if regions else None
        d.in_region = r is not None or not regions
        d.floor = (r or {}).get("floor") if r else None
        score_detection(d, raster=True, scale_uncertain=scale_den is None, confirmed=False)
        d.id = f"d_{len(out)}"
        out.append(d)
    return out
