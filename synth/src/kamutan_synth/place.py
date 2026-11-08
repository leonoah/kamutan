"""Discipline symbols on a plan (paper mm): electrical, lighting, plumbing (+ pipes), with labels.

Every placed symbol becomes exactly one GT feature; labels (H=…, 2X, קיים / להחליף / חדש, type tags) are placed
with the symbol atomically when they carry meaning (2X, lifecycle) and best-effort otherwise (heights).
"""

from __future__ import annotations

import itertools
import math
import random
from dataclasses import dataclass, field

from .catalog import CLASSES
from .layout import Opening, Plan, Room, blocked, free_slots, side_interval, side_of
from .scene import BBox, Circle, Pen, Poly, Prim, SymbolRef, Text, bbox_grow, bbox_of, bbox_overlap, expand, prim_points
from .spec import SheetSpec
from .symbols import build
from .text import FontSpec

Pt = tuple[float, float]
SIDE_ROT = {"S": 0.0, "N": 180.0, "W": 270.0, "E": 90.0}
INWARD = {"N": (0.0, 1.0), "S": (0.0, -1.0), "W": (1.0, 0.0), "E": (-1.0, 0.0)}


@dataclass
class Placed:
    fine: str
    sid: str
    insert: Pt
    rot: float
    mirror: bool
    local: list[Prim]
    bbox: BBox
    room_id: str
    floor: str
    cls: str  # taxonomy class (after 2X upgrades)
    symbol_cls: str  # taxonomy class of the drawn glyph
    lifecycle: str = "new"
    qualifier: str | None = None
    heights_cm: list[int] = field(default_factory=list)
    qty: int = 1
    annotations: list[str] = field(default_factory=list)
    labels: list[Prim] = field(default_factory=list)  # paper coordinates
    label_boxes: list[BBox] = field(default_factory=list)
    type_tag: int | None = None
    controls: list[int] = field(default_factory=list)  # indices into the placed list
    exploded: bool = False
    tags: list[str] = field(default_factory=list)  # difficulty tags
    params: dict[str, object] = field(default_factory=dict)
    gid: str = ""
    context: bool = False


@dataclass
class Pipe:
    system: str  # cold | hot | sewer
    dia: int
    pts: list[Pt]
    length_m: float
    floor: str
    label: Prim | None = None
    gid: str = ""


