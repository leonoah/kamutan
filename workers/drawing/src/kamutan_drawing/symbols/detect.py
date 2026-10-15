"""Detections of one sheet: legend-conditioned vector spotting + type tags + text anchors.

Pipeline (all paper mm):

1. templates from the legend entries (:mod:`.template`); entries without a countable class
   ("ראה הערה", "אביזר מוגן מים", conduits) become *markers* — found the same way, but they only
   annotate the nearest item ("מוגן מים");
2. spotting (:mod:`.match`) with family disambiguation by the symbol's own text (BEZEK / TV /
   TEL / רשת next to the bracket);
3. annotations from nearby text: ``2X`` / ``3X`` (→ class socket_double / socket_triple), ``H=30``,
   ``IP44``; a nearby label naming a more specific class of the same family ("שקע תלת פאזי"
   next to a power socket) refines the class;
4. fixture-type tags (:mod:`.tags`) set the luminaire type of the nearest lighting symbol, or
   become detections of their own;
5. text-anchored items on plumbing sheets (no legend): "מרכז ניאגרה", "ברז קיר"…;
6. unknown clusters: repeated symbol-like stroke groups no template explains;
7. score + level + Hebrew reason chips (see :func:`score_detection`).
"""

from __future__ import annotations

import math
import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from scipy.spatial import cKDTree

from ..ingest.pdf_vector import SEG_BEZIER, VectorSheet
from ..legend.classes import apply_multiplicity, multiplicity, suggest_class
from ..legend.parse import LegendEntry, LegendResult, clean_qualifier
from ..ocr.dictionary import TextSpan
from ..ocr.textutil import levenshtein, normalize
from .geometry import BBox, bbox_dict, groups_of, in_box, seg_lengths, segment_components, stroke_signature
from .marks import GlyphLibrary, build_library, qualifier_clouds, read_marks_near, read_qualifier
from .match import Candidate, Scene, build_scene, spot
from .tags import Tag, find_tags
from .template import Template, build_templates

# ---- reason chips (Hebrew, user facing)
R_WEAK = "התאמה חלשה לסמל במקרא"
R_SIMILAR = "דומה לסמל אחר"
R_NOT_IN_LEGEND = "סמל לא במקרא"
R_SCALE = 'קנ"מ לא ודאי'
R_RASTER = "רסטר"
R_LABEL = "תווית המקרא לא ודאית"
R_NO_CLASS = "סוג הפריט לא זוהה"
R_TAG_ONLY = "סוג לפי תג בלבד"
R_TEXT_ONLY = "זוהה מכיתוב בלבד"
R_OUTSIDE = "מחוץ לאזור השרטוט"
R_LOW = "ביטחון נמוך"
R_REFINED = "סוג עודכן לפי כיתוב סמוך"
R_ATTACH = "שיוך כיתוב לא ודאי"  # 2X / type tag / label could belong to ≥ 2 nearby symbols
R_OVERLAP = "פריטים חופפים"
R_TYPE_MISMATCH = "סוג בטבלה שונה מסמל הגוף"
R_MARK_UNREAD = "כיתוב ליד הסמל לא נקרא"
R_FLOOR = "קומה לא ודאית"
R_NOTE = "סוג לפי הערה ליד הסימון"

GREEN_MIN = 0.85
RED_BELOW = 0.5
WARNING_REASONS = {
    R_WEAK,
    R_SIMILAR,
    R_NOT_IN_LEGEND,
    R_SCALE,
    R_RASTER,
    R_LABEL,
    R_NO_CLASS,
    R_TAG_ONLY,
    R_TEXT_ONLY,
    R_OUTSIDE,
    R_LOW,
    R_ATTACH,
    R_OVERLAP,
    R_TYPE_MISMATCH,
    R_MARK_UNREAD,
    R_FLOOR,
    R_NOTE,
}
OVERLAP_MM = 4.0
# stroke-wise reading of the symbol's own text (BEZEK / TV / TEL / רשת) — measured on the Noah GT it
# picked the wrong sub-type more often than the plain fallback (tv 1/4 vs 4/8), so it is off until the
# qualifier strokes are segmented better; the class stays yellow "דומה לסמל אחר" either way.
READ_QUALIFIER_STROKES = False
CONTEST_MM = 3.0  # a second symbol this much farther than the nearest still competes for a text


def _contested(gaps: list[float], slack: float = CONTEST_MM) -> bool:
    g = sorted(gaps)
    return len(g) >= 2 and g[1] <= g[0] + slack


LIGHTING_CLASSES = ("luminaire_", "ceiling_fan")
# a nearby label may make a detection more specific, never jump to another family
REFINES: dict[str, set[str]] = {
    "socket_power": {"socket_3phase", "socket_power_double", "heater_feed"},  # heater: "הזנה לדוד"
    "socket_single": {"socket_double", "socket_triple", "socket_prep"},  # a hollow glyph is never a power socket
    "socket_double": {"socket_triple"},
    "luminaire_ceiling": {"luminaire_pendant", "luminaire_strip", "luminaire_wall", "luminaire_outdoor", "ceiling_fan"},
    "switch_single": {"switch_2way", "switch_fan"},
}
TEXT_ANCHOR_CLASSES = {"fixture_wc_concealed", "fixture_wc_monoblock", "faucet_wall", "faucet_basin", "fixture_basin"}
H_RE = re.compile(r"H\s*=\s*(\d{2,3})", re.IGNORECASE)
IP_RE = re.compile(r"IP\s*(\d{2})", re.IGNORECASE)


