"""Floor-plan generator: rooms (treemap of a room programme), walls by kind, doors, windows, stairs, furniture.

Everything is in metres, x to the right and y DOWN (plan north up). ``Plan.scaled`` maps a plan to paper mm.
Rooms are axis-aligned rectangles that tile the footprint; walls are the rectangle edges (exterior / block /
gypsum / concrete around the ממ"ד) with real thickness; openings are cut from the walls.
"""

from __future__ import annotations

import itertools
import math
import random
from dataclasses import dataclass, field, replace

from shapely import box
from shapely.geometry import LineString, MultiPolygon, Polygon
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

Pt = tuple[float, float]
Rect = tuple[float, float, float, float]

ROOM_NAMES: dict[str, tuple[str, ...]] = {
    "living": ("סלון", "חדר מגורים", "סלון ופינת אוכל"),
    "family": ("חדר משפחה", "פינת טלוויזיה"),
    "kitchen": ("מטבח",),
    "master": ("חדר הורים", "חדר שינה הורים"),
    "bedroom": ("חדר שינה", "חדר ילדים", "חדר שינה 2", "חדר ילדים 1"),
    "mamad": ('ממ"ד',),
    "bath": ("חדר רחצה", "אמבטיה", "חדר אמבטיה"),
    "shower": ("מקלחת הורים", "חדר רחצה הורים"),
    "wc": ("שירותי אורחים", "שירותים", "ש. אורחים"),
    "laundry": ("חדר כביסה", "מרפסת שירות", "שירות"),
    "corridor": ("מסדרון", "פרוזדור"),
    "entry": ("מבואה", "כניסה"),
    "storage": ("מחסן", "ארון שירות"),
    "study": ("חדר עבודה", "חדר עבודה / אורחים"),
    "stairs": ("חדר מדרגות", "מדרגות"),
}

WET = {"bath", "shower", "wc", "laundry", "kitchen"}

# min short side (m), max aspect
MIN_SIDE = {
    "living": 3.4,
    "family": 3.0,
    "kitchen": 2.2,
    "master": 3.0,
    "bedroom": 2.6,
    "mamad": 2.4,
    "bath": 1.6,
    "shower": 1.5,
    "wc": 1.0,
    "laundry": 1.2,
    "corridor": 1.05,
    "entry": 1.4,
    "storage": 1.0,
    "study": 2.4,
    "stairs": 2.2,
}
MAX_ASPECT = {"corridor": 6.0, "stairs": 2.6, "storage": 3.0, "laundry": 3.0, "wc": 2.4}

WALL_PRIORITY = {"concrete": 4, "exterior": 3, "block": 2, "gypsum": 1}

# floor-2 relabelling of a house's ground-floor rooms (stacked rooms keep their rectangles)
UPPER_FLOOR = {
    "living": "family",
    "kitchen": "bedroom",
    "entry": "corridor",
    "wc": "bath",
    "laundry": "shower",
    "storage": "wc",
    "study": "bedroom",
    "corridor": "corridor",
    "mamad": "mamad",
    "stairs": "stairs",
    "master": "master",
    "bedroom": "bedroom",
    "bath": "bath",
    "shower": "laundry",
    "family": "family",
}


@dataclass
class Room:
    rid: str
    kind: str
    name: str
    rect: Rect  # wall centre lines
    net: Rect = (0.0, 0.0, 0.0, 0.0)  # inner faces (largest inscribed rectangle used for placement)
    poly: list[Pt] = field(default_factory=list)  # exact net polygon (GT area)
    area: float = 0.0  # m2 (plan units squared)


@dataclass
class Wall:
    wid: str
    kind: str
    t: float
    a: Pt
    b: Pt
    rooms: tuple[str, ...]

    @property
    def horizontal(self) -> bool:
        return abs(self.a[1] - self.b[1]) < 1e-9

    @property
    def length(self) -> float:
        return math.dist(self.a, self.b)


@dataclass
class Opening:
    oid: str
    kind: str  # door | entrance | opening | window
    wid: str
    c: Pt  # centre on the wall centre line
    w: float
    horizontal: bool  # wall direction
    t: float  # wall thickness
    into: str | None = None  # room the leaf swings into
    hinge: Pt | None = None  # hinge point on the face of ``into``
    leaf_dir: Pt = (0.0, 0.0)  # unit vector from hinge along the closed leaf (along the wall)
    swing_dir: Pt = (0.0, 0.0)  # unit vector from the wall into ``into``


@dataclass
class Furniture:
    kind: str
    room: str
    polys: list[list[Pt]]  # outline polylines (closed)
    circles: list[tuple[Pt, float]] = field(default_factory=list)
    lines: list[list[Pt]] = field(default_factory=list)
    bbox: Rect = (0.0, 0.0, 0.0, 0.0)


@dataclass
class FixtureSpot:
    fine: str
    room: str
    side: str  # N S W E: wall the fixture backs onto
    c: Pt  # point on the wall face (centre of the back edge)
    params: dict[str, object] = field(default_factory=dict)
    extent: Rect = (0.0, 0.0, 0.0, 0.0)  # footprint (plan units)