class Placer:
    def __init__(
        self,
        plan: Plan,
        spec: SheetSpec,
        rng: random.Random,
        scale: int,
        font: FontSpec,
        occupied: list[BBox],
        *,
        mult_text: bool = False,
    ) -> None:
        self.plan = plan
        self.spec = spec
        self.rng = rng
        self.scale = scale
        self.font = font
        self.occ: list[BBox] = list(occupied)
        self.walls = {w.wid: w for w in plan.walls}
        # labels must not sit on walls (symbols may touch them)
        self.wall_boxes: list[BBox] = []
        for w in plan.walls:
            h = w.t / 2
            self.wall_boxes.append(
                (min(w.a[0], w.b[0]) - h, min(w.a[1], w.b[1]) - h, max(w.a[0], w.b[0]) + h, max(w.a[1], w.b[1]) + h)
            )
        self.out: list[Placed] = []
        self.pipes: list[Pipe] = []
        self.m = 1000.0 / scale  # paper mm per metre
        self.lh = max(1.8, spec.sym_u * 0.5)  # label height
        self.mult_text = mult_text  # sheet convention: 2X / 3X text next to a single-socket glyph

    # ------------------------------------------------------------------------------------------ primitives
    def _u(self, fine: str) -> float:
        return self.m if CLASSES[fine].real_size else self.spec.sym_u

    def _make(
        self, fine: str, insert: Pt, rot: float, params: dict[str, object] | None = None, mirror: bool | None = None
    ) -> tuple[list[Prim], BBox, bool]:
        sid = self.spec.styles[fine]
        local = build(sid, self._u(fine), self.spec.lw, params)
        if mirror is None:
            mirror = self.rng.random() < self.spec.p_mirror
        ref = SymbolRef("", sid, local, insert, rot, mirror, "", Pen())
        bb = bbox_of([q for p in expand(ref) for q in prim_points(p, self.font)])
        return local, bb, mirror

    def _free(self, bb: BBox, pad: float = 0.5) -> bool:
        return not any(bbox_overlap(bb, o, pad) for o in self.occ)

    def _text_box(self, t: Text) -> BBox:
        return bbox_of(prim_points(t, self.font))

    def _label_spots(self, bb: BBox, s: str, *, far: bool = False) -> list[tuple[Text, list[Prim]]]:
        h = self.lh
        g = 0.8 if not far else self.rng.uniform(4.0, 8.0)
        cx, cy = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2
        cands = [
            Text(s, (bb[2] + g, cy), h, 0.0, "l", "m"),
            Text(s, (bb[0] - g, cy), h, 0.0, "r", "m"),
            Text(s, (cx, bb[1] - g), h, 0.0, "c", "b"),
            Text(s, (cx, bb[3] + g + h), h, 0.0, "c", "b"),
            Text(s, (bb[2] + g, bb[1] - g * 0.5), h, 0.0, "l", "b"),
            Text(s, (bb[0] - g, bb[3] + g * 0.5 + h), h, 0.0, "r", "b"),
        ]
        if far:
            self.rng.shuffle(cands)
        out: list[tuple[Text, list[Prim]]] = []
        for t in cands:
            extra: list[Prim] = []
            if far:
                tb = self._text_box(t)
                px = min(max(cx, tb[0]), tb[2])
                py = min(max(cy, tb[1]), tb[3])
                sx = min(max(px, bb[0]), bb[2])
                sy = min(max(py, bb[1]), bb[3])
                extra = [Poly([(sx, sy), (px, py)])]
            out.append((t, extra))
        return out

    def _try_labels(self, bb: BBox, texts: list[str]) -> list[tuple[Text, list[Prim], BBox]] | None:
        """Place labels (one each); all-or-nothing. Labels are reserved in ``self.occ`` on success only."""
        placed: list[tuple[Text, list[Prim], BBox]] = []
        tmp: list[BBox] = []
        for s in texts:
            far = self.rng.random() < self.spec.p_leader
            ok = None
            for t, extra in self._label_spots(bb, s, far=far) + (self._label_spots(bb, s) if far else []):
                tb = self._text_box(t)
                if (
                    self._free(tb, 0.3)
                    and not any(bbox_overlap(tb, o, 0.3) for o in tmp)
                    and not bbox_overlap(tb, bb, 0.1)
                    and not any(bbox_overlap(tb, o, 0.0) for o in self.wall_boxes)
                ):
                    ok = (t, extra, tb)
                    break
            if ok is None:
                return None
            placed.append(ok)
            tmp.append(ok[2])
        return placed

    def _commit(self, p: Placed, labels: list[tuple[Text, list[Prim], BBox]]) -> Placed:
        for t, extra, tb in labels:
            p.labels.append(t)
            p.labels.extend(extra)
            p.label_boxes.append(tb)
            self.occ.append(tb)
            if extra:
                p.tags.append("leader")
        self.occ.append(p.bbox)
        self.out.append(p)
        return p

    # ------------------------------------------------------------------------------------------ item semantics
    def _semantics(self, fine: str, height: int | None) -> tuple[str, str, list[str], int, str, str | None, list[int]]:
        """(fine to draw, taxonomy class, required labels, qty, lifecycle, qualifier, heights)."""
        rng = self.rng
        cls = CLASSES[fine].taxonomy
        draw = fine
        labels: list[str] = []
        qty = 1
        if fine in ("socket_double", "socket_triple") and self.mult_text:
            draw = "socket_single"
            labels.append("2X" if fine == "socket_double" else "3X")
        if fine in ("data_point", "tv_point") and self.spec.difficulty != "easy" and rng.random() < 0.15 * self.spec.density:
            qty = 2
            labels.append("2X")
        lifecycle, qual = "new", None
        if self.spec.renovation and CLASSES[fine].domain != "plumbing":
            r = rng.random()
            if r < 0.22:
                lifecycle, qual = "existing", rng.choice(["קיים", "(קיים)", "ק."])
            elif r < 0.32:
                lifecycle, qual = "new", rng.choice(["להחליף", "להחלפה"])
            elif r < 0.4:
                qual = "חדש"
        if qual:
            labels.append(qual)
        heights = [height] if height is not None else []
        return draw, cls, labels, qty, lifecycle, qual, heights

    def _new(
        self, fine: str, draw: str, cls: str, room: Room, insert: Pt, rot: float, local: list[Prim], bb: BBox, mirror: bool
    ) -> Placed:
        sid = self.spec.styles[draw]
        return Placed(
            fine=fine,
            sid=sid,
            insert=insert,
            rot=rot,
            mirror=mirror,
            local=local,
            bbox=bb,
            room_id=room.rid,
            floor=self.plan.floor,
            cls=cls,
            symbol_cls=CLASSES[draw].taxonomy,
            exploded=self.rng.random() < self.spec.p_exploded,
        )

    # ------------------------------------------------------------------------------------------ placement
    def wall_item(
        self,
        room: Room,
        fine: str,
        *,
        sides: list[str] | None = None,
        height: int | None = None,
        purpose: str | None = None,
        near: float | None = None,
        near_side: str | None = None,
        params: dict[str, object] | None = None,
        tries: int = 14,
    ) -> Placed | None:
        draw, cls, req, qty, life, qual, heights = self._semantics(fine, height)
        side_list = list(sides or ["N", "S", "W", "E"])
        if near_side is None:
            self.rng.shuffle(side_list)
        else:
            side_list = [near_side]
        u = self._u(draw)
        for side in side_list:
            lo, hi = side_interval(room, side)
            taken = blocked(room, side, self.plan.openings, self.walls, 1.0)
            slots = free_slots(lo + u * 0.6, hi - u * 0.6, taken, u * 1.2)
            if not slots:
                continue
            for i in range(tries):
                if near is not None:
                    t = near + (self.rng.uniform(-1, 1) * u * (1 + i * 0.6) if i else 0.0)
                    if not any(a <= t <= b for a, b in slots):
                        continue
                else:
                    a, b = self.rng.choice(slots)
                    t = self.rng.uniform(a + u * 0.6, max(a + u * 0.6, b - u * 0.6))
                gap = 0.0 if self.spec.touch_wall else 0.35
                x0, y0, x1, y1 = room.net
                face = {"N": (t, y0), "S": (t, y1), "W": (x0, t), "E": (x1, t)}[side]
                ins = (face[0] + INWARD[side][0] * gap, face[1] + INWARD[side][1] * gap)
                rot = SIDE_ROT[side]
                local, bb, mirror = self._make(draw, ins, rot, params)
                if not self._free(bb):
                    continue
                # the whole symbol stays inside the room and off door / window openings along its wall
                if bb[0] < x0 - 0.6 or bb[2] > x1 + 0.6 or bb[1] < y0 - 0.6 or bb[3] > y1 + 0.6:
                    continue
                lo_s, hi_s = (bb[0], bb[2]) if side in ("N", "S") else (bb[1], bb[3])
                if any(lo_s < tb and ta < hi_s for ta, tb in taken):
                    continue
                labels = self._try_labels(bb, req)
                if labels is None:
                    continue
                p = self._new(fine, draw, cls, room, ins, rot, local, bb, mirror)
                p.qty, p.lifecycle, p.qualifier, p.params = qty, life, qual, dict(params or {})
                p.annotations = list(req)
                self._commit(p, labels)
                self._optional_labels(p, heights, purpose)
                if self.spec.touch_wall:
                    p.tags.append("touching_wall")
                return p
        return None

    def center_item(self, room: Room, fine: str, pos: Pt, *, height: int | None = None, jitter: float = 0.0) -> Placed | None:
        draw, cls, req, qty, life, qual, heights = self._semantics(fine, height)
        cands = [pos] + [
            (pos[0] + self.rng.uniform(-1, 1) * jitter, pos[1] + self.rng.uniform(-1, 1) * jitter)
            for _ in range(6 if jitter else 0)
        ]
        x0, y0, x1, y1 = room.net
        for c in cands:
            rot = 0.0
            if self.spec.rot_jitter:
                rot = round(self.rng.uniform(-self.spec.rot_jitter, self.spec.rot_jitter), 1)
            local, bb, mirror = self._make(draw, c, rot)
            if bb[0] < x0 + 0.5 or bb[2] > x1 - 0.5 or bb[1] < y0 + 0.5 or bb[3] > y1 - 0.5:
                continue
            if not self._free(bb):
                continue
            labels = self._try_labels(bb, req)
            if labels is None:
                continue
            p = self._new(fine, draw, cls, room, c, rot, local, bb, mirror)
            p.qty, p.lifecycle, p.qualifier = qty, life, qual
            p.annotations = list(req)
            if rot:
                p.tags.append("rotated")
            self._commit(p, labels)
            self._optional_labels(p, heights, None)
            return p
        return None

    def _optional_labels(self, p: Placed, heights: list[int], purpose: str | None) -> None:
        if heights and self.rng.random() < self.spec.p_height_label:
            got = self._try_labels(p.bbox, [f"H={heights[0]}"])
            if got:
                for t, extra, tb in got:
                    p.labels.append(t)
                    p.labels.extend(extra)
                    p.label_boxes.append(tb)
                    self.occ.append(tb)
                p.heights_cm = list(heights)
                p.annotations.append(f"H={heights[0]}")
        if purpose and self.rng.random() < 0.5 + 0.3 * (self.spec.difficulty == "hard"):
            got = self._try_labels(p.bbox, [purpose])
            if got:
                for t, extra, tb in got:
                    p.labels.append(t)
                    p.labels.extend(extra)
                    p.label_boxes.append(tb)
                    self.occ.append(tb)
                p.annotations.append(purpose)
                if any(bbox_overlap(tb, o, 0.0) for o in p.label_boxes[:-1]):
                    p.tags.append("text_collision")

    # ------------------------------------------------------------------------------------------ helpers
    def doors_of(self, room: Room) -> list[Opening]:
        out = []
        for o in self.plan.openings:
            if o.kind not in ("door", "entrance"):
                continue
            w = self.walls[o.wid]
            if room.rid in w.rooms:
                out.append(o)
        return out

    def near_door(self, room: Room, o: Opening) -> tuple[str, float]:
        """(side, coordinate) next to the latch side of door ``o`` inside ``room``."""
        w = self.walls[o.wid]
        side = side_of(room, w)
        along = 0 if side in ("N", "S") else 1
        if o.hinge is not None and o.into == room.rid:
            latch = o.hinge[along] + o.leaf_dir[along] * o.w
            sgn = o.leaf_dir[along]
            return side, latch + sgn * (self.spec.sym_u * 0.9 + 0.12 * self.m)
        sgn = self.rng.choice([-1.0, 1.0])
        return side, o.c[along] + sgn * (o.w / 2 + self.spec.sym_u * 0.9 + 0.12 * self.m)

    def n(self, lo: int, hi: int) -> int:
        d = self.spec.density
        return max(0, round(self.rng.randint(lo, hi) * d - 0.2))


