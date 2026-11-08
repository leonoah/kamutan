"""Scene -> DXF (ezdxf, R2018). Model space in real-world millimetres: X = x_paper * scale, Y = -y_paper * scale.

Symbols become BLOCK definitions + INSERTs (rotation, negative X scale when mirrored) unless the symbol is
"exploded" (spec knob) or it carries text that an INSERT would turn / mirror differently from the PDF; then its
primitives are written directly. Text is real TEXT in logical order with a TTF text style.
"""

from __future__ import annotations

import hashlib
import math
import uuid
from pathlib import Path

import ezdxf
from ezdxf.document import CREATED_BY_EZDXF
from ezdxf.enums import TextEntityAlignment
from ezdxf.layouts import BaseLayout

from .scene import RGB, Arc, Circle, Item, Pen, Poly, Prim, Scene, SymbolRef, Text, expand, resolve_fill, resolve_pen

_ALIGN = {
    ("l", "b"): TextEntityAlignment.LEFT,
    ("c", "b"): TextEntityAlignment.CENTER,
    ("r", "b"): TextEntityAlignment.RIGHT,
    ("l", "m"): TextEntityAlignment.MIDDLE_LEFT,
    ("c", "m"): TextEntityAlignment.MIDDLE_CENTER,
    ("r", "m"): TextEntityAlignment.MIDDLE_RIGHT,
    ("l", "t"): TextEntityAlignment.TOP_LEFT,
    ("c", "t"): TextEntityAlignment.TOP_CENTER,
    ("r", "t"): TextEntityAlignment.TOP_RIGHT,
}
_LW = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100]


def _lw(mm: float) -> int:
    v = mm * 100
    return min(_LW, key=lambda x: abs(x - v))


def _tc(c: RGB) -> int:
    return (c[0] << 16) | (c[1] << 8) | c[2]


def _linetype(dash: tuple[float, ...] | None) -> str:
    if not dash:
        return "CONTINUOUS"
    if len(dash) >= 4:
        return "DASHDOT" if dash[0] < 5 else "CENTER"
    return "DASHED"


