"""Sprint 4: room type / wet flag / opening / perimeter metrics for the tiling chapter, and expected tiling quantities.

Truth: ``<gt>/tiling/wet_rooms.json`` (schema ``kamutan.tiling-truth/1``): wet rooms on the architecture sheets with
inner-face polygon (paper mm), type, perimeter, openings (kind, width, centre), external (reflex) corners, ceiling
height and sub-areas (laundry niche, courtyard landing). Every other room polygon on the architecture truth sheets
(``class == room``) contributes its type (derived from its names) and ``wet = False``.

Predictions: the worker's ``rooms.json.gz`` (``kamutan.rooms/1``) with the Sprint-4 fields ``type``, ``wet``,
``perimeterM``, ``openings[{kind, widthM, centerMm}]``, ``externalCorners``.

Metrics (rooms matched by polygon IoU >= ``room_iou``, Hungarian, per sheet):

- type accuracy over matched rooms (prediction must be one of the truth room's acceptable types; open-plan rooms
  accept any of their named spaces);
- wet: precision / recall / F1 over truth rooms (unmatched truth wet room = FN, unmatched predicted wet room = FP);
- for matched wet rooms: area PE (vs ``area_m2``), perimeter PE, external-corner AE, openings (Hungarian on centre
  distance <= ``opening_tol_mm`` within the same kind): recall, precision, width AE, share of widths within
  ``width_tol_m``.

Expected tiling quantities: :func:`expected_lines` applies a parameterised rule set to the truth geometry (the same
rule family the worker's BOQ uses: perimeter x height - openings, corners x height, floor area, one waterproofing per
room with a shower or bath).
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from scipy.optimize import linear_sum_assignment
from shapely.affinity import translate
from shapely.geometry import Polygon

from .data import Feature, Project
from .worker import norm_name

TILING_SCHEMA = "kamutan.tiling-truth/1"
WET_TYPES = ("bathroom", "wc")

# coarse names -> Sprint-4 room types (docs/agents/SPRINT4_BRIEF.md)
NAME_TYPES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("wc", ("שירותים", "שאורחים", "שירותיאורחים")),
    ("bathroom", ("רחצה", "אמבטיה", "מקלחת")),
    ("bedroom", ("שינה", "הורים", "עבודה")),
    ("living", ("סלון", "מגורים", "אוכל", "טלוויזיה", "משחקים")),
    ("kitchen", ("מטבח",)),
    ("storage", ("ארונות", "מחסן")),
    ("corridor", ("מבואה", "כניסה", "מסדרון", "פרוזדור")),
    ("stairs", ("מדרגות",)),
    ("courtyard", ("חצר",)),
    ("balcony", ("מרפסת",)),
)


def types_of(*names: Any) -> set[str]:
    out: set[str] = set()
    for n in names:
        k = norm_name(n)
        for t, keys in NAME_TYPES:
            if any(key in k for key in keys):
                out.add(t)
                break
    return out


def load_tiling_truth(gt_dir: str | Path) -> dict[str, Any]:
    p = Path(gt_dir) / "tiling" / "wet_rooms.json"
    obj = json.loads(p.read_text(encoding="utf-8"))
    if obj.get("schema") != TILING_SCHEMA:
        raise ValueError(f"{p}: expected schema {TILING_SCHEMA}, got {obj.get('schema')!r}")
    return obj


@dataclass
class TruthRoom:
    sheet_id: str
    room_id: str
    poly: Polygon
    types: set[str]
    wet: bool
    detail: dict[str, Any] | None  # tiling-truth record for wet rooms / courtyard


def truth_rooms(truth: Project, tiling: dict[str, Any]) -> dict[str, list[TruthRoom]]:
    detail = {(r["sheet_id"], r["room_id"]): r for r in tiling["rooms"]}
    out: dict[str, list[TruthRoom]] = {}
    seen: set[tuple[str, str]] = set()
    for (sid, rid), r in detail.items():
        t = {r["type"]}
        out.setdefault(sid, []).append(TruthRoom(sid, rid, Polygon(r["polygon_mm"]), t, r["type"] in WET_TYPES, r))
        seen.add((sid, rid))
    for sid in {r["sheet_id"] for r in tiling["rooms"]}:
        sh = truth.sheets.get(sid)
        if sh is None:
            continue
        for f in sh.features:
            if f.cls != "room" or f.geom_type != "Polygon" or (sid, str(f.get("room_id"))) in seen:
                continue
            names = f.get("names") or [f.get("name")]
            poly = Polygon(f.coords[0], f.coords[1:])
            out[sid].append(TruthRoom(sid, str(f.get("room_id")), poly, types_of(*names), False, None))
    # transfers: the same rooms translated onto other sheets of the floor (e.g. construction plans)
    for tr in tiling.get("transfers", []):
        dx, dy = float(tr["d_mm"][0]), float(tr["d_mm"][1])
        src = out.get(tr["from"], [])
        floor_of = {(r["sheet_id"], r["room_id"]): r.get("floor") for r in tiling["rooms"]}
        sh = truth.sheets.get(tr["from"])
        if sh is not None:
            for f in sh.features:
                if f.cls == "room":
                    floor_of.setdefault((tr["from"], str(f.get("room_id"))), f.get("floor"))
        moved = []
        for r in src:
            if floor_of.get((r.sheet_id, r.room_id)) != tr["floor"]:
                continue
            moved.append(
                TruthRoom(tr["sheet_id"], r.room_id, translate(r.poly, dx, dy), r.types, r.wet, _shift_detail(r.detail, dx, dy))
            )
        out.setdefault(tr["sheet_id"], []).extend(moved)
    return out


def _shift_detail(d: dict[str, Any] | None, dx: float, dy: float) -> dict[str, Any] | None:
    if d is None:
        return None
    ops = [o | {"center_mm": [o["center_mm"][0] + dx, o["center_mm"][1] + dy]} for o in d["openings"]]
    return d | {"openings": ops}


def _pred_poly(f: Feature) -> Polygon:
    p = Polygon(f.coords[0], f.coords[1:])
    return p if p.is_valid else p.buffer(0)


def _pt(d: Any) -> tuple[float, float] | None:
    if isinstance(d, dict) and "x" in d:
        return float(d["x"]), float(d["y"])
    if isinstance(d, (list, tuple)) and len(d) == 2:
        return float(d[0]), float(d[1])
    return None


def match_openings(
    truth_ops: list[dict[str, Any]], pred_ops: list[dict[str, Any]], tol_mm: float, width_tol_m: float
) -> dict[str, Any]:
    pairs: list[dict[str, Any]] = []
    used_p: set[int] = set()
    for kind in sorted({o["kind"] for o in truth_ops} | {str(o.get("kind")) for o in pred_ops}):
        ti = [i for i, o in enumerate(truth_ops) if o["kind"] == kind]
        pi = [j for j, o in enumerate(pred_ops) if str(o.get("kind")) == kind and _pt(o.get("centerMm"))]
        if not ti or not pi:
            continue
        cost = np.full((len(ti), len(pi)), 1e6)
        for a, i in enumerate(ti):
            for b, j in enumerate(pi):
                pc = _pt(pred_ops[j].get("centerMm"))
                assert pc is not None
                d = math.dist(tuple(truth_ops[i]["center_mm"]), pc)
                if d <= tol_mm:
                    cost[a, b] = d
        rows, cols = linear_sum_assignment(cost)
        for a, b in zip(rows.tolist(), cols.tolist()):
            if cost[a, b] >= 1e6:
                continue
            i, j = ti[a], pi[b]
            used_p.add(j)
            pw = pred_ops[j].get("widthM")
            wae = abs(float(pw) - truth_ops[i]["width_m"]) if pw is not None else None
            pairs.append(
                {
                    "kind": kind,
                    "truth_width_m": truth_ops[i]["width_m"],
                    "pred_width_m": pw,
                    "width_ae_m": wae,
                    "width_ok": wae is not None and wae <= width_tol_m + 1e-9,
                }
            )
    return {"n_truth": len(truth_ops), "n_pred": len(pred_ops), "n_matched": len(pairs), "pairs": pairs}


@dataclass(frozen=True)
class TilingEvalConfig:
    room_iou: float = 0.5
    opening_tol_mm: float = 10.0
    width_tol_m: float = 0.05


def _prf(tp: int, fp: int, fn: int) -> dict[str, Any]:
    p = tp / (tp + fp) if tp + fp else None
    r = tp / (tp + fn) if tp + fn else None
    f1 = 2 * tp / (2 * tp + fp + fn) if tp + fp + fn else None
    return {"tp": tp, "fp": fp, "fn": fn, "precision": p, "recall": r, "f1": f1}


def evaluate_tiling_rooms(
    truth: Project, tiling: dict[str, Any], pred: Project, cfg: TilingEvalConfig | None = None
) -> dict[str, Any]:
    cfg = cfg or TilingEvalConfig()
    scale = float(tiling.get("scale") or 50)
    tr = truth_rooms(truth, tiling)
    per_room: list[dict[str, Any]] = []
    type_ok = n_matched = type_ok_name = n_typed = 0
    tp = fp = fn = 0
    unmatched_truth: list[str] = []
    missing: list[str] = []
    for sid, gts in sorted(tr.items()):
        psh = pred.sheets.get(sid)
        prs = [f for f in (psh.features if psh else []) if f.cls == "room" and f.geom_type == "Polygon"]
        if psh is None or not prs:
            missing.append(sid)
            continue
        pp = [_pred_poly(f) for f in prs]
        iou = np.zeros((len(gts), len(prs)))
        for i, g in enumerate(gts):
            for j, p in enumerate(pp):
                u = g.poly.union(p).area
                iou[i, j] = g.poly.intersection(p).area / u if u > 0 else 0.0
        rows, cols = linear_sum_assignment(-iou)
        matched_g: set[int] = set()
        matched_p: set[int] = set()
        for i, j in zip(rows.tolist(), cols.tolist()):
            if iou[i, j] < cfg.room_iou:
                continue
            matched_g.add(i)
            matched_p.add(j)
            g, f = gts[i], prs[j]
            n_matched += 1
            ptype = f.get("type")
            ok = ptype in g.types
            type_ok += int(ok)
            n_typed += int(ptype is not None)
            # fallback for rooms without the Sprint-4 'type' field: the type implied by the predicted name
            name_types = types_of(f.get("name"))
            type_ok_name += int(bool(name_types & g.types)) if ptype is None else int(ok)
            pwet = bool(f.get("wet"))
            if g.wet and pwet:
                tp += 1
            elif g.wet:
                fn += 1
            elif pwet:
                fp += 1
            rec: dict[str, Any] = {
                "sheet": sid,
                "truth_room_id": g.room_id,
                "pred_id": f.id,
                "iou": round(float(iou[i, j]), 4),
                "truth_types": sorted(g.types),
                "pred_type": ptype,
                "type_ok": ok,
                "truth_wet": g.wet,
                "pred_wet": pwet,
            }
            if g.detail is not None:
                d = g.detail
                pa = f.get("area_m2")
                if pa is None:
                    pa = pp[j].area * scale * scale / 1e6
                pper = f.get("perimeter_m")
                pc = f.get("external_corners")
                ops = match_openings(d["openings"], list(f.get("openings") or []), cfg.opening_tol_mm, cfg.width_tol_m)
                rec |= {
                    "truth_area_m2": d["area_m2"],
                    "pred_area_m2": pa,
                    "area_pe": abs(float(pa) - d["area_m2"]) / d["area_m2"],
                    "truth_perimeter_m": d["perimeter_m"],
                    "pred_perimeter_m": pper,
                    "perimeter_pe": (abs(float(pper) - d["perimeter_m"]) / d["perimeter_m"]) if pper is not None else None,
                    "truth_external_corners": d["external_corners"],
                    "pred_external_corners": pc,
                    "corners_ae": abs(int(pc) - d["external_corners"]) if pc is not None else None,
                    "openings": ops,
                }
            per_room.append(rec)
        for i, g in enumerate(gts):
            if i not in matched_g:
                unmatched_truth.append(f"{sid}:{g.room_id}")
                if g.wet:
                    fn += 1
        for j, f in enumerate(prs):
            if j not in matched_p and bool(f.get("wet")):
                fp += 1
    wet_recs = [r for r in per_room if "area_pe" in r]
    ops_pairs = [p for r in wet_recs for p in r["openings"]["pairs"]]
    n_t_ops = sum(r["openings"]["n_truth"] for r in wet_recs)
    n_p_ops = sum(r["openings"]["n_pred"] for r in wet_recs)

    def med(xs: list[float]) -> float | None:
        return float(np.median(xs)) if xs else None

    return {
        "tiling_rooms": {
            "config": {"room_iou": cfg.room_iou, "opening_tol_mm": cfg.opening_tol_mm, "width_tol_m": cfg.width_tol_m},
            "n_truth_rooms": sum(len(v) for v in tr.values()),
            "n_matched": n_matched,
            "type_accuracy": (type_ok / n_matched) if n_matched else None,
            "n_pred_typed": n_typed,
            "type_accuracy_name_fallback": (type_ok_name / n_matched) if n_matched else None,
            "wet": _prf(tp, fp, fn),
            "wet_rooms_matched": len(wet_recs),
            "area_median_pe": med([r["area_pe"] for r in wet_recs]),
            "perimeter_median_pe": med([r["perimeter_pe"] for r in wet_recs if r["perimeter_pe"] is not None]),
            "corners_ae_sum": sum(r["corners_ae"] for r in wet_recs if r["corners_ae"] is not None),
            "corners_exact": sum(1 for r in wet_recs if r["corners_ae"] == 0),
            "openings": {
                "recall": (len(ops_pairs) / n_t_ops) if n_t_ops else None,
                "precision": (len(ops_pairs) / n_p_ops) if n_p_ops else None,
                "width_within_tol": (sum(1 for p in ops_pairs if p["width_ok"]) / len(ops_pairs)) if ops_pairs else None,
                "width_median_ae_m": med([p["width_ae_m"] for p in ops_pairs if p["width_ae_m"] is not None]),
            },
            "unmatched_truth": unmatched_truth,
            "missing_pred_sheets": missing,
            "rooms": per_room,
        }
    }


# ----------------------------------------------------------------------------- expected quantities


@dataclass(frozen=True)
class TilingRules:
    cladding_height_m: float = 2.6
    cap_at_ceiling: bool = True
    door_height_m: float = 2.1
    window_sill_m: float = 1.0
    window_head_m: float = 2.1
    clad_niches: bool = False
    floor_types: tuple[str, ...] = ("bathroom", "wc")
    floor_include_niches: bool = True
    floor_courtyard: str = "none"  # none | landing | whole
    clad_types: tuple[str, ...] = ("bathroom",)
    waterproof_types: tuple[str, ...] = ("bathroom",)


def _niche_wall_length(room: dict[str, Any]) -> float:
    """Length of the niche walls lying on the room outline (niche polygon edges shared with the room outline)."""
    sub = room.get("sub_polygons_mm", {}).get("laundry_niche")
    if not sub:
        return float(room.get("niche_wall_m") or 0.0)
    outline = Polygon(room["polygon_mm"]).exterior
    niche = Polygon(sub).exterior
    return float(outline.intersection(niche).length) * 50 / 1000


def expected_lines(tiling: dict[str, Any], rules: TilingRules | None = None) -> dict[str, Any]:
    rules = rules or TilingRules()
    rooms = tiling["rooms"]
    clad = corners = floor = 0.0
    wp = 0
    per_room = []
    for r in rooms:
        h = rules.cladding_height_m
        if rules.cap_at_ceiling and r.get("ceiling_height_m"):
            h = min(h, float(r["ceiling_height_m"]))
        c = k = fl = 0.0
        if r["type"] in rules.clad_types:
            per = r["perimeter_m"] - (0.0 if rules.clad_niches else _niche_wall_length(r))
            c = per * h
            for o in r["openings"]:
                if o["kind"] == "door":
                    c -= o["width_m"] * min(h, rules.door_height_m)
                elif o["kind"] == "window":
                    c -= o["width_m"] * max(0.0, min(h, rules.window_head_m) - rules.window_sill_m)
            k = r["external_corners"] * h
        if r["type"] in rules.floor_types:
            fl = r["area_m2"] - (0.0 if rules.floor_include_niches else r.get("sub_areas_m2", {}).get("laundry_niche", 0.0))
        if r["type"] == "courtyard" and rules.floor_courtyard != "none":
            fl = r["area_m2"] if rules.floor_courtyard == "whole" else r.get("sub_areas_m2", {}).get("landing", 0.0)
        w = 1 if r["type"] in rules.waterproof_types else 0
        clad += c
        corners += k
        floor += fl
        wp += w
        per_room.append({"room_id": r["room_id"], "5.01": round(c, 3), "5.02": round(fl, 3), "5.03": round(k, 3), "5.05": w})
    return {
        "rules": rules.__dict__,
        "lines": {"5.01": round(clad, 2), "5.02": round(floor, 2), "5.03": round(corners, 2), "5.05": float(wp)},
        "per_room": per_room,
    }


def render_tiling_markdown(m: dict[str, Any]) -> str:
    t = m["tiling_rooms"]

    def f(v: Any, nd: int = 3) -> str:
        return "-" if v is None else (f"{v:.{nd}f}" if isinstance(v, float) else str(v))

    w = t["wet"]
    o = t["openings"]
    out = [
        "# kbench — rooms for tiling (types, wet, openings)",
        "",
        (
            f"matched {t['n_matched']}/{t['n_truth_rooms']} truth rooms · type accuracy {f(t['type_accuracy'])} · "
            f"wet P {f(w['precision'])} R {f(w['recall'])} F1 {f(w['f1'])}"
        ),
        (
            f"wet rooms matched {t['wet_rooms_matched']} · area median PE {f(t['area_median_pe'])} · perimeter median PE "
            f"{f(t['perimeter_median_pe'])} · corners exact {t['corners_exact']} (ΣAE {t['corners_ae_sum']})"
        ),
        (
            f"openings R {f(o['recall'])} P {f(o['precision'])} · width within tol {f(o['width_within_tol'])} · "
            f"median width AE {f(o['width_median_ae_m'])} m"
        ),
        "",
        "| sheet | truth room | IoU | type (truth / pred) | wet (t/p) | area PE | perim PE | corners t/p | openings t/p/matched |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r in t["rooms"]:
        ops = r.get("openings") or {}
        out.append(
            f"| {r['sheet']} | {r['truth_room_id']} | {r['iou']:.2f} | {'/'.join(r['truth_types'])} / {r['pred_type']} | "
            f"{int(r['truth_wet'])}/{int(r['pred_wet'])} | {f(r.get('area_pe'))} | {f(r.get('perimeter_pe'))} | "
            f"{r.get('truth_external_corners', '-')}/{r.get('pred_external_corners', '-')} | "
            f"{ops.get('n_truth', '-')}/{ops.get('n_pred', '-')}/{ops.get('n_matched', '-')} |"
        )
    if t["unmatched_truth"]:
        out += ["", "Unmatched truth rooms: " + ", ".join(t["unmatched_truth"])]
    if t["missing_pred_sheets"]:
        out += ["", "Sheets without predicted rooms: " + ", ".join(t["missing_pred_sheets"])]
    return "\n".join(out) + "\n"