@dataclass
class Plan:
    floor: str
    footprint: Rect
    rooms: list[Room]
    walls: list[Wall]
    openings: list[Opening]
    furniture: list[Furniture]
    fixtures: list[FixtureSpot]
    stairs: list[list[Pt]] = field(default_factory=list)  # tread lines
    units: str = "m"

    def room(self, rid: str) -> Room:
        for r in self.rooms:
            if r.rid == rid:
                return r
        raise KeyError(rid)

    def scaled(self, k: float, ox: float, oy: float) -> Plan:
        """Copy in other units: p' = (ox + k x, oy + k y)."""

        def P(p: Pt) -> Pt:
            return (ox + k * p[0], oy + k * p[1])

        def R(r: Rect) -> Rect:
            return (ox + k * r[0], oy + k * r[1], ox + k * r[2], oy + k * r[3])

        return Plan(
            self.floor,
            R(self.footprint),
            [replace(r, rect=R(r.rect), net=R(r.net), poly=[P(p) for p in r.poly], area=r.area) for r in self.rooms],
            [replace(w, t=w.t * k, a=P(w.a), b=P(w.b)) for w in self.walls],
            [replace(o, c=P(o.c), w=o.w * k, t=o.t * k, hinge=P(o.hinge) if o.hinge else None) for o in self.openings],
            [
                replace(
                    f,
                    polys=[[P(p) for p in q] for q in f.polys],
                    circles=[(P(c), r * k) for c, r in f.circles],
                    lines=[[P(p) for p in q] for q in f.lines],
                    bbox=R(f.bbox),
                )
                for f in self.furniture
            ],
            [replace(x, c=P(x.c), extent=R(x.extent), params=dict(x.params)) for x in self.fixtures],
            [[P(p) for p in s] for s in self.stairs],
            units="mm",
        )


# ============================================================================================ programme
def programme(rng: random.Random, kind: str) -> list[tuple[str, float]]:
    """(room kind, target area m2) list."""
    if kind == "house":
        rooms = [("living", rng.uniform(28, 40)), ("kitchen", rng.uniform(10, 15)), ("entry", rng.uniform(4, 6))]
        rooms += [("wc", rng.uniform(2.0, 3.0)), ("laundry", rng.uniform(3, 5)), ("mamad", rng.uniform(9, 12))]
        rooms += [("stairs", rng.uniform(7, 9)), ("study", rng.uniform(9, 12))]
        if rng.random() < 0.5:
            rooms.append(("storage", rng.uniform(2.5, 4)))
        return rooms
    n_bed = rng.choice([1, 2, 2, 3, 3])
    rooms = [("living", rng.uniform(24, 34)), ("kitchen", rng.uniform(8, 13)), ("master", rng.uniform(12, 16))]
    rooms += [("bedroom", rng.uniform(9, 12)) for _ in range(n_bed - 1)]
    rooms += [("mamad", rng.uniform(9, 12)), ("bath", rng.uniform(4, 6)), ("corridor", rng.uniform(4, 7))]
    if rng.random() < 0.7:
        rooms.append(("wc", rng.uniform(1.6, 2.6)))
    if n_bed >= 2 or rng.random() < 0.4:
        rooms.append(("shower", rng.uniform(3.2, 4.5)))
    if rng.random() < 0.6:
        rooms.append(("laundry", rng.uniform(2.5, 4)))
    return rooms


GROUPS = {
    "public": ("living", "kitchen", "entry", "family"),
    "service": ("wc", "laundry", "storage", "stairs"),
    "private": ("corridor", "bath", "shower", "master", "bedroom", "mamad", "study"),
}


def _order(rng: random.Random, rooms: list[tuple[str, float]]) -> list[tuple[str, float]]:
    groups = {g: [r for r in rooms if r[0] in kinds] for g, kinds in GROUPS.items()}
    for g in groups.values():
        rng.shuffle(g)
    # keep wet rooms of the private group next to each other
    pv = groups["private"]
    wet = [r for r in pv if r[0] in ("bath", "shower")]
    dry = [r for r in pv if r[0] not in ("bath", "shower")]
    k = rng.randint(0, len(dry))
    groups["private"] = dry[:k] + wet + dry[k:]
    order = ["public", "service", "private"]
    if rng.random() < 0.5:
        order = ["service", "public", "private"] if rng.random() < 0.5 else ["public", "private", "service"]
    return [r for g in order for r in groups[g]]


def _snap(v: float, q: float = 0.05) -> float:
    return round(round(v / q) * q, 4)


def _treemap(rng: random.Random, rect: Rect, items: list[tuple[str, float]], out: list[tuple[str, Rect]]) -> None:
    if len(items) == 1:
        out.append((items[0][0], rect))
        return
    x0, y0, x1, y1 = rect
    total = sum(a for _, a in items)
    acc = 0.0
    cands: list[tuple[float, int]] = []
    for k in range(1, len(items)):
        acc += items[k - 1][1]
        cands.append((abs(acc - total / 2) + rng.uniform(0, 0.12) * total, k))
    cands.sort()
    k = cands[0][1]
    frac = sum(a for _, a in items[:k]) / total
    if (x1 - x0) >= (y1 - y0):
        xs = _snap(x0 + frac * (x1 - x0))
        _treemap(rng, (x0, y0, xs, y1), items[:k], out)
        _treemap(rng, (xs, y0, x1, y1), items[k:], out)
    else:
        ys = _snap(y0 + frac * (y1 - y0))
        _treemap(rng, (x0, y0, x1, ys), items[:k], out)
        _treemap(rng, (x0, ys, x1, y1), items[k:], out)


