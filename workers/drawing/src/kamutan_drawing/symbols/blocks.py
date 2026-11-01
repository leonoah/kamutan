"""DXF block references as symbol detections, checked against the drawn graphics (Stage 10, A-pipeline-05, E2E-07).

A DXF names its symbols: every socket placed as an INSERT of block ``SOCKET`` is one socket. Drawings also carry
*exploded* copies (loose lines / circles of the same shape — the block was exploded and pasted once more, or a
symbol was never a block), so the block count and what the sheet shows can differ. Both counts are produced:

* **block count** — INSERTs of the block on the plan (legend samples and title-block contents excluded);
* **graphic count** — distinct places where the block's drawing is found among the sheet's strokes (vector spotting
  with a template made from the block's own exploded strokes; a loose copy drawn exactly on top of an INSERT is the
  same place).

Each distinct place becomes one detection (``source = "block"`` when an INSERT is there, else ``"vector"``). When the
two counts differ, every detection of that block gets the yellow reason naming both numbers, so the user sees which
count to trust. The class of a block comes from the label written next to one of its INSERTs (the legend row — the
legend sample itself is not counted), else from a block name that is itself a known label.

Pure geometry; no I/O.
"""

from __future__ import annotations

import math
import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from ..ingest.pdf_vector import VectorSheet
from ..legend.parse import LegendEntry
from ..ocr.dictionary import TextSpan
from .geometry import BBox, in_box, stroke_signature
from .match import build_scene, spot_template
from .template import build_template

R_BLOCK_COUNT = "ספירת בלוקים ({blocks}) שונה מהספירה הגרפית ({graphic})"
R_BLOCK_COUNT_PREFIX = "ספירת בלוקים ("
R_GRAPHIC_ONLY = "סמל משורטט ללא בלוק"
R_BLOCK_ONLY = "בלוק ללא שרטוט נראה"
MIN_QUALITY = 0.74  # same bar as the vector path for simple drawings
MAX_SYMBOL_MM = 30.0  # bigger blocks are frames, title blocks, furniture groups — not countable symbols
MIN_SYMBOL_MM = 0.8
_LEGEND_LAYER = re.compile(r"legend|מקרא|lgnd", re.IGNORECASE)
_LEGEND_TITLE = re.compile(r"מקרא")
# English block names that are a label in themselves (offices often name blocks after the item)
_NAME_CLASSES: dict[str, str] = {
    "SOCKET": "socket_single",
    "OUTLET": "socket_single",
    "SWITCH": "switch_single",
    "LAMP": "luminaire_ceiling",
    "LIGHT": "luminaire_ceiling",
}


@dataclass
class BlockPlace:
    center: tuple[float, float]
    bbox: BBox
    insert: bool  # an INSERT of the block is here
    graphics: int  # strokes of the block's drawing found here (0 = the INSERT draws nothing visible)


@dataclass
class BlockCount:
    name: str
    cls: str | None
    label: str
    label_conf: float
    blocks: int
    graphic: int
    places: list[BlockPlace] = field(default_factory=list)
    size: float = 0.0
    entry: LegendEntry | None = None

    @property
    def mismatch(self) -> bool:
        return self.blocks != self.graphic


def _box(ins: dict[str, Any]) -> BBox | None:
    b = ins.get("bboxMm")
    if not isinstance(b, list | tuple) or len(b) != 4:
        return None
    try:
        x0, y0, x1, y1 = (float(v) for v in b)
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in (x0, y0, x1, y1)) or x1 < x0 or y1 < y0:
        return None
    return (x0, y0, x1, y1)


def _label_of(b: BBox, spans: list[TextSpan], suggest: Any) -> tuple[str, str | None, float] | None:
    """The class-bearing label written beside the symbol (same row, within 2.5 symbol sizes of its edge)."""
    size = max(b[2] - b[0], b[3] - b[1])
    best: tuple[float, str, str | None, float] | None = None
    for s in spans:
        if len(s.text) > 60:
            continue
        sx0, sy0, sx1, sy1 = s.bbox
        if min(b[3], sy1) - max(b[1], sy0) < -0.3 * size:
            continue  # not on the symbol's row
        gap = max(sx0 - b[2], b[0] - sx1, 0.0)
        if gap > 2.5 * size:
            continue
        cls, conf = suggest(s.text, s.conf)
        if cls is None:
            continue
        if best is None or gap < best[0]:
            best = (gap, s.text, cls, conf)
    return None if best is None else (best[1], best[2], best[3])


def _is_legend_sample(ins: dict[str, Any], b: BBox, spans: list[TextSpan], legend_boxes: list[BBox]) -> bool:
    if _LEGEND_LAYER.search(str(ins.get("layer", ""))):
        return True
    cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    if any(lb[0] <= cx <= lb[2] and lb[1] <= cy <= lb[3] for lb in legend_boxes):
        return True
    # a "מקרא" title just above (within 40 mm) and roughly in the same column
    return any(
        _LEGEND_TITLE.search(s.text) and 0 <= cy - s.bbox[3] <= 40.0 and abs((s.bbox[0] + s.bbox[2]) / 2 - cx) <= 40.0
        for s in spans
        if len(s.text) <= 20
    )


