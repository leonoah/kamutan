"""Hard text and yellow-symbol crops for the LLM gateway (Sprint 8, Worker-LLM) — the **sandbox side**.

Pure: no gateway, no network, no secrets (the sandbox child has none). It runs inside the ``understand`` task and
only prepares crops and applies readings that the orchestrator (``llm_gateway.hooks``, worker parent process) got
from the gateway. Two passes per page when the org's gateway is on:

* **pass 1** (``args.llm = {"collect": true, "titleBlockMm": …}``): the normal run, plus candidate crops written
  under ``outDir/llm/`` (PNG, never uploaded) and listed in the result's ``llmRequests``:

  - ``note`` / ``qualifier`` (*read_hard_text*): blocks of text spans the glyph dictionary read as noise
    (:func:`noisy`) within :data:`NEAR_DET_MM` of a detection — e.g. the 4.10 bed-head note "מפסק מחליף קיים /
    H=65" whose glyph tops PDFium's path API drops — rendered at :data:`TEXT_PX_PER_MM` from the page render
    (which draws the whole glyphs), padded upwards to cover the missing halves; and sockets whose 2X / 3X / TV mark
    could not be read (reason ``כיתוב ליד הסמל לא נקרא``);
  - ``mark`` (*read_hard_text*): rotated "U.K=75 / O.K=210 / H=140" boxes the height-mark Tesseract could not
    parse (hook in :func:`kamutan_drawing.geometry.marks.read_marks` → :meth:`Session.mark`), the stroke render
    already made for Tesseract;
  - ``verify`` (*verify_symbol*): yellow vector detections matched to a legend row of this sheet — the symbol crop
    plus the legend row's thumbnail (``legend/{entryId}.webp``).

  Nothing inside the title block (``titleBlockMm`` from the orchestrator) is ever a candidate.
* **pass 2** (``args.llm = {"readings": {id: {kind, text, confidence, bboxMm}}}``), only when pass 1 produced a
  usable reading: notes replace the noisy spans inside their block (readable ones stay), qualifiers add a span on their socket (the existing
  annotation / refinement / lifecycle code then reads them like any text), marks answer the height-mark hook for
  the same stroke render (same id = sha256 of the PNG). ``llmUsed`` lists the ids that were applied.

Everything derived from a reading is capped at yellow by the orchestrator (SEC-33, ``hooks.cap_llm_derived``).
"""

from __future__ import annotations

import contextlib
import contextvars
import hashlib
import io
import re
from collections.abc import Callable, Container, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from PIL import Image

from ..ocr.dictionary import TextSpan

BBox = tuple[float, float, float, float]

TEXT_PX_PER_MM = 16.0  # ≈ 406 dpi: the thin SHX strokes stay ≥ 2 px
SYMBOL_PX_PER_MM = 12.0
NEAR_DET_MM = 15.0  # a hard note / mark is next to the symbol it qualifies
BLOCK_GAP_MM = 3.0  # word gaps of one note line (half-height glyph remnants underestimate the line height)
MAX_NOTES = 30
MAX_QUALIFIERS = 20
MAX_MARKS = 12
MAX_VERIFY = 60
MAX_NOTE_W_MM = 45.0  # a block larger than this is not a note (scattered tags / dimensions)
MAX_NOTE_H_MM = 15.0
PAD_SIDE_MM = 4.0  # Hebrew notes end on the left: the last word's glyphs reach past the read remnants
PAD_TOP_MM = 4.0  # SHX glyph tops PDFium's path API may drop (Noah 1bbe4113: ≈ 3–4 mm above the read remnants)
READING_CONF_MAX = 0.75  # span confidence given to an LLM reading (below the dictionary's "read" level)
R_MARK_UNREAD = "כיתוב ליד הסמל לא נקרא"  # = symbols.detect.R_MARK_UNREAD
R_HUMAN = "אושר ידנית"
_ID = re.compile(r"^[a-z]_[0-9a-f]{20}$")
_DET_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_EID = re.compile(r"^le_[A-Za-z0-9_-]{1,120}$")


@dataclass
class Candidate:
    id: str
    kind: str  # note | qualifier | mark | verify
    bbox: BBox
    png: bytes
    current: str = ""
    detection_id: str | None = None
    cls: str | None = None
    legend_entry_id: str | None = None

    def manifest(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "id": self.id,
            "kind": self.kind,
            "bboxMm": [round(v, 2) for v in self.bbox],
            "file": f"llm/{self.id}.png",
        }
        if self.kind != "verify":
            d["current"] = self.current[:80]
        else:
            d.update(detectionId=self.detection_id, cls=self.cls, legendEntryId=self.legend_entry_id)
        return d