@dataclass
class Detection:
    cls: str
    center: tuple[float, float]
    bbox: BBox
    angle: int = 0
    entry: LegendEntry | None = None
    quality: float = 0.0
    margin: float = 1.0
    score: float = 0.0
    level: str = "red"
    reasons: list[str] = field(default_factory=list)
    annotations: list[str] = field(default_factory=list)
    cluster_id: str | None = None
    room_id: str | None = None
    floor: str | None = None
    lifecycle: str = "unknown"
    supply: str | None = None
    source: str = "vector"  # vector | tag | text | raster | unknown
    type_entry: LegendEntry | None = None
    class_conf: float = 0.0
    in_region: bool = True
    id: str = ""
    signature: str | None = None  # stroke signature (Sprint 4: review clusters, re-match tie-break)

    def to_json(self, sheet_id: str) -> dict[str, Any]:
        e = self.type_entry or self.entry
        return {
            "id": self.id,
            "class": self.cls,
            "legendEntryId": e.entry_id(sheet_id) if e is not None else None,
            "centerMm": {"x": round(self.center[0], 2), "y": round(self.center[1], 2)},
            "bboxMm": bbox_dict(self.bbox),
            "angleDeg": int(self.angle) % 360,
            "score": round(float(self.score), 3),
            "level": self.level,
            "reasons": list(dict.fromkeys(self.reasons)),
            "roomId": self.room_id,
            "floor": self.floor,
            "lifecycle": self.lifecycle,
            "supply": self.supply,
            "annotations": list(dict.fromkeys(self.annotations)),
            "clusterId": self.cluster_id,
            "signature": _sig_or_none(self.signature or (self.entry.signature if self.entry is not None else None)),
        }


_SIG_RE = re.compile(r"^[A-Za-z0-9_-]{8,128}$")


def _sig_or_none(sig: str | None) -> str | None:
    return sig if sig and _SIG_RE.match(sig) else None


@dataclass
class UnknownCluster:
    id: str
    signature: str
    count: int
    exemplar: BBox
    members: list[BBox]

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "signature": self.signature,
            "count": self.count,
            "exemplarBboxMm": bbox_dict(self.exemplar),
            "thumb": f"unknown/{self.id}.webp",
        }


@dataclass
class DetectResult:
    detections: list[Detection] = field(default_factory=list)
    clusters: list[UnknownCluster] = field(default_factory=list)
    templates: int = 0
    scale: float = 1.0
    scale_estimated: bool = False
    stats: dict[str, Any] = field(default_factory=dict)
    legend: LegendResult | None = None  # raster sheets: the legend found in pixels


# ----------------------------------------------------------------------------------- text
class TextIndex:
    def __init__(self, spans: list[TextSpan]) -> None:
        self.spans = spans
        xy = np.array([[(s.bbox[0] + s.bbox[2]) / 2, (s.bbox[1] + s.bbox[3]) / 2] for s in spans]) if spans else np.zeros((0, 2))
        self.tree = cKDTree(xy) if len(xy) else None
        self.xy = xy

    def near(self, b: BBox, reach: float) -> list[tuple[int, float]]:
        """(span index, gap mm between the span box and ``b``) for spans within ``reach``."""
        if self.tree is None:
            return []
        cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        r = reach + 0.5 * math.hypot(b[2] - b[0], b[3] - b[1]) + 25.0
        out = []
        for i in self.tree.query_ball_point([cx, cy], r):
            s = self.spans[i].bbox
            dx = max(b[0] - s[2], 0.0, s[0] - b[2])
            dy = max(b[1] - s[3], 0.0, s[1] - b[3])
            g = math.hypot(dx, dy)
            if g <= reach:
                out.append((i, g))
        return sorted(out, key=lambda q: q[1])


def _tokens(text: str) -> list[str]:
    t = normalize(text)
    return [w for w in re.split(r"[\s,;]+", t) if w]


def annotation_tokens(text: str) -> list[str]:
    """Annotation tokens in a span: 2X/3X, H=…, IP…, TV/TEL/BEZEK."""
    out: list[str] = []
    for m in H_RE.finditer(text):
        out.append(f"H={m.group(1)}")
    for m in IP_RE.finditer(text):
        out.append(f"IP{m.group(1)}")
    for w in _tokens(text):
        q = clean_qualifier(w)
        if multiplicity(q) is not None and len(q) <= 3:
            out.append(q)
    return out


def _qualifier_near(q: str, texts: list[str]) -> bool:
    qn = q.replace(" ", "")
    for t in texts:
        c = clean_qualifier(t)
        if not c:
            continue
        if qn in c or (
            len(qn) >= 3 and any(levenshtein(c[i : i + len(qn)], qn) <= 1 for i in range(max(1, len(c) - len(qn) + 1)))
        ):
            return True
    return False


