"""LLM hooks of the understanding stage (Sprint 8, Worker-LLM) — the **orchestrator side** (worker parent process).

Called from ``service/pipeline.py::_understand`` around the sandbox ``understand`` task:

1. :func:`prepare` — the org's gateway is on (:meth:`LlmGateway.enabled_for`) → ``args.llm = {"collect": true,
   "titleBlockMm": …}`` for pass 1 (else None: no crops, no extra work, nothing sent);
2. :func:`after_understand` — reads pass 1's ``llmRequests`` (crops under ``outDir/llm/``, validated, nothing in
   the title block), then

   * ``read_hard_text`` (notes, qualifiers, marks; region ``text_region``) in batches of ≤ 10 crops; readings with
     confidence ≥ :data:`MIN_READING_CONF` that differ from the current text → **pass 2** of the sandbox task with
     ``args.llm.readings``. Every item of pass 2 that differs from pass 1 (it can only come from a reading) is capped
     at yellow with :data:`R_LLM_TEXT` (SEC-33), link groups of changed detections too;
   * ``verify_symbol`` (yellow detections; the symbol crop = region ``symbol``, the legend rows = region
     ``legend_row``, sent first and prompt-cached) → per detection, **through** :func:`kamutan_drawing.calibration.calibrate`
     with a level cap: ``agree`` → reason :data:`R_VERIFIED`, stays yellow (never green); ``other_class`` → reason
     :data:`R_VERIFY_OTHER`, red when confident, else yellow; ``unsure`` → :data:`R_VERIFY_UNSURE`, yellow.

   ``disabled`` / ``budget_exceeded`` / errors leave the items exactly as pass 1 produced them.
3. :func:`report_json` — counts, tokens and USD for the version artifact ``llm.json`` (never text or images).

The orchestrator then caps and uploads the (rewritten) artifacts as before.
"""

from __future__ import annotations

import gzip
import json
import logging
import math
import re
import time
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from ..calibration import LEVEL_RANK, calibrate, min_level
from .gateway import BatchItem, BatchResult, PrefixImage
from .hard_text import bbox_of
from .prompts import HARD_TEXT_ITEM_SCHEMA, verify_item_schema

log = logging.getLogger("kamutan.llm_gateway")

R_LLM_TEXT = "נקרא בעזרת מודל שפה"
R_VERIFIED = "אומת חזותית"
R_VERIFY_OTHER = "בדיקה חזותית: ייתכן שזה סמל אחר במקרא"
R_VERIFY_UNSURE = "בדיקה חזותית לא חד-משמעית"
MIN_READING_CONF = 0.6
MIN_VERIFY_CONF = 0.6
RED_OTHER_CONF = 0.8  # other_class at or above → red, below → stays yellow
MAX_REQUESTS = 200
MAX_CROP_BYTES = 4 * 1024 * 1024
MAX_PREFIX = 12
LEVEL_FILES = (
    "detections.json.gz",
    "fixtures.json.gz",
    "text_items.json.gz",
    "geometry.json.gz",
    "links.json.gz",
    "rooms.json.gz",
)
_ID = re.compile(r"^[a-z]_[0-9a-f]{20}$")
_DET_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_EID = re.compile(r"^le_[A-Za-z0-9_-]{1,120}$")
_KINDS = ("note", "qualifier", "mark", "verify")
_ID_KEYS = frozenset({"id", "switchIds", "luminaireIds", "pointIds", "arcIds", "pairedWith", "lineIdx", "clusterId"})

ReadFile = Callable[[str], bytes]
Rerun = Callable[[dict[str, Any]], dict[str, Any] | None]
OutPath = Callable[[Mapping[str, Any]], Path]


