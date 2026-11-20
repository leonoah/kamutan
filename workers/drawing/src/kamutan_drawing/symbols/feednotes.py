"""Named feeds from their notes (Sprint 13, Accuracy).

The designer marks the single named feeds of a house — the three-phase socket of the jacuzzi / induction hob / EV charger
/ "היתרו" water heater / sauna, the feed of the electric awning, the feeds on the roof, the pool machine room — with a
*note*, not with a symbol of their own:

* a **leader note**: the words stand on an underline shelf that runs on (straight or with a bend) to an arrowhead at an
  ordinary glyph (a three-phase socket, the "M" feed ring), 20-70 mm away; or a boxed note with a leader from its frame;
* a **free note**: a boxed list / a cloud / a big remark that points at nothing ("יש לבצע הזנות בגג: 1. הזנה לדוד ...").

The plan text is stroke text read word by word, so a note is first put back together (:func:`note_blocks`: the words of
a row right to left, the rows top to bottom) and then read with a small lexicon that tolerates the reader's known slips
(ק read as ל / כ, ג as ה). A leader note names the glyph at its arrow tip: the canonical word goes onto that detection
as an annotation (the BOQ label rules read annotations), and a two-tick power socket named "תלת" becomes a three-phase
socket. A free note becomes a text-only detection carrying :data:`A_FEED_NOTE`, so the BOQ can count an instruction that
is repeated on several sheets once.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import numpy as np

from ..ingest.pdf_vector import SEG_LINE, VectorSheet

if TYPE_CHECKING:
    from ..ocr.dictionary import TextSpan

BBox = tuple[float, float, float, float]

A_FEED_NOTE = "feednote"  # annotation of a feed read from a note that points at no glyph (ASCII: never an OCR word)
ROW_GAP_H = 2.2  # words of one row stand at most this many text heights apart
ROW_MAX_H_MM = 8.0
BLOCK_GAP_H = 1.1  # rows of one note: the next baseline follows within about a line
BLOCK_MAX_ROWS = 8
LEADER_MIN_SAT = 80  # a leader is drawn in a coloured annotation pen (orange / red / purple)
LEADER_MAX_PEN_MM = 0.45
LEADER_MAX_SEGS = 6
LEADER_MIN_MM = 6.0
LEADER_PAD_MM = 3.0  # the shelf runs under the words; a boxed note's leader starts on its frame
LEADER_JOIN_MM = 0.4
LEADER_MAX_PATHS = 3
TIP_MIN_MM = 4.0  # the tip is this far outside the padded note (a shelf may overshoot its words a little)
TIP_REACH_MM = 5.0  # arrowhead length + the glyph's own stub
NEAR_REACH_MM = 25.0  # no leader found: the nearest socket this close (the Sprint 11 "תלת" reach)
NEAR_REACH_PLAIN_MM = 12.0  # ... and for a note that does not say "תלת" (a label-like distance)
RING_NEAR_MM = 30.0  # a shutter-switch note this close to an "M" ring is that ring's switch

_THREE_PHASE = re.compile(r"תלת")
_FEED_WORD = re.compile(r"הזנ|שקע|ש\.|מפס[קל]")
_CONDUIT = re.compile(r"צינור")


@dataclass(frozen=True)
class Feed:
    key: str
    pattern: re.Pattern[str]
    canon: str  # the word the BOQ label rules match
    classes: tuple[str, ...]  # glyph classes a leader note of this feed may name
    text_cls: str | None  # class of the text-only detection of a free note (None: only a glyph can carry it)
    three_phase: bool = True  # the note must say "תלת"
    needs: re.Pattern[str] | None = None


SOCKETS_3PH = ("socket_3phase", "socket_power")
FEED_RINGS = ("shutter_feed", "heater_feed", "water_heater_feed")
SWITCH_GLYPHS = ("switch_single", "switch_2way", "switch_cross", "switch_shutter")
# order matters: the first feed a note names wins (a jacuzzi note that mentions the pool is the jacuzzi's)
FEEDS: tuple[Feed, ...] = (
    Feed("jacuzzi", re.compile(r"[גה]['׳]?[קלכ]וזי"), "ג'קוזי", SOCKETS_3PH, "socket_3phase"),
    Feed("ev", re.compile(r"טעינה|לרכב|רכב\s*חשמלי"), "טעינה לרכב", SOCKETS_3PH, "socket_3phase"),
    Feed("induction", re.compile(r"אינדו[קלכ]ציה|כיריי[םמ]"), "אינדוקציה", SOCKETS_3PH, "socket_3phase"),
    Feed("hydro", re.compile(r"היתרו"), "היתרו", SOCKETS_3PH, "socket_3phase"),
    Feed("sauna", re.compile(r"סאונה"), "סאונה", SOCKETS_3PH, "socket_3phase"),
    Feed("ac", re.compile(r"מז[גה]ן|מיזו[גה]"), "מזגן", SOCKETS_3PH, None),
    Feed("pool", re.compile(r"בריכ|מכונות"), "חדר מכונות בריכה", SOCKETS_3PH, "socket_3phase"),
    Feed("awning", re.compile(r"סוכך|פר[גה]ול"), "סוכך", FEED_RINGS, None, three_phase=False, needs=re.compile(r"הזנ")),
    # "מפסק תריס בריכה": a shutter marked by its switch only (no "M" ring) — counted when the note names no glyph. The
    # note names which shutter; the legend row "מפסק לתריס" does not
    Feed(
        "shutter",
        re.compile(r"מפס[קל]\s*תריס\s+[א-ת]{3,}"),
        "תריס",
        (*SWITCH_GLYPHS, *FEED_RINGS),
        "switch_shutter",
        three_phase=False,
    ),
    Feed(
        "roof_boiler",
        re.compile(r"הזנה\s*לדוד"),
        "דוד שמש וחימום מים בגג",
        (),
        "heater_feed",
        three_phase=False,
        needs=re.compile(r"חימום|בצמוד\s*לדוד"),
    ),
)


@dataclass
class Note:
    text: str
    bbox: BBox
    rows: int = 1


@dataclass
class NamedFeed:
    feed: Feed
    note: Note
    det: int | None = None  # index of the detection the note names (None: a free note)
    tip: tuple[float, float] | None = None
    reclass: bool = False


@dataclass
class _Row:
    bbox: BBox
    h: float
    words: list[tuple[float, str]] = field(default_factory=list)  # (x of the word's right edge, text)

    @property
    def text(self) -> str:
        return " ".join(w for _, w in sorted(self.words, key=lambda q: -q[0]))


def _union(a: BBox, b: BBox) -> BBox:
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


def note_blocks(spans: list[TextSpan]) -> list[Note]:
    """Notes of a sheet from its word spans: horizontal words of about one height on one baseline are a row (read right
    to left); rows of about one height directly under each other with overlapping extents are one note."""
    words = []
    for s in spans:
        x0, y0, x1, y1 = s.bbox
        h = y1 - y0
        if (
            not s.text.strip()
            or getattr(s, "rotation", 0) not in (0, None)
            or not (0.8 <= h <= ROW_MAX_H_MM)
            or x1 - x0 < 0.5 * h
        ):
            continue
        words.append((s.bbox, h, s.text.strip()))
    rows: list[_Row] = []
    for bb, h, t in sorted(words, key=lambda w: -w[0][2]):
        best: _Row | None = None
        best_gap = math.inf
        for r in rows:
            if not (0.5 <= h / r.h <= 2.0):  # a word with a descender ("לג'קוזי") is taller than its neighbours
                continue
            ov = min(bb[3], r.bbox[3]) - max(bb[1], r.bbox[1])
            if ov < 0.5 * min(h, r.h):
                continue
            gap = max(r.bbox[0] - bb[2], bb[0] - r.bbox[2])
            if gap <= ROW_GAP_H * max(h, r.h) and gap < best_gap:
                best, best_gap = r, gap
        if best is None:
            rows.append(_Row(bb, h, [(bb[2], t)]))
        else:
            best.bbox = _union(best.bbox, bb)
            best.words.append((bb[2], t))
    rows.sort(key=lambda r: (r.bbox[1], -r.bbox[2]))
    used = [False] * len(rows)
    notes: list[Note] = []
    for i, r in enumerate(rows):
        if used[i]:
            continue
        used[i] = True
        chain = [r]
        box = r.bbox
        grown = True
        while grown and len(chain) < BLOCK_MAX_ROWS:
            grown = False
            last = chain[-1]
            for j, o in enumerate(rows):
                if used[j] or not (0.6 <= o.h / last.h <= 1.6):
                    continue
                gap = o.bbox[1] - last.bbox[3]
                if not (-0.3 * last.h <= gap <= BLOCK_GAP_H * last.h):
                    continue
                if min(box[2], o.bbox[2]) - max(box[0], o.bbox[0]) <= 0.0:
                    continue
                used[j] = True
                chain.append(o)
                box = _union(box, o.bbox)
                grown = True
                break
        notes.append(Note(" ".join(c.text for c in chain), box, len(chain)))
    return notes


def classify(text: str) -> Feed | None:
    """The feed a note names, or None. A three-phase feed needs "תלת" in the note; every feed needs a feed word."""
    if not _FEED_WORD.search(text) and not _THREE_PHASE.search(text):
        return None
    for f in FEEDS:
        if not f.pattern.search(text):
            continue
        if f.three_phase and not _THREE_PHASE.search(text):
            continue
        if f.needs is not None and not f.needs.search(text):
            continue
        return f
    return None


class Leaders:
    """Leader polylines of a sheet: thin solid coloured non-text paths of a few straight pieces."""

    def __init__(self, vs: VectorSheet, text_paths: set[int]) -> None:
        self.ends: list[tuple[np.ndarray, np.ndarray]] = []  # per leader path: its two free ends
        self.segs: list[np.ndarray] = []
        if not vs.n_paths or not vs.n_segs:
            return
        rgb = vs.path_stroke_rgba[:, :3].astype(int)
        sat = (rgb.max(axis=1) - rgb.min(axis=1)) >= LEADER_MIN_SAT
        solid = np.array([len(d) == 0 for d in vs.path_dash], bool)
        bb = vs.path_bbox.astype(float)
        diag = np.hypot(bb[:, 2] - bb[:, 0], bb[:, 3] - bb[:, 1])
        ok = vs.path_stroked & solid & sat & (vs.path_width_mm < LEADER_MAX_PEN_MM) & (vs.path_fill_mode == 0)
        ok &= (vs.path_seg_count <= LEADER_MAX_SEGS) & (diag >= LEADER_MIN_MM)
        if text_paths:
            ok[[p for p in text_paths if 0 <= p < len(ok)]] = False
        sel = np.where(ok[vs.seg_path])[0]
        by_path: dict[int, list[int]] = {}
        for i in sel:
            by_path.setdefault(int(vs.seg_path[i]), []).append(int(i))
        for idx in by_path.values():
            if any(int(vs.seg_kind[i]) != SEG_LINE for i in idx):
                continue
            s = vs.segs[idx].astype(float)
            pts = np.concatenate([s[:, :2], s[:, 2:]])
            free = [p for k, p in enumerate(pts) if int((np.hypot(*(pts - p).T) <= LEADER_JOIN_MM).sum()) == 1]
            if len(free) != 2:
                continue  # a closed frame or a branching path is not a leader
            self.ends.append((free[0], free[1]))
            self.segs.append(s)

    def tips(self, box: BBox) -> list[tuple[float, float]]:
        """Far ends of the leaders that start at the note ``box`` (a shelf under it or a line from its frame)."""
        x0, y0, x1, y1 = box[0] - LEADER_PAD_MM, box[1] - LEADER_PAD_MM, box[2] + LEADER_PAD_MM, box[3] + LEADER_PAD_MM

        def gap(p: np.ndarray) -> float:
            return math.hypot(max(x0 - p[0], 0.0, p[0] - x1), max(y0 - p[1], 0.0, p[1] - y1))

        out: list[tuple[float, float]] = []
        for k, (a, b) in enumerate(self.ends):
            s = self.segs[k]
            touch = (
                (np.minimum(s[:, 0], s[:, 2]) <= x1)
                & (np.maximum(s[:, 0], s[:, 2]) >= x0)
                & (np.minimum(s[:, 1], s[:, 3]) <= y1)
                & (np.maximum(s[:, 1], s[:, 3]) >= y0)
            )
            if not touch.any():
                continue
            for at, away in ((a, b), (b, a)):
                if gap(at) > 0.0:
                    continue  # the walk starts from an end that is at the note
                far, cur = away, k
                # a leader drawn in several paths: the shelf, then the line to the glyph
                for _ in range(LEADER_MAX_PATHS - 1):
                    nxt: tuple[int, np.ndarray] | None = None
                    for j, (c, d) in enumerate(self.ends):
                        if j == cur:
                            continue
                        if math.dist(c, far) <= LEADER_JOIN_MM:
                            nxt = (j, d)
                        elif math.dist(d, far) <= LEADER_JOIN_MM:
                            nxt = (j, c)
                        if nxt is not None:
                            break
                    if nxt is None:
                        break
                    cur, far = nxt
                if gap(far) >= TIP_MIN_MM:
                    out.append((float(far[0]), float(far[1])))
        return out


def _box_gap(p: tuple[float, float], b: BBox) -> float:
    return math.hypot(max(b[0] - p[0], 0.0, p[0] - b[2]), max(b[1] - p[1], 0.0, p[1] - b[3]))


def _boxes_gap(a: BBox, b: BBox) -> float:
    return math.hypot(max(a[0] - b[2], 0.0, b[0] - a[2]), max(a[1] - b[3], 0.0, b[1] - a[3]))


def read_named_feeds(
    spans: list[TextSpan],
    dets: list[tuple[str, BBox, bool]],
    vs: VectorSheet | None,
    text_paths: set[int] | None = None,
) -> list[NamedFeed]:
    """Named feeds of a sheet. ``dets``: (class, bbox, is a drawn glyph) per detection, in the caller's order.

    A note binds to the glyph at its leader tip (an allowed class, within :data:`TIP_REACH_MM`); a note without a leader
    binds to the nearest three-phase / power socket within :data:`NEAR_REACH_MM`. A note about a *conduit* for the
    appliance ("צינור חופשי עבור ...") never names a glyph. Notes that bind to nothing are free notes; a free note is
    dropped when a glyph on the sheet already carries the same feed (the note explains that glyph), and two free notes of
    one feed on a sheet are one."""
    leaders = Leaders(vs, text_paths or set()) if vs is not None else None
    found: list[NamedFeed] = []
    taken: dict[int, str] = {}
    for n in note_blocks(spans):
        f = classify(n.text)
        if f is None:
            continue
        nf = NamedFeed(f, n)
        if f.classes and not _CONDUIT.search(n.text):
            cand: list[tuple[float, int, tuple[float, float] | None]] = []
            for tip in leaders.tips(n.bbox) if leaders is not None else []:
                for di, (cls, bb, glyph) in enumerate(dets):
                    if glyph and cls in f.classes and (g := _box_gap(tip, bb)) <= TIP_REACH_MM:
                        cand.append((g, di, tip))
            if not cand:
                reach = NEAR_REACH_MM if f.three_phase else NEAR_REACH_PLAIN_MM
                for di, (cls, bb, glyph) in enumerate(dets):
                    if glyph and cls in f.classes and (g := _boxes_gap(n.bbox, bb)) <= reach:
                        cand.append((NEAR_REACH_MM + g, di, None))
            cand = [c for c in cand if taken.get(c[1], f.key) == f.key]
            if cand:
                _, di, at = min(cand, key=lambda c: (c[0], c[1]))
                nf.det, nf.tip = di, at
                nf.reclass = f.three_phase and dets[di][0] == "socket_power"
                taken[di] = f.key
        found.append(nf)
    bound = {nf.feed.key for nf in found if nf.det is not None}
    out: list[NamedFeed] = []
    seen_free: set[str] = set()
    seen_det: set[int] = set()
    for nf in found:
        if nf.det is not None:
            if nf.det not in seen_det:
                seen_det.add(nf.det)
                out.append(nf)
            continue
        if nf.feed.text_cls is None or nf.feed.key in bound or nf.feed.key in seen_free:
            continue
        if nf.feed.key == "shutter" and any(
            glyph and cls == "shutter_feed" and _boxes_gap(nf.note.bbox, bb) <= RING_NEAR_MM for cls, bb, glyph in dets
        ):
            continue
        seen_free.add(nf.feed.key)
        out.append(nf)
    return out
