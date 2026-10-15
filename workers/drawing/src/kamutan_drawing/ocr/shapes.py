"""Style-normalised glyph shapes and the persistent per-org glyph store.

Sprint 0 keyed every SHX glyph by its strokes quantised to 1/8 of the *line* height.
On the sample set that produced 1,710 "unique" shapes because the same letter was
drawn in several text styles: different cap heights (handled), different **width
factors** (not handled: x was divided by the height too) and quantisation flips of
±1 step for vertices that sit near a bin edge.

This module normalises every glyph by its *style*:

    u = (x - glyph_left) / (H_style * wf_style)      v = (y - baseline) / H_style

* ``H_style``  — robust cap height of the style (median over the lines of one pen
  colour/width whose measured heights agree within 6 %), so a short line of
  digits no longer gets its own, noisy height;
* ``wf_style`` — width factor of the style relative to the org dictionary's
  reference style, estimated by matching the style's frequent glyphs against the
  known shapes with x normalised by the glyph's own width.

Shapes are then matched **topology first**: same number of strokes, same curve
flag and vertex count per stroke, and every vertex within ``MATCH_TOL`` (< one
quantisation step) after optimal stroke assignment. This is deliberately much
stricter than the blurred-bitmap cosine merge the spike rejected (it merged
ה/ח/ק): look-alike Hebrew letters differ in topology or by ≥ 0.3 H at some vertex.

:class:`GlyphStore` holds one *entry* per shape (exemplar strokes, the exact keys
seen, OCR votes, geometry samples) and is persisted per org as JSON so labels are
reused across sheets and projects. Updates from one page are expressed as a
:class:`StoreDelta` and merged commutatively (vote counts add; the same
contribution id is never counted twice), which keeps retries idempotent.
"""

from __future__ import annotations

import gzip
import json
from collections import Counter, defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from scipy.optimize import linear_sum_assignment

from .glyphs import Glyph, TextLine

QUANT = 8  # exact-key quantisation, 1/QUANT of the style cap height
MATCH_TOL = 0.09  # max vertex distance (units of H) for two glyphs to be the same shape
WF_MATCH_TOL = 0.08  # same, with x normalised by the glyph width (width-factor estimation)
HEIGHT_BIN = 1.06  # lines of one pen whose heights differ by less than 6 % share a style
LINE_H_TOL = 0.10  # a line uses the style height when its own height is within 10 %
MIN_WF_MATCHES = 3
MAX_KEYS_PER_ENTRY = 64
MAX_SAMPLES = 50
SCHEMA = "kamutan.glyphstore/1"

Sig = tuple[tuple[bool, int], ...]


# --------------------------------------------------------------------------- shapes
@dataclass
class Shape:
    """Normalised strokes of one glyph, grouped by (has_curve, n_vertices)."""

    sig: Sig
    groups: dict[tuple[bool, int], list[np.ndarray]]
    width: float  # glyph bbox width in normalised units

    def strokes(self) -> list[tuple[bool, np.ndarray]]:
        return [(c, s) for (c, _), lst in sorted(self.groups.items()) for s in lst]


def make_shape(
    polys: Sequence[tuple[bool, np.ndarray]], x0: float, baseline: float, h: float, wf: float, width_mm: float
) -> Shape:
    sx = 1.0 / (h * wf)
    sy = 1.0 / h
    groups: dict[tuple[bool, int], list[np.ndarray]] = defaultdict(list)
    for curve, v in polys:
        if len(v) == 0:
            continue
        a = np.column_stack([(v[:, 0] - x0) * sx, (v[:, 1] - baseline) * sy]).astype(np.float64)
        groups[(bool(curve), len(a))].append(a)
    sig: Sig = tuple(sorted((k[0], k[1]) for k, lst in groups.items() for _ in lst))
    return Shape(sig=sig, groups=dict(groups), width=float(width_mm * sx))


def width_normalised(s: Shape) -> Shape:
    """Same strokes with x divided by the glyph width (scale-free in x)."""
    w = s.width if s.width > 0.2 else 1.0
    g = {k: [np.column_stack([a[:, 0] / w, a[:, 1]]) for a in lst] for k, lst in s.groups.items()}
    return Shape(sig=s.sig, groups=g, width=1.0)


