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
QUOTES = {"'", '"', "\u05f3", "\u05f4", "`", "\u2019"}


@dataclass
class Cluster:
    id: int
    keys: set[str]
    feat: np.ndarray
    count: int = 0
    votes: Counter = field(default_factory=Counter)
    votes_eng: Counter = field(default_factory=Counter)
    label: str | None = None
    conf: float = 0.0
    example: tuple[int, int] | None = None  # (line index, glyph index)


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
                if len(feats[g.key]) < 20:
                    feats[g.key].append(g.feat)
        keys = list(by_key)
        F = np.array([np.mean(feats[k], axis=0) for k in keys])
        zero = np.linalg.norm(F, axis=1) < 1e-9
        F[zero] = 1.0  # glyph entirely outside the feature window: uniform vector
        F /= np.linalg.norm(F, axis=1, keepdims=True)
        if len(keys) > 1 and merge_dist > 0:
            Z = linkage(F, method="complete", metric="cosine")
            lab = fcluster(Z, t=merge_dist, criterion="distance") - 1
        else:
            lab = np.arange(len(keys))
        clusters: dict[int, Cluster] = {}
        k2c: dict[str, int] = {}
        for k, c in zip(keys, lab):
            c = int(c)
            cl = clusters.setdefault(c, Cluster(id=c, keys=set(), feat=np.zeros_like(F[0])))
            cl.keys.add(k)
            cl.count += len(by_key[k])
            cl.feat = cl.feat + F[keys.index(k)] * len(by_key[k])
            if cl.example is None:
                cl.example = by_key[k][0]
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
            used = set()
            for bx in boxes:
                if not bx.ch.strip():
                    continue
                best, bo = -1, 0.0
                for gi, (a, b) in enumerate(spans):
                    ov = min(b, bx.x1) - max(a, bx.x0)
                    if ov > bo:
                        best, bo = gi, ov
                if best < 0:
                    continue
                a, b = spans[best]
                # the box must cover a decent part of the glyph
                if bo < 0.4 * max(b - a, 1.0) and bo < 0.4 * max(bx.x1 - bx.x0, 1):
                    continue
                if best in used:
                    continue  # one char per glyph; first box wins
                used.add(best)
                cl = self.cluster_by_id(ln.glyphs[best].cluster)
                if cl is not None:
                    getattr(cl, target)[bx.ch] += 1

    def finalize_labels(self, min_votes: int = 1) -> None:
        """Pick one label per cluster from the Hebrew votes, or from the English
        votes when the cluster is clearly a Latin letter / symbol that the Hebrew
        model cannot read (BEZEK, TV, TEL, 2X ...)."""
        for cl in self.clusters:
            hl, hc = _top(cl.votes)
            el, ec = _top(cl.votes_eng)
            label, conf = hl, hc
            if el is not None:
                eng_is_latin = el.isascii() and el.isalpha()
                heb_is_heb = hl is not None and "\u05d0" <= hl <= "\u05ea"
                if eng_is_latin and ec >= 0.6 and (not heb_is_heb or hc < 0.6) and ec > hc:
                    label, conf = el, ec
                elif hl is None or (not heb_is_heb and not hl.isdigit() and ec > hc):
                    label, conf = el, ec
            tot = sum(cl.votes.values()) + sum(cl.votes_eng.values())
            if label is None or tot < min_votes:
                cl.label, cl.conf = None, 0.0
            else:
                cl.label, cl.conf = label, conf

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
        """Visual order -> logical string with spaces at word gaps."""
        ids = range(len(ln.glyphs)) if glyph_ids is None else glyph_ids
        gl = sorted((ln.glyphs[i] for i in ids), key=lambda g: g.bbox[0])
        out: list[str] = []
        prev = None
        for g in gl:
            lab = self.glyph_label(g)
            if prev is not None and (g.bbox[0] - prev.bbox[2]) > WORD_GAP * ln.height:
                out.append(" ")
            elif lab in QUOTES and out and out[-1] in QUOTES:
                out[-1] = '"'  # SHX gershayim = two separate tick strokes
                prev = g
                continue
            out.append("'" if lab in QUOTES else lab)
            prev = g
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


def text_spans(lines: list[TextLine], gd: GlyphDictionary, max_gap_h: float = 2.0) -> list[TextSpan]:
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
                    bbox=tuple(float(v) for v in comb.bbox),
                    text=text,
                    conf=float(min(confs)) if confs else 0.0,
                    height=float(comb.height),
                    rotation=rot,
                    n_glyphs=len(gl),
                )
            )
    return spans