# --------------------------------------------------------------------------------- scoring
def score_detection(d: Detection, *, raster: bool, scale_uncertain: bool, confirmed: bool) -> None:
    """Heuristic score (calibration comes in Sprint 5 — conservative on purpose).

    score = geometric quality × margin factor × class confidence factor × scale/region factors.
    """
    reasons = list(d.reasons)
    q = d.quality
    m_f = min(1.0, max(0.0, d.margin / 0.25))
    c = 0.95 if confirmed else d.class_conf
    c_f = 0.7 + 0.3 * min(1.0, c / 0.8)
    s = q * (0.8 + 0.2 * m_f) * c_f
    if d.source == "vector":
        if q < 0.72:
            reasons.append(R_WEAK)
        if d.margin < 0.12:
            reasons.append(R_SIMILAR)
    if d.cls == "unknown" and d.source != "unknown":
        reasons.append(R_NO_CLASS)
    elif not confirmed and c < 0.6 and d.source in ("vector", "tag", "raster"):
        reasons.append(R_LABEL)
    if scale_uncertain:
        s *= 0.9
        reasons.append(R_SCALE)
    if not d.in_region:
        s *= 0.85
        reasons.append(R_OUTSIDE)
    if raster:
        reasons.append(R_RASTER)
    s = max(0.0, min(1.0, s))
    warn = any(r in WARNING_REASONS for r in reasons)
    # green = strong template fit AND a clear margin over the runner-up AND a specific, well-read class
    # AND no warning (ambiguous text attachment, overlap, uncertain floor…)
    strong = d.source == "vector" and q >= 0.86 and d.margin >= 0.3 and c >= 0.7
    level = "red" if s < RED_BELOW else ("green" if (s >= GREEN_MIN or strong) and not warn else "yellow")
    if raster and level == "green":
        level = "yellow"
    if level != "green" and not reasons:
        reasons.append(R_LOW)
    d.score, d.level, d.reasons = s, level, list(dict.fromkeys(reasons))


# ------------------------------------------------------------------------------- assembly
def _family_member(t: Template, near_texts: list[str]) -> tuple[LegendEntry | None, bool]:
    """Pick the legend entry of a look-alike family from the text near a detection (``near_texts``
    sorted by distance). Returns (entry, ambiguous)."""
    named = [e for e in t.entries if e.qualifier and e.qualifier != "?" and e.multiplicity is None]
    plain = [e for e in t.entries if not (e.qualifier and e.qualifier != "?" and e.multiplicity is None)]
    for txt in near_texts:  # nearest text first: "רשת TV TEL" stacked next to three brackets
        for e in named:
            if _qualifier_near(e.qualifier, [txt]):
                return e, False
    if plain:
        base = [e for e in plain if e.multiplicity is None] or plain
        # look-alikes told apart only by text that was not found here: the plain member is a guess
        return base[0], bool(named)
    return (named[0] if named else None), True


def _is_note(t: Template) -> bool:
    """ "ראה הערה" (see note): the item is named by the note written next to the mark."""
    return any("הערה" in e.label for e in t.entries)


def _is_marker(t: Template) -> bool:
    return all(e.suggested_class is None for e in t.entries)


def _colour_mask(vs: VectorSheet, templates: list[Template]) -> np.ndarray | None:
    """Scene strokes drawn in a colour of some legend symbol (furniture is grey, symbols black)."""
    if not templates or vs.n_segs == 0:
        return None
    paths = np.unique(np.concatenate([vs.seg_path[e.seg_idx] for t in templates for e in t.entries]))
    cols = {tuple(int(v) for v in vs.path_stroke_rgba[p, :3]) for p in paths}
    cols |= {tuple(int(v) for v in vs.path_fill_rgba[p, :3]) for p in paths if vs.path_fill_mode[p] > 0}
    rgb = vs.path_stroke_rgba[vs.seg_path, :3].astype(np.int32)
    keep = np.zeros(vs.n_segs, bool)
    for c in cols:
        keep |= np.abs(rgb - np.array(c)).sum(axis=1) <= 90
    return keep


def _region_of(pt: tuple[float, float], regions: list[dict[str, Any]]) -> dict[str, Any] | None:
    from shapely.geometry import Point, Polygon

    p = Point(pt)
    for r in regions:
        poly = [(float(q["x"]), float(q["y"])) for q in r.get("polygonMm", [])]
        if len(poly) >= 3 and Polygon(poly).buffer(0.5).contains(p):
            return r
    return None