def _score(rects: list[tuple[str, Rect]]) -> float:
    s = 0.0
    for kind, (x0, y0, x1, y1) in rects:
        w, h = x1 - x0, y1 - y0
        short, long_ = min(w, h), max(w, h)
        if short < MIN_SIDE[kind]:
            s += 10 * (MIN_SIDE[kind] - short)
        asp = long_ / max(short, 1e-6)
        lim = MAX_ASPECT.get(kind, 2.2)
        if asp > lim:
            s += 2 * (asp - lim)
    return s


# ============================================================================================ walls
def _segments(rooms: list[Room], fp: Rect, ext_t: float, part_kind: str, part_t: float) -> list[Wall]:
    edges: dict[tuple[str, float], list[tuple[float, float, str]]] = {}
    for r in rooms:
        x0, y0, x1, y1 = r.rect
        edges.setdefault(("h", round(y0, 4)), []).append((x0, x1, r.rid))
        edges.setdefault(("h", round(y1, 4)), []).append((x0, x1, r.rid))
        edges.setdefault(("v", round(x0, 4)), []).append((y0, y1, r.rid))
        edges.setdefault(("v", round(x1, 4)), []).append((y0, y1, r.rid))
    kinds = {r.rid: r.kind for r in rooms}
    walls: list[Wall] = []
    for (orient, c), spans in sorted(edges.items()):
        bps = sorted({round(v, 4) for a, b, _ in spans for v in (a, b)})
        pieces: list[tuple[float, float, str, tuple[str, ...]]] = []
        for a, b in itertools.pairwise(bps):
            if b - a < 1e-6:
                continue
            ids = tuple(sorted({rid for s0, s1, rid in spans if s0 <= a + 1e-6 and s1 >= b - 1e-6}))
            if not ids:
                continue
            if len(ids) == 1:
                kind = "concrete" if kinds[ids[0]] == "mamad" else "exterior"
            elif any(kinds[i] == "mamad" for i in ids):
                kind = "concrete"
            elif any(kinds[i] in WET for i in ids) and part_kind == "gypsum":
                kind = "block"  # wet rooms keep block partitions
            else:
                kind = part_kind
            if pieces and pieces[-1][2] == kind and pieces[-1][3] == ids and abs(pieces[-1][1] - a) < 1e-6:
                pieces[-1] = (pieces[-1][0], b, kind, ids)
            else:
                pieces.append((a, b, kind, ids))
        for a, b, kind, ids in pieces:
            t = {"exterior": ext_t, "concrete": 0.30, "block": max(0.10, part_t), "gypsum": 0.10}[kind]
            if kind == "concrete" and len(ids) == 1:
                t = max(ext_t, 0.30)
            pa: Pt = (a, c) if orient == "h" else (c, a)
            pb: Pt = (b, c) if orient == "h" else (c, b)
            walls.append(Wall(f"w{len(walls) + 1}", kind, t, pa, pb, ids))
    return walls


def wall_polygon(w: Wall) -> Polygon:
    return LineString([w.a, w.b]).buffer(w.t / 2, cap_style="square", join_style="mitre")


def wall_unions(walls: list[Wall], openings: list[Opening]) -> dict[str, BaseGeometry]:
    """Drawn wall areas per kind (heavier kinds win at junctions), openings cut out."""
    cuts = unary_union([opening_rect(o) for o in openings]) if openings else None
    out: dict[str, BaseGeometry] = {}
    taken: BaseGeometry | None = None
    for kind in sorted(WALL_PRIORITY, key=lambda k: -WALL_PRIORITY[k]):
        ps = [wall_polygon(w) for w in walls if w.kind == kind]
        if not ps:
            continue
        g = unary_union(ps)
        if taken is not None:
            g = g.difference(taken)
        taken = g if taken is None else taken.union(g)
        if cuts is not None:
            g = g.difference(cuts)
        out[kind] = g
    return out


def opening_rect(o: Opening) -> Polygon:
    hw, ht = o.w / 2, o.t / 2 + 0.002
    if o.horizontal:
        return box(o.c[0] - hw, o.c[1] - ht, o.c[0] + hw, o.c[1] + ht)
    return box(o.c[0] - ht, o.c[1] - hw, o.c[0] + ht, o.c[1] + hw)


# ============================================================================================ rooms geometry
def _side_walls(room: Room, walls: list[Wall]) -> dict[str, list[Wall]]:
    x0, y0, _x1, _y1 = room.rect
    out: dict[str, list[Wall]] = {"N": [], "S": [], "W": [], "E": []}
    for w in walls:
        if room.rid not in w.rooms:
            continue
        if w.horizontal:
            out["N" if abs(w.a[1] - y0) < 1e-6 else "S"].append(w)
        else:
            out["W" if abs(w.a[0] - x0) < 1e-6 else "E"].append(w)
    return out