def exact_key(s: Shape, quant: int = QUANT) -> str:
    """Hash of the quantised strokes (direction-canonical, sorted)."""
    parts = []
    for (curve, _), lst in s.groups.items():
        for a in lst:
            q = np.round(a * quant).astype(int)
            keep = [0] + [k for k in range(1, len(q)) if (q[k] != q[k - 1]).any()]
            t = tuple((int(p[0]), int(p[1])) for p in q[keep])
            t = min(t, tuple(reversed(t)))
            parts.append(("c" if curve else "l") + "|".join(f"{x},{y}" for x, y in t))
    return ";".join(sorted(parts)) or "dot"


def _stroke_dist(a: np.ndarray, b: np.ndarray) -> float:
    return float(min(np.abs(a - b).max(), np.abs(a - b[::-1]).max()))


def shape_distance(a: Shape, b: Shape) -> float:
    """Max vertex distance after optimal stroke assignment; inf if topologies differ."""
    if a.sig != b.sig:
        return float("inf")
    worst = 0.0
    for k, la in a.groups.items():
        lb = b.groups.get(k)
        if lb is None or len(lb) != len(la):
            return float("inf")
        if len(la) == 1:
            d = _stroke_dist(la[0], lb[0])
        else:
            cost = np.array([[_stroke_dist(x, y) for y in lb] for x in la])
            r, c = linear_sum_assignment(cost)
            d = float(cost[r, c].max())
        worst = max(worst, d)
        if worst > 1.0:
            break
    return worst


# --------------------------------------------------------------------------- store
@dataclass
class Entry:
    id: int
    shape: Shape
    keys: set[str] = field(default_factory=set)
    count: int = 0
    votes: Counter[str] = field(default_factory=Counter)
    votes_eng: Counter[str] = field(default_factory=Counter)
    rel_h: list[float] = field(default_factory=list)
    rel_bottom: list[float] = field(default_factory=list)
    n_comps: list[int] = field(default_factory=list)
    label: str | None = None
    conf: float = 0.0
    alt: str | None = None
    _wn: Shape | None = None

    def width_norm(self) -> Shape:
        if self._wn is None:
            self._wn = width_normalised(self.shape)
        return self._wn

    def n_votes(self) -> int:
        return sum(self.votes.values()) + sum(self.votes_eng.values())


@dataclass
class StoreDelta:
    """Changes one page makes to the org store (applied by the orchestrator)."""

    contribution: str
    new_entries: list[dict[str, Any]] = field(default_factory=list)  # serialised entries with page-local ids
    updates: dict[int, dict[str, Any]] = field(default_factory=dict)  # entry id -> {keys, count, votes, ...}

    def to_obj(self) -> dict[str, Any]:
        return {
            "contribution": self.contribution,
            "newEntries": self.new_entries,
            "updates": {str(k): v for k, v in self.updates.items()},
        }

    @classmethod
    def from_obj(cls, o: dict[str, Any]) -> StoreDelta:
        return cls(
            contribution=str(o["contribution"]),
            new_entries=list(o.get("newEntries", [])),
            updates={int(k): dict(v) for k, v in dict(o.get("updates", {})).items()},
        )


def _entry_to_obj(e: Entry) -> dict[str, Any]:
    return {
        "id": e.id,
        "sig": [[int(c), n] for c, n in e.shape.sig],
        "strokes": [[int(c), np.round(s, 4).tolist()] for c, s in e.shape.strokes()],
        "width": round(e.shape.width, 4),
        "keys": sorted(e.keys)[:MAX_KEYS_PER_ENTRY],
        "count": e.count,
        "votes": dict(e.votes),
        "votesEng": dict(e.votes_eng),
        "relH": [round(x, 3) for x in e.rel_h[:MAX_SAMPLES]],
        "relBottom": [round(x, 3) for x in e.rel_bottom[:MAX_SAMPLES]],
        "nComps": e.n_comps[:MAX_SAMPLES],
        "label": e.label,
        "conf": round(e.conf, 3),
        "alt": e.alt,
    }


