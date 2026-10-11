"""Vector extraction from PDF pages with pypdfium2 (Apache/BSD; PyMuPDF is AGPL and not used).

Every path object on the page is read segment by segment (move/line/bezier), its
graphic state (stroke/fill RGBA, draw mode, line width, dash pattern) is captured,
and all coordinates are transformed to the canonical Kamutan frame:

    paper millimetres, origin at the top-left corner of the (crop) box, y pointing down.

Output is a compact, columnar :class:`VectorSheet` made of numpy arrays so that the
later stages (glyph clustering, symbol matching, rooms) can stay vectorised.
Bezier curves are kept as control points (``curves``) and are *also* flattened into
the ``segs`` array so that consumers that only understand straight segments see
the whole drawing.
"""

from __future__ import annotations

import ctypes
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c

PT_TO_MM = 25.4 / 72.0

SEG_LINE = 0
SEG_BEZIER = 1  # piece of a flattened bezier

# Number of straight pieces used when flattening one cubic bezier.
BEZIER_STEPS = 8


@dataclass
class VectorSheet:
    """Columnar primitives of one page, in paper mm, y-down, origin top-left."""

    page_index: int
    width_mm: float
    height_mm: float
    # --- per path (n_paths) ---
    path_stroke_rgba: np.ndarray  # (n,4) uint8
    path_fill_rgba: np.ndarray  # (n,4) uint8
    path_stroked: np.ndarray  # (n,) bool
    path_fill_mode: np.ndarray  # (n,) int8: 0 none, 1 alternate, 2 winding
    path_width_mm: np.ndarray  # (n,) float32 (0 => hairline)
    path_dash: list[tuple[float, ...]]  # dash array in mm, () for solid
    path_closed: np.ndarray  # (n,) bool: any subpath closed
    path_bbox: np.ndarray  # (n,4) float32 x0,y0,x1,y1
    path_seg_start: np.ndarray  # (n,) int32 index into segs
    path_seg_count: np.ndarray  # (n,) int32
    # --- per straight segment (m) ---
    segs: np.ndarray  # (m,4) float32 x0,y0,x1,y1
    seg_path: np.ndarray  # (m,) int32
    seg_kind: np.ndarray  # (m,) int8 SEG_LINE / SEG_BEZIER
    # --- original cubic beziers (k) ---
    curves: np.ndarray  # (k,8) float32 p0,c1,c2,p3
    curve_path: np.ndarray  # (k,) int32
    stats: dict[str, Any] = field(default_factory=dict)

    @property
    def n_paths(self) -> int:
        return int(self.path_bbox.shape[0])

    @property
    def n_segs(self) -> int:
        return int(self.segs.shape[0])

    def seg_rgb(self) -> np.ndarray:
        """Stroke RGB per segment (m,3) uint8."""
        return self.path_stroke_rgba[self.seg_path, :3]

    def seg_width(self) -> np.ndarray:
        return self.path_width_mm[self.seg_path]


def _matrix_of(obj_raw) -> np.ndarray:
    m = pdfium_c.FS_MATRIX()
    if not pdfium_c.FPDFPageObj_GetMatrix(obj_raw, ctypes.byref(m)):
        return np.eye(3)
    return np.array([[m.a, m.c, m.e], [m.b, m.d, m.f], [0.0, 0.0, 1.0]])


def _color(fn, obj_raw) -> tuple[int, int, int, int]:
    r, g, b, a = (ctypes.c_uint() for _ in range(4))
    if not fn(obj_raw, ctypes.byref(r), ctypes.byref(g), ctypes.byref(b), ctypes.byref(a)):
        return (0, 0, 0, 0)
    return (r.value, g.value, b.value, a.value)