def _net_geometry(rooms: list[Room], walls: list[Wall]) -> None:
    allw = unary_union([wall_polygon(w) for w in walls])
    for r in rooms:
        sw = _side_walls(r, walls)
        h = {s: max((w.t for w in ws), default=0.1) / 2 for s, ws in sw.items()}
        x0, y0, x1, y1 = r.rect
        r.net = (x0 + h["W"], y0 + h["N"], x1 - h["E"], y1 - h["S"])
        g = box(*r.rect).difference(allw)
        if isinstance(g, MultiPolygon):
            g = max(g.geoms, key=lambda q: q.area)
        assert isinstance(g, Polygon)
        r.poly = [(round(x, 5), round(y, 5)) for x, y in list(g.exterior.coords)[:-1]]
        r.area = float(g.area)


# ============================================================================================ openings
def side_of(room: Room, w: Wall) -> str:
    x0, y0, _x1, _y1 = room.rect
    if w.horizontal:
        return "N" if abs(w.a[1] - y0) < 1e-6 else "S"
    return "W" if abs(w.a[0] - x0) < 1e-6 else "E"


INWARD: dict[str, Pt] = {"N": (0.0, 1.0), "S": (0.0, -1.0), "W": (1.0, 0.0), "E": (-1.0, 0.0)}


def _door(oid: str, kind: str, w: Wall, into: Room, width: float, rng: random.Random) -> Opening | None:
    L = w.length
    margin = 0.32
    if L < width + 2 * margin:
        return None
    along = ((w.b[0] - w.a[0]) / L, (w.b[1] - w.a[1]) / L)
    at_start = rng.random() < 0.5
    off = margin + rng.uniform(0.0, 0.15)
    s = off + width / 2 if at_start else L - off - width / 2
    c = (w.a[0] + along[0] * s, w.a[1] + along[1] * s)
    sd = INWARD[side_of(into, w)]
    hinge_s = s - width / 2 if at_start else s + width / 2
    face = (w.a[0] + along[0] * hinge_s + sd[0] * w.t / 2, w.a[1] + along[1] * hinge_s + sd[1] * w.t / 2)
    leaf = along if at_start else (-along[0], -along[1])
    return Opening(oid, kind, w.wid, c, width, w.horizontal, w.t, into.rid, face, leaf, sd)


def _window(oid: str, w: Wall, width: float, rng: random.Random, taken: list[tuple[float, float]]) -> Opening | None:
    L = w.length
    margin = 0.45
    if L < width + 2 * margin:
        width = L - 2 * margin
        if width < 0.5:
            return None
    along = ((w.b[0] - w.a[0]) / L, (w.b[1] - w.a[1]) / L)
    for _ in range(6):
        s = L / 2 + rng.uniform(-1, 1) * max(0.0, (L - width) / 2 - margin)
        if all(s + width / 2 + 0.25 < a or s - width / 2 - 0.25 > b for a, b in taken):
            taken.append((s - width / 2, s + width / 2))
            c = (w.a[0] + along[0] * s, w.a[1] + along[1] * s)
            return Opening(oid, "window", w.wid, c, width, w.horizontal, w.t)
    return None


def _door_width(kind: str) -> float:
    return 0.7 if kind in ("wc", "storage", "laundry") else (0.9 if kind == "mamad" else 0.8)


DOOR_PARENT_PRIORITY = {"corridor": 0, "entry": 1, "living": 2, "family": 2, "master": 3, "kitchen": 4}


