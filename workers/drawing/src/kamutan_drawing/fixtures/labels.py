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
    # 'קנ"מ' (Sprint 11, Worker-Areas): a drawing title ("חזית מקלחון קנ"מ 1:25" under an elevation detail), not a point
    (None, ("ברז לניאגרה", "פירוק", "הריסה", "לביטול", "משאבה", "חדר כביסה", "ומייבש", 'קנ"מ')),
    ("wc_monoblock", ("מונובלוק", "מונו בלוק")),
    # Sprint 11 (Worker-Areas): "מיכל הדחה סמוי" is the designer's other name of the concealed cistern (Achituv)
    ("wc_concealed", ("ניאגרה סמויה", "מרכז ניאגרה", "מסתור ניאגרה", "אסלה תלויה", "ניאגרה נמוכה", "מיכל הדחה")),
    ("garden_tap", ("ברז גן", "תמי 4", "תמי4", "לתמי")),
    ("faucet_wall", ("ברז קיר",)),
    ("faucet_basin", ("ברז פרח", "ברז עומד", "סוללה עומדת")),
    ("washer", ("מכונת כביסה", "למכונת", "כביסה")),
    ("ac", ("מזגן", "מאייד", "מעבה")),
    # Sprint 11 (Worker-Areas): the parts of a shower / bath point as the boxed notes name them — "ראש טוש / דוש
    # מהתקרה", "נק' מים מאחז" (hand shower), "קופסת ניקוז", "ניקוז רגיל"
    ("bath", ("אמבטיה", "אמבט")),
    (
        "shower",
        ("מקלחון", "מקלחת", "ראש גשם", "תעלת ניקוז", "מזלף", "ראש טוש", "ראש דוש", "מים מאחז", "קופסת ניקוז", "ניקוז רגיל"),
    ),
    ("mixer", ("אינטרפוץ", "אינטרפוצ", "מערבל")),
    ("kitchen_sink", ("כיור מטבח", "קערת מטבח")),
    ("sink_point", ("נק מים+ביוב", "נק מים וביוב", "מים+ביוב", "מים וביוב", "כיור")),
]
_NORM_RULES: list[tuple[str | None, tuple[str, ...]]] = [(k, tuple(normalise(w) for w in ws)) for k, ws in RULES]
# boxed notes only (Sprint 11): "אביק פיית מילוי" in its own box with a leader is the bath's filler point — on Noah the
# same words are a loose remark beside a tub that is already drawn
BOXED_RULES: list[tuple[str, tuple[str, ...]]] = [("bath", (normalise("פיית מילוי"),))]
_HEB = re.compile(r"[א-ת]")
# short abbreviations matched as whole tokens on the raw text ("מ.א" = AC indoor unit, "מ.כ" = washing machine)
_ABBREV: list[tuple[str, re.Pattern[str]]] = [
    # "קבלן מ.א" (Sprint 11, Worker-Areas) is the AC contractor ("יסומנו בשטח ע"י קבלן מ.א"), not a unit
    ("ac", re.compile(r"(?<!קבלן)(?:^|[\s(,ל])מ\s?[.\"'״׳]\s?א(?![א-ת])")),
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
    frame: Any = None  # Sprint 11: the note box (:class:`~.leaders.Frame`) the lines are written in

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


def also_kinds(text: str, kind: str | None) -> list[str]:
    """Other point kinds a note names besides its own (Sprint 11): "נק' מים קרים משולבת כביסה + תמי 4 + ניקוז לכביסה"
    is one box for two points — the washing machine and the Tami 4 tap."""
    n = normalise(text)
    out: list[str] = []
    for k in ("garden_tap", "washer"):
        if k != kind and any(kw and kw in n for kk, kws in _NORM_RULES if kk == k for kw in kws):
            out.append(k)
    return out


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


def labels(text: Sequence[Any], frames: Sequence[Any] | None = None) -> list[Label]:
    """Fixture / AC labels of a sheet (blocks with a kind; marker blocks with kind None are dropped).

    ``frames`` (Sprint 11, :class:`~.leaders.Frame` note boxes): the lines written inside one box are one block
    whatever their spacing, and never join the lines of another box (boxed notes are stacked 1 mm apart)."""
    items = [
        t
        for t in text_items(text)
        if (t.bbox[2] - t.bbox[0]) >= (t.bbox[3] - t.bbox[1]) * 0.8
        and t.h <= 6.0
        and len(normalise(t.text)) >= 2
        and t.conf >= 0.3
    ]
    grouped: list[tuple[list[TextItem], Any]] = []
    if frames:
        by_frame: dict[int, list[TextItem]] = {}
        rest: list[TextItem] = []
        for t in items:
            hits = [fk for fk, f in enumerate(frames) if f.holds(t.bbox)]
            if hits:
                fk0 = min(hits, key=lambda q: (frames[q].box[2] - frames[q].box[0]) * (frames[q].box[3] - frames[q].box[1]))
                by_frame.setdefault(fk0, []).append(t)
            else:
                rest.append(t)
        for fk1 in sorted(by_frame):
            grouped.append((sorted(by_frame[fk1], key=lambda t: (t.bbox[1], -t.bbox[2])), frames[fk1]))
        grouped.extend((blk, None) for blk in blocks(rest))
    else:
        grouped = [(blk, None) for blk in blocks(items)]
    out: list[Label] = []
    for blk, frame in grouped:
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
        if not veto and kind is None and frame is not None:
            n_blk = normalise(" ".join(t.text for t in blk))
            for bk, kws in BOXED_RULES:
                if any(kw in n_blk for kw in kws):
                    kind, matched, conf = bk, kws[0], min(1.0, max(0.3, min(t.conf for t in blk)))
                    break
        if veto or kind is None:
            continue
        x0 = min(t.bbox[0] for t in blk)
        y0 = min(t.bbox[1] for t in blk)
        x1 = max(t.bbox[2] for t in blk)
        y1 = max(t.bbox[3] for t in blk)
        out.append(Label(kind, " / ".join(t.text for t in blk), (x0, y0, x1, y1), conf, list(blk), matched, frame))
    return out


# ---------------------------------------------------------------------------------------------- shower parts
_WAYS = re.compile(r"([2-5])\s*דר[כך]")
_PART_WORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("mixer", ("אינטרפוץ", "אינטרפוצ")),
    ("hand", ("מים מאחז", "מאחז")),
    ("rain", ("ראש טוש", "ראש דוש", "ראש גשם")),
    ("channel", ("תעלת ניקוז",)),
    ("box", ("קופסת ניקוז",)),
    ("plain_drain", ("ניקוז רגיל",)),
    ("filler", ("פיית מילוי",)),
)
_NORM_PARTS = tuple((k, tuple(normalise(w) for w in ws)) for k, ws in _PART_WORDS)


def shower_parts(text: str) -> tuple[list[str], int | None]:
    """(parts, ways) named by a shower / bath note, the main one first: ``mixer`` (אינטרפוץ, with its "3 דרך" /
    "4 דרך"), ``hand`` (נק' מים מאחז), ``rain`` (ראש טוש / דוש / גשם), ``channel`` (תעלת ניקוז), ``box`` (קופסת
    ניקוז), ``plain_drain`` (ניקוז רגיל), ``filler`` (bath filler spout). One box may name two ("אינטרפוץ 4 דרך
    H=110 / ראש טוש קירי H=220")."""
    n = normalise(text)
    parts = [k for k, ws in _NORM_PARTS if any(w and w in n for w in ws)]
    if not parts:  # OCR slips ("אינטרפו3"): one fuzzy pass for the long words
        for k, ws in _NORM_PARTS:
            if any(
                len(w) >= 6
                and any(SequenceMatcher(None, w, n[i : i + len(w)]).ratio() >= 0.8 for i in range(max(1, len(n) - len(w) + 1)))
                for w in ws
            ):
                parts.append(k)
                break
    m = _WAYS.search(text)
    return parts, (int(m.group(1)) if m and "mixer" in parts else None)


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
