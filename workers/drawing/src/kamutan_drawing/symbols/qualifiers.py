"""Read the short text written next to a look-alike symbol (BEZEK / TV / TEL / רשת) with Tesseract (Stage 10, A-pipeline-01).

Comms points share one drawing (a bracket on the wall); only the word at the end of the bracket's stem tells a
phone point from a data or TV point. On the AutoCAD exports that word is SHX strokes, often written vertically
or at 45° along the stem, and the glyph reader (:mod:`kamutan_drawing.ocr`) does not read rotated words.

Per candidate symbol this module cuts narrow *windows* along the 8 compass directions (start just outside the
symbol, about two symbol sizes long, one text height wide), keeps only the small strokes inside (text-sized
paths; walls and long lines drop out), turns each window so that the text runs left to right the way a drawing
is read (from the bottom or the right side of the sheet) and stacks every window of the sheet into ONE image.
Tesseract reads that image twice (``eng`` for TV / TEL / BEZEK, ``heb`` for רשת / בזק), so the cost is two
Tesseract calls per sheet, whatever the number of symbols.

Each window's words are compared with the tokens of each family member (the legend's qualifier, or words implied
by its label: "נק' קצה לטלויזיה" → TV). Assignment is global and greedy: best similarity first, one reading per
symbol, and a window's strokes can name only one symbol (two symbols side by side never share a word).
Pure apart from the Tesseract subprocess; a missing / failing Tesseract returns no readings (the caller keeps
its previous behaviour).
"""

from __future__ import annotations

import logging
import math
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Protocol

import numpy as np
from PIL import Image, ImageDraw

from ..ocr.textutil import levenshtein

log = logging.getLogger(__name__)


class FamilyEntry(Protocol):
    """A family member as the legend gives it (:class:`kamutan_drawing.legend.parse.LegendEntry`)."""

    label: str
    qualifier: str


PX_PER_MM = 30  # render scale: SHX text 2.5 mm high → 75 px, comfortable for Tesseract
MIN_SEGS = 4  # a window with fewer strokes holds no word
MIN_SIM = 0.6  # 1 - edit distance / token length (one slip in רשת is accepted, none in TV)
TEXT_PATH_MAX = 1.0  # stroke paths up to this many symbol sizes are text-like

# label keywords → tokens written next to the symbol on the plan (first match wins; order matters: בזק before טלפון)
_LABEL_TOKENS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("בזק", ("BEZEK", "בזק")),
    ("טלוויז", ("TV",)),
    ("טלויז", ("TV",)),
    ("טלביז", ("TV",)),
    ("TV", ("TV",)),
    ("טלפון", ("TEL",)),
    ("רשת", ("רשת", "DATA")),
    ("מחשב", ("רשת", "DATA")),
)
_LATIN = re.compile(r"[A-Za-z]")
_PUNCT = re.compile(r"[^0-9A-Za-z֐-׿]+")


def entry_tokens(label: str, qualifier: str) -> tuple[str, ...]:
    """Words that name this family member next to the symbol: the label's implied words, plus the legend's own
    qualifier when it reads as a clean word (digits / stray marks of the legend row stripped)."""
    out: list[str] = []
    for kw, toks in _LABEL_TOKENS:
        if kw in label:
            out.extend(toks)
            break
    q = re.sub(r"[0-9]", "", _PUNCT.sub("", qualifier or "")).upper()
    q = re.sub(r"^כ", "", q) if "רשת" in q else q  # "כ.רשת" (cable network) → רשת
    if len(q) >= 2 and q not in out:
        out.append(q)
    return tuple(out)


def similarity(word: str, token: str) -> float:
    """1 − edit distance / token length, strict for short Latin words (OCR noise is full of two-letter words):
    a Latin token of ≤ 3 letters needs the same length and ≤ 1 substitution (3 letters) or an exact match (2)."""
    w = _PUNCT.sub("", word).upper()
    t = token.upper()
    if not w or not t:
        return 0.0
    if w == t:
        return 1.0
    latin = bool(_LATIN.search(t))
    if latin and len(t) <= 3:
        if len(t) == 2 or len(w) != len(t):
            return 0.0
        return 1.0 - levenshtein(w, t) / len(t)
    best = float(levenshtein(w, t))
    if len(w) > len(t):  # a stray stroke read as a letter next to the word ("רהשת")
        best = min([best, *(levenshtein(w[i : i + len(t)], t) + 0.5 for i in range(len(w) - len(t) + 1))])
    return max(0.0, 1.0 - best / len(t))