# ============================================================================================ electrical
def place_electrical(pl: Placer) -> None:
    rng = pl.rng
    entr = next((o for o in pl.plan.openings if o.kind == "entrance"), None)
    for room in pl.plan.rooms:
        k = room.kind
        if entr is not None and entr.into == room.rid:
            side, t = pl.near_door(room, entr)
            pl.wall_item(room, "intercom", near=t, near_side=side, height=140)
            pl.wall_item(room, "panel", height=170 if rng.random() < 0.5 else None)
        if k in ("living", "family"):
            for _ in range(pl.n(2, 4)):
                pl.wall_item(room, "socket_single", height=30)
            for _ in range(pl.n(1, 2)):
                pl.wall_item(room, "socket_double", height=30)
            pl.wall_item(room, "tv_point", height=30)
            pl.wall_item(room, "data_point", height=30)
            if rng.random() < 0.5:
                pl.wall_item(room, "phone_point", height=30)
            pl.wall_item(room, "socket_ac", height=rng.choice([220, 230, 240]), purpose="למזגן")
            x0, y0, x1, y1 = room.net
            for _ in range(pl.n(0, 2)):
                pl.center_item(
                    room,
                    "speaker",
                    (
                        rng.uniform(x0 + 0.2 * (x1 - x0), x1 - 0.2 * (x1 - x0)),
                        rng.uniform(y0 + 0.2 * (y1 - y0), y1 - 0.2 * (y1 - y0)),
                    ),
                    jitter=10,
                )
            if rng.random() < 0.4:
                pl.wall_item(room, "conduit_cobra", purpose="צ.קוברה")
        elif k == "kitchen":
            for _ in range(pl.n(2, 3)):
                pl.wall_item(room, "socket_double", height=110)
            for purpose in rng.sample(["למדיח", "למקרר", "לתנור", "למיקרוגל"], k=min(4, max(1, pl.n(1, 3)))):
                pl.wall_item(room, "socket_power", height=rng.choice([60, 110]), purpose=purpose)
            if rng.random() < 0.5:
                pl.wall_item(room, "socket_3phase", height=60, purpose="לכיריים")
            if rng.random() < 0.5:
                pl.wall_item(room, "socket_single", height=110)
        elif k in ("master", "bedroom", "study"):
            for _ in range(pl.n(1, 3)):
                pl.wall_item(room, "socket_single", height=30)
            for _ in range(pl.n(1, 2)):
                pl.wall_item(room, "socket_double", height=30)
            if rng.random() < 0.6:
                pl.wall_item(room, "tv_point", height=30)
            if rng.random() < 0.6 or k == "study":
                pl.wall_item(room, "data_point", height=30)
            if rng.random() < 0.3:
                pl.wall_item(room, "phone_point", height=30)
            if k != "study" or rng.random() < 0.5:
                pl.wall_item(room, "socket_ac", height=rng.choice([220, 240]), purpose="למזגן")
            if rng.random() < 0.25:
                pl.wall_item(room, "socket_triple", height=30)
        elif k == "mamad":
            for _ in range(pl.n(1, 2)):
                pl.wall_item(room, "socket_single", height=30)
            pl.wall_item(room, "data_point", height=30)
            if rng.random() < 0.6:
                pl.wall_item(room, "socket_ac", height=220, purpose="למזגן")
            if rng.random() < 0.3:
                pl.wall_item(room, "socket_3phase", height=220, purpose="למזגן")
        elif k in ("bath", "shower"):
            pl.wall_item(room, "socket_waterproof", height=110)
            if rng.random() < 0.6:
                pl.wall_item(room, "socket_power", height=200, purpose=rng.choice(["לתנור", "לונטה", "לתנור חימום"]))
        elif k == "wc":
            if rng.random() < 0.4:
                pl.wall_item(room, "socket_waterproof", height=110)
        elif k == "laundry":
            pl.wall_item(room, "socket_power", height=110, purpose="למכונת כביסה")
            if rng.random() < 0.5:
                pl.wall_item(room, "socket_waterproof", height=110)
        elif k in ("corridor", "entry", "storage"):
            if rng.random() < 0.6:
                pl.wall_item(room, "socket_single", height=30)
            if rng.random() < 0.4:
                pl.wall_item(room, "junction_box", height=250)