@dataclass(frozen=True)
class Reading:
    kind: str
    text: str
    confidence: float
    bbox: BBox


@dataclass
class Session:
    collect: bool = False
    title_block: BBox | None = None
    readings: dict[str, Reading] = field(default_factory=dict)
    candidates: list[Candidate] = field(default_factory=list)
    used: list[str] = field(default_factory=list)

    def in_title_block(self, box: BBox) -> bool:
        return self.title_block is not None and _intersects(box, self.title_block)

    def mark(self, box: BBox, img: Image.Image) -> str | None:
        """Height-mark hook: ``img`` is the (unrotated) stroke render of an anchor box Tesseract could not parse.
        Pass 2 → the reading's text; pass 1 → recorded as a candidate, None."""
        png = png_bytes(img)
        cid = "m_" + hashlib.sha256(png).hexdigest()[:20]
        r = self.readings.get(cid)
        if r is not None and r.kind == "mark":
            if cid not in self.used:
                self.used.append(cid)
            return r.text
        n_marks = sum(c.kind == "mark" for c in self.candidates)
        if self.collect and not self.in_title_block(box) and n_marks < MAX_MARKS and all(c.id != cid for c in self.candidates):
            self.candidates.append(Candidate(cid, "mark", box, png))
        return None


_CURRENT: contextvars.ContextVar[Session | None] = contextvars.ContextVar("kamutan_llm_hard_text", default=None)


def current() -> Session | None:
    """The page's session while ``understand`` runs (None: no LLM work — every hook is a no-op)."""
    return _CURRENT.get()


@contextlib.contextmanager
def active(sess: Session | None) -> Iterator[Session | None]:
    tok = _CURRENT.set(sess)
    try:
        yield sess
    finally:
        _CURRENT.reset(tok)


def activate(sess: Session | None) -> contextvars.Token[Session | None]:
    """``understand.run``: make ``sess`` the page's session (pair with :func:`deactivate` in a ``finally``)."""
    return _CURRENT.set(sess)


def deactivate(tok: contextvars.Token[Session | None]) -> None:
    _CURRENT.reset(tok)


# ------------------------------------------------------------------------------------------------ helpers
def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.convert("L" if img.mode in ("1", "L") else "RGB").save(buf, format="PNG", optimize=False)
    return buf.getvalue()


def _intersects(a: BBox, b: BBox, pad: float = 0.0) -> bool:
    return a[0] - pad <= b[2] and b[0] - pad <= a[2] and a[1] - pad <= b[3] and b[1] - pad <= a[3]


def _gap(a: BBox, b: BBox) -> float:
    dx = max(a[0] - b[2], 0.0, b[0] - a[2])
    dy = max(a[1] - b[3], 0.0, b[1] - a[3])
    return float((dx * dx + dy * dy) ** 0.5)


def _union(boxes: Sequence[BBox]) -> BBox:
    return (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))


def bbox_of(d: Any) -> BBox | None:
    """``{x, y, w, h}`` or ``[x0, y0, x1, y1]`` → BBox (None when malformed)."""
    try:
        if isinstance(d, Mapping):
            x, y, w, h = (float(d[k]) for k in ("x", "y", "w", "h"))
            return (x, y, x + w, y + h)
        if isinstance(d, list | tuple) and len(d) == 4:
            x0, y0, x1, y1 = (float(v) for v in d)
            return (x0, y0, x1, y1) if x1 >= x0 and y1 >= y0 else None
    except (KeyError, TypeError, ValueError):
        return None
    return None


_STROKES = frozenset("|/\\-_—=.,:;'`~ ")


def noisy(s: TextSpan) -> bool:
    """A span the glyph dictionary read as noise: unknown glyphs, stroke artefacts ("|", "?"), or a scatter of
    one-character tokens (half glyphs, rotated words read as horizontal). A span of stroke characters only ("|",
    "/") is a wall / leader segment, not text."""
    t = s.text.strip()
    if not t or s.n_glyphs < 1 or len(t) > 60 or set(t) <= _STROKES:
        return False
    if s.conf < 0.5 or "|" in t or "?" in t:
        return True
    toks = t.split()
    if len(toks) >= 3 and sum(len(w) == 1 for w in toks) * 2 >= len(toks):
        return True
    return len(t) == 1 and not t.isdigit() and s.conf < 0.7


