"""Cross-sheet de-duplication by authority (an item drawn on both the electrical and the lighting sheet of a
floor is counted once).

For each ``authority`` rule ``{family, classes, discipline, radiusMm}`` (``radiusMm`` real-world mm → paper mm
with the authoritative sheet's scale) and each floor: the detections of those classes
on a sheet of *another* discipline (secondary) are compared with the authoritative sheet(s) of that floor:

1. **align** the secondary sheet onto each authoritative sheet (paper mm; scale ratio from the sheets' scale
   denominators): every (secondary, authoritative) pair of same-rule items votes for the translation that
   would superimpose them (2 mm bins, 3×3 neighbourhood); the best-supported translation is accepted when,
   after it, ≥ 3 items *and* ≥ half of the secondary items find a partner within ``radiusMm``. Otherwise,
   when both pages have the same size and rotation (one CAD layout plotted twice), the identity placement is
   used. The authoritative sheet with the most matches wins.
2. **match** greedily by distance ≤ ``radiusMm`` (after alignment): matched secondary items are dropped
   (``dropped_by`` = the authoritative detection); unmatched ones are kept with ``פריט מגיליון משני``.
   When no alignment is accepted nothing is dropped and the items carry ``יישור גיליונות נכשל — ייתכן כפל``.

Secondary items are only compared when the floor *has* an authoritative sheet. Otherwise (e.g. a floor with an
electrical sheet but no lighting sheet) the secondary sheet with the most items of the family acts as the
authority for that floor (Sprint 4: fixtures drawn on both the construction and the architecture plan of a floor
without a plumbing sheet are counted once); with a single secondary sheet nothing changes.

``unmatchedSecondary: 'drop'`` (Sprint 4, fixtures — :data:`DROP_FAMILIES` by default): on a floor that has an authoritative sheet, *every* secondary
item of the family is dropped — matched or not, aligned or not (the plumbing sheet is the plan of record for
fixtures; text-anchored fixtures are too few to vote an alignment).

``authorityOrder`` + ``matchRooms`` (Sprint 4 integration, AC — :data:`AUTHORITY_ORDER` / :data:`ROOM_FAMILIES` by
default): the authority of a floor is the first discipline of the order that has a sheet on that floor (AC: the
plumbing sheet's drain marks; the electrical AC sockets only fill floors without a plumbing sheet). Secondary items
are placed on the authoritative sheet by the translation that superimposes the two sheets' *room outlines*
(``rooms.align.align_polygons``; item votes / identity as fallbacks) and matched one-to-one: same room first, else
within ``radiusMm`` (AC 1.6 m — a drain mark and the socket of the same unit are 0.3–1 m apart). Matched copies
are dropped, the others kept (``פריט מגיליון משני``, yellow: a unit the plumbing sheet does not show); without any
alignment every secondary item is dropped (the plan of record wins).
"""

from __future__ import annotations

import math
from collections import Counter, defaultdict
from dataclasses import dataclass, field

from .rules import R_ALIGN_FAILED, R_SECONDARY, Rule

BIN_MM = 2.0
DEFAULT_SCALE = 50
MIN_VOTES = 3  # matched pairs needed to accept a voted translation
# families whose secondary items are all dropped on floors that have an authoritative sheet (worker constant until
# contracts carry ``unmatchedSecondary``): the plumbing sheet is the plan of record for fixtures
DROP_FAMILIES = frozenset({"fixtures"})
# authority by floor: the first discipline of the order with a sheet on the floor (worker default until contracts
# carry ``authorityOrder``); room-aware one-to-one matching for these families (``matchRooms``)
AUTHORITY_ORDER: dict[str, tuple[str, ...]] = {"ac": ("plumbing", "electrical")}
ROOM_FAMILIES = frozenset({"ac"})
ROOM_MATCH_RADIUS_MM = {"ac": 1600.0}  # real-world mm
ROOM_TOL_MM = 800.0  # real mm: an item drawn in / on the wall belongs to the nearest room this close


@dataclass
class Det:
    sheet_id: str
    version_id: str
    id: str
    cls: str
    x: float
    y: float
    level: str
    reasons: list[str]
    floor: str | None
    lifecycle: str
    supply: str | None
    discipline: str
    score: float = 0.0
    item_code: str | None = None  # user-chosen item (confirmed legend entry / symbol mapping)
    code_rule: str | None = None  # ruleId-like origin of item_code
    dropped_by: str | None = None
    room: str | None = None  # room name (rooms artifact), None outside every room
    annotations: tuple[str, ...] = ()
    room_id: str | None = None  # roomId on its own sheet
    source: str = "auto"  # auto | manual (added / measured by a correction)
    correction_id: str | None = None
    verified: bool = False  # accepted / reclassified / added by a human

    @property
    def key(self) -> str:
        return f"{self.sheet_id}/{self.id}"