def _openings(rng: random.Random, rooms: list[Room], walls: list[Wall]) -> list[Opening] | None:
    byid = {r.rid: r for r in rooms}
    shared: dict[tuple[str, str], list[Wall]] = {}
    for w in walls:
        if len(w.rooms) == 2:
            shared.setdefault((w.rooms[0], w.rooms[1]), []).append(w)
    start = next((r for r in rooms if r.kind in ("living", "family")), rooms[0])
    tree = {start.rid}
    ops: list[Opening] = []
    taken: dict[str, list[tuple[float, float]]] = {}
    while len(tree) < len(rooms):
        cands = []
        for (a, b), ws in shared.items():
            if (a in tree) == (b in tree):
                continue
            par, ch = (a, b) if a in tree else (b, a)
            pk, ck = byid[par].kind, byid[ch].kind
            if ck == "shower" and pk not in ("master", "corridor"):
                continue
            pri = DOOR_PARENT_PRIORITY.get(pk, 6) + (3 if pk in WET and pk != "kitchen" else 0)
            wl = max(ws, key=lambda q: q.length)
            if wl.length < _door_width(ck) + 0.7:
                continue
            cands.append((pri, -wl.length, par, ch, wl))
        if not cands:
            return None
        cands.sort(key=lambda c: (c[0], c[1], c[2], c[3]))
        _, _, par, ch, wl = cands[0]
        pk, ck = byid[par].kind, byid[ch].kind
        oid = f"o{len(ops) + 1}"
        if {pk, ck} == {"kitchen", "living"} or {pk, ck} == {"living", "entry"}:
            width = min(wl.length - 0.5, rng.uniform(1.2, 2.2))
            L = wl.length
            along = ((wl.b[0] - wl.a[0]) / L, (wl.b[1] - wl.a[1]) / L)
            s = L / 2
            ops.append(
                Opening(oid, "opening", wl.wid, (wl.a[0] + along[0] * s, wl.a[1] + along[1] * s), width, wl.horizontal, wl.t)
            )
            taken.setdefault(wl.wid, []).append((s - width / 2, s + width / 2))
        else:
            width = _door_width(ck)
            into = byid[ch] if ck != "corridor" else byid[par]
            if ck == "corridor" and pk in ("living", "entry"):
                into = byid[ch]
            d = _door(oid, "door", wl, into, width, rng)
            if d is None:
                return None
            ops.append(d)
            L = wl.length
            along = ((wl.b[0] - wl.a[0]) / L, (wl.b[1] - wl.a[1]) / L)
            s = (d.c[0] - wl.a[0]) * along[0] + (d.c[1] - wl.a[1]) * along[1]
            taken.setdefault(wl.wid, []).append((s - width / 2, s + width / 2))
        tree.add(ch)
    # entrance: exterior wall of entry / living / corridor
    ext = [
        w
        for w in walls
        if w.kind == "exterior" and len(w.rooms) == 1 and byid[w.rooms[0]].kind in ("entry", "living", "corridor")
    ]
    ext.sort(key=lambda w: (["entry", "corridor", "living"].index(byid[w.rooms[0]].kind), -w.length))
    for w in ext:
        d = _door(f"o{len(ops) + 1}", "entrance", w, byid[w.rooms[0]], 1.0, rng)
        if d is not None:
            ops.append(d)
            L = w.length
            along = ((w.b[0] - w.a[0]) / L, (w.b[1] - w.a[1]) / L)
            s = (d.c[0] - w.a[0]) * along[0] + (d.c[1] - w.a[1]) * along[1]
            taken.setdefault(w.wid, []).append((s - 0.5, s + 0.5))
            break
    else:
        return None
    # windows
    wwidth = {"living": (2.0, 3.0), "family": (1.6, 2.4), "master": (1.4, 1.8), "bedroom": (1.2, 1.6), "mamad": (1.0, 1.0)}
    wwidth |= {"kitchen": (1.0, 1.4), "bath": (0.6, 0.8), "shower": (0.6, 0.6), "wc": (0.5, 0.5), "study": (1.2, 1.6)}
    wwidth |= {"laundry": (0.8, 1.0), "stairs": (0.8, 1.2)}
    for r in rooms:
        if r.kind not in wwidth:
            continue
        ext_w = [w for w in walls if w.rooms == (r.rid,)]
        if not ext_w:
            continue
        ext_w.sort(key=lambda w: (-w.length, w.wid))
        n = 2 if r.kind in ("living", "family") and len(ext_w) > 1 and rng.random() < 0.6 else 1
        for w in ext_w[:n]:
            lo, hi = wwidth[r.kind]
            o = _window(f"o{len(ops) + 1}", w, rng.uniform(lo, hi), rng, taken.setdefault(w.wid, []))
            if o is not None:
                ops.append(o)
    return ops


# ============================================================================================ furniture
def side_interval(room: Room, side: str) -> tuple[float, float]:
    x0, y0, x1, y1 = room.net
    return (x0, x1) if side in ("N", "S") else (y0, y1)


def side_point(room: Room, side: str, t: float) -> Pt:
    x0, y0, x1, y1 = room.net
    return {"N": (t, y0), "S": (t, y1), "W": (x0, t), "E": (x1, t)}[side]


def blocked(room: Room, side: str, openings: list[Opening], walls: dict[str, Wall], pad: float) -> list[tuple[float, float]]:
    """Intervals of a room side (in its own coordinate) taken by openings (+ pad), plus door swing zones of any side."""
    out = []
    for o in openings:
        w = walls[o.wid]
        if room.rid not in w.rooms or side_of(room, w) != side:
            continue
        cpos = o.c[0] if side in ("N", "S") else o.c[1]
        out.append((cpos - o.w / 2 - pad, cpos + o.w / 2 + pad))
    # door leaves of perpendicular walls sweep along this side near the corners
    for o in openings:
        if o.into != room.rid or o.hinge is None:
            continue
        w = walls[o.wid]
        s = side_of(room, w)
        if s == side:
            continue
        # door on a perpendicular side: its swing square touches this side if near this side's line
        hx, hy = o.hinge
        ex = hx + o.leaf_dir[0] * o.w + o.swing_dir[0] * o.w
        ey = hy + o.leaf_dir[1] * o.w + o.swing_dir[1] * o.w
        bx0, bx1 = sorted((hx, ex))
        by0, by1 = sorted((hy, ey))
        nx0, ny0, nx1, ny1 = room.net
        line = {"N": ny0, "S": ny1, "W": nx0, "E": nx1}[side]
        if side in ("N", "S") and by0 - 0.05 <= line <= by1 + 0.05:
            out.append((bx0 - pad, bx1 + pad))
        if side in ("W", "E") and bx0 - 0.05 <= line <= bx1 + 0.05:
            out.append((by0 - pad, by1 + pad))
    return out


