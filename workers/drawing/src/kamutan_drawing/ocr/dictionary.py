"""Glyph dictionary: cluster identical SHX glyph shapes across a sheet set,
label every cluster from OCR votes, then read text deterministically.

Pipeline::

    lines = extract_text_lines(vs)            # per sheet (ocr.glyphs)
    gd = GlyphDictionary.build(all_lines)     # exact-key groups + tolerant merge
    gd.label_from_ocr(all_lines, source=...)  # tesseract votes -> one label per cluster
    text = gd.read_line(line)                 # deterministic read
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.cluster.hierarchy import fcluster, linkage

from .glyphs import TextLine
from .tess import ocr_boxes, render_line
from .textutil import visual_to_logical

# cosine distance under which exact-key groups are merged. 0 = exact keys only:
# the spike showed that any tolerant merge mixes Hebrew look-alikes (ה/ח/ק, ב/כ/נ).
FEAT_MERGE_DIST = 0.0
WORD_GAP = 0.55  # gap / line height that starts a new word
DIGIT_GAP = 1.0  # same, between two digits
LATIN_SEED_CONF = 0.6  # a Latin neighbour must be at least this confident to flip a glyph to Latin
QUOTES = {"'", '"', "\u05f3", "\u05f4", "`", "\u2019"}


@dataclass
class Cluster:
    id: int
    keys: set[str]
    feat: np.ndarray
    count: int = 0
    votes: Counter = field(default_factory=Counter)
    votes_eng: Counter = field(default_factory=Counter)
    alt: str | None = None  # Latin reading used when neighbours are Latin
    rel_h: list = field(default_factory=list)  # glyph height / line height (samples)
    n_comps: list = field(default_factory=list)  # connected stroke groups per glyph (samples)
    rel_bottom: list = field(default_factory=list)  # (glyph bottom - baseline) / line height

    def descends(self) -> bool:
        return bool(self.rel_bottom) and float(np.median(self.rel_bottom)) > 0.1

    def sits_on_baseline(self) -> bool:
        return bool(self.rel_bottom) and abs(float(np.median(self.rel_bottom))) < 0.05

    def geometry(self) -> tuple[float, int]:
        rh = float(np.median(self.rel_h)) if self.rel_h else 1.0
        nc = Counter(self.n_comps).most_common(1)[0][0] if self.n_comps else 1
        return rh, nc

    label: str | None = None
    conf: float = 0.0
    example: tuple[int, int] | None = None  # (line index, glyph index)


def _match_boxes(spans: list[tuple[float, float]], boxes) -> list[tuple[int, int]]:
    """Optimal one-to-one assignment of OCR char boxes to glyph x-spans.

    Maximises the summed x-IoU (Hungarian), so a ':' box sitting next to a
    wide letter cannot steal that letter's vote as a greedy match would.
    """
    from scipy.optimize import linear_sum_assignment

    if not spans or not boxes:
        return []
    iou = np.zeros((len(spans), len(boxes)))
    for i, (a, b) in enumerate(spans):
        for j, bx in enumerate(boxes):
            inter = min(b, bx.x1) - max(a, bx.x0)
            if inter > 0:
                iou[i, j] = inter / (max(b, bx.x1) - min(a, bx.x0))
    r, c = linear_sum_assignment(-iou)
    return [(int(i), int(j)) for i, j in zip(r, c) if iou[i, j] >= 0.25]


TO_FINAL = {"ד": "ך", "ר": "ך", "כ": "ך", "ו": "ן", "פ": "ף", "צ": "ץ"}
FROM_FINAL = {"ן": "ו", "ף": "פ", "ץ": "צ", "ך": "ד"}
SMALL_MARKS = set(".,:;'\"`\u2018\u2019\u05f3\u05f4-_~\u00bb\u00ab")
SYMBOLS_OK = set("=+-/.:,()%'\"")


CASE_BY_HEIGHT = set("cosvwxzCOSVWXZ")  # Latin letters whose upper/lower case differ only in height


def is_diameter_sign(polys, x0: float, baseline: float, h: float) -> bool:
    """SHX ``Ø``: a closed curved loop crossed by one long diagonal straight stroke."""
    loop = None
    bars = []
    for curve, v in polys:
        if len(v) < 2:
            continue
        a = (v - [x0, baseline]) / h
        if curve and len(a) >= 4 and np.abs(a[0] - a[-1]).max() < 0.05:
            loop = a
        elif not curve and len(a) == 2:
            bars.append(a)
    if loop is None or len(bars) != 1 or len(polys) != 2:
        return False
    b = bars[0]
    lw = loop[:, 0].max() - loop[:, 0].min()
    lh = loop[:, 1].max() - loop[:, 1].min()
    dx, dy = abs(b[1, 0] - b[0, 0]), abs(b[1, 1] - b[0, 1])
    cx, cy = loop[:, 0].mean(), loop[:, 1].mean()
    mid = b.mean(axis=0)
    return bool(
        0.6 < lw / max(lh, 1e-6) < 1.6
        and dx >= 0.8 * lw
        and dy >= 0.8 * lh
        and abs(mid[0] - cx) < 0.25 * lw
        and abs(mid[1] - cy) < 0.25 * lh
    )


def _numeric(c: str) -> bool:
    return c.isdigit() or c in ".:/,"


def _top(c: Counter) -> tuple[str | None, float]:
    tot = sum(c.values())
    if not tot:
        return None, 0.0
    ch, n = c.most_common(1)[0]
    return ch, n / tot


class GlyphDictionary:
    def __init__(self, clusters: list[Cluster], key_to_cluster: dict[str, int]):
        self.clusters = clusters
        self.key_to_cluster = key_to_cluster

    # ------------------------------------------------------------------ build
    @classmethod
    def build(cls, lines: list[TextLine], merge_dist: float = FEAT_MERGE_DIST) -> GlyphDictionary:
        by_key: dict[str, list[tuple[int, int]]] = defaultdict(list)
        feats: dict[str, list[np.ndarray]] = defaultdict(list)
        for li, ln in enumerate(lines):
            for gi, g in enumerate(ln.glyphs):
                by_key[g.key].append((li, gi))
                if g.feat is not None and len(feats[g.key]) < 20:
                    feats[g.key].append(g.feat)
        keys = list(by_key)
        F = np.array([np.mean(feats[k], axis=0) for k in keys])
        zero = np.linalg.norm(F, axis=1) < 1e-9
        F[zero] = 1.0  # glyph entirely outside the feature window: uniform vector
        F /= np.linalg.norm(F, axis=1, keepdims=True)
        lab: np.ndarray
        if len(keys) > 1 and merge_dist > 0:
            Z = linkage(F, method="complete", metric="cosine")
            lab = fcluster(Z, t=merge_dist, criterion="distance") - 1
        else:
            lab = np.arange(len(keys))
        clusters: dict[int, Cluster] = {}
        k2c: dict[str, int] = {}
        labels: list[int] = [int(v) for v in lab.tolist()]
        for k, c in zip(keys, labels, strict=True):
            cl = clusters.setdefault(c, Cluster(id=c, keys=set(), feat=np.zeros_like(F[0])))
            cl.keys.add(k)
            cl.count += len(by_key[k])
            cl.feat = cl.feat + F[keys.index(k)] * len(by_key[k])
            if cl.example is None:
                cl.example = by_key[k][0]
            for li, gi in by_key[k][:50]:
                ln = lines[li]
                g = ln.glyphs[gi]
                cl.rel_h.append(float((g.bbox[3] - g.bbox[1]) / ln.height))
                cl.rel_bottom.append(float((g.bbox[3] - ln.baseline) / ln.height))
                cl.n_comps.append(len(g.comps))
            k2c[k] = c
        for cl in clusters.values():
            n = np.linalg.norm(cl.feat)
            cl.feat = cl.feat / n if n else cl.feat
        ordered = [clusters[i] for i in sorted(clusters)]
        gd = cls(ordered, k2c)
        gd.assign(lines)
        return gd

    def assign(self, lines: list[TextLine]) -> None:
        """Set ``glyph.cluster``; unseen keys go to the nearest cluster by feature."""
        F = np.array([c.feat for c in self.clusters]) if self.clusters else None
        id_index = {c.id: i for i, c in enumerate(self.clusters)}
        for ln in lines:
            for g in ln.glyphs:
                c = self.key_to_cluster.get(g.key)
                if c is None and F is not None:
                    d = 1.0 - F @ g.feat
                    j = int(np.argmin(d))
                    c = self.clusters[j].id if d[j] < max(FEAT_MERGE_DIST, 0.05) else -1
                g.cluster = c if c is not None else -1
        self._id_index = id_index

    def cluster_by_id(self, cid: int) -> Cluster | None:
        i = getattr(self, "_id_index", {c.id: k for k, c in enumerate(self.clusters)}).get(cid)
        return self.clusters[i] if i is not None else None

    @property
    def n_unique(self) -> int:
        return len(self.clusters)

    # ------------------------------------------------------------------ label
    def collect_votes(
        self,
        lines: list[TextLine],
        image_fn=None,
        lang: str = "heb",
        psm: int = 6,
        workers: int = 2,
        batch: int = 30,
        target: str = "votes",
    ) -> None:
        """Run OCR on line images and vote char -> cluster by x-overlap.

        ``image_fn(line) -> (PIL image, mm_x -> px_x)``; defaults to the clean
        vector rendering of the glyph strokes. Lines are stacked ``batch`` per
        image (one tesseract process per batch: model loading dominates otherwise).
        """
        image_fn = image_fn or (lambda ln: render_line(ln))
        items = []
        for ln in lines:
            img, to_px = image_fn(ln)
            if img is not None:
                items.append((ln, img, to_px))
        chunks = [items[i : i + batch] for i in range(0, len(items), batch)]

        def job(chunk):
            gap = 30
            W = max(im.size[0] for _, im, _ in chunk) + 2 * gap
            Ht = sum(im.size[1] + gap for _, im, _ in chunk) + gap
            canvas = Image.new("L", (W, Ht), 255)
            spans, y = [], gap
            for _, im, _ in chunk:
                canvas.paste(im, (gap, y))
                spans.append((y, y + im.size[1]))
                y += im.size[1] + gap
            boxes = ocr_boxes(canvas, lang=lang, psm=psm)
            per = [[] for _ in chunk]
            for bx in boxes:
                cy = (bx.y0 + bx.y1) / 2
                for k, (a, b) in enumerate(spans):
                    if a <= cy <= b:
                        bx.x0 -= gap
                        bx.x1 -= gap
                        per[k].append(bx)
                        break
            return [(ln, per[k], to_px) for k, (ln, _, to_px) in enumerate(chunk)]

        with ThreadPoolExecutor(max_workers=workers) as ex:
            results = [r for res in ex.map(job, chunks) for r in res]
        self.ocr_raw = getattr(self, "ocr_raw", {})
        for ln, boxes, to_px in results:
            self.ocr_raw[(id(ln), target)] = "".join(b.ch for b in boxes)
            spans = []
            for g in ln.glyphs:
                a, b = sorted((to_px(g.bbox[0]), to_px(g.bbox[2])))
                spans.append((a - 1.0, b + 1.0))
            boxes = [bx for bx in boxes if bx.ch.strip()]
            for gi, bi in _match_boxes(spans, boxes):
                cl = self.cluster_by_id(ln.glyphs[gi].cluster)
                if cl is not None:
                    getattr(cl, target)[boxes[bi].ch] += 1

    def finalize_labels(self, min_votes: int = 1, lines: list[TextLine] | None = None) -> None:
        """One label per cluster from Hebrew (``votes``) and English (``votes_eng``) OCR.

        * Hebrew letter winners stay Hebrew unless English is near-unanimous on a
          Latin letter; the English reading is kept as ``alt`` (used in Latin context).
        * Digits/symbols: the more consistent of the two readings wins.
        * Geometry that OCR cannot know (with ``lines``, to look at an example glyph):
          SHX ``Ø`` (loop + diagonal bar, never produced by Tesseract) and the case of
          Latin letters whose upper/lower forms differ only in height (``X``/``x``).
        """
        for cl in self.clusters:
            if lines is not None and cl.example is not None:
                li, gi = cl.example
                if li < len(lines) and gi < len(lines[li].glyphs):
                    ln = lines[li]
                    g = ln.glyphs[gi]
                    if g.polys and is_diameter_sign(g.polys, float(g.bbox[0]), ln.baseline, ln.height):
                        cl.label, cl.conf, cl.alt = "Ø", 0.9, None
                        continue
            rel_h, n_comps = cl.geometry()
            hv, ev = Counter(cl.votes), Counter(cl.votes_eng)
            if rel_h >= 0.6 and n_comps == 1:
                # geometric veto: a one-piece, letter-height glyph cannot be '.', ':', ',', quotes or '-'
                # (those votes come from OCR boxes bleeding over from an adjacent mark)
                for v in (hv, ev):
                    for ch in list(v):
                        if ch in SMALL_MARKS:
                            del v[ch]
            if rel_h < 0.45:
                # geometric veto: a short glyph (tick, dot, dash, '=') cannot be a digit or letter
                for v in (hv, ev):
                    for ch in list(v):
                        if ch.isascii() and ch.isalnum():
                            del v[ch]
            hl, hc = _top(hv)
            el, ec = _top(ev)
            label, conf, alt = hl, hc, None
            heb_is_heb = hl is not None and "\u05d0" <= hl <= "\u05ea"
            eng_is_latin = el is not None and el.isascii() and el.isalpha()
            if heb_is_heb:
                # never override a Hebrew winner at cluster level (ך vs T, ו vs V):
                # keep the Latin reading as a context-dependent alternative
                if eng_is_latin and ec >= 0.4:
                    alt = el
            elif el is not None and (el.isalnum() and el.isascii() or el in SYMBOLS_OK):
                both_digits = hl is not None and hl.isdigit() and el.isdigit()
                if (
                    hl is None
                    or el == hl
                    or both_digits  # the English model is the better digit reader
                    or (eng_is_latin and ec >= hc and sum(ev.values()) >= 2)
                    or ec >= hc + 0.2
                ):
                    label, conf, alt = el, max(ec, hc if el == hl else 0.0), hl
            if label is not None and "\u05d0" <= label <= "\u05ea":
                # descender geometry decides final vs non-final look-alikes (ך/ד, ן/ו, ף/פ, ץ/צ)
                if cl.descends():
                    label = TO_FINAL.get(label, label)
                elif cl.sits_on_baseline():
                    label = FROM_FINAL.get(label, label)
            if label in QUOTES:  # one tick stroke = geresh, two = gershayim
                label = '"' if n_comps >= 2 else "'"
            if label is not None and label in CASE_BY_HEIGHT:
                label = label.upper() if rel_h >= 0.85 else (label.lower() if rel_h <= 0.75 else label)
            tot = sum(cl.votes.values()) + sum(cl.votes_eng.values())
            if label is None or tot < min_votes:
                cl.label, cl.conf, cl.alt = None, 0.0, None
            else:
                cl.label, cl.conf, cl.alt = label, float(conf), alt

    def propagate_nearest(self, max_dist: float = 0.12) -> int:
        """Unlabelled clusters borrow the label of the nearest labelled cluster
        (cosine distance on the bitmap feature) when it is close enough."""
        lab = [c for c in self.clusters if c.label]
        if not lab:
            return 0
        F = np.array([c.feat for c in lab])
        n = 0
        for c in self.clusters:
            if c.label:
                continue
            d = 1.0 - F @ c.feat
            j = int(np.argmin(d))
            if d[j] < max_dist:
                c.label, c.conf = lab[j].label, float(lab[j].conf * (1 - d[j]))
                n += 1
        return n

    # ------------------------------------------------------------------ read
    def glyph_label(self, g) -> str:
        cl = self.cluster_by_id(g.cluster)
        return cl.label if (cl is not None and cl.label) else "?"

    def read_glyphs(self, ln: TextLine, glyph_ids: list[int] | None = None) -> str:
        """Visual order -> logical string with spaces at word gaps.

        Script context: a glyph whose cluster has a Latin ``alt`` reading (SHX ז
        and Latin T are the same strokes) is read as Latin when a neighbour in
        the same word is Latin.
        """
        ids = range(len(ln.glyphs)) if glyph_ids is None else glyph_ids
        gl = sorted((ln.glyphs[i] for i in ids), key=lambda g: g.bbox[0])
        labs, alts, confs = [], [], []
        for g in gl:
            cl = self.cluster_by_id(g.cluster)
            labs.append(cl.label if (cl is not None and cl.label) else "?")
            alts.append(cl.alt if cl is not None else None)
            confs.append(cl.conf if cl is not None else 0.0)
        # word breaks
        brk = [False] * len(gl)
        for k in range(1, len(gl)):
            gap = gl[k].bbox[0] - gl[k - 1].bbox[2]
            lim = WORD_GAP * ln.height
            if _numeric(labs[k]) and _numeric(labs[k - 1]):
                lim = DIGIT_GAP * ln.height  # SHX digits are widely tracked; '1' is narrow
            brk[k] = gap > lim
        latin = lambda c: c.isascii() and c.isalpha()
        # whole word readable as Latin (every glyph Latin or with a Latin alt) -> Latin
        start = 0
        for k in range(1, len(gl) + 1):
            if k == len(gl) or brk[k]:
                word = range(start, k)
                if (
                    len(word) >= 2
                    and any(latin(labs[i]) and confs[i] >= LATIN_SEED_CONF for i in word)
                    and all(latin(labs[i]) or (alts[i] and latin(alts[i])) for i in word)
                ):
                    for i in word:
                        alt = alts[i]
                        if not latin(labs[i]) and alt:
                            labs[i] = alt
                start = k
        for _ in range(3):
            for k, a in enumerate(alts):
                if a and latin(a) and not latin(labs[k]):
                    left = k > 0 and not brk[k] and latin(labs[k - 1]) and confs[k - 1] >= LATIN_SEED_CONF
                    right = k + 1 < len(gl) and not brk[k + 1] and latin(labs[k + 1]) and confs[k + 1] >= LATIN_SEED_CONF
                    # "H=120", "O.K=+0.35": a letter directly followed by '=' is a Latin variable name
                    eq = k + 1 < len(gl) and not brk[k + 1] and labs[k + 1] == "="
                    if left or right or eq:
                        labs[k] = a
                        confs[k] = LATIN_SEED_CONF
        out: list[str] = []
        for k, lab in enumerate(labs):
            if k and brk[k]:
                out.append(" ")
            elif lab in QUOTES and out and out[-1] in QUOTES:
                out[-1] = '"'  # SHX gershayim = two separate tick strokes
                continue
            out.append(('"' if lab in ('"', "\u05f4") else "'") if lab in QUOTES else lab)
        return visual_to_logical("".join(out))

    def read_line(self, ln: TextLine) -> str:
        return self.read_glyphs(ln)

    # ------------------------------------------------------------------ io
    def to_json(self) -> dict:
        return {
            "n_clusters": len(self.clusters),
            "clusters": [
                {
                    "id": c.id,
                    "label": c.label,
                    "conf": round(float(c.conf), 3),
                    "count": c.count,
                    "votes": dict(c.votes.most_common(5)),
                    "n_keys": len(c.keys),
                }
                for c in self.clusters
            ],
        }

    def save(self, path: str | Path) -> None:
        Path(path).write_text(json.dumps(self.to_json(), ensure_ascii=False, indent=1))


def contact_sheet(gd: GlyphDictionary, lines: list[TextLine], cols: int = 20, cell: int = 48) -> Image.Image:
    """Grid of one example per cluster (for human/VLM labelling and reports)."""
    from .tess import render_glyph

    cl = sorted(gd.clusters, key=lambda c: -c.count)
    rows = (len(cl) + cols - 1) // cols
    sheet = Image.new("L", (cols * cell, rows * cell), 255)
    for k, c in enumerate(cl):
        if c.example is None:
            continue
        li, gi = c.example
        ln = lines[li]
        im = render_glyph(ln.glyphs[gi], ln.height, ln.baseline, px_per_h=cell * 0.45)
        im.thumbnail((cell - 2, cell - 2))
        sheet.paste(im, ((k % cols) * cell + 1, (k // cols) * cell + 1))
    return sheet


@dataclass
class TextSpan:
    sheet: str
    bbox: tuple[float, float, float, float]  # page mm
    text: str
    conf: float  # min cluster confidence over the span's glyphs (0 if any unknown)
    height: float
    rotation: int
    n_glyphs: int


def text_spans(lines: list[TextLine], gd: GlyphDictionary, max_gap_h: float = 1.3) -> list[TextSpan]:
    """Merge word-level lines sharing a baseline into phrases and read them."""
    by_key: dict = defaultdict(list)
    for ln in lines:
        by_key[(ln.sheet, ln.rotation, ln.style)].append(ln)
    spans: list[TextSpan] = []
    for (sheet, rot, _), lns in by_key.items():
        lns = sorted(lns, key=lambda l: (l.baseline, l.glyphs[0].bbox[0]))
        used = [False] * len(lns)
        for i, a in enumerate(lns):
            if used[i]:
                continue
            group = [a]
            used[i] = True
            changed = True
            while changed:
                changed = False
                for j, b in enumerate(lns):
                    if used[j]:
                        continue
                    ref = group[0]
                    if abs(b.baseline - ref.baseline) > 0.3 * ref.height:
                        continue
                    if abs(b.height - ref.height) > 0.25 * ref.height:
                        continue
                    gx0 = min(g.bbox[0] for l in group for g in l.glyphs)
                    gx1 = max(g.bbox[2] for l in group for g in l.glyphs)
                    bx0, bx1 = b.glyphs[0].bbox[0], b.glyphs[-1].bbox[2]
                    gap = max(bx0 - gx1, gx0 - bx1)
                    if gap <= max_gap_h * ref.height:
                        group.append(b)
                        used[j] = True
                        changed = True
            # read as one visual line: fake a combined TextLine
            gl = [g for l in group for g in l.glyphs]
            comb = TextLine(
                sheet=sheet,
                glyphs=sorted(gl, key=lambda g: g.bbox[0]),
                bbox=np.array(
                    [
                        min(l.bbox[0] for l in group),
                        min(l.bbox[1] for l in group),
                        max(l.bbox[2] for l in group),
                        max(l.bbox[3] for l in group),
                    ]
                ),
                baseline=group[0].baseline,
                topline=group[0].topline,
                height=group[0].height,
                rotation=rot,
                style=group[0].style,
            )
            text = gd.read_line(comb)
            confs = []
            for g in gl:
                c = gd.cluster_by_id(g.cluster)
                confs.append(c.conf if (c is not None and c.label) else 0.0)
            spans.append(
                TextSpan(
                    sheet=sheet,
                    bbox=(float(comb.bbox[0]), float(comb.bbox[1]), float(comb.bbox[2]), float(comb.bbox[3])),
                    text=text,
                    conf=float(min(confs)) if confs else 0.0,
                    height=float(comb.height),
                    rotation=rot,
                    n_glyphs=len(gl),
                )
            )
    return spans