def _render_png(
    render_many: Callable[[list[tuple[float, int, int, int, int]]], list[Any]], reqs: list[tuple[float, int, int, int, int]]
) -> list[bytes | None]:
    try:
        imgs = render_many(reqs)
    except Exception:  # noqa: BLE001 - crops are best effort; the page never fails for them
        return [None] * len(reqs)
    out: list[bytes | None] = []
    for im in imgs:
        try:
            out.append(png_bytes(im) if im is not None else None)
        except Exception:  # noqa: BLE001 - one bad crop is skipped
            out.append(None)
    return out


def _req(box: BBox, ppm: float) -> tuple[float, int, int, int, int]:
    x0, y0, x1, y1 = box
    return ppm, max(0, int(x0 * ppm)), max(0, int(y0 * ppm)), max(1, int((x1 - x0) * ppm)), max(1, int((y1 - y0) * ppm))


def _cid(prefix: str, *parts: Any) -> str:
    h = hashlib.sha256("\x00".join(str(p) for p in parts).encode()).hexdigest()[:20]
    return f"{prefix}_{h}"


# ------------------------------------------------------------------------------------------------ pass 1
def _same_note(a: BBox, b: BBox) -> bool:
    """Two pieces of one note: words of one line (vertical overlap, horizontal gap ≤ :data:`BLOCK_GAP_MM`) or
    stacked lines (horizontal overlap, vertical gap ≤ one line height)."""
    h = max(a[3] - a[1], b[3] - b[1], 0.8)
    v_ov = min(a[3], b[3]) - max(a[1], b[1])
    h_ov = min(a[2], b[2]) - max(a[0], b[0])
    h_gap = max(a[0] - b[2], b[0] - a[2], 0.0)
    v_gap = max(a[1] - b[3], b[1] - a[3], 0.0)
    return (v_ov > 0.3 * h and h_gap <= BLOCK_GAP_MM) or (h_ov > 0 and v_gap <= h)


def note_blocks(
    spans: Sequence[TextSpan], det_boxes: Sequence[BBox], *, exclude: Sequence[BBox] = ()
) -> list[tuple[BBox, BBox, str]]:
    """``(block bbox, crop bbox, current text)`` of noisy text blocks within :data:`NEAR_DET_MM` of a detection.
    Noisy spans that are words of one line or stacked lines (:func:`_same_note`) form one block (single linkage
    over all noisy spans, then the block must be near a detection); readable spans touching it join the crop (the "65"
    under a garbled "H"); blocks larger than :data:`MAX_NOTE_W_MM` × :data:`MAX_NOTE_H_MM` are not notes (scattered
    tags, dimension clusters). The crop is padded by :data:`PAD_TOP_MM` upwards: PDFium's path API can drop the
    upper part of SHX glyphs (Noah 1bbe4113, the 4.10 note), the page render draws them."""
    seeds = {i for i, s in enumerate(spans) if noisy(s)}
    # stroke-only fragments ("-|", "|") bridge the words of a garbled line but never make a block alone
    bridges = {i for i, s in enumerate(spans) if s.text.strip() and set(s.text.strip()) <= _STROKES and len(s.text) <= 6}
    cand = [i for i in sorted(seeds | bridges) if not any(_intersects(spans[i].bbox, e) for e in exclude)]
    parent = {i: i for i in cand}

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for a_i, i in enumerate(cand):
        for j in cand[a_i + 1 :]:
            if _same_note(spans[i].bbox, spans[j].bbox):
                parent[find(i)] = find(j)
    groups: dict[int, list[int]] = {}
    for i in cand:
        groups.setdefault(find(i), []).append(i)
    out: list[tuple[BBox, BBox, str]] = []
    seen: set[tuple[float, ...]] = set()
    for g in sorted(groups.values(), key=lambda g: (min(spans[j].bbox[1] for j in g), min(spans[j].bbox[0] for j in g))):
        if not seeds.intersection(g):
            continue
        box = _union([spans[j].bbox for j in g])
        if not any(_gap(box, b) <= NEAR_DET_MM for b in det_boxes):
            continue
        h = max(max(spans[j].bbox[3] - spans[j].bbox[1] for j in g), 0.8)
        members = set(g)
        for j, o in enumerate(spans):
            if j not in members and not noisy(o) and len(o.text) <= 12 and _gap(o.bbox, box) <= max(1.0, 0.8 * h):
                members.add(j)
        box = _union([spans[j].bbox for j in members])
        if box[2] - box[0] > MAX_NOTE_W_MM or box[3] - box[1] > MAX_NOTE_H_MM:
            continue
        pad_x = max(PAD_SIDE_MM, 2.0 * h)
        crop = (max(0.0, box[0] - pad_x), max(0.0, box[1] - max(PAD_TOP_MM, 2.5 * h)), box[2] + pad_x, box[3] + max(2.0, 1.5 * h))
        key = tuple(round(v, 1) for v in box)
        if key in seen:
            continue
        seen.add(key)
        text = " / ".join(spans[j].text for j in sorted(members, key=lambda k: (spans[k].bbox[1], -spans[k].bbox[2])))
        out.append((box, crop, text))
    return out