@dataclass
class SheetMeta:
    sheet_id: str
    discipline: str
    scale: int | None
    floors: list[str]
    page: tuple[float, float, int]  # widthMm, heightMm, rotation
    rooms: list[tuple[str | None, list[tuple[float, float]]]] = field(default_factory=list)  # (floor, polygon mm)


@dataclass
class DedupStats:
    dropped: int = 0
    secondary_kept: int = 0
    align_failed: int = 0
    dropped_unmatched: int = 0
    alignments: list[dict[str, object]] = field(default_factory=list)


def _offset_vote(a: list[tuple[float, float]], b: list[tuple[float, float]], k: float) -> tuple[int, float, float]:
    """(support, tx, ty) of the best translation t with b ≈ k·a + t."""
    bins: Counter[tuple[int, int]] = Counter()
    offs: list[tuple[float, float]] = []
    for ax, ay in a:
        for bx, by in b:
            dx, dy = bx - k * ax, by - k * ay
            offs.append((dx, dy))
            bins[(math.floor(dx / BIN_MM), math.floor(dy / BIN_MM))] += 1
    if not bins:
        return 0, 0.0, 0.0
    best: tuple[int, float, tuple[int, int]] | None = None
    for i, j in bins:
        s = sum(bins.get((i + di, j + dj), 0) for di in (-1, 0, 1) for dj in (-1, 0, 1))
        cand = (s, -math.hypot(i, j), (i, j))
        if best is None or cand > best:
            best = cand
    assert best is not None
    ci, cj = best[2]
    inl = [(dx, dy) for dx, dy in offs if abs(dx / BIN_MM - (ci + 0.5)) <= 1.5 and abs(dy / BIN_MM - (cj + 0.5)) <= 1.5]
    tx = sum(o[0] for o in inl) / len(inl)
    ty = sum(o[1] for o in inl) / len(inl)
    return best[0], tx, ty


def _match(a: list[Det], b: list[Det], k: float, tx: float, ty: float, radius: float) -> dict[str, Det]:
    pairs = []
    for da in a:
        px, py = k * da.x + tx, k * da.y + ty
        for db in b:
            d = math.hypot(db.x - px, db.y - py)
            if d <= radius:
                pairs.append((d, da.key, db.key, da, db))
    pairs.sort(key=lambda p: (p[0], p[1], p[2]))
    used_a: set[str] = set()
    used_b: set[str] = set()
    out: dict[str, Det] = {}
    for _, ka, kb, _da, db in pairs:
        if ka in used_a or kb in used_b:
            continue
        used_a.add(ka)
        used_b.add(kb)
        out[ka] = db
    return out


def _room_polys(meta: SheetMeta, floor: str) -> list[list[tuple[float, float]]]:
    return [p for f, p in meta.rooms if len(p) >= 3 and (f is None or f == floor)]


def _room_align(sec: SheetMeta, au: SheetMeta, floor: str) -> tuple[float, float] | None:
    """Translation sec → au (paper mm) from the room outlines of the floor on both sheets (same scale only)."""
    if sec.scale and au.scale and sec.scale != au.scale:
        return None
    pa, pb = _room_polys(sec, floor), _room_polys(au, floor)
    if not pa or not pb:
        return None
    try:
        from ..rooms.align import align_polygons

        al = align_polygons(pa, pb)
    except Exception:  # noqa: BLE001 - geometry edge cases: fall back to item votes
        return None
    if al is None or al.iou < 0.4:
        return None
    return al.dx, al.dy


def _room_matches(
    a: list[Det], b: list[Det], k: float, tx: float, ty: float, radius: float, polys: list[list[tuple[float, float]]], tol: float
) -> dict[str, Det]:
    """One-to-one matches secondary → authoritative item: same room of the authoritative sheet first (nearest
    pair), then by distance ≤ ``radius`` (paper mm on the authoritative sheet)."""
    from shapely.geometry import Point, Polygon

    rooms = [Polygon(p).buffer(0) for p in polys]

    def room_of(x: float, y: float) -> int | None:
        pt = Point(x, y)
        best: tuple[float, int] | None = None
        for i, r in enumerate(rooms):
            d = r.distance(pt)
            if d == 0:
                return i
            if d <= tol and (best is None or d < best[0]):
                best = (d, i)
        return best[1] if best else None

    pa = {d.key: (k * d.x + tx, k * d.y + ty) for d in a}
    ra = {key: room_of(*xy) for key, xy in pa.items()}
    rb = {d.key: room_of(d.x, d.y) for d in b}
    pairs = []
    for da in a:
        for db in b:
            dist = math.hypot(db.x - pa[da.key][0], db.y - pa[da.key][1])
            same = ra[da.key] is not None and ra[da.key] == rb[db.key]
            if same or dist <= radius:
                pairs.append((0 if same else 1, dist, da.key, db.key, db))
    pairs.sort(key=lambda q: (q[0], q[1], q[2], q[3]))
    used_a: set[str] = set()
    used_b: set[str] = set()
    out: dict[str, Det] = {}
    for _, _, ka, kb, db in pairs:
        if ka in used_a or kb in used_b:
            continue
        used_a.add(ka)
        used_b.add(kb)
        out[ka] = db
    return out


