"""Plumbing / AC labels: text lines → label blocks → label kinds.

Plumbing sheets have no symbol legend; every point is named by a multi-line note ("נק' מים+ביוב / H=50",
"ברז קיר 110 / המידה מתייחסת / למרכז הפיה") joined to the fixture by a leader line. Lines are merged into a
*block* when they are stacked (gap ≤ 0.7 × line height) and aligned (same right or left edge ± 2 mm, or ≥ 50 %
horizontal overlap). The block kind is the first matching rule in :data:`RULES` (order matters: "ברז לניאגרה" is
the cistern stop valve, not a WC).
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Any

from ..rooms.names import normalise

# kind -> keywords (normalised with rooms.names.normalise: no spaces / quotes / punctuation, final letters folded)
# ``None`` kind = marker without a class (stops the search: the block is not a fixture label).
RULES: list[tuple[str | None, tuple[str, ...]]] = [
    (None, ("ברז לניאגרה", "פירוק", "הריסה", "לביטול", "משאבה", "חדר כביסה", "ומייבש")),
    ("wc_monoblock", ("מונובלוק", "מונו בלוק")),
    ("wc_concealed", ("ניאגרה סמויה", "מרכז ניאגרה", "מסתור ניאגרה", "אסלה תלויה", "ניאגרה נמוכה")),
    ("garden_tap", ("ברז גן", "תמי 4", "תמי4", "לתמי")),
    ("faucet_wall", ("ברז קיר",)),
    ("faucet_basin", ("ברז פרח", "ברז עומד", "סוללה עומדת")),
    ("washer", ("מכונת כביסה", "למכונת", "כביסה")),
    ("ac", ("מזגן", "מאייד", "מעבה")),
    ("bath", ("אמבטיה", "אמבט")),
    ("shower", ("מקלחון", "מקלחת", "ראש גשם", "תעלת ניקוז", "מזלף")),
    ("mixer", ("אינטרפוץ", "אינטרפוצ", "מערבל")),
    ("kitchen_sink", ("כיור מטבח", "קערת מטבח")),
    ("sink_point", ("נק מים+ביוב", "נק מים וביוב", "מים+ביוב", "מים וביוב", "כיור")),
]
_NORM_RULES: list[tuple[str | None, tuple[str, ...]]] = [(k, tuple(normalise(w) for w in ws)) for k, ws in RULES]
_HEB = re.compile(r"[א-ת]")
# short abbreviations matched as whole tokens on the raw text ("מ.א" = AC indoor unit, "מ.כ" = washing machine)
_ABBREV: list[tuple[str, re.Pattern[str]]] = [
    ("ac", re.compile(r"(?:^|[\s(,ל])מ\s?[.\"'״׳]\s?א(?![א-ת])")),
    ("washer", re.compile(r"(?:^|[\s(,ל])מ\s?[.\"'״׳]\s?כ(?![א-ת])")),
]
_PRIORITY = {k: i for i, (k, _) in enumerate(RULES) if k is not None}
_BATH_DIMS = re.compile(r"\b(1[4-9]0)\s*/\s*([6-9]0)\b")  # "160/70" written inside a bath


@dataclass
class TextItem:
    bbox: tuple[float, float, float, float]
    text: str
    conf: float

    @property
    def h(self) -> float:
        return max(0.5, self.bbox[3] - self.bbox[1])


@dataclass
class Label:
    kind: str | None
    text: str
    bbox: tuple[float, float, float, float]
    conf: float
    lines: list[TextItem] = field(default_factory=list)
    matched: str = ""

    @property
    def center(self) -> tuple[float, float]:
        return ((self.bbox[0] + self.bbox[2]) / 2, (self.bbox[1] + self.bbox[3]) / 2)


def text_items(text: Sequence[Any]) -> list[TextItem]:
    """Normalise TextLine / TextSpan / SimpleText items to :class:`TextItem` (horizontal-ish lines only kept as is)."""
    out: list[TextItem] = []
    for t in text:
        b = getattr(t, "bbox", None)
        s = str(getattr(t, "text", "") or "")
        if b is None or not s.strip():
            continue
        v = [float(x) for x in list(b)[:4]]
        conf = getattr(t, "conf", None)
        if conf is None:
            conf = getattr(t, "confidence", None)
        out.append(
            TextItem(
                (min(v[0], v[2]), min(v[1], v[3]), max(v[0], v[2]), max(v[1], v[3])),
                s,
                float(conf) if conf is not None else 0.7,
            )
        )
    return out


def classify_text(s: str) -> tuple[str | None, str, float]:
    """(kind, matched keyword, match score) of one text; kind None + score 0 when nothing matches."""
    n = normalise(s)
    if not n or not _HEB.search(s):
        return None, "", 0.0
    for kind, kws in _NORM_RULES:
        for kw in kws:
            if kw and kw in n:
                return kind, kw, 1.0
    for kind, rx in _ABBREV:
        if rx.search(s):
            return kind, rx.pattern, 0.9
    # OCR slips: one fuzzy pass for long keywords only (≥ 6 letters)
    best: tuple[str | None, str, float] = (None, "", 0.0)
    for kind, kws in _NORM_RULES:
        for kw in kws:
            if len(kw) < 6 or len(n) < len(kw) - 1:
                continue
            for i in range(max(1, len(n) - len(kw) + 2)):
                r = SequenceMatcher(None, kw, n[i : i + len(kw)]).ratio()
                if r >= 0.86 and r > best[2]:
                    best = (kind, kw, r)
    if best[0] is None or best[2] == 0.0:
        return None, "", 0.0
    return best


def _aligned(a: TextItem, b: tuple[float, float, float, float]) -> bool:
    ov = min(a.bbox[2], b[2]) - max(a.bbox[0], b[0])
    short = min(a.bbox[2] - a.bbox[0], b[2] - b[0])
    return abs(a.bbox[2] - b[2]) <= 2.0 or abs(a.bbox[0] - b[0]) <= 2.0 or (short > 0 and ov >= 0.5 * short)


def _same_row(a: TextItem, b: TextItem) -> bool:
    """One line split in two by the reader: same row (≥ 50 % vertical overlap), ≤ 1.5 line heights apart."""
    vo = min(a.bbox[3], b.bbox[3]) - max(a.bbox[1], b.bbox[1])
    hg = max(a.bbox[0], b.bbox[0]) - min(a.bbox[2], b.bbox[2])
    return vo >= 0.5 * min(a.h, b.h) and hg <= 1.5 * max(a.h, b.h)


def blocks(items: Sequence[TextItem]) -> list[list[TextItem]]:
    """Stack lines into note blocks (top to bottom); pieces of one line (same row, close) join too."""
    order = sorted(range(len(items)), key=lambda i: (items[i].bbox[1], -items[i].bbox[2]))
    out: list[list[TextItem]] = []
    boxes: list[list[float]] = []
    for i in order:
        it = items[i]
        placed = False
        for k in range(len(out) - 1, -1, -1):
            bb = boxes[k]
            last = out[k][-1]
            gap = it.bbox[1] - last.bbox[3]
            row = any(_same_row(it, m) for m in out[k])
            if not row and (gap > 0.7 * max(it.h, last.h) or gap < -0.6 * min(it.h, last.h)):
                continue
            if not row and not _aligned(it, (bb[0], bb[1], bb[2], bb[3])):
                continue
            out[k].append(it)
            bb[0], bb[1], bb[2], bb[3] = (
                min(bb[0], it.bbox[0]),
                min(bb[1], it.bbox[1]),
                max(bb[2], it.bbox[2]),
                max(bb[3], it.bbox[3]),
            )
            placed = True
            break
        if not placed:
            out.append([it])
            boxes.append(list(it.bbox))
    return out


def labels(text: Sequence[Any]) -> list[Label]:
    """Fixture / AC labels of a sheet (blocks with a kind; marker blocks with kind None are dropped)."""
    items = [
        t
        for t in text_items(text)
        if (t.bbox[2] - t.bbox[0]) >= (t.bbox[3] - t.bbox[1]) * 0.8
        and t.h <= 6.0
        and len(normalise(t.text)) >= 2
        and t.conf >= 0.3
    ]
    out: list[Label] = []
    for blk in blocks(items):
        # the first line with a kind decides; a marker line (kind None with a match) vetoes the whole block
        kind: str | None = None
        matched = ""
        conf = 0.0
        veto = False
        for it in blk:
            k, kw, sc = classify_text(it.text)
            if kw and k is None:
                veto = True
                break
            if k is None:
                continue
            if kind is None or _PRIORITY[k] < _PRIORITY[kind]:
                kind, matched, conf = k, kw, sc * min(1.0, max(0.3, it.conf))
        if veto or kind is None:
            continue
        x0 = min(t.bbox[0] for t in blk)
        y0 = min(t.bbox[1] for t in blk)
        x1 = max(t.bbox[2] for t in blk)
        y1 = max(t.bbox[3] for t in blk)
        out.append(Label(kind, " / ".join(t.text for t in blk), (x0, y0, x1, y1), conf, list(blk), matched))
    return out


def bath_dims(text: Sequence[Any]) -> list[tuple[tuple[float, float], str]]:
    """Centres of "160/70"-like bath size notes (written inside the tub)."""
    out = []
    for it in text_items(text):
        m = _BATH_DIMS.search(it.text.replace(" ", ""))
        if m:
            out.append((((it.bbox[0] + it.bbox[2]) / 2, (it.bbox[1] + it.bbox[3]) / 2), m.group(0)))
    return out


HEIGHT_RE = re.compile(r"(?:H|ה)\s*=\s*(\d{2,3})")


def heights(label: Label) -> list[int]:
    """Mounting heights written in a label ("H=240" is often read as "ה=240", or the H is a separate item)."""
    vals = [int(v) for v in HEIGHT_RE.findall(label.text)]
    if not vals:
        vals = [int(v) for v in re.findall(r"(?<!\d)(\d{2,3})(?!\d)", label.text) if 20 <= int(v) <= 300]
    return vals