def free_slots(lo: float, hi: float, taken: list[tuple[float, float]], need: float) -> list[tuple[float, float]]:
    """Sub-intervals of [lo, hi] free of ``taken`` that are at least ``need`` long."""
    cur = [(lo, hi)]
    for a, b in sorted(taken):
        nxt = []
        for c, d in cur:
            if b <= c or a >= d:
                nxt.append((c, d))
                continue
            if a > c:
                nxt.append((c, a))
            if b < d:
                nxt.append((b, d))
        cur = nxt
    return [(a, b) for a, b in cur if b - a >= need]


def door_swing_boxes(openings: list[Opening]) -> list[Rect]:
    out = []
    for o in openings:
        if o.hinge is None:
            continue
        hx, hy = o.hinge
        ex = hx + o.leaf_dir[0] * o.w + o.swing_dir[0] * o.w
        ey = hy + o.leaf_dir[1] * o.w + o.swing_dir[1] * o.w
        out.append((min(hx, ex), min(hy, ey), max(hx, ex), max(hy, ey)))
    return out


def rect_hits(r: Rect, others: list[Rect], pad: float = 0.0) -> bool:
    return any(r[0] - pad < o[2] and o[0] - pad < r[2] and r[1] - pad < o[3] and o[1] - pad < r[3] for o in others)


def wall_rect(room: Room, side: str, t: float, width: float, depth: float) -> Rect:
    """Footprint of an item of ``width`` x ``depth`` backing onto ``side`` centred at ``t``."""
    x0, y0, x1, y1 = room.net
    if side == "N":
        return (t - width / 2, y0, t + width / 2, y0 + depth)
    if side == "S":
        return (t - width / 2, y1 - depth, t + width / 2, y1)
    if side == "W":
        return (x0, t - width / 2, x0 + depth, t + width / 2)
    return (x1 - depth, t - width / 2, x1, t + width / 2)


class Placer:
    """Wall-backed placement of to-scale items (furniture / fixtures) inside rooms, avoiding doors and each other."""

    def __init__(self, rng: random.Random, plan_rooms: list[Room], walls: list[Wall], openings: list[Opening]) -> None:
        self.rng = rng
        self.walls = {w.wid: w for w in walls}
        self.openings = openings
        self.occupied: list[Rect] = list(door_swing_boxes(openings))
        self.rooms = plan_rooms

    def window_sides(self, room: Room) -> set[str]:
        out = set()
        for o in self.openings:
            if o.kind == "window":
                w = self.walls[o.wid]
                if room.rid in w.rooms:
                    out.add(side_of(room, w))
        return out

    def place(
        self,
        room: Room,
        width: float,
        depth: float,
        *,
        sides: list[str] | None = None,
        avoid_windows: bool = False,
        corner: bool = False,
    ) -> tuple[str, float, Rect] | None:
        order = sides or ["N", "S", "W", "E"]
        if sides is None:
            self.rng.shuffle(order)
        win = self.window_sides(room) if avoid_windows else set()
        for side in order:
            if side in win:
                continue
            lo, hi = side_interval(room, side)
            taken = blocked(room, side, self.openings, self.walls, 0.05)
            for a, b in free_slots(lo + 0.02, hi - 0.02, taken, width):
                if corner:
                    ts = [a + width / 2, b - width / 2]
                    self.rng.shuffle(ts)
                else:
                    span = b - a - width
                    ts = [a + width / 2 + span * f for f in (self.rng.random(), 0.5, 0.0, 1.0)]
                for t in ts:
                    r = wall_rect(room, side, t, width, depth)
                    if not rect_hits(r, self.occupied, 0.03):
                        self.occupied.append(r)
                        return side, t, r
        return None


def _rect_poly(r: Rect) -> list[Pt]:
    return [(r[0], r[1]), (r[2], r[1]), (r[2], r[3]), (r[0], r[3])]


def _local_to_wall(room: Room, side: str, t: float, pts: list[Pt]) -> list[Pt]:
    """Map local (x along wall, y = distance from wall) to plan coordinates."""
    x0, y0, x1, y1 = room.net
    out = []
    for lx, ly in pts:
        if side == "N":
            out.append((t + lx, y0 + ly))
        elif side == "S":
            out.append((t - lx, y1 - ly))
        elif side == "W":
            out.append((x0 + ly, t - lx))
        else:
            out.append((x1 - ly, t + lx))
    return out