def _dedup_rooms(rule: Rule, by: dict[tuple[str, str], list[Det]], sheets: dict[str, SheetMeta], stats: DedupStats) -> None:
    """``matchRooms`` families (AC): per floor, the authority is the first discipline of ``authorityOrder`` with a
    sheet on that floor; the other sheets' items are aligned by room outlines and matched one-to-one."""
    family = str(rule.match.get("family") or "")
    order = list(rule.match.get("authorityOrder") or AUTHORITY_ORDER.get(family) or [str(rule.match.get("discipline") or "")])
    radius_real = float(
        rule.match.get("roomMatchRadiusMm") or ROOM_MATCH_RADIUS_MM.get(family) or rule.match.get("radiusMm") or 150.0
    )
    floors = sorted({f for f, _ in by} | {f for s in sheets.values() for f in s.floors})
    for floor in floors:
        on_floor = sorted(s for s, m in sheets.items() if floor in m.floors)
        disc = next((d for d in order if any(sheets[s].discipline == d for s in on_floor)), None)
        if disc is None:
            continue
        auth_sheets = [s for s in on_floor if sheets[s].discipline == disc]
        for sec in on_floor:
            if sec in auth_sheets:
                continue
            a = sorted(by.get((floor, sec), []), key=lambda d: d.key)
            if not a:
                continue
            ms = sheets[sec]
            best: tuple[int, str, float, float, float, str, float] | None = None
            for au in auth_sheets:
                ma = sheets[au]
                b = by.get((floor, au), [])
                k = (ms.scale / ma.scale) if (ms.scale and ma.scale) else 1.0
                radius = radius_real / float(ma.scale or DEFAULT_SCALE)
                cand: tuple[float, float, str] | None = None
                t = _room_align(ms, ma, floor)
                if t is not None:
                    cand = (t[0], t[1], "rooms")
                elif b:
                    _, tx, ty = _offset_vote([(d.x, d.y) for d in a], [(d.x, d.y) for d in b], k)
                    n = len(_match(a, b, k, tx, ty, radius))
                    if n >= MIN_VOTES and n >= math.ceil(len(a) / 2):
                        cand = (tx, ty, "votes")
                if cand is None and ms.page == ma.page and ms.page[0] > 0:
                    cand = (0.0, 0.0, "identity")
                if cand is None:
                    continue
                n = len(
                    _room_matches(
                        a, b, k, cand[0], cand[1], radius, _room_polys(ma, floor), ROOM_TOL_MM / float(ma.scale or DEFAULT_SCALE)
                    )
                )
                if best is None or n > best[0]:
                    best = (n, au, k, cand[0], cand[1], cand[2], radius)
            if best is None:  # no placement: the plan of record wins
                for d in a:
                    d.dropped_by = f"{auth_sheets[0]}/*"
                stats.dropped += len(a)
                stats.dropped_unmatched += len(a)
                stats.alignments.append({"rule": rule.id, "floor": floor, "secondary": sec, "authority": auth_sheets[0],
                                         "support": len(a), "how": "drop", "t": [0.0, 0.0]})  # fmt: skip
                continue
            sup, au, k, tx, ty, how, radius = best
            ma = sheets[au]
            matched = _room_matches(
                a,
                by.get((floor, au), []),
                k,
                tx,
                ty,
                radius,
                _room_polys(ma, floor),
                ROOM_TOL_MM / float(ma.scale or DEFAULT_SCALE),
            )
            stats.alignments.append({"rule": rule.id, "floor": floor, "secondary": sec, "authority": au, "support": sup,
                                     "how": how, "t": [round(tx, 2), round(ty, 2)]})  # fmt: skip
            for d in a:
                if d.key in matched:
                    d.dropped_by = matched[d.key].key
                    stats.dropped += 1
                else:
                    if R_SECONDARY not in d.reasons:
                        d.reasons.append(R_SECONDARY)
                    if d.level == "green":
                        d.level = "yellow"
                    stats.secondary_kept += 1


