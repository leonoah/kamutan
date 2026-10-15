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

Secondary items are only compared when the floor *has* an authoritative sheet; otherwise they are counted as
they are (e.g. a floor with an electrical sheet but no lighting sheet).
"""

from __future__ import annotations

import math
from collections import Counter, defaultdict
from dataclasses import dataclass, field

from .rules import R_ALIGN_FAILED, R_SECONDARY, Rule

BIN_MM = 2.0
DEFAULT_SCALE = 50
MIN_VOTES = 3  # matched pairs needed to accept a voted translation


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


@dataclass
class DedupStats:
    dropped: int = 0
    secondary_kept: int = 0
    align_failed: int = 0
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


def dedup(dets: list[Det], sheets: dict[str, SheetMeta], rules: list[Rule]) -> DedupStats:
    """Mark secondary duplicates (``dropped_by``) in place; add reasons to kept secondary items."""
    stats = DedupStats()
    for rule in (r for r in rules if r.kind == "authority"):
        classes = set(rule.classes)
        disc = str(rule.match.get("discipline") or "")
        radius_real = float(rule.match.get("radiusMm") or 150.0)  # real-world mm
        by: dict[tuple[str, str], list[Det]] = defaultdict(list)  # (floor, sheet) -> items
        for d in dets:
            if d.cls in classes and d.floor and d.dropped_by is None:
                by[(d.floor, d.sheet_id)].append(d)
        floors = sorted({f for f, _ in by} | {f for s in sheets.values() for f in s.floors})
        for floor in floors:
            auth_sheets = sorted(s for s, m in sheets.items() if m.discipline == disc and floor in m.floors)
            if not auth_sheets:
                continue
            for sec in sorted(s for s, m in sheets.items() if m.discipline != disc and floor in m.floors):
                a = sorted(by.get((floor, sec), []), key=lambda d: d.key)
                if not a:
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