@dataclass
class PageReport:
    status: str = "off"  # off | ok | disabled | budget_exceeded | refused | error
    reasons: list[str] = field(default_factory=list)
    calls: int = 0
    cost_usd: float = 0.0
    tokens_in: int = 0
    tokens_out: int = 0
    cache_write_tokens: int = 0
    cache_read_tokens: int = 0
    hard_text_sent: int = 0
    hard_text_read: int = 0
    hard_text_applied: int = 0
    verify_sent: int = 0
    verify_agree: int = 0
    verify_other: int = 0
    verify_unsure: int = 0
    llm_capped: int = 0
    second_pass: bool = False
    seconds: float = 0.0

    def add(self, r: BatchResult) -> None:
        self.calls += r.calls
        self.cost_usd += r.cost_usd
        self.tokens_in += r.tokens_in
        self.tokens_out += r.tokens_out
        self.cache_write_tokens += r.cache_write_tokens
        self.cache_read_tokens += r.cache_read_tokens
        if r.status != "ok":
            self.reasons.append(f"{r.status}:{r.reason}")
            if self.status in ("off", "ok"):
                self.status = r.status


def prepare(gw: Any, org_id: str, title_block: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """``args.llm`` for pass 1, or None when the gateway would send nothing for this org (no crops prepared)."""
    if gw is None or not getattr(gw, "globally_enabled", False) or not hasattr(gw, "call_batch"):
        return None
    try:
        if not gw.enabled_for(org_id):
            return None
    except Exception:  # noqa: BLE001 - a settings / storage hiccup = off for this page
        return None
    out: dict[str, Any] = {"collect": True}
    if title_block is not None:
        out["titleBlockMm"] = dict(title_block)
    return out


# --------------------------------------------------------------------------------------------- requests
@dataclass(frozen=True)
class _Req:
    id: str
    kind: str
    bbox: tuple[float, float, float, float]
    png: bytes
    current: str = ""
    detection_id: str | None = None
    cls: str | None = None
    legend_entry_id: str | None = None


def _requests(res: Mapping[str, Any], read: ReadFile, title_block: tuple[float, float, float, float] | None) -> list[_Req]:
    """Validate pass 1's (untrusted) manifest; drop anything malformed or touching the title block."""
    man = res.get("llmRequests")
    items = man.get("items") if isinstance(man, Mapping) else None
    if not isinstance(items, list):
        return []
    out: list[_Req] = []
    seen: set[str] = set()
    for it in items[:MAX_REQUESTS]:
        if not isinstance(it, Mapping):
            continue
        rid, kind, box = it.get("id"), it.get("kind"), bbox_of(it.get("bboxMm"))
        if not isinstance(rid, str) or not _ID.match(rid) or rid in seen or kind not in _KINDS or box is None:
            continue
        if not all(math.isfinite(v) and -10 <= v <= 5000 for v in box):
            continue
        if title_block is not None and _intersects(box, title_block):
            continue  # SEC-31: never, even if the sandbox listed it
        if it.get("file") != f"llm/{rid}.png":
            continue
        try:
            png = read(f"llm/{rid}.png")
        except (OSError, ValueError):
            continue
        if not png or len(png) > MAX_CROP_BYTES:
            continue
        det_id, cls, eid = it.get("detectionId"), it.get("cls"), it.get("legendEntryId")
        if kind == "verify" and not (
            isinstance(det_id, str)
            and _DET_ID.match(det_id)
            and isinstance(cls, str)
            and isinstance(eid, str)
            and _EID.match(eid)
        ):
            continue
        cur = it.get("current")
        seen.add(rid)
        out.append(
            _Req(
                rid,
                str(kind),
                box,
                png,
                current=str(cur)[:80] if isinstance(cur, str) else "",
                detection_id=det_id if kind == "verify" else None,
                cls=cls[:64] if kind == "verify" and isinstance(cls, str) else None,
                legend_entry_id=eid if kind == "verify" else None,
            )
        )
    return out


def _intersects(a: tuple[float, ...], b: tuple[float, ...]) -> bool:
    return a[0] <= b[2] and b[0] <= a[2] and a[1] <= b[3] and b[1] <= a[3]


def _norm(t: str) -> str:
    return " ".join(t.replace("/", " ").split())


# --------------------------------------------------------------------------------------------- main
def after_understand(
    gw: Any,
    org_id: str,
    res: dict[str, Any],
    *,
    llm_args: Mapping[str, Any],
    read_file: ReadFile,
    rerun: Rerun,
    out_path: OutPath,
    green_threshold: float | None = None,
    raster: bool = False,
) -> tuple[dict[str, Any], PageReport]:
    """See the module docstring. ``read_file(rel)`` reads a file of pass 1's outDir (sandbox-confined);
    ``rerun(llm_args)`` runs the sandbox task again (pass 2, into **another** outDir, so a failed pass 2 leaves
    pass 1 intact) and returns its result (None on failure); ``out_path(result)`` is a result's outDir on the
    parent's side (the artifacts of the returned result are rewritten in place)."""
    t0 = time.monotonic()
    rep = PageReport(status="ok")
    tb = bbox_of(llm_args.get("titleBlockMm"))
    reqs = _requests(res, read_file, tb)
    if not reqs:
        rep.seconds = round(time.monotonic() - t0, 3)
        return res, rep

    # ---- read_hard_text
    hard = [r for r in reqs if r.kind != "verify"]
    readings: dict[str, dict[str, Any]] = {}
    if hard:
        rep.hard_text_sent = len(hard)
        items = [BatchItem(r.id, r.png, "text_region", {"kind": r.kind, "currentReading": r.current}) for r in hard]
        br = gw.call_batch(org_id, "read_hard_text", items, HARD_TEXT_ITEM_SCHEMA)
        rep.add(br)
        for r in hard:
            ans = br.results.get(r.id)
            if not isinstance(ans, Mapping):
                continue
            text, conf = str(ans.get("text") or "").strip(), float(ans.get("confidence") or 0.0)
            if not text or conf < MIN_READING_CONF:
                continue
            rep.hard_text_read += 1
            if _norm(text) == _norm(r.current):
                continue
            readings[r.id] = {"kind": r.kind, "text": text[:200], "confidence": round(conf, 3), "bboxMm": list(r.bbox)}

    # ---- verify_symbol (crops read now: pass 2 rewrites the outDir)
    verdicts: list[tuple[_Req, dict[str, Any]]] = []
    ver = [r for r in reqs if r.kind == "verify"]
    entries = {str(e.get("id")): e for e in (res.get("legend") or {}).get("entries") or [] if isinstance(e, Mapping)}
    if ver and rep.status == "ok":
        verdicts = _verify(gw, org_id, ver, entries, read_file, rep)

    # ---- pass 2 with the readings
    final = res
    if readings:
        before = _level_docs(out_path(res))
        res2 = rerun({k: v for k, v in llm_args.items() if k != "collect"} | {"readings": readings})
        if res2 is not None:
            final = res2
            rep.second_pass = True
            used = [u for u in (res2.get("llmUsed") or []) if isinstance(u, str) and u in readings]
            rep.hard_text_applied = len(set(used))
            rep.llm_capped = cap_llm_derived(out_path(res2), before)

    # ---- apply the verdicts through calibration
    if verdicts:
        od = out_path(final)
        _apply_verdicts(od, verdicts, entries, green_threshold=green_threshold, raster=raster, rep=rep)
        final = {**final, "detectionStats": _det_stats(od) or final.get("detectionStats")}
    rep.cost_usd = round(rep.cost_usd, 6)
    rep.seconds = round(time.monotonic() - t0, 3)
    fields = {k: v for k, v in asdict(rep).items() if k != "reasons"} | {"org": org_id, "reasons": rep.reasons[:5]}
    log.info("llm_page %s", json.dumps(fields, ensure_ascii=True, sort_keys=True), extra={"llm": fields})
    return final, rep


def _verify(
    gw: Any, org_id: str, ver: list[_Req], entries: Mapping[str, Mapping[str, Any]], read_file: ReadFile, rep: PageReport
) -> list[tuple[_Req, dict[str, Any]]]:
    """Batches grouped so every call carries ≤ MAX_PREFIX legend rows (the shared, cached prefix)."""
    thumbs: dict[str, bytes] = {}
    for eid in sorted({r.legend_entry_id for r in ver if r.legend_entry_id}):
        e = entries.get(eid)
        if e is None or e.get("thumb") != f"legend/{eid}.webp":
            continue
        try:
            b = read_file(f"legend/{eid}.webp")
        except (OSError, ValueError):
            continue
        if b and len(b) <= MAX_CROP_BYTES:
            thumbs[eid] = b
    ver = [r for r in ver if r.legend_entry_id in thumbs]
    eids = sorted({str(r.legend_entry_id) for r in ver})
    # other_class may name any class of this sheet's legend (labels as data; images only for the matched rows)
    legend_classes = sorted(
        {(str(e["suggestedClass"])[:64], str(e.get("label") or "")[:60]) for e in entries.values() if e.get("suggestedClass")}
    )[:60]
    out: list[tuple[_Req, dict[str, Any]]] = []
    for k in range(0, len(eids), MAX_PREFIX):
        group = eids[k : k + MAX_PREFIX]
        refs = {eid: f"L{i + 1}" for i, eid in enumerate(group)}
        prefix = [
            PrefixImage(
                refs[eid],
                thumbs[eid],
                "legend_row",
                {"class": entries[eid].get("suggestedClass"), "label": str(entries[eid].get("label") or "")[:80]},
            )
            for eid in group
        ]
        items_r = [r for r in ver if r.legend_entry_id in refs]
        items = [
            BatchItem(r.id, r.png, "symbol", {"detectedClass": r.cls, "legendRef": refs[str(r.legend_entry_id)]}) for r in items_r
        ]
        rep.verify_sent += len(items)
        br = gw.call_batch(
            org_id, "verify_symbol", items, verify_item_schema([c for c, _ in legend_classes] + [str(r.cls) for r in items_r]),
            prefix=prefix, shared_vars={"legendClasses": [{"class": c, "label": lb} for c, lb in legend_classes]},
        )  # fmt: skip
        rep.add(br)
        out.extend((r, br.results[r.id]) for r in items_r if isinstance(br.results.get(r.id), Mapping))
        if br.status != "ok":
            break
    return out


# --------------------------------------------------------------------------------------------- artifacts
def _load(p: Path) -> dict[str, Any] | None:
    try:
        o = json.loads(gzip.decompress(p.read_bytes()))
    except (OSError, ValueError, EOFError):
        return None
    return o if isinstance(o, dict) else None


def _save(p: Path, obj: dict[str, Any]) -> None:
    p.write_bytes(gzip.compress(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode(), mtime=0))


def _level_docs(out_dir: Path) -> dict[str, dict[str, Any]]:
    return {n: d for n in LEVEL_FILES if (d := _load(out_dir / n)) is not None}


def _level_items(obj: Any) -> list[dict[str, Any]]:
    """Every dict carrying a ``level`` in a document (detections, link groups, text items, geometry lines…)."""
    found: list[dict[str, Any]] = []

    def walk(o: Any) -> None:
        if isinstance(o, dict):
            if o.get("level") in LEVEL_RANK:
                found.append(o)
            for v in o.values():
                if isinstance(v, dict | list):
                    walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(obj)
    return found


def _canon(it: Mapping[str, Any]) -> str:
    return json.dumps({k: v for k, v in it.items() if k not in _ID_KEYS}, ensure_ascii=False, sort_keys=True)


def _cap(it: dict[str, Any]) -> bool:
    reasons = [str(r) for r in it.get("reasons") or []]
    changed = False
    if R_LLM_TEXT not in reasons:
        reasons.append(R_LLM_TEXT)
        changed = True
    if it.get("level") == "green":
        it["level"] = "yellow"
        changed = True
    it["reasons"] = reasons
    return changed


def cap_llm_derived(out_dir: Path, before: Mapping[str, Mapping[str, Any]]) -> int:
    """Pass 2 differs from pass 1 only by the LLM readings: every leveled item that is new or changed is
    LLM-derived → at most yellow + :data:`R_LLM_TEXT`; link groups of such detections follow. Returns the count."""
    n = 0
    changed_dets: set[str] = set()
    for name in LEVEL_FILES:
        doc = _load(out_dir / name)
        if doc is None:
            continue
        old = {_canon(it) for it in _level_items(before.get(name) or {})}
        hit = 0
        for it in _level_items(doc):
            if name == "links.json.gz":
                continue
            if _canon(it) not in old:
                if name == "detections.json.gz" and isinstance(it.get("id"), str):
                    changed_dets.add(it["id"])
                hit += int(_cap(it))
        if name == "links.json.gz":
            for g in _level_items(doc):
                ids = {*(g.get("switchIds") or []), *(g.get("luminaireIds") or [])}
                if _canon(g) not in old or ids & changed_dets:
                    hit += int(_cap(g))
        if hit:
            _save(out_dir / name, doc)
            n += hit
    return n


def _apply_verdicts(
    out_dir: Path,
    verdicts: list[tuple[_Req, dict[str, Any]]],
    entries: Mapping[str, Mapping[str, Any]],
    *,
    green_threshold: float | None,
    raster: bool,
    rep: PageReport,
) -> None:
    doc = _load(out_dir / "detections.json.gz")
    if doc is None:
        return
    dets = [d for d in doc.get("detections") or [] if isinstance(d, dict)]
    by_id = {str(d.get("id")): d for d in dets}
    changed = False
    for r, ans in verdicts:
        d = by_id.get(str(r.detection_id))
        b = bbox_of(d.get("bboxMm")) if d is not None else None
        # the detection must still be the one that was verified (pass 2 may renumber / refine)
        if d is None or b is None or d.get("class") != r.cls or max(abs(b[i] - r.bbox[i]) for i in range(4)) > 1.0:
            continue
        verdict, conf = ans.get("verdict"), float(ans.get("confidence") or 0.0)
        if d.get("level") == "green" or conf < MIN_VERIFY_CONF:
            continue
        reasons = [str(x) for x in d.get("reasons") or []]
        if verdict == "agree":
            reasons.append(R_VERIFIED)
            cap, rep.verify_agree = "yellow", rep.verify_agree + 1
        elif verdict == "other_class":
            reasons.append(R_VERIFY_OTHER)
            cap, rep.verify_other = ("red" if conf >= RED_OTHER_CONF else "yellow"), rep.verify_other + 1
        else:
            reasons.append(R_VERIFY_UNSURE)
            cap, rep.verify_unsure = "yellow", rep.verify_unsure + 1
        cap = min_level(cap, str(d.get("level") or "red"))
        raw = d.get("scoreRaw", d.get("score", 0.0))
        score, level, reasons = calibrate(
            str(d.get("class") or "unknown"),
            float(raw) if isinstance(raw, int | float) else 0.0,
            reasons,
            level=cap,
            raster=raster,
            green_threshold=green_threshold,
        )
        if level == "green":  # cannot happen (cap ≤ yellow); belt and braces for SEC-33
            level = "yellow"
        d["score"], d["level"], d["reasons"] = score, level, reasons
        changed = True
    if changed:
        _save(out_dir / "detections.json.gz", doc)


def _det_stats(out_dir: Path) -> dict[str, Any] | None:
    doc = _load(out_dir / "detections.json.gz")
    if doc is None:
        return None
    from ..pipeline.understand import detection_stats

    return detection_stats([d for d in doc.get("detections") or [] if isinstance(d, dict)])


def report_json(rep: PageReport, model: str) -> dict[str, Any]:
    """The version artifact ``llm.json`` (``kamutan.llm/1``): counts, tokens, USD — never text or images."""
    d = asdict(rep)
    d["reasons"] = [str(r)[:80] for r in rep.reasons[:10]]
    return {"schema": "kamutan.llm/1", "model": model, **d}


__all__ = [
    "R_LLM_TEXT",
    "R_VERIFIED",
    "R_VERIFY_OTHER",
    "R_VERIFY_UNSURE",
    "PageReport",
    "after_understand",
    "cap_llm_derived",
    "prepare",
    "report_json",
]