@dataclass
class Window:
    item: int  # index into the candidates
    direction: int  # degrees, y-down paper frame
    flip: bool
    seg_idx: np.ndarray
    u: np.ndarray  # (k, 4) local coords u0, v0, u1, v1 (mm)
    lateral: float  # mean |v| of the ink: 0 = the text lies on the stem's axis


@dataclass
class Reading:
    item: int
    entry: int  # index into that item's family
    similarity: float
    word: str
    direction: int
    token: str  # the family member's word it matched ("TEL", "רשת")


def _windows(segs: np.ndarray, short: np.ndarray, centers: Sequence[tuple[float, float]], sizes: Sequence[float]) -> list[Window]:
    out: list[Window] = []
    for i, ((cx, cy), size) in enumerate(zip(centers, sizes, strict=True)):
        r0, r1, hw = max(1.2, 0.45 * size), max(1.2, 0.45 * size) + 2.1 * size, 0.48 * size
        near = short & (np.abs(segs[:, 0] - cx) <= r1 + hw) & (np.abs(segs[:, 1] - cy) <= r1 + hw)
        idx = np.nonzero(near)[0]
        if len(idx) < MIN_SEGS:
            continue
        s = segs[idx]
        for k in range(8):
            a = k * math.pi / 4
            ux, uy = math.cos(a), math.sin(a)
            au = (s[:, 0] - cx) * ux + (s[:, 1] - cy) * uy
            av = -(s[:, 0] - cx) * uy + (s[:, 1] - cy) * ux
            bu = (s[:, 2] - cx) * ux + (s[:, 3] - cy) * uy
            bv = -(s[:, 2] - cx) * uy + (s[:, 3] - cy) * ux
            m = (au >= r0) & (bu >= r0) & (au <= r1) & (bu <= r1) & (np.abs(av) <= hw) & (np.abs(bv) <= hw)
            # the symbol's stem (a line along the window's axis from its start) would merge with the first letter
            du, dv = bu - au, bv - av
            along = np.abs(dv) <= 0.27 * np.hypot(du, dv) + 1e-9
            stem = along & (np.minimum(au, bu) <= r0 + 0.5) & (np.maximum(np.abs(av), np.abs(bv)) <= 0.3)
            m &= ~stem
            if int(m.sum()) < MIN_SEGS:
                continue
            # drawings are read from the bottom or the right: the text runs right, or straight up
            flip = not (ux > 1e-6 or (abs(ux) <= 1e-6 and uy < 0))
            lat = float(np.mean(np.abs(np.concatenate([av[m], bv[m]]))))
            out.append(Window(i, k * 45, flip, idx[m], np.stack([au[m], av[m], bu[m], bv[m]], axis=1), lat))
    return out


def _stack(windows: list[Window], length: float, half: float) -> tuple[Image.Image, int]:
    """All windows one under the other (one text line each) → image, strip pitch in px."""
    strip, gap = int(2 * half * PX_PER_MM) + 30, STACK_GAP
    pitch = strip + gap
    width = int((length + 1.0) * PX_PER_MM)
    img = Image.new("L", (width, gap + len(windows) * pitch), 255)
    dr = ImageDraw.Draw(img)
    for n, w in enumerate(windows):
        oy = gap + n * pitch + strip / 2

        def p(u: float, v: float, oy: float = oy, flip: bool = w.flip) -> tuple[float, float]:
            if flip:
                u, v = length - u, -v
            return (u + 0.5) * PX_PER_MM, oy + v * PX_PER_MM

        for u0, v0, u1, v1 in w.u:
            dr.line([p(u0, v0), p(u1, v1)], fill=0, width=4)
    return img, pitch


SPAN_REACH = 2.6  # × symbol size: a text-layer word this close to a bracket's centre may name it (≈ the OCR window)