# ============================================================================================ lighting
def place_lighting(pl: Placer) -> None:
    rng = pl.rng
    m = pl.m
    for room in pl.plan.rooms:
        k = room.kind
        x0, y0, x1, y1 = room.net
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        lum: list[int] = []

        def add(p: Placed | None, lum: list[int] = lum) -> None:
            if p is not None:
                lum.append(len(pl.out) - 1)

        def grid(nmax: int, room: Room = room, net: tuple[float, float, float, float] = room.net, lum: list[int] = lum) -> None:
            gx0, gy0, gx1, gy1 = net
            nx = max(1, min(nmax, int((gx1 - gx0) / (1.4 * m))))
            ny = max(1, min(nmax, int((gy1 - gy0) / (1.4 * m))))
            for i in range(nx):
                for j in range(ny):
                    pos = (gx0 + (i + 0.5) * (gx1 - gx0) / nx, gy0 + (j + 0.5) * (gy1 - gy0) / ny)
                    add(pl.center_item(room, "luminaire_recessed", pos, jitter=3), lum)

        if k in ("living", "family"):
            if rng.random() < 0.5:
                grid(3)
            else:
                add(pl.center_item(room, "luminaire_ceiling", (cx, cy), jitter=8))
            dining = [f for f in pl.plan.furniture if f.kind == "dining" and f.room == room.rid]
            if dining:
                b = dining[0].bbox
                add(pl.center_item(room, "luminaire_pendant", ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2), jitter=4))
            if rng.random() < 0.5:
                add(pl.wall_item(room, "luminaire_strip", params={"length": rng.uniform(1.5, 3.0) * m / pl.spec.sym_u}))
            if rng.random() < 0.4:
                add(pl.wall_item(room, "luminaire_wall", height=180))
        elif k == "kitchen":
            if rng.random() < 0.6:
                grid(2)
            else:
                add(pl.center_item(room, "luminaire_ceiling", (cx, cy), jitter=8))
            counters = [f for f in pl.plan.furniture if f.kind == "counter" and f.room == room.rid]
            if counters and rng.random() < 0.7:
                b = counters[0].bbox
                bx, by = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
                side = min(("N", "S", "W", "E"), key=lambda s: abs({"N": by - y0, "S": y1 - by, "W": bx - x0, "E": x1 - bx}[s]))
                length = max(b[2] - b[0], b[3] - b[1]) * 0.7 / pl.spec.sym_u
                add(
                    pl.wall_item(
                        room, "luminaire_strip", near=bx if side in ("N", "S") else by, near_side=side, params={"length": length}
                    )
                )
        elif k in ("master", "bedroom"):
            if rng.random() < 0.35:
                add(pl.center_item(room, "ceiling_fan", (cx, cy), jitter=8))
                add(pl.center_item(room, "luminaire_ceiling", (cx, y0 + (y1 - y0) * 0.25), jitter=8))
            else:
                add(pl.center_item(room, "luminaire_ceiling", (cx, cy), jitter=8))
            if k == "master" and rng.random() < 0.5:
                for _ in range(2):
                    add(pl.wall_item(room, "luminaire_wall", height=150))
        elif k in ("bath", "shower", "wc"):
            if rng.random() < 0.5:
                add(pl.center_item(room, "luminaire_recessed", (cx, cy), jitter=5))
            else:
                add(pl.center_item(room, "luminaire_ceiling", (cx, cy), jitter=5))
            if k != "wc" and rng.random() < 0.7:
                add(pl.wall_item(room, "luminaire_wall", height=200))
        elif k in ("corridor", "entry"):
            if rng.random() < 0.6:
                grid(3)
            else:
                add(pl.center_item(room, "luminaire_ceiling", (cx, cy), jitter=8))
        elif k == "stairs":
            add(pl.wall_item(room, "luminaire_wall", height=200))
        else:
            add(pl.center_item(room, "luminaire_ceiling", (cx, cy), jitter=8))
        if not lum:
            continue
        # switches
        groups = sorted({pl.out[i].fine for i in lum})
        doors = pl.doors_of(room)
        if not doors:
            continue
        doors.sort(key=lambda o: (o.kind != "entrance", o.oid))
        two_way = (k == "corridor" and len(doors) >= 2) or (k == "master" and rng.random() < 0.4 and len(doors) >= 1)
        if two_way:
            spots = [pl.near_door(room, doors[0])]
            if k == "corridor":
                spots.append(pl.near_door(room, doors[-1]))
            sw = []
            for side, t in spots:
                p = pl.wall_item(room, "switch_2way", near=t, near_side=side, height=110)
                if p is None:
                    p = pl.wall_item(room, "switch_2way", height=110)
                if p is not None:
                    sw.append(p)
            if k == "master" and len(sw) == 1:
                p = pl.wall_item(room, "switch_2way", height=110)
                if p is not None:
                    sw.append(p)
            for p in sw:
                p.controls = list(lum)
        else:
            fine = {1: "switch_single", 2: "switch_2gang"}.get(len(groups), "switch_3gang")
            side, t = pl.near_door(room, doors[0])
            p = pl.wall_item(room, fine, near=t, near_side=side, height=110)
            if p is None:
                p = pl.wall_item(room, fine, height=110)
            if p is not None:
                p.controls = list(lum)
        if k in ("living", "master", "bedroom", "family") and rng.random() < 0.5:
            pl.wall_item(room, "switch_shutter", height=110)
    if pl.spec.type_tags:
        _type_tags(pl)


