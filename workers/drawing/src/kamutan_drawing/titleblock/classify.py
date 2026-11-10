"""Title block location, field reading and sheet classification.

Input: text spans (``ocr.dictionary.text_spans``) + vector primitives of one sheet.
The sample set's title block is a bottom strip with cells labelled
"שם הפרויקט:", "שם הגיליון:", "קנ"מ:", "תאריך:", "סטטוס:", "תאור והערות:".
Labels are found by fuzzy matching (OCR noise tolerant), each label's cell is
bounded by the nearest vertical rules and the next horizontal rule below, and
the value is the text inside the cell under the label.
"""

from __future__ import annotations

import itertools
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
    "furniture": ("ריהוט", ["ריהוט", "העמדה"]),  # Sprint 10: "העמדה" = furniture layout (Achituv)
    "hvac": ("מיזוג אוויר", ["מיזוג", "מזוג"]),
    "flooring": ("ריצוף", ["ריצוף"]),
    "ceiling": ("תקרות", ["תקרות", "תקרה"]),
    # Sprint 10 (Worker-Classify): the designer's other sheet kinds (open set, contracts DisciplineSchema)
    "pool": ("בריכה", ["בריכה", "בריכת שחיה"]),
    "post_permit": ("אחרי טופס 4", ["אחרי טופס 4", "אחרי טופס"]),
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
    field_spans: dict[str, list[TextSpan]] = field(default_factory=dict)  # Sprint 10: the value spans of each field
    method: str = "labels"  # Sprint 10: "labels" (label cells) or "cells" (anchored cells, labels unreadable)


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
        tb.field_spans[key] = vals
    return tb


# ---------------------------------------------------------------------------------------------------------------
# Sprint 10 (Worker-Classify): title blocks whose labels cannot be read
#
# The designer's newer template (Rubel / Achituv / Yahav) draws the labels "שם הגיליון:", "שם הפרויקט:" … in an
# outlined (hollow) SHX font that the glyph dictionary reads as "רO תOרחיקלR" / "פמ תקלילמן:" — the label cells were
# never found, the sheet fell back to the largest "discipline" text on the page, and that was the "תאור והערות:" label
# (→ lighting). The values are plain SHX and read well. So the block is located by anchors that do read — the status
# words (לעיון / לתמחור / לביצוע), a date, the scale "1:N" — its cells are cut at the vertical rules, the label row of
# each cell is dropped, and the sheet-name cell is the one whose value names a discipline.

STATUS_WORDS = ("לעיון", "לתמחור", "לביצוע", "לאישור", "לתיאום")
_DATE_ANY = re.compile(r"\b\d{1,2}\s*[./-]\s*(\d{1,2}|[A-Za-z]{3})\s*[./-]\s*\d{2,4}\b")
_SCALE_ONLY = re.compile(r"^\s*1\s*:\s*\d{1,4}\s*$")
_JUNK = re.compile(r"^[\s|/\\NO0+.\-_:]*$")  # cell-corner ticks, the status circles read as "O"
ANCHOR_REACH_MM = 60.0
STRIP_PAD_MM = 18.0
MIN_CELL_MM = 8.0


def _is_status(text: str) -> bool:
    t = fold(text)
    return any(t == fold(w) for w in STATUS_WORDS)


