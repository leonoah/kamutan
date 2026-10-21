"""Sprint 5: conservative calibration — ``kbench calibrate``.

Builds the worker's calibration table (``kamutan.calibration/1``, docs/agents/SPRINT5_BRIEF.md §1) from DEV-split
predictions scored against the ground truth, plus a report (test plan "כיול (Calibration)"):

* **Split guard.** Every truth project must be listed as ``dev`` in the split file (``gt/splits.json``,
  ``kamutan.gt-splits/1``); a holdout project, or one that is not listed, is refused (``SplitError``). The holdout
  list is checked against its recorded sha256. Calibration never sees holdout data.
* **Items** (one per predicted item, before any human action):
  - symbols on the electrical / lighting truth sheets: every predicted symbol;
  - symbols on the plumbing / architecture truth sheets: the plumbing + hvac (fixture) classes only (the other
    classes are not annotated there);
  - rooms on the architecture truth sheets (domain ``tiling``): every predicted room polygon;
  - link groups on the link-truth sheets (class ``link:<kind>``, domain ``lighting``): every predicted group,
    correct = exact switch + luminaire sets of a non-disputed truth group (disputed groups excluded).
  A symbol is *correct* under the test-plan item definition (matched by centre distance, right class, lifecycle,
  floor; ``metrics.py``); *detection-correct* (matched with the right class) is reported next to it. A room is
  correct when it is matched (polygon IoU >= ``room_iou``), its area is within the flooring tolerance (2%) of the
  truth area and its floor is not wrong.
* **Stats per class and per domain** (electrical, lighting, plumbing (+ hvac), tiling): n, tp, fp, precision, two-sided
  Wilson LB 95% (z = 1.96), reliability data (10 equal-mass buckets), ECE, MCE, Brier, on the raw score and on the
  calibrated score (in-sample, and leave-one-sheet-out cross-validated).
* **Score maps.** Isotonic regression (pool-adjacent-violators, pure numpy) of correctness on the raw score, fitted
  on DEV only, per class and per domain when there are at least ``min_map_n`` scored items. The map is a list of
  breakpoints ``[[raw, calibrated], ...]`` (non-decreasing); apply it with linear interpolation, flat outside.
* **Green rule (conservative mode, < 30 GT projects).** ``greenAllowed`` only when n >= 200 AND precision == 1.0.
* **Ceiling rules (hard failures).** Over every predicted sheet: no green item on a raster sheet; every area item
  (room) red on a scale-conflict sheet.
* **Conservative check.** Greens the predictions already carry in classes the table does not allow (expected before
  the worker applies the table; must be 0 afterwards).

The table holds class statistics only (no project names, ids, coordinates or text).
"""

from __future__ import annotations

import hashlib
import itertools
import json
import math
from collections import Counter, defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np

from . import __version__
from .data import Project, load_classes
from .matching import MatchParams
from .metrics import EvalConfig
from .plumbing import fixture_classes
from .stats import Z95, reliability, wilson_lower, wilson_upper
from .worker import (
    WorkerEvalConfig,
    WorkerPredictions,
    _subset,
    evaluate_worker,
    find_artifacts,
    is_symbol,
    match_rooms,
    read_json_any,
)

TABLE_SCHEMA = "kamutan.calibration/1"
SPLITS_SCHEMA = "kamutan.gt-splits/1"
TABLE_DOMAINS = ("electrical", "lighting", "plumbing", "tiling")
DOMAIN_ALIAS = {"hvac": "plumbing"}  # AC drain points feed the plumbing chapter (3.01)
R_RASTER = "רסטר"
R_SCALE_CONFLICT = "קנה מידה סותר"
ALL_SYMBOL_DISCIPLINES = ("electrical", "lighting")
MAX_KNOTS = 256  # worker schema: scoreMap maxItems
FIXTURE_DISCIPLINES = ("plumbing", "architecture", "architecture_master")
ROOM_DISCIPLINES = ("architecture", "architecture_master")


class SplitError(ValueError):
    """A truth project is not on the DEV split (or the split file is inconsistent)."""


@dataclass(frozen=True)
class CalibrateConfig:
    center_tol_mm: float = 3.0
    room_iou: float = 0.5
    room_area_tol: float = 0.02
    n_bins: int = 10
    green_min_n: int = 200
    green_target: float = 0.98
    min_map_n: int = 30
    full_mode_min_projects: int = 30
    z: float = Z95


@dataclass
class CalItem:
    project_id: str
    sheet_id: str
    pred_id: str
    cls: str
    domain: str
    correct: bool
    detection_correct: bool
    score_raw: float | None
    score: float | None
    level: str | None
    reasons: list[str] = field(default_factory=list)


