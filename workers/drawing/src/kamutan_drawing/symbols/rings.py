"""Circled-glyph symbols (Sprint 10, Worker-Accuracy): a ring with a letter inside decides the item by the letter.

This designer's electrical legend draws several items as the same circle with a different letter: ``M`` (shutter
motor feed), ``T`` (thermostat), ``V`` (ventilator), ``ג`` (alarm detector), ``צ`` (siren), ``פ`` (bell). The letter
is drawn in two ways — as SHX strokes (tiny paths inside the ring) or as a font text object (a text span in
``text.json``, no path at all); the legend rows use strokes, the plan uses either, and the legend parser drops a
stroke letter that the SHX reader folded into the label ("ת תרמוסטט"), so a template built from the legend row may
be the bare ring. Matching such templates against each other is hopeless (the ring dominates), so:

1. every template whose drawing is one full ring (plus ≤ 60 % of its ink inside it) becomes a *ring family*
   member: the template keeps the **ring only**, members of the same radius share one template (``Template.ring``);
2. per member the *inner reference* is read straight from the sheet's strokes inside the legend ring (whatever the
   parser kept), normalised by the radius;
3. on the plan a ring candidate takes the member whose inner reference its own inner strokes fit best
   (:func:`resolve_member`), else the member whose letter literal is the text span inside the ring (font text; the
   literals come from the legend's own inner span when it has one, else from the class table below and the
   label's initial); a ring with nothing inside, or with an inner glyph that fits no member clearly, is not an
   item of the family (``None``) — or, when something *is* inside, an ``unknown`` the reviewer sees.
"""

from __future__ import annotations

import math
import re
from collections.abc import Sequence
from dataclasses import dataclass, field

import numpy as np
from scipy.spatial import cKDTree

from ..ingest.pdf_vector import VectorSheet
from ..legend.classes import norm_label
from ..legend.parse import LegendEntry
from ..ocr.dictionary import TextSpan
from .geometry import resample, seg_lengths
from .template import Anchor, Template

MIN_RING_R = 1.2  # mm; smaller circles are dots / conduit ends
RING_BAND = (0.82, 1.2)  # radius band (× r) of the ring's own strokes
INNER_R = 0.8  # strokes with their midpoint inside this radius (× r) are the glyph
MAX_INNER_SHARE = 0.6  # a drawing with more ink inside than this is not "a ring with a letter"
STEP = 0.1
# inner-glyph fit: mean chamfer / r of the plan glyph against a member's reference glyph, and how clearly the best
# member must beat the runner-up
FIT_MAX = 0.22
FIT_RATIO = 0.75
TEXT_REACH = 0.7  # a text span whose centre lies within this × r of the ring centre is the inner letter

# letter literals of the font-text channel, per class (this designer: M motor, T thermostat, V vent; Hebrew initials).
# "ר" for the alarm detector: the ground-floor sheets' Hebrew font maps the drawn "ג" to U+05E8 in the text layer.
CLASS_LETTERS: dict[str, frozenset[str]] = {
    "shutter_feed": frozenset({"M"}),
    "thermostat": frozenset({"T", "ת"}),
    "ventilator_feed": frozenset({"V"}),
    "alarm_detector": frozenset({"ג", "ר"}),
    "siren": frozenset({"צ"}),
    "doorbell": frozenset({"פ", "P", "B"}),
    "intercom": frozenset({"א", "I"}),
    "speaker": frozenset({"S"}),
    "heater_feed": frozenset({"H"}),
}
_WORD = re.compile(r"[A-Za-zא-ת]+")
_NOT_LETTERS = ("O", "o", "l", "I")  # what the SHX reader gives for the ring itself / a stem


@dataclass
class RingMember:
    entry: LegendEntry
    inner: np.ndarray  # (k,2) reference glyph points, ring frame (centre 0, radius 1); empty = none kept
    letters: frozenset[str]
    tree: cKDTree | None = None


@dataclass
class RingInfo:
    r: float  # legend ring radius (mm)
    members: list[RingMember] = field(default_factory=list)