class SpanLike(Protocol):
    bbox: tuple[float, float, float, float]
    text: str


def read_from_spans(
    centers: Sequence[tuple[float, float]],
    sizes: Sequence[float],
    families: Sequence[Sequence[FamilyEntry]],
    spans: Sequence[SpanLike],
) -> dict[int, Reading]:
    """Sprint 10: name family members from the sheet's TEXT LAYER before any OCR.

    Some designers write the word beside a bracket ("רשת", "TEL") as a font text object: the text layer holds it
    cleanly, while the OCR windows (rendered from strokes) see nothing — and when the legend row kept no qualifier,
    the plain span check (``detect._family_member``) has nothing to compare it with. Here every word of a nearby span
    is compared with each member's implied tokens (:func:`entry_tokens`), **exact match only**; nearest span first,
    one span per candidate and one candidate per span; a candidate whose nearest matching spans name two different
    members at the same distance stays unread (OCR / the old fallback decide)."""
    tokens = [[entry_tokens(f.label, f.qualifier) for f in fam] for fam in families]
    pairs: list[tuple[float, int, int, int, str, str]] = []  # (distance, candidate, span, entry, word, token)
    for i, (c, size) in enumerate(zip(centers, sizes, strict=True)):
        reach = SPAN_REACH * max(float(size), 1.0)
        for si, sp in enumerate(spans):
            sx, sy = (sp.bbox[0] + sp.bbox[2]) / 2, (sp.bbox[1] + sp.bbox[3]) / 2
            dist = math.hypot(sx - c[0], sy - c[1])
            if dist > reach:
                continue
            words = [_PUNCT.sub("", w).upper() for w in str(sp.text).split()]
            for ei, toks in enumerate(tokens[i]):
                hit = next(((w, t) for w in words for t in toks if w and w == t.upper()), None)
                if hit is not None:
                    pairs.append((dist, i, si, ei, hit[0], hit[1]))
    pairs.sort()
    out: dict[int, Reading] = {}
    used_spans: set[int] = set()
    for dist, i, si, ei, word, tok in pairs:
        if i in out or si in used_spans:
            continue
        rivals = {e for d, j, s, e, _, _ in pairs if j == i and s not in used_spans and abs(d - dist) < 1e-6}
        if len(rivals) > 1:
            continue
        out[i] = Reading(i, ei, 1.0, word, -1, tok)
        used_spans.add(si)
    return out