# ----------------------------------------------------------------------------- split guard


def load_splits(path: str | Path) -> dict[str, Any]:
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    if doc.get("schema") != SPLITS_SCHEMA:
        raise SplitError(f"{path}: expected schema {SPLITS_SCHEMA}, got {doc.get('schema')!r}")
    holdout = sorted(doc.get("holdout", []))
    want = hashlib.sha256(json.dumps(holdout).encode()).hexdigest()
    if doc.get("holdout_sha256") != want:
        raise SplitError(f"{path}: holdout_sha256 does not match the holdout list (split file edited without re-locking)")
    return doc


def check_dev(splits: dict[str, Any], project_id: str) -> None:
    if project_id in set(splits.get("holdout", [])):
        raise SplitError(f"project {project_id!r} is HOLDOUT: calibration must never read it")
    entry = (splits.get("projects") or {}).get(project_id)
    if entry is None:
        raise SplitError(f"project {project_id!r} is not in the split file: lock its split first")
    if entry.get("split") != "dev":
        raise SplitError(f"project {project_id!r} is on split {entry.get('split')!r}, calibration reads 'dev' only")


def project_id_of(truth: Project) -> str:
    pid = (truth.boq or {}).get("project_id") or next(
        (s.meta.get("project_id") for s in truth.sheets.values() if s.meta.get("project_id")), None
    )
    if not pid:
        raise SplitError(f"{truth.root}: truth has no project_id (boq_truth.json or sheet metadata)")
    return str(pid)


# ----------------------------------------------------------------------------- isotonic map


def isotonic_fit(
    x: Sequence[float] | np.ndarray, y: Sequence[float] | np.ndarray, max_knots: int = MAX_KNOTS
) -> list[list[float]]:
    """Pool-adjacent-violators fit of y (0/1) on x (clamped to [0, 1]); non-decreasing breakpoints [[x, f(x)], ...].

    Each pooled block contributes its lowest and highest raw score (one point if they coincide). More than
    ``max_knots`` points are thinned to an evenly spaced subset that keeps both ends (still monotone)."""
    xa = np.round(np.clip(np.asarray(x, dtype=float), 0.0, 1.0), 6)  # pool on the published precision
    ya = np.asarray(y, dtype=float)
    if len(xa) == 0:
        return []
    ux, inv = np.unique(xa, return_inverse=True)
    sums = np.bincount(inv, weights=ya)
    wts = np.bincount(inv).astype(float)
    blocks: list[list[float]] = []  # [sum, weight, xmin, xmax]
    for i in range(len(ux)):
        blocks.append([float(sums[i]), float(wts[i]), float(ux[i]), float(ux[i])])
        while len(blocks) >= 2 and blocks[-2][0] / blocks[-2][1] > blocks[-1][0] / blocks[-1][1] + 1e-12:
            s, w, _, hi = blocks.pop()
            blocks[-1][0] += s
            blocks[-1][1] += w
            blocks[-1][3] = hi
    pts: list[list[float]] = []
    for s, w, lo, hi in blocks:
        v = round(s / w, 6)
        for xv in (lo, hi) if hi > lo else (lo,):
            xr = round(xv, 6)
            if pts and pts[-1][0] == xr:
                pts[-1][1] = max(pts[-1][1], v)
            else:
                pts.append([xr, v])
    if len(pts) > max_knots:
        keep = sorted({round(i * (len(pts) - 1) / (max_knots - 1)) for i in range(max_knots)})
        pts = [pts[i] for i in keep]
    return pts


def apply_score_map(points: Sequence[Sequence[float]] | None, x: Sequence[float] | float) -> np.ndarray:
    """Calibrated score: linear interpolation between breakpoints, flat outside; identity without a map."""
    xa = np.asarray(x, dtype=float)
    if not points:
        return xa
    xp = np.asarray([p[0] for p in points], dtype=float)
    fp = np.asarray([p[1] for p in points], dtype=float)
    return np.interp(xa, xp, fp)


# ----------------------------------------------------------------------------- items