def _entry_from_obj(o: dict[str, Any]) -> Entry:
    groups: dict[tuple[bool, int], list[np.ndarray]] = defaultdict(list)
    for c, pts in o["strokes"]:
        a = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
        groups[(bool(c), len(a))].append(a)
    sig: Sig = tuple(sorted((k[0], k[1]) for k, lst in groups.items() for _ in lst))
    return Entry(
        id=int(o["id"]),
        shape=Shape(sig=sig, groups=dict(groups), width=float(o.get("width", 1.0))),
        keys=set(o.get("keys", [])),
        count=int(o.get("count", 0)),
        votes=Counter({str(k): int(v) for k, v in dict(o.get("votes", {})).items()}),
        votes_eng=Counter({str(k): int(v) for k, v in dict(o.get("votesEng", {})).items()}),
        rel_h=[float(x) for x in o.get("relH", [])],
        rel_bottom=[float(x) for x in o.get("relBottom", [])],
        n_comps=[int(x) for x in o.get("nComps", [])],
        label=o.get("label"),
        conf=float(o.get("conf", 0.0)),
        alt=o.get("alt"),
    )


class GlyphStore:
    """Per-org dictionary of glyph shapes (see module docstring)."""

    def __init__(self, entries: Iterable[Entry] = (), contributions: Iterable[str] = (), next_id: int | None = None):
        self.entries: dict[int, Entry] = {e.id: e for e in entries}
        self.contributions: set[str] = set(contributions)
        self.next_id = next_id if next_id is not None else (max(self.entries, default=-1) + 1)
        self._key_index: dict[str, int] = {}
        self._by_sig: dict[Sig, list[int]] = defaultdict(list)
        for e in self.entries.values():
            self._index(e)

    def _index(self, e: Entry) -> None:
        for k in e.keys:
            self._key_index.setdefault(k, e.id)
        if e.id not in self._by_sig[e.shape.sig]:
            self._by_sig[e.shape.sig].append(e.id)

    def __len__(self) -> int:
        return len(self.entries)

    # ------------------------------------------------------------- lookup
    def lookup(self, shape: Shape, key: str, tol: float = MATCH_TOL) -> int | None:
        eid = self._key_index.get(key)
        if eid is not None:
            return eid
        best, best_d = None, tol
        for cid in self._by_sig.get(shape.sig, ()):
            d = shape_distance(shape, self.entries[cid].shape)
            if d <= best_d:
                best, best_d = cid, d
        return best

    def lookup_width_free(self, wn_shape: Shape, tol: float = WF_MATCH_TOL) -> Entry | None:
        best, best_d = None, tol
        for cid in self._by_sig.get(wn_shape.sig, ()):
            e = self.entries[cid]
            d = shape_distance(wn_shape, e.width_norm())
            if d <= best_d:
                best, best_d = e, d
        return best

    def add(self, shape: Shape, key: str) -> Entry:
        e = Entry(id=self.next_id, shape=shape, keys={key})
        self.next_id += 1
        self.entries[e.id] = e
        self._index(e)
        return e

    def add_key(self, eid: int, key: str) -> None:
        e = self.entries[eid]
        if key not in e.keys and len(e.keys) < MAX_KEYS_PER_ENTRY:
            e.keys.add(key)
        self._key_index.setdefault(key, eid)

    # ------------------------------------------------------------- merge
    def apply(self, delta: StoreDelta) -> dict[int, int]:
        """Merge a page delta. Returns page-local new-entry id -> store id.

        New entries are re-matched against the current store first (another page may
        have added the same shape concurrently). Votes/counts of a contribution that
        was already applied are not added again (retry idempotency).
        """
        dup = delta.contribution in self.contributions
        remap: dict[int, int] = {}
        for o in delta.new_entries:
            ne = _entry_from_obj(o)
            key = next(iter(ne.keys), exact_key(ne.shape))
            hit = self.lookup(ne.shape, key)
            if hit is None:
                e = self.add(ne.shape, key)
                for k in ne.keys:
                    self.add_key(e.id, k)
                remap[ne.id] = e.id
                upd = {"count": ne.count, "votes": ne.votes, "votesEng": ne.votes_eng, "relH": ne.rel_h}
                upd |= {"relBottom": ne.rel_bottom, "nComps": ne.n_comps, "label": ne.label, "conf": ne.conf, "alt": ne.alt}
                self._update(e, upd, add_counts=not dup)
            else:
                remap[ne.id] = hit
                for k in ne.keys:
                    self.add_key(hit, k)
                upd = {"count": ne.count, "votes": ne.votes, "votesEng": ne.votes_eng, "relH": ne.rel_h}
                upd |= {"relBottom": ne.rel_bottom, "nComps": ne.n_comps}
                self._update(self.entries[hit], upd, add_counts=not dup)
        for eid, u in delta.updates.items():
            ent = self.entries.get(eid)
            if ent is None:  # entry vanished (should not happen: entries are never deleted)
                continue
            for k in u.get("keys", []):
                self.add_key(eid, k)
            self._update(ent, u, add_counts=not dup)
        self.contributions.add(delta.contribution)
        return remap

    @staticmethod
    def _update(e: Entry, upd: dict[str, Any], add_counts: bool) -> None:
        if add_counts:
            e.count += int(upd.get("count", 0))
            e.votes.update({str(k): int(v) for k, v in dict(upd.get("votes", {})).items()})
            e.votes_eng.update({str(k): int(v) for k, v in dict(upd.get("votesEng", {})).items()})
            for name, attr in (("relH", "rel_h"), ("relBottom", "rel_bottom"), ("nComps", "n_comps")):
                cur = getattr(e, attr)
                room = MAX_SAMPLES - len(cur)
                if room > 0:
                    cur.extend(list(upd.get(name, []))[:room])
        if "label" in upd:
            e.label, e.conf, e.alt = upd.get("label"), float(upd.get("conf") or 0.0), upd.get("alt")

    # ------------------------------------------------------------- io
    def to_obj(self) -> dict[str, Any]:
        return {
            "schema": SCHEMA,
            "nextId": self.next_id,
            "contributions": sorted(self.contributions),
            "entries": [_entry_to_obj(e) for e in sorted(self.entries.values(), key=lambda e: e.id)],
        }

    @classmethod
    def from_obj(cls, o: dict[str, Any]) -> GlyphStore:
        if o.get("schema") != SCHEMA:
            raise ValueError(f"unsupported glyph store schema: {o.get('schema')!r}")
        return cls(
            entries=[_entry_from_obj(x) for x in o.get("entries", [])],
            contributions=[str(c) for c in o.get("contributions", [])],
            next_id=int(o["nextId"]),
        )

    def to_bytes(self) -> bytes:
        return gzip.compress(json.dumps(self.to_obj(), ensure_ascii=False, separators=(",", ":")).encode(), mtime=0)

    @classmethod
    def from_bytes(cls, data: bytes | None) -> GlyphStore:
        if not data:
            return cls()
        return cls.from_obj(json.loads(gzip.decompress(data)))

    def stats(self) -> dict[str, Any]:
        es = list(self.entries.values())
        return {
            "entries": len(es),
            "labelled": sum(1 for e in es if e.label),
            "instances": sum(e.count for e in es),
            "contributions": len(self.contributions),
        }