def dedup(dets: list[Det], sheets: dict[str, SheetMeta], rules: list[Rule]) -> DedupStats:
    """Mark secondary duplicates (``dropped_by``) in place; add reasons to kept secondary items."""
    stats = DedupStats()
    for rule in (r for r in rules if r.kind == "authority"):
        classes = set(rule.classes)
        disc = str(rule.match.get("discipline") or "")
        if rule.match.get("matchRooms", rule.match.get("family") in ROOM_FAMILIES):
            by_r: dict[tuple[str, str], list[Det]] = defaultdict(list)
            for d in dets:
                if d.cls in classes and d.floor and d.dropped_by is None:
                    by_r[(d.floor, d.sheet_id)].append(d)
            _dedup_rooms(rule, by_r, sheets, stats)
            continue
        radius_real = float(rule.match.get("radiusMm") or 150.0)  # real-world mm
        by: dict[tuple[str, str], list[Det]] = defaultdict(list)  # (floor, sheet) -> items
        for d in dets:
            if d.cls in classes and d.floor and d.dropped_by is None:
                by[(d.floor, d.sheet_id)].append(d)
        drop_unmatched = (
            rule.match.get("unmatchedSecondary", "drop" if rule.match.get("family") in DROP_FAMILIES else "keep") == "drop"
        )
        floors = sorted({f for f, _ in by} | {f for s in sheets.values() for f in s.floors})
        for floor in floors:
            auth_sheets = sorted(s for s, m in sheets.items() if m.discipline == disc and floor in m.floors)
            fallback = False
            if not auth_sheets:
                with_items = sorted(
                    (s for s in sheets if floor in sheets[s].floors and by.get((floor, s))),
                    key=lambda s: (-len(by[(floor, s)]), s),
                )
                if len(with_items) < 2:
                    continue
                auth_sheets, fallback = [with_items[0]], True
            for sec in sorted(
                s for s, m in sheets.items() if floor in m.floors and s not in auth_sheets and (fallback or m.discipline != disc)
            ):
                a = sorted(by.get((floor, sec), []), key=lambda d: d.key)
                if not a:
                    continue
                if drop_unmatched and not fallback:
                    for d in a:
                        d.dropped_by = f"{auth_sheets[0]}/*"
                    stats.dropped += len(a)
                    stats.dropped_unmatched += len(a)
                    stats.alignments.append({"rule": rule.id, "floor": floor, "secondary": sec, "authority": auth_sheets[0],
                                             "support": len(a), "how": "drop", "t": [0.0, 0.0]})  # fmt: skip
                    continue
                best: tuple[int, str, float, float, float, str, float] | None = None
                for au in auth_sheets:
                    b = by.get((floor, au), [])
                    ms, ma = sheets[sec], sheets[au]
                    k = (ms.scale / ma.scale) if (ms.scale and ma.scale) else 1.0
                    radius = radius_real / float(ma.scale or DEFAULT_SCALE)  # paper mm on the authoritative sheet
                    cand: tuple[int, float, float, str] | None = None
                    if b:
                        _, tx, ty = _offset_vote([(d.x, d.y) for d in a], [(d.x, d.y) for d in b], k)
                        n = len(_match(a, b, k, tx, ty, radius))
                        if n >= MIN_VOTES and n >= math.ceil(len(a) / 2):
                            cand = (n, tx, ty, "votes")
                    if cand is None and ms.page == ma.page and ms.page[0] > 0:
                        # same page layout (one CAD layout plotted twice): identity placement
                        cand = (len(_match(a, b, k, 0.0, 0.0, radius)), 0.0, 0.0, "identity")
                    if cand is not None and (best is None or cand[0] > best[0]):
                        best = (cand[0], au, k, cand[1], cand[2], cand[3], radius)
                if best is None:
                    for d in a:
                        if R_ALIGN_FAILED not in d.reasons:
                            d.reasons.append(R_ALIGN_FAILED)
                        if d.level == "green":
                            d.level = "yellow"
                    stats.align_failed += len(a)
                    continue
                sup, au, k, tx, ty, how, radius = best
                stats.alignments.append(
                    {
                        "rule": rule.id,
                        "floor": floor,
                        "secondary": sec,
                        "authority": au,
                        "support": sup,
                        "how": how,
                        "t": [round(tx, 2), round(ty, 2)],
                    }
                )
                matched = _match(a, by.get((floor, au), []), k, tx, ty, radius)
                for d in a:
                    if d.key in matched:
                        d.dropped_by = matched[d.key].key
                        stats.dropped += 1
                    else:
                        if R_SECONDARY not in d.reasons:
                            d.reasons.append(R_SECONDARY)
                        if d.level == "green":
                            d.level = "yellow"
                        stats.secondary_kept += 1
    return stats