def table_domain(cls: str, classes: dict[str, dict[str, Any]]) -> str:
    if cls == "room":
        return "tiling"
    if cls.startswith("link:"):
        return "lighting"
    dom = str(classes.get(cls, {}).get("domain") or "other")
    return DOMAIN_ALIAS.get(dom, dom)


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _symbol_items(
    pid: str, truth: Project, preds: WorkerPredictions, sheets: list[str], keep, cfg: CalibrateConfig, classes: dict
) -> tuple[list[CalItem], dict[str, Any]]:
    if not sheets:
        return [], {}
    t_sub = _subset(truth, sheets, keep)
    p_sub = _subset(preds.project, sheets, keep)
    wp = WorkerPredictions(project=p_sub, sources={s: preds.sources[s] for s in sheets if s in preds.sources})
    wcfg = WorkerEvalConfig(
        base=EvalConfig(match=MatchParams(center_tol_mm=cfg.center_tol_mm, mode="center"), exclude_disputed=False)
    )
    m = evaluate_worker(t_sub, wp, wcfg, {})
    by_id = {f.id: f for f in p_sub.all_features()}
    out = []
    for it in m["symbols"]["items"]:
        f = by_id.get(it["pred_id"])
        raw = _num(f.get("score_raw")) if f is not None else None
        out.append(
            CalItem(
                project_id=pid,
                sheet_id=it["sheet_id"],
                pred_id=it["pred_id"],
                cls=it["cls"],
                domain=table_domain(it["cls"], classes),
                correct=bool(it["correct"]),
                detection_correct=not ({"unmatched", "class"} & set(it["reasons"])),
                score_raw=raw if raw is not None else _num(it.get("confidence")),
                score=_num(it.get("confidence")),
                level=it.get("level"),
                reasons=list(it["reasons"]),
            )
        )
    det = m["symbols"]["detection"]
    return out, {"sheets": m["sheets"]["symbols"], "per_class": det.get("per_class", {}), "micro": det.get("micro")}


def _room_items(pid: str, truth: Project, preds: WorkerPredictions, cfg: CalibrateConfig) -> tuple[list[CalItem], dict]:
    out: list[CalItem] = []
    sheets = []
    for sid, sh in sorted(truth.sheets.items()):
        if sh.meta.get("discipline") not in ROOM_DISCIPLINES:
            continue
        gts = [f for f in sh.features if f.cls == "room" and f.geom_type == "Polygon"]
        psh = preds.project.sheets.get(sid)
        prs = [f for f in (psh.features if psh else []) if f.cls == "room" and f.geom_type == "Polygon"]
        if not gts or not prs:
            continue
        sheets.append(sid)
        rm = match_rooms(gts, prs, cfg.room_iou, sh.scale)
        pair_of = {p["pred"]: p for p in rm.pairs}
        for f in prs:
            reasons: list[str] = []
            p = pair_of.get(f.id)
            if p is None:
                reasons.append("unmatched")
            else:
                if p["area_pe"] is None:
                    reasons.append("quantity_unknown")
                elif p["area_pe"] > cfg.room_area_tol + 1e-9:
                    reasons.append("quantity")
                if p["floor_correct"] is False:
                    reasons.append("floor")
            raw = _num(f.get("score_raw"))
            out.append(
                CalItem(
                    project_id=pid,
                    sheet_id=sid,
                    pred_id=f.id,
                    cls="room",
                    domain="tiling",
                    correct=not reasons,
                    detection_correct=p is not None,
                    score_raw=raw if raw is not None else _num(f.get("confidence")),
                    score=_num(f.get("confidence")),
                    level=f.get("level"),
                    reasons=reasons,
                )
            )
    return out, {"sheets": sheets}


def link_key(kind: str | None) -> str:
    """Class key of a link group in the table (worker ``calibration.link_key``)."""
    return f"link:{kind or 'unknown'}"


def _link_items(pid: str, truth: Project, preds: WorkerPredictions, cfg: CalibrateConfig) -> tuple[list[CalItem], dict]:
    """Predicted link groups on the link-truth sheets: correct = exactly the switch set AND luminaire set of a
    non-disputed truth group. Groups touching a disputed truth group are excluded (as in ``eval-links``)."""
    from .links import group_from_dict, load_pred_links, load_truth_links, map_detections

    if truth.root is None or preds.project.root is None:
        return [], {"sheets": []}
    docs = load_truth_links(truth.root)
    if not docs:
        return [], {"sheets": []}
    pl = load_pred_links(preds.project.root, set(docs))
    closed = {
        str(d.get("id")) for d in (truth.disputes or {}).get("disputes", []) if d.get("status") in ("resolved", "withdrawn")
    }
    out: list[CalItem] = []
    sheets = []
    for sid, doc in sorted(docs.items()):
        if sid not in pl.groups:
            continue
        sheets.append(sid)
        tg = [group_from_dict(g) for g in doc.get("groups", [])]
        disputed_ids: set[str] = set()
        for g in tg:
            if g.dispute_id and g.dispute_id not in closed:
                disputed_ids |= g.ids
        gate = [g for g in tg if not (g.dispute_id and g.dispute_id not in closed)]
        id_map = map_detections(
            truth.sheets[sid].features if sid in truth.sheets else [], pl.detections.get(sid, []), cfg.center_tol_mm
        )
        for raw in pl.groups[sid]:
            p = group_from_dict(raw, id_map)
            if p.ids & disputed_ids:
                continue
            ok = any(p.switches == g.switches and p.luminaires == g.luminaires for g in gate)
            score = _num(raw.get("scoreRaw", raw.get("confidence")))
            out.append(
                CalItem(
                    project_id=pid,
                    sheet_id=sid,
                    pred_id=f"{sid}:{p.id}",
                    cls=link_key(p.kind),
                    domain="lighting",
                    correct=ok,
                    detection_correct=ok,
                    score_raw=score,
                    score=_num(raw.get("confidence")),
                    level=p.level,
                    reasons=[] if ok else ["group_not_exact"],
                )
            )
    return out, {"sheets": sheets}