def _page_to_mm(page: pdfium.PdfPage) -> tuple[np.ndarray, float, float]:
    """Affine matrix (3x3) mapping PDF user space (pt, y-up) to paper mm, y-down.

    Takes the crop box and the page /Rotate into account (rotation is applied
    clockwise as viewers do).
    """
    x0, y0, x1, y1 = page.get_cropbox()
    w, h = x1 - x0, y1 - y0
    rot = page.get_rotation() % 360
    # first: translate to box origin and flip y -> (u, v) in pt, y-down, size w x h
    flip = np.array([[1.0, 0.0, -x0], [0.0, -1.0, y1], [0.0, 0.0, 1.0]])
    if rot == 0:
        r = np.eye(3)
        W, H = w, h
    elif rot == 90:  # clockwise: (u,v) -> (h - v, u)
        r = np.array([[0.0, -1.0, h], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]])
        W, H = h, w
    elif rot == 180:
        r = np.array([[-1.0, 0.0, w], [0.0, -1.0, h], [0.0, 0.0, 1.0]])
        W, H = w, h
    elif rot == 270:
        r = np.array([[0.0, 1.0, 0.0], [-1.0, 0.0, w], [0.0, 0.0, 1.0]])
        W, H = h, w
    else:  # pragma: no cover - PDF only allows multiples of 90
        raise ValueError(f"unsupported rotation {rot}")
    s = np.diag([PT_TO_MM, PT_TO_MM, 1.0])
    return s @ r @ flip, W * PT_TO_MM, H * PT_TO_MM


def _flatten_bezier(p0, c1, c2, p3, steps: int = BEZIER_STEPS) -> np.ndarray:
    t = np.linspace(0.0, 1.0, steps + 1)[:, None]
    mt = 1.0 - t
    pts = (mt**3) * p0 + 3 * (mt**2) * t * c1 + 3 * mt * (t**2) * c2 + (t**3) * p3
    return pts


def _object_to_page_matrix(obj: pdfium.PdfObject) -> np.ndarray:
    m = _matrix_of(obj.raw)
    parent = getattr(obj, "container", None)
    # Objects nested inside form XObjects: compose with the form object's matrices.
    while parent is not None and isinstance(parent, pdfium.PdfObject):
        m = _matrix_of(parent.raw) @ m
        parent = getattr(parent, "container", None)
    return m