class _Writer:
    def __init__(self, scene: Scene, scale: int, sheet_id: str) -> None:
        self.scene = scene
        self.S = float(scale)
        doc = ezdxf.new("R2018", setup=True, units=4)
        md = doc.ezdxf_metadata()
        md[CREATED_BY_EZDXF] = f"{ezdxf.__version__} @ 2026-01-01T00:00:00+00:00"
        doc.header["$MEASUREMENT"] = 1
        doc.header["$LTSCALE"] = self.S
        doc.header["$TDCREATE"] = 2461000.5
        doc.header["$TDUPDATE"] = 2461000.5
        doc.header["$TDINDWG"] = 0.0
        doc.header["$TDUSRTIMER"] = 0.0
        g = uuid.UUID(bytes=hashlib.sha256(sheet_id.encode()).digest()[:16])
        doc.header["$FINGERPRINTGUID"] = "{" + str(g).upper() + "}"
        doc.header["$VERSIONGUID"] = "{" + str(g).upper() + "}"
        font = scene.font
        doc.styles.add("SYNTH", font=Path(font.ttf_path).name if font.ttf_path else "DejaVuSans.ttf")
        for lay in scene.layers.values():
            layer = doc.layers.add(lay.name)
            layer.rgb = lay.color
            layer.dxf.lineweight = _lw(lay.lw)
        self.doc = doc
        self.msp = doc.modelspace()
        self.blocks: dict[str, str] = {}

    def P(self, p: tuple[float, float]) -> tuple[float, float]:
        return (p[0] * self.S, -p[1] * self.S)

    # ------------------------------------------------------------------------------------- primitives
    def prim(self, lay: BaseLayout, p: Prim, owner: Pen, layer: str, *, k: float, flip: bool, block: bool) -> None:
        """Write one primitive. ``k`` scales coordinates, ``flip`` maps y-down to y-up (always true here)."""

        def T(q: tuple[float, float]) -> tuple[float, float]:
            return (q[0] * k, -q[1] * k if flip else q[1] * k)

        attrs: dict[str, object] = {"layer": "0" if block else layer}
        if isinstance(p, Text):
            col = p.color or owner.color
            h = p.h * k
            e = lay.add_text(p.text, height=h, rotation=p.angle, dxfattribs=attrs | {"style": "SYNTH", "true_color": _tc(col)})
            e.set_placement(T(p.pos), align=_ALIGN[(p.align, p.valign)])
            return
        pen = resolve_pen(p.pen, owner)
        attrs["lineweight"] = _lw(pen.width)
        if pen.color != owner.color or not block:
            attrs["true_color"] = _tc(pen.color)
        lt = _linetype(pen.dash)
        if lt != "CONTINUOUS":
            attrs["linetype"] = lt
        if isinstance(p, Arc):
            ext = (p.a1 - p.a0) % 360.0 or 360.0
            lay.add_arc(T(p.c), p.r * k, p.a0, p.a0 + ext, dxfattribs=attrs)
            return
        fill = resolve_fill(p.fill, owner)
        if isinstance(p, Circle):
            if fill is not None:
                pts = [
                    T((p.c[0] + p.r * math.cos(a / 16 * math.pi), p.c[1] + p.r * math.sin(a / 16 * math.pi))) for a in range(32)
                ]
                hc = lay.add_hatch(dxfattribs={"layer": attrs["layer"], "true_color": _tc(fill)})
                hc.paths.add_polyline_path(pts, is_closed=True)
            if p.stroke:
                lay.add_circle(T(p.c), p.r * k, dxfattribs=attrs)
            return
        if len(p.pts) < 2:
            return
        if fill is not None:
            hp = lay.add_hatch(dxfattribs={"layer": attrs["layer"], "true_color": _tc(fill)})
            hp.paths.add_polyline_path([T(q) for q in p.pts], is_closed=True, flags=1)
            for hole in p.holes:
                hp.paths.add_polyline_path([T(q) for q in hole], is_closed=True, flags=0)
        if p.stroke:
            for ring in [p.pts, *p.holes]:
                lay.add_lwpolyline([T(q) for q in ring], close=p.closed or bool(p.holes), dxfattribs=attrs)

    def block_for(self, ref: SymbolRef) -> str:
        key = repr([(type(p).__name__, _round(p)) for p in ref.local])
        name = "SYN_" + ref.style_id.replace("/", "_").upper() + "_" + hashlib.sha256(key.encode()).hexdigest()[:6].upper()
        if name not in self.blocks:
            blk = self.doc.blocks.new(name)
            for p in ref.local:
                self.prim(blk, p, ref.pen, ref.layer, k=1.0, flip=True, block=True)
            self.blocks[name] = name
        return name

    def symbol(self, ref: SymbolRef) -> str | None:
        has_text = any(isinstance(p, Text) for p in ref.local)
        rot_ok = abs(((ref.rot + 180.0) % 360.0) - 180.0) < 1e-6
        if ref.exploded or (has_text and (ref.mirror or not rot_ok)):
            for p in expand(ref):
                self.prim(self.msp, p, ref.pen, ref.layer, k=self.S, flip=True, block=False)
            return None
        name = self.block_for(ref)
        self.msp.add_blockref(
            name,
            self.P(ref.insert),
            dxfattribs={
                "layer": ref.layer,
                "xscale": -self.S if ref.mirror else self.S,
                "yscale": self.S,
                "rotation": ref.rot % 360.0,
                "true_color": _tc(ref.pen.color),
                "lineweight": _lw(ref.pen.width),
            },
        )
        return name


def _round(p: Prim) -> object:
    if isinstance(p, Poly):
        return [(round(x, 4), round(y, 4)) for x, y in p.pts], p.closed, p.fill, p.pen.width if p.pen else None
    if isinstance(p, Circle):
        return round(p.c[0], 4), round(p.c[1], 4), round(p.r, 4), p.fill
    if isinstance(p, Arc):
        return round(p.c[0], 4), round(p.c[1], 4), round(p.r, 4), round(p.a0, 3), round(p.a1, 3)
    return p.text, round(p.pos[0], 4), round(p.pos[1], 4), round(p.h, 4)


def render_dxf(scene: Scene, path: Path, scale: int, sheet_id: str) -> dict[str, str | None]:
    """Write the DXF; returns {symbol gid: block name or None (exploded)} for the GT."""
    w = _Writer(scene, scale, sheet_id)
    out: dict[str, str | None] = {}
    for it in scene.items:
        if isinstance(it, Item):
            w.prim(w.msp, it.prim, it.pen, it.layer, k=w.S, flip=True, block=False)
        else:
            name = w.symbol(it)
            if it.gid:
                out[it.gid] = name
    # ezdxf stamps $TDUPDATE / GUIDs on save; fixed metadata keeps the file byte-identical for a given seed
    prev = ezdxf.options.write_fixed_meta_data_for_testing
    ezdxf.options.write_fixed_meta_data_for_testing = True
    try:
        w.doc.saveas(path)
    finally:
        ezdxf.options.write_fixed_meta_data_for_testing = prev
    return out