def collect_items(truth: Project, preds: WorkerPredictions, cfg: CalibrateConfig | None = None) -> tuple[list[CalItem], dict]:
    cfg = cfg or CalibrateConfig()
    classes = load_classes()
    pid = project_id_of(truth)
    with_det = {sid for sid, src in preds.sources.items() if "detections" in src}

    def disc(sid: str) -> str:
        return str(truth.sheets[sid].meta.get("discipline") or "")

    sym_truth = [sid for sid, sh in sorted(truth.sheets.items()) if any(is_symbol(f) for f in sh.features)]
    a_sheets = [s for s in sym_truth if disc(s) in ALL_SYMBOL_DISCIPLINES and s in with_det]
    b_sheets = [s for s in sym_truth if disc(s) in FIXTURE_DISCIPLINES and s in with_det]
    fx = fixture_classes()
    a_items, a_meta = _symbol_items(pid, truth, preds, a_sheets, is_symbol, cfg, classes)
    b_items, b_meta = _symbol_items(pid, truth, preds, b_sheets, lambda f: is_symbol(f) and f.cls in fx, cfg, classes)
    r_items, r_meta = _room_items(pid, truth, preds, cfg)
    l_items, l_meta = _link_items(pid, truth, preds, cfg)
    meta = {
        "project_id": pid,
        "scopes": {
            "symbols_all_classes": a_meta.get("sheets", []),
            "symbols_fixture_classes": b_meta.get("sheets", []),
            "rooms": r_meta["sheets"],
            "link_groups": l_meta["sheets"],
        },
        "truth_sheets_without_predictions": sorted(set(sym_truth) - with_det),
    }
    return a_items + b_items + r_items + l_items, meta


# ----------------------------------------------------------------------------- stats


def _scored(items: Sequence[CalItem]) -> tuple[list[CalItem], np.ndarray, np.ndarray]:
    sc = [it for it in items if it.score_raw is not None]
    return sc, np.asarray([it.score_raw for it in sc], dtype=float), np.asarray([it.correct for it in sc], dtype=float)


def _rel(scores: Sequence[float] | np.ndarray, correct: Sequence[float] | np.ndarray, n_bins: int) -> dict[str, Any]:
    r = reliability(list(map(float, scores)), [bool(c) for c in correct], n_bins)
    return {"n": r["n"], "ece": r["ece"], "mce": r["mce"], "brier": r["brier"], "bins": r["bins"]}


def bucket_stats(items: Sequence[CalItem], cfg: CalibrateConfig, mode: str = "conservative") -> dict[str, Any]:
    n = len(items)
    tp = sum(1 for it in items if it.correct)
    lb = wilson_lower(tp, n, cfg.z)
    if mode == "conservative":
        allowed = n >= cfg.green_min_n and tp == n
    else:
        allowed = lb is not None and lb >= cfg.green_target
    return {
        "n": n,
        "tp": tp,
        "fp": n - tp,
        "precision": (tp / n) if n else None,
        "wilsonLb": None if lb is None else round(lb, 6),
        "greenAllowed": bool(allowed),
    }


def fit_maps(items: Sequence[CalItem], cfg: CalibrateConfig) -> tuple[dict[str, list], dict[str, list]]:
    by_c: dict[str, list[CalItem]] = defaultdict(list)
    by_d: dict[str, list[CalItem]] = defaultdict(list)
    for it in items:
        by_c[it.cls].append(it)
        by_d[it.domain].append(it)
    cmaps: dict[str, list] = {}
    dmaps: dict[str, list] = {}
    for key, group, dst in [(k, v, cmaps) for k, v in by_c.items()] + [(k, v, dmaps) for k, v in by_d.items()]:
        _, x, y = _scored(group)
        if len(x) >= cfg.min_map_n:
            pts = isotonic_fit(x, y)
            if len(pts) >= 2:  # worker schema: a map has >= 2 knots (a constant map is no map)
                dst[key] = pts
    return cmaps, dmaps