def ring_geometry(t: Template) -> tuple[np.ndarray, float] | None:
    """(centre in the template frame, radius) when the template's anchor is one full ring that spans the drawing."""
    an = t.anchor
    if an.kind != "arc" or an.coverage < 320 or an.r < MIN_RING_R:
        return None
    if max(t.w, t.h) > 2 * an.r * 1.15 + 0.2:
        return None  # the ring is only a part of the drawing (a ceiling point with a cross through it)
    return np.asarray(an.center, dtype=np.float64), float(an.r)


def _inner_share(t: Template, c: np.ndarray, r: float) -> float:
    d = np.hypot(t.pts[:, 0] - c[0], t.pts[:, 1] - c[1])
    return float((d < INNER_R * r).mean()) if len(d) else 0.0


def inner_strokes(vs: VectorSheet, cx: float, cy: float, r: float) -> np.ndarray:
    """Segments of the sheet with their midpoint inside ``INNER_R × r`` of the ring centre, shorter than the ring."""
    s = vs.segs.astype(np.float64)
    if len(s) == 0:
        return np.zeros((0, 4))
    mx, my = (s[:, 0] + s[:, 2]) / 2, (s[:, 1] + s[:, 3]) / 2
    idx = np.where((np.abs(mx - cx) <= r) & (np.abs(my - cy) <= r))[0]
    if len(idx) == 0:
        return np.zeros((0, 4))
    d = np.hypot(mx[idx] - cx, my[idx] - cy)
    keep = (d < INNER_R * r) & (seg_lengths(s[idx]) <= 1.6 * r)
    return s[idx[keep]]


def _norm_points(segs: np.ndarray, cx: float, cy: float, r: float) -> np.ndarray:
    if len(segs) == 0:
        return np.zeros((0, 2))
    pts, _ = resample(segs, STEP * r)
    return (pts - np.array([cx, cy])) / r


def _letters_of(entry: LegendEntry, legend_inner_spans: Sequence[TextSpan]) -> frozenset[str]:
    out: set[str] = set()
    for sp in legend_inner_spans:
        w = _WORD.findall(sp.text)
        if len(w) == 1 and 1 <= len(w[0]) <= 2 and w[0] not in _NOT_LETTERS:
            out.add(w[0].upper() if w[0].isascii() else w[0])
    out |= set(CLASS_LETTERS.get(entry.suggested_class or "", ()))
    if not out:  # a Hebrew label's initial ("גלאי …" → ג)
        words = [w for w in norm_label(entry.label).split() if re.match(r"[א-ת]", w)]
        if words:
            out.add(words[0][0])
    return frozenset(out)


def _spans_inside(spans: Sequence[TextSpan], cx: float, cy: float, r: float, reach: float = TEXT_REACH) -> list[TextSpan]:
    out = []
    for sp in spans:
        sx, sy = (sp.bbox[0] + sp.bbox[2]) / 2, (sp.bbox[1] + sp.bbox[3]) / 2
        if math.hypot(sx - cx, sy - cy) <= reach * r and (sp.bbox[2] - sp.bbox[0]) <= 2.2 * r:
            out.append(sp)
    return out


def _ring_only(t: Template, c: np.ndarray, r: float) -> Template:
    """A copy of ``t`` holding only the strokes in the ring's radius band, centred on the ring."""
    d = np.hypot(t.pts[:, 0] - c[0], t.pts[:, 1] - c[1])
    band = (d >= RING_BAND[0] * r) & (d <= RING_BAND[1] * r)
    pts = t.pts[band] - c if band.any() else t.pts - c
    mid = np.hypot((t.segs[:, 0] + t.segs[:, 2]) / 2 - c[0], (t.segs[:, 1] + t.segs[:, 3]) / 2 - c[1])
    sb = (mid >= RING_BAND[0] * r) & (mid <= RING_BAND[1] * r)
    segs = (t.segs[sb] if sb.any() else t.segs) - np.concatenate([c, c])
    fam = Template(
        id=t.id,
        entries=[],
        segs=segs,
        pts=pts,
        w=2 * r,
        h=2 * r,
        anchor=Anchor("arc", np.zeros(2), r=r, coverage=t.anchor.coverage, mid=np.asarray(t.anchor.mid)),
        curved_share=1.0,
        complexity=t.complexity,
        symmetric=True,
        fill_area=0.0,
    )
    fam.tree = cKDTree(fam.pts)
    fam.ring = RingInfo(r)
    return fam