# --------------------------------------------------------------------------- styles
@dataclass
class LineStyle:
    style_id: str
    height: float  # H used for normalisation
    wf: float  # width factor relative to the store reference


def _height_bins(hs: list[float]) -> list[list[int]]:
    order = sorted(range(len(hs)), key=lambda i: hs[i])
    bins: list[list[int]] = []
    for i in order:
        if bins and hs[i] <= hs[bins[-1][0]] * HEIGHT_BIN:
            bins[-1].append(i)
        else:
            bins.append([i])
    return bins


def estimate_line_styles(lines: Sequence[TextLine], store: GlyphStore) -> list[LineStyle]:
    """Robust cap height + width factor per text style (pen colour/width + height bin)."""
    out: list[LineStyle | None] = [None] * len(lines)
    by_pen: dict[tuple[int, int, int, float], list[int]] = defaultdict(list)
    for i, ln in enumerate(lines):
        by_pen[ln.style].append(i)
    styles: dict[str, list[int]] = {}
    style_h: dict[str, float] = {}
    for pen, idx in by_pen.items():
        hs = [lines[i].height for i in idx]
        for b in _height_bins(hs):
            members = [idx[k] for k in b]
            longer = [lines[i].height for i in members if len(lines[i].glyphs) >= 3]
            h = float(np.median(longer if longer else [lines[i].height for i in members]))
            sid = f"{pen[0]:02x}{pen[1]:02x}{pen[2]:02x}-{pen[3]:.3f}-{h:.2f}"
            styles[sid] = members
            style_h[sid] = h
    line_h = {}
    for sid, members in styles.items():
        for i in members:
            own = lines[i].height
            line_h[i] = style_h[sid] if abs(own / style_h[sid] - 1.0) <= LINE_H_TOL else own

    # width factors: biggest styles first; each style is calibrated against the store and the
    # styles already calibrated on this page (pseudo-entries in a scratch store)
    scratch = GlyphStore(entries=list(store.entries.values()), next_id=store.next_id)
    order = sorted(styles, key=lambda s: -sum(len(lines[i].glyphs) for i in styles[s]))
    wf_of: dict[str, float] = {}
    for sid in order:
        samples: dict[str, tuple[Shape, float]] = {}
        freq: Counter[str] = Counter()
        for i in styles[sid]:
            ln = lines[i]
            h = line_h[i]
            for g in ln.glyphs:
                gw = float(g.bbox[2] - g.bbox[0])
                gh = float(g.bbox[3] - g.bbox[1])
                if not g.polys or gw < 0.25 * h or gh < 0.5 * h:
                    continue
                sh = make_shape(g.polys, float(g.bbox[0]), ln.baseline, h, 1.0, gw)
                k = exact_key(sh)
                freq[k] += 1
                samples.setdefault(k, (sh, gw / h))
        ratios: list[float] = []
        for k, _ in freq.most_common(40):
            sh, w_over_h = samples[k]
            e = scratch.lookup_width_free(width_normalised(sh))
            if e is not None and e.shape.width > 0.2:
                ratios.append(float(np.log(w_over_h / e.shape.width)))
        if len(ratios) >= MIN_WF_MATCHES:
            wf = float(np.exp(np.median(ratios)))
        else:
            wf = 1.0
        wf = round(wf, 3)
        wf_of[sid] = wf
        # add this style's frequent shapes as calibrated references for the next styles
        for k, n in freq.most_common(40):
            if n < 2:
                break
            sh, _ = samples[k]
            norm = Shape(
                sig=sh.sig,
                groups={kk: [np.column_stack([a[:, 0] / wf, a[:, 1]]) for a in v] for kk, v in sh.groups.items()},
                width=sh.width / wf,
            )
            if scratch.lookup(norm, exact_key(norm)) is None:
                scratch.add(norm, exact_key(norm))
    for sid, members in styles.items():
        for i in members:
            out[i] = LineStyle(style_id=sid, height=line_h[i], wf=wf_of[sid])
    return [s for s in out if s is not None]


