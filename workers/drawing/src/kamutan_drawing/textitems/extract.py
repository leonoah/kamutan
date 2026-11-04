"""Text & equipment items of one sheet → ``text_items.json.gz`` (``kamutan.textItems/1``, shape in NOTES "Sprint 6 —
text & equipment items").

Flow (:func:`extract`, pure):

1. **lines** of ``text.json.gz`` (index kept for ``lineIdx`` / evidence ``text_{n}``); lines inside the title block
   are dropped (client / project names never leave it); lines inside a legend table become ``legend_row`` items.
2. **detail boxes**: a title "פרט A קנ"מ 1:20" + the lines stacked under it = kind ``detail`` (the definition — never
   counted); its content is attached to every ``detail_ref`` ("פרט A" elsewhere on the sheet) as
   ``normalized = "פרט A → <content>"``.
3. **note blocks**: horizontal lines stacked (gap ≤ 0.7 line height) and aligned (same right / left edge or ≥ 50 %
   overlap), cut where an underline separates them; rotated lines are one-line notes. A block with a leader
   (:class:`fixtures.leaders.LeaderIndex`) is a ``callout`` whose ``anchorMm`` is the leader's terminal.
4. **conduit runs** (:mod:`textitems.conduits`) when a legend row names a conduit ("צינור קוברה"): kind
   ``conduit``, ``lengthM`` = drawn length × scale, text = the notes at its ends ("קוברה+ שקע בתקרה למקרן").
5. **catalog** (:mod:`textitems.catalog`): every match of an entry in a block (per line it starts on) is one item;
   unmatched blocks are kept (``matchedPattern: null``) so org ``text_item`` rules can still match them.
6. **pairing / grouping** on the sheet: switch → nearest feed of the same entry on the same floor; notes of a
   ``group_mm`` entry closer than that; ``per_floor`` entries once per floor. Folded items get ``qty 0`` +
   ``pairedWith``.
7. **levels** through :func:`kamutan_drawing.calibration.calibrate` (key ``text:{itemCode}``, never green: the
   heuristic level is capped at yellow until text items have GT statistics).
"""

from __future__ import annotations

import gzip
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from ..calibration import calibrate
from ..ingest.pdf_vector import SEG_LINE, VectorSheet
from .catalog import (
    CATALOG,
    CATALOG_VERSION,
    R_ACCESS_FLOOR,
    R_ACCESS_SAME,
    R_CORROBORATES,
    R_GROUPED,
    R_NO_FLOOR,
    R_OCR_UNSURE,
    R_PAIRED,
    R_SUGGESTED,
    R_TEXT,
    Entry,
)
from .conduits import Run, find_runs
from .normalize import compile_pattern, detail_refs, has_hebrew, is_detail_title, normalize
from .qty import count_in_text, length_in_text_m, lifecycle_of

SCHEMA = "kamutan.textItems/1"
FILE = "text_items.json.gz"
MAX_ITEMS = 1500
MAX_TEXT = 400
KINDS = ("note", "callout", "detail_ref", "legend_row", "panel_schedule", "conduit")  # contracts TEXT_ITEM_KINDS
CONDUIT_LEGEND = re.compile(r"קוברה|צינור")
DETAIL_DEPTH_MM = 40.0
DETAIL_GAP_MM = 9.0
DETAIL_FIRST_GAP_MM = 20.0  # the detail's own drawing sits between its title and the description lines
CONDUIT_TEXT_MM = 8.0
LOW_OCR = 0.6

BBox = tuple[float, float, float, float]


@dataclass
class Line:
    idx: int
    text: str
    bbox: BBox  # the glyph box of the text line, clipped to ~1.4 font heights (see :func:`read_lines`)
    conf: float
    angle: float

    @property
    def h(self) -> float:
        return max(0.5, self.bbox[3] - self.bbox[1]) if self.horizontal else max(0.5, self.bbox[2] - self.bbox[0])

    @property
    def horizontal(self) -> bool:
        a = self.angle % 180.0
        return a < 30 or a > 150

    @property
    def center(self) -> tuple[float, float]:
        return ((self.bbox[0] + self.bbox[2]) / 2, (self.bbox[1] + self.bbox[3]) / 2)