def merge_ring_families(templates: list[Template], vs: VectorSheet, spans: Sequence[TextSpan]) -> list[Template]:
    """Replace circled-glyph templates by ring families (ring-only template, members with inner references).
    One circled symbol alone keeps its own (letter-bearing) template."""
    rings: list[tuple[Template, np.ndarray, float]] = []
    rest: list[Template] = []
    for t in templates:
        g = ring_geometry(t)
        if g is None or len(t.entries) != 1 or _inner_share(t, g[0], g[1]) > MAX_INNER_SHARE:
            rest.append(t)
            continue
        rings.append((t, g[0], g[1]))
    if len(rings) < 2:
        return templates
    fams: list[Template] = []
    for t, c, r in rings:
        e = t.entries[0]
        # the legend ring's absolute centre = the entry's bbox centre (template origin) + the anchor offset
        sb = e.symbol_bbox
        acx, acy = (sb[0] + sb[2]) / 2 + float(c[0]), (sb[1] + sb[3]) / 2 + float(c[1])
        inner = _norm_points(inner_strokes(vs, acx, acy, r), acx, acy, r)
        member = RingMember(e, inner, _letters_of(e, _spans_inside(spans, acx, acy, r)), cKDTree(inner) if len(inner) else None)
        fam = next((f for f in fams if abs(f.ring.r - r) <= 0.12 * max(f.ring.r, r)), None)
        if fam is None:
            fam = _ring_only(t, c, r)
            fams.append(fam)
        fam.entries.append(e)
        fam.ring.members.append(member)
    return rest + fams


def _inner_text(spans: Sequence[TextSpan], cx: float, cy: float, r: float) -> str | None:
    words: list[str] = []
    for sp in _spans_inside(spans, cx, cy, r):
        for w in _WORD.findall(sp.text):
            if 1 <= len(w) <= 2 and w not in _NOT_LETTERS:
                words.append(w)
    return words[0] if len(words) == 1 else None


def resolve_member(
    t: Template, center: tuple[float, float], scale: float, vs: VectorSheet, spans: Sequence[TextSpan]
) -> tuple[LegendEntry | None, bool, str | None]:
    """(member entry, ambiguous, what was read) for a ring candidate. ``(None, False, None)`` = nothing inside (not
    an item); ``(None, True, word)`` = a glyph is inside but fits no member clearly."""
    info: RingInfo = t.ring
    r = info.r * scale
    cx, cy = center
    segs = inner_strokes(vs, cx, cy, r)
    if len(segs):
        q = _norm_points(segs, cx, cy, r)
        fits: list[tuple[float, RingMember]] = []
        qt = cKDTree(q) if len(q) else None
        for m in info.members:
            if m.tree is None or qt is None:
                continue
            d_fwd = float(np.minimum(m.tree.query(q)[0], 0.6).mean())
            d_rev = float(np.minimum(qt.query(m.inner)[0], 0.6).mean())
            fits.append(((d_fwd + d_rev) / 2, m))
        fits.sort(key=lambda f: f[0])
        if fits and fits[0][0] <= FIT_MAX and (len(fits) == 1 or fits[0][0] <= FIT_RATIO * fits[1][0]):
            return fits[0][1].entry, False, None
        word = _inner_text(spans, cx, cy, r)
        if word is None:
            return None, True, None
    else:
        word = _inner_text(spans, cx, cy, r)
        if word is None:
            return None, False, None
    hits = [m for m in info.members if word in m.letters or word.upper() in m.letters]
    if len(hits) == 1:
        return hits[0].entry, False, word
    return None, True, word


__all__ = ["CLASS_LETTERS", "RingInfo", "RingMember", "inner_strokes", "merge_ring_families", "resolve_member", "ring_geometry"]
