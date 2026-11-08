"""Display list in paper millimetres (origin top-left, y DOWN), shared by the PDF / DXF renderers and the GT.

Angles are *visual* counter-clockwise degrees (as seen on paper). In y-down coordinates a visual CCW rotation by
``t`` maps ``(x, y)`` to ``(x cos t + y sin t, -x sin t + y cos t)``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from .text import FontSpec, text_corners, text_width, to_visual

Pt = tuple[float, float]
RGB = tuple[int, int, int]
INK: RGB = (-1, -1, -1)  # "use the owner's pen colour" (symbol prims)
BLACK: RGB = (0, 0, 0)


@dataclass(slots=True)
class Pen:
    color: RGB = BLACK
    width: float = 0.25  # mm
    dash: tuple[float, ...] | None = None  # mm pattern


@dataclass(slots=True)
class Poly:
    pts: list[Pt]
    closed: bool = False
    pen: Pen | None = None  # None = owner's pen; Pen(width=0) never happens (use stroke=False)
    fill: RGB | None = None
    stroke: bool = True
    holes: list[list[Pt]] = field(default_factory=list)


@dataclass(slots=True)
class Circle:
    c: Pt
    r: float
    pen: Pen | None = None
    fill: RGB | None = None
    stroke: bool = True


@dataclass(slots=True)
class Arc:
    c: Pt
    r: float
    a0: float  # visual CCW degrees; the arc runs a0 -> a1 counter-clockwise
    a1: float
    pen: Pen | None = None


@dataclass(slots=True)
class Text:
    text: str  # logical order
    pos: Pt
    h: float  # cap height mm
    angle: float = 0.0
    align: str = "l"  # l | c | r
    valign: str = "b"  # b | m | t
    color: RGB | None = None  # None = owner's colour
    font: FontSpec | None = None  # None = sheet font
    role: str = "label"


Prim = Poly | Circle | Arc | Text


@dataclass(slots=True)
class Item:
    prim: Prim
    layer: str
    pen: Pen  # owner pen (resolves None / INK)


@dataclass(slots=True)
class SymbolRef:
    gid: str  # GT feature id (or legend row id)
    style_id: str
    local: list[Prim]
    insert: Pt
    rot: float
    mirror: bool
    layer: str
    pen: Pen
    exploded: bool = False  # DXF: draw the primitives instead of an INSERT
    role: str = "symbol"  # symbol | legend | context


# ----------------------------------------------------------------------------------------------- transforms
def rot_pt(p: Pt, deg: float) -> Pt:
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return (p[0] * c + p[1] * s, -p[0] * s + p[1] * c)


def xf_pt(p: Pt, insert: Pt, rot: float, mirror: bool, scale: float = 1.0) -> Pt:
    x, y = (-p[0] if mirror else p[0]) * scale, p[1] * scale
    rx, ry = rot_pt((x, y), rot)
    return (insert[0] + rx, insert[1] + ry)


def upright(angle: float) -> float:
    a = (angle + 180.0) % 360.0 - 180.0  # (-180, 180]
    if a > 90.0 + 1e-6:
        a -= 180.0
    elif a <= -90.0 + 1e-6:
        a += 180.0
    return a


def xf_prim(p: Prim, insert: Pt, rot: float, mirror: bool) -> Prim:
    """Local symbol primitive -> paper primitive. Text stays readable (never mirrored, kept upright)."""
    if isinstance(p, Poly):
        return Poly(
            [xf_pt(q, insert, rot, mirror) for q in p.pts],
            p.closed,
            p.pen,
            p.fill,
            p.stroke,
            [[xf_pt(q, insert, rot, mirror) for q in h] for h in p.holes],
        )
    if isinstance(p, Circle):
        return Circle(xf_pt(p.c, insert, rot, mirror), p.r, p.pen, p.fill, p.stroke)
    if isinstance(p, Arc):
        a0, a1 = (180.0 - p.a1, 180.0 - p.a0) if mirror else (p.a0, p.a1)
        return Arc(xf_pt(p.c, insert, rot, mirror), p.r, a0 + rot, a1 + rot, p.pen)
    ang = upright(p.angle + rot)
    return Text(p.text, xf_pt(p.pos, insert, rot, mirror), p.h, ang, p.align, p.valign, p.color, p.font, p.role)


def expand(ref: SymbolRef) -> list[Prim]:
    return [xf_prim(p, ref.insert, ref.rot, ref.mirror) for p in ref.local]


# ----------------------------------------------------------------------------------------------- bounding boxes
BBox = tuple[float, float, float, float]


def arc_points(c: Pt, r: float, a0: float, a1: float, step_deg: float = 10.0) -> list[Pt]:
    span = (a1 - a0) % 360.0 or 360.0
    n = max(2, math.ceil(span / step_deg) + 1)
    out = []
    for i in range(n):
        a = math.radians(a0 + span * i / (n - 1))
        out.append((c[0] + r * math.cos(a), c[1] - r * math.sin(a)))
    return out


def prim_points(p: Prim, font: FontSpec) -> list[Pt]:
    if isinstance(p, Poly):
        return list(p.pts)
    if isinstance(p, Circle):
        return [(p.c[0] - p.r, p.c[1] - p.r), (p.c[0] + p.r, p.c[1] + p.r)]
    if isinstance(p, Arc):
        return arc_points(p.c, p.r, p.a0, p.a1)
    f = p.font or font
    w = text_width(to_visual(p.text), p.h, f)
    return text_corners(p.pos, w, p.h, p.angle, p.align, p.valign)


def bbox_of(points: list[Pt]) -> BBox:
    xs = [q[0] for q in points]
    ys = [q[1] for q in points]
    return (min(xs), min(ys), max(xs), max(ys))


def prims_bbox(prims: list[Prim], font: FontSpec, *, ink_only: bool = False) -> BBox:
    pts: list[Pt] = []
    for p in prims:
        if ink_only and isinstance(p, Text):
            continue
        pts.extend(prim_points(p, font))
    if not pts:  # text-only symbol
        for p in prims:
            pts.extend(prim_points(p, font))
    return bbox_of(pts)


def bbox_union(a: BBox, b: BBox) -> BBox:
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


def bbox_overlap(a: BBox, b: BBox, pad: float = 0.0) -> bool:
    return a[0] - pad < b[2] and b[0] - pad < a[2] and a[1] - pad < b[3] and b[1] - pad < a[3]


def bbox_grow(a: BBox, d: float) -> BBox:
    return (a[0] - d, a[1] - d, a[2] + d, a[3] + d)


@dataclass
class Layer:
    name: str
    color: RGB
    lw: float


@dataclass
class Scene:
    width: float
    height: float
    font: FontSpec
    layers: dict[str, Layer] = field(default_factory=dict)
    items: list[Item | SymbolRef] = field(default_factory=list)

    def layer(self, name: str, color: RGB = BLACK, lw: float = 0.25) -> str:
        if name not in self.layers:
            self.layers[name] = Layer(name, color, lw)
        return name

    def add(self, prim: Prim, layer: str, pen: Pen | None = None) -> Prim:
        lay = self.layers[layer]
        self.items.append(Item(prim, layer, pen or Pen(lay.color, lay.lw)))
        return prim

    def add_symbol(self, ref: SymbolRef) -> SymbolRef:
        self.items.append(ref)
        return ref

    def flat(self) -> list[Item]:
        """Every primitive in paper coordinates with its owner pen (symbols expanded), in draw order."""
        out: list[Item] = []
        for it in self.items:
            if isinstance(it, Item):
                out.append(it)
            else:
                out.extend(Item(p, it.layer, it.pen) for p in expand(it))
        return out


def resolve_pen(p: Pen | None, owner: Pen) -> Pen:
    if p is None:
        return owner
    if p.color == INK:
        return Pen(owner.color, p.width, p.dash)
    return p


def resolve_fill(f: RGB | None, owner: Pen) -> RGB | None:
    if f == INK:
        return owner.color
    return f