def extract_page(page: pdfium.PdfPage, page_index: int = 0) -> VectorSheet:
    to_mm, width_mm, height_mm = _page_to_mm(page)

    p_stroke: list[tuple[int, int, int, int]] = []
    p_fill: list[tuple[int, int, int, int]] = []
    p_stroked: list[bool] = []
    p_fillmode: list[int] = []
    p_width: list[float] = []
    p_dash: list[tuple[float, ...]] = []
    p_closed: list[bool] = []
    p_bbox: list[tuple[float, float, float, float]] = []
    p_start: list[int] = []
    p_count: list[int] = []

    segs: list[np.ndarray] = []
    seg_kind: list[np.ndarray] = []
    seg_path: list[np.ndarray] = []
    curves: list[np.ndarray] = []
    curve_path: list[int] = []
    n_seg_total = 0
    n_forms = 0
    n_images = 0
    n_text = 0

    fx = ctypes.c_float()
    fy = ctypes.c_float()
    for obj in page.get_objects(max_depth=15):
        t = obj.type
        if t == pdfium_c.FPDF_PAGEOBJ_FORM:
            n_forms += 1
            continue
        if t == pdfium_c.FPDF_PAGEOBJ_IMAGE:
            n_images += 1
            continue
        if t == pdfium_c.FPDF_PAGEOBJ_TEXT:
            n_text += 1
            continue
        if t != pdfium_c.FPDF_PAGEOBJ_PATH:
            continue
        raw = obj.raw
        n = pdfium_c.FPDFPath_CountSegments(raw)
        if n <= 0:
            continue
        m = to_mm @ _object_to_page_matrix(obj)
        lin = m[:2, :2]
        scale_lin = float(np.sqrt(abs(np.linalg.det(lin))))

        fillmode = ctypes.c_int()
        stroke = ctypes.c_int()
        pdfium_c.FPDFPath_GetDrawMode(raw, ctypes.byref(fillmode), ctypes.byref(stroke))
        w = ctypes.c_float()
        pdfium_c.FPDFPageObj_GetStrokeWidth(raw, ctypes.byref(w))
        dash: tuple[float, ...] = ()
        dc = pdfium_c.FPDFPageObj_GetDashCount(raw)
        if dc > 0:
            arr = (ctypes.c_float * dc)()
            if pdfium_c.FPDFPageObj_GetDashArray(raw, arr, dc):
                # dash lengths are in object user space; mm conversion embedded in scale_lin
                dash = tuple(round(float(v) * scale_lin, 4) for v in arr)

        # Collect raw points
        pts = np.empty((n, 2), dtype=np.float64)
        types = np.empty(n, dtype=np.int8)
        closes = np.zeros(n, dtype=bool)
        for i in range(n):
            s = pdfium_c.FPDFPath_GetPathSegment(raw, i)
            pdfium_c.FPDFPathSegment_GetPoint(s, ctypes.byref(fx), ctypes.byref(fy))
            pts[i] = (fx.value, fy.value)
            types[i] = pdfium_c.FPDFPathSegment_GetType(s)
            closes[i] = bool(pdfium_c.FPDFPathSegment_GetClose(s))
        pts = pts @ lin.T + m[:2, 2]

        path_idx = len(p_bbox)
        lines: list[tuple[float, float, float, float]] = []
        kinds: list[int] = []
        cur = None
        sub_start = None
        i = 0
        while i < n:
            ty = types[i]
            if ty == pdfium_c.FPDF_SEGMENT_MOVETO:
                cur = pts[i]
                sub_start = pts[i]
                i += 1
                continue
            if cur is None:  # malformed: treat as moveto
                cur = pts[i]
                sub_start = pts[i]
                i += 1
                continue
            if ty == pdfium_c.FPDF_SEGMENT_LINETO:
                nxt = pts[i]
                lines.append((cur[0], cur[1], nxt[0], nxt[1]))
                kinds.append(SEG_LINE)
                cur = nxt
                closing = closes[i]
                i += 1
            elif ty == pdfium_c.FPDF_SEGMENT_BEZIERTO and i + 2 < n:
                c1, c2, p3 = pts[i], pts[i + 1], pts[i + 2]
                curves.append(np.concatenate([cur, c1, c2, p3]).astype(np.float32))
                curve_path.append(path_idx)
                fl = _flatten_bezier(cur, c1, c2, p3)
                for a, b in zip(fl[:-1], fl[1:]):
                    lines.append((a[0], a[1], b[0], b[1]))
                    kinds.append(SEG_BEZIER)
                cur = p3
                closing = closes[i + 2]
                i += 3
            else:
                i += 1
                continue
            if closing and sub_start is not None:
                if not np.allclose(cur, sub_start):
                    lines.append((cur[0], cur[1], sub_start[0], sub_start[1]))
                    kinds.append(SEG_LINE)
                cur = sub_start

        arr = np.asarray(lines, dtype=np.float32).reshape(-1, 4)
        if arr.shape[0]:
            xs = np.concatenate([arr[:, 0], arr[:, 2]])
            ys = np.concatenate([arr[:, 1], arr[:, 3]])
            bbox = (float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max()))
        else:  # isolated moveto(s)
            bbox = (
                float(pts[:, 0].min()),
                float(pts[:, 1].min()),
                float(pts[:, 0].max()),
                float(pts[:, 1].max()),
            )

        p_stroke.append(_color(pdfium_c.FPDFPageObj_GetStrokeColor, raw))
        p_fill.append(_color(pdfium_c.FPDFPageObj_GetFillColor, raw))
        p_stroked.append(bool(stroke.value))
        p_fillmode.append(int(fillmode.value))
        p_width.append(float(w.value) * scale_lin)
        p_dash.append(dash)
        p_closed.append(bool(closes.any()))
        p_bbox.append(bbox)
        p_start.append(n_seg_total)
        p_count.append(arr.shape[0])
        segs.append(arr)
        seg_kind.append(np.asarray(kinds, dtype=np.int8))
        seg_path.append(np.full(arr.shape[0], path_idx, dtype=np.int32))
        n_seg_total += arr.shape[0]

    def cat(lst, shape, dtype):
        return np.concatenate(lst).astype(dtype) if lst else np.zeros(shape, dtype=dtype)

    vs = VectorSheet(
        page_index=page_index,
        width_mm=float(width_mm),
        height_mm=float(height_mm),
        path_stroke_rgba=np.asarray(p_stroke, dtype=np.uint8).reshape(-1, 4),
        path_fill_rgba=np.asarray(p_fill, dtype=np.uint8).reshape(-1, 4),
        path_stroked=np.asarray(p_stroked, dtype=bool),
        path_fill_mode=np.asarray(p_fillmode, dtype=np.int8),
        path_width_mm=np.asarray(p_width, dtype=np.float32),
        path_dash=p_dash,
        path_closed=np.asarray(p_closed, dtype=bool),
        path_bbox=np.asarray(p_bbox, dtype=np.float32).reshape(-1, 4),
        path_seg_start=np.asarray(p_start, dtype=np.int32),
        path_seg_count=np.asarray(p_count, dtype=np.int32),
        segs=cat(segs, (0, 4), np.float32),
        seg_path=cat(seg_path, (0,), np.int32),
        seg_kind=cat(seg_kind, (0,), np.int8),
        curves=np.asarray(curves, dtype=np.float32).reshape(-1, 8),
        curve_path=np.asarray(curve_path, dtype=np.int32),
    )
    vs.stats = sheet_stats(vs, n_forms=n_forms, n_images=n_images, n_text=n_text)
    return vs