def _furnish(rng: random.Random, plan: Plan, placer: Placer) -> None:
    F = plan.furniture

    def add(
        kind: str,
        room: Room,
        side: str,
        t: float,
        r: Rect,
        polys: list[list[Pt]],
        circles: list[tuple[Pt, float]] | None = None,
        lines: list[list[Pt]] | None = None,
    ) -> None:
        F.append(
            Furniture(
                kind,
                room.rid,
                [_local_to_wall(room, side, t, p) for p in polys],
                [(_local_to_wall(room, side, t, [c])[0], rr) for c, rr in (circles or [])],
                [_local_to_wall(room, side, t, ln) for ln in (lines or [])],
                r,
            )
        )

    for room in plan.rooms:
        k = room.kind
        if k in ("master", "bedroom", "mamad", "study"):
            double = k == "master" or (k == "bedroom" and rng.random() < 0.3)
            bw, bd = (1.6, 2.0) if double else (0.9, 1.9)
            if k in ("mamad", "study"):
                bw, bd = (1.4, 0.7)  # desk
            got = placer.place(room, bw + (0.9 if double else 0.0), bd, avoid_windows=True)
            if got:
                side, t, r = got
                if k in ("mamad", "study"):
                    add(
                        "desk",
                        room,
                        side,
                        t,
                        r,
                        [[(-bw / 2, 0), (bw / 2, 0), (bw / 2, bd), (-bw / 2, bd)]],
                        [((0.0, bd + 0.3), 0.22)],
                    )
                else:
                    polys = [[(-bw / 2, 0), (bw / 2, 0), (bw / 2, bd), (-bw / 2, bd)]]
                    if double:
                        polys += [
                            [(-0.7, 0.08), (-0.1, 0.08), (-0.1, 0.45), (-0.7, 0.45)],
                            [(0.1, 0.08), (0.7, 0.08), (0.7, 0.45), (0.1, 0.45)],
                        ]
                        polys += [
                            [(-1.25, 0), (-0.85, 0), (-0.85, 0.4), (-1.25, 0.4)],
                            [(0.85, 0), (1.25, 0), (1.25, 0.4), (0.85, 0.4)],
                        ]
                    else:
                        polys += [[(-0.35, 0.08), (0.35, 0.08), (0.35, 0.42), (-0.35, 0.42)]]
                    add("bed", room, side, t, r, polys, lines=[[(-bw / 2, 0.55), (bw / 2, 0.55)]])
            if k in ("master", "bedroom") and rng.random() < 0.8:
                got = placer.place(room, min(2.4, rng.uniform(1.4, 2.6)), 0.6)
                if got:
                    side, t, r = got
                    w = (r[2] - r[0]) if side in ("N", "S") else (r[3] - r[1])
                    add(
                        "wardrobe",
                        room,
                        side,
                        t,
                        r,
                        [[(-w / 2, 0), (w / 2, 0), (w / 2, 0.6), (-w / 2, 0.6)]],
                        lines=[[(-w / 2, 0), (w / 2, 0.6)]],
                    )
        elif k in ("living", "family"):
            got = placer.place(room, 2.3, 0.9, avoid_windows=False)
            if got:
                side, t, r = got
                add(
                    "sofa",
                    room,
                    side,
                    t,
                    r,
                    [[(-1.15, 0), (1.15, 0), (1.15, 0.9), (-1.15, 0.9)], [(-0.95, 0.2), (0.95, 0.2), (0.95, 0.9), (-0.95, 0.9)]],
                )
            got = placer.place(room, 1.8, 0.45)
            if got:
                side, t, r = got
                add("tv_unit", room, side, t, r, [[(-0.9, 0), (0.9, 0), (0.9, 0.45), (-0.9, 0.45)]])
            x0, y0, x1, y1 = room.net
            if k == "living" and (x1 - x0) > 4.0 and (y1 - y0) > 3.5:
                cx, cy = (x0 + x1) / 2 + rng.uniform(-0.3, 0.3), (y0 + y1) / 2 + rng.uniform(-0.3, 0.3)
                rr = (cx - 1.0, cy - 1.0, cx + 1.0, cy + 1.0)
                if not rect_hits(rr, placer.occupied, 0.1):
                    placer.occupied.append(rr)
                    chairs = [
                        (cx + 0.78 * math.cos(a), cy + 0.78 * math.sin(a)) for a in (0, math.pi / 2, math.pi, 1.5 * math.pi)
                    ]
                    polys = [[(x - 0.2, y - 0.2), (x + 0.2, y - 0.2), (x + 0.2, y + 0.2), (x - 0.2, y + 0.2)] for x, y in chairs]
                    F.append(Furniture("dining", room.rid, polys, [((cx, cy), 0.55)], [], rr))
        elif k == "kitchen":
            got = placer.place(room, min(3.2, (room.net[2] - room.net[0]) - 0.3), 0.6, sides=["N", "S", "W", "E"])
            if got is None:
                got = placer.place(room, 1.8, 0.6)
            if got:
                side, t, r = got
                w = (r[2] - r[0]) if side in ("N", "S") else (r[3] - r[1])
                circles = [((x, y), 0.09) for x in (w / 2 - 0.45, w / 2 - 0.2) for y in (0.18, 0.42)]
                add("counter", room, side, t, r, [[(-w / 2, 0), (w / 2, 0), (w / 2, 0.6), (-w / 2, 0.6)]], circles)
                # kitchen sink sits in the counter
                plan.fixtures.append(
                    FixtureSpot("fixture_kitchen_sink", room.rid, side, side_point(room, side, t - min(0.5, w / 2 - 0.55)), {}, r)
                )
            got = placer.place(room, 0.75, 0.7)
            if got:
                side, t, r = got
                add(
                    "fridge",
                    room,
                    side,
                    t,
                    r,
                    [[(-0.37, 0), (0.37, 0), (0.37, 0.7), (-0.37, 0.7)]],
                    lines=[[(-0.37, 0), (0.37, 0.7)]],
                )