def read_qualifiers(
    segs: np.ndarray,
    seg_path: np.ndarray,
    path_bbox: np.ndarray,
    centers: Sequence[tuple[float, float]],
    sizes: Sequence[float],
    families: Sequence[Sequence[FamilyEntry]],
    *,
    ocr: OcrFn | None = None,
) -> dict[int, Reading]:
    """Readings ``{candidate index: Reading}`` for the candidates whose family member could be named.

    ``families[i]`` = the members of candidate *i*'s look-alike family (label + qualifier). ``ocr`` (tests) is a
    callable ``(image, lang, psm) -> list[(text, y_center_px)]``; default = Tesseract TSV.

    Pass 1: every window of the sheet stacked in one image, read once per language (psm 6). Pass 2: candidates
    still unread get their few most on-axis windows read one by one as a single word (psm 8), at most
    :data:`MAX_SINGLE_CALLS` Tesseract calls per sheet."""
    if not centers:
        return {}
    tokens = [[entry_tokens(f.label, f.qualifier) for f in fam] for fam in families]
    if not any(t for fam in tokens for t in fam):
        return {}
    pext = np.maximum(path_bbox[:, 2] - path_bbox[:, 0], path_bbox[:, 3] - path_bbox[:, 1])
    size_cap = max(3.5, TEXT_PATH_MAX * max(sizes))
    short = pext[seg_path] <= size_cap
    wins = _windows(segs.astype(np.float64), short, centers, sizes)
    if not wins:
        return {}
    length = max(max(0.45 * s, 1.2) + 2.1 * s for s in sizes)
    half = max(0.48 * s for s in sizes)
    read: OcrFn = ocr or _tesseract_words
    words: dict[int, list[str]] = {}
    img, pitch = _stack(wins, length, half)
    for lang in ("eng", "heb"):
        for text, yc in _safe(read, img, lang, 6):
            n = int((yc - STACK_GAP) // pitch)
            if 0 <= n < len(wins):
                words.setdefault(n, []).append(str(text))
    out, claimed, rivals = _assign(_matches(words, wins, tokens), wins, {}, set())
    # pass 2: single-word reads of the unread candidates' most on-axis windows
    unread = [i for i in range(len(centers)) if i not in out and i not in rivals]
    calls = 0
    more: dict[int, list[str]] = {}
    for i in unread:
        own = sorted((w.lateral, n) for n, w in enumerate(wins) if w.item == i and len(set(w.seg_idx.tolist()) & claimed) == 0)
        for _lat, n in own[:SINGLE_WINDOWS]:
            if calls + 2 > MAX_SINGLE_CALLS:
                break
            one, _ = _stack([wins[n]], length, half)
            for lang in ("eng", "heb"):
                calls += 1
                more.setdefault(n, []).extend(str(t) for t, _ in _safe(read, one, lang, 8))
    if more:
        out, claimed, rivals2 = _assign(_matches(more, wins, tokens), wins, out, claimed)
        rivals |= rivals2
    for i in rivals:
        out.pop(i, None)
    return out


OcrFn = Callable[[Image.Image, str, int], list[tuple[str, float]]]
STACK_GAP = 45
SINGLE_WINDOWS = 3  # pass 2: windows per unread candidate (smallest lateral offset of the ink first)
MAX_SINGLE_CALLS = 24  # pass 2: Tesseract calls per sheet (≈ 0.2–0.3 s each)


def _safe(read: OcrFn, img: Image.Image, lang: str, psm: int) -> list[tuple[str, float]]:
    try:
        return list(read(img, lang, psm))
    except Exception:  # Tesseract missing / crashed: no readings (best effort)
        log.warning("qualifier OCR (%s) failed", lang, exc_info=True)
        return []


def _matches(
    words: dict[int, list[str]], wins: list[Window], tokens: list[list[tuple[str, ...]]]
) -> list[tuple[float, float, int, int, str, str]]:
    """(-similarity, lateral, window, entry, word, token) for every member a window's words name."""
    cands: list[tuple[float, float, int, int, str, str]] = []
    for n, ws in words.items():
        w = wins[n]
        for ei, toks in enumerate(tokens[w.item]):
            best, best_word, best_tok = 0.0, "", ""
            for word in ws:
                for tok in toks:
                    if bool(_LATIN.search(tok)) != bool(_LATIN.search(word)):
                        continue
                    sim = similarity(word, tok)
                    if sim > best:
                        best, best_word, best_tok = sim, word, tok
            if best >= MIN_SIM:
                cands.append((-best, w.lateral, n, ei, best_word, best_tok))
    cands.sort()
    return cands


def _assign(
    cands: list[tuple[float, float, int, int, str, str]],
    wins: list[Window],
    out: dict[int, Reading],
    claimed: set[int],
) -> tuple[dict[int, Reading], set[int], set[int]]:
    """Greedy: best similarity first; one reading per candidate; a word's strokes name one candidate only; a
    candidate whose window(s) name two members equally well gets no reading (``rivals``)."""
    out = dict(out)
    claimed = set(claimed)
    rivals: set[int] = set()
    for neg, _lat, n, ei, word, tok in cands:
        w = wins[n]
        segset = set(w.seg_idx.tolist())
        if w.item in out:
            if out[w.item].entry != ei and -neg >= out[w.item].similarity - 1e-9:
                rivals.add(w.item)
            continue
        if len(segset & claimed) > 0.5 * len(segset):
            continue  # this word already names a neighbour
        out[w.item] = Reading(w.item, ei, -neg, word, w.direction, tok)
        claimed |= segset
    return out, claimed, rivals


def _tesseract_words(img: Image.Image, lang: str, psm: int) -> list[tuple[str, float]]:
    from ..ocr.tess import ocr_words

    return [(w.text, (w.y0 + w.y1) / 2) for w in ocr_words(img, lang, psm)]