def count_blocks(
    vs: VectorSheet,
    spans: list[TextSpan],
    inserts: list[dict[str, Any]],
    *,
    exclude: list[BBox],
    legend_boxes: list[BBox] | None = None,
    suggest: Any = None,
) -> list[BlockCount]:
    """Block count vs graphic count per countable block of the sheet (see the module docstring)."""
    if suggest is None:
        from ..legend.classes import suggest_class as suggest
    legend_boxes = legend_boxes or []
    by_name: dict[str, list[tuple[dict[str, Any], BBox]]] = defaultdict(list)
    for ins in inserts:
        b = _box(ins)
        if b is None:
            continue
        size = max(b[2] - b[0], b[3] - b[1])
        if not MIN_SYMBOL_MM <= size <= MAX_SYMBOL_MM:
            continue
        by_name[str(ins.get("name", ""))].append((ins, b))
    out: list[BlockCount] = []
    for name, items in sorted(by_name.items()):
        labelled = [(ins, b, lab) for ins, b in items if (lab := _label_of(b, spans, suggest)) is not None]
        samples = [(ins, b, lab) for ins, b, lab in labelled if _is_legend_sample(ins, b, spans, legend_boxes)]
        votes: dict[str, float] = defaultdict(float)
        label, label_conf = "", 0.0
        for _ins, _b, (txt, cls, conf) in samples or labelled:
            if cls:
                votes[cls] += conf
                if conf >= label_conf:
                    label, label_conf = txt, conf
        cls_name = max(votes, key=lambda k: votes[k]) if votes else _NAME_CLASSES.get(name.upper())
        if cls_name is None:
            continue  # a block nobody labelled: not a countable symbol on this sheet
        if not votes:
            label, label_conf = name, 0.6
        sample_ids = {id(ins) for ins, _b, _l in samples}
        plan = [(ins, b) for ins, b in items if id(ins) not in sample_ids and not _inside_any(b, exclude)]
        ref_b = samples[0][1] if samples else (plan[0][1] if plan else items[0][1])
        size = max(ref_b[2] - ref_b[0], ref_b[3] - ref_b[1])
        sample_boxes = [b for _i, b, _l in samples]
        entry = _entry_for(vs, ref_b, label, label_conf, cls_name)
        places = _places(vs, entry, plan, size, exclude + sample_boxes)
        out.append(
            BlockCount(
                name=name,
                cls=cls_name,
                label=label,
                label_conf=label_conf,
                blocks=len(plan),
                graphic=sum(1 for p in places if p.graphics > 0),
                places=places,
                size=size,
                entry=entry,
            )
        )
    return out


def _inside_any(b: BBox, boxes: list[BBox]) -> bool:
    cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    return any(x[0] <= cx <= x[2] and x[1] <= cy <= x[3] for x in boxes)


def _entry_for(vs: VectorSheet, b: BBox, label: str, conf: float, cls: str) -> LegendEntry | None:
    """A legend entry whose strokes are the block's own exploded drawing at ``b`` (the template source)."""
    s = vs.segs.astype(np.float64)
    pad = 0.05
    inside = in_box(s[:, 0], s[:, 1], b, pad) & in_box(s[:, 2], s[:, 3], b, pad)
    idx = np.nonzero(inside)[0]
    if len(idx) == 0:
        return None
    e = LegendEntry(n=0, legend_id="blocks", kind="symbol", symbol_bbox=b, label_bbox=None, label=label, label_conf=conf)
    e.seg_idx = idx.astype(np.int64)
    e.suggested_class, e.class_conf = cls, max(0.6, conf)
    e.signature = stroke_signature(s[idx])
    return e


def _places(
    vs: VectorSheet, entry: LegendEntry | None, plan: list[tuple[dict[str, Any], BBox]], size: float, exclude: list[BBox]
) -> list[BlockPlace]:
    """Distinct places: plan INSERTs ∪ graphic matches of the block's drawing (merged within half a symbol)."""
    merge = 0.5 * size
    places: list[BlockPlace] = [BlockPlace(((b[0] + b[2]) / 2, (b[1] + b[3]) / 2), b, True, 0) for _ins, b in plan]
    tpl = build_template("blk", entry, vs) if entry is not None else None
    if tpl is None:
        return places
    scene = build_scene(vs, exclude)
    cands = sorted((c for c in spot_template(tpl, scene, 1.0) if c.quality >= MIN_QUALITY), key=lambda c: -c.quality)
    # one graphic place per drawn copy: greedy NMS over candidates, then count copies by stroke overlap
    kept: list[Any] = []
    for c in cands:
        if all(math.dist(c.center, k.center) > merge for k in kept):
            kept.append(c)
    copies = _copies_at(vs, kept, tpl.w, tpl.h)
    for c, n in zip(kept, copies, strict=True):
        near = [p for p in places if math.dist(p.center, c.center) <= merge]
        if near:
            near[0].graphics += n
        else:
            places.append(BlockPlace(c.center, c.bbox(), False, n))
    return places


def _copies_at(vs: VectorSheet, cands: list[Any], w: float, h: float) -> list[int]:
    """How many drawn copies of the symbol sit at each candidate place (identical strokes stacked = 2 copies)."""
    if not cands:
        return []
    s = vs.segs.astype(np.float64)
    out = []
    for c in cands:
        b = c.bbox()
        m = in_box(s[:, 0], s[:, 1], b, 0.05) & in_box(s[:, 2], s[:, 3], b, 0.05)
        if not m.any():
            out.append(1)
            continue
        key = np.round(s[m] / 0.05).astype(np.int64)
        key = np.where((key[:, 0:1] > key[:, 2:3]) | ((key[:, 0:1] == key[:, 2:3]) & (key[:, 1:2] > key[:, 3:4])),
                       key[:, [2, 3, 0, 1]], key)  # fmt: skip
        _, counts = np.unique(key, axis=0, return_counts=True)
        out.append(max(1, int(np.median(counts))))
    return out