@dataclass
class Block:
    kind: str
    lines: list[Line]
    anchor: tuple[float, float] | None = None
    leader: list[tuple[float, float]] | None = None
    extra: str = ""  # detail content / conduit end notes
    run: Run | None = None
    fuzzy: bool = False
    run_length_m: float | None = None

    @property
    def text(self) -> str:
        return " / ".join(ln.text.strip() for ln in self.lines)

    @property
    def bbox(self) -> BBox:
        if self.run is not None and not self.lines:
            return self.run.bbox
        b = [ln.bbox for ln in self.lines]
        return (min(x[0] for x in b), min(x[1] for x in b), max(x[2] for x in b), max(x[3] for x in b))

    @property
    def conf(self) -> float:
        return min((ln.conf for ln in self.lines), default=0.7)


@dataclass
class Item:
    kind: str
    block: Block
    lines: list[Line]
    entry: Entry | None = None
    match: str = ""
    role: str | None = None
    lifecycle: str | None = None
    qty: float | None = None
    length_m: float | None = None
    floor: str | None = None
    room_id: str | None = None
    paired_with: Item | None = None
    reasons: list[str] = field(default_factory=list)
    id: str = ""

    @property
    def box(self) -> BBox:
        return _bbox(self.lines) if self.lines else self.block.bbox

    @property
    def anchor(self) -> tuple[float, float]:
        if self.block.anchor is not None:
            return self.block.anchor
        b = _bbox(self.lines) if self.lines else self.block.bbox
        return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def _bbox(lines: Sequence[Line]) -> BBox:
    return (
        min(ln.bbox[0] for ln in lines),
        min(ln.bbox[1] for ln in lines),
        max(ln.bbox[2] for ln in lines),
        max(ln.bbox[3] for ln in lines),
    )


def _inside(pt: tuple[float, float], box: BBox | None, pad: float = 0.0) -> bool:
    return box is not None and box[0] - pad <= pt[0] <= box[2] + pad and box[1] - pad <= pt[1] <= box[3] + pad