def detect_symbols(
    vs: VectorSheet,
    spans: list[TextSpan],
    legend: LegendResult,
    *,
    title_block: BBox | None = None,
    discipline: str | None = None,
    regions: list[dict[str, Any]] | None = None,
    scale_den: int | None = None,
    mappings: dict[str, dict[str, Any]] | None = None,
    text_paths: set[int] | None = None,
    unknown: bool = True,
) -> DetectResult:
    res = DetectResult()
    regions = regions or []
    mappings = mappings or {}
    exclude = legend.exclusion_boxes() + ([title_block] if title_block else [])
    plan_spans = [
        sp
        for sp in spans
        if not any(
            b[0] <= (sp.bbox[0] + sp.bbox[2]) / 2 <= b[2] and b[1] <= (sp.bbox[1] + sp.bbox[3]) / 2 <= b[3] for b in exclude
        )
    ]
    tix = TextIndex(plan_spans)
    entries = legend.entries
    sym_entries = [e for e in entries if e.kind == "symbol"]
    templates = build_templates(sym_entries, vs)
    # simple classless drawings ("+" = see note) are neither items nor useful markers
    templates = [t for t in templates if not (_is_marker(t) and t.complexity < 0.6 and not _is_note(t))]
    res.templates = len(templates)
    scene: Scene = build_scene(vs, exclude, keep_mask=_colour_mask(vs, templates))
    sp = spot(templates, scene) if templates else None
    cands: list[Candidate] = sp.detections if sp else []
    if sp is not None:
        res.scale, res.scale_estimated = sp.scale, sp.scale_estimated
    scale_uncertain = res.scale_estimated or scale_den is None

    dets: list[Detection] = []
    markers: list[tuple[Candidate, LegendEntry]] = []
    qual_clouds: dict[str, Any] = {}
    for c in cands:
        t = c.tpl
        min_q = 0.6 if t.complexity >= 0.7 else 0.74
        if c.quality < min_q:
            continue
        b = c.bbox()
        near = [tix.spans[i].text for i, _ in tix.near(b, max(3.0, 0.9 * t.size))]
        entry, ambiguous = _family_member(t, near)
        by_strokes = False
        if READ_QUALIFIER_STROKES and ambiguous and len(t.entries) > 1:
            # the text reader found nothing usable: compare the strokes written next to the symbol with
            # the legend's qualifier strokes (vertical / 45° text included)
            qc = qual_clouds.setdefault(t.id, qualifier_clouds(vs, t.entries))
            inner = (b[0] + 0.3, b[1] + 0.3, b[2] - 0.3, b[3] - 0.3)
            got, _ = read_qualifier(vs, qc, b, max(3.0, 1.0 * t.size), exclude=inner)
            if got is not None:
                entry, ambiguous, by_strokes = got, False, True
        if entry is None:
            continue
        needs_text = entry.qualifier and entry.qualifier != "?" and entry.multiplicity is None
        if t.complexity < 0.7 and (
            (ambiguous and c.quality < 0.85) or (needs_text and not by_strokes and not _qualifier_near(entry.qualifier, near))
        ):
            continue  # a bare bracket / cross is everywhere on a plan; trust it only with its text or an exact fit
        if _is_marker(t):
            markers.append((c, entry))
            continue
        m = mappings.get(entry.signature)
        cls = (m or {}).get("class") or entry.suggested_class or "unknown"
        d = Detection(
            cls=cls,
            center=c.center,
            bbox=b,
            angle=c.angle_deg,
            entry=entry,
            quality=c.quality,
            margin=c.quality - c.runner_up,
            source="vector",
            class_conf=0.95 if m else entry.class_conf,
        )
        if ambiguous or by_strokes:  # the class hangs on text next to the symbol that the reader could not confirm
            d.reasons.append(R_SIMILAR)
            d.margin = min(d.margin, 0.05)
        dets.append(d)

    # ---- fixture type tags
    tags: list[Tag] = []
    if any(e.kind == "type" for e in entries):
        tags = find_tags(vs, scene.arcs, entries, exclude)
        _apply_tags(dets, tags, mappings)

    # ---- "see note" marks named by the text next to them; panels named by their label
    dets.extend(_note_items(markers, tix, dets))
    dets.extend(_panels_from_labels(vs, exclude, tix, dets))

    # ---- text-anchored items (plumbing: no symbol legend)
    if discipline == "plumbing" or (not sym_entries and discipline in ("plumbing", None)):
        dets.extend(_text_anchored(plan_spans, exclude, dets))

    # ---- annotations, markers, refinements (each text token goes to its nearest detection)
    _annotate(dets, tix, markers)
    _read_marks(vs, dets, build_library(vs, plan_spans, entries))

    # ---- unknown clusters
    if unknown and discipline in ("electrical", "lighting", "plumbing"):
        res.clusters, unk = _unknown_clusters(vs, scene, dets, exclude, text_paths or set(), tix)
        dets.extend(unk)

    # ---- two items within ~4 mm: one of them may be a duplicate reading
    real = [d for d in dets if d.source != "unknown"]
    for i, da in enumerate(real):
        for db in real[i + 1 :]:
            if math.dist(da.center, db.center) < OVERLAP_MM:
                da.reasons.append(R_OVERLAP)
                db.reasons.append(R_OVERLAP)

    # ---- regions, scoring, ids
    for d in dets:
        r = _region_of(d.center, regions) if regions else None
        d.in_region = r is not None or not regions
        d.floor = (r or {}).get("floor") if r else None
        confirmed = bool(d.entry is not None and d.entry.signature in mappings)
        score_detection(d, raster=False, scale_uncertain=scale_uncertain and d.source == "vector", confirmed=confirmed)
    dets.sort(key=lambda d: (round(d.center[1] / 20), d.center[0]))
    for i, d in enumerate(dets):
        d.id = f"d_{i}"
    res.detections = dets
    res.stats = {"templates": len(templates), "candidates": len(cands), "tags": len(tags), "markers": len(markers)}
    return res


