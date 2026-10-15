"""Build a :class:`VectorSheet` from polylines (DXF capture, synthetic data) and paint one.

Coordinates are paper mm, origin top-left, y down — the same frame as the PDF path.
The painter rasterises a band of a vector sheet at any resolution without allocating
the whole page (used for DXF tiles).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from PIL import Image, ImageDraw

from ..ingest.pdf_vector import SEG_LINE, VectorSheet, sheet_stats


@dataclass
class VectorBuilder:
    stroke: list[tuple[int, int, int, int]] = field(default_factory=list)
    fill: list[tuple[int, int, int, int]] = field(default_factory=list)
    stroked: list[bool] = field(default_factory=list)
    fill_mode: list[int] = field(default_factory=list)
    width: list[float] = field(default_factory=list)
    closed: list[bool] = field(default_factory=list)
    layer: list[int] = field(default_factory=list)
    segs: list[np.ndarray] = field(default_factory=list)
    layers: list[str] = field(default_factory=list)
    _layer_ix: dict[str, int] = field(default_factory=dict)

    def layer_index(self, name: str | None) -> int:
        if not name:
            return -1
        if name not in self._layer_ix:
            self._layer_ix[name] = len(self.layers)
            self.layers.append(name)
        return self._layer_ix[name]

    def add(
        self,
        pts: np.ndarray,
        *,
        rgb: tuple[int, int, int] = (0, 0, 0),
        width_mm: float = 0.0,
        filled: bool = False,
        closed: bool = False,
        layer: str | None = None,
    ) -> None:
        """Add one polyline (k,2) in mm. Filled polygons are closed implicitly."""
        pts = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
        if len(pts) < 2 and not filled:
            if len(pts) == 1:  # a point: zero-length segment keeps it visible to consumers
                pts = np.vstack([pts, pts])
            else:
                return
        if (filled or closed) and len(pts) >= 2 and not np.allclose(pts[0], pts[-1]):
            pts = np.vstack([pts, pts[:1]])
        seg = np.hstack([pts[:-1], pts[1:]]).astype(np.float32)
        if seg.shape[0] == 0:
            return
        color = (*rgb, 255)
        self.stroke.append(color if not filled else (0, 0, 0, 0))
        self.fill.append(color if filled else (0, 0, 0, 0))
        self.stroked.append(not filled)
        self.fill_mode.append(2 if filled else 0)
        self.width.append(float(width_mm))
        self.closed.append(bool(filled or closed))
        self.layer.append(self.layer_index(layer))
        self.segs.append(seg)

    def build(self, page_index: int, width_mm: float, height_mm: float) -> VectorSheet:
        n = len(self.segs)
        counts = np.array([len(s) for s in self.segs], dtype=np.int32)
        starts = (np.cumsum(counts) - counts).astype(np.int32) if n else np.zeros(0, np.int32)
        segs = np.vstack(self.segs).astype(np.float32) if n else np.zeros((0, 4), np.float32)
        if n:
            xs = [np.concatenate([s[:, 0], s[:, 2]]) for s in self.segs]
            ys = [np.concatenate([s[:, 1], s[:, 3]]) for s in self.segs]
            bbox = np.array([[x.min(), y.min(), x.max(), y.max()] for x, y in zip(xs, ys, strict=True)], np.float32)
        else:
            bbox = np.zeros((0, 4), np.float32)
        vs = VectorSheet(
            page_index=page_index,
            width_mm=float(width_mm),
            height_mm=float(height_mm),
            path_stroke_rgba=np.asarray(self.stroke, np.uint8).reshape(-1, 4),
            path_fill_rgba=np.asarray(self.fill, np.uint8).reshape(-1, 4),
            path_stroked=np.asarray(self.stroked, bool),
            path_fill_mode=np.asarray(self.fill_mode, np.int8),
            path_width_mm=np.asarray(self.width, np.float32),
            path_dash=[() for _ in range(n)],
            path_closed=np.asarray(self.closed, bool),
            path_bbox=bbox,
            path_seg_start=starts,
            path_seg_count=counts,
            segs=segs,
            seg_path=np.repeat(np.arange(n, dtype=np.int32), counts) if n else np.zeros(0, np.int32),
            seg_kind=np.full(len(segs), SEG_LINE, np.int8),
            curves=np.zeros((0, 8), np.float32),
            curve_path=np.zeros(0, np.int32),
            path_layer=np.asarray(self.layer, np.int32),
            layers=list(self.layers),
        )
        vs.stats = sheet_stats(vs)
        return vs


def empty_sheet(page_index: int, width_mm: float, height_mm: float) -> VectorSheet:
    return VectorBuilder().build(page_index, width_mm, height_mm)


class VectorPainter:
    """Rasterise paths of a VectorSheet into arbitrary pixel windows (white background).

    ``extra`` sheets (e.g. DXF text outlines kept out of the primitives) are painted too.
    """

    def __init__(self, sheets: list[VectorSheet]) -> None:
        self.sheets = sheets

    def render(self, px_per_mm: float, x0: int, y0: int, w: int, h: int) -> Image.Image:
        img = Image.new("RGB", (w, h), (255, 255, 255))
        dr = ImageDraw.Draw(img)
        bx0, by0 = x0 / px_per_mm, y0 / px_per_mm
        bx1, by1 = (x0 + w) / px_per_mm, (y0 + h) / px_per_mm
        for vs in self.sheets:
            if vs.n_paths == 0:
                continue
            b = vs.path_bbox
            pad = vs.path_width_mm + 1.0 / px_per_mm
            vis = np.where((b[:, 2] + pad >= bx0) & (b[:, 0] - pad <= bx1) & (b[:, 3] + pad >= by0) & (b[:, 1] - pad <= by1))[0]
            # fills first, then strokes (drawing order inside each group is preserved)
            for filled in (True, False):
                for i in vis:
                    is_fill = vs.path_fill_mode[i] > 0
                    if is_fill != filled:
                        continue
                    s0, n = int(vs.path_seg_start[i]), int(vs.path_seg_count[i])
                    sg = vs.segs[s0 : s0 + n]
                    if not len(sg):
                        continue
                    pts = np.vstack([sg[:, :2], sg[-1:, 2:]]).astype(np.float64)
                    xy = [((x - bx0) * px_per_mm, (y - by0) * px_per_mm) for x, y in pts]
                    if is_fill:
                        rgb = tuple(int(c) for c in vs.path_fill_rgba[i][:3])
                        if len(xy) >= 3:
                            dr.polygon(xy, fill=rgb)  # type: ignore[arg-type]
                    else:
                        rgb = tuple(int(c) for c in vs.path_stroke_rgba[i][:3])
                        lw = max(1, round(float(vs.path_width_mm[i]) * px_per_mm))
                        dr.line(xy, fill=rgb, width=lw)  # type: ignore[arg-type]
        return img
