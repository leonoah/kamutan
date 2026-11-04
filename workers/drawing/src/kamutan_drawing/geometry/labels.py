"""Notes that name geometry: note blocks → keyword flags, their leaders, heights ("H=140") and level marks.

A note names an element when one of its leader terminals ends on / next to it (≤ ``LEADER_HIT_MM``), else when the
note block itself is close (≤ ``NEAR_MM``). Keywords are matched on :func:`rooms.names.normalise` text (no spaces,
quotes, punctuation; final letters folded), so "סגירת  דלת בבלוק" and "סגירת דלת ב-בלוק" both carry ``block`` +
``closure``.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from shapely.geometry import box as sbox
from shapely.geometry.base import BaseGeometry

from ..fixtures.labels import TextItem, blocks, text_items
from ..fixtures.leaders import LeaderIndex
from ..ingest.pdf_vector import VectorSheet
from ..rooms.names import normalise

LEADER_HIT_MM = 2.5
NEAR_MM = 8.0

# flag -> keywords (raw Hebrew; normalised below). Order is irrelevant: a note carries every flag it matches.
KEYWORDS: dict[str, tuple[str, ...]] = {
    "gypsum": ("גבס",),
    "double": ("דו כרומי", "דו קרומי", "דו-כרומי", "כפול", "כפולה", "כפולות"),
    "block": ("בלוק", "בלוקים", "בבלוק"),
    "concrete": ("בטון", "קיר תומך", "תומך", "חומת", "חומה"),
    "demolished": ("הריסה", "להריסה", "פירוק", "לפירוק", "לפרק", "להרוס"),
    "waterproofing": ("איטום",),
    "ceiling": ("תקרה מונמכת", "תקרת גבס", "הנמכת תקרה", "תקרה תותבת", "תותבת", "מזגן עילי", "מעל נגרות"),
    "valance": ("סינר",),
    "curtain": ("וילון",),
    "ventilator": ("ונטה", "ונטות"),
    "closure": ("סגירת", "סגירה"),
    "low": ("קיר נמוך", "קיר חצי", "קיר מונמך"),
    "cladding": ("חיפוי", "בריק", "קרמיקה", "אריחי"),
    "courtyard": ("חצר אנגלית", "ח.אנגלית", "ח. אנגלית", "אנגלית"),
    "cistern": ("מסתור ניאגרה", "ניאגרה"),
    "window": ("חלון",),
    "opening": ("דלת", "פתח", "חלון"),
    "partition": ("מחיצה", "מחיצת", "מחיצות"),
    "ac": ("מיזוג", "מזגן", "מ.א"),
}
_NORM_KW: dict[str, tuple[str, ...]] = {k: tuple(normalise(w) for w in ws) for k, ws in KEYWORDS.items()}
# "ת.ת" / 'ה"ת' = תקרה תותבת (suspended ceiling) — too short for the normalised match, matched on the raw text
_CEILING_ABBREV = re.compile(r"(?:^|[\s(])[תה]\s*[.\"'״׳]\s*ת(?![א-ת])")
HEIGHT_RE = re.compile(r"(?:H|ה)\s*=\s*(\d{2,3})")
# a note's pieces joined with " / ": the SHX reader may split "H=120" into "H" and "120" (the "=" lost)
HEIGHT_JOINED_RE = re.compile(r"(?:^|[\s/])H\s*=?\s*(?:/\s*)?(\d{2,3})(?!\d)")
LEVEL_RE = re.compile(r"(?<![\d.])([+\-±]?\s?\d{1,2}\.\d{2})(?![\d.])")
BARE_H_RE = re.compile(r"^\s*(\d{3})\s*$")
CEILING_RANGE_CM = (180, 420)
GENERAL_NOTE_MIN_CHARS = 60  # title-block notes ("2) מחיצות חדרי רחצה יבנו מגבס ירוק נגד מים") are not labels


def flags_of(text: str) -> set[str]:
    n = normalise(text)
    out = {k for k, ws in _NORM_KW.items() if any(w and w in n for w in ws)}
    if _CEILING_ABBREV.search(text):
        out.add("ceiling")
    return out


def height_of(text: str) -> float | None:
    """``H=140`` → 1.40 m (cm on these drawings; 10–420 cm accepted)."""
    m = HEIGHT_RE.search(text)
    if not m:
        return None
    v = int(m.group(1))
    return v / 100.0 if 10 <= v <= 420 else None


@dataclass
class Note:
    text: str
    bbox: tuple[float, float, float, float]
    flags: set[str]
    height_m: float | None
    terminals: list[tuple[float, float]] = field(default_factory=list)

    @property
    def geom(self) -> BaseGeometry:
        return sbox(*self.bbox)

    def bbox_json(self) -> dict[str, float]:
        x0, y0, x1, y1 = self.bbox
        return {"x": round(x0, 2), "y": round(y0, 2), "w": round(x1 - x0, 2), "h": round(y1 - y0, 2)}


def notes(vs: VectorSheet, spans: Sequence[Any], *, exclude: Sequence[tuple[float, float, float, float]] = ()) -> list[Note]:
    """Note blocks with at least one geometry flag, with their leader terminals."""
    items = [
        t
        for t in text_items(spans)
        if t.h <= 6.0
        and len(normalise(t.text)) >= 2
        and t.conf >= 0.3
        and (t.bbox[2] - t.bbox[0]) >= (t.bbox[3] - t.bbox[1]) * 0.8
    ]
    out: list[Note] = []
    blks = blocks(items)
    flagged: list[tuple[list[TextItem], set[str]]] = []
    for blk in blks:
        txt = " / ".join(t.text for t in blk)
        if len(txt) > 400:
            continue
        fl: set[str] = set()
        for t in blk:
            if len(t.text) >= GENERAL_NOTE_MIN_CHARS:
                continue
            fl |= flags_of(t.text)
        if fl:
            flagged.append((blk, fl))
    if not flagged:
        return out
    idx = LeaderIndex(vs, items)
    from ..fixtures.labels import Label

    for blk, fl in flagged:
        x0 = min(t.bbox[0] for t in blk)
        y0 = min(t.bbox[1] for t in blk)
        x1 = max(t.bbox[2] for t in blk)
        y1 = max(t.bbox[3] for t in blk)
        if any(x0 >= e[0] and y0 >= e[1] and x1 <= e[2] and y1 <= e[3] for e in exclude):
            continue
        txt = " / ".join(t.text for t in blk)
        lab = Label("geometry", txt, (x0, y0, x1, y1), 1.0, list(blk), "")
        try:
            terms = [ld.terminal for ld in idx.follow(lab)]
        except Exception:  # noqa: BLE001 - a leader that cannot be followed is not fatal
            terms = []
        hs = [h for t in blk if (h := height_of(t.text)) is not None]
        if not hs:
            hs = _h_beside_number(blk)
        if not hs and (mj := HEIGHT_JOINED_RE.search(txt)):
            v = int(mj.group(1))
            if 10 <= v <= 420:
                hs = [v / 100.0]
        if not hs and fl & {"cistern", "low"}:
            # "H" read apart and dropped as a one-letter piece: a bare 2–3 digit line of a screen / low-wall note
            bare = [int(t.text.strip()) for t in blk if re.fullmatch(r"\d{2,3}", t.text.strip())]
            if bare and 30 <= bare[0] <= 300:
                hs = [bare[0] / 100.0]
        out.append(Note(txt, (x0, y0, x1, y1), fl, hs[0] if hs else None, terms))
    return out


_LONE_H = re.compile(r"(?:^|[\s/])H\s*=?\s*$")


def _h_beside_number(blk: Sequence[TextItem]) -> list[float]:
    """ "H=140" read as two pieces, "H" and "140": the number on the same row right after the "H" (not a dimension
    of the note's block one row below)."""
    out: list[float] = []
    for t in blk:
        if not _LONE_H.search(t.text):
            continue
        cy, th = (t.bbox[1] + t.bbox[3]) / 2, max(t.bbox[3] - t.bbox[1], 0.5)
        best: tuple[float, int] | None = None
        for u in blk:
            m = re.fullmatch(r"\s*(\d{2,3})\s*", u.text)
            if u is t or not m:
                continue
            uy = (u.bbox[1] + u.bbox[3]) / 2
            gap = u.bbox[0] - t.bbox[2]
            if abs(uy - cy) <= 0.6 * th and -0.5 <= gap <= 4.0 * th and (best is None or gap < best[0]):
                best = (gap, int(m.group(1)))
        if best is not None and 10 <= best[1] <= 420:
            out.append(best[1] / 100.0)
    return out


def ranked_notes(g: BaseGeometry, cands: Sequence[Note], want: set[str] | None = None) -> list[tuple[Note, str, float]]:
    """Every note naming ``g`` (leader hits first, then near blocks), best first."""
    from shapely.geometry import Point

    out: list[tuple[int, float, Note, str]] = []
    for n in cands:
        if want is not None and not (n.flags & want):
            continue
        hits = [g.distance(Point(tx, ty)) for tx, ty in n.terminals]
        hits = [d for d in hits if d <= LEADER_HIT_MM]
        if hits:
            out.append((0, min(hits), n, "leader"))
            continue
        d = g.distance(n.geom)
        if d <= NEAR_MM:
            out.append((1, d, n, "near"))
    out.sort(key=lambda t: (t[0], t[1]))
    return [(n, src, d) for _, d, n, src in out]


def best_note(g: BaseGeometry, cands: Sequence[Note], want: set[str] | None = None) -> tuple[Note | None, str | None, float]:
    """The note naming ``g``: a leader terminal on it first, else the closest block ≤ ``NEAR_MM``.
    ``want``: only notes with one of these flags. Returns (note, "leader"|"near", distance)."""
    best: tuple[float, int, Note | None, str | None] = (1e9, 2, None, None)
    from shapely.geometry import Point

    for n in cands:
        if want is not None and not (n.flags & want):
            continue
        for tx, ty in n.terminals:
            d = g.distance(Point(tx, ty))
            if d <= LEADER_HIT_MM and (0, d) < (best[1], best[0]):
                best = (d, 0, n, "leader")
        d = g.distance(n.geom)
        if d <= NEAR_MM and (1, d) < (best[1], best[0]):
            best = (d, 1, n, "near")
    return best[2], best[3], best[0]


def level_values(spans: Sequence[Any]) -> list[tuple[float, float, float]]:
    """(x, y, value m) of level marks: a short line that is a level number ("-2.55", "+2.96", "0.50")."""
    out: list[tuple[float, float, float]] = []
    for t in text_items(spans):
        s = t.text.strip()
        if len(s) > 14:
            continue
        m = LEVEL_RE.search(s)
        if not m:
            continue
        raw = m.group(1).replace(" ", "").replace("±", "")
        try:
            v = float(raw)
        except ValueError:
            continue
        if abs(v) > 30:
            continue
        out.append(((t.bbox[0] + t.bbox[2]) / 2, (t.bbox[1] + t.bbox[3]) / 2, v))
    return out


def ceiling_marks(spans: Sequence[Any]) -> list[tuple[float, float, float]]:
    """(x, y, ceiling m) from level marks: "H=265" next to / stacked on a level ("-2.55 H=220"), or a bare 3-digit
    number stacked right under a level number (the SHX reader drops "H=": "2.55" over "220")."""
    items = text_items(spans)
    levels = [(t, LEVEL_RE.search(t.text)) for t in items]
    lv = [(t.bbox, m) for t, m in levels if m and len(t.text.strip()) <= 14]
    out: list[tuple[float, float, float]] = []
    for t in items:
        h = height_of(t.text)
        if h is None:
            m = BARE_H_RE.match(t.text)
            if not m:
                continue
            v = int(m.group(1))
            if not (CEILING_RANGE_CM[0] <= v <= CEILING_RANGE_CM[1]):
                continue
            h = v / 100.0
            strict = True
        else:
            if not (CEILING_RANGE_CM[0] / 100 <= h <= CEILING_RANGE_CM[1] / 100):
                continue
            strict = False
        cx, cy = (t.bbox[0] + t.bbox[2]) / 2, (t.bbox[1] + t.bbox[3]) / 2
        hit = False
        for b, _m in lv:
            bx, by = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
            if b == t.bbox and not strict:
                hit = True
                break
            if abs(by - cy) <= 5.0 and abs(bx - cx) <= 8.0 and (not strict or cy > by):
                hit = True
                break
        if hit:
            out.append((cx, cy, round(h, 2)))
    return out