def _anchor_spans(spans: list[TextSpan]) -> list[TextSpan]:
    """Status words (≥ 2 of them within a status column) plus the date / scale / label spans near them."""
    status = [s for s in spans if s.rotation == 0 and _is_status(s.text)]
    best: list[TextSpan] = []
    for s in status:  # the largest group of status words stacked within ANCHOR_REACH_MM
        cx, cy = _span_center(s)
        grp = [t for t in status if abs(_span_center(t)[0] - cx) <= 25.0 and abs(_span_center(t)[1] - cy) <= 25.0]
        if len(grp) > len(best):
            best = grp
    if len(best) < 2:
        # no readable status column (small A2 title blocks): a date and a scale "1:N" next to each other
        dates = [s for s in spans if s.rotation == 0 and _DATE_ANY.search(s.text)]
        scales = [s for s in spans if s.rotation == 0 and _SCALE_ONLY.match(s.text)]
        pairs = [
            (d, c)
            for d in dates
            for c in scales
            if abs(_span_center(d)[0] - _span_center(c)[0]) <= 40.0 and 0.0 < _span_center(c)[1] - _span_center(d)[1] <= 25.0
        ]
        if len(pairs) != 1:
            return []
        best = list(pairs[0])
    cx = sum(_span_center(s)[0] for s in best) / len(best)
    cy = sum(_span_center(s)[1] for s in best) / len(best)
    out = list(best)
    for s in spans:
        if s.rotation != 0 or s in out:
            continue
        x, y = _span_center(s)
        if abs(y - cy) > 25.0 or abs(x - cx) > 400.0:
            continue
        if _DATE_ANY.search(s.text) or _SCALE_ONLY.match(s.text):
            out.append(s)
    return out


def _cell_rows(vals: list[TextSpan]) -> list[list[TextSpan]]:
    vals = sorted(vals, key=lambda s: (s.bbox[1], -s.bbox[2]))
    rows: list[list[TextSpan]] = []
    for s in vals:
        if rows and abs(rows[-1][0].bbox[3] - s.bbox[3]) < 0.4 * max(s.height, 0.5):
            rows[-1].append(s)
        else:
            rows.append([s])
    return rows


