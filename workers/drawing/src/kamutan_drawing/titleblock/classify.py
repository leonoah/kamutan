"""Title block location, field reading and sheet classification.

Input: text spans (``ocr.dictionary.text_spans``) + vector primitives of one sheet.
The sample set's title block is a bottom strip with cells labelled
"שם הפרויקט:", "שם הגיליון:", "קנ"מ:", "תאריך:", "סטטוס:", "תאור והערות:".
Labels are found by fuzzy matching (OCR noise tolerant), each label's cell is
bounded by the nearest vertical rules and the next horizontal rule below, and
the value is the text inside the cell under the label.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import numpy as np

from ..ingest.pdf_vector import VectorSheet
from ..ocr.textutil import levenshtein, normalize

if TYPE_CHECKING:
    from ..ocr.dictionary import TextSpan

LABELS: dict[str, list[str]] = {
    "project": ["שם הפרויקט"],
    "sheet_name": ["שם הגיליון", "שם הגליון"],
    "scale": ['קנ"מ', "קנמ", "קנה מידה"],
    "date": ["תאריך"],
    "status": ["סטטוס"],
    "notes": ["תאור והערות", "תיאור והערות"],
}

# discipline code -> (Hebrew display, keywords)
DISCIPLINES: dict[str, tuple[str, list[str]]] = {
    "electrical": ("חשמל", ["חשמל"]),
    "lighting": ("תאורה", ["תאורה"]),
    "plumbing": ("אינסטלציה", ["אינסטלציה", "אינסטלציה סניטרית", "סניטריה"]),
    "demolition": ("הריסה", ["הריסה"]),
    "construction": ("בנייה", ["בניה", "בנייה"]),
    "architecture_master": ("אדריכלות (מאסטר)", ["מאסטר"]),
    "architecture": ("אדריכלות", ["אדריכלות", "אדריכלית"]),
    "furniture": ("ריהוט", ["ריהוט"]),
    "hvac": ("מיזוג אוויר", ["מיזוג", "מזוג"]),
    "flooring": ("ריצוף", ["ריצוף"]),
    "ceiling": ("תקרות", ["תקרות", "תקרה"]),
}

FLOORS: dict[str, tuple[str, list[str]]] = {
    "basement": ("מרתף", ["מרתף"]),
    "ground": ("קרקע", ["קרקע"]),
    "first": ("א'", ["א'", "א"]),
    "second": ("ב'", ["ב'", "ב"]),
    "third": ("ג'", ["ג'", "ג"]),
    "roof": ("גג", ["גג"]),
}


@dataclass
class TitleBlock:
    bbox: tuple[float, float, float, float] | None
    fields: dict[str, str] = field(default_factory=dict)
    field_conf: dict[str, float] = field(default_factory=dict)
    label_hits: dict[str, float] = field(default_factory=dict)


@dataclass
class SheetClass:
    disciplines: list[str]
    floors: list[str]
    scale_den: int | None
    date: str | None
    title: str
    confidence: float
    notes: list[str] = field(default_factory=list)


def _clean(s: str) -> str:
    return normalize(s).replace(":", "").strip()


def fuzzy_ratio(a: str, b: str) -> float:
    """1 - normalised edit distance (1.0 = identical)."""
    a, b = _clean(a), _clean(b)
    if not a and not b:
        return 1.0
    return 1.0 - levenshtein(a, b) / max(len(a), len(b))


def _span_center(s) -> tuple[float, float]:
    return ((s.bbox[0] + s.bbox[2]) / 2, (s.bbox[1] + s.bbox[3]) / 2)


def _rules(vs: VectorSheet, min_len: float = 4.0):
    s = vs.segs
    dx = s[:, 2] - s[:, 0]
    dy = s[:, 3] - s[:, 1]
    L = np.hypot(dx, dy)
    vert = (np.abs(dx) < 0.05) & (L >= min_len)
    hor = (np.abs(dy) < 0.05) & (L >= min_len)
    v = s[vert]
    h = s[hor]
    v = np.column_stack([v[:, 0], np.minimum(v[:, 1], v[:, 3]), np.maximum(v[:, 1], v[:, 3])])  # x, y0, y1
    h = np.column_stack([h[:, 1], np.minimum(h[:, 0], h[:, 2]), np.maximum(h[:, 0], h[:, 2])])  # y, x0, x1
    return v, h


def _cell_for(label_bbox, v, h, page_h: float):
    x0, y0, x1, y1 = label_bbox
    cy = (y0 + y1) / 2
    cx = (x0 + x1) / 2
    covers = (v[:, 1] <= cy + 0.2) & (v[:, 2] >= cy - 0.2)
    left = v[covers & (v[:, 0] <= x0 + 0.2)][:, 0]
    right = v[covers & (v[:, 0] >= x1 - 0.2)][:, 0]
    L = float(left.max()) if left.size else x0 - 2.0
    R = float(right.min()) if right.size else x1 + 2.0
    w = R - L
    below = h[(h[:, 0] > y1 + 0.3) & (h[:, 1] <= L + 0.1 * w) & (h[:, 2] >= R - 0.1 * w)]
    B = float(below[:, 0].min()) if below.size else min(page_h, y1 + 25.0)
    above = h[(h[:, 0] < y0 - 0.1) & (h[:, 1] <= cx) & (h[:, 2] >= cx)]
    T = float(above[:, 0].max()) if above.size else y0 - 1.0
    return (L, T, R, B)


def read_title_block(spans, vs: VectorSheet, min_ratio: float = 0.66) -> TitleBlock:
    spans = [s for s in spans if s.rotation == 0]
    hits: dict[str, tuple[float, TextSpan]] = {}
    for s in spans:
        txt = _clean(s.text)
        if not txt or len(txt) > 20:
            continue
        for key, variants in LABELS.items():
            r = max(fuzzy_ratio(txt, v) for v in variants)
            # labels end with ':' in this office template - small bonus
            if s.text.strip().endswith(":"):
                r = min(1.0, r + 0.05)
            if r >= min_ratio and (key not in hits or r > hits[key][0]):
                hits[key] = (r, s)
    tb = TitleBlock(bbox=None, label_hits={k: round(v[0], 3) for k, v in hits.items()})
    if len(hits) < 2:
        return tb
    v, h = _rules(vs)
    cells = {}
    for key, (_, s) in hits.items():
        cells[key] = _cell_for(s.bbox, v, h, vs.height_mm)
    xs = [c[0] for c in cells.values()] + [c[2] for c in cells.values()]
    ys = [c[1] for c in cells.values()] + [c[3] for c in cells.values()]
    tb.bbox = (min(xs), min(ys), max(xs), max(ys))
    for key, (L, T, R, B) in cells.items():
        label_span = hits[key][1]
        vals = []
        for s in spans:
            if s is label_span:
                continue
            cx, cy = _span_center(s)
            if L <= cx <= R and label_span.bbox[3] - 0.2 <= cy <= B:
                vals.append(s)
        vals.sort(key=lambda s: (s.bbox[1], -s.bbox[2]))
        # rows: spans with the same baseline are one row (right to left)
        rows: list[list] = []
        for s in vals:
            if rows and abs(rows[-1][0].bbox[3] - s.bbox[3]) < 0.4 * s.height:
                rows[-1].append(s)
            else:
                rows.append([s])
        text = "\n".join(" ".join(x.text for x in sorted(r, key=lambda x: -x.bbox[2])) for r in rows)
        tb.fields[key] = text
        tb.field_conf[key] = round(min([x.conf for x in vals], default=0.0), 3)
    return tb


_SCALE_RE = re.compile(r"(\d+)\s*[:/]\s*(\d+)")
_DATE_RE = re.compile(r"(\d{1,2})[./](\d{1,2})[./](\d{2,4})")


def parse_scale(text: str) -> int | None:
    m = _SCALE_RE.search(text or "")
    if not m:
        return None
    a, b = int(m.group(1)), int(m.group(2))
    if a == 1 and b > 0:
        return b
    return None


def _best_keyword(text: str, table: dict[str, tuple[str, list[str]]], min_ratio: float) -> list[tuple[str, float]]:
    toks = [t for t in re.split(r"[\s+.,/\-]+", normalize(text)) if t]
    found: dict[str, float] = {}
    for code, (_, kws) in table.items():
        best = 0.0
        for kw in kws:
            n = len(kw.split())
            for i in range(len(toks)):
                cand = " ".join(toks[i : i + n])
                if len(kw) <= 2:  # short floor tokens like א' must match exactly
                    r = 1.0 if cand == kw else 0.0
                else:
                    r = fuzzy_ratio(cand, kw)
                best = max(best, r)
        if best >= min_ratio:
            found[code] = best
    return sorted(found.items(), key=lambda kv: -kv[1])


def classify_sheet(tb: TitleBlock) -> SheetClass:
    name = tb.fields.get("sheet_name", "")
    notes: list[str] = []
    disc = _best_keyword(name, DISCIPLINES, 0.75)
    # keep only the top discipline unless a second one is an (almost) exact hit
    keep = [d for d in disc if d[1] >= 0.9] or disc[:1]
    floors = _best_keyword(name, FLOORS, 0.75)
    # "א" alone is ambiguous; only accept the first-floor token after "קומה"
    if "קומה" not in normalize(name) and "קומת" not in normalize(name):
        floors = [f for f in floors if f[0] not in ("first", "second", "third")]
    scale = parse_scale(tb.fields.get("scale", ""))
    if scale is None:
        notes.append("scale not parsed from title block")
    m = _DATE_RE.search(tb.fields.get("date", ""))
    date = m.group(0) if m else None
    disc_score = keep[0][1] if keep else 0.0
    label_score = min(tb.label_hits.values()) if tb.label_hits else 0.0
    ocr_conf = tb.field_conf.get("sheet_name", 0.0)
    conf = round(min(disc_score, max(label_score, 0.5)) * (0.5 + 0.5 * ocr_conf), 3)
    if not keep:
        notes.append("no discipline keyword")
    return SheetClass(
        disciplines=[d for d, _ in keep],
        floors=[f for f, _ in floors],
        scale_den=scale,
        date=date,
        title=name.replace("\n", " / "),
        confidence=conf,
        notes=notes,
    )