# --------------------------------------------------------------------------- assignment
@dataclass
class Assignment:
    entry_of: list[list[int]]  # per line, per glyph -> entry id (store ids; new ones are page-local, >= base)
    new_ids: set[int]
    styles: list[LineStyle]


def glyph_shape(g: Glyph, ln: TextLine, st: LineStyle) -> Shape:
    return make_shape(g.polys, float(g.bbox[0]), ln.baseline, st.height, st.wf, float(g.bbox[2] - g.bbox[0]))


def assign_entries(lines: Sequence[TextLine], store: GlyphStore) -> Assignment:
    """Map every glyph to a store entry, adding new entries to ``store`` for unseen shapes.

    Glyphs are processed by exact key, most frequent first, so the exemplar of a new
    entry is its most common rendering.
    """
    styles = estimate_line_styles(lines, store)
    shapes: list[list[tuple[Shape, str]]] = []
    freq: Counter[str] = Counter()
    first: dict[str, Shape] = {}
    for ln, st in zip(lines, styles, strict=True):
        row = []
        for g in ln.glyphs:
            sh = glyph_shape(g, ln, st)
            k = exact_key(sh)
            row.append((sh, k))
            freq[k] += 1
            first.setdefault(k, sh)
        shapes.append(row)
    base = store.next_id
    key_to_entry: dict[str, int] = {}
    for k, _ in freq.most_common():
        sh = first[k]
        eid = store.lookup(sh, k)
        if eid is None:
            eid = store.add(sh, k).id
        else:
            store.add_key(eid, k)
        key_to_entry[k] = eid
    entry_of = [[key_to_entry[k] for _, k in row] for row in shapes]
    return Assignment(entry_of=entry_of, new_ids={i for i in store.entries if i >= base}, styles=styles)
