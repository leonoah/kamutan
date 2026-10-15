"""Legend parsing: ruled tables → legend entries (symbol strokes + Hebrew label + class).

Two table kinds are understood:

* **symbol legend** ("מקרא"): rows of *symbol, label* pairs, possibly several pairs per row.
  Hebrew is right-to-left, so each label sits to the left of its symbol. Symbols are found
  as stroke groups larger than the label text that line up in columns; text drawn between
  a label and its symbol (``BEZEK``, ``TV``, ``2X``) is the symbol's *qualifier* — it is not
  part of the stroke template but tells look-alike symbols apart on the plan.
* **fixture-types table** ("טבלת תאורה"): header with "מס'" and "סוג"; each row gives a type
  number (drawn on the plan inside a small circle) and a description. Entries of this kind
  have no stroke template; :mod:`kamutan_drawing.symbols.tags` finds the circled numbers.

The label is read by the SHX reader (``ocr/reader.py`` + org glyph dictionary) upstream; this
module only receives :class:`~kamutan_drawing.ocr.dictionary.TextSpan` objects.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field

import numpy as np

from ..ingest.pdf_vector import VectorSheet
from ..ocr.dictionary import TextSpan
from ..ocr.textutil import is_hebrew, normalize
from ..symbols.geometry import (
    BBox,
    Group,
    bbox_of,
    bbox_overlap_share,
    groups_of,
    in_box,
    seg_lengths,
    segment_components,
    stroke_signature,
)
from .classes import multiplicity, norm_label, suggest_class
from .tables import Table, find_tables

TITLE_LEGEND = "מקרא"
TITLE_TYPES = "טבלת תאורה"
MIN_LABELS = 3


@dataclass
class LegendEntry:
    n: int
    legend_id: str
    kind: str  # "symbol" | "type"
    symbol_bbox: BBox
    label_bbox: BBox | None
    label: str
    label_conf: float
    qualifier: str = ""  # normalised text drawn with the symbol ("2X", "BEZEK", "TV"…)
    seg_idx: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.int64))
    suggested_class: str | None = None
    class_conf: float = 0.0
    signature: str = ""
    type_no: str | None = None  # fixture-types table: the type number ("17")
    multiplicity: int | None = None  # qualifier "2X" → 2
    qual_seg_idx: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.int64))  # strokes of the qualifier text

    def entry_id(self, sheet_id: str) -> str:
        return f"le_{sheet_id}_{self.n}"


@dataclass
class Legend:
    id: str
    kind: str  # "symbols" | "types"
    bbox: BBox
    title: str
    confidence: float
    entries: list[LegendEntry] = field(default_factory=list)


@dataclass
class LegendResult:
    legends: list[Legend] = field(default_factory=list)

    @property
    def entries(self) -> list[LegendEntry]:
        return [e for lg in self.legends for e in lg.entries]

    def exclusion_boxes(self, pad: float = 1.0) -> list[BBox]:
        out = []
        for lg in self.legends:
            b = lg.bbox
            for e in lg.entries:  # symbols may overshoot the table
                if e.kind == "symbol":
                    b = (
                        min(b[0], e.symbol_bbox[0]),
                        min(b[1], e.symbol_bbox[1]),
                        max(b[2], e.symbol_bbox[2]),
                        max(b[3], e.symbol_bbox[3]),
                    )
            out.append((b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad))
        return out


def _hebrew_letters(t: str) -> int:
    return sum(1 for ch in t if is_hebrew(ch))


def _center(b: BBox) -> tuple[float, float]:
    return (b[0] + b[2]) / 2, (b[1] + b[3]) / 2


def _inside_center(b: BBox, box: BBox, pad: float = 0.0) -> bool:
    cx, cy = _center(b)
    return box[0] - pad <= cx <= box[2] + pad and box[1] - pad <= cy <= box[3] + pad


_QUAL_STRIP = re.compile(r"[|\[\]()<>{}~_+\-–—=]+")


def clean_qualifier(t: str) -> str:
    """Symbol text as a comparable token: ``"BEZEK |"`` → ``BEZEK``, ``"+א2"`` → ``2X``."""
    t = normalize(t)
    t = _QUAL_STRIP.sub(" ", t)
    t = re.sub(r"\s+", "", t)
    m = multiplicity(t) if len(t) <= 3 else None
    if m is not None:
        return f"{m}X"
    # a final-form letter can never start a word: it is a stroke of the symbol read as a letter
    t = re.sub(r"^[ךםןףץ]+", "", t)
    if re.search(r"[A-Za-z]{2,}", t):  # Latin words (BEZEK, TV, TEL): drop stray Hebrew letters around them
        t = re.sub(r"^[^A-Za-z0-9]+|[^A-Za-z0-9]+$", "", t)
    return t.upper()


def _title_near(spans: list[TextSpan], bb: BBox) -> tuple[str, float] | None:
    """Readable title just above the table (often not readable: "מקרא:" is short and underlined)."""
    best: tuple[str, float] | None = None
    for s in spans:
        x0, y0, x1, y1 = s.bbox
        if y1 < bb[1] - 9 or y0 > bb[1] + 1.5 or x1 < bb[0] or x0 > bb[2]:
            continue
        t = norm_label(s.text)
        for title in (TITLE_TYPES, TITLE_LEGEND, "מקרא סימנים"):
            if norm_label(title) in t:
                return title, float(s.conf)
        if "טבלת" in t or "מקרא" in t:
            best = (s.text.strip(" :"), float(s.conf))
    return best


# ------------------------------------------------------------------------------------ symbols
def _parse_symbol_table(
    vs: VectorSheet, spans: list[TextSpan], table: Table, legend_id: str, start_n: int
) -> tuple[list[LegendEntry], float]:
    bb = table.bbox
    s = vs.segs.astype(np.float64)
    lens = seg_lengths(s)
    pad = 1.0
    mid_x, mid_y = (s[:, 0] + s[:, 2]) / 2, (s[:, 1] + s[:, 3]) / 2
    inside = in_box(mid_x, mid_y, bb, pad=pad)
    is_rule = np.zeros(len(s), bool)
    is_rule[table.rule_segs] = True
    horiz = np.abs(s[:, 3] - s[:, 1]) < 0.15
    vert = np.abs(s[:, 2] - s[:, 0]) < 0.15
    is_rule |= horiz & (lens >= 0.45 * table.width)
    is_rule |= vert & (lens >= 0.8 * table.height)
    # horizontal strokes entirely above / below the table (the title's underline) are not symbols
    outside_h = horiz & ((np.maximum(s[:, 1], s[:, 3]) < bb[1] - 0.05) | (np.minimum(s[:, 1], s[:, 3]) > bb[3] + 0.05))
    idx = np.where(inside & ~is_rule & ~outside_h)[0]
    if len(idx) == 0:
        return [], 0.0
    lab = segment_components(s[idx])
    groups = groups_of(s, lab, idx)

    in_spans = [sp for sp in spans if _inside_center(sp.bbox, bb, pad=0.5)]
    labels = [sp for sp in in_spans if _hebrew_letters(sp.text) >= 2]
    if not labels:
        return [], 0.0
    th = float(np.median([sp.height for sp in labels])) if labels else 2.0

    def texty(g: Group) -> bool:
        return any(bbox_overlap_share(g.bbox, sp.bbox) >= 0.8 for sp in labels) and max(g.w, g.h) <= 1.6 * th

    big = [g for g in groups if max(g.w, g.h) > 1.3 * th and not texty(g)]
    if len(big) < 2:
        return [], 0.0
    # symbol columns: 1-D clustering of the big groups' centres
    xs = sorted(big, key=lambda g: g.cx)
    cols: list[list[Group]] = [[xs[0]]]
    for g in xs[1:]:
        if g.cx - cols[-1][-1].cx > 6.0:
            cols.append([g])
        else:
            cols[-1].append(g)
    cols = [c for c in cols if len(c) >= 2]
    if not cols:
        return [], 0.0
    col_ranges = sorted((min(g.bbox[0] for g in c), max(g.bbox[2] for g in c)) for c in cols)
    # tighten each column to the core of its members (outliers such as a long arrow)
    tight: list[tuple[float, float]] = []
    for c0, c1 in col_ranges:
        mem = [g for g in big if c0 <= g.cx <= c1]
        lo = float(np.percentile([g.bbox[0] for g in mem], 25))
        hi = float(np.percentile([g.bbox[2] for g in mem], 75))
        tight.append((min(lo, c1), max(hi, c0)))
    col_ranges = tight

    # content rows: bands between consecutive rules that hold a label
    ys = table.rule_ys
    bands = [(ys[i], ys[i + 1]) for i in range(len(ys) - 1)]
    if not bands:
        bands = [(bb[1], bb[3])]

    def band_of(cy: float) -> int:
        for i, (a, b) in enumerate(bands):
            if a - 0.01 <= cy <= b + 0.01:
                return i
        return -1

    content = sorted({band_of(_center(sp.bbox)[1]) for sp in labels} - {-1})
    if not content:
        return [], 0.0

    def nearest_content(cy: float) -> int:
        return min(content, key=lambda i: abs((bands[i][0] + bands[i][1]) / 2 - cy))

    entries: list[LegendEntry] = []
    n = start_n
    read_confs: list[float] = []
    for bi in content:
        y0, y1 = bands[bi]
        row_spans = [sp for sp in in_spans if y0 - 0.3 <= _center(sp.bbox)[1] <= y1 + 0.3]
        prev_c = bb[0] - 1.0
        for ci, (c0, c1) in enumerate(col_ranges):
            # symbol strokes: groups centred in the column, attached to this row
            sym = [
                g
                for g in groups
                if c0 - 0.6 <= g.cx <= c1 + 0.6
                and nearest_content(g.cy) == bi
                and g.bbox[1] < y1 + 0.5 * (y1 - y0) + 2.0
                and g.bbox[3] > y0 - 0.5 * (y1 - y0) - 2.0
                and not texty(g)
            ]
            if not sym or not any(max(g.w, g.h) > 1.3 * th for g in sym):
                prev_c = (c0 + c1) / 2
                continue
            # small text-like groups that do not touch the symbol's big strokes ("2X" glyphs) are not
            # part of the drawing; small parts inside it (ת in a circle) are
            core = [g for g in sym if max(g.w, g.h) > 1.3 * th]
            cb = (
                min(g.bbox[0] for g in core),
                min(g.bbox[1] for g in core),
                max(g.bbox[2] for g in core),
                max(g.bbox[3] for g in core),
            )
            sym = [
                g
                for g in sym
                if g in core
                or (
                    g.bbox[0] >= cb[0] - 0.3
                    and g.bbox[2] <= cb[2] + 0.3
                    and g.bbox[1] >= cb[1] - 0.3
                    and g.bbox[3] <= cb[3] + 0.3
                )
            ]
            # label: Hebrew spans between the previous column and this one. A span that touches
            # the symbol is the symbol's own text (BEZEK, כ.רשת) when another label lies further
            # left; when it is the only one, it is the label with a stroke of the symbol read into it.
            zone = [sp for sp in row_spans if prev_c < _center(sp.bbox)[0] < c1 and sp.bbox[0] < c0 - 0.8]
            heb = [sp for sp in zone if _hebrew_letters(sp.text) >= 2]
            touching = [sp for sp in heb if sp.bbox[2] > c0 - 0.3]
            free = [sp for sp in heb if sp.bbox[2] <= c0 - 0.3]
            cand = free if free else touching
            quals = [sp for sp in zone if sp not in cand and sp.bbox[2] > c0 - 0.3]
            prev_c = (c0 + c1) / 2
            if not cand:
                continue
            cand.sort(key=lambda sp: -sp.bbox[2])  # right to left = reading order
            label_x1 = cand[0].bbox[2]
            label = " ".join(normalize(sp.text) for sp in cand)
            label = re.sub(r"^[^\w\"']+|[^\w\"']+$", "", label).strip()
            label = re.sub(r"^[()|\[\]]\s*|\s*[()|\[\]]$", "", label).strip()
            if cand[0].bbox[2] > c0 - 0.3:  # the label touches the symbol: drop a lone letter read from its strokes
                label = re.sub(r"^\S\s+(?=\S{2,})", "", label)
            label_conf = float(min(sp.conf for sp in cand))
            lbb = (
                min(sp.bbox[0] for sp in cand),
                min(sp.bbox[1] for sp in cand),
                max(sp.bbox[2] for sp in cand),
                max(sp.bbox[3] for sp in cand),
            )
            # qualifier strokes between label and column: not part of the template
            qual_groups = [g for g in groups if label_x1 < g.cx < c0 - 0.2 and nearest_content(g.cy) == bi and not texty(g)]
            qual_text = ""
            for sp in quals:
                q = clean_qualifier(sp.text)
                if q:
                    qual_text = q
            if not qual_text and any(max(g.w, g.h) <= 1.3 * th for g in qual_groups) and len(qual_groups) >= 2:
                qual_text = "?"  # something is written next to the symbol but could not be read
            seg_idx = np.concatenate([g.segs for g in sym]).astype(np.int64)
            # strokes of a symbol never reach into the qualifier zone
            sbb = bbox_of(s[seg_idx])
            cls, cconf = suggest_class(label, label_conf)
            mult = multiplicity(qual_text) if qual_text else None
            if mult is not None and cls == "socket_single":
                cls = {2: "socket_double", 3: "socket_triple"}.get(mult, cls)
            e = LegendEntry(
                n=n,
                legend_id=legend_id,
                kind="symbol",
                symbol_bbox=sbb,
                label_bbox=lbb,
                label=label,
                label_conf=round(label_conf, 3),
                qualifier=qual_text,
                seg_idx=seg_idx,
                suggested_class=cls,
                class_conf=cconf,
                signature=stroke_signature(s[seg_idx], qual_text, curved=vs.seg_kind[seg_idx] == 1),
                multiplicity=mult,
                qual_seg_idx=np.concatenate([g.segs for g in qual_groups]).astype(np.int64)
                if qual_groups
                else np.zeros(0, dtype=np.int64),
            )
            entries.append(e)
            read_confs.append(label_conf)
            n += 1
    if len(entries) < MIN_LABELS:
        return [], 0.0
    classed = sum(1 for e in entries if e.suggested_class) / len(entries)
    conf = 0.45 + 0.25 * min(1.0, len(entries) / 8) + 0.3 * classed
    return entries, round(min(0.97, conf), 3)


# ------------------------------------------------------------------------------ fixture types
_NUM = re.compile(r"^\s*(\d{1,3})\s*$")
_NUM_LEAD = re.compile(r"^\s*(\d{1,3})\s+(\S.*)$")


def _parse_types_table(
    vs: VectorSheet, spans: list[TextSpan], table: Table, legend_id: str, start_n: int
) -> tuple[list[LegendEntry], float]:
    bb = table.bbox
    in_spans = [sp for sp in spans if _inside_center(sp.bbox, bb, pad=0.5)]
    first_rule = next((y for y in table.rule_ys if y > bb[1] + 2.0), bb[1] + 8.0)
    header = [sp for sp in in_spans if _center(sp.bbox)[1] < first_rule]
    hdr_text = " ".join(norm_label(sp.text) for sp in header)
    if "סוג" not in hdr_text:
        return [], 0.0
    # "מס'" is the right-most (first, RTL) column: where the bare numbers start
    lone = [sp.bbox[0] for sp in in_spans if _NUM.match(sp.text) and sp.bbox[0] > bb[2] - 0.15 * table.width]
    hdr_no = [sp for sp in header if norm_label(sp.text).startswith("מס")]
    if len(lone) >= 3:
        num_col_x0 = min(lone) - 0.3
    elif hdr_no:
        num_col_x0 = hdr_no[0].bbox[0] - 1.0
    else:
        num_col_x0 = bb[2] - 0.12 * table.width
    s = vs.segs
    xs = sorted({round(float(s[i, 0]), 1) for i in table.vertical_segs})
    left_rules = [x for x in xs if x < num_col_x0 - 0.2]
    desc_x1 = max(left_rules) if left_rules else num_col_x0
    further = [x for x in left_rules if x < desc_x1 - 5.0]
    desc_x0 = max(further) if further else bb[0]
    ys = table.rule_ys

    # rows: (number, number bbox, description spans); the SHX reader sometimes reads the number
    # and the description as one span ("16 גוף תלוי פעמון מיני")
    rows: list[tuple[str, BBox, list[TextSpan], str | None]] = []
    for sp in in_spans:
        if sp.bbox[2] < num_col_x0 or sp in header:
            continue
        m = _NUM.match(sp.text)
        if m and sp.bbox[0] >= num_col_x0 - 0.5:
            rows.append((m.group(1), sp.bbox, [], None))
            continue
        m2 = _NUM_LEAD.match(normalize(sp.text))
        if m2 and _hebrew_letters(m2.group(2)) >= 2:
            rows.append((m2.group(1), sp.bbox, [sp], m2.group(2)))
    if len(rows) < 3:
        return [], 0.0
    entries: list[LegendEntry] = []
    n = start_n
    seen: set[str] = set()
    for num, nbb, own, own_text in sorted(rows, key=lambda r: r[1][1]):
        if num in seen:
            continue
        if own:
            desc = own
            label = own_text or ""
        else:
            cy = _center(nbb)[1]
            above = [y for y in ys if y <= cy]
            below = [y for y in ys if y > cy]
            r0 = max(above) if above else cy - 3
            r1 = min(below) if below else cy + 3
            desc = [
                d
                for d in in_spans
                if desc_x0 - 0.5 <= _center(d.bbox)[0] <= desc_x1 + 0.5
                and r0 - 0.2 <= _center(d.bbox)[1] <= r1 + 0.2
                and _hebrew_letters(d.text) >= 2
            ]
            if not desc:
                continue
            desc.sort(key=lambda d: (round(d.bbox[1], 0), -d.bbox[2]))
            label = " ".join(normalize(d.text) for d in desc)
        label = label.strip()
        lconf = float(min(d.conf for d in desc))
        lbb = (
            min(d.bbox[0] for d in desc),
            min(d.bbox[1] for d in desc),
            max(d.bbox[2] for d in desc),
            max(d.bbox[3] for d in desc),
        )
        cls, cconf = suggest_class(label, lconf, types_table=True)
        seen.add(num)
        sig = hashlib.sha256(f"type|{num}|{norm_label(label)}".encode()).hexdigest()[:16]
        entries.append(
            LegendEntry(
                n=n,
                legend_id=legend_id,
                kind="type",
                symbol_bbox=(max(num_col_x0, nbb[0]), nbb[1], nbb[2], nbb[3]) if own else nbb,
                label_bbox=lbb,
                label=label,
                label_conf=round(lconf, 3),
                qualifier=f"T{num}",
                suggested_class=cls,
                class_conf=cconf,
                signature=sig,
                type_no=num,
            )
        )
        n += 1
    if len(entries) < MIN_LABELS:
        return [], 0.0
    return entries, round(min(0.95, 0.6 + 0.35 * min(1.0, len(entries) / 10)), 3)


def parse_legends(
    vs: VectorSheet,
    spans: list[TextSpan],
    *,
    title_block: BBox | None = None,
    sheet_id: str = "",
) -> LegendResult:
    """Find and parse every legend / fixture-types table on the sheet."""
    tables = find_tables(vs, exclude=[title_block] if title_block else None)
    res = LegendResult()
    n = 0
    for t in sorted(tables, key=lambda t: (t.bbox[1], -t.bbox[2])):
        lid = f"lg{len(res.legends)}"
        title = _title_near(spans, t.bbox)
        kind = "types" if title and title[0] == TITLE_TYPES else None
        entries: list[LegendEntry] = []
        conf = 0.0
        if kind != "symbols":
            entries, conf = _parse_types_table(vs, spans, t, lid, n)
            if entries:
                kind = "types"
        if not entries:
            entries, conf = _parse_symbol_table(vs, spans, t, lid, n)
            kind = "symbols"
        if not entries:
            continue
        if title:
            conf = min(0.98, conf + 0.05)
        res.legends.append(
            Legend(
                id=lid,
                kind=kind or "symbols",
                bbox=t.bbox,
                title=title[0] if title else (TITLE_TYPES if kind == "types" else TITLE_LEGEND),
                confidence=round(conf, 3),
                entries=entries,
            )
        )
        n += len(entries)
    return res