def collect(
    sess: Session,
    *,
    sheet_id: str,
    spans: Sequence[TextSpan],
    detections: Sequence[Mapping[str, Any]],
    legend_entries: Sequence[Mapping[str, Any]],
    legend_ids: Container[str],
    render_many: Callable[[list[tuple[float, int, int, int, int]]], list[Any]] | None,
) -> None:
    """Pass 1: note / qualifier / verify candidates of one page (marks were recorded during geometry)."""
    if not sess.collect or render_many is None:
        return
    exclude: list[BBox] = [sess.title_block] if sess.title_block is not None else []
    for e in legend_entries:  # a legend's own labels are the legend_label purpose, not hard text
        for k in ("symbolBboxMm", "labelBboxMm"):
            b = bbox_of(e.get(k))
            if b is not None:
                exclude.append(b)
    dets: list[tuple[Mapping[str, Any], BBox]] = []
    for d in detections:
        b = bbox_of(d.get("bboxMm"))
        if b is not None and not sess.in_title_block(b):
            dets.append((d, b))
    pending: list[tuple[Candidate, tuple[float, int, int, int, int]]] = []
    for box, crop, text in note_blocks(spans, [b for _, b in dets], exclude=exclude)[:MAX_NOTES]:
        if sess.in_title_block(crop):
            continue
        cid = _cid("n", sheet_id, *(round(v, 1) for v in box), text)
        pending.append((Candidate(cid, "note", box, b"", current=text), _req(crop, TEXT_PX_PER_MM)))
    nq = 0
    for d, b in dets:
        if nq >= MAX_QUALIFIERS or R_MARK_UNREAD not in (d.get("reasons") or []):
            continue
        size = max(b[2] - b[0], b[3] - b[1])
        pad = max(3.0, 1.1 * size)
        crop = (max(0.0, b[0] - pad), max(0.0, b[1] - pad), b[2] + pad, b[3] + pad)
        if sess.in_title_block(crop):
            continue
        cid = _cid("q", sheet_id, *(round(v, 1) for v in b))
        pending.append((Candidate(cid, "qualifier", b, b"", detection_id=str(d.get("id"))), _req(crop, TEXT_PX_PER_MM)))
        nq += 1
    nv = 0
    for d, b in dets:
        if nv >= MAX_VERIFY:
            break
        eid = d.get("legendEntryId")
        reasons = d.get("reasons") or []
        if d.get("level") != "yellow" or R_HUMAN in reasons or not isinstance(eid, str) or eid not in legend_ids:
            continue
        did = str(d.get("id") or "")
        if not _DET_ID.match(did) or not _EID.match(eid):
            continue
        cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        half = max(3.0, 0.5 * max(b[2] - b[0], b[3] - b[1]) + 1.5)
        crop = (max(0.0, cx - half), max(0.0, cy - half), cx + half, cy + half)
        cid = _cid("v", sheet_id, did, d.get("class"), round(cx, 1), round(cy, 1))
        cand = Candidate(cid, "verify", b, b"", detection_id=did, cls=str(d.get("class")), legend_entry_id=eid)
        pending.append((cand, _req(crop, SYMBOL_PX_PER_MM)))
        nv += 1
    pngs = _render_png(render_many, [r for _, r in pending])
    for (c, _), png in zip(pending, pngs, strict=True):
        if png:
            c.png = png
            sess.candidates.append(c)


def write_requests(sess: Session, out_dir: Path) -> dict[str, Any] | None:
    """Write the candidate PNGs under ``out_dir/llm/`` and return the ``llmRequests`` manifest (None: nothing)."""
    if not sess.collect or not sess.candidates:
        return None
    d = out_dir / "llm"
    d.mkdir(parents=True, exist_ok=True)
    items = []
    for c in sess.candidates:
        if not _ID.match(c.id) or not c.png:
            continue
        (d / f"{c.id}.png").write_bytes(c.png)
        items.append(c.manifest())
    return {"version": 1, "items": items} if items else None