# ------------------------------------------------------------------------------------------------- lines → blocks
def read_lines(lines: Sequence[Mapping[str, Any]]) -> list[Line]:
    out = []
    for i, ln in enumerate(lines):
        try:
            x0, y0, x1, y1 = (float(v) for v in ln["bboxMm"])
        except (KeyError, TypeError, ValueError):
            continue
        t = str(ln.get("text") or "").strip()
        if not t:
            continue
        b = (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
        ang = float(ln.get("angle", 0.0) or 0.0)
        hm = float(ln.get("heightMm") or 0.0)
        # the reader sometimes joins a stray glyph of a symbol to a line ("שקע בתקרה)" 3 × font height): keep the box
        # of the letters (bottom = baseline side) so stacked notes stay stacked
        if hm > 0 and (ang % 180.0 < 30 or ang % 180.0 > 150) and b[3] - b[1] > 1.8 * hm:
            b = (b[0], b[3] - 1.4 * hm, b[2], b[3])
        out.append(Line(i, t, b, float(ln.get("confidence", 0.7) or 0.0), ang))
    return out


def _underlines(vs: VectorSheet | None, text_paths: set[int]) -> np.ndarray:
    """Horizontal dark solid line pieces ≥ 3 mm (note underlines / leader shoulders), (k, 3) = x0, x1, y."""
    if vs is None or vs.n_segs == 0:
        return np.zeros((0, 3))
    s = vs.segs.astype(np.float64)
    p = vs.seg_path
    rgb = vs.path_stroke_rgba[p, :3].astype(int)
    solid = np.array([len(vs.path_dash[i]) == 0 for i in range(vs.n_paths)], bool)[p]
    keep = (
        (vs.seg_kind == SEG_LINE)
        & solid
        & (rgb.max(axis=1) <= 90)
        & (np.abs(s[:, 3] - s[:, 1]) <= 0.05)
        & (np.abs(s[:, 2] - s[:, 0]) >= 3.0)
    )
    if text_paths:
        keep &= ~np.isin(p, np.fromiter(text_paths, dtype=np.int64))
    k = s[keep]
    return np.stack([np.minimum(k[:, 0], k[:, 2]), np.maximum(k[:, 0], k[:, 2]), k[:, 1]], axis=1) if len(k) else np.zeros((0, 3))


def _separated(a: Line, b: Line, ul: np.ndarray) -> bool:
    """An underline lies between the upper line ``a`` and the lower line ``b`` under both of them."""
    if not len(ul):
        return False
    if b.bbox[1] - a.bbox[3] < 0.5 * min(a.h, b.h):
        return False  # tight stack: a line under the upper text is the leader's shoulder of a multi-line note
    y_lo, y_hi = a.bbox[3] - 0.3 * a.h, b.bbox[1] + 0.3 * b.h
    sel = ul[(ul[:, 2] >= y_lo) & (ul[:, 2] <= y_hi)]
    if not len(sel):
        return False
    w = min(a.bbox[2] - a.bbox[0], b.bbox[2] - b.bbox[0])
    ov_a = np.minimum(sel[:, 1], a.bbox[2]) - np.maximum(sel[:, 0], a.bbox[0])
    ov_b = np.minimum(sel[:, 1], b.bbox[2]) - np.maximum(sel[:, 0], b.bbox[0])
    return bool(((ov_a >= 0.6 * w) & (ov_b >= 0.6 * w)).any())


def _aligned(a: BBox, b: BBox) -> bool:
    ov = min(a[2], b[2]) - max(a[0], b[0])
    short = min(a[2] - a[0], b[2] - b[0])
    return abs(a[2] - b[2]) <= 2.5 or abs(a[0] - b[0]) <= 2.5 or (short > 0 and ov >= 0.5 * short)


def note_blocks(lines: Sequence[Line], ul: np.ndarray) -> list[list[Line]]:
    """Stack horizontal lines into note blocks (top to bottom); rotated lines stay alone."""
    horiz = sorted((ln for ln in lines if ln.horizontal), key=lambda ln: (ln.bbox[1], -ln.bbox[2]))
    out: list[list[Line]] = []
    for ln in horiz:
        best: int | None = None
        for k in range(len(out) - 1, -1, -1):
            last = out[k][-1]
            gap = ln.bbox[1] - last.bbox[3]
            same_row = min(ln.bbox[3], last.bbox[3]) - max(ln.bbox[1], last.bbox[1]) >= 0.5 * min(ln.h, last.h) and (
                max(ln.bbox[0], last.bbox[0]) - min(ln.bbox[2], last.bbox[2]) <= 1.5 * max(ln.h, last.h)
            )
            if not same_row:
                if gap > 0.7 * max(ln.h, last.h) or gap < -0.6 * min(ln.h, last.h):
                    continue
                if not (0.6 <= ln.h / last.h <= 1.6) or not _aligned(ln.bbox, _bbox(out[k])):
                    continue
                if _separated(last, ln, ul):
                    continue
            best = k
            break
        if best is None:
            out.append([ln])
        else:
            out[best].append(ln)
    out.extend([ln] for ln in lines if not ln.horizontal)
    return out


# ------------------------------------------------------------------------------------------------ detail boxes
def _details(lines: list[Line], used: set[int]) -> tuple[list[Block], dict[str, str]]:
    """Detail boxes: title + stacked content below it (consumed). Returns the blocks and letter → content."""
    blocks: list[Block] = []
    content: dict[str, str] = {}
    for t in lines:
        if t.idx in used or not t.horizontal or not is_detail_title(t.text):
            continue
        refs = detail_refs(t.text)
        letter = refs[0][0] if refs else "?"
        x0, x1 = t.bbox[0] - 8.0, t.bbox[2] + 8.0
        below = sorted(
            (
                ln
                for ln in lines
                if ln.idx != t.idx
                and ln.idx not in used
                and x0 <= ln.center[0] <= x1
                and t.bbox[1] < ln.center[1] <= t.bbox[3] + DETAIL_DEPTH_MM
            ),
            key=lambda ln: ln.bbox[1],
        )
        body: list[Line] = []
        last_y = t.bbox[3]
        for ln in below:
            if ln.bbox[1] - last_y > (DETAIL_GAP_MM if body else DETAIL_FIRST_GAP_MM):
                break
            body.append(ln)
            last_y = max(last_y, ln.bbox[3])
        words = [ln for ln in body if has_hebrew(ln.text) and len(normalize(ln.text)) >= 4]
        used.add(t.idx)
        used.update(ln.idx for ln in body)
        txt = " / ".join(ln.text.strip() for ln in words)
        content.setdefault(letter, txt)
        blocks.append(Block("detail", [t, *body], extra=txt))
    return blocks, content


# ----------------------------------------------------------------------------------------------------- matching
def _line_span(block: Block, start: int, end: int) -> tuple[list[Line], list[Line]]:
    """``(spanned, context)``: the lines of the block a match ``[start, end)`` (offsets in the block's normalised
    text) lies on, and those plus the next line (two-line notes: "מפסק דוד קיים / להחליף לטיימר")."""
    pos = 0
    first = last = None
    for i, ln in enumerate(block.lines):
        n = len(normalize(ln.text)) + 3  # " / "
        if first is None and start < pos + n:
            first = i
        if end - 1 < pos + n:
            last = i
            break
        pos += n
    if first is None:
        first = len(block.lines) - 1
    if last is None or last < first:
        last = len(block.lines) - 1
    return block.lines[first : last + 1], block.lines[first : last + 2]


def _role(entry: Entry, text: str) -> str:
    if any(compile_pattern(p).search(text) for p in entry.feed_patterns):
        return "feed"
    if any(compile_pattern(p).search(text) for p in entry.switch_patterns):
        return "switch"
    return "item"


def match_block(block: Block, discipline: str | None, catalog: Sequence[Entry] = CATALOG) -> list[Item]:
    """Catalog items of one block (see module docstring step 5); [] when nothing matches."""
    full = normalize(block.text + (f" → {block.extra}" if block.extra else ""))
    items: list[Item] = []
    for e in catalog:
        if block.kind not in e.scope or (e.disciplines and (discipline or "") not in e.disciplines):
            continue
        seen: set[int] = set()
        for pat in e.patterns:
            for m in compile_pattern(pat).finditer(full):
                if block.kind in ("conduit", "detail_ref"):
                    spanned = local = list(block.lines)
                    local_text = full
                else:
                    lead = len(m.group(0)) - len(m.group(0).lstrip(" /+-^"))
                    spanned, local = _line_span(block, m.start() + lead, m.end())
                    local_text = normalize(" / ".join(ln.text for ln in local))
                keys = {ln.idx for ln in spanned} or {-1}
                if keys & seen:
                    continue
                if any(compile_pattern(x).search(local_text) for x in e.exclude):
                    continue
                lc = lifecycle_of(local_text)
                if e.lifecycle_any and lc not in e.lifecycle_any:
                    continue
                if e.lifecycle_none and lc in e.lifecycle_none:
                    continue
                seen |= keys
                role = _role(e, normalize(m.group(0))) if (e.feed_patterns or e.switch_patterns) else "item"
                if role == "item" and (e.feed_patterns or e.switch_patterns):
                    role = _role(e, local_text)
                qty: float | None = 1.0
                if e.qty == "number_in_text":
                    qty = float(count_in_text(local_text) or 1)
                length = length_in_text_m(local_text)
                if e.qty == "length_in_text_m":
                    qty = length
                if block.run is not None:
                    length = block.run_length_m
                items.append(Item(block.kind, block, spanned, e, m.group(0), role, lc, qty, length))
            if block.kind in ("conduit", "detail_ref") and seen:
                break  # one item per entry for an equipment run / a detail reference
    return items


# --------------------------------------------------------------------------------------------- floors / rooms
def _poly(r: Mapping[str, Any]) -> list[tuple[float, float]]:
    pts = r.get("polygonMm") or []
    out = []
    for q in pts:
        if isinstance(q, Mapping):
            out.append((float(q["x"]), float(q["y"])))
        else:
            out.append((float(q[0]), float(q[1])))
    return out


def _locate(
    pt: tuple[float, float], regions: Sequence[Mapping[str, Any]], rooms: Sequence[Mapping[str, Any]]
) -> tuple[str | None, str | None]:
    from shapely.geometry import Point, Polygon

    p = Point(pt)
    floor: str | None = None
    best = 1e9
    for r in regions:
        poly = _poly(r)
        if len(poly) < 3:
            continue
        d = Polygon(poly).distance(p)
        if d < best:
            best, floor = d, (str(r["floor"]) if r.get("floor") else None)
    if best > 30.0:
        floors = {str(r.get("floor")) for r in regions if r.get("floor")}
        floor = floors.pop() if len(floors) == 1 else None
    room: str | None = None
    rbest = 1.0
    for rm in rooms:
        poly = _poly(rm)
        if len(poly) < 3:
            continue
        d = Polygon(poly).distance(p)
        if d <= rbest:
            rbest, room = d, str(rm.get("id"))
            if rm.get("floor") and floor is None:
                floor = str(rm["floor"])
            if d == 0:
                break
    return floor, room


# ----------------------------------------------------------------------------------------------------- main
def extract(
    lines_json: Sequence[Mapping[str, Any]],
    *,
    sheet_id: str,
    discipline: str | None,
    vs: VectorSheet | None = None,
    text_paths: set[int] | None = None,
    scale_den: int | None = None,
    regions: Sequence[Mapping[str, Any]] = (),
    rooms: Sequence[Mapping[str, Any]] = (),
    legend_boxes: Sequence[BBox] = (),
    legend_labels: Sequence[str] = (),
    title_block: BBox | None = None,
    raster: bool = False,
    green_threshold: float | None = None,
    catalog: Sequence[Entry] = CATALOG,
) -> dict[str, Any]:
    """``kamutan.textItems/1`` document of one sheet (see the module docstring)."""
    tp = set(text_paths or ())
    lines = [ln for ln in read_lines(lines_json) if not _inside(ln.center, title_block)]
    used: set[int] = set()
    blocks: list[Block] = []
    # legend rows
    for ln in lines:
        if any(_inside(ln.center, b, 0.5) for b in legend_boxes):
            used.add(ln.idx)
            if has_hebrew(ln.text):
                blocks.append(Block("legend_row", [ln]))
    details, content = _details([ln for ln in lines if ln.idx not in used], used)
    blocks.extend(details)
    ul = _underlines(vs, tp)
    rest = [ln for ln in lines if ln.idx not in used and (has_hebrew(ln.text) or detail_refs(ln.text))]
    leaders = _leader_index(vs, rest) if vs is not None else None
    for grp in note_blocks(rest, ul):
        b = Block("note", grp)
        refs = [r for ln in grp for r in detail_refs(ln.text)] if not any(is_detail_title(ln.text) for ln in grp) else []
        if refs and content:
            letter = refs[0][0]
            b.kind = "detail_ref"
            b.extra = content.get(letter) or (next(iter(content.values())) if len(content) == 1 else "")
            b.fuzzy = not re.search(r"פרט", normalize(b.text))
        if leaders is not None:
            _attach_leader(b, leaders)
        blocks.append(b)
    # conduit runs (legend-conditioned)
    if vs is not None and conduit_legend(legend_labels):
        exclude = [*legend_boxes, *([title_block] if title_block else [])]
        for run in find_runs(vs, text_paths=tp, exclude=exclude):
            near = [
                bl
                for bl in blocks
                if bl.kind in ("note", "callout", "detail_ref")
                and any(_dist_box(e, bl.bbox) <= CONDUIT_TEXT_MM for e in run.ends)
            ]
            near.sort(key=lambda bl: min(_dist_box(e, bl.bbox) for e in run.ends))
            cb = Block("conduit", [], anchor=run_center(run), run=run)
            cb.extra = " / ".join(bl.text for bl in near[:3])
            cb.run_length_m = round(run.length_mm * (scale_den or 50) / 1000.0, 2)
            blocks.append(cb)
    # items
    items: list[Item] = []
    for b in blocks:
        got = match_block(b, discipline, catalog) if b.kind != "detail" else []
        if b.kind == "conduit":
            # no catalog entry named the run's notes ("קוברה", "מקרן"): it is a plain run of the legend's conduit
            got = got or [Item("conduit", b, [], _conduit_default(catalog), "", "item", None, 1.0, b.run_length_m)]
            proj = [it for it in got if it.entry is not None and it.entry.id == "tx_cobra_projector"]
            got = proj[:1] or got[:1]
        elif b.kind == "detail_ref":
            got = got[:1]  # one equipment item per reference (catalog order)
        if got:
            items.extend(got)
        elif b.kind == "detail":
            continue  # the detail box defines what "פרט A" means (folded into each detail_ref); never an item
        elif b.lines and has_hebrew(b.text):
            items.append(Item(b.kind, b, list(b.lines)))
    for it in items:
        it.floor, it.room_id = _locate(it.anchor, regions, rooms)
    _fold(items)
    items = sorted(
        items, key=lambda it: (round(it.block.bbox[1], 1), -round(it.block.bbox[2], 1), it.entry.id if it.entry else "")
    )[:MAX_ITEMS]
    for n, it in enumerate(items, 1):
        it.id = f"t_{n}"
    docs = [_to_json(it, items, sheet_id, raster=raster, green_threshold=green_threshold) for it in items]
    by_code: dict[str, float] = {}
    for d in docs:
        if d["itemCode"] and d["qty"]:
            by_code[d["itemCode"]] = round(by_code.get(d["itemCode"], 0.0) + float(d["qty"]), 3)
    return {
        "schema": SCHEMA,
        "sheetId": sheet_id,
        "discipline": discipline,
        "catalogVersion": CATALOG_VERSION,
        "items": docs,
        "stats": {
            "items": len(docs),
            "matched": sum(1 for d in docs if d["matchedPattern"]),
            "byCode": dict(sorted(by_code.items())),
        },
    }


def run_center(run: Run) -> tuple[float, float]:
    """Centre of a conduit run = middle of its chord (the ``conduit_cobra`` detection's ``centerMm``)."""
    (ax, ay), (zx, zy) = run.ends
    return (round((ax + zx) / 2, 2), round((ay + zy) / 2, 2))


def conduit_legend(labels: Sequence[str]) -> bool:
    """The sheet's legend names a conduit sign ("צינור קוברה 50 מ"מ") — runs are looked for only then."""
    return any(CONDUIT_LEGEND.search(normalize(t)) for t in labels)


def _conduit_default(catalog: Sequence[Entry]) -> Entry | None:
    return next((e for e in catalog if "conduit" in e.scope and e.id == "tx_cobra"), None) or next(
        (e for e in catalog if "conduit" in e.scope), None
    )


def _dist_box(p: tuple[float, float], b: BBox) -> float:
    dx = max(b[0] - p[0], 0.0, p[0] - b[2])
    dy = max(b[1] - p[1], 0.0, p[1] - b[3])
    return float((dx * dx + dy * dy) ** 0.5)


def _leader_index(vs: VectorSheet, lines: Sequence[Line]) -> Any:
    try:
        from ..fixtures.labels import TextItem
        from ..fixtures.leaders import LeaderIndex

        return LeaderIndex(vs, [TextItem(ln.bbox, ln.text, ln.conf) for ln in lines])
    except Exception:  # noqa: BLE001 - leaders are best effort (anchor falls back to the text)
        return None


def _attach_leader(b: Block, leaders: Any) -> None:
    from ..fixtures.labels import Label

    if not b.lines or not b.lines[0].horizontal:
        return
    try:
        found = leaders.follow(Label(None, b.text, b.bbox, b.conf))
    except Exception:  # noqa: BLE001
        return
    if not found:
        return
    best = max(found, key=lambda ld: ld.length)
    if best.length < 2.0:
        return
    if b.kind == "note":
        b.kind = "callout"
    b.anchor = (round(best.terminal[0], 2), round(best.terminal[1], 2))
    b.leader = [(round(x, 2), round(y, 2)) for x, y in best.polyline][:32]


def _fold(items: list[Item]) -> None:
    """Pairing (switch → feed), grouping (``group_mm``) and once-per-floor on one sheet: folded items get qty 0."""
    by_entry: dict[str, list[int]] = {}
    for i, it in enumerate(items):
        if it.entry is not None and it.qty:
            by_entry.setdefault(it.entry.id, []).append(i)
    for idxs in by_entry.values():
        e = items[idxs[0]].entry
        assert e is not None
        if e.access_panels:
            _fold_access_panels(items, idxs)
            continue
        if e.per_floor:
            first: dict[str | None, int] = {}
            for i in idxs:
                fl = items[i].floor
                if fl in first:
                    _fold_into(items, i, first[fl], R_GROUPED)
                else:
                    first[fl] = i
            continue
        if e.feed_patterns or e.switch_patterns:
            feeds = [i for i in idxs if items[i].role == "feed"]
            taken: set[int] = set()
            for i in idxs:
                if items[i].role != "switch":
                    continue
                cand = [f for f in feeds if f not in taken and items[f].floor == items[i].floor]
                if not cand:
                    continue
                f = min(cand, key=lambda j: _d(items[j].anchor, items[i].anchor))
                taken.add(f)
                _fold_into(items, i, f, R_PAIRED)
        if e.group_mm > 0:
            for a_pos, i in enumerate(idxs):
                if not items[i].qty:
                    continue
                for j in idxs[a_pos + 1 :]:
                    near = min(_d(items[i].anchor, items[j].anchor), _box_gap(items[i].box, items[j].box))
                    if items[j].qty and items[j].floor == items[i].floor and near <= e.group_mm:
                        _fold_into(items, j, i, R_GROUPED)


ACCESS_SAME_MM = 40.0
_EXPLICIT_ACCESS = compile_pattern(r"פתח ?(?:שירות|ביקורת|גישה)|אורבונד")
_REFERS_TO_SECTION = compile_pattern(r"ראה ?(?:חתכ|פרט)|(?:^|[^א-ת])חתכ(?![א-ת])")


def _fold_access_panels(items: list[Item], idxs: list[int]) -> None:
    """7.04 (``access_panels`` entries): per floor of the sheet one unit per AC closure note; an explicit access note
    ("פתח שירות") is the panel of a closure ≤ ``ACCESS_SAME_MM`` away, else of a closure that refers to a section
    (the access note sits on that section; one each), else a unit of its own. The floor's first note carries the
    unit count (``qty``), the others are folded into it — one item per floor whatever the BOQ's text clustering."""
    by_floor: dict[str | None, list[int]] = {}
    for i in idxs:
        by_floor.setdefault(items[i].floor, []).append(i)
    for members in by_floor.values():
        explicit = [i for i in members if _EXPLICIT_ACCESS.search(normalize(items[i].match))]
        closures = [i for i in members if i not in explicit]
        units = len(closures)
        taken: set[int] = set()
        same: dict[int, int] = {}
        for i in explicit:
            near = [(min(_d(items[c].anchor, items[i].anchor), _box_gap(items[c].box, items[i].box)), c) for c in closures]
            near = [t for t in near if t[0] <= ACCESS_SAME_MM and t[1] not in taken]
            if not near:
                near = [
                    (0.0, c) for c in closures if c not in taken and _REFERS_TO_SECTION.search(normalize(items[c].block.text))
                ]
            if near:
                c = min(near)[1]
                taken.add(c)
                same[i] = c
            else:
                units += 1
        order = sorted(members, key=lambda j: (j in same, round(items[j].box[1], 1), round(items[j].box[0], 1)))
        head = order[0]
        items[head].qty = float(units)
        for j in order[1:]:
            _fold_into(items, j, head, R_ACCESS_SAME if j in same else R_ACCESS_FLOOR)


def _fold_into(items: list[Item], i: int, into: int, reason: str) -> None:
    items[i].qty = 0.0
    items[i].paired_with = items[into]
    items[i].reasons.append(reason)
    if reason not in items[into].reasons:
        items[into].reasons.append(reason)


def _box_gap(a: BBox, b: BBox) -> float:
    dx = max(a[0] - b[2], 0.0, b[0] - a[2])
    dy = max(a[1] - b[3], 0.0, b[1] - a[3])
    return float((dx * dx + dy * dy) ** 0.5)


def _d(a: tuple[float, float], b: tuple[float, float]) -> float:
    return float(((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5)


def _box_json(b: BBox) -> dict[str, float]:
    return {"x": round(b[0], 2), "y": round(b[1], 2), "w": round(b[2] - b[0], 2), "h": round(b[3] - b[1], 2)}


def _to_json(it: Item, items: list[Item], sheet_id: str, *, raster: bool, green_threshold: float | None) -> dict[str, Any]:
    e = it.entry
    b = it.block
    lines = it.lines or b.lines
    text = (b.text if b.kind in ("conduit",) else " / ".join(ln.text.strip() for ln in lines)) or b.extra
    if b.kind == "conduit":
        text = b.extra or "צינור"
    norm = normalize(text)
    if b.kind == "detail_ref" and b.extra:
        norm = f"{normalize(b.text)} → {normalize(b.extra)}"
    if b.kind == "detail":
        norm = normalize(b.text)
    box = _bbox(lines) if lines and b.kind not in ("conduit", "detail") else b.bbox
    ocr = min((ln.conf for ln in lines), default=0.8)
    reasons = list(it.reasons)
    raw = max(0.0, min(1.0, ocr))
    if b.kind == "conduit":
        raw = 0.8
    if e is not None:
        reasons = [*e.reasons, *reasons]
        if R_TEXT not in reasons and b.kind != "conduit":
            reasons.insert(0, R_TEXT)
        if e.corroborates:
            reasons.append(R_CORROBORATES)
        if e.suggested:
            reasons.append(R_SUGGESTED)
            raw = min(raw, 0.6)
        if b.fuzzy:
            raw *= 0.85
            reasons.append(R_OCR_UNSURE)
    if ocr < LOW_OCR and b.kind != "conduit" and R_OCR_UNSURE not in reasons:
        reasons.append(R_OCR_UNSURE)
    if e is not None and it.floor is None:
        reasons.append(R_NO_FLOOR)
    heur = "red" if raw < 0.5 else "yellow"  # text items are never green before they have GT statistics
    score, level, reasons = calibrate(
        f"text:{e.item_code}" if e is not None else "text:unmatched",
        raw,
        reasons,
        level=heur,
        raster=raster,
        green_threshold=green_threshold,
    )
    if level == "green":  # defensive: a table entry for text classes must not lift text items to green yet
        level = "yellow"
    lead = b.leader if b.kind == "callout" else None
    return {
        "id": it.id,
        "sheetId": sheet_id,
        "kind": b.kind,
        "text": text[:MAX_TEXT],
        "normalized": norm[:MAX_TEXT],
        "bboxMm": _box_json(box),
        "anchorMm": {"x": round(b.anchor[0], 2), "y": round(b.anchor[1], 2)} if b.anchor is not None else None,
        "leaderMm": [{"x": x, "y": y} for x, y in lead] if lead else None,
        "lineIdx": sorted({ln.idx for ln in (lines if b.kind != "conduit" else [])}),
        "floor": it.floor,
        "roomId": it.room_id,
        "lifecycle": it.lifecycle,
        "qty": None if e is None or it.qty is None else round(float(it.qty), 3),
        "unit": e.unit if e is not None else None,
        "lengthM": it.length_m,
        "matchedPattern": e.id if e is not None else None,
        "itemCode": e.item_code if e is not None else None,
        "role": it.role if e is not None else None,
        "pairedWith": it.paired_with.id if it.paired_with is not None else None,
        "corroborates": bool(e is not None and e.corroborates),
        "suggested": bool(e is not None and e.suggested),
        "dedupe": "floor" if (e is not None and e.per_floor) else None,  # one unit per floor over all sheets
        "confidence": round(score, 3),
        "scoreRaw": round(raw, 3),
        "level": level,
        "reasons": [str(r)[:64] for r in dict.fromkeys(reasons)][:8],
    }


# ------------------------------------------------------------------------------------- from stored artifacts
def gz_json(obj: Any) -> bytes:
    return gzip.compress(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode(), mtime=0)


def from_version_dir(vdir: Path, *, sheet_id: str | None = None, version: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Recompute a sheet's text items from its stored artifacts (``primitives.msgpack.gz``, ``text.json.gz``,
    ``legend.json.gz``, ``rooms.json.gz`` and the version doc's ``regions`` / ``discipline`` / ``scaleDenominator``)
    — the same code path as the ``understand`` hook, for backfills and local measurement."""
    from ..classify.sheet import classify_page, span_from_line
    from ..pipeline.artifacts import decode_primitives, decode_text
    from ..types_sprint2 import vector_sheet_from_primitives

    v = dict(version or json.loads((vdir / "version.json").read_text(encoding="utf-8")))
    prim = decode_primitives((vdir / "primitives.msgpack.gz").read_bytes())
    vs = vector_sheet_from_primitives(prim)
    lines = list(decode_text((vdir / "text.json.gz").read_bytes()).get("lines") or [])
    raster = str((v.get("page") or {}).get("kind") or "") in ("png", "jpg")
    spans = [span_from_line(ln) for ln in lines]
    tb = classify_page(spans, vs, raster=raster).title_block_bbox if (spans or vs.n_paths) else None
    boxes: list[BBox] = []
    labels: list[str] = []
    lp = vdir / "legend.json.gz"
    if lp.exists():
        leg = json.loads(gzip.decompress(lp.read_bytes()))
        for lg in leg.get("legends") or []:
            bb = lg.get("bboxMm") or {}
            boxes.append((float(bb["x"]), float(bb["y"]), float(bb["x"]) + float(bb["w"]), float(bb["y"]) + float(bb["h"])))
        labels = [str(e.get("label") or "") for e in leg.get("entries") or []]
    rooms: list[dict[str, Any]] = []
    rp = vdir / "rooms.json.gz"
    if rp.exists():
        rooms = list(json.loads(gzip.decompress(rp.read_bytes())).get("rooms") or [])
    return extract(
        lines,
        sheet_id=sheet_id or str(v.get("sheetId") or ""),
        discipline=v.get("discipline"),
        vs=vs,
        text_paths={int(i) for i in prim.get("textPaths", [])},
        scale_den=int(v["scaleDenominator"]) if v.get("scaleDenominator") else None,
        regions=list(v.get("regions") or []),
        rooms=rooms,
        legend_boxes=boxes,
        legend_labels=labels,
        title_block=tb,
        raster=raster,
    )
