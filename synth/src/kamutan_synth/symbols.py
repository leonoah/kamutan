"""Symbol style catalogue: several drawing styles per fine class, redrawn by us.

The styles are inspired by the vocabulary of Israeli electrical / lighting / plumbing sheets (dome sockets with a
stem, filled power sockets, bracket + BEZEK/TV/TEL comms points, IEC switch levers with ticks, circled-cross
luminaires, to-scale sanitary fixtures). Nothing is traced or copied from images.

Local frame of a style: y UP (math), wall-anchored symbols have the wall face on ``y = 0`` and extend into the room
(``y > 0``); centre symbols are centred on the origin. ``u`` = nominal symbol size in paper mm (or paper mm per metre
for fixtures drawn to scale). :func:`build` returns primitives in the y-DOWN local frame used by ``scene``.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass, field

from .scene import INK, Arc, Circle, Pen, Poly, Prim, Text

Pt = tuple[float, float]


@dataclass
class B:
    """Primitive builder in y-up local units (scaled by ``u``)."""

    u: float
    lw: float
    out: list[Prim] = field(default_factory=list)

    def _p(self, x: float, y: float) -> Pt:
        return (x * self.u, -y * self.u)

    def thin(self, f: float = 0.6) -> Pen:
        return Pen(INK, self.lw * f)

    def line(self, *pts: Pt, pen: Pen | None = None) -> None:
        self.out.append(Poly([self._p(*p) for p in pts], False, pen))

    def poly(self, *pts: Pt, pen: Pen | None = None) -> None:
        self.out.append(Poly([self._p(*p) for p in pts], True, pen))

    def fill(self, *pts: Pt) -> None:
        self.out.append(Poly([self._p(*p) for p in pts], True, None, INK))

    def rect(self, x0: float, y0: float, x1: float, y1: float, *, fill: bool = False, pen: Pen | None = None) -> None:
        pts = [self._p(x0, y0), self._p(x1, y0), self._p(x1, y1), self._p(x0, y1)]
        self.out.append(Poly(pts, True, pen, INK if fill else None))

    def circle(self, x: float, y: float, r: float, *, fill: bool = False, pen: Pen | None = None) -> None:
        self.out.append(Circle(self._p(x, y), r * self.u, pen, INK if fill else None))

    def arc(self, x: float, y: float, r: float, a0: float, a1: float, pen: Pen | None = None) -> None:
        self.out.append(Arc(self._p(x, y), r * self.u, a0, a1, pen))

    def half_disc(self, x: float, y: float, r: float, a0: float = 0.0) -> None:
        pts = [
            (x + r * math.cos(math.radians(a0 + 180 * i / 12)), y + r * math.sin(math.radians(a0 + 180 * i / 12)))
            for i in range(13)
        ]
        self.fill(*pts)

    def ellipse(
        self, x: float, y: float, rx: float, ry: float, a0: float = 0.0, a1: float = 360.0, *, closed: bool = True
    ) -> None:
        n = 24
        pts = [
            (x + rx * math.cos(math.radians(a0 + (a1 - a0) * i / n)), y + ry * math.sin(math.radians(a0 + (a1 - a0) * i / n)))
            for i in range(n + 1)
        ]
        if closed and a1 - a0 >= 360:
            self.poly(*pts[:-1])
        else:
            self.line(*pts)

    def text(self, s: str, x: float, y: float, h: float, align: str = "c", valign: str = "m") -> None:
        self.out.append(Text(s, self._p(x, y), h * self.u, 0.0, align, valign, None, None, "symbol_text"))


Draw = Callable[[B, dict[str, object]], None]


@dataclass(frozen=True)
class Style:
    fine: str
    sid: str  # e.g. "socket_single/s2"
    draw: Draw
    symmetric: bool = True  # mirror-invariant (a mirrored INSERT looks the same)


STYLES: dict[str, list[Style]] = {}


def style(fine: str, name: str, *, symmetric: bool = True) -> Callable[[Draw], Draw]:
    def deco(fn: Draw) -> Draw:
        STYLES.setdefault(fine, []).append(Style(fine, f"{fine}/{name}", fn, symmetric))
        return fn

    return deco


# ============================================================================================ sockets
def _dome(b: B, x: float = 0.0, r: float = 0.36, base: float = 0.22, *, stem: bool = True, filled: bool = False) -> None:
    if filled:
        b.half_disc(x, base, r)
    else:
        b.arc(x, base, r, 0, 180)
        b.line((x - r, base), (x + r, base))
    if stem:
        b.line((x, 0), (x, base))


def _circle_prongs(b: B, x: float = 0.0, *, filled: bool = False) -> None:
    b.circle(x, 0.52, 0.3, fill=filled)
    b.line((x - 0.1, 0.22), (x - 0.1, 0.0))
    b.line((x + 0.1, 0.22), (x + 0.1, 0.0))


def _bar_dome(b: B, x: float = 0.0, *, filled: bool = False) -> None:
    if filled:
        b.half_disc(x, 0.12, 0.34)
    else:
        b.arc(x, 0.12, 0.34, 0, 180)
    b.line((x - 0.5, 0.12), (x + 0.5, 0.12))
    b.line((x, 0.0), (x, 0.12))


@style("socket_single", "s1")
def _ss1(b: B, p: dict[str, object]) -> None:
    _dome(b)


@style("socket_single", "s2")
def _ss2(b: B, p: dict[str, object]) -> None:
    _circle_prongs(b)


@style("socket_single", "s3")
def _ss3(b: B, p: dict[str, object]) -> None:
    _bar_dome(b)


@style("socket_double", "s1")
def _sd1(b: B, p: dict[str, object]) -> None:
    for x in (-0.3, 0.3):
        b.arc(x, 0.22, 0.28, 0, 180)
    b.line((-0.58, 0.22), (0.58, 0.22))
    b.line((0, 0), (0, 0.22))


@style("socket_double", "s2")
def _sd2(b: B, p: dict[str, object]) -> None:
    _dome(b, r=0.38)
    b.arc(0, 0.22, 0.24, 0, 180)


@style("socket_double", "s3")
def _sd3(b: B, p: dict[str, object]) -> None:
    _bar_dome(b)
    b.line((-0.12, 0.3), (-0.12, 0.42))
    b.line((0.12, 0.3), (0.12, 0.42))


@style("socket_triple", "s1")
def _st1(b: B, p: dict[str, object]) -> None:
    for x in (-0.5, 0.0, 0.5):
        b.arc(x, 0.22, 0.24, 0, 180)
    b.line((-0.74, 0.22), (0.74, 0.22))
    b.line((0, 0), (0, 0.22))


@style("socket_triple", "s2")
def _st2(b: B, p: dict[str, object]) -> None:
    _dome(b, r=0.4)
    b.text("3", 0.0, 0.4, 0.3)


@style("socket_power", "s1")
def _sp1(b: B, p: dict[str, object]) -> None:
    _dome(b, filled=True)


@style("socket_power", "s2")
def _sp2(b: B, p: dict[str, object]) -> None:
    _circle_prongs(b, filled=True)


@style("socket_power", "s3")
def _sp3(b: B, p: dict[str, object]) -> None:
    _bar_dome(b, filled=True)


@style("socket_waterproof", "s1", symmetric=False)
def _sw1(b: B, p: dict[str, object]) -> None:
    _dome(b)
    b.fill((0.5, 0.05), (0.8, 0.05), (0.65, 0.35))


@style("socket_waterproof", "s2")
def _sw2(b: B, p: dict[str, object]) -> None:
    _dome(b)
    b.text("IP", 0.0, 0.85, 0.28)


@style("socket_waterproof", "s3")
def _sw3(b: B, p: dict[str, object]) -> None:
    _circle_prongs(b)
    b.line((-0.2, 0.52), (0.2, 0.52))
    b.line((0, 0.32), (0, 0.72))


@style("socket_3phase", "s1")
def _s3p1(b: B, p: dict[str, object]) -> None:
    _dome(b, r=0.4)
    for dx in (-0.16, 0.0, 0.16):
        b.line((dx - 0.07, 0.3), (dx + 0.07, 0.52))


@style("socket_3phase", "s2")
def _s3p2(b: B, p: dict[str, object]) -> None:
    _dome(b, r=0.4, filled=True)
    b.text("3P", 0.0, 0.9, 0.26)


@style("socket_3phase", "s3")
def _s3p3(b: B, p: dict[str, object]) -> None:
    _circle_prongs(b)
    for dx in (-0.12, 0.0, 0.12):
        b.line((dx - 0.05, 0.42), (dx + 0.05, 0.62))


@style("socket_ac", "s1")
def _sac1(b: B, p: dict[str, object]) -> None:
    b.rect(-0.36, 0.0, 0.36, 0.5)
    b.text("AC", 0.0, 0.25, 0.26)


@style("socket_ac", "s2")
def _sac2(b: B, p: dict[str, object]) -> None:
    b.circle(0.0, 0.5, 0.32)
    b.line((0, 0), (0, 0.18))
    b.text("M", 0.0, 0.5, 0.3)


@style("socket_ac", "s3")
def _sac3(b: B, p: dict[str, object]) -> None:
    _dome(b, filled=True)
    b.rect(-0.4, 0.66, 0.4, 0.9, pen=b.thin())
    b.line((-0.4, 0.66), (0.4, 0.9), pen=b.thin())


# ============================================================================================ low voltage
def _tee(b: B, label: str, *, side: bool = True) -> None:
    b.line((0, 0), (0, 0.42))
    b.line((-0.3, 0.42), (0.3, 0.42))
    if side:
        b.text(label, 0.42, 0.42, 0.26, align="l")
    else:
        b.text(label, 0.0, 0.72, 0.26)


def _tri(b: B, label: str, *, filled: bool = False) -> None:
    if filled:
        b.fill((-0.32, 0.0), (0.32, 0.0), (0.0, 0.5))
    else:
        b.poly((-0.32, 0.0), (0.32, 0.0), (0.0, 0.5))
    b.text(label, 0.0, 0.78, 0.26)


def _boxed(b: B, label: str) -> None:
    b.rect(-0.34, 0.0, 0.34, 0.5)
    b.text(label, 0.0, 0.25, 0.24)


for _fine, _lbl, _tl in (("data_point", "D", "D"), ("phone_point", "TEL", "T"), ("tv_point", "TV", "TV")):

    def _mk(lbl: str, tl: str, fine: str) -> None:
        @style(fine, "s1", symmetric=False)
        def _a(b: B, p: dict[str, object]) -> None:
            _tee(b, lbl)

        @style(fine, "s2")
        def _b(b: B, p: dict[str, object]) -> None:
            _tri(b, tl, filled=fine == "phone_point")

        @style(fine, "s3")
        def _c(b: B, p: dict[str, object]) -> None:
            _boxed(b, tl)

    _mk(_lbl, _tl, _fine)


@style("intercom", "s1")
def _ic1(b: B, p: dict[str, object]) -> None:
    b.rect(-0.3, 0.0, 0.3, 0.6)
    b.circle(0.0, 0.3, 0.16)
    b.circle(0.0, 0.3, 0.05, fill=True)


@style("intercom", "s2")
def _ic2(b: B, p: dict[str, object]) -> None:
    b.rect(-0.42, 0.0, 0.42, 0.42)
    b.text("INT", 0.0, 0.21, 0.22)


@style("speaker", "s1")
def _spk1(b: B, p: dict[str, object]) -> None:
    b.rect(-0.3, -0.15, -0.1, 0.15)
    b.poly((-0.1, -0.15), (0.25, -0.38), (0.25, 0.38), (-0.1, 0.15))


@style("speaker", "s2")
def _spk2(b: B, p: dict[str, object]) -> None:
    b.circle(0, 0, 0.38)
    b.text("S", 0.0, 0.0, 0.34)


@style("speaker", "s3")
def _spk3(b: B, p: dict[str, object]) -> None:
    b.circle(0, 0, 0.36)
    b.circle(0, 0, 0.16)


@style("panel", "s1")
def _pn1(b: B, p: dict[str, object]) -> None:
    b.rect(-0.9, 0.0, 0.9, 0.42)
    b.fill((-0.9, 0.0), (0.9, 0.42), (-0.9, 0.42))


@style("panel", "s2")
def _pn2(b: B, p: dict[str, object]) -> None:
    b.rect(-0.8, 0.0, 0.8, 0.45)
    for i in range(1, 8):
        x = -0.8 + i * 0.2
        b.line((x, 0.0), (x - 0.12, 0.45), pen=b.thin())


@style("panel", "s3", symmetric=False)
def _pn3(b: B, p: dict[str, object]) -> None:
    b.rect(-0.8, 0.0, 0.8, 0.4)
    b.line((-0.7, 0.08), (-0.2, 0.32), (0.2, 0.08), (0.7, 0.32))
    b.fill((0.55, 0.32), (0.7, 0.32), (0.66, 0.2))


@style("junction_box", "s1")
def _jb1(b: B, p: dict[str, object]) -> None:
    b.rect(-0.22, 0.0, 0.22, 0.44)
    b.line((-0.22, 0.0), (0.22, 0.44))
    b.line((0.22, 0.0), (-0.22, 0.44))


@style("junction_box", "s2")
def _jb2(b: B, p: dict[str, object]) -> None:
    b.circle(0.0, 0.3, 0.24)
    b.circle(0.0, 0.3, 0.08, fill=True)
    b.line((0, 0), (0, 0.06))


@style("conduit_cobra", "s1", symmetric=False)
def _cb1(b: B, p: dict[str, object]) -> None:
    b.circle(0.0, 0.12, 0.12, fill=True)
    b.arc(0.6, 0.12, 0.6, 90, 180)
    b.arc(0.6, 1.32, 0.6, 270, 360)
    b.fill((1.2, 1.32), (1.08, 1.12), (1.32, 1.12))


@style("conduit_cobra", "s2", symmetric=False)
def _cb2(b: B, p: dict[str, object]) -> None:
    b.circle(0.0, 0.14, 0.14)
    b.line((0.0, 0.28), (0.0, 0.7), (0.5, 1.0), (1.0, 0.7), (1.4, 1.0))


# ============================================================================================ switches
def _lever(b: B, cx: float, cy: float, ang: float, ticks: int, length: float = 0.55) -> None:
    a = math.radians(ang)
    r = 0.12
    sx, sy = cx + r * math.cos(a), cy + r * math.sin(a)
    ex, ey = cx + length * math.cos(a), cy + length * math.sin(a)
    b.line((sx, sy), (ex, ey))
    px, py = math.cos(a - math.pi / 2), math.sin(a - math.pi / 2)
    for i in range(ticks):
        tx, ty = ex - i * 0.12 * math.cos(a), ey - i * 0.12 * math.sin(a)
        b.line((tx, ty), (tx + 0.16 * px, ty + 0.16 * py))


def _sw(b: B, ticks: int, kind: str) -> None:
    cx, cy = 0.0, 0.26
    if kind == "s1":
        b.circle(cx, cy, 0.12)
        _lever(b, cx, cy, 55, ticks)
    elif kind == "s2":
        b.circle(cx, cy, 0.12, fill=True)
        _lever(b, cx, cy, 55, ticks)
    else:
        b.line((0, 0), (0, 0.14))
        b.circle(cx, cy, 0.12, fill=True)
        _lever(b, cx, cy, 90, ticks, 0.6)


for _n, _fine in ((1, "switch_single"), (2, "switch_2gang"), (3, "switch_3gang")):
    for _k in ("s1", "s2", "s3"):

        def _mks(n: int, k: str, fine: str) -> None:
            @style(fine, k, symmetric=k == "s3")
            def _f(b: B, p: dict[str, object]) -> None:
                _sw(b, n, k)

        _mks(_n, _k, _fine)


@style("switch_2way", "s1")
def _w2a(b: B, p: dict[str, object]) -> None:
    b.circle(0.0, 0.4, 0.12)
    _lever(b, 0.0, 0.4, 55, 1)
    _lever(b, 0.0, 0.4, 235, 1, 0.4)


@style("switch_2way", "s2")
def _w2b(b: B, p: dict[str, object]) -> None:
    b.circle(0.0, 0.3, 0.12, fill=True)
    _lever(b, 0.0, 0.3, 45, 1)
    _lever(b, 0.0, 0.3, 135, 1)


@style("switch_2way", "s3", symmetric=False)
def _w2c(b: B, p: dict[str, object]) -> None:
    b.circle(0.0, 0.3, 0.14)
    b.line((-0.1, 0.2), (0.1, 0.4))
    _lever(b, 0.0, 0.3, 60, 1)
    _lever(b, 0.0, 0.3, 120, 1)


@style("switch_shutter", "s1")
def _sh1(b: B, p: dict[str, object]) -> None:
    b.circle(0.0, 0.42, 0.3)
    b.line((-0.14, 0.28), (-0.14, 0.56), (0.14, 0.56), (0.14, 0.28))


@style("switch_shutter", "s2")
def _sh2(b: B, p: dict[str, object]) -> None:
    b.rect(-0.3, 0.0, 0.3, 0.6)
    b.fill((-0.14, 0.34), (0.14, 0.34), (0.0, 0.52))
    b.fill((-0.14, 0.26), (0.14, 0.26), (0.0, 0.08))


@style("switch_shutter", "s3", symmetric=False)
def _sh3(b: B, p: dict[str, object]) -> None:
    b.circle(0.0, 0.26, 0.12, fill=True)
    _lever(b, 0.0, 0.26, 55, 1)
    b.text("T", 0.34, 0.2, 0.26, align="l")


# ============================================================================================ luminaires
@style("luminaire_ceiling", "s1")
def _lc1(b: B, p: dict[str, object]) -> None:
    b.circle(0, 0, 0.5)
    d = 0.5 * math.sqrt(0.5)
    b.line((-d, -d), (d, d))
    b.line((-d, d), (d, -d))


@style("luminaire_ceiling", "s2")
def _lc2(b: B, p: dict[str, object]) -> None:
    b.circle(0, 0, 0.42)
    b.line((-0.68, 0), (0.68, 0))
    b.line((0, -0.68), (0, 0.68))


@style("luminaire_ceiling", "s3")
def _lc3(b: B, p: dict[str, object]) -> None:
    b.circle(0, 0, 0.45)
    b.circle(0, 0, 0.18, fill=True)


@style("luminaire_recessed", "s1")
def _lr1(b: B, p: dict[str, object]) -> None:
    b.circle(0, 0, 0.3)
    b.circle(0, 0, 0.08, fill=True)


@style("luminaire_recessed", "s2")
def _lr2(b: B, p: dict[str, object]) -> None:
    b.rect(-0.3, -0.3, 0.3, 0.3)
    b.circle(0, 0, 0.2)


@style("luminaire_recessed", "s3")
def _lr3(b: B, p: dict[str, object]) -> None:
    b.circle(0, 0, 0.3)
    b.half_disc(0, 0, 0.3, 0.0)


@style("luminaire_wall", "s1")
def _lw1(b: B, p: dict[str, object]) -> None:
    b.arc(0, 0.08, 0.45, 0, 180)
    b.line((-0.45, 0.08), (0.45, 0.08))
    d = 0.45 * math.sqrt(0.5)
    b.line((-d, 0.08 + d), (0.0, 0.08))
    b.line((d, 0.08 + d), (0.0, 0.08))


@style("luminaire_wall", "s2")
def _lw2(b: B, p: dict[str, object]) -> None:
    b.line((0, 0), (0, 0.2))
    b.circle(0, 0.55, 0.35)
    d = 0.35 * math.sqrt(0.5)
    b.line((-d, 0.55 - d), (d, 0.55 + d))
    b.line((-d, 0.55 + d), (d, 0.55 - d))


@style("luminaire_wall", "s3")
def _lw3(b: B, p: dict[str, object]) -> None:
    b.half_disc(0, 0.06, 0.4)
    b.line((-0.55, 0.06), (0.55, 0.06))


@style("luminaire_pendant", "s1")
def _lp1(b: B, p: dict[str, object]) -> None:
    b.circle(0, 0, 0.55)
    b.circle(0, 0, 0.22)
    d = 0.55 * math.sqrt(0.5)
    b.line((-d, -d), (d, d))
    b.line((-d, d), (d, -d))


@style("luminaire_pendant", "s2")
def _lp2(b: B, p: dict[str, object]) -> None:
    b.circle(0, 0, 0.5)
    b.poly((0, 0.34), (0.3, -0.18), (-0.3, -0.18))


@style("luminaire_pendant", "s3")
def _lp3(b: B, p: dict[str, object]) -> None:
    b.circle(0, 0, 0.5)
    b.circle(0, 0, 0.32)
    b.circle(0, 0, 0.07, fill=True)


@style("luminaire_strip", "s1")
def _ls1(b: B, p: dict[str, object]) -> None:
    half = float(p.get("length", 4.0)) / 2  # type: ignore[arg-type]
    b.rect(-half, 0.08, half, 0.3)
    n = max(2, int(half * 2 / 0.6))
    for i in range(1, n):
        x = -half + i * 2 * half / n
        b.line((x, 0.08), (x, 0.3), pen=b.thin())


@style("luminaire_strip", "s2")
def _ls2(b: B, p: dict[str, object]) -> None:
    half = float(p.get("length", 4.0)) / 2  # type: ignore[arg-type]
    b.line((-half, 0.2), (half, 0.2), pen=Pen(INK, b.lw * 2.4))
    b.circle(-half, 0.2, 0.1, fill=True)
    b.circle(half, 0.2, 0.1, fill=True)


@style("luminaire_strip", "s3")
def _ls3(b: B, p: dict[str, object]) -> None:
    half = float(p.get("length", 4.0)) / 2  # type: ignore[arg-type]
    b.line((-half, 0.2), (half, 0.2), pen=Pen(INK, b.lw, (1.2, 0.6)))
    b.line((-half, 0.06), (-half, 0.34))
    b.line((half, 0.06), (half, 0.34))


@style("ceiling_fan", "s1")
def _cf1(b: B, p: dict[str, object]) -> None:
    b.circle(0, 0, 0.14)
    for k in range(3):
        a = math.radians(90 + 120 * k)
        c, s = math.cos(a), math.sin(a)
        pts = [(0.18 * c - 0.1 * s, 0.18 * s + 0.1 * c), (0.75 * c - 0.14 * s, 0.75 * s + 0.14 * c), (0.8 * c, 0.8 * s)]
        pts += [(0.75 * c + 0.14 * s, 0.75 * s - 0.14 * c), (0.18 * c + 0.1 * s, 0.18 * s - 0.1 * c)]
        b.poly(*pts)


@style("ceiling_fan", "s2")
def _cf2(b: B, p: dict[str, object]) -> None:
    b.circle(0, 0, 0.55)
    b.arc(-0.2, 0, 0.2, 0, 180)
    b.arc(0.2, 0, 0.2, 180, 360)
    b.line((-0.55, 0), (-0.4, 0))
    b.line((0.4, 0), (0.55, 0))


# ============================================================================================ plumbing
# drawn to scale: u = paper mm per metre; local units are metres


@style("fixture_wc_monoblock", "s1")
def _wm1(b: B, p: dict[str, object]) -> None:
    b.rect(-0.22, 0.0, 0.22, 0.18)
    b.ellipse(0.0, 0.46, 0.18, 0.26)
    b.ellipse(0.0, 0.46, 0.12, 0.18)


@style("fixture_wc_monoblock", "s2")
def _wm2(b: B, p: dict[str, object]) -> None:
    b.rect(-0.2, 0.02, 0.2, 0.2)
    b.line((-0.17, 0.2), (-0.17, 0.42))
    b.line((0.17, 0.2), (0.17, 0.42))
    b.arc(0.0, 0.42, 0.17, 0, 180)


@style("fixture_wc_concealed", "s1")
def _wc1(b: B, p: dict[str, object]) -> None:
    b.rect(-0.25, -0.12, 0.25, 0.0, pen=Pen(INK, b.lw * 0.6, (1.0, 0.6)))
    b.ellipse(0.0, 0.3, 0.18, 0.28)
    b.ellipse(0.0, 0.32, 0.11, 0.18)


@style("fixture_wc_concealed", "s2")
def _wc2(b: B, p: dict[str, object]) -> None:
    b.rect(-0.18, 0.0, 0.18, 0.06)
    b.line((-0.16, 0.06), (-0.16, 0.3))
    b.line((0.16, 0.06), (0.16, 0.3))
    b.arc(0.0, 0.3, 0.16, 0, 180)
    b.circle(0.0, 0.3, 0.05)


@style("fixture_basin", "s1")
def _ba1(b: B, p: dict[str, object]) -> None:
    b.rect(-0.28, 0.0, 0.28, 0.44)
    b.ellipse(0.0, 0.24, 0.2, 0.14)
    b.circle(0.0, 0.08, 0.025, fill=True)


@style("fixture_basin", "s2")
def _ba2(b: B, p: dict[str, object]) -> None:
    b.line((-0.26, 0.0), (0.26, 0.0))
    b.ellipse(0.0, 0.0, 0.26, 0.4, 0, 180, closed=False)
    b.ellipse(0.0, 0.02, 0.18, 0.28, 0, 180, closed=False)
    b.circle(0.0, 0.16, 0.03)


@style("fixture_shower", "s1")
def _sh_1(b: B, p: dict[str, object]) -> None:
    s = float(p.get("size", 0.9))  # type: ignore[arg-type]
    b.rect(-s / 2, 0.0, s / 2, s)
    b.line((-s / 2, 0.0), (s / 2, s), pen=b.thin())
    b.line((s / 2, 0.0), (-s / 2, s), pen=b.thin())
    b.circle(0.0, s / 2, 0.05)


@style("fixture_shower", "s2")
def _sh_2(b: B, p: dict[str, object]) -> None:
    s = float(p.get("size", 0.9))  # type: ignore[arg-type]
    b.rect(-s / 2, 0.0, s / 2, s)
    b.rect(-s / 2 + 0.05, 0.05, s / 2 - 0.05, s - 0.05, pen=b.thin())
    b.circle(0.0, s / 2, 0.05)
    b.line((-0.04, s / 2), (0.04, s / 2), pen=b.thin())
    b.circle(-s / 2 + 0.12, 0.1, 0.06, fill=True)


@style("fixture_bath", "s1")
def _bt1(b: B, p: dict[str, object]) -> None:
    L = float(p.get("length", 1.6))  # type: ignore[arg-type]
    b.rect(-L / 2, 0.0, L / 2, 0.72)
    b.rect(-L / 2 + 0.08, 0.08, L / 2 - 0.08, 0.64, pen=b.thin())
    b.circle(-L / 2 + 0.22, 0.36, 0.04)


@style("fixture_bath", "s2")
def _bt2(b: B, p: dict[str, object]) -> None:
    L = float(p.get("length", 1.6))  # type: ignore[arg-type]
    b.rect(-L / 2, 0.0, L / 2, 0.72)
    b.ellipse(0.05, 0.36, L / 2 - 0.16, 0.26)
    b.circle(-L / 2 + 0.22, 0.36, 0.04)


@style("fixture_kitchen_sink", "s1")
def _ks1(b: B, p: dict[str, object]) -> None:
    b.rect(-0.42, 0.04, 0.42, 0.52)
    b.rect(-0.38, 0.1, -0.03, 0.46, pen=b.thin())
    b.rect(0.03, 0.1, 0.38, 0.46, pen=b.thin())
    b.circle(-0.2, 0.28, 0.03)
    b.circle(0.2, 0.28, 0.03)


@style("fixture_kitchen_sink", "s2")
def _ks2(b: B, p: dict[str, object]) -> None:
    b.rect(-0.5, 0.04, 0.5, 0.52)
    b.rect(-0.45, 0.1, 0.0, 0.46, pen=b.thin())
    for i in range(1, 5):
        x = 0.05 + i * 0.08
        b.line((x, 0.12), (x, 0.44), pen=b.thin())
    b.circle(-0.22, 0.28, 0.03)


@style("fixture_washing_machine", "s1")
def _wmc1(b: B, p: dict[str, object]) -> None:
    b.rect(-0.3, 0.0, 0.3, 0.6)
    b.circle(0.0, 0.32, 0.2)


@style("fixture_washing_machine", "s2")
def _wmc2(b: B, p: dict[str, object]) -> None:
    b.rect(-0.3, 0.0, 0.3, 0.6)
    b.line((-0.3, 0.5), (0.3, 0.5), pen=b.thin())
    b.circle(0.0, 0.25, 0.16)
    b.circle(0.0, 0.25, 0.1)


@style("floor_drain", "s1")
def _fd1(b: B, p: dict[str, object]) -> None:
    b.circle(0, 0, 0.4)
    b.line((-0.28, -0.28), (0.28, 0.28))
    b.line((-0.28, 0.28), (0.28, -0.28))


@style("floor_drain", "s2")
def _fd2(b: B, p: dict[str, object]) -> None:
    b.rect(-0.38, -0.38, 0.38, 0.38)
    b.circle(0, 0, 0.24)
    for y in (-0.1, 0.0, 0.1):
        b.line((-0.2, y), (0.2, y), pen=b.thin())


@style("floor_drain", "s3")
def _fd3(b: B, p: dict[str, object]) -> None:
    b.circle(0, 0, 0.36, fill=True)
    b.circle(0, 0, 0.5)


@style("water_point_hot", "s1")
def _wh1(b: B, p: dict[str, object]) -> None:
    b.circle(0.0, 0.4, 0.3, fill=True)
    b.line((0, 0), (0, 0.1))
    b.text("ח", 0.0, 1.0, 0.4)


@style("water_point_hot", "s2")
def _wh2(b: B, p: dict[str, object]) -> None:
    b.circle(0.0, 0.4, 0.3)
    b.half_disc(0.0, 0.4, 0.3, 180.0)
    b.text("HW", 0.0, 1.0, 0.32)


@style("water_point_cold", "s1")
def _wcp1(b: B, p: dict[str, object]) -> None:
    b.circle(0.0, 0.4, 0.3)
    b.line((0, 0), (0, 0.1))
    b.text("ק", 0.0, 1.0, 0.4)


@style("water_point_cold", "s2")
def _wcp2(b: B, p: dict[str, object]) -> None:
    b.circle(0.0, 0.4, 0.3)
    b.line((-0.3, 0.4), (0.3, 0.4))
    b.text("CW", 0.0, 1.0, 0.32)


def styles_for(fine: str) -> list[Style]:
    return STYLES[fine]


def get_style(sid: str) -> Style:
    fine = sid.split("/", 1)[0]
    for s in STYLES[fine]:
        if s.sid == sid:
            return s
    raise KeyError(sid)


def build(sid: str, u: float, lw: float, params: dict[str, object] | None = None) -> list[Prim]:
    b = B(u, lw)
    get_style(sid).draw(b, params or {})
    return b.out