def _is_label_row(row: list[TextSpan], rest: list[TextSpan]) -> bool:
    text = " ".join(x.text for x in sorted(row, key=lambda x: -x.bbox[2]))
    if text.strip().endswith(":"):
        return True
    if _best_keyword(text, DISCIPLINES, 0.75) or _best_keyword(text, FLOORS, 0.75):
        return False  # a value ("תכ' חשמל"), whatever its size
    if any(max(fuzzy_ratio(text, v) for v in vs) >= 0.5 for vs in LABELS.values()):
        return True
    if rest:
        hs = sorted(x.height for x in rest)
        med = hs[len(hs) // 2]
        return max(x.height for x in row) >= 1.12 * med
    return False


def read_title_block_cells(spans: list[TextSpan], vs: VectorSheet) -> TitleBlock:
    """Title block found by its anchors (see above); fields ``sheet_name`` / ``scale`` / ``date`` from its cells.
    ``bbox`` None when no anchors are found."""
    spans = [s for s in spans if s.rotation == 0]
    anchors = _anchor_spans(spans)
    tb = TitleBlock(bbox=None, method="cells")
    if not anchors:
        return tb
    ay0 = min(s.bbox[1] for s in anchors)
    ay1 = max(s.bbox[3] for s in anchors)
    v, h = _rules(vs)
    W = vs.width_mm
    wide = h[(h[:, 2] - h[:, 1]) >= 0.25 * W] if len(h) else h
    above = wide[(wide[:, 0] < ay0 - 0.5) & (wide[:, 0] >= ay0 - STRIP_PAD_MM - 25.0)] if len(wide) else wide
    T = float(above[:, 0].max()) if len(above) else ay0 - STRIP_PAD_MM
    below = wide[(wide[:, 0] > ay1 + 0.5) & (wide[:, 0] <= ay1 + STRIP_PAD_MM + 25.0)] if len(wide) else wide
    B = float(below[:, 0].min()) if len(below) else min(vs.height_mm, ay1 + STRIP_PAD_MM)
    # a strip that holds the anchors: also the rows above the status column (the label row is above the values)
    T = min(T, ay0 - 2.0)
    hgt = max(1.0, B - T)
    vv = v[(np.minimum(v[:, 2], B) - np.maximum(v[:, 1], T)) >= 0.35 * hgt] if len(v) else v
    xs = sorted(float(x) for x in (vv[:, 0] if len(vv) else []))
    cuts: list[float] = []
    for x in xs:
        if not cuts or x - cuts[-1] > 3.0:
            cuts.append(x)
    inside = [s for s in spans if T - 0.5 <= _span_center(s)[1] <= B + 0.5]
    if not inside:
        return tb
    lo = min([*cuts[:1], min(s.bbox[0] for s in inside)])
    hi = max([*cuts[-1:], max(s.bbox[2] for s in inside)])
    edges = sorted({lo, hi, *cuts})
    cells = [(a, b) for a, b in itertools.pairwise(edges) if b - a >= MIN_CELL_MM]
    tb.bbox = (lo, T, hi, B)
    tb.label_hits = {"anchors": 0.8}
    best: tuple[float, str, list[TextSpan]] | None = None
    for x0, x1 in cells:
        vals = [s for s in inside if x0 <= _span_center(s)[0] <= x1 and not _JUNK.match(s.text)]
        if not vals:
            continue
        rows = _cell_rows(vals)
        if rows and _is_label_row(rows[0], [x for r in rows[1:] for x in r]):
            rows = rows[1:]
        rows = [r for r in rows if not _is_label_row(r, [])]  # a second label inside the cell ("מם תגיליון")
        if not rows:
            continue
        text = "\n".join(" ".join(x.text for x in sorted(r, key=lambda x: -x.bbox[2])) for r in rows)
        flat = [x for r in rows for x in r]
        if _SCALE_ONLY.match(text.split("\n")[-1]) and "scale" not in tb.fields:
            tb.fields["scale"] = text.split("\n")[-1].strip()
            tb.field_conf["scale"] = round(min(x.conf for x in flat), 3)
        if _DATE_ANY.search(text) and "date" not in tb.fields:
            tb.fields["date"] = text
        if any(_is_status(x.text) for x in flat) or len(text) > 60 or len(text.split()) > 8:
            continue  # the status column, or a notes cell ("תאור והערות": "1) כל השקעים … לתוכנית תאורה")
        disc = _best_keyword(text, DISCIPLINES, 0.75)
        if not disc:
            continue
        score = disc[0][1] + (0.5 if _best_keyword(text, FLOORS, 0.75) else 0.0)
        if best is None or score > best[0]:
            best = (score, text, flat)
    if best is not None:
        tb.fields["sheet_name"] = best[1]
        tb.field_conf["sheet_name"] = round(min(x.conf for x in best[2]), 3)
        tb.field_spans["sheet_name"] = best[2]
    return tb


_SCALE_RE = re.compile(r"(\d+)\s*[:/]\s*(\d+)")
_DATE_RE = re.compile(r"(\d{1,2})[./](\d{1,2})[./](\d{2,4})")


_SCALE_MIRRORED = re.compile(r"^\s*(\d{1,4})\s*[:/]\s*[1ו|lI]\s*$")  # "50: ו": 1:50 read right to left, 1 → ו
COMMON_SCALES = frozenset({1, 2, 5, 10, 20, 25, 50, 75, 100, 200, 250, 500, 1000})


def parse_scale(text: str) -> int | None:
    m = _SCALE_RE.search(text or "")
    if not m:
        mm = _SCALE_MIRRORED.match(text or "")  # Sprint 10: cold glyph store on Noah's title block
        if mm and int(mm.group(1)) in COMMON_SCALES:
            return int(mm.group(1))
        return None
    a, b = int(m.group(1)), int(m.group(2))
    if a == 1 and b > 0:
        return b
    return None


# Sprint 10 (Worker-Classify): letters the cold glyph store confuses on this designer's SHX font ("כומת כרכע",
# "לומת לרלע" for "קומת קרקע", "תכרה" for "תקרה") and the final forms, folded on BOTH sides of a keyword comparison
_FOLD = str.maketrans({"ק": "כ", "ל": "כ", "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ"})
_TOKEN_SPLIT = re.compile(r"[\s+.,/\-'|]+")


def fold(text: str) -> str:
    """``normalize`` + final letters + the ק/כ/ל confusion folded (keyword matching only, never shown)."""
    return normalize(text).translate(_FOLD)


def floor_words_present(text: str) -> bool:
    """The text says "קומה" / "קומת" (also as the cold store misreads it): "א" then means the first floor."""
    t = fold(text)
    return "כומה" in t or "כומת" in t


def _best_keyword(
    text: str, table: dict[str, tuple[str, list[str]]], min_ratio: float, *, exact_up_to: int = 2
) -> list[tuple[str, float]]:
    """Codes of ``table`` whose keyword appears in ``text`` (token n-grams, folded), best ratio first.

    Keywords of at most ``exact_up_to`` letters must match exactly (floor tokens like א'). Sprint 10: free text
    outside the title block passes ``exact_up_to=5`` — one wrong letter turns "תאור" (the "תאור והערות" label),
    "פריסה" (an elevation) or "מיזוה" into תאורה / הריסה / מיזוג at 0.8, which classified Rubel's demolition,
    construction and ceiling sheets as lighting."""
    toks = [t for t in _TOKEN_SPLIT.split(fold(text)) if t]
    found: dict[str, float] = {}
    for code, (_, kws) in table.items():
        best = 0.0
        for kw in kws:
            fk = fold(kw)
            n = len(fk.split())
            for i in range(len(toks)):
                cands = [" ".join(toks[i : i + n])]
                if n == 1 and i + 1 < len(toks) and len(toks[i]) + len(toks[i + 1]) <= len(fk) + 1:
                    cands.append(toks[i] + toks[i + 1])  # a word the reader split in two ("הר סה")
                for cand in cands:
                    if len(fk.replace(" ", "")) <= exact_up_to:
                        r = 1.0 if cand == fk else 0.0
                    else:
                        r = fuzzy_ratio(cand, fk)
                        if n == 1 and len(fk) >= 4 and cand.endswith(fk) and len(cand) - len(fk) <= 2 and exact_up_to <= 2:
                            r = max(r, 0.9)  # "ת.תאורה" read as one word "תהתאורה" (prefix glued to the keyword)
                    best = max(best, r)
        if best >= min_ratio:
            found[code] = best
    return sorted(found.items(), key=lambda kv: -kv[1])


def keyword_spans(spans: list[TextSpan], table: dict[str, tuple[str, list[str]]], min_ratio: float) -> list[TextSpan]:
    """The spans that carry a keyword of ``table`` (their reading confidence is the field's confidence)."""
    return [s for s in spans if _best_keyword(s.text, table, min_ratio)]


def classify_sheet(tb: TitleBlock) -> SheetClass:
    name = tb.fields.get("sheet_name", "")
    notes: list[str] = []
    disc = _best_keyword(name, DISCIPLINES, 0.75)
    # keep only the top discipline unless a second one is an (almost) exact hit
    keep = [d for d in disc if d[1] >= 0.9] or disc[:1]
    floors = _best_keyword(name, FLOORS, 0.75)
    # "א" alone is ambiguous; only accept the first-floor token after "קומה"
    if not floor_words_present(name):
        floors = [f for f in floors if f[0] not in ("first", "second", "third")]
    scale = parse_scale(tb.fields.get("scale", ""))
    if scale is None:
        notes.append("scale not parsed from title block")
    m = _DATE_RE.search(tb.fields.get("date", ""))
    date = m.group(0) if m else None
    disc_score = keep[0][1] if keep else 0.0
    label_score = min(tb.label_hits.values()) if tb.label_hits else 0.0
    ocr_conf = tb.field_conf.get("sheet_name", 0.0)
    # Sprint 10: the reading confidence is that of the spans that carry the discipline / floor words — not the
    # weakest span of the cell (a stray "|" or "N" of the cell frame read at 0.4 made correct sheets red)
    carriers = keyword_spans(tb.field_spans.get("sheet_name", []), DISCIPLINES, 0.75) + keyword_spans(
        tb.field_spans.get("sheet_name", []), FLOORS, 0.75
    )
    if carriers:
        ocr_conf = max(ocr_conf, sum(s.conf for s in carriers) / len(carriers))
    if disc_score >= 0.999 and floors:
        ocr_conf = max(ocr_conf, 0.75)  # an exact discipline word + a floor read: the dictionary confirms the reading
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
