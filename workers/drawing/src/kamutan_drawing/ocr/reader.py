"""Read the SHX text of one page with the org glyph store (runs inside the sandbox).

1. every glyph is mapped to a store entry (style-normalised shape, see :mod:`.shapes`);
2. lines that contain a glyph whose entry is not yet *settled* (too few OCR votes in the
   org store) are OCR-ed with Tesseract ``heb`` and ``eng`` (clean vector re-render,
   30 lines per call); settled lines are read from the store alone — this is how labels
   are reused across sheets and projects and why later sheets are faster;
3. page votes + prior org votes → one label per entry (geometric vetoes, see
   :class:`~.dictionary.GlyphDictionary`) → deterministic reading;
4. the page's contribution (new shapes, new keys, *page* votes and geometry samples) is
   returned as a :class:`~.shapes.StoreDelta`; the orchestrator merges it into the
   persisted store (idempotent per contribution id).
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from .dictionary import GlyphDictionary, TextSpan, text_spans
from .glyphs import TextLine
from .shapes import MAX_SAMPLES, GlyphStore, StoreDelta, _entry_to_obj, assign_entries

SETTLED_VOTES = 4  # per language: an entry with this many heb and eng votes needs no new OCR


@dataclass
class PageText:
    spans: list[TextSpan]
    delta: StoreDelta
    stats: dict[str, Any] = field(default_factory=dict)


def _settled(votes: Counter[str], votes_eng: Counter[str]) -> bool:
    return sum(votes.values()) >= SETTLED_VOTES and sum(votes_eng.values()) >= SETTLED_VOTES


def read_page_text(lines: list[TextLine], store: GlyphStore, contribution: str, *, ocr: bool = True) -> PageText:
    """``store`` is mutated (new entries); pass a private copy if that matters."""
    if not lines:
        return PageText([], StoreDelta(contribution), {"lines": 0, "glyphs": 0})
    prior = {eid: (Counter(e.votes), Counter(e.votes_eng)) for eid, e in store.entries.items()}
    asg = assign_entries(lines, store)
    for ln, row in zip(lines, asg.entry_of, strict=True):
        for g, eid in zip(ln.glyphs, row, strict=True):
            g.key = f"e{eid}"
    gd = GlyphDictionary.build(lines)
    eid_of = {cl.id: int(next(iter(cl.keys))[1:]) for cl in gd.clusters}

    def settled(eid: int) -> bool:
        pv = prior.get(eid)
        return pv is not None and _settled(*pv)

    todo = [ln for ln, row in zip(lines, asg.entry_of, strict=True) if any(not settled(e) for e in row)] if ocr else []
    if todo:
        gd.collect_votes(todo, lang="heb", target="votes")
        gd.collect_votes(todo, lang="eng", target="votes_eng")
    page_votes = {cl.id: (Counter(cl.votes), Counter(cl.votes_eng)) for cl in gd.clusters}
    for cl in gd.clusters:
        e = store.entries[eid_of[cl.id]]
        cl.votes.update(e.votes)
        cl.votes_eng.update(e.votes_eng)
        room = MAX_SAMPLES - len(cl.rel_h)
        if room > 0:
            cl.rel_h.extend(e.rel_h[:room])
            cl.rel_bottom.extend(e.rel_bottom[:room])
            cl.n_comps.extend(e.n_comps[:room])
    gd.finalize_labels(lines=lines)
    gd.propagate_nearest()
    spans = text_spans(lines, gd)

    # ---- delta (page contribution only)
    delta = StoreDelta(contribution)
    counts = Counter(g.cluster for ln in lines for g in ln.glyphs)
    for cl in gd.clusters:
        eid = eid_of[cl.id]
        e = store.entries[eid]
        pv, pe = page_votes[cl.id]
        # geometry samples measured on this page are the first entries of cl.rel_h (before priors were appended)
        n_page = min(len(cl.rel_h), counts[cl.id], MAX_SAMPLES)
        upd: dict[str, Any] = {
            "keys": sorted(e.keys),
            "count": counts[cl.id],
            "votes": dict(pv),
            "votesEng": dict(pe),
            "relH": cl.rel_h[:n_page],
            "relBottom": cl.rel_bottom[:n_page],
            "nComps": cl.n_comps[:n_page],
            "label": cl.label,
            "conf": float(cl.conf),
            "alt": cl.alt,
        }
        if eid in asg.new_ids:
            e.count = counts[cl.id]
            e.votes, e.votes_eng = Counter(pv), Counter(pe)
            e.rel_h, e.rel_bottom, e.n_comps = list(upd["relH"]), list(upd["relBottom"]), list(upd["nComps"])
            e.label, e.conf, e.alt = cl.label, float(cl.conf), cl.alt
            delta.new_entries.append(_entry_to_obj(e))
        else:
            delta.updates[eid] = upd
    n_gl = sum(len(ln.glyphs) for ln in lines)
    labelled = sum(1 for ln in lines for g in ln.glyphs if (c := gd.cluster_by_id(g.cluster)) is not None and c.label)
    stats = {
        "lines": len(lines),
        "glyphs": n_gl,
        "shapes": gd.n_unique,
        "newShapes": len(asg.new_ids),
        "ocrLines": len(todo),
        "labelledShare": round(labelled / max(n_gl, 1), 4),
    }
    return PageText(spans, delta, stats)
