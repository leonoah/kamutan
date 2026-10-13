"""DXF ingest with ezdxf (runs inside the sandbox).

* Real ``TEXT``/``MTEXT``/``ATTRIB`` strings are read directly (no OCR); their paper
  bbox is the extent of the glyph outlines the ezdxf frontend draws for them.
* ``INSERT`` references are listed with block name, layer, position, rotation, scale and
  attributes (symbols for free); every primitive keeps its layer.
* Rendering: the ezdxf drawing frontend drives a capturing backend; the captured
  polylines/polygons are the page primitives and are rasterised by
  :class:`~kamutan_drawing.parse.vectors.VectorPainter` band by band for the tiles.
* Security (SEC-17): IMAGE entities are ignored (their file path is never opened),
  OLE frames and proxy graphics are ignored, XREFs are never resolved.

Pages: every paper-space layout that has entities is a page (paper units, mm unless
``$INSUNITS`` says inch); otherwise model space is one page, mapped to paper with the
smallest standard scale that fits A0 (or the ``1:N`` written in the drawing when it fits).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from ..errors import IngestError
from ..ingest.pdf_vector import VectorSheet
from .vectors import VectorBuilder

COMMON_SCALES = (1, 2, 5, 10, 20, 25, 50, 75, 100, 200, 250, 500, 1000, 2000, 5000)
A0 = (1189.0, 841.0)
MARGIN_MM = 10.0
TEXT_TYPES = frozenset({"TEXT", "MTEXT", "ATTRIB", "ATTDEF"})
# $INSUNITS -> millimetres per drawing unit
UNIT_MM = {1: 25.4, 2: 304.8, 4: 1.0, 5: 10.0, 6: 1000.0, 14: 100.0}
_SCALE_TXT = re.compile(r"1\s*:\s*(\d{1,4})")
MAX_ENTITIES = 2_000_000
MAX_BLOCK_DEPTH = 32


@dataclass
class DxfText:
    text: str
    bbox: tuple[float, float, float, float]  # drawing units, y up
    height: float
    rotation: float  # degrees CCW
    layer: str


@dataclass
class DxfPage:
    index: int
    name: str
    width_mm: float
    height_mm: float
    vs: VectorSheet  # primitives without text outlines
    text_vs: VectorSheet  # text outlines (rendered in tiles, not part of the primitives)
    texts: list[dict[str, Any]] = field(default_factory=list)  # {text,bboxMm,angle,heightMm,layer}
    inserts: list[dict[str, Any]] = field(default_factory=list)
    scale_den: int | None = None
    units_known: bool = True
    from_modelspace: bool = True


def _color_rgb(c: str) -> tuple[int, int, int]:
    c = c.lstrip("#")
    if len(c) >= 6:
        try:
            rgb = int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)
            # ACI 7 ("foreground") comes out white for a dark screen background; on paper it is black
            return (0, 0, 0) if min(rgb) >= 250 else rgb
        except ValueError:
            pass
    return (0, 0, 0)


class _Capture:
    """Minimal ezdxf BackendInterface collecting geometry in drawing units."""

    def __init__(self) -> None:
        self.items: list[tuple[np.ndarray, tuple[int, int, int], float, bool, bool, str, bool]] = []
        self.texts: list[DxfText] = []
        self._stack: list[Any] = []
        self._text_entity: Any = None
        self._text_pts: list[np.ndarray] = []
        self.n_entities = 0

    # -- ezdxf BackendInterface --------------------------------------------------
    def configure(self, config: Any) -> None:
        pass

    def set_background(self, color: Any) -> None:
        pass

    def clear(self) -> None:
        pass

    def finalize(self) -> None:
        pass

    def enter_entity(self, entity: Any, properties: Any) -> None:
        self.n_entities += 1
        if self.n_entities > MAX_ENTITIES:
            raise IngestError("too_complex", "DXF has too many entities")
        self._stack.append(entity)
        if self._text_entity is None and entity.dxftype() in TEXT_TYPES:
            self._text_entity = entity
            self._text_pts = []

    def exit_entity(self, entity: Any) -> None:
        if self._stack:
            self._stack.pop()
        if entity is self._text_entity:
            self._finish_text(entity)
            self._text_entity = None

    def _finish_text(self, e: Any) -> None:
        try:
            raw = e.plain_text() if hasattr(e, "plain_text") else e.dxf.text
        except Exception:  # noqa: BLE001 - hostile DXF: any decoding error falls back to the raw text
            raw = getattr(e.dxf, "text", "")
        text = " ".join(str(raw).split())
        if not text or not self._text_pts:
            return
        P = np.vstack(self._text_pts)
        h = float(getattr(e.dxf, "char_height", 0.0) or getattr(e.dxf, "height", 0.0) or 0.0)
        rot = float(getattr(e.dxf, "rotation", 0.0) or 0.0)
        layer = str(getattr(e.dxf, "layer", "") or "")
        self.texts.append(
            DxfText(text, (float(P[:, 0].min()), float(P[:, 1].min()), float(P[:, 0].max()), float(P[:, 1].max())), h, rot, layer)
        )

    def _add(self, pts: np.ndarray, props: Any, filled: bool, closed: bool) -> None:
        if len(pts) == 0:
            return
        in_text = self._text_entity is not None
        if in_text:
            self._text_pts.append(pts)
        lw = float(getattr(props, "lineweight", 0.0) or 0.0)
        self.items.append(
            (
                pts,
                _color_rgb(str(getattr(props, "color", "#000000"))),
                lw,
                filled,
                closed,
                str(getattr(props, "layer", "")),
                in_text,
            )
        )

    def draw_point(self, pos: Any, properties: Any) -> None:
        self._add(np.array([[pos.x, pos.y]]), properties, False, False)

    def draw_line(self, start: Any, end: Any, properties: Any) -> None:
        self._add(np.array([[start.x, start.y], [end.x, end.y]]), properties, False, False)

    def draw_solid_lines(self, lines: Any, properties: Any) -> None:
        for s, t in lines:
            self.draw_line(s, t, properties)

    def draw_path(self, path: Any, properties: Any) -> None:
        for sp in path.sub_paths() if path.has_sub_paths else [path]:
            pts = np.array([(v.x, v.y) for v in sp.flattening(0.01 * max(1e-9, _path_size(sp)) or 0.1)])
            self._add(pts, properties, False, bool(sp.is_closed))

    def draw_filled_paths(self, paths: Any, properties: Any) -> None:
        for p in paths:
            for sp in p.sub_paths() if p.has_sub_paths else [p]:
                pts = np.array([(v.x, v.y) for v in sp.flattening(0.01 * max(1e-9, _path_size(sp)) or 0.1)])
                self._add(pts, properties, True, True)

    def draw_filled_polygon(self, points: Any, properties: Any) -> None:
        pts = np.array([(v.x, v.y) for v in points.vertices()])
        self._add(pts, properties, True, True)

    def draw_image(self, image_data: Any, properties: Any) -> None:  # never displayed (SEC-17)
        pass


def _path_size(p: Any) -> float:
    try:
        bb = p.bbox()
        return float(max(bb.size.x, bb.size.y))
    except Exception:  # noqa: BLE001 - degenerate path from a hostile file: default flattening size
        return 1.0


def load_doc(path: str) -> Any:
    import os

    import ezdxf
    from ezdxf import recover

    if os.path.getsize(path) == 0:  # finding F-1: ezdxf "recovers" an empty document from 0 bytes
        raise IngestError("file_unreadable", "DXF file is empty")
    try:
        doc, _auditor = recover.readfile(path)
    except (OSError, ezdxf.DXFStructureError) as e:
        raise IngestError("file_unreadable", f"DXF could not be read ({type(e).__name__})") from None
    return doc


def expanded_entity_count(doc: Any, layout: Any, limit: int = MAX_ENTITIES) -> int:
    """Entities the drawing frontend would visit, following INSERT (incl. MINSERT arrays) and
    DIMENSION blocks — computed statically, before anything is exploded.

    Findings F-2/F-3 (sprint-1 security gate): a self-referencing block or a 1 KB "billion
    laughs" fan-out (9 levels x 10 INSERTs) must end as ``too_complex`` in milliseconds instead
    of a RecursionError or minutes of CPU.
    """
    memo: dict[str, int] = {}
    visiting: set[str] = set()

    def block(name: str, depth: int) -> int:
        if name in memo:
            return memo[name]
        if name in visiting or depth > MAX_BLOCK_DEPTH:
            raise IngestError("too_complex", "DXF block references are cyclic or nested too deeply")
        blk = doc.blocks.get(name)
        if blk is None:
            memo[name] = 0
            return 0
        visiting.add(name)
        n = entities(blk, depth + 1)
        visiting.discard(name)
        memo[name] = n
        return n

    def entities(container: Any, depth: int) -> int:
        total = 0
        for e in container:
            total += 1
            t = e.dxftype()
            if t == "INSERT":
                rep = max(1, int(e.dxf.get("row_count", 1) or 1)) * max(1, int(e.dxf.get("column_count", 1) or 1))
                total += rep * block(str(e.dxf.name), depth)
            elif t == "DIMENSION" and e.dxf.hasattr("geometry"):
                total += block(str(e.dxf.geometry), depth)
            if total > limit:
                raise IngestError("too_complex", "DXF has too many entities (after block expansion)")
        return total

    return entities(layout, 0)


def page_layouts(doc: Any) -> list[tuple[str, Any, bool]]:
    """[(name, layout, is_modelspace)]: paper layouts with entities, else model space."""
    out = []
    for name in doc.layout_names_in_taborder():
        if name.lower() == "model":
            continue
        lay = doc.layouts.get(name)
        if len(lay) > 0:
            out.append((name, lay, False))
    if not out:
        msp = doc.modelspace()
        if len(msp) == 0:
            raise IngestError("file_unreadable", "DXF contains no drawable entities")
        out.append(("Model", msp, True))
    return out


def _capture_layout(doc: Any, layout: Any) -> _Capture:
    from ezdxf.addons.drawing.config import BackgroundPolicy, Configuration, ImagePolicy, ProxyGraphicPolicy
    from ezdxf.addons.drawing.frontend import Frontend
    from ezdxf.addons.drawing.properties import RenderContext

    cap = _Capture()
    cfg = Configuration(
        image_policy=ImagePolicy.IGNORE,
        proxy_graphic_policy=ProxyGraphicPolicy.IGNORE,
        background_policy=BackgroundPolicy.WHITE,  # paper: ACI 7 is drawn black
        hatching_timeout=5.0,
    )
    ctx = RenderContext(doc)
    Frontend(ctx, cap, config=cfg).draw_layout(layout, finalize=True)  # type: ignore[arg-type]
    return cap


def _choose_scale(w_mm: float, h_mm: float, declared: list[int]) -> int:
    a, b = max(w_mm, h_mm), min(w_mm, h_mm)
    for d in declared:
        if a / d <= 2 * A0[0] and b / d <= 2 * A0[1]:
            return d
    for d in COMMON_SCALES:
        if a / d <= A0[0] and b / d <= A0[1]:
            return d
    return COMMON_SCALES[-1]


def extract_page(doc: Any, index: int) -> DxfPage:
    layouts = page_layouts(doc)
    if not 0 <= index < len(layouts):
        raise IngestError("file_unreadable", "DXF page out of range")
    name, layout, is_ms = layouts[index]
    expanded_entity_count(doc, layout)
    cap = _capture_layout(doc, layout)
    insunits = int(doc.header.get("$INSUNITS", 0) or 0)
    units_known = insunits in UNIT_MM
    unit_mm = UNIT_MM.get(insunits, 1.0)
    pts = [it[0] for it in cap.items]
    if pts:
        P = np.vstack(pts)
        P = P[np.isfinite(P).all(axis=1)]
    else:
        P = np.zeros((0, 2))
    if len(P) == 0:
        x0 = y0 = 0.0
        x1, y1 = 100.0, 100.0
    else:
        x0, y0 = np.percentile(P, 0.0, axis=0)
        x1, y1 = np.percentile(P, 100.0, axis=0)
    texts_scale = [int(m.group(1)) for t in cap.texts for m in _SCALE_TXT.finditer(t.text) if 0 < int(m.group(1)) <= 5000]
    if is_ms:
        den = _choose_scale(
            (x1 - x0) * unit_mm, (y1 - y0) * unit_mm, sorted(set(texts_scale), key=texts_scale.count, reverse=True)
        )
        k = unit_mm / den
    else:
        den = None
        k = 25.4 if insunits == 1 else 1.0
    margin = MARGIN_MM
    width_mm = (x1 - x0) * k + 2 * margin
    height_mm = (y1 - y0) * k + 2 * margin
    if not (math.isfinite(width_mm) and math.isfinite(height_mm)) or max(width_mm, height_mm) > 5000:
        raise IngestError("page_too_large", "DXF extents are too large for one sheet")

    def to_mm(a: np.ndarray) -> np.ndarray:
        return np.column_stack([(a[:, 0] - x0) * k + margin, (y1 - a[:, 1]) * k + margin])

    geo, txt = VectorBuilder(), VectorBuilder()
    for p, rgb, lw, filled, closed, layer, in_text in cap.items:
        if not np.isfinite(p).all():
            continue
        (txt if in_text else geo).add(to_mm(p), rgb=rgb, width_mm=lw, filled=filled, closed=closed, layer=layer)
    texts = []
    for t in cap.texts:
        bx = to_mm(np.array([[t.bbox[0], t.bbox[3]], [t.bbox[2], t.bbox[1]]]))
        ang = round(t.rotation % 360.0, 2)
        texts.append(
            {
                "text": t.text,
                "bboxMm": [round(float(v), 3) for v in (bx[0, 0], bx[0, 1], bx[1, 0], bx[1, 1])],
                "angle": ang,
                "heightMm": round(t.height * k, 3),
                "confidence": 1.0,
                "layer": t.layer,
            }
        )
    inserts = []
    for e in layout.query("INSERT"):
        try:
            ins = e.dxf.insert
            pos = to_mm(np.array([[ins.x, ins.y]]))[0]
            attribs = {a.dxf.tag: a.dxf.text for a in e.attribs}
            inserts.append(
                {
                    "name": str(e.dxf.name),
                    "layer": str(e.dxf.layer),
                    "xMm": round(float(pos[0]), 3),
                    "yMm": round(float(pos[1]), 3),
                    "rotation": round(float(e.dxf.rotation or 0.0), 3),
                    "scale": [float(e.dxf.xscale or 1.0), float(e.dxf.yscale or 1.0)],
                    "attribs": attribs,
                }
            )
        except Exception:  # noqa: BLE001, S112 - a malformed INSERT must not fail the sheet
            continue
    return DxfPage(
        index=index,
        name=name,
        width_mm=float(width_mm),
        height_mm=float(height_mm),
        vs=geo.build(index, width_mm, height_mm),
        text_vs=txt.build(index, width_mm, height_mm),
        texts=texts,
        inserts=inserts,
        scale_den=den,
        units_known=units_known or not is_ms,
        from_modelspace=is_ms,
    )
