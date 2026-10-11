"""All accuracy metrics of the test plan ("מדדי דיוק") in one place.

Implemented exactly as defined in docs/spec/07_test_plan.md:
- per-class detection P/R/F1 (micro + macro over classes with >= 20 GT items), confusion matrix
- count error per BOQ line (AE, PE = AE / max(Q, 1)), area/length error (PE = AE / A)
- line exact-match rate over confirmed lines (+ extra lines reported separately)
- "items correct before review" (per item; denominator = #predicted + #FN) with Wilson LB
- calibration: equal-mass reliability (10 bins), ECE, MCE, Brier, P_green + Wilson LB,
  minimum-sample rule, per-domain check, class green eligibility, ceiling rules
- review burden, yield of review, AUC of the risk score
Lines referenced by open disputes (and their evidence items) are excluded from all
gating metrics.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from typing import Any, Iterable

from .data import Feature, Project, class_domain, load_classes, unit_kind
from .matching import MatchParams, match
from .stats import auc, min_n_for_lower_bound, percentile, reliability, wilson_lower, wilson_upper

EPS = 1e-9


@dataclass
class EvalConfig:
    match: MatchParams = field(default_factory=MatchParams)
    exclude_disputed: bool = True
    include_draft_lines: bool = False
    macro_min_support: int = 20
    n_bins: int = 10
    green_target: float = 0.98
    domain_green_min_n: int = 200
    domain_green_lb: float = 0.96
    class_green_min_items: int = 200
    flooring_tol: float = 0.02
    cladding_tol: float = 0.03
    length_tol: float = 0.02
    area_tol: float = 0.02

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        return d


# ----------------------------------------------------------------------------- helpers

def prf(tp: int, fp: int, fn: int) -> dict[str, Any]:
    p = tp / (tp + fp) if tp + fp else None
    r = tp / (tp + fn) if tp + fn else None
    # 2PR/(P+R) == 2TP/(2TP+FP+FN); defined whenever anything was predicted or expected
    f1 = 2 * tp / (2 * tp + fp + fn) if (2 * tp + fp + fn) else None
    return {"tp": tp, "fp": fp, "fn": fn, "precision": p, "recall": r, "f1": f1, "support": tp + fn}


def is_item(f: Feature) -> bool:
    return f.kind != "context"


def item_quantity(f: Feature, scale: float | None) -> float | None:
    """Real-world quantity of an area/linear item (m2 or m)."""
    if "quantity" in f.props:
        return float(f.props["quantity"])
    if scale is None:
        return None
    if f.geom_type == "Polygon":
        return f.area_mm2 * scale * scale / 1e6
    if f.geom_type == "LineString":
        import math

        pts = f.coords
        length = sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
        return length * scale / 1000.0
    return None


def area_tolerance(f: Feature, cfg: EvalConfig) -> float:
    if f.kind == "linear":
        return cfg.length_tol
    if f.cls in ("wall_cladding",) or f.get("category") == "cladding":
        return cfg.cladding_tol
    if f.cls in ("floor_tiling",) or f.get("category") == "flooring":
        return cfg.flooring_tol
    return cfg.area_tol


def line_tolerance(line: dict[str, Any], cfg: EvalConfig) -> float:
    if "tolerance_pe" in line:
        return float(line["tolerance_pe"])
    cat = line.get("category")
    if cat == "cladding":
        return cfg.cladding_tol
    if cat == "flooring":
        return cfg.flooring_tol
    if unit_kind(line.get("unit", "")) == "length":
        return cfg.length_tol
    return cfg.area_tol


def chapter_of(code: str) -> str:
    return code.split(".", 1)[0]


def eligible_truth_line(line: dict[str, Any], cfg: EvalConfig) -> bool:
    st = line.get("gt_status", "draft")
    if st in ("confirmed", "user_input"):
        return True
    return cfg.include_draft_lines and st == "draft"


# ----------------------------------------------------------------------------- core

@dataclass
class ItemRecord:
    project_id: str
    sheet_id: str
    pred_id: str
    cls: str
    domain: str
    correct: bool
    reasons: list[str]
    confidence: float | None
    level: str | None
    input_type: str
    scale_conflict: bool
    kind: str
    room_correct: bool | None


class _Acc:
    """Accumulator across projects."""

    def __init__(self) -> None:
        self.class_counts: dict[str, Counter] = defaultdict(Counter)
        self.confusion: dict[str, Counter] = defaultdict(Counter)
        self.items: list[ItemRecord] = []
        self.fn_items: list[tuple[str, str, str]] = []  # (project, sheet, gt id)
        self.n_pred_items = 0
        self.line_results: list[dict[str, Any]] = []
        self.extra_lines: list[dict[str, Any]] = []
        self.room_ious: list[float] = []
        self.excluded: dict[str, Any] = {"disputed_codes": {}, "gt_items": 0, "pred_items": 0}
        self.dataset: list[dict[str, Any]] = []


def _excluded_gt_ids(truth: Project, disputed: set[str]) -> set[str]:
    ids: set[str] = set()
    for ln in truth.boq_lines():
        if ln["code"] in disputed:
            ids.update(ln.get("evidence", []))
    for f in truth.all_features():
        if f.get("boq_code") in disputed:
            ids.add(f.id)
    return ids


def _evaluate_project(truth: Project, pred: Project, cfg: EvalConfig, acc: _Acc, classes: dict) -> None:
    pid = (truth.boq or {}).get("project_id") or next(
        (s.meta.get("project_id") for s in truth.sheets.values()), str(truth.root))
    disputed = truth.open_dispute_codes() if cfg.exclude_disputed else set()
    acc.excluded["disputed_codes"][pid] = sorted(disputed)
    excl_gt = _excluded_gt_ids(truth, disputed)
    sheet_ids = sorted(set(truth.sheets) | set(pred.sheets))
    n_gt_items = 0
    for sid in sheet_ids:
        tsh = truth.sheets.get(sid)
        psh = pred.sheets.get(sid)
        meta = (tsh.meta if tsh else {}) | {}
        scale = (tsh.scale if tsh else None) or (psh.scale if psh else None)
        input_type = meta.get("input_type", (psh.meta.get("input_type") if psh else None) or "vector")
        scale_conflict = bool(meta.get("scale_conflict", False))
        all_gt = [f for f in (tsh.features if tsh else []) if is_item(f)]
        all_pr = [f for f in (psh.features if psh else []) if is_item(f)]

        # 1) class-agnostic matching: item metric + dispute exclusion of predictions
        m_all = match(all_gt, all_pr, cfg.match)
        gt_of_pred = {j: i for i, j, _ in m_all.pairs}
        keep_pred = []
        for j, p in enumerate(all_pr):
            if j in gt_of_pred:
                drop = all_gt[gt_of_pred[j]].id in excl_gt
            else:
                drop = p.get("boq_code") in disputed
            if drop:
                acc.excluded["pred_items"] += 1
            else:
                keep_pred.append(j)
        keep_gt = [i for i, g in enumerate(all_gt) if g.id not in excl_gt]
        acc.excluded["gt_items"] += len(all_gt) - len(keep_gt)
        gts = [all_gt[i] for i in keep_gt]
        prs = [all_pr[j] for j in keep_pred]
        n_gt_items += len(gts)
        acc.n_pred_items += len(prs)

        # item-level correctness (class-agnostic geometric match, then attribute checks)
        mi = match(gts, prs, cfg.match)
        g_for_p = {j: i for i, j, _ in mi.pairs}
        for j, p in enumerate(prs):
            reasons: list[str] = []
            room_ok = None
            if j not in g_for_p:
                reasons.append("unmatched")
            else:
                g = gts[g_for_p[j]]
                if g.cls != p.cls:
                    reasons.append("class")
                if (g.get("boq_code") or None) != (p.get("boq_code") or None):
                    reasons.append("boq_code")
                if g.get("lifecycle") != p.get("lifecycle"):
                    reasons.append("lifecycle")
                if g.get("floor") != p.get("floor"):
                    reasons.append("floor")
                if g.get("room_id") is not None:
                    room_ok = g.get("room_id") == p.get("room_id")
                if g.kind in ("area", "linear"):
                    qa, qp = item_quantity(g, scale), item_quantity(p, scale)
                    if qa is None or qp is None:
                        reasons.append("quantity_unknown")
                    else:
                        pe = abs(qp - qa) / qa if qa > 0 else (0.0 if abs(qp) < EPS else float("inf"))
                        if pe > area_tolerance(g, cfg) + EPS:
                            reasons.append("quantity")
                    if g.cls == "room" and g.geom_type == "Polygon" and p.geom_type == "Polygon":
                        acc.room_ious.append(polygon_iou(g, p))
            acc.items.append(ItemRecord(
                project_id=pid, sheet_id=sid, pred_id=p.id, cls=p.cls,
                domain=p.get("domain") or class_domain(p.cls, classes), correct=not reasons, reasons=reasons,
                confidence=p.get("confidence"), level=p.get("level"), input_type=input_type,
                scale_conflict=scale_conflict, kind=p.kind, room_correct=room_ok))
        for i in mi.unmatched_gt:
            acc.fn_items.append((pid, sid, gts[i].id))

        # 2) per-class detection matching
        classes_here = sorted({f.cls for f in gts} | {f.cls for f in prs})
        un_g: list[Feature] = []
        un_p: list[Feature] = []
        for c in classes_here:
            gc = [f for f in gts if f.cls == c]
            pc = [f for f in prs if f.cls == c]
            mc = match(gc, pc, cfg.match)
            tp = len(mc.pairs)
            acc.class_counts[c]["tp"] += tp
            acc.class_counts[c]["fp"] += len(mc.unmatched_pred)
            acc.class_counts[c]["fn"] += len(mc.unmatched_gt)
            acc.confusion[c][c] += tp
            un_g += [gc[i] for i in mc.unmatched_gt]
            un_p += [pc[j] for j in mc.unmatched_pred]
        mx = match(un_g, un_p, cfg.match)
        for i, j, _ in mx.pairs:
            acc.confusion[un_g[i].cls][un_p[j].cls] += 1
        for i in mx.unmatched_gt:
            acc.confusion[un_g[i].cls]["<missed>"] += 1
        for j in mx.unmatched_pred:
            acc.confusion["<background>"][un_p[j].cls] += 1

    # 3) BOQ lines
    pred_lines = {ln["code"]: ln for ln in pred.boq_lines()}
    truth_codes = set()
    for ln in truth.boq_lines():
        code = ln["code"]
        truth_codes.add(code)
        if code in disputed or not eligible_truth_line(ln, cfg):
            continue
        q = float(ln["quantity"])
        pl = pred_lines.get(code)
        qh = float(pl["quantity"]) if pl is not None else None
        kind = unit_kind(ln.get("unit", ""))
        ae = abs((qh or 0.0) - q)
        res: dict[str, Any] = {"project_id": pid, "code": code, "unit": ln.get("unit"), "kind": kind,
                               "quantity": q, "predicted": qh, "proposed": pl is not None, "ae": ae}
        if kind == "count" or kind == "other":
            res["pe"] = ae / max(q, 1.0)
            res["correct"] = pl is not None and abs(qh - q) < EPS
        elif kind in ("area", "length"):
            pe = ae / q if q > 0 else (0.0 if ae < EPS else float("inf"))
            res["pe"] = pe
            res["tolerance_pe"] = line_tolerance(ln, cfg)
            res["correct"] = pl is not None and pe <= res["tolerance_pe"] + EPS
        else:  # lump sum: correct if proposed with the GT quantity (normally 1.0)
            res["pe"] = ae / max(q, 1.0)
            res["correct"] = pl is not None and abs(qh - q) < EPS
        acc.line_results.append(res)
    for code, pl in pred_lines.items():
        if code not in truth_codes and code not in disputed:
            acc.extra_lines.append({"project_id": pid, "code": code, "quantity": pl.get("quantity")})
    acc.dataset.append({"project_id": pid, "n_sheets": len(sheet_ids), "n_gt_items": n_gt_items,
                        "gt_version": (truth.boq or {}).get("gt_version")})


def polygon_iou(a: Feature, b: Feature) -> float:
    from shapely.geometry import Polygon

    pa, pb = Polygon(a.coords[0], a.coords[1:]), Polygon(b.coords[0], b.coords[1:])
    if not pa.is_valid or not pb.is_valid:
        pa, pb = pa.buffer(0), pb.buffer(0)
    union = pa.union(pb).area
    return float(pa.intersection(pb).area / union) if union > 0 else 0.0


# ----------------------------------------------------------------------------- aggregation

def _detection_summary(acc: _Acc, cfg: EvalConfig, classes: dict) -> dict[str, Any]:
    per_class = {c: prf(v["tp"], v["fp"], v["fn"]) for c, v in sorted(acc.class_counts.items())}
    tot = Counter()
    by_domain: dict[str, Counter] = defaultdict(Counter)
    for c, v in acc.class_counts.items():
        tot.update(v)
        by_domain[class_domain(c, classes)].update(v)
    macro_classes = [c for c, m in per_class.items() if m["support"] >= cfg.macro_min_support and m["f1"] is not None]
    macro = (sum(per_class[c]["f1"] for c in macro_classes) / len(macro_classes)) if macro_classes else None
    return {
        "per_class": per_class,
        "micro": prf(tot["tp"], tot["fp"], tot["fn"]),
        "macro": {"f1": macro, "classes": macro_classes, "min_support": cfg.macro_min_support},
        "per_domain": {d: prf(v["tp"], v["fp"], v["fn"]) for d, v in sorted(by_domain.items())},
        "confusion": {g: dict(sorted(row.items())) for g, row in sorted(acc.confusion.items())},
    }


def _boq_summary(acc: _Acc) -> dict[str, Any]:
    lines = acc.line_results
    count_lines = [r for r in lines if r["kind"] in ("count", "other")]
    qty_lines = [r for r in lines if r["kind"] in ("area", "length")]
    ae_by_chapter: dict[str, float] = defaultdict(float)
    for r in count_lines:
        ae_by_chapter[chapter_of(r["code"])] += r["ae"]
    pes = [r["pe"] for r in count_lines]
    n_ok = sum(1 for r in lines if r["correct"])
    return {
        "n_lines_evaluated": len(lines),
        "count_error": {
            "n_lines": len(count_lines),
            "sum_ae_by_chapter": dict(sorted(ae_by_chapter.items())),
            "median_pe": percentile(pes, 50),
            "p90_pe": percentile(pes, 90),
            "n_lines_ae_gt_0": sum(1 for r in count_lines if r["ae"] > EPS),
        },
        "area_length_error": {
            "n_lines": len(qty_lines),
            "median_pe": percentile([r["pe"] for r in qty_lines], 50),
            "n_within_tolerance": sum(1 for r in qty_lines if r["correct"]),
        },
        "exact_match": {"rate": n_ok / len(lines) if lines else None, "n_correct": n_ok, "n_lines": len(lines),
                        "n_not_proposed": sum(1 for r in lines if not r["proposed"])},
        "extra_lines": acc.extra_lines,
        "lines": lines,
    }


def _items_summary(acc: _Acc) -> dict[str, Any]:
    n_pred = len(acc.items)
    n_ok = sum(1 for it in acc.items if it.correct)
    n_fn = len(acc.fn_items)
    denom = n_pred + n_fn
    reasons = Counter(r for it in acc.items for r in it.reasons)
    room = [it.room_correct for it in acc.items if it.room_correct is not None]
    return {
        "rate": n_ok / denom if denom else None,
        "wilson_lb95": wilson_lower(n_ok, denom) if denom else None,
        "n_correct": n_ok, "n_predicted": n_pred, "n_fn": n_fn, "denominator": denom,
        "error_reasons": dict(sorted(reasons.items())),
        "room_accuracy_measured_not_gated": (sum(room) / len(room)) if room else None,
        "room_iou": {"n": len(acc.room_ious), "mean": (sum(acc.room_ious) / len(acc.room_ious)) if acc.room_ious else None,
                     "frac_ge_0_95": (sum(1 for v in acc.room_ious if v >= 0.95) / len(acc.room_ious)) if acc.room_ious else None},
    }


def _calibration_summary(acc: _Acc, cfg: EvalConfig, classes: dict) -> dict[str, Any]:
    scored = [it for it in acc.items if it.confidence is not None]
    rel = reliability([it.confidence for it in scored], [it.correct for it in scored], cfg.n_bins)
    per_level = {}
    for lvl in ("green", "yellow", "red"):
        sub = [it for it in scored if it.level == lvl]
        per_level[lvl] = reliability([it.confidence for it in sub], [it.correct for it in sub], cfg.n_bins)
    per_domain = {}
    for dom in sorted({it.domain for it in scored}):
        sub = [it for it in scored if it.domain == dom]
        per_domain[dom] = reliability([it.confidence for it in sub], [it.correct for it in sub], cfg.n_bins)

    greens = [it for it in acc.items if it.level == "green"]
    k = sum(1 for it in greens if it.correct)
    n = len(greens)
    n_req0 = min_n_for_lower_bound(cfg.green_target, errors=0)
    lb = wilson_lower(k, n)
    green_by_domain = {}
    for dom in sorted({it.domain for it in greens}):
        sub = [it for it in greens if it.domain == dom]
        kd = sum(1 for it in sub if it.correct)
        lbd = wilson_lower(kd, len(sub))
        green_by_domain[dom] = {"n": len(sub), "correct": kd, "p": kd / len(sub), "wilson_lb95": lbd,
                                "checked": len(sub) >= cfg.domain_green_min_n,
                                "pass": (lbd is not None and lbd >= cfg.domain_green_lb) if len(sub) >= cfg.domain_green_min_n else None}

    # class green eligibility (conservative calibration, stages A/B): green allowed only for
    # classes with >= class_green_min_items predicted items and precision == 1.0
    per_class_items: dict[str, list[ItemRecord]] = defaultdict(list)
    for it in acc.items:
        per_class_items[it.cls].append(it)
    eligible = sorted(c for c, its in per_class_items.items()
                      if len(its) >= cfg.class_green_min_items and all(i.correct for i in its))
    ineligible_green = sorted({it.cls for it in greens if it.cls not in eligible})

    violations = []
    for it in acc.items:
        if it.input_type == "raster" and it.level == "green":
            violations.append({"rule": "raster_sheet_green", "sheet_id": it.sheet_id, "item": it.pred_id})
        if it.scale_conflict and it.kind in ("area", "linear") and it.level != "red":
            violations.append({"rule": "scale_conflict_area_not_red", "sheet_id": it.sheet_id, "item": it.pred_id})

    sample_ok = n >= (n_req0 or 0)
    return {
        "n_scored": len(scored),
        "reliability": rel,
        "ece": rel["ece"], "mce": rel["mce"], "brier": rel["brier"],
        "per_level": per_level,
        "per_domain": per_domain,
        "green": {
            "n": n, "correct": k, "p_green": (k / n) if n else None,
            "wilson_lb95": lb, "wilson_ub95": wilson_upper(k, n) if n else None,
            "target": cfg.green_target,
            "min_n_at_zero_errors": n_req0,
            "sufficient_sample": sample_ok,
            "pass": bool(lb is not None and lb >= cfg.green_target and sample_ok),
            "by_domain": green_by_domain,
            "eligible_classes": eligible,
            "green_in_ineligible_classes": ineligible_green,
        },
        "ceiling_violations": violations,
    }


def _burden_summary(acc: _Acc) -> dict[str, Any]:
    leveled = [it for it in acc.items if it.level is not None]
    n = len(leveled)
    yr = [it for it in leveled if it.level in ("yellow", "red")]
    errors = [it for it in leveled if not it.correct]
    errors_in_yr = [it for it in yr if not it.correct]
    scored = [it for it in acc.items if it.confidence is not None]
    return {
        "burden": len(yr) / n if n else None,
        "n_items": n, "n_yellow": sum(1 for it in leveled if it.level == "yellow"),
        "n_red": sum(1 for it in leveled if it.level == "red"),
        "n_green": sum(1 for it in leveled if it.level == "green"),
        "yield_of_review": len(errors_in_yr) / len(errors) if errors else None,
        "n_errors": len(errors),
        "risk_auc": auc([1.0 - it.confidence for it in scored], [not it.correct for it in scored]),
    }


def evaluate(pairs: Iterable[tuple[Project, Project]], cfg: EvalConfig | None = None) -> dict[str, Any]:
    cfg = cfg or EvalConfig()
    classes = load_classes()
    acc = _Acc()
    for truth, pred in pairs:
        _evaluate_project(truth, pred, cfg, acc, classes)
    cal = _calibration_summary(acc, cfg, classes)
    return {
        "config": cfg.to_dict(),
        "dataset": {"projects": acc.dataset, "n_pred_items": acc.n_pred_items, "excluded": acc.excluded},
        "detection": _detection_summary(acc, cfg, classes),
        "boq": _boq_summary(acc),
        "items_correct": _items_summary(acc),
        "calibration": cal,
        "review_burden": _burden_summary(acc),
        "ceiling_violations": cal.pop("ceiling_violations"),
        "items": [asdict(it) for it in acc.items],
        "fn_items": [{"project_id": a, "sheet_id": b, "gt_id": c} for a, b, c in acc.fn_items],
    }