def finish(sess: Session, *, spans: Sequence[TextSpan], out_dir: Path, render: Callable[..., Any] | None) -> dict[str, Any]:
    """End of ``understand.run``: ``llmUsed`` (pass 2) and, in pass 1, the crops + ``llmRequests`` manifest. Reads the
    page's own just-written ``detections.json.gz`` / ``legend.json.gz``; never raises (best effort)."""
    res: dict[str, Any] = {}
    if sess.used:
        res["llmUsed"] = sorted(set(sess.used))
    if not sess.collect:
        return res
    try:
        import gzip
        import json

        def load(name: str) -> dict[str, Any]:
            p = out_dir / name
            return json.loads(gzip.decompress(p.read_bytes())) if p.exists() else {}

        dets = [d for d in load("detections.json.gz").get("detections") or [] if isinstance(d, dict)]
        entries = [e for e in load("legend.json.gz").get("entries") or [] if isinstance(e, dict)]
        ids = {str(e.get("id")) for e in entries if e.get("thumb") and (out_dir / "legend" / f"{e.get('id')}.webp").exists()}
        render_many = None
        if render is not None:
            from ..pipeline.understand import BatchRender

            def render_many(reqs: list[tuple[float, int, int, int, int]]) -> list[Any]:
                batch = BatchRender(render)
                batch.prefetch(reqs)
                out: list[Any] = []
                for r in reqs:
                    try:
                        out.append(batch(*r))
                    except Exception:  # noqa: BLE001 - one bad crop is skipped
                        out.append(None)
                return out

        collect(sess, sheet_id=str(out_dir.name), spans=spans, detections=dets, legend_entries=entries, legend_ids=ids,
                render_many=render_many)  # fmt: skip
        man = write_requests(sess, out_dir)
    except Exception:
        import logging

        logging.getLogger(__name__).warning("llm crop collection failed", exc_info=True)
        return res
    if man is not None:
        res["llmRequests"] = man
    return res


# ------------------------------------------------------------------------------------------------ pass 2
def session_from_args(raw: Any) -> Session | None:
    """``args.llm`` (orchestrator data; still validated: the sandbox trusts nothing) → Session, or None."""
    if not isinstance(raw, Mapping):
        return None
    tb = bbox_of(raw.get("titleBlockMm"))
    readings: dict[str, Reading] = {}
    rr = raw.get("readings")
    if isinstance(rr, Mapping):
        for k, v in list(rr.items())[:500]:
            if not isinstance(k, str) or not _ID.match(k) or not isinstance(v, Mapping):
                continue
            kind, text, conf, box = v.get("kind"), v.get("text"), v.get("confidence"), bbox_of(v.get("bboxMm"))
            if kind not in ("note", "qualifier", "mark") or not isinstance(text, str) or box is None:
                continue
            if not isinstance(conf, int | float) or isinstance(conf, bool):
                continue
            text = "".join(ch for ch in text if ch.isprintable())[:200].strip()
            if text:
                readings[k] = Reading(str(kind), text, float(max(0.0, min(1.0, conf))), box)
    collect_ = raw.get("collect") is True
    if not collect_ and not readings:
        return None
    return Session(collect=collect_, title_block=tb, readings=readings)


def apply_span_readings(spans: list[TextSpan], sess: Session | None) -> list[TextSpan]:
    """Pass 2: a note replaces the spans whose centre lies in its block; a qualifier adds a span on its socket."""
    if sess is None or not sess.readings:
        return spans
    out = list(spans)
    sheet = spans[0].sheet if spans else ""
    for cid, r in sorted(sess.readings.items()):
        if r.kind not in ("note", "qualifier") or sess.in_title_block(r.bbox):
            continue
        x0, y0, x1, y1 = r.bbox
        if r.kind == "note":
            # only the noise is replaced: readable spans of the block (tags, "65") keep their own position
            inside = [
                s
                for s in out
                if noisy(s)
                and x0 - 0.3 <= (s.bbox[0] + s.bbox[2]) / 2 <= x1 + 0.3
                and y0 - 0.3 <= (s.bbox[1] + s.bbox[3]) / 2 <= y1 + 0.3
            ]
            height = max((s.height for s in inside), default=max(y1 - y0, 1.0))
            out = [s for s in out if s not in inside]
        else:
            height = max(1.0, min(3.0, y1 - y0))
        conf = min(READING_CONF_MAX, r.confidence)
        out.append(TextSpan(sheet, r.bbox, r.text, conf, height, 0, len(r.text)))
        sess.used.append(cid)
    return out


__all__ = [
    "Candidate",
    "Reading",
    "Session",
    "activate",
    "active",
    "apply_span_readings",
    "bbox_of",
    "collect",
    "current",
    "deactivate",
    "finish",
    "noisy",
    "note_blocks",
    "session_from_args",
    "write_requests",
]