def _apply_tags(dets: list[Detection], tags: list[Tag], mappings: dict[str, dict[str, Any]]) -> None:
    """A tag names the type of the nearest lighting symbol (within reach); else it is the item."""
    light = [d for d in dets if d.cls.startswith(LIGHTING_CLASSES) or d.cls in ("unknown",)]
    used: set[int] = set()
    pairs = []
    for ti, t in enumerate(tags):
        for di, d in enumerate(light):
            dist = math.hypot(d.center[0] - t.cx, d.center[1] - t.cy)
            if dist <= 4.5 * t.r + 0.5 * math.hypot(d.bbox[2] - d.bbox[0], d.bbox[3] - d.bbox[1]):
                pairs.append((dist, ti, di))
    taken_d: set[int] = set()
    for _, ti, di in sorted(pairs):
        if ti in used or di in taken_d:
            continue
        used.add(ti)
        taken_d.add(di)
        d, t = light[di], tags[ti]
        m = mappings.get(t.entry.signature)
        tcls = (m or {}).get("class") or t.entry.suggested_class
        if _contested([q[0] for q in pairs if q[1] == ti]):
            d.reasons.append(R_ATTACH)
        # the table names the fixture of a generic light point (⊕ "נק' מאור"): that is its purpose. A
        # specific glyph (wall / pendant…) that the table calls something else is a conflict.
        if tcls and d.cls not in ("unknown", "luminaire_ceiling") and tcls != d.cls:
            d.reasons.append(R_TYPE_MISMATCH)
        if tcls:
            d.cls = tcls
            d.class_conf = 0.95 if m else max(d.class_conf, t.entry.class_conf)
        d.type_entry = t.entry
        d.annotations.append(f"סוג {t.entry.type_no}")
    for ti, t in enumerate(tags):
        if ti in used:
            continue
        m = mappings.get(t.entry.signature)
        dets.append(
            Detection(
                cls=(m or {}).get("class") or t.entry.suggested_class or "unknown",
                center=(t.cx, t.cy),
                bbox=t.bbox,
                entry=None,
                type_entry=t.entry,
                quality=0.75,
                margin=0.3,
                source="tag",
                class_conf=0.95 if m else t.entry.class_conf,
                annotations=[f"סוג {t.entry.type_no}"],
                reasons=[R_TAG_ONLY],
            )
        )


NOTE_REACH_MM = 10.0


def _note_items(markers: list[tuple[Candidate, LegendEntry]], tix: TextIndex, dets: list[Detection]) -> list[Detection]:
    """A "see note" cross becomes an item only when a nearby note names a class (פעמון, אינטרקום…);
    each note names one cross (nearest first). A bare cross is everywhere on a plan, so the fit must
    be exact and the note close."""
    crosses = [(c, e) for c, e in markers if "הערה" in e.label and c.quality >= 0.85]
    crosses = [(c, e) for c, e in crosses if not any(math.dist(c.center, d.center) < OVERLAP_MM for d in dets)]
    pairs: list[tuple[float, int, int, str, float]] = []
    for ci, (c, _) in enumerate(crosses):
        for i, gap in tix.near(c.bbox(), NOTE_REACH_MM):
            s = tix.spans[i]
            cls, conf = suggest_class(s.text, s.conf) if len(s.text) <= 40 else (None, 0.0)
            if cls and cls not in TEXT_ANCHOR_CLASSES and cls != "panel":
                pairs.append((gap, ci, i, cls, conf))
    out: list[Detection] = []
    used_c: set[int] = set()
    used_s: set[int] = set()
    for gap, ci, si, cls, conf in sorted(pairs):
        if ci in used_c or si in used_s:
            continue
        used_c.add(ci)
        used_s.add(si)
        c, e = crosses[ci]
        reasons = [R_NOTE] + ([R_ATTACH] if _contested([p[0] for p in pairs if p[2] == si]) else [])
        out.append(
            Detection(
                cls=cls, center=c.center, bbox=c.bbox(), angle=c.angle_deg, entry=e, quality=c.quality,
                margin=0.3, source="note", class_conf=min(conf, 0.7), reasons=reasons,
            )
        )  # fmt: skip
    return out


