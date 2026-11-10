"""Lighting circuits of one sheet from the circuit tags (Sprint 10, Worker-Lighting). Pure: no I/O.

Convention (idan mordechai's lighting plans — rubel / achituv / yahav, see NOTES "Sprint 10 — lighting circuits"):

* every fixture carries a tag (``A1``) written just beside its symbol (fixture tag = a single tag whose nearest
  symbol is a luminaire / fan within :attr:`CircuitParams.fixture_tag_mm`; LED strips take theirs from a leader note
  up to :attr:`CircuitParams.leader_tag_mm` away);
* every other tag text is a **switch list**: one tag per switch glyph (yahav), a range at a gang (achituv:
  ``A1-A4``), or rows of comma lists in an orange switch box with no glyphs at all (rubel). Lists that are close
  together (one box, one bank of glyphs) form one **switch position**;
* a tag list in a note frame with Hebrew prose, on the same row as prose, far from the plan or next to a timer /
  stair keyword is a **note**: the timer circuits are listed in such a note ("תאורות שנדלקות ע"י שעון שבת (טיימר)
  בלוח: D6 D3"), the stair push-button is named by one ("לחצן אוטומט חדר מדרגות C8");
* circuit **kind** per tag: ``no_switch`` (tag at no position — אפס קבוע), ``timer`` (listed in the timer note),
  ``single`` (one position, one fixture), ``shared`` (one position, N fixtures), ``two_way`` (two positions),
  ``cross`` (three or more); a stair push-button note sets ``stairAutomat``.

Nothing is dropped silently: fixtures without a tag, switch lists whose tags have no fixture on the sheet, and
tag texts that could not be placed are reported in ``unmatched`` and lower the sheet's circuits to yellow.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from ..textitems.normalize import normalize
from .tags import LIST_WORDS, Tag, TagRead, parse_tags

CIRCUITS_SCHEMA = "kamutan.circuits/1"
CIRCUIT_KINDS = ("single", "shared", "two_way", "cross", "timer", "no_switch")
LUMINAIRE_CLASSES = frozenset(
    {"luminaire_ceiling", "luminaire_wall", "luminaire_pendant", "luminaire_strip", "luminaire_outdoor", "ceiling_fan"}
)
SWITCH_CLASSES = frozenset({"switch_single", "switch_2way", "switch_fan", "switch_cross"})
# classes a circuit tag can never belong to (page furniture, text anchors, non-lighting equipment)
NEVER_FIXTURE = frozenset(
    {
        "legend_entry", "legend_box", "region", "room", "note_point", "waterproof_marker", "breaker", "panel", "thermostat",
        "switch_shutter", "socket_single", "socket_double", "socket_triple", "socket_power", "socket_power_double",
        "socket_3phase", "socket_box_6", "socket_prep", "data_point", "tv_point", "phone_point", "bezek_point", "intercom",
        "doorbell", "heater_feed", "water_heater_feed", "conduit_cobra", "ac_unit",
    }
)  # fmt: skip

# reasons (Hebrew chips ≤ 64 chars)
R_NO_TAG = "גוף תאורה ללא תג מעגל"
R_TAG_NO_FIXTURE = "תג מפסק ללא גוף תאורה בגיליון"
R_TAG_CORRECTED = "תג מעגל תוקן מקריאה"
R_POSITION_NO_GLYPH = "מיקום מפסק ללא סמל מפסק"
R_TIMER_WORD_UNREAD = "רשימת טיימר ללא מילת מפתח קריאה"
R_UNPLACED_TAG = "תג מעגל לא שויך"
R_UNMATCHED_ON_SHEET = "בגיליון גופי תאורה ללא תג"
R_BUILTIN_SWITCH = "גוף תאורה ללא תג ליד מפסק — נק' עם מפסק מובנה"
R_LEADER_TAG = "תג המפסק נקרא מהערה עם קו מוביל"
R_RETAGGED = "סמל סווג אחרת — תג המעגל מצביע על גוף תאורה"

_TIMER_WORDS = ("טיימר", "שעון שבת", "שעון", "timer")
_STAIR_RE = re.compile(r"אוטומט")
_STAIR_CTX = re.compile(r"מדר.{1,2}ות|[לכ]חצנ")  # "מדרגות" / "לחצן" with the reader's usual ל→כ, ג→ה slips
_HEB = re.compile(r"[א-ת]")

BBox = tuple[float, float, float, float]


class SpanLike(Protocol):
    bbox: tuple[float, float, float, float]
    text: str


@dataclass
class CircuitParams:
    """Distances in paper mm (the tags are drawn at ~2 mm text height whatever the scale)."""

    fixture_tag_mm: float = 4.5  # a single tag this close to a luminaire / fan symbol labels it
    switch_tag_mm: float = 6.0  # switch glyphs this close to a list belong to its position
    position_merge_mm: float = 7.0  # lists closer than this = one switch position (a bank / a box)
    box_margin_mm: float = 3.0  # an enclosing closed rectangle (switch box / note frame) within this margin
    box_max_mm: float = 120.0  # larger closed rectangles are rooms / frames, not boxes
    box_min_w_mm: float = 7.0  # a glyph-less switch box is at least this wide (a 5 mm closed rect is a symbol)
    note_word_mm: float = 60.0  # a timer / stair keyword this close to a lone tag / list makes it a note (timer list)
    note_ctx_mm: float = 15.0  # … and only this close does the keyword settle which note it is (timer / stair)
    max_tag_height_mm: float = 4.0  # tag labels are small; bigger texts are titles / dimensions
    min_tag_height_mm: float = 1.0  # smaller "texts" are glyph-reader crumbs (0.3 mm strokes read as "l7")
    leader_tag_mm: float = 12.0  # a fixture still untagged takes a tag mentioned in a leader note this close
    leader_end_mm: float = 5.0  # a leader line starts this close to the glyph it annotates
    leader_note_mm: float = 6.0  # … and ends this close to the note text
    retag_mm: float = 3.5  # a tag label this close to a symbol of another class re-tags it as a fixture


@dataclass
class _TagText:
    idx: int
    text: str
    bbox: BBox
    read: TagRead
    role: str = ""  # fixture | switch | note | unplaced
    fixture_id: str | None = None
    box: BBox | None = None  # enclosing small rectangle


def _gap(a: BBox, b: BBox) -> float:
    dx = max(0.0, max(a[0], b[0]) - min(a[2], b[2]))
    dy = max(0.0, max(a[1], b[1]) - min(a[3], b[3]))
    return (dx * dx + dy * dy) ** 0.5


def _center(b: BBox) -> tuple[float, float]:
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def _det_bbox(d: dict[str, Any]) -> BBox:
    b = d.get("bboxMm") or {}
    try:
        x, y, w, h = float(b["x"]), float(b["y"]), float(b.get("w", 0)), float(b.get("h", 0))
    except (KeyError, TypeError, ValueError):
        c = d.get("centerMm") or {"x": 0, "y": 0}
        x, y, w, h = float(c["x"]) - 1.5, float(c["y"]) - 1.5, 3.0, 3.0
    return (x, y, x + w, y + h)


def _union(boxes: Sequence[BBox]) -> BBox:
    return (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))


def _in_poly(x: float, y: float, poly: list[tuple[float, float]]) -> bool:
    inside = False
    n = len(poly)
    for i in range(n):
        (ax, ay), (bx, by) = poly[i], poly[(i + 1) % n]
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / ((by - ay) or 1e-9) + ax:
            inside = not inside
    return inside


def _region_polys(regions: Sequence[dict[str, Any]] | None) -> list[tuple[str | None, list[tuple[float, float]]]]:
    out = []
    for r in regions or []:
        pts = r.get("polygonMm") or []
        if len(pts) >= 3:
            try:
                out.append((r.get("floor"), [(float(p["x"]), float(p["y"])) for p in pts]))
            except (KeyError, TypeError, ValueError):
                continue
    return out


def _timer_note(text: str) -> bool:
    t = normalize(text)
    return any((nw := normalize(w)) in t or nw[::-1] in t for w in _TIMER_WORDS)


def _stair_note(text: str) -> bool:
    t = normalize(text)
    return bool(_STAIR_RE.search(t)) and bool(_STAIR_CTX.search(t))


def enclosing_rects(
    bboxes: Sequence[BBox], *, closed: Sequence[bool] | None = None, max_mm: float = 120.0, min_mm: float = 4.0
) -> list[BBox]:
    """Small closed rectangles of a sheet (switch boxes, note frames): closed paths whose bbox is between ``min_mm``
    and ``max_mm`` on its longer side. ``bboxes`` = ``VectorSheet.path_bbox`` rows, ``closed`` = ``path_closed``."""
    out: list[BBox] = []
    for i, b in enumerate(bboxes):
        if closed is not None and not bool(closed[i]):
            continue
        w, h = float(b[2]) - float(b[0]), float(b[3]) - float(b[1])
        if min(w, h) < 2.0 or max(w, h) < min_mm or max(w, h) > max_mm:
            continue
        out.append((float(b[0]), float(b[1]), float(b[2]), float(b[3])))
    return out


def leader_lines(segs: Any, seg_path: Any, path_closed: Sequence[bool], *, min_mm: float = 6.0, max_segs: int = 4) -> list[BBox]:
    """End points ``(x0, y0, x1, y1)`` of the open polylines of a sheet (leader lines of notes): paths of at most
    ``max_segs`` straight segments, not closed, at least ``min_mm`` long end to end."""
    import numpy as np

    segs = np.asarray(segs, dtype=float)
    seg_path = np.asarray(seg_path)
    if not len(segs):
        return []
    out: list[BBox] = []
    order = np.argsort(seg_path, kind="stable")
    sp = seg_path[order]
    bounds = np.flatnonzero(np.diff(sp)) + 1
    starts = np.concatenate([[0], bounds])
    ends = np.concatenate([bounds, [len(sp)]])
    for a, b in zip(starts, ends, strict=True):
        pid = int(sp[a])
        if b - a > max_segs or (0 <= pid < len(path_closed) and bool(path_closed[pid])):
            continue
        idx = order[a:b]
        x0, y0 = float(segs[idx[0], 0]), float(segs[idx[0], 1])
        x1, y1 = float(segs[idx[-1], 2]), float(segs[idx[-1], 3])
        if ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5 >= min_mm:
            out.append((x0, y0, x1, y1))
    return out


def _he_number_words(text: str) -> bool:
    """Hebrew prose (≥ 2 Hebrew words of ≥ 3 letters, not a comma list) — a note sentence, not a list row."""
    if "," in text:
        return False  # "מיזוג,מיזוג" (or its misreads): a row of a switch box
    words = [w for w in re.findall(r"[א-ת]{3,}", text) if w not in LIST_WORDS and w[::-1] not in LIST_WORDS]
    return len(words) >= 2


@dataclass
class _Position:
    id: str
    texts: list[_TagText]
    tags: list[str]
    switch_ids: list[str]
    bbox: BBox
    box: BBox | None
    reasons: list[str] = field(default_factory=list)


def build_circuits(
    spans: Sequence[SpanLike],
    detections: Sequence[dict[str, Any]],
    *,
    sheet_id: str = "",
    rects: Sequence[BBox] = (),
    leaders: Sequence[BBox] = (),
    regions: Sequence[dict[str, Any]] | None = None,
    exclude: Sequence[BBox] = (),
    params: CircuitParams | None = None,
    debug: bool = False,
) -> dict[str, Any]:
    """``kamutan.circuits/1`` document of one sheet (see the module docstring). ``debug`` adds every tag text with
    its role (fixture / switch / note / unplaced) under ``debugTexts``.

    ``spans``: the sheet's text lines (``kamutan.text/1`` lines or ``TextSpan``s); ``detections``: the sheet's
    ``kamutan.detections/1`` detections; ``rects``: small closed rectangles (:func:`enclosing_rects`); ``leaders``:
    open polylines as ``(x0, y0, x1, y1)`` end points (:func:`leader_lines`) — a tag-less switch glyph whose leader
    points at a note that names a tag ("לחצן אוטומט חדר מדרגות C8") takes that tag; ``regions``:
    the version's floor regions (``polygonMm``, ``floor``); ``exclude``: legend / title-block boxes (texts inside
    are never tags)."""
    p = params or CircuitParams()
    lum = [d for d in detections if d.get("class") in LUMINAIRE_CLASSES]
    sw = [d for d in detections if d.get("class") in SWITCH_CLASSES]
    # a symbol of another class with a tag label right beside it is a lighting fixture the detector mis-classified
    # (rubel: the ceiling spots come out as alarm_detector / unknown) — only fixtures carry circuit tags
    other = [
        d
        for d in detections
        if d.get("class") not in LUMINAIRE_CLASSES
        and d.get("class") not in SWITCH_CLASSES
        and d.get("class") not in NEVER_FIXTURE
    ]
    retagged: set[str] = set()
    if other:
        other_boxes = [_det_bbox(d) for d in other]
        lum_boxes0 = [_det_bbox(d) for d in lum]
        for s in spans:
            txt = str(getattr(s, "text", "") or "")
            r = parse_tags(txt)
            if len(r.tags) != 1 or r.is_list or r.words or r.corrected:
                continue
            bb = tuple(float(v) for v in s.bbox)
            if len(bb) != 4 or (bb[3] - bb[1]) < p.min_tag_height_mm:
                continue
            near_lum = min((_gap(bb, b) for b in lum_boxes0), default=1e9)
            for oi, ob in enumerate(other_boxes):
                g = _gap(bb, ob)
                if g <= p.retag_mm and g < near_lum and str(other[oi]["id"]) not in retagged:
                    retagged.add(str(other[oi]["id"]))
        for d in other:
            if str(d["id"]) in retagged:
                lum.append({**d, "reasons": [*list(d.get("reasons") or []), R_RETAGGED]})
    lum_boxes = [_det_bbox(d) for d in lum]
    sw_boxes = [_det_bbox(d) for d in sw]
    polys = _region_polys(regions)

    def excluded(b: BBox) -> bool:
        cx, cy = _center(b)
        return any(e[0] <= cx <= e[2] and e[1] <= cy <= e[3] for e in exclude)

    # ---------------------------------------------------------------- candidate tag texts
    texts: list[_TagText] = []
    notes: list[tuple[str, BBox]] = []  # Hebrew prose lines (timer / stair keywords live here)
    for i, s in enumerate(spans):
        txt = str(getattr(s, "text", "") or "")
        bb = tuple(float(v) for v in s.bbox)
        if len(bb) != 4:
            continue
        box = (bb[0], bb[1], bb[2], bb[3])
        if _HEB.search(txt) and len(txt) >= 4:
            notes.append((txt, box))
        if not txt or len(txt) > 120 or excluded(box):
            continue
        w_mm, h_mm = box[2] - box[0], box[3] - box[1]
        if (h_mm > p.max_tag_height_mm and w_mm > p.max_tag_height_mm) or min(w_mm, h_mm) < p.min_tag_height_mm:
            continue  # a title (vertical tags are narrow) or a glyph-reader crumb
        read = parse_tags(txt)
        if not read.tags:
            continue
        if _he_number_words(txt) and not read.is_list:
            # a sentence that happens to contain a tag ("הזנה לתאורת דוקרנים ושעון שבת A4") — a note mention
            texts.append(_TagText(i, txt, box, read, role="note"))
            continue
        texts.append(_TagText(i, txt, box, read))
    # enclosing small rectangles (switch boxes / note frames)
    for t in texts:
        best: BBox | None = None
        mg = p.box_margin_mm
        tcx, tcy = _center(t.bbox)
        for rc in rects:
            inside = rc[0] - mg <= t.bbox[0] and rc[1] - mg <= t.bbox[1] and t.bbox[2] <= rc[2] + mg and t.bbox[3] <= rc[3] + mg
            if not inside or max(rc[2] - rc[0], rc[3] - rc[1]) > p.box_max_mm:
                continue
            if not (rc[0] <= tcx <= rc[2] and rc[1] <= tcy <= rc[3]):
                continue  # the text centre must sit in the box (stacked boxes share edges)
            if best is None or (rc[2] - rc[0]) * (rc[3] - rc[1]) < (best[2] - best[0]) * (best[3] - best[1]):
                best = rc
        t.box = best

    # ---------------------------------------------------------------- fixture tags (single tag, nearest luminaire)
    cand: list[tuple[float, int, int]] = []  # (gap, text idx, luminaire idx)
    for ti, t in enumerate(texts):
        if t.role or t.read.is_list or len(t.read.tags) != 1 or t.read.words:
            continue
        boxed = t.box is not None and (t.box[2] - t.box[0]) < 40 and (t.box[3] - t.box[1]) < 40
        if boxed and t.box is not None and not any(_gap(t.box, lb) == 0 for lb in lum_boxes):
            continue  # a boxed single tag is a one-row switch box (rubel "T1") unless a luminaire sits in the box
        near_sw = min((_gap(t.bbox, b) for b in sw_boxes), default=1e9)
        for li, lb in enumerate(lum_boxes):
            g = _gap(t.bbox, lb)
            if g <= p.fixture_tag_mm and g <= near_sw:
                cand.append((g, ti, li))
    cand.sort()
    taken_text: set[int] = set()
    fixture_tag: dict[int, _TagText] = {}  # luminaire idx → tag text
    for g, ti, li in cand:
        if ti in taken_text or li in fixture_tag:
            continue
        taken_text.add(ti)
        fixture_tag[li] = texts[ti]
        texts[ti].role = "fixture"
        texts[ti].fixture_id = str(lum[li]["id"])

    # second pass: a fixture still untagged takes the single tag of a leader note / a lone tag label nearby
    # ("הזנה לשנאי עבור פרופיל לד A1 H=200" written above the strip it feeds)
    cand2: list[tuple[float, int, int]] = []
    for ti, t in enumerate(texts):
        if t.role not in ("", "note") or ti in taken_text or len(t.read.tags) != 1 or t.read.is_list:
            continue
        if t.box is not None:
            continue
        near_sw = min((_gap(t.bbox, b) for b in sw_boxes), default=1e9)
        if near_sw <= p.switch_tag_mm and t.role == "":
            continue  # a switch tag
        for li, lb in enumerate(lum_boxes):
            if li in fixture_tag:
                continue
            g = _gap(t.bbox, lb)
            if g <= p.leader_tag_mm:
                cand2.append((g, ti, li))
    cand2.sort()
    for g, ti, li in cand2:
        if ti in taken_text or li in fixture_tag:
            continue
        taken_text.add(ti)
        fixture_tag[li] = texts[ti]
        texts[ti].role = "fixture"
        texts[ti].fixture_id = str(lum[li]["id"])

    # ---------------------------------------------------------------- switch lists → positions / notes
    lists = [t for t in texts if not t.role]
    for t in lists:
        has_glyph = any(_gap(t.bbox, b) <= p.switch_tag_mm for b in sw_boxes)
        cx, cy = _center(t.bbox)
        in_plan = not polys or any(_in_poly(cx, cy, poly) for _, poly in polys)
        if has_glyph:
            t.role = "switch"
            continue
        if t.box is not None and (t.box[2] - t.box[0]) >= p.box_min_w_mm:
            # a framed list: a switch box (rubel: rows of tags, list words) unless the frame also holds Hebrew prose
            # (the timer note "תאורות שנדלקות ע"י שעון שבת … D6 D3")
            frame_prose = any(_gap(t.box, nb) == 0 and _he_number_words(nt) and not parse_tags(nt).tags for nt, nb in notes)
            t.role = "note" if frame_prose else "switch"
            continue
        same_row_prose = any(abs(_center(nb)[1] - cy) <= 1.5 and _gap(t.bbox, nb) <= 12 and len(nt) >= 6 for nt, nb in notes)
        kw_near = any(_gap(t.bbox, nb) <= p.note_word_mm and (_timer_note(nt) or _stair_note(nt)) for nt, nb in notes)
        if t.read.is_list and not kw_near and in_plan:
            t.role = "switch"  # a comma list / range in the plan is a switch list even without a frame
        elif same_row_prose or not in_plan or kw_near:
            t.role = "note"
        else:
            t.role = "unplaced"  # a lone tag with no fixture, glyph, frame or note around it: reported, never guessed
    # cluster the switch lists into positions (union-find on proximity / shared box)
    sw_texts = [t for t in texts if t.role == "switch"]
    parent = list(range(len(sw_texts)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(sw_texts)):
        for j in range(i + 1, len(sw_texts)):
            a, b = sw_texts[i], sw_texts[j]
            same_box = a.box is not None and a.box == b.box
            if same_box or _gap(a.bbox, b.bbox) <= p.position_merge_mm:
                parent[find(i)] = find(j)
    groups: dict[int, list[_TagText]] = {}
    for i, t in enumerate(sw_texts):
        groups.setdefault(find(i), []).append(t)
    positions: list[_Position] = []
    used_sw: set[int] = set()
    for members in sorted(groups.values(), key=lambda ms: (ms[0].bbox[1], ms[0].bbox[0])):
        bb = _union([m.bbox for m in members])
        ids: list[str] = []
        for si, sb in enumerate(sw_boxes):
            if si in used_sw:
                continue
            if any(_gap(m.bbox, sb) <= p.switch_tag_mm for m in members):
                ids.append(str(sw[si]["id"]))
                used_sw.add(si)
        tags: list[str] = []
        for m in members:
            for tg in m.read.ids:
                if tg not in tags:
                    tags.append(tg)
        pos = _Position(f"sp_{len(positions) + 1}", members, tags, ids, bb, members[0].box)
        if not ids:
            pos.reasons.append(R_POSITION_NO_GLYPH)
        positions.append(pos)

    # switch glyphs without a tag whose leader line points at a tag mention → a position of that tag
    for si, sb in enumerate(sw_boxes):
        if si in used_sw:
            continue
        for ld in leaders:
            ends = ((ld[0], ld[1]), (ld[2], ld[3]))
            at_glyph = [e for e in ends if _gap(sb, (e[0], e[1], e[0], e[1])) <= p.leader_end_mm]
            if not at_glyph or len(at_glyph) == 2:
                continue
            far_pt = ends[0] if at_glyph[0] == ends[1] else ends[1]
            far_box = (far_pt[0], far_pt[1], far_pt[0], far_pt[1])
            named = [
                t for t in texts
                if t.role in ("note", "unplaced") and not t.read.is_list and _gap(t.bbox, far_box) <= p.leader_note_mm
            ]  # fmt: skip
            if not named:
                # the leader ends at the Hebrew part of the note; the tag sits on the same row within a few mm
                row = [nb for nt, nb in notes if _gap(nb, far_box) <= p.leader_note_mm]
                named = [
                    t for t in texts
                    if t.role in ("note", "unplaced") and not t.read.is_list
                    and any(abs(_center(nb)[1] - _center(t.bbox)[1]) <= 1.5 and _gap(nb, t.bbox) <= 12 for nb in row)
                ]  # fmt: skip
            if not named:
                continue
            t = named[0]
            pos = _Position(f"sp_{len(positions) + 1}", [t], list(t.read.ids), [str(sw[si]["id"])], sb, None, [R_LEADER_TAG])
            positions.append(pos)
            used_sw.add(si)
            break

    # ---------------------------------------------------------------- notes: timer / stair lists
    timer_tags: dict[str, bool] = {}  # tag → keyword read
    stair_tags: set[str] = set()
    for t in texts:
        if t.role != "note":
            continue
        ctx = " ".join([t.text, *(nt for nt, nb in notes if _gap(t.bbox, nb) <= p.note_ctx_mm)])
        kw_timer = _timer_note(ctx)
        kw_stair = _stair_note(ctx)
        prose = bool(t.read.words) or _he_number_words(t.text)
        own_timer = _timer_note(t.text)
        # a tag on the same row as Hebrew prose is a mention inside a leader note ("… פרופיל לד A1 H=200"), unless
        # that prose is the timer sentence itself
        row_prose = [
            nt for nt, nb in notes if abs(_center(nb)[1] - _center(t.bbox)[1]) <= 1.5 and _gap(t.bbox, nb) <= 25 and len(nt) >= 4
        ]
        mention = (prose and not own_timer) or (bool(row_prose) and not kw_timer) or (t.read.corrected and not kw_timer)
        for tg in t.read.ids:
            if kw_stair:
                stair_tags.add(tg)
                continue
            if mention:
                continue
            timer_tags[tg] = timer_tags.get(tg, False) or kw_timer

    # ---------------------------------------------------------------- circuits per tag
    by_tag_fixtures: dict[str, list[int]] = {}
    for li, t in fixture_tag.items():
        by_tag_fixtures.setdefault(t.read.ids[0], []).append(li)
    by_tag_positions: dict[str, list[_Position]] = {}
    for pos in positions:
        for tg in pos.tags:
            by_tag_positions.setdefault(tg, []).append(pos)
    all_tags = sorted(set(by_tag_fixtures) | set(by_tag_positions) | set(timer_tags), key=_tag_sort)
    circuits: list[dict[str, Any]] = []
    unmatched_tags: list[dict[str, Any]] = []
    for tg in all_tags:
        lis = by_tag_fixtures.get(tg, [])
        poss = by_tag_positions.get(tg, [])
        if not lis:
            if poss:
                unmatched_tags.append(
                    {
                        "tag": tg,
                        "positionIds": [q.id for q in poss],
                        "reason": R_TAG_NO_FIXTURE,
                        "bboxMm": _bbox_dict(poss[0].bbox),
                    }
                )
            continue
        fixtures = [lum[li] for li in lis]
        n_pos = len(poss)
        reasons: list[str] = []
        if n_pos == 0:
            kind = "timer" if tg in timer_tags else "no_switch"
            if kind == "timer" and not timer_tags[tg]:
                reasons.append(R_TIMER_WORD_UNREAD)
        elif n_pos == 1:
            kind = "single" if len(fixtures) == 1 else "shared"
        elif n_pos == 2:
            kind = "two_way"
        else:
            kind = "cross"
        if any(fixture_tag[li].read.corrected for li in lis) or any(m.read.corrected for q in poss for m in q.texts):
            reasons.append(R_TAG_CORRECTED)
        if any(str(lum[li]["id"]) in retagged for li in lis):
            reasons.append(R_RETAGGED)
        for q in poss:
            for pr in q.reasons:
                if pr not in reasons:
                    reasons.append(pr)
        floors = [str(d.get("floor")) for d in fixtures if d.get("floor")]
        floor = max(set(floors), key=floors.count) if floors else _floor_at(_center(_det_bbox(fixtures[0])), polys)
        evidence: list[dict[str, Any]] = [
            {
                "kind": "tag",
                "text": fixture_tag[li].text,
                "bboxMm": _bbox_dict(fixture_tag[li].bbox),
                "detectionId": str(lum[li]["id"]),
            }
            for li in lis
        ] + [
            {
                "kind": "switch_list",
                "text": m.text,
                "bboxMm": _bbox_dict(m.bbox),
                "positionId": q.id,
                "detectionIds": q.switch_ids,
            }
            for q in poss
            for m in q.texts
        ]
        if tg in timer_tags:
            evidence.append({"kind": "timer_note", "tag": tg, "keywordRead": bool(timer_tags[tg])})
        circuits.append(
            {
                "id": f"c_{tg}",
                "tag": tg,
                "kind": kind,
                "fixtureIds": [str(d["id"]) for d in fixtures],
                "switchIds": [i for q in poss for i in _glyphs_of(q, tg, sw, sw_boxes)],
                "positionIds": [q.id for q in poss],
                "positions": n_pos,
                "fixtures": len(fixtures),
                "floor": floor,
                "timer": tg in timer_tags and n_pos == 0,
                "stairAutomat": tg in stair_tags,
                "level": "yellow" if reasons else "green",
                "reasons": reasons,
                "evidence": evidence,
            }
        )
    # a fixture without a tag but with a switch glyph right beside it is a wall light with its own switch
    # ("מפסק מובנה קבוע H=110" on achituv): a single point of its own, tagged after the glyph's tag with a star
    builtin: list[tuple[int, _Position]] = []
    for li, d in enumerate(lum):
        if li in fixture_tag or d.get("class") == "ceiling_fan":
            continue
        lb = lum_boxes[li]
        near = [
            q
            for q in positions
            if any(_gap(lb, sw_boxes[si]) <= p.switch_tag_mm for si, sd in enumerate(sw) if str(sd["id"]) in q.switch_ids)
        ]
        if len(near) == 1 and near[0].tags:
            builtin.append((li, near[0]))
    for li, q in builtin:
        d = lum[li]
        tg = f"{q.tags[0]}*"
        n = sum(1 for c in circuits if c["tag"].startswith(tg))
        tag_id = tg if not n else f"{tg}{n + 1}"
        fixture_tag[li] = _TagText(-1, tag_id, _det_bbox(d), parse_tags(q.tags[0]), role="fixture", fixture_id=str(d["id"]))
        floors = [str(d["floor"])] if d.get("floor") else []
        circuits.append(
            {
                "id": f"c_{tag_id}",
                "tag": tag_id,
                "kind": "single",
                "fixtureIds": [str(d["id"])],
                "switchIds": list(q.switch_ids),
                "positionIds": [q.id],
                "positions": 1,
                "fixtures": 1,
                "floor": floors[0] if floors else _floor_at(_center(_det_bbox(d)), polys),
                "timer": False,
                "stairAutomat": False,
                "level": "yellow",
                "reasons": [R_BUILTIN_SWITCH],
                "evidence": [
                    {"kind": "builtin_switch", "detectionId": str(d["id"]), "positionId": q.id, "detectionIds": q.switch_ids}
                ],
            }
        )
    # fans carry no circuit tag of their own on these plans (their own BOQ line): not "untagged"
    untagged = [str(d["id"]) for li, d in enumerate(lum) if li not in fixture_tag and d.get("class") != "ceiling_fan"]
    unplaced = [{"text": t.text, "bboxMm": _bbox_dict(t.bbox), "tags": t.read.ids} for t in texts if t.role == "unplaced"]
    if untagged:
        for c in circuits:
            if R_UNMATCHED_ON_SHEET not in c["reasons"]:
                c["reasons"].append(R_UNMATCHED_ON_SHEET)
                c["level"] = "yellow"
    stats = {
        "circuits": len(circuits),
        "byKind": {k: sum(1 for c in circuits if c["kind"] == k) for k in CIRCUIT_KINDS if any(c["kind"] == k for c in circuits)},
        "fixtures": len(lum),
        "taggedFixtures": len(fixture_tag),
        "untaggedFixtures": len(untagged),
        "positions": len(positions),
        "positionsWithoutGlyph": sum(1 for q in positions if not q.switch_ids),
        "unmatchedTags": len(unmatched_tags),
        "unplacedTexts": len(unplaced),
        "timerTags": sorted((tg for tg in timer_tags if tg in by_tag_fixtures), key=_tag_sort),
        "green": sum(1 for c in circuits if c["level"] == "green"),
        "yellow": sum(1 for c in circuits if c["level"] != "green"),
    }
    return {
        "schema": CIRCUITS_SCHEMA,
        "sheetId": sheet_id,
        **(
            {"debugTexts": [{"text": t.text, "bboxMm": _bbox_dict(t.bbox), "role": t.role, "box": t.box} for t in texts]}
            if debug
            else {}
        ),
        "circuits": circuits,
        "positions": [
            {
                "id": q.id,
                "tags": q.tags,
                "switchIds": q.switch_ids,
                "bboxMm": _bbox_dict(q.bbox),
                "boxMm": _bbox_dict(q.box) if q.box else None,
                "texts": [m.text for m in q.texts],
                "reasons": q.reasons,
            }
            for q in positions
        ],
        "unmatched": {"fixtureIds": untagged, "tags": unmatched_tags, "texts": unplaced},
        "stats": stats,
    }


def _glyphs_of(q: _Position, tg: str, sw: Sequence[dict[str, Any]], sw_boxes: Sequence[BBox]) -> list[str]:
    """The switch glyphs of position ``q`` that control ``tg``: the glyph nearest each single-tag text naming it; a
    text that names several tags (a range at a gang, a box row) stands for every glyph of the position."""
    idx = {str(d["id"]): i for i, d in enumerate(sw)}
    ids = [i for i in q.switch_ids if i in idx]
    if len(ids) <= 1:
        return list(q.switch_ids)
    out: list[str] = []
    for m in q.texts:
        if tg not in m.read.ids:
            continue
        if len(m.read.tags) != 1:
            return list(q.switch_ids)
        best = min(ids, key=lambda i: _gap(m.bbox, sw_boxes[idx[i]]))
        if best not in out:
            out.append(best)
    return out or list(q.switch_ids)


def _tag_sort(tg: str) -> tuple[str, int, str]:
    m = re.match(r"([A-Z]+)(\d+)(.*)", tg)
    return (m.group(1), int(m.group(2)), m.group(3)) if m else (tg, 0, "")


def _bbox_dict(b: BBox) -> dict[str, float]:
    return {"x": round(b[0], 2), "y": round(b[1], 2), "w": round(b[2] - b[0], 2), "h": round(b[3] - b[1], 2)}


def _floor_at(pt: tuple[float, float], polys: list[tuple[str | None, list[tuple[float, float]]]]) -> str | None:
    for fl, poly in polys:
        if _in_poly(pt[0], pt[1], poly):
            return str(fl) if fl else None
    return None


def circuit_stats(doc: dict[str, Any] | None) -> dict[str, Any]:
    return dict((doc or {}).get("stats") or {})


__all__ = [
    "CIRCUITS_SCHEMA",
    "CIRCUIT_KINDS",
    "CircuitParams",
    "Tag",
    "build_circuits",
    "circuit_stats",
    "enclosing_rects",
    "leader_lines",
]
