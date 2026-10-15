"""Adapters for the drawing worker's Sprint-2 artifacts + the evaluation built on them.

The worker writes, per sheet version (gzip JSON, see docs/agents/SPRINT2_BRIEF.md):

- ``detections.json.gz``  schema ``kamutan.detections/1``  -> point predictions
- ``rooms.json.gz``       schema ``kamutan.rooms/1``       -> room polygon predictions
- ``legend.json.gz``      schema ``kamutan.legend/1``      -> legend rows (optional)

``kbench eval --truth T --pred-detections DIR`` accepts either ``DIR/<sheet>/detections.json.gz`` or the
worker's storage layout ``DIR/**/sheets/<sheetId>/versions/<v>/detections.json.gz`` (newest version wins).
Worker sheet ids such as ``noah-eb8be8a3-p0`` are mapped to truth sheet ids (``eb8be8a3``) when the truth
id occurs in the worker id.

Evaluation (all coordinates paper mm, y down):

- symbols: centre-distance matching (default 3 mm) per class, P/R/F1, confusion; items-correct; the
  same at *symbol level* (truth ``symbol_class`` = the legend glyph, which is what legend-conditioned
  spotting can see); count error per floor and class; green-bucket precision with the Wilson bound
  (both the test-plan item definition and a detection-only definition); review burden.
- rooms: Hungarian matching on polygon IoU (default >= 0.5), IoU, area error, name accuracy. Matched
  predicted room ids are rewritten to truth ids so that each detection's ``roomId`` can be scored.
- legend: rows matched by symbol-box centre distance (default 4 mm) or predicted centre inside the truth
  symbol box; class and label accuracy.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import math
import re
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import numpy as np
from scipy.optimize import linear_sum_assignment

from .data import Feature, Project, Sheet
from .metrics import EvalConfig, evaluate
from .stats import wilson_lower, wilson_upper

DETECTIONS_SCHEMA = "kamutan.detections/1"
ROOMS_SCHEMA = "kamutan.rooms/1"
LEGEND_SCHEMA = "kamutan.legend/1"
_HEX8 = re.compile(r"[0-9a-f]{8}")


# ----------------------------------------------------------------------------- loading


def read_json_any(path: Path) -> Any:
    raw = path.read_bytes()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return json.loads(raw.decode("utf-8"))


def _sheet_dir_name(path: Path, root: Path) -> str:
    """Sheet folder of an artifact: the part after ``sheets/`` if present, else the parent folder."""
    rel = path.relative_to(root).parts[:-1]
    if "sheets" in rel:
        i = len(rel) - 1 - rel[::-1].index("sheets")
        if i + 1 < len(rel):
            return rel[i + 1]
    if len(rel) >= 2 and rel[-2] == "versions":
        return rel[-3] if len(rel) >= 3 else rel[-1]
    return rel[-1] if rel else path.stem


def find_artifacts(root: str | Path, name: str) -> dict[str, Path]:
    """{worker sheet folder name: newest artifact path}."""
    root = Path(root)
    found: dict[str, Path] = {}
    for p in sorted(root.rglob(name)):
        key = _sheet_dir_name(p, root)
        if key not in found or p.stat().st_mtime > found[key].stat().st_mtime:
            found[key] = p
    return found


def map_sheet_id(worker_id: str, truth_ids: set[str], sheet_map: dict[str, str] | None = None) -> str:
    if sheet_map and worker_id in sheet_map:
        return sheet_map[worker_id]
    if worker_id in truth_ids:
        return worker_id
    hits = [t for t in truth_ids if t and t in worker_id]
    if len(hits) == 1:
        return hits[0]
    m = _HEX8.search(worker_id)
    return m.group(0) if m else worker_id


def _pt(d: dict[str, Any] | None) -> tuple[float, float] | None:
    if not d:
        return None
    return float(d["x"]), float(d["y"])


def detections_to_features(obj: dict[str, Any], sheet_id: str) -> list[Feature]:
    if obj.get("schema") != DETECTIONS_SCHEMA:
        raise ValueError(f"{sheet_id}: expected schema {DETECTIONS_SCHEMA}, got {obj.get('schema')!r}")
    feats = []
    for d in obj.get("detections", []):
        c = _pt(d.get("centerMm"))
        if c is None:
            b = d.get("bboxMm") or {}
            c = (float(b["x"]) + float(b["w"]) / 2, float(b["y"]) + float(b["h"]) / 2)
        cls = str(d.get("class") or "unknown")
        props = {
            "id": f"{sheet_id}:{d.get('id')}",
            "class": cls,
            "symbol_class": cls,
            "kind": "symbol",
            "floor": d.get("floor"),
            "lifecycle": d.get("lifecycle"),
            "supply": d.get("supply"),
            "room_id": d.get("roomId"),
            "legend_entry": d.get("legendEntryId"),
            "confidence": d.get("score"),
            "level": d.get("level"),
            "reasons": d.get("reasons", []),
            "annotations": d.get("annotations", []),
            "cluster_id": d.get("clusterId"),
            "bbox_mm": d.get("bboxMm"),
            "angle_deg": d.get("angleDeg"),
            "boq_code": None,
        }
        feats.append(Feature(id=props["id"], sheet_id=sheet_id, cls=cls, geom_type="Point", coords=[c[0], c[1]], props=props))
    return feats


def rooms_to_features(obj: dict[str, Any], sheet_id: str) -> list[Feature]:
    if obj.get("schema") != ROOMS_SCHEMA:
        raise ValueError(f"{sheet_id}: expected schema {ROOMS_SCHEMA}, got {obj.get('schema')!r}")
    feats = []
    for r in obj.get("rooms", []):
        ring = [[float(p["x"]), float(p["y"])] for p in r.get("polygonMm", [])]
        if len(ring) < 3:
            continue
        if ring[0] != ring[-1]:
            ring.append(list(ring[0]))
        props = {
            "id": f"{sheet_id}:{r.get('id')}",
            "worker_room_id": r.get("id"),
            "class": "room",
            "kind": "area",
            "name": r.get("name"),
            "floor": r.get("floor"),
            "area_m2": r.get("areaM2"),
            "quantity": r.get("areaM2"),
            "perimeter_m": r.get("perimeterM"),
            "type": r.get("type"),
            "wet": r.get("wet"),
            "openings": r.get("openings") or [],
            "external_corners": r.get("externalCorners"),
            "walls": r.get("walls") or [],
            "confidence": r.get("confidence"),
            "level": r.get("level"),
            "reasons": r.get("reasons", []),
            "lifecycle": "new",
        }
        feats.append(Feature(id=props["id"], sheet_id=sheet_id, cls="room", geom_type="Polygon", coords=[ring], props=props))
    return feats


@dataclass
class WorkerPredictions:
    project: Project
    legends: dict[str, dict[str, Any]] = field(default_factory=dict)
    sources: dict[str, dict[str, str]] = field(default_factory=dict)


def load_worker_predictions(
    root: str | Path,
    truth_ids: set[str],
    sheet_map: dict[str, str] | None = None,
    rooms_root: str | Path | None = None,
) -> WorkerPredictions:
    root = Path(root)
    proj = Project(root=root)
    out = WorkerPredictions(project=proj)
    for wid, path in find_artifacts(root, "detections.json.gz").items():
        sid = map_sheet_id(wid, truth_ids, sheet_map)
        sh = proj.sheets.setdefault(sid, Sheet(sheet_id=sid, meta={"sheet_id": sid, "kind": "prediction"}, features=[]))
        sh.features += detections_to_features(read_json_any(path), sid)
        out.sources.setdefault(sid, {})["detections"] = str(path)
        out.sources[sid]["detections_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        leg = path.with_name("legend.json.gz")
        if leg.exists():
            out.legends[sid] = read_json_any(leg)
            out.sources[sid]["legend"] = str(leg)
    for wid, path in find_artifacts(Path(rooms_root) if rooms_root else root, "rooms.json.gz").items():
        sid = map_sheet_id(wid, truth_ids, sheet_map)
        sh = proj.sheets.setdefault(sid, Sheet(sheet_id=sid, meta={"sheet_id": sid, "kind": "prediction"}, features=[]))
        sh.features += rooms_to_features(read_json_any(path), sid)
        out.sources.setdefault(sid, {})["rooms"] = str(path)
        out.sources[sid]["rooms_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    return out


# ----------------------------------------------------------------------------- rooms


def norm_name(s: Any) -> str:
    s = unicodedata.normalize("NFKC", str(s or ""))
    s = s.replace("״", '"').replace("׳", "'")
    return re.sub(r"[\s\.\-_'\"]+", "", s)


ROOM_TYPES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("wc", ("שירותים", "שאורחים", "שירותיאורחים")),
    ("bath", ("רחצה", "אמבטיה", "מקלחת")),
    ("bedroom", ("שינה", "הורים")),
    ("living", ("סלון", "מגורים")),
    ("dining", ("אוכל",)),
    ("kitchen", ("מטבח",)),
    ("closet", ("ארונות",)),
    ("tv", ("טלוויזיה", "משחקים")),
    ("study", ("עבודה",)),
    ("hall", ("מבואה", "כניסה", "מסדרון", "פרוזדור")),
    ("stair", ("מדרגות",)),
)


def room_types(*names: Any) -> set[str]:
    """Coarse room type(s) of one or more names ('ח. שינה 2' and 'חדר שינה' are both 'bedroom').

    A predicted name may list several spaces ('סלון / פינת אוכל'). The playroom and TV-room
    labels both map to 'tv' (family room).
    """
    out: set[str] = set()
    for n in names:
        for part in re.split(r"[/+,]", str(n or "")):
            k = norm_name(part)
            for t, keys in ROOM_TYPES:
                if any(key in k for key in keys):
                    out.add(t)
    return out


def _poly(f: Feature):
    from shapely.geometry import Polygon

    p = Polygon(f.coords[0], f.coords[1:])
    return p if p.is_valid else p.buffer(0)  # nosemgrep: shapely property


def truth_area_m2(f: Feature, scale: float | None) -> float | None:
    if f.get("area_m2") is not None:
        return float(f.get("area_m2"))
    if scale:
        return _poly(f).area * scale * scale / 1e6
    return None


@dataclass
class RoomMatch:
    pairs: list[dict[str, Any]]
    unmatched_truth: list[str]
    unmatched_pred: list[str]
    pred_to_truth: dict[str, str]


def match_rooms(gts: list[Feature], prs: list[Feature], iou_min: float, scale: float | None) -> RoomMatch:
    n, m = len(gts), len(prs)
    pairs: list[dict[str, Any]] = []
    if n and m:
        gp = [_poly(g) for g in gts]
        pp = [_poly(p) for p in prs]
        iou = np.zeros((n, m))
        for i in range(n):
            for j in range(m):
                u = gp[i].union(pp[j]).area
                iou[i, j] = gp[i].intersection(pp[j]).area / u if u > 0 else 0.0
        rows, cols = linear_sum_assignment(-iou)
        for i, j in zip(rows.tolist(), cols.tolist()):
            if iou[i, j] < iou_min:
                continue
            g, p = gts[i], prs[j]
            ga = truth_area_m2(g, scale)
            pa = p.get("area_m2")
            if pa is None and scale:
                pa = pp[j].area * scale * scale / 1e6
            names = [norm_name(x) for x in (g.get("names") or [g.get("name")]) if x]
            pairs.append(
                {
                    "truth": g.id,
                    "truth_room_id": g.get("room_id"),
                    "pred": p.id,
                    "iou": float(iou[i, j]),
                    "truth_area_m2": ga,
                    "pred_area_m2": pa,
                    "area_pe": (abs(float(pa) - ga) / ga) if (ga and pa is not None) else None,
                    "name_correct": bool(p.get("name")) and norm_name(p.get("name")) in names,
                    "pred_name": p.get("name"),
                    "type_correct": bool(room_types(p.get("name")) & room_types(*(g.get("names") or [g.get("name")]))),
                    "floor_correct": (p.get("floor") == g.get("floor")) if p.get("floor") is not None else None,
                    "level": p.get("level"),
                }
            )
    mt = {d["truth"] for d in pairs}
    mp = {d["pred"] for d in pairs}
    p2t = {}
    for d in pairs:
        pf = next(p for p in prs if p.id == d["pred"])
        p2t[str(pf.get("worker_room_id"))] = str(d["truth_room_id"])
    return RoomMatch(pairs, [g.id for g in gts if g.id not in mt], [p.id for p in prs if p.id not in mp], p2t)


def rooms_summary(matches: dict[str, RoomMatch], n_truth: int, n_pred: int, tol: float) -> dict[str, Any]:
    pairs = [p for rm in matches.values() for p in rm.pairs]
    ious = [p["iou"] for p in pairs]
    pes = [p["area_pe"] for p in pairs if p["area_pe"] is not None]
    return {
        "n_truth": n_truth,
        "n_pred": n_pred,
        "n_matched": len(pairs),
        "precision": len(pairs) / n_pred if n_pred else None,
        "recall": len(pairs) / n_truth if n_truth else None,
        "mean_iou": float(np.mean(ious)) if ious else None,
        "frac_iou_ge_0_95": (sum(1 for v in ious if v >= 0.95) / len(ious)) if ious else None,
        "median_area_pe": float(np.median(pes)) if pes else None,
        "n_area_within_tol": sum(1 for v in pes if v <= tol + 1e-9),
        "area_tol": tol,
        "name_accuracy": (sum(1 for p in pairs if p["name_correct"]) / len(pairs)) if pairs else None,
        "type_accuracy": (sum(1 for p in pairs if p["type_correct"]) / len(pairs)) if pairs else None,
        "per_sheet": {
            sid: {"pairs": rm.pairs, "unmatched_truth": rm.unmatched_truth, "unmatched_pred": rm.unmatched_pred}
            for sid, rm in sorted(matches.items())
        },
    }


# ----------------------------------------------------------------------------- legend


def legend_summary(
    truth_legends: dict[str, list[dict[str, Any]]], pred_legends: dict[str, dict[str, Any]], tol_mm: float
) -> dict:
    per_sheet = {}
    tot: Counter[str] = Counter()
    for sid, rows in sorted(truth_legends.items()):
        pl = pred_legends.get(sid)
        if pl is None:
            continue
        entries = pl.get("entries", [])
        tc = [(r, _bbox_center(r["properties"]["symbol_bbox_mm"])) for r in rows]
        tb = [r["properties"]["symbol_bbox_mm"] for r in rows]
        pc = [(e, _bbox_center(e.get("symbolBboxMm") or {})) for e in entries]
        n, m = len(tc), len(pc)
        pairs = []
        if n and m:
            cost = np.full((n, m), 1e6)
            for i, (_, a) in enumerate(tc):
                for j, (_, b) in enumerate(pc):
                    if a and b:
                        d = math.dist(a, b)
                        # valid: centres within tol, or the predicted centre inside the truth symbol box
                        # (truth boxes of the comms rows include the TV/TEL/BEZEK prefix text)
                        if d <= tol_mm or _inside(b, tb[i]):
                            cost[i, j] = d
            r_, c_ = linear_sum_assignment(cost)
            pairs = [(i, j) for i, j in zip(r_.tolist(), c_.tolist()) if cost[i, j] < 1e6]
        cls_ok = sum(1 for i, j in pairs if pc[j][0].get("suggestedClass") == tc[i][0]["properties"]["legend_class"])
        lab_ok = sum(1 for i, j in pairs if norm_name(pc[j][0].get("label")) == norm_name(tc[i][0]["properties"]["label"]))
        cer = [_cer(tc[i][0]["properties"]["label"], pc[j][0].get("label") or "") for i, j in pairs]
        res = {
            "n_truth_rows": n,
            "n_pred_entries": m,
            "n_matched": len(pairs),
            "class_correct": cls_ok,
            "label_exact": lab_ok,
            "label_mean_cer": float(np.mean(cer)) if cer else None,
            "missed_rows": [tc[i][0]["properties"]["legend_class"] for i in range(n) if i not in {a for a, _ in pairs}],
            "class_confusions": [
                (tc[i][0]["properties"]["legend_class"], pc[j][0].get("suggestedClass"))
                for i, j in pairs
                if pc[j][0].get("suggestedClass") != tc[i][0]["properties"]["legend_class"]
            ],
        }
        per_sheet[sid] = res
        tot.update({k: res[k] for k in ("n_truth_rows", "n_pred_entries", "n_matched", "class_correct", "label_exact")})
    return {
        "row_recall": tot["n_matched"] / tot["n_truth_rows"] if tot["n_truth_rows"] else None,
        "entry_precision": tot["n_matched"] / tot["n_pred_entries"] if tot["n_pred_entries"] else None,
        "class_accuracy": tot["class_correct"] / tot["n_matched"] if tot["n_matched"] else None,
        "label_exact_rate": tot["label_exact"] / tot["n_matched"] if tot["n_matched"] else None,
        "tolerance_mm": tol_mm,
        "per_sheet": per_sheet,
    }


def _inside(p: tuple[float, float], b: dict[str, Any]) -> bool:
    try:
        return float(b["x"]) <= p[0] <= float(b["x"]) + float(b["w"]) and float(b["y"]) <= p[1] <= float(b["y"]) + float(b["h"])
    except (KeyError, TypeError, ValueError):
        return False


def _bbox_center(b: dict[str, Any]) -> tuple[float, float] | None:
    try:
        return float(b["x"]) + float(b["w"]) / 2, float(b["y"]) + float(b["h"]) / 2
    except (KeyError, TypeError, ValueError):
        return None


def _cer(a: str, b: str) -> float:
    a, b = norm_name(a), norm_name(b)
    if not a:
        return 0.0 if not b else 1.0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1] / len(a)


def load_truth_legends(legend_dir: str | Path) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {}
    d = Path(legend_dir)
    if not d.is_dir():
        return out
    for p in sorted(d.glob("legend_*.geojson")):
        obj = json.loads(p.read_text(encoding="utf-8"))
        sid = obj.get("kamutan", {}).get("sheet_id") or p.stem.removeprefix("legend_")
        out[sid] = [f for f in obj.get("features", []) if f["properties"].get("class") == "legend_entry"]
    return out


# ----------------------------------------------------------------------------- symbols


def _subset(proj: Project, sheet_ids: list[str], keep, relabel=None) -> Project:
    out = Project(root=proj.root, boq=None, disputes=None)
    for sid in sheet_ids:
        sh = proj.sheets.get(sid)
        if sh is None:
            continue
        feats = []
        for f in sh.features:
            if not keep(f):
                continue
            if relabel is not None:
                cls = relabel(f)
                if cls is None:
                    continue
                f = replace(f, cls=cls, props=f.props | {"class": cls})
            feats.append(f)
        out.sheets[sid] = Sheet(sheet_id=sid, meta=sh.meta, features=feats)
    return out


def glyph_map(truth: Project) -> dict[str, str]:
    """semantic class -> legend glyph class, where the truth uses exactly one glyph for that class.

    Used to compare worker classes with the truth at glyph level (e.g. a predicted ``socket_3phase`` is a
    ``socket_power`` glyph). Classes drawn with several glyphs (e.g. outdoor luminaires) are left unmapped.
    """
    seen: dict[str, set[str]] = defaultdict(set)
    for sh in truth.sheets.values():
        for f in sh.features:
            g = f.get("symbol_class")
            if is_symbol(f) and g not in (None, "unknown"):
                seen[f.cls].add(str(g))
    return {c: next(iter(g)) for c, g in sorted(seen.items()) if len(g) == 1 and next(iter(g)) != c}


def resolve_ambiguous_glyphs(truth: Project, pred: Project, glyph_of: dict[str, str], tol_mm: float) -> int:
    """Predicted classes the truth draws with several glyphs (e.g. outdoor luminaires: ceiling or wall glyph)
    take the glyph of the nearest truth item of the *same semantic class* within ``tol_mm``; else unchanged."""
    ambiguous: set[str] = set()
    for sh in truth.sheets.values():
        seen: dict[str, set[str]] = defaultdict(set)
        for f in sh.features:
            if is_symbol(f) and f.get("symbol_class") not in (None, "unknown"):
                seen[f.cls].add(str(f.get("symbol_class")))
        ambiguous |= {c for c, g in seen.items() if len(g) > 1}
    n = 0
    for sid, sh in pred.sheets.items():
        tsh = truth.sheets.get(sid)
        if tsh is None:
            continue
        new = []
        for f in sh.features:
            if f.cls in ambiguous and f.cls not in glyph_of:
                cands = [g for g in tsh.features if g.cls == f.cls and g.get("symbol_class")]
                best = min(cands, key=lambda g: math.dist(g.center, f.center), default=None)
                if best is not None and math.dist(best.center, f.center) <= tol_mm:
                    glyph = str(best.get("symbol_class"))
                    f = replace(f, cls=glyph, props=f.props | {"class": glyph})
                    n += 1
            new.append(f)
        sh.features = new
    return n


def is_symbol(f: Feature) -> bool:
    return f.geom_type == "Point" and f.kind == "symbol"


def counts_by_floor_class(truth: Project, pred: Project, sheet_ids: list[str], key: str = "class") -> list[dict[str, Any]]:
    tc: Counter[tuple[str, str, str]] = Counter()
    pc: Counter[tuple[str, str, str]] = Counter()
    for sid in sheet_ids:
        for f in truth.sheets[sid].features if sid in truth.sheets else []:
            if is_symbol(f):
                tc[(sid, str(f.get("floor")), str(f.cls if key == "class" else f.get(key)))] += 1
        for f in pred.sheets[sid].features if sid in pred.sheets else []:
            if is_symbol(f):
                pc[(sid, str(f.get("floor")), str(f.cls))] += 1
    rows = []
    for k in sorted(set(tc) | set(pc)):
        rows.append({"sheet": k[0], "floor": k[1], "class": k[2], "truth": tc[k], "pred": pc[k], "ae": abs(tc[k] - pc[k])})
    return rows


def green_precision(items: list[dict[str, Any]]) -> dict[str, Any]:
    greens = [it for it in items if it.get("level") == "green"]
    n = len(greens)
    k_item = sum(1 for it in greens if it["correct"])
    k_det = sum(1 for it in greens if not ({"unmatched", "class"} & set(it["reasons"])))
    return {
        "n_green": n,
        "items_correct": {
            "k": k_item,
            "p": k_item / n if n else None,
            "wilson_lb95": wilson_lower(k_item, n),
            "wilson_ub95": wilson_upper(k_item, n),
        },
        "detection_correct": {
            "k": k_det,
            "p": k_det / n if n else None,
            "wilson_lb95": wilson_lower(k_det, n),
            "wilson_ub95": wilson_upper(k_det, n),
        },
    }


def per_level_precision(items: list[dict[str, Any]]) -> dict[str, Any]:
    out = {}
    for lvl in ("green", "yellow", "red", None):
        sub = [it for it in items if it.get("level") == lvl]
        k = sum(1 for it in sub if not ({"unmatched", "class"} & set(it["reasons"])))
        out[str(lvl)] = {"n": len(sub), "detection_correct": k, "p": k / len(sub) if sub else None}
    return out


@dataclass
class WorkerEvalConfig:
    base: EvalConfig = field(default_factory=EvalConfig)
    room_iou: float = 0.5
    room_area_tol: float = 0.02
    legend_tol_mm: float = 4.0
    include_missing_sheets: bool = False


def evaluate_worker(
    truth: Project,
    preds: WorkerPredictions,
    cfg: WorkerEvalConfig | None = None,
    truth_legends: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    cfg = cfg or WorkerEvalConfig()
    pred = preds.project
    sym_truth = {sid for sid, sh in truth.sheets.items() if any(is_symbol(f) for f in sh.features)}
    room_truth = {sid for sid, sh in truth.sheets.items() if any(f.cls == "room" for f in sh.features)}
    with_det = {sid for sid, src in preds.sources.items() if "detections" in src}
    with_rooms = {sid for sid, src in preds.sources.items() if "rooms" in src}
    sym_sheets = sorted(sym_truth if cfg.include_missing_sheets else sym_truth & with_det)
    room_sheets = sorted(room_truth if cfg.include_missing_sheets else room_truth & with_rooms)

    # rooms first: gives the pred->truth room id mapping used to score detection roomIds
    matches: dict[str, RoomMatch] = {}
    n_tr = n_pr = 0
    for sid in room_sheets:
        tsh = truth.sheets[sid]
        gts = [f for f in tsh.features if f.cls == "room" and f.geom_type == "Polygon"]
        prs = [f for f in (pred.sheets[sid].features if sid in pred.sheets else []) if f.cls == "room"]
        n_tr += len(gts)
        n_pr += len(prs)
        matches[sid] = match_rooms(gts, prs, cfg.room_iou, tsh.scale)
    rooms = rooms_summary(matches, n_tr, n_pr, cfg.room_area_tol)

    def remap(f: Feature) -> Feature:
        rm = matches.get(f.sheet_id)
        rid = f.get("room_id")
        if rid is None:
            return f
        new = rm.pred_to_truth.get(str(rid), f"unmatched:{rid}") if rm else f"unmatched:{rid}"
        return replace(f, props=f.props | {"room_id": new})

    pred_sym = Project(root=pred.root)
    for sid in sym_sheets:
        sh = pred.sheets.get(sid)
        feats = [remap(f) for f in (sh.features if sh else []) if is_symbol(f)]
        pred_sym.sheets[sid] = Sheet(sheet_id=sid, meta=(sh.meta if sh else {"sheet_id": sid}), features=feats)
    truth_sym = _subset(truth, sym_sheets, is_symbol)
    base = replace(cfg.base, exclude_disputed=False)
    m_cls = evaluate([(truth_sym, pred_sym)], base)

    truth_glyph = _subset(
        truth,
        sym_sheets,
        is_symbol,
        relabel=lambda f: None if f.get("symbol_class", f.cls) is None else str(f.get("symbol_class", f.cls)),
    )
    glyph_of = glyph_map(truth)
    pred_glyph = _subset(pred_sym, sym_sheets, is_symbol, relabel=lambda f: glyph_of.get(f.cls, f.cls))
    n_resolved = resolve_ambiguous_glyphs(truth_sym, pred_glyph, glyph_of, cfg.base.match.center_tol_mm)
    m_sym = evaluate([(truth_glyph, pred_glyph)], base)

    n_text_only = sum(
        1 for sid in sym_sheets for f in truth.sheets[sid].features if is_symbol(f) and f.get("symbol_class", "x") is None
    )
    det = m_cls["detection"]

    return {
        "sheets": {
            "symbols": sym_sheets,
            "rooms": room_sheets,
            "missing_predictions": sorted((sym_truth - with_det) | (room_truth - with_rooms)),
        },
        "config": {
            "center_tol_mm": cfg.base.match.center_tol_mm,
            "match_mode": cfg.base.match.mode,
            "room_iou": cfg.room_iou,
            "room_area_tol": cfg.room_area_tol,
            "legend_tol_mm": cfg.legend_tol_mm,
        },
        "symbols": {
            "detection": det,
            "items_correct": m_cls["items_correct"],
            "green": green_precision(m_cls["items"]),
            "calibration": {k: m_cls["calibration"][k] for k in ("ece", "mce", "brier", "n_scored")},
            "precision_by_level": per_level_precision(m_cls["items"]),
            "review_burden": m_cls["review_burden"],
            "counts": counts_by_floor_class(truth_sym, pred_sym, sym_sheets),
            "items": m_cls["items"],
            "fn_items": m_cls["fn_items"],
        },
        "symbols_glyph_level": {
            "detection": m_sym["detection"],
            "n_truth_text_only_excluded": n_text_only,
            "counts": counts_by_floor_class(truth_glyph, pred_glyph, sym_sheets),
            "pred_class_to_glyph": glyph_of,
            "n_pred_glyph_resolved_by_nearest_truth": n_resolved,
            "fn_items": m_sym["fn_items"],
            "items": m_sym["items"],
        },
        "rooms": rooms,
        "legend": legend_summary(truth_legends or {}, preds.legends, cfg.legend_tol_mm),
        "sources": preds.sources,
    }


# ----------------------------------------------------------------------------- report


def _f(v: Any, pct: bool = False) -> str:
    if v is None:
        return "—"
    if isinstance(v, float):
        return f"{v * 100:.1f}%" if pct else f"{v:.3f}"
    return str(v)


def render_worker_markdown(m: dict[str, Any], title: str = "kbench — worker artifacts") -> str:
    o: list[str] = [f"# {title}", ""]
    s = m["sheets"]
    c = m["config"]
    o.append(f"- symbol sheets: {', '.join(s['symbols']) or '—'} · room sheets: {', '.join(s['rooms']) or '—'}")
    if s["missing_predictions"]:
        o.append(f"- truth sheets without predictions (excluded): {', '.join(s['missing_predictions'])}")
    o.append(
        f"- matching: centre distance ≤ {c['center_tol_mm']} mm · rooms IoU ≥ {c['room_iou']} · legend ≤ {c['legend_tol_mm']} mm"
    )
    o.append("")
    for key, head in (("symbols", "Symbols — semantic class"), ("symbols_glyph_level", "Symbols — legend-glyph level")):
        det = m[key]["detection"]
        mi = det["micro"]
        o.append(f"## {head}")
        o.append(
            f"micro P {_f(mi['precision'])} · R {_f(mi['recall'])} · **F1 {_f(mi['f1'])}** (TP {mi['tp']} / FP {mi['fp']} / FN {mi['fn']})"
        )
        if key == "symbols_glyph_level" and m[key]["n_truth_text_only_excluded"]:
            o.append(f"(truth items without a glyph — text callouts — excluded: {m[key]['n_truth_text_only_excluded']})")
        o.append("")
        o.append("| class | support | TP | FP | FN | P | R | F1 |")
        o.append("| --- | --- | --- | --- | --- | --- | --- | --- |")
        for cl, v in det["per_class"].items():
            o.append(
                f"| {cl} | {v['support']} | {v['tp']} | {v['fp']} | {v['fn']} | {_f(v['precision'])} | {_f(v['recall'])} | {_f(v['f1'])} |"
            )
        o.append("")
    sy = m["symbols"]
    g = sy["green"]
    o.append("## Confidence buckets")
    o.append(
        f"- green n={g['n_green']}: detection-correct {_f(g['detection_correct']['p'], True)} "
        f"(Wilson LB95 {_f(g['detection_correct']['wilson_lb95'], True)}); items-correct (class+lifecycle+floor) "
        f"{_f(g['items_correct']['p'], True)} (LB95 {_f(g['items_correct']['wilson_lb95'], True)})"
    )
    for lvl, v in sy["precision_by_level"].items():
        if v["n"]:
            o.append(f"- {lvl}: n={v['n']}, detection-correct {_f(v['p'], True)}")
    rb = sy["review_burden"]
    o.append(
        f"- review burden {_f(rb['burden'], True)} (green {rb['n_green']} / yellow {rb['n_yellow']} / red {rb['n_red']}) · "
        f"yield of review {_f(rb['yield_of_review'], True)} · risk AUC {_f(rb['risk_auc'])}"
    )
    ic = sy["items_correct"]
    o.append(
        f"- items correct before review {_f(ic['rate'], True)} (LB95 {_f(ic['wilson_lb95'], True)}); error reasons {ic['error_reasons']}"
    )
    o.append("")
    o.append("## Count error per sheet / floor / class (semantic)")
    o.append("| sheet | floor | class | truth | pred | AE |")
    o.append("| --- | --- | --- | --- | --- | --- |")
    for r in sy["counts"]:
        if r["truth"] or r["pred"]:
            o.append(f"| {r['sheet']} | {r['floor']} | {r['class']} | {r['truth']} | {r['pred']} | {r['ae']} |")
    o.append("")
    rm = m["rooms"]
    o.append("## Rooms")
    o.append(
        f"truth {rm['n_truth']} · predicted {rm['n_pred']} · matched {rm['n_matched']} (P {_f(rm['precision'])}, R {_f(rm['recall'])}) · "
        f"mean IoU {_f(rm['mean_iou'])} · IoU≥0.95 {_f(rm['frac_iou_ge_0_95'], True)} · median area PE {_f(rm['median_area_pe'], True)} · "
        f"within {rm['area_tol'] * 100:.0f}%: {rm['n_area_within_tol']} · exact name {_f(rm['name_accuracy'], True)} · "
        f"room type {_f(rm['type_accuracy'], True)}"
    )
    o.append("")
    lg = m["legend"]
    if lg["per_sheet"]:
        o.append("## Legend")
        o.append(
            f"row recall {_f(lg['row_recall'], True)} · entry precision {_f(lg['entry_precision'], True)} · "
            f"class accuracy {_f(lg['class_accuracy'], True)} · exact label {_f(lg['label_exact_rate'], True)}"
        )
        o.append("")
    return "\n".join(o)