def _panels_from_labels(vs: VectorSheet, exclude: list[BBox], tix: TextIndex, dets: list[Detection]) -> list[Detection]:
    """Panels ("לוח חשמל", "לוח תקשורת"): a rectangle crossed by both diagonals (the hatch of a panel)
    within reach of the label. The legend often shows the home-run arrow, not the panel itself."""
    labels = [s for s in tix.spans if suggest_class(s.text, s.conf)[0] == "panel" and len(s.text) <= 40]
    if not labels or vs.n_segs == 0:
        return []
    s = vs.segs.astype(np.float64)
    keep = np.ones(len(s), bool)
    mx, my = (s[:, 0] + s[:, 2]) / 2, (s[:, 1] + s[:, 3]) / 2
    for b in exclude:
        keep &= ~in_box(mx, my, b)
    s = s[keep]
    lens = seg_lengths(s)
    dx, dy = s[:, 2] - s[:, 0], s[:, 3] - s[:, 1]
    diag = (lens >= 2.0) & (lens <= 25.0) & (np.abs(dx) > 0.15 * lens) & (np.abs(dy) > 0.15 * lens)
    idx = np.where(diag)[0]
    mids = np.column_stack([(s[idx, 0] + s[idx, 2]) / 2, (s[idx, 1] + s[idx, 3]) / 2]) if len(idx) else np.zeros((0, 2))
    out: list[Detection] = []
    used: set[int] = set()
    for i in range(len(idx)):
        if int(idx[i]) in used:
            continue
        a = s[idx[i]]
        # its crossing partner: same midpoint, the other diagonal direction
        for j in range(i + 1, len(idx)):
            bseg = s[idx[j]]
            if np.hypot(*(mids[i] - mids[j])) > 0.3 or np.sign(dx[idx[i]] * dy[idx[i]]) == np.sign(dx[idx[j]] * dy[idx[j]]):
                continue
            if abs(lens[idx[i]] - lens[idx[j]]) > 0.1 * lens[idx[i]]:
                continue
            box = (
                float(min(a[0], a[2], bseg[0], bseg[2])), float(min(a[1], a[3], bseg[1], bseg[3])),
                float(max(a[0], a[2], bseg[0], bseg[2])), float(max(a[1], a[3], bseg[1], bseg[3])),
            )  # fmt: skip
            w, h = box[2] - box[0], box[3] - box[1]
            if not (1.0 <= min(w, h) and max(w, h) <= 20.0):
                continue
            # the rectangle around the diagonals: sides on its edges
            edge = ((np.abs(s[:, 1] - s[:, 3]) < 0.05) | (np.abs(s[:, 0] - s[:, 2]) < 0.05)) & (lens >= 0.8 * min(w, h))
            on = (
                edge
                & (
                    (np.abs(s[:, 0] - box[0]) < 0.3)
                    | (np.abs(s[:, 0] - box[2]) < 0.3)
                    | (np.abs(s[:, 1] - box[1]) < 0.3)
                    | (np.abs(s[:, 1] - box[3]) < 0.3)
                )
                & (np.minimum(s[:, 0], s[:, 2]) >= box[0] - 0.3)
                & (np.maximum(s[:, 0], s[:, 2]) <= box[2] + 0.3)
                & (np.minimum(s[:, 1], s[:, 3]) >= box[1] - 0.3)
                & (np.maximum(s[:, 1], s[:, 3]) <= box[3] + 0.3)
            )
            if on.sum() < 3:
                continue
            c = ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
            near_label = min(
                math.hypot(max(sp.bbox[0] - c[0], 0.0, c[0] - sp.bbox[2]), max(sp.bbox[1] - c[1], 0.0, c[1] - sp.bbox[3]))
                for sp in labels
            )
            if near_label > 20.0 or any(math.dist(c, d.center) < OVERLAP_MM for d in dets + out):
                continue
            used.update((int(idx[i]), int(idx[j])))
            out.append(
                Detection(
                    cls="panel", center=c, bbox=box, quality=0.7, margin=0.3, source="text", class_conf=0.6,
                    reasons=[R_TEXT_ONLY],
                )
            )  # fmt: skip
            break
    return out


def _text_anchored(spans: list[TextSpan], exclude: list[BBox], dets: list[Detection]) -> list[Detection]:
    out: list[Detection] = []
    for s in spans:
        cx, cy = (s.bbox[0] + s.bbox[2]) / 2, (s.bbox[1] + s.bbox[3]) / 2
        if any(b[0] <= cx <= b[2] and b[1] <= cy <= b[3] for b in exclude):
            continue
        cls, conf = suggest_class(s.text, s.conf)
        if cls not in TEXT_ANCHOR_CLASSES:
            continue
        out.append(
            Detection(
                cls=cls,
                center=(cx, cy),
                bbox=s.bbox,
                quality=0.7,
                margin=0.3,
                source="text",
                class_conf=conf,
                reasons=[R_TEXT_ONLY],
                annotations=annotation_tokens(s.text),
            )
        )
    # "מרכז ניאגרה" + "מונובלוק" on the next line is one monoblock WC
    mono = [d for d in out if d.cls == "fixture_wc_monoblock"]
    return [d for d in out if not (d.cls == "fixture_wc_concealed" and any(math.dist(d.center, m.center) < 8.0 for m in mono))]


def _annotate(dets: list[Detection], tix: TextIndex, markers: list[tuple[Candidate, LegendEntry]]) -> None:
    if not dets:
        return
    centers = np.array([d.center for d in dets])
    tree = cKDTree(centers)
    claimed: dict[int, list[tuple[int, float]]] = defaultdict(list)
    for si, s in enumerate(tix.spans):
        toks = annotation_tokens(s.text)
        cls_txt, _ = suggest_class(s.text, s.conf) if len(s.text) <= 40 else (None, 0.0)
        if not toks and not cls_txt:
            continue
        cx, cy = tix.xy[si]
        for di in tree.query_ball_point([cx, cy], 25.0):
            d = dets[di]
            b = d.bbox
            dx = max(b[0] - s.bbox[2], 0.0, s.bbox[0] - b[2])
            dy = max(b[1] - s.bbox[3], 0.0, s.bbox[1] - b[3])
            g = math.hypot(dx, dy)
            claimed[si].append((di, g))
    for si, lst in claimed.items():
        if not lst:
            continue
        s = tix.spans[si]
        cls_txt, _ = suggest_class(s.text, s.conf) if len(s.text) <= 40 else (None, 0.0)
        if cls_txt:
            ok = [
                (di, g)
                for di, g in lst
                if dets[di].source != "text" and cls_txt in REFINES.get(dets[di].cls, set()) and g <= 12.0
            ]
            if ok:
                di, g = min(ok, key=lambda q: q[1])
                d = dets[di]
                if not any(r == R_REFINED for r in d.reasons):
                    d.cls = cls_txt
                    d.reasons.append(R_REFINED)
                if _contested([q[1] for q in ok]):
                    for dj, gj in ok:
                        if gj <= g + CONTEST_MM:
                            dets[dj].reasons.append(R_ATTACH)
        di, g = min(lst, key=lambda q: q[1])
        d = dets[di]
        if d.source == "text":
            continue
        size = max(d.bbox[2] - d.bbox[0], d.bbox[3] - d.bbox[1])
        toks = annotation_tokens(s.text)
        if toks and g <= max(3.5, 1.2 * size):
            for tk in toks:
                if multiplicity(tk) is not None and g > max(2.5, 0.8 * size):
                    continue
                d.annotations.append(tk)
                n = multiplicity(tk)
                if n is not None:
                    new = apply_multiplicity(d.cls, n)
                    if new != d.cls:
                        d.cls = new
                    if _contested([gg for dj, gg in lst if dets[dj].cls in MARK_CLASSES or dj == di]):
                        d.reasons.append(R_ATTACH)
    for c, e in markers:
        if not dets:
            break
        if "הערה" in e.label:
            continue
        dist, di = tree.query(c.center)
        if dist <= max(8.0, 2 * c.tpl.size):
            label = e.label
            if "מוגן" in label:
                label = "מוגן מים"
            dets[int(di)].annotations.append(label)