def _type_tags(pl: Placer) -> None:
    lum_classes = sorted({p.fine for p in pl.out if p.fine.startswith(("luminaire", "ceiling_fan"))})
    numbers = {f: i + 1 for i, f in enumerate(lum_classes)}
    r = max(1.3, pl.spec.sym_u * 0.32)
    for p in pl.out:
        if p.fine not in numbers or p.type_tag is not None:
            continue
        bb = p.bbox
        for dx, dy in ((1, -1), (1, 1), (-1, -1), (-1, 1)):
            c = (bb[2] + r + 0.6 if dx > 0 else bb[0] - r - 0.6, bb[1] - r * 0.6 if dy < 0 else bb[3] + r * 0.6)
            tb = (c[0] - r, c[1] - r, c[0] + r, c[1] + r)
            if pl._free(tb, 0.2):
                n = numbers[p.fine]
                p.labels.append(Circle(c, r))
                p.labels.append(Text(str(n), c, r * 0.95, 0.0, "c", "m", role="type_tag"))
                p.label_boxes.append(tb)
                pl.occ.append(tb)
                p.type_tag = n
                p.annotations.append(f"type:{n}")
                break


# ============================================================================================ plumbing
def context_fixtures(pl: Placer) -> list[Placed]:
    """Sanitary fixtures drawn as grey architectural background (non-plumbing sheets)."""
    out = []
    for fx in pl.plan.fixtures:
        room = pl.plan.room(fx.room)
        sid = f"{fx.fine}/s1"
        local = build(sid, pl.m, 0.18, fx.params)
        rot = SIDE_ROT[fx.side]
        ref = SymbolRef("", sid, local, fx.c, rot, False, "", Pen())
        bb = bbox_of([q for p in expand(ref) for q in prim_points(p, pl.font)])
        p = Placed(
            fx.fine,
            sid,
            fx.c,
            rot,
            False,
            local,
            bb,
            room.rid,
            pl.plan.floor,
            CLASSES[fx.fine].taxonomy,
            CLASSES[fx.fine].taxonomy,
            context=True,
        )
        pl.occ.append(bb)
        out.append(p)
    return out