def calibrated(it: CalItem, cmaps: dict[str, list], dmaps: dict[str, list], domain_fallback: bool = False) -> float | None:
    """As the worker applies the table: the class map, else the raw score (``domain_fallback``: else the domain map)."""
    if it.score_raw is None:
        return None
    m = cmaps.get(it.cls) or (dmaps.get(it.domain) if domain_fallback else None)
    return float(apply_score_map(m, it.score_raw)) if m else it.score_raw


def loso_calibrated(items: Sequence[CalItem], cfg: CalibrateConfig, domain_fallback: bool = False) -> list[float | None]:
    """Leave-one-sheet-out calibrated scores (maps fitted without the item's sheet): an honest ECE estimate."""
    out: list[float | None] = [None] * len(items)
    keys = sorted({(it.project_id, it.sheet_id) for it in items})
    for key in keys:
        train = [it for it in items if (it.project_id, it.sheet_id) != key]
        cm, dm = fit_maps(train, cfg)
        for i, it in enumerate(items):
            if (it.project_id, it.sheet_id) == key:
                out[i] = calibrated(it, cm, dm, domain_fallback)
    return out


def _cal_block(items: Sequence[CalItem], cal: Sequence[float | None], cv: Sequence[float | None], n_bins: int) -> dict:
    idx = [i for i, it in enumerate(items) if it.score_raw is not None]
    y = [float(items[i].correct) for i in idx]
    raw = [float(items[i].score_raw) for i in idx]  # type: ignore[arg-type]
    return {
        "raw": _rel(raw, y, n_bins),
        "calibrated_in_sample": _rel([float(cal[i]) for i in idx], y, n_bins),  # type: ignore[arg-type]
        "calibrated_loso_cv": _rel([float(cv[i]) for i in idx], y, n_bins),  # type: ignore[arg-type]
    }


def _detail(items: Sequence[CalItem], cfg: CalibrateConfig) -> dict[str, Any]:
    n = len(items)
    kd = sum(1 for it in items if it.detection_correct)
    greens = [it for it in items if it.level == "green"]
    kg = sum(1 for it in greens if it.correct)
    return {
        "detection_correct": {"k": kd, "p": (kd / n) if n else None, "wilson_lb95": wilson_lower(kd, n, cfg.z)},
        "wilson_ub95": wilson_upper(sum(1 for it in items if it.correct), n, cfg.z),
        "levels": dict(Counter(str(it.level) for it in items)),
        "green": {"n": len(greens), "correct": kg, "wilson_lb95": wilson_lower(kg, len(greens), cfg.z)},
        "errors": dict(Counter(r for it in items for r in it.reasons)),
        "n_scored": sum(1 for it in items if it.score_raw is not None),
    }


# ----------------------------------------------------------------------------- ceiling rules