MARK_CLASSES = ("socket_single", "socket_double", "socket_triple", "socket_power", "socket_power_double")


def _read_marks(vs: VectorSheet, dets: list[Detection], lib: GlyphLibrary) -> None:
    """2X / 3X next to sockets, read from strokes when the text reader did not give them; every
    word goes to its nearest socket."""
    words: dict[tuple[int, int], tuple[int, float, tuple[float, float]]] = {}
    unread: list[tuple[float, float]] = []
    for d in dets:
        if d.cls not in MARK_CLASSES or d.source != "vector":
            continue
        b = d.bbox
        size = max(b[2] - b[0], b[3] - b[1])
        inner = (b[0] + 0.3, b[1] + 0.3, b[2] - 0.3, b[3] - 0.3)
        for n, dist, c in read_marks_near(vs, lib, b, max(3.0, 1.1 * size), exclude=inner):
            if n == 0:  # an X-like word whose digit could not be read
                unread.append(c)
                continue
            key = (round(c[0] * 4), round(c[1] * 4))
            if key not in words or dist < words[key][1]:
                words[key] = (n, dist, c)
    socks = [d for d in dets if d.cls in MARK_CLASSES and d.source == "vector"]
    # every socket-like symbol competes for a word, also one already refined by a label (3-phase)
    rivals = [d for d in dets if d.source == "vector" and d.cls.startswith(("socket", "heater"))]
    if not socks:
        return
    taken: set[int] = set()

    def gaps_to(c: tuple[float, float]) -> list[tuple[float, int]]:
        out = []
        for i, d in enumerate(socks):
            b = d.bbox
            out.append((math.hypot(max(b[0] - c[0], 0.0, c[0] - b[2]), max(b[1] - c[1], 0.0, c[1] - b[3])), i))
        return sorted(out)

    for n, _, c in sorted(words.values(), key=lambda w: w[1]):
        gaps = gaps_to(c)
        _, i = gaps[0]
        d = socks[i]
        if i in taken or any(multiplicity(a) is not None for a in d.annotations):
            continue
        taken.add(i)
        d.annotations.append(f"{n}X")
        d.cls = apply_multiplicity(d.cls, n)
        rg = [
            math.hypot(max(r.bbox[0] - c[0], 0.0, c[0] - r.bbox[2]), max(r.bbox[1] - c[1], 0.0, c[1] - r.bbox[3])) for r in rivals
        ]
        if _contested(rg):
            d.reasons.append(R_ATTACH)
    # an X-like word next to a socket that could not be read: single / double / triple is open
    for c in unread:
        _, i = gaps_to(c)[0]
        if not any(multiplicity(a) is not None for a in socks[i].annotations):
            socks[i].reasons.append(R_MARK_UNREAD)


def _circle_with_contents(sg: np.ndarray, kinds: np.ndarray) -> bool:
    """The group is one circle, possibly with strokes strictly inside it (digits of a tag)."""
    from .arcs import arc_of_points
    from .geometry import resample

    cur = sg[kinds == SEG_BEZIER]
    if len(cur) < 4:
        return False
    pts, _ = resample(cur, 0.1)
    a = arc_of_points(pts)
    if a is None or a.coverage < 300:
        return False
    rest = sg[kinds != SEG_BEZIER]
    if len(rest) == 0:
        return True
    d0 = np.hypot(rest[:, 0] - a.cx, rest[:, 1] - a.cy)
    d1 = np.hypot(rest[:, 2] - a.cx, rest[:, 3] - a.cy)
    return bool((np.maximum(d0, d1) <= 1.02 * a.r).all())