def _fixtures(rng: random.Random, plan: Plan, placer: Placer) -> None:
    for room in plan.rooms:
        k = room.kind
        items: list[tuple[str, float, float, dict[str, object]]] = []
        if k == "bath":
            if (room.net[2] - room.net[0]) >= 1.62 and rng.random() < 0.6:
                items.append(("fixture_bath", 1.6, 0.72, {"length": 1.6}))
            else:
                items.append(("fixture_shower", 0.9, 0.9, {"size": 0.9}))
            items.append(("fixture_wc_concealed" if rng.random() < 0.6 else "fixture_wc_monoblock", 0.5, 0.65, {}))
            items.append(("fixture_basin", 0.58, 0.46, {}))
        elif k == "shower":
            items.append(("fixture_shower", 0.85, 0.85, {"size": 0.85}))
            items.append(("fixture_wc_concealed" if rng.random() < 0.5 else "fixture_wc_monoblock", 0.5, 0.65, {}))
            items.append(("fixture_basin", 0.58, 0.46, {}))
        elif k == "wc":
            items.append(("fixture_wc_concealed" if rng.random() < 0.5 else "fixture_wc_monoblock", 0.5, 0.65, {}))
            if room.area > 1.7:
                items.append(("fixture_basin", 0.58, 0.46, {}))
        elif k == "laundry":
            items.append(("fixture_washing_machine", 0.62, 0.62, {}))
        for fine, w, d, params in items:
            got = placer.place(room, w, d, corner=fine in ("fixture_shower", "fixture_bath"))
            if got is None:
                continue
            side, t, r = got
            plan.fixtures.append(FixtureSpot(fine, room.rid, side, side_point(room, side, t), params, r))


def _stairs(plan: Plan) -> None:
    for room in plan.rooms:
        if room.kind != "stairs":
            continue
        x0, y0, x1, y1 = room.net
        long_x = (x1 - x0) >= (y1 - y0)
        n = int(((x1 - x0) if long_x else (y1 - y0)) / 0.28)
        mid = (y0 + y1) / 2 if long_x else (x0 + x1) / 2
        for i in range(1, n):
            if long_x:
                x = x0 + i * 0.28
                plan.stairs.append([(x, y0), (x, y1)])
            else:
                y = y0 + i * 0.28
                plan.stairs.append([(x0, y), (x1, y)])
        if long_x:
            plan.stairs.append([(x0 + 0.3, mid), (x1 - 0.3, mid)])
        else:
            plan.stairs.append([(mid, y0 + 0.3), (mid, y1 - 0.3)])


# ============================================================================================ entry point
@dataclass
class BuildingSpec:
    kind: str  # apartment | house
    floors: list[str]
    ext_t: float
    part_kind: str  # block | gypsum
    part_t: float


def _rooms_for(rng: random.Random, rects: list[tuple[str, Rect]], floor: str, upper: bool) -> list[Room]:
    names_used: dict[str, int] = {}
    rooms = []
    for i, (kind, r) in enumerate(rects):
        k = UPPER_FLOOR.get(kind, kind) if upper else kind
        names = ROOM_NAMES[k]
        n = names_used.get(k, 0)
        names_used[k] = n + 1
        name = names[rng.randrange(len(names))]
        if k == "bedroom" and n > 0:
            name = f"חדר שינה {n + 1}"
        x0, y0, x1, y1 = (round(v, 4) for v in r)
        rooms.append(Room(f"{floor}-r{i + 1}", k, name, (x0, y0, x1, y1)))
    return rooms


def generate_building(rng: random.Random, spec: BuildingSpec) -> list[Plan]:
    """One plan per floor (houses: the upper floor reuses the room rectangles, relabelled)."""
    for _attempt in range(10):
        plans = _try_building(rng, spec)
        if plans is not None:
            return plans
    raise RuntimeError("no connected door layout")


def _try_building(rng: random.Random, spec: BuildingSpec) -> list[Plan] | None:
    prog = programme(rng, spec.kind)
    total = sum(a for _, a in prog) * 1.12  # + walls
    cands: list[tuple[float, int, list[tuple[str, Rect]], Rect]] = []
    for i in range(60):
        aspect = rng.uniform(1.15, 1.7)
        W = _snap(math.sqrt(total * aspect), 0.1)
        D = _snap(total / W, 0.1)
        out: list[tuple[str, Rect]] = []
        _treemap(rng, (0.0, 0.0, W, D), _order(rng, prog), out)
        cands.append((_score(out), i, out, (0.0, 0.0, W, D)))
    cands.sort(key=lambda c: (c[0], c[1]))
    for _sc, _i, rects, fp in cands[:25]:
        plans: list[Plan] = []
        for fi, floor in enumerate(spec.floors):
            rooms = _rooms_for(rng, rects, floor, fi > 0)
            walls = _segments(rooms, fp, spec.ext_t, spec.part_kind, spec.part_t)
            ops = None
            for _ in range(6):
                ops = _openings(rng, rooms, walls)
                if ops is not None:
                    break
            if ops is None:
                break
            _net_geometry(rooms, walls)
            plan = Plan(floor, fp, rooms, walls, ops, [], [])
            placer = Placer(rng, rooms, walls, ops)
            _fixtures(rng, plan, placer)
            _furnish(rng, plan, placer)
            _stairs(plan)
            plans.append(plan)
        if len(plans) == len(spec.floors):
            return plans
    return None