def place_plumbing(pl: Placer) -> None:
    rng = pl.rng
    fixtures: list[Placed] = []
    for fx in pl.plan.fixtures:
        room = pl.plan.room(fx.room)
        rot = SIDE_ROT[fx.side]
        local, bb, mirror = pl._make(fx.fine, fx.c, rot, fx.params, mirror=False)
        p = Placed(
            fx.fine,
            pl.spec.styles[fx.fine],
            fx.c,
            rot,
            mirror,
            local,
            bb,
            room.rid,
            pl.plan.floor,
            CLASSES[fx.fine].taxonomy,
            CLASSES[fx.fine].taxonomy,
        )
        p.params = dict(fx.params)
        p.exploded = rng.random() < pl.spec.p_exploded
        pl._commit(p, [])
        fixtures.append(p)
    # water points next to fixtures, on the same wall
    points: list[tuple[Placed, str]] = []
    need = {
        "fixture_basin": ("hot", "cold"),
        "fixture_kitchen_sink": ("hot", "cold"),
        "fixture_shower": ("hot", "cold"),
        "fixture_bath": ("hot", "cold"),
        "fixture_wc_concealed": ("cold",),
        "fixture_wc_monoblock": ("cold",),
        "fixture_washing_machine": ("cold",),
    }
    hmap = {"fixture_basin": 55, "fixture_kitchen_sink": 55, "fixture_shower": 110, "fixture_bath": 70}
    for fx, p in zip(pl.plan.fixtures, fixtures, strict=True):
        room = pl.plan.room(fx.room)
        along = 0 if fx.side in ("N", "S") else 1
        half = (fx.extent[2] - fx.extent[0]) / 2 if along == 0 else (fx.extent[3] - fx.extent[1]) / 2
        base = fx.c[along]
        for i, sysname in enumerate(need.get(fx.fine, ())):
            fine = "water_point_hot" if sysname == "hot" else "water_point_cold"
            sgn = -1.0 if i == 0 else 1.0
            t = base + sgn * (half + pl.spec.sym_u * 0.7)
            q = pl.wall_item(
                room, fine, near=t, near_side=fx.side, height=hmap.get(fx.fine, 60 if sysname == "cold" else None), tries=6
            )
            if q is not None:
                points.append((q, sysname))
    # floor drains
    for room in pl.plan.rooms:
        if room.kind not in ("bath", "shower", "laundry"):
            continue
        x0, y0, x1, y1 = room.net
        for f in (0.5, 0.35, 0.65):
            if pl.center_item(room, "floor_drain", (x0 + (x1 - x0) * f, y0 + (y1 - y0) * (1 - f)), jitter=4) is not None:
                break
    _pipes(pl, fixtures, points)