def _line_terminator(g: Any, scene: Scene) -> bool:
    """A small group on the end of a line that runs away from it (conduit end circle, leader dot,
    arrow head): some other stroke ≥ 1 mm starts at the group's edge and ends well outside it."""
    b = g.bbox
    own = set(np.asarray(g.segs).tolist())
    s = scene.segs
    for xa, ya, xb, yb in ((s[:, 0], s[:, 1], s[:, 2], s[:, 3]), (s[:, 2], s[:, 3], s[:, 0], s[:, 1])):
        touch = (xa >= b[0] - 0.3) & (xa <= b[2] + 0.3) & (ya >= b[1] - 0.3) & (ya <= b[3] + 0.3)
        away = (xb < b[0] - 1.0) | (xb > b[2] + 1.0) | (yb < b[1] - 1.0) | (yb > b[3] + 1.0)
        idx = np.where(touch & away & (scene.seg_len >= 1.0))[0]
        if any(int(i) not in own for i in idx):
            return True
    return False


def _lone_ring(sg: np.ndarray) -> bool:
    """One closed convex polygon (a circle / ellipse drawn as a polyline): a dot, not a symbol."""
    from scipy.spatial import ConvexHull, QhullError

    pts = np.vstack([sg[:, :2], sg[:, 2:]])
    if len(sg) < 8:
        return False
    try:
        hull = ConvexHull(pts)
    except QhullError:
        return False
    return len(set(hull.vertices.tolist())) >= 0.8 * len(np.unique(np.round(pts, 3), axis=0))


def _unknown_clusters(
    vs: VectorSheet, scene: Scene, dets: list[Detection], exclude: list[BBox], text_paths: set[int], tix: TextIndex
) -> tuple[list[UnknownCluster], list[Detection]]:
    """Repeated symbol-like stroke groups (2–8 mm, black, with a curve or ≥ 3 directions) that no
    detection explains, grouped by a rotation-tolerant descriptor; ≥ 3 members → a cluster."""
    if scene.n == 0:
        return [], []
    keep = scene.seg_len <= 8.0
    ids = np.where(keep)[0]
    if len(ids) == 0:
        return [], []
    vsid = scene.seg_ids[ids]
    black = vs.path_stroke_rgba[vs.seg_path[vsid], :3].max(axis=1) < 60
    tp = np.zeros(vs.n_paths, bool)
    if text_paths:
        tp[np.fromiter((p for p in text_paths if 0 <= p < vs.n_paths), dtype=np.int64)] = True
    ids = ids[black & ~tp[vs.seg_path[vsid]]]
    if len(ids) == 0:
        return [], []
    lab = segment_components(scene.segs[ids])
    groups = groups_of(scene.segs, lab, ids)
    det_boxes = [d.bbox for d in dets]
    det_tree = cKDTree(np.array([d.center for d in dets])) if dets else None
    span_boxes = [s.bbox for s in tix.spans if len(s.text.strip()) >= 2]
    by_key: dict[tuple[Any, ...], list[Any]] = defaultdict(list)
    # stray glyphs of rotated text are text-sized: an unknown symbol must be clearly bigger than the text
    heights = [s.height for s in tix.spans if s.height > 0.5]
    min_big = max(2.0, 1.35 * float(np.percentile(heights, 30))) if heights else 2.0  # body text, not titles
    for g in groups:
        big, small = max(g.w, g.h), min(g.w, g.h)
        if not (min_big <= big <= 8.0) or small < 0.8 or len(g.segs) < 3:
            continue
        if det_tree is not None and det_tree.query_ball_point([g.cx, g.cy], 0.6 * big + 1.0):
            continue
        if any(b[0] - 0.3 <= g.cx <= b[2] + 0.3 and b[1] - 0.3 <= g.cy <= b[3] + 0.3 for b in span_boxes):
            continue
        sg = scene.segs[g.segs]
        kinds = vs.seg_kind[scene.seg_ids[g.segs]]
        ang = np.round(np.degrees(np.arctan2(sg[:, 3] - sg[:, 1], sg[:, 2] - sg[:, 0])) % 180 / 15) % 12
        n_dirs = len(set(ang[kinds != SEG_BEZIER].tolist()))
        curved = bool((kinds == SEG_BEZIER).any())
        if not curved and n_dirs < 3:
            continue
        if (curved and _circle_with_contents(sg, kinds)) or _lone_ring(sg):
            continue  # a lone circle (conduit end, dot) or a circled number (type tag): not a symbol to ask about
        if _line_terminator(g, scene):
            continue
        total = float(seg_lengths(sg).sum())
        key = (round(big * 2) / 2, round(small * 2) / 2, round(total / big, 1) // 0.5, curved, min(n_dirs, 6))
        by_key[key].append(g)
    clusters: list[UnknownCluster] = []
    unk: list[Detection] = []
    ranked = sorted(by_key.items(), key=lambda kv: -len(kv[1]))
    for _, gs in ranked:
        if len(gs) < 3 or len(gs) > 80 or len(clusters) >= 8:
            continue
        cid = f"u_{len(clusters)}"
        ex = gs[0]
        sig = stroke_signature(scene.segs[ex.segs], "", curved=vs.seg_kind[scene.seg_ids[ex.segs]] == SEG_BEZIER)
        clusters.append(UnknownCluster(cid, sig, len(gs), ex.bbox, [g.bbox for g in gs]))
        for g in gs:
            unk.append(
                Detection(
                    cls="unknown",
                    center=(g.cx, g.cy),
                    bbox=g.bbox,
                    quality=0.4,
                    margin=0.0,
                    source="unknown",
                    cluster_id=cid,
                    reasons=[R_NOT_IN_LEGEND],
                    signature=sig,
                )
            )
    _ = det_boxes, in_box
    return clusters, unk