def sheet_stats(vs: VectorSheet, **extra: int) -> dict[str, Any]:
    from collections import Counter

    rgb = Counter(
        "#%02x%02x%02x" % tuple(int(v) for v in c[:3])
        for c, s in zip(vs.path_stroke_rgba, vs.path_stroked)
        if s
    )
    widths = Counter(round(float(w), 3) for w in vs.path_width_mm)
    lens = (
        np.hypot(vs.segs[:, 2] - vs.segs[:, 0], vs.segs[:, 3] - vs.segs[:, 1])
        if vs.n_segs
        else np.zeros(0)
    )
    return {
        "page_index": vs.page_index,
        "width_mm": round(vs.width_mm, 2),
        "height_mm": round(vs.height_mm, 2),
        "paper": paper_size_name(vs.width_mm, vs.height_mm),
        "n_paths": vs.n_paths,
        "n_segments": vs.n_segs,
        "n_beziers": int(vs.curves.shape[0]),
        "n_filled_paths": int((vs.path_fill_mode > 0).sum()),
        "n_dashed_paths": int(sum(1 for d in vs.path_dash if d)),
        "stroke_colors_top": rgb.most_common(12),
        "line_widths_mm_top": widths.most_common(8),
        "segment_len_mm_median": float(np.median(lens)) if lens.size else 0.0,
        "has_text_layer": bool(extra.get("n_text", 0)),
        **extra,
    }


_PAPER = {"A0": (1189, 841), "A1": (841, 594), "A2": (594, 420), "A3": (420, 297), "A4": (297, 210)}


def paper_size_name(w: float, h: float, tol: float = 3.0) -> str:
    a, b = max(w, h), min(w, h)
    for name, (pw, ph) in _PAPER.items():
        if abs(a - pw) <= tol and abs(b - ph) <= tol:
            return name
    return f"{a:.0f}x{b:.0f}mm"


def extract_pdf(path: str | Path, pages: list[int] | None = None) -> list[VectorSheet]:
    pdf = pdfium.PdfDocument(str(path))
    try:
        idx = range(len(pdf)) if pages is None else pages
        out = []
        for i in idx:
            page = pdf[i]
            try:
                out.append(extract_page(page, i))
            finally:
                page.close()
        return out
    finally:
        pdf.close()


def save_npz(vs: VectorSheet, path: str | Path) -> None:
    """Persist the columnar primitives (dash arrays as a ragged pair)."""
    dash_flat = np.asarray([v for d in vs.path_dash for v in d], dtype=np.float32)
    dash_len = np.asarray([len(d) for d in vs.path_dash], dtype=np.int16)
    np.savez_compressed(
        path,
        meta=np.asarray([vs.page_index, vs.width_mm, vs.height_mm], dtype=np.float64),
        path_stroke_rgba=vs.path_stroke_rgba,
        path_fill_rgba=vs.path_fill_rgba,
        path_stroked=vs.path_stroked,
        path_fill_mode=vs.path_fill_mode,
        path_width_mm=vs.path_width_mm,
        dash_flat=dash_flat,
        dash_len=dash_len,
        path_closed=vs.path_closed,
        path_bbox=vs.path_bbox,
        path_seg_start=vs.path_seg_start,
        path_seg_count=vs.path_seg_count,
        segs=vs.segs,
        seg_path=vs.seg_path,
        seg_kind=vs.seg_kind,
        curves=vs.curves,
        curve_path=vs.curve_path,
    )