def _perimeter_path(net: tuple[float, float, float, float], a: Pt, b: Pt) -> list[Pt]:
    """Shortest path between two points on the boundary of rectangle ``net`` along that boundary."""
    x0, y0, x1, y1 = net
    W, H = x1 - x0, y1 - y0
    P = 2 * (W + H)

    def s_of(p: Pt) -> float:
        x, y = p
        d = {abs(y - y0): 0, abs(x - x1): 1, abs(y - y1): 2, abs(x - x0): 3}
        side = d[min(d)]
        if side == 0:
            return x - x0
        if side == 1:
            return W + (y - y0)
        if side == 2:
            return W + H + (x1 - x)
        return 2 * W + H + (y1 - y)

    corners = [(W, (x1, y0)), (W + H, (x1, y1)), (2 * W + H, (x0, y1)), (P, (x0, y0))]
    sa, sb = s_of(a), s_of(b)
    fwd = (sb - sa) % P
    out = [a]
    if fwd <= P - fwd:
        for s, c in corners + [(s + P, c) for s, c in corners]:
            if sa < s < sa + fwd:
                out.append(c)
    else:
        back = P - fwd
        for s, c in sorted([(s - P, c) for s, c in corners] + corners, key=lambda q: -q[0]):
            if sa - back < s < sa:
                out.append(c)
    out.append(b)
    return [p for i, p in enumerate(out) if i == 0 or math.dist(p, out[i - 1]) > 1e-6]