def _sheet_docs(root: Path) -> dict[str, dict[str, Any]]:
    """Worker sheet id -> {raster, scale_conflict} from the sheet docs (``_firestore``) and ``dev-index.json``."""
    docs: dict[str, dict[str, Any]] = {}

    def add(sid: str, d: dict[str, Any]) -> None:
        reasons = list(((d.get("classification") or {}).get("reasons")) or [])
        cur = docs.setdefault(sid, {"raster": False, "scale_conflict": False})
        cur["raster"] |= R_RASTER in reasons or d.get("inputType") == "raster"
        cur["scale_conflict"] |= R_SCALE_CONFLICT in reasons or d.get("scaleConflict") is True

    for p in root.rglob("*.json"):
        if p.parent.name == "sheets" and "_firestore" in p.parts:
            try:
                add(p.stem, json.loads(p.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                continue
    idx = root / "dev-index.json"
    if idx.exists():
        try:
            for e in json.loads(idx.read_text(encoding="utf-8")):
                if isinstance(e, dict) and e.get("sheetId"):
                    add(str(e["sheetId"]), e)
        except (OSError, ValueError):
            pass
    return docs


def ceiling_checks(root: str | Path) -> dict[str, Any]:
    """Raster -> never green; scale conflict -> every area item (room) red. Over all predicted sheets."""
    root = Path(root)
    docs = _sheet_docs(root)
    violations: list[dict[str, Any]] = []
    raster_sheets: set[str] = set()
    conflict_sheets: set[str] = set()
    dets = find_artifacts(root, "detections.json.gz")
    rooms = find_artifacts(root, "rooms.json.gz")
    for sid in sorted(set(dets) | set(rooms)):
        flags = docs.get(sid, {"raster": False, "scale_conflict": False})
        det_list = list((read_json_any(dets[sid]).get("detections") or []) if sid in dets else [])
        room_list = list((read_json_any(rooms[sid]).get("rooms") or []) if sid in rooms else [])
        raster = bool(flags["raster"]) or any(R_RASTER in (d.get("reasons") or []) for d in det_list)
        if raster:
            raster_sheets.add(sid)
            for d in det_list + room_list:
                if d.get("level") == "green":
                    violations.append({"rule": "raster_sheet_green", "sheet": sid, "item": d.get("id")})
        if flags["scale_conflict"]:
            conflict_sheets.add(sid)
            for r in room_list:
                if r.get("level") != "red":
                    violations.append({"rule": "scale_conflict_area_not_red", "sheet": sid, "item": r.get("id")})
    return {
        "n_sheets_checked": len(set(dets) | set(rooms)),
        "raster_sheets": sorted(raster_sheets),
        "scale_conflict_sheets": sorted(conflict_sheets),
        "violations": violations,
        "pass": not violations,
    }


# ----------------------------------------------------------------------------- table + report


def table_version(gt_version: str | None, digest: str) -> str:
    """``cal-<gt version>-<content hash>``, restricted to the worker schema's ``^[A-Za-z0-9._-]+$`` (<= 64)."""
    gv = "".join(ch if ch.isalnum() or ch in "._-" else "-" for ch in (gt_version or "gt-unknown"))
    return f"cal-{gv}"[: 64 - len(digest) - 1] + f"-{digest}"


def check_table(table: dict[str, Any], schema: dict[str, Any] | None = None) -> list[str]:
    """Semantic checks of a table (+ JSON schema when given): tp + fp = n, monotone maps in [0, 1], green rule."""
    errs: list[str] = []
    if schema is not None:
        import jsonschema

        errs += [
            f"schema: {e.message} at {'/'.join(map(str, e.path))}" for e in jsonschema.Draft7Validator(schema).iter_errors(table)
        ]
    for part in ("classes", "domains"):
        for k, st in (table.get(part) or {}).items():
            if st["tp"] + st["fp"] != st["n"]:
                errs.append(f"{part}.{k}: tp + fp != n")
            sm = st.get("scoreMap")
            if sm is not None:
                if len(sm) < 2:
                    errs.append(f"{part}.{k}: scoreMap needs >= 2 knots")
                if any(not (0 <= a <= 1 and 0 <= b <= 1) for a, b in sm):
                    errs.append(f"{part}.{k}: scoreMap outside [0, 1]")
                if any(b[0] < a[0] or b[1] < a[1] for a, b in itertools.pairwise(sm)):
                    errs.append(f"{part}.{k}: scoreMap not non-decreasing")
            if table.get("mode") == "conservative" and st["greenAllowed"] and (st["n"] < 200 or st["fp"] != 0):
                errs.append(f"{part}.{k}: greenAllowed violates the conservative rule")
    return errs


LINK_KINDS = ("single", "two_way", "shared", "sensor", "add_to_existing")


def _taxonomy_classes(classes: dict[str, dict[str, Any]]) -> list[str]:
    keys = {c for c, v in classes.items() if DOMAIN_ALIAS.get(str(v.get("domain")), str(v.get("domain"))) in TABLE_DOMAINS}
    keys.discard("unknown")
    return sorted(keys | {link_key(k) for k in LINK_KINDS})


def calibrate(
    items: Sequence[CalItem],
    cfg: CalibrateConfig | None = None,
    *,
    gt_version: str | None = None,
    n_projects: int = 1,
    generated_at: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """(table, report) from DEV items."""
    cfg = cfg or CalibrateConfig()
    items = list(items)
    mode = "full" if n_projects >= cfg.full_mode_min_projects else "conservative"
    classes = load_classes()
    cmaps, dmaps = fit_maps(items, cfg)
    cal = [calibrated(it, cmaps, dmaps) for it in items]
    cv = loso_calibrated(items, cfg)
    cal_d = [calibrated(it, cmaps, dmaps, True) for it in items]
    cv_d = loso_calibrated(items, cfg, True)
    by_c: dict[str, list[int]] = defaultdict(list)
    by_d: dict[str, list[int]] = defaultdict(list)
    for i, it in enumerate(items):
        by_c[it.cls].append(i)
        by_d[it.domain].append(i)

    t_classes: dict[str, Any] = {}
    r_classes: dict[str, Any] = {}
    for c in sorted(set(_taxonomy_classes(classes)) | set(by_c)):
        sub = [items[i] for i in by_c.get(c, [])]
        t_classes[c] = bucket_stats(sub, cfg, mode) | {"scoreMap": cmaps.get(c)}
        r_classes[c] = {
            "domain": table_domain(c, classes),
            **_detail(sub, cfg),
            **_cal_block(sub, [cal[i] for i in by_c.get(c, [])], [cv[i] for i in by_c.get(c, [])], cfg.n_bins),
        }
    t_domains: dict[str, Any] = {}
    r_domains: dict[str, Any] = {}
    for d in TABLE_DOMAINS:
        ids = by_d.get(d, [])
        sub = [items[i] for i in ids]
        t_domains[d] = bucket_stats(sub, cfg, mode) | {"scoreMap": dmaps.get(d)}
        # domain rows: what the domain map would do (the worker applies class maps only, see report["overall"])
        r_domains[d] = _detail(sub, cfg) | _cal_block(sub, [cal_d[i] for i in ids], [cv_d[i] for i in ids], cfg.n_bins)
    other = sorted(set(by_d) - set(TABLE_DOMAINS))

    body = {"classes": t_classes, "domains": t_domains}
    digest = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()[:12]
    n_proj = len({it.project_id for it in items})
    table = {
        "schema": TABLE_SCHEMA,
        "version": table_version(gt_version, digest),
        "mode": mode,
        "generatedAt": generated_at or datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "gtVersion": gt_version,
        "source": f"kbench calibrate {__version__}: DEV split only, {n_proj} project(s), {len(items)} predicted items"[:300],
        "rule": (
            f"{mode}: greenAllowed only for classes with >= {cfg.green_min_n} DEV items and precision 1.0"
            if mode == "conservative"
            else f"full: greenAllowed when the Wilson LB95 >= {cfg.green_target}"
        )
        + f"; correct = test-plan item definition; scoreMap = isotonic P(correct | raw) on DEV, >= {cfg.min_map_n} scored items",
        "notes": [
            "symbols: centre distance <= 3 mm paper, right class, lifecycle and floor; rooms: IoU >= 0.5, area PE <= 2%, floor",
            "domains: hvac (AC drain points) is pooled into plumbing; a class missing here is never green",
        ],
        **body,
    }
    greens = [it for it in items if it.level == "green"]
    disallowed = [it for it in greens if not t_classes.get(it.cls, {}).get("greenAllowed")]
    report = {
        "mode": mode,
        "config": cfg.__dict__,
        "n_items": len(items),
        "overall": _detail(items, cfg) | _cal_block(items, cal, cv, cfg.n_bins) | bucket_stats(items, cfg, mode),
        "overall_with_domain_fallback": _cal_block(items, cal_d, cv_d, cfg.n_bins),
        "classes": r_classes,
        "domains": r_domains,
        "domains_not_in_table": other,
        "conservative_check": {
            "n_green": len(greens),
            "n_green_in_disallowed_classes": len(disallowed),
            "by_class": dict(Counter(it.cls for it in disallowed)),
            "note": "greens the predictions carry in classes without greenAllowed; must be 0 once the worker applies the table",
        },
    }
    return table, report


def _f(v: Any, nd: int = 3) -> str:
    if v is None:
        return "-"
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, float):
        return f"{v:.{nd}f}"
    return str(v)


def render_calibration_markdown(table: dict[str, Any], report: dict[str, Any]) -> str:
    L = [
        "# kbench calibrate — conservative calibration (DEV only)",
        "",
        (
            f"Table `{table['schema']}` version `{table['version']}`, mode **{table['mode']}**, GT `{table['gtVersion']}`, "
            f"generated {table['generatedAt']}."
        ),
    ]
    sp = report.get("split") or {}
    if sp:
        L += [
            (
                f"Split file `{sp.get('path')}` ({sp.get('split_version')}): DEV projects {sp.get('dev_projects')}; holdout "
                f"{sp.get('n_holdout')} project(s) (sha256 {str(sp.get('holdout_sha256'))[:12]}…), not read."
            )
        ]
    L += [
        "",
        (
            "Rule (conservative mode): green allowed only for classes with n >= 200 DEV items and precision 1.0. "
            "Correct = test-plan item definition (class + lifecycle + floor; rooms: IoU >= 0.5, area PE <= 2%, floor)."
        ),
        "",
        "## Per class",
        "",
        "| class | domain | n | tp | fp | precision | Wilson LB | greenAllowed | det. P | greens (ok) | ECE raw | ECE cv | map |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for c, t in table["classes"].items():
        r = report["classes"][c]
        if not t["n"]:
            continue
        L.append(
            f"| {c} | {r['domain']} | {t['n']} | {t['tp']} | {t['fp']} | {_f(t['precision'])} | {_f(t['wilsonLb'])} | "
            f"{_f(t['greenAllowed'])} | {_f(r['detection_correct']['p'])} | {r['green']['n']} ({r['green']['correct']}) | "
            f"{_f(r['raw']['ece'])} | {_f(r['calibrated_loso_cv']['ece'])} | {'yes' if t['scoreMap'] else '-'} |"
        )
    empty = [c for c, t in table["classes"].items() if not t["n"]]
    L += [
        "",
        f"Classes with no DEV items (greenAllowed = no, no map): {', '.join(empty) or '-'}",
        "",
        "## Per domain",
        "",
        "Calibrated columns apply the domain map (the worker applies class maps only; see the what-if line below).",
        "",
    ]
    L += [
        (
            "| domain | n | tp | precision | Wilson LB | greenAllowed | ECE raw | MCE raw | Brier raw | ECE in-sample | "
            "ECE cv | MCE cv | Brier cv | map |"
        ),
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for d, t in table["domains"].items():
        r = report["domains"][d]
        L.append(
            f"| {d} | {t['n']} | {t['tp']} | {_f(t['precision'])} | {_f(t['wilsonLb'])} | {_f(t['greenAllowed'])} | "
            f"{_f(r['raw']['ece'])} | {_f(r['raw']['mce'])} | {_f(r['raw']['brier'])} | "
            f"{_f(r['calibrated_in_sample']['ece'])} | {_f(r['calibrated_loso_cv']['ece'])} | "
            f"{_f(r['calibrated_loso_cv']['mce'])} | {_f(r['calibrated_loso_cv']['brier'])} | "
            f"{'yes' if t['scoreMap'] else '-'} |"
        )
    o = report["overall"]
    L += [
        "",
        f"## Overall (n = {report['n_items']}, scored {o['n_scored']})",
        "",
        f"- precision {_f(o['precision'])}, Wilson LB {_f(o['wilsonLb'])}; detection-correct {_f(o['detection_correct']['p'])}",
        f"- raw score: ECE {_f(o['raw']['ece'])}, MCE {_f(o['raw']['mce'])}, Brier {_f(o['raw']['brier'])}",
        (
            f"- calibrated (in-sample): ECE {_f(o['calibrated_in_sample']['ece'])}, MCE {_f(o['calibrated_in_sample']['mce'])}, "
            f"Brier {_f(o['calibrated_in_sample']['brier'])}"
        ),
        (
            f"- calibrated (leave-one-sheet-out): ECE {_f(o['calibrated_loso_cv']['ece'])}, "
            f"MCE {_f(o['calibrated_loso_cv']['mce'])}, Brier {_f(o['calibrated_loso_cv']['brier'])}"
        ),
        (
            f"- what-if (worker falls back to the domain map when a class has none): in-sample ECE "
            f"{_f(report['overall_with_domain_fallback']['calibrated_in_sample']['ece'])}, leave-one-sheet-out ECE "
            f"{_f(report['overall_with_domain_fallback']['calibrated_loso_cv']['ece'])}, MCE "
            f"{_f(report['overall_with_domain_fallback']['calibrated_loso_cv']['mce'])}, Brier "
            f"{_f(report['overall_with_domain_fallback']['calibrated_loso_cv']['brier'])}"
        ),
        (
            f"- levels {o['levels']}; current greens {o['green']['n']} ({o['green']['correct']} correct, Wilson LB "
            f"{_f(o['green']['wilson_lb95'])}); errors {o['errors']}"
        ),
        "",
        "### Reliability (raw score, 10 equal-mass buckets)",
        "",
        "| bucket | n | score range | mean score | accuracy | gap |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for i, b in enumerate(o["raw"]["bins"], 1):
        L.append(
            f"| {i} | {b['n']} | {b['score_min']:.3f}–{b['score_max']:.3f} | {b['conf']:.3f} | {b['acc']:.3f} | "
            f"{abs(b['acc'] - b['conf']):.3f} |"
        )
    cc = report["conservative_check"]
    ce = report.get("ceiling") or {}
    L += [
        "",
        "## Checks",
        "",
        (
            f"- Ceiling rules ({ce.get('n_sheets_checked', '-')} predicted sheets; raster {ce.get('raster_sheets')}, "
            f"scale conflict {ce.get('scale_conflict_sheets')}): **{'PASS' if ce.get('pass', True) else 'FAIL'}**, "
            f"{len(ce.get('violations', []))} violation(s)."
        ),
        (
            f"- Conservative check: {cc['n_green_in_disallowed_classes']} of {cc['n_green']} current greens are in classes "
            f"without greenAllowed {cc['by_class']} ({cc['note']})."
        ),
    ]
    if report.get("scopes"):
        L += ["", "## Scope", "", f"- {json.dumps(report['scopes'], ensure_ascii=False)}"]
    L += [
        "",
        (
            "Statistical note: the green target (Wilson LB >= 0.98) needs >= 189 green items with zero errors; with one DEV "
            "project it is not provable. The figures above are DEV in-sample (the cv column is leave-one-sheet-out)."
        ),
        "",
    ]
    return "\n".join(L)