def _snap_to(net: tuple[float, float, float, float], p: Pt) -> Pt:
    x0, y0, x1, y1 = net
    x = min(max(p[0], x0), x1)
    y = min(max(p[1], y0), y1)
    d = {abs(y - y0): (x, y0), abs(x - x1): (x1, y), abs(y - y1): (x, y1), abs(x - x0): (x0, y)}
    return d[min(d)]


def _pipes(pl: Placer, fixtures: list[Placed], points: list[tuple[Placed, str]]) -> None:
    """Supply pipes run along the walls of each wet room from a manifold (מחלק) in a corner of that room; sewer
    pipes run straight to a floor stack in the same room. Nothing crosses another room or the ממ"ד."""
    rng = pl.rng
    by_room: dict[str, list[tuple[Placed, str]]] = {}
    for p, sysname in points:
        by_room.setdefault(p.room_id, []).append((p, sysname))
    for rid, pts in sorted(by_room.items()):
        room = pl.plan.room(rid)
        x0, y0, x1, y1 = room.net
        for sysname, off in (("cold", 1.2), ("hot", 2.2)):
            mine = [p for p, s in pts if s == sysname]
            if not mine:
                continue
            net = (x0 + off, y0 + off, x1 - off, y1 - off)
            corner = (net[0], net[1]) if rng.random() < 0.5 else (net[2], net[3])
            for p in mine:
                target = _snap_to(net, p.insert)
                path = _perimeter_path(net, corner, target)
                if math.dist(target, p.insert) > 1e-6:
                    path.append(p.insert)
                dia = 20 if sysname == "hot" else rng.choice([16, 20, 20, 25])
                _add_pipe(pl, sysname, dia, path)
    for f in fixtures:
        if f.fine == "fixture_kitchen_sink" or (f.fine == "fixture_washing_machine" and rng.random() < 0.5):
            continue
        room = pl.plan.room(f.room_id)
        x0, y0, x1, y1 = room.net
        stack = (x0 + 3.0, y1 - 3.0)
        c = ((f.bbox[0] + f.bbox[2]) / 2, (f.bbox[1] + f.bbox[3]) / 2)
        dia = 110 if f.fine.startswith("fixture_wc") else rng.choice([50, 50, 75])
        mid = (c[0], stack[1]) if rng.random() < 0.5 else (stack[0], c[1])
        _add_pipe(pl, "sewer", dia, [c, mid, stack])


def _add_pipe(pl: Placer, system: str, dia: int, pts: list[Pt]) -> None:
    pts = [p for i, p in enumerate(pts) if i == 0 or math.dist(p, pts[i - 1]) > 1e-6]
    if len(pts) < 2:
        return
    length = sum(math.dist(a, b) for a, b in itertools.pairwise(pts)) / pl.m
    if length < 0.05:
        return
    pipe = Pipe(system, dia, pts, round(length, 3), pl.plan.floor)
    # label on the longest segment
    seg = max(itertools.pairwise(pts), key=lambda s: math.dist(*s))
    mx, my = (seg[0][0] + seg[1][0]) / 2, (seg[0][1] + seg[1][1]) / 2
    vertical = abs(seg[0][0] - seg[1][0]) < 1e-6
    t = Text(
        f"Ø{dia}",
        (mx + (0.8 if vertical else 0.0), my - (0.0 if vertical else 0.6)),
        pl.lh * 0.85,
        90.0 if vertical else 0.0,
        "c",
        "b",
        role="pipe_label",
    )
    tb = bbox_of(prim_points(t, pl.font))
    if pl._free(tb, 0.2) and not any(bbox_overlap(tb, o, 0.0) for o in pl.wall_boxes):
        pipe.label = t
        pl.occ.append(bbox_grow(tb, 0.0))
    pl.pipes.append(pipe)
