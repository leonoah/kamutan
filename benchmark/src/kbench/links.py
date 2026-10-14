"""Switch<->luminaire link groups (Sprint 3): truth loading, worker adapter, metrics, implied composite BOQ counts.

Truth: ``<gt>/links/<sheet>.json`` (``kamutan.links-truth/1``, schema ``schema/links.schema.json``). Ids are the
point-GT feature ids of the sheet's switches and luminaires.

Prediction: the worker's ``kamutan.links/1`` artifact (``DIR/**/sheets/<s>/versions/<v>/links.json.gz``, newest
wins) whose ``switchIds`` / ``luminaireIds`` are detection ids of ``detections.json.gz`` in the same folder.
Predicted detections are mapped to truth ids by Hungarian centre-distance matching per family (switches,
luminaires incl. ceiling fans), class-agnostic inside the family, so a link is scored even when the detector
got the switch sub-type wrong. An unmatched predicted id stays ``?<id>`` and can never equal a truth set.

Metrics (per sheet and pooled; groups carrying a ``dispute_id`` and their switches/luminaires are excluded from the
gated numbers and reported separately):

- group exact match: a truth group is matched when one predicted group has exactly the same switch set and the
  same luminaire set (after mapping). recall = matched / truth groups, precision = matched / predicted groups.
- switch -> point assignment accuracy: per truth switch, the luminaire set of the predicted group containing the
  mapped switch equals the truth set (an undetected switch is wrong; counted separately).
- luminaire -> switch accuracy: per truth luminaire, the switch set of its predicted group equals the truth set.
- composite-kind accuracy: per truth group, the predicted group with the largest Jaccard overlap (ids) — kind equal?
  Reported over overlapping groups and over exact-matched groups; plus a kind confusion table.
- green-group precision (LK-06: never a wrong green): exact-match rate of predicted groups with level green.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .data import Feature, Project
from .matching import MatchParams, match
from .stats import wilson_lower
from .worker import detections_to_features, find_artifacts, map_sheet_id, read_json_any

LINKS_SCHEMA = "kamutan.links/1"
LINKS_TRUTH_FORMAT = "kamutan.links-truth/1"
KINDS = ("single", "two_way", "shared", "sensor", "add_to_existing")


def family(cls: str | None) -> str | None:
    c = cls or ""
    if c.startswith("switch"):
        return "switch"
    if c.startswith("luminaire") or c == "ceiling_fan":
        return "luminaire"
    return None


@dataclass
class Group:
    id: str
    kind: str
    switches: frozenset[str]
    luminaires: frozenset[str]
    level: str | None = None
    confidence: float | None = None
    dispute_id: str | None = None
    duplicate_of: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def ids(self) -> frozenset[str]:
        return self.switches | self.luminaires


def group_from_dict(g: dict[str, Any], id_map: dict[str, str] | None = None) -> Group:
    def m(i: str) -> str:
        if id_map is None:
            return i
        return id_map.get(i, f"?{i}")

    lum = g.get("luminaireIds") or g.get("pointIds") or []
    dup = g.get("cross_sheet_duplicate_of")
    return Group(
        id=str(g["id"]),
        kind=str(g.get("kind")),
        switches=frozenset(m(str(i)) for i in g.get("switchIds", [])),
        luminaires=frozenset(m(str(i)) for i in lum),
        level=g.get("level"),
        confidence=g.get("confidence"),
        dispute_id=g.get("dispute_id"),
        duplicate_of=(dup or {}).get("group_id") if isinstance(dup, dict) else None,
        raw=g,
    )


# ----------------------------------------------------------------------------- loading


def load_truth_links(gt_dir: str | Path) -> dict[str, dict[str, Any]]:
    d = Path(gt_dir) / "links"
    out: dict[str, dict[str, Any]] = {}
    if d.is_dir():
        for p in sorted(d.glob("*.json")):
            doc = json.loads(p.read_text(encoding="utf-8"))
            out[str(doc.get("sheet_id") or p.stem)] = doc
    return out


@dataclass
class PredLinks:
    groups: dict[str, list[dict[str, Any]]] = field(default_factory=dict)  # sheet -> raw groups (detection ids)
    detections: dict[str, list[Feature]] = field(default_factory=dict)  # sheet -> features (id = raw detection id)
    sources: dict[str, dict[str, str]] = field(default_factory=dict)


def load_pred_links(root: str | Path, truth_ids: set[str], sheet_map: dict[str, str] | None = None) -> PredLinks:
    """Read ``links.json.gz`` (or ``links.json``) + the sibling ``detections.json.gz`` per sheet."""
    out = PredLinks()
    found = find_artifacts(root, "links.json")
    found.update(find_artifacts(root, "links.json.gz"))
    for wid, path in found.items():
        sid = map_sheet_id(wid, truth_ids, sheet_map)
        if sid not in truth_ids:
            continue
        obj = read_json_any(path)
        if obj.get("schema") != LINKS_SCHEMA:
            raise ValueError(f"{path}: expected schema {LINKS_SCHEMA}, got {obj.get('schema')!r}")
        out.groups[sid] = list(obj.get("groups", []))
        out.sources[sid] = {"links": str(path), "links_sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        det = path.with_name("detections.json.gz")
        if det.exists():
            feats = detections_to_features(read_json_any(det), sid)
            for f in feats:  # links reference raw detection ids
                f.id = f.id.split(":", 1)[1] if f.id.startswith(f"{sid}:") else f.id
            out.detections[sid] = feats
    return out


def map_detections(truth_feats: list[Feature], pred_feats: list[Feature], tol_mm: float = 3.0) -> dict[str, str]:
    """pred detection id -> truth id, Hungarian per family on centre distance."""
    out: dict[str, str] = {}
    params = MatchParams(center_tol_mm=tol_mm, mode="center")
    for fam in ("switch", "luminaire"):
        gts = [f for f in truth_feats if family(f.cls) == fam]
        prs = [f for f in pred_feats if family(f.cls) == fam]
        for gi, pj, _q in match(gts, prs, params).pairs:
            out[prs[pj].id] = gts[gi].id
    return out


# ----------------------------------------------------------------------------- metrics


def _jacc(a: frozenset[str], b: frozenset[str]) -> float:
    u = a | b
    return len(a & b) / len(u) if u else 0.0


def _rate(k: int, n: int) -> dict[str, Any]:
    return {"k": k, "n": n, "p": round(k / n, 4) if n else None, "wilson_lb95": wilson_lower(k, n)}


def evaluate_sheet_links(truth: list[Group], pred: list[Group], detected_switches: set[str] | None = None) -> dict[str, Any]:
    """Score one sheet. ``truth``/``pred`` already in truth-id space."""
    excluded_ids: set[str] = set()
    for g in truth:
        if g.dispute_id:
            excluded_ids |= g.ids
    t_gate = [g for g in truth if not g.dispute_id]
    p_gate = [g for g in pred if not (g.ids & excluded_ids)]
    exact = {g.id: next((p.id for p in pred if p.switches == g.switches and p.luminaires == g.luminaires), None) for g in truth}
    matched_pred = {v for k, v in exact.items() if v and k in {g.id for g in t_gate}}

    sw_of_pred = {s: p for p in pred for s in p.switches}
    lum_of_pred = {lu: p for p in pred for lu in p.luminaires}
    sw_ok = sw_n = sw_missing = 0
    lum_ok = lum_n = 0
    errors: list[dict[str, Any]] = []
    for g in t_gate:
        for s in sorted(g.switches):
            sw_n += 1
            p = sw_of_pred.get(s)
            if p is None:
                sw_missing += 1
                if detected_switches is not None and s not in detected_switches:
                    errors.append({"type": "switch_not_detected", "truth_group": g.id, "id": s})
                else:
                    errors.append({"type": "switch_not_linked", "truth_group": g.id, "id": s})
            elif p.luminaires == g.luminaires:
                sw_ok += 1
            else:
                errors.append(
                    {
                        "type": "switch_wrong_points",
                        "truth_group": g.id,
                        "id": s,
                        "pred_group": p.id,
                        "missing": sorted(g.luminaires - p.luminaires),
                        "extra": sorted(p.luminaires - g.luminaires),
                    }
                )
        for lu in sorted(g.luminaires):
            lum_n += 1
            p = lum_of_pred.get(lu)
            if p is not None and p.switches == g.switches:
                lum_ok += 1

    kind_conf: Counter[tuple[str, str]] = Counter()
    kind_ok = kind_n = kind_ok_exact = kind_n_exact = 0
    for g in t_gate:
        best = max(pred, key=lambda p: _jacc(g.ids, p.ids), default=None)
        if best is None or _jacc(g.ids, best.ids) == 0:
            kind_conf[(g.kind, "<none>")] += 1
            continue
        kind_n += 1
        kind_ok += best.kind == g.kind
        kind_conf[(g.kind, best.kind)] += 1
        if best.kind != g.kind:
            errors.append(
                {"type": "kind", "truth_group": g.id, "pred_group": best.id, "truth_kind": g.kind, "pred_kind": best.kind}
            )

    pred_by_id = {p.id: p for p in pred}
    for g in t_gate:
        eid = exact[g.id]
        if eid:
            kind_n_exact += 1
            kind_ok_exact += pred_by_id[eid].kind == g.kind
    for g in t_gate:
        if not exact[g.id]:
            errors.append(
                {
                    "type": "group_not_exact",
                    "truth_group": g.id,
                    "kind": g.kind,
                    "switches": sorted(g.switches),
                    "luminaires": sorted(g.luminaires),
                }
            )
    extra = [p for p in p_gate if p.id not in matched_pred]
    for p in extra:
        errors.append(
            {
                "type": "pred_group_not_exact",
                "pred_group": p.id,
                "kind": p.kind,
                "level": p.level,
                "switches": sorted(p.switches),
                "luminaires": sorted(p.luminaires),
            }
        )

    greens = [p for p in p_gate if p.level == "green"]
    k_green = sum(1 for p in greens if p.id in matched_pred)
    per_level = {}
    for lvl in ("green", "yellow", "red"):
        sub = [p for p in p_gate if p.level == lvl]
        per_level[lvl] = _rate(sum(1 for p in sub if p.id in matched_pred), len(sub))

    disputed = []
    for g in truth:
        if g.dispute_id:
            best = max(pred, key=lambda p: _jacc(g.ids, p.ids), default=None)
            disputed.append(
                {
                    "truth_group": g.id,
                    "dispute_id": g.dispute_id,
                    "exact": bool(exact[g.id]),
                    "best_pred": best.raw if best is not None and _jacc(g.ids, best.ids) > 0 else None,
                }
            )
    return {
        "n_truth_groups": len(t_gate),
        "n_pred_groups": len(p_gate),
        "group_exact": {"recall": _rate(len(matched_pred), len(t_gate)), "precision": _rate(len(matched_pred), len(p_gate))},
        "switch_assignment": _rate(sw_ok, sw_n) | {"switch_without_pred_group": sw_missing},
        "luminaire_assignment": _rate(lum_ok, lum_n),
        "kind_accuracy": _rate(kind_ok, kind_n),
        "kind_accuracy_exact_groups": _rate(kind_ok_exact, kind_n_exact),
        "kind_confusion": [{"truth": a, "pred": b, "n": n} for (a, b), n in sorted(kind_conf.items())],
        "green_precision": _rate(k_green, len(greens)),
        "per_level_exact": per_level,
        "disputed": disputed,
        "errors": errors,
    }


def _pool(per: dict[str, dict[str, Any]], key: str, sub: str | None = None) -> dict[str, Any]:
    k = n = 0
    for m in per.values():
        r = m[key][sub] if sub else m[key]
        k += r["k"]
        n += r["n"]
    return _rate(k, n)


def evaluate_links(truth_docs: dict[str, dict[str, Any]], truth: Project, pred: PredLinks, tol_mm: float = 3.0) -> dict[str, Any]:
    per: dict[str, dict[str, Any]] = {}
    missing = []
    closed = {
        str(d.get("id")) for d in (truth.disputes or {}).get("disputes", []) if d.get("status") in ("resolved", "withdrawn")
    }
    for sid, doc in sorted(truth_docs.items()):
        tg = [group_from_dict(g) for g in doc.get("groups", [])]
        for g in tg:
            if g.dispute_id in closed:
                g.dispute_id = None
        if sid not in pred.groups:
            missing.append(sid)
            continue
        tfeats = truth.sheets[sid].features if sid in truth.sheets else []
        id_map = map_detections(tfeats, pred.detections.get(sid, []), tol_mm)
        pg = [group_from_dict(g, id_map) for g in pred.groups[sid]]
        detected = {v for v in id_map.values()}
        m = evaluate_sheet_links(tg, pg, detected)
        m["n_mapped_detections"] = len(id_map)
        per[sid] = m
    pooled = {
        "group_exact_recall": _pool(per, "group_exact", "recall"),
        "group_exact_precision": _pool(per, "group_exact", "precision"),
        "switch_assignment": _pool(per, "switch_assignment"),
        "luminaire_assignment": _pool(per, "luminaire_assignment"),
        "kind_accuracy": _pool(per, "kind_accuracy"),
        "kind_accuracy_exact_groups": _pool(per, "kind_accuracy_exact_groups"),
        "green_precision": _pool(per, "green_precision"),
    }
    return {"links": {"pooled": pooled, "sheets": per, "missing_pred_sheets": missing, "sources": pred.sources}}


# ----------------------------------------------------------------------------- implied composite BOQ


@dataclass(frozen=True)
class CompositeRules:
    """Group -> composite line code. Codes are TEXT."""

    single: str = "4.09"
    two_way: str = "4.10"
    shared: tuple[tuple[int, str], ...] = ((2, "4.11"), (3, "4.16"))
    add_two_way: str = "4.12"
    add_fan: str = "4.14"
    sensor: str = "4.15"
    install: str = "9.01"
    #: a fan switch anywhere adds one fan line (and is ignored when classifying its group)
    fan_switch_anywhere: bool = True
    #: skip a single/shared group whose points are all existing (an existing point re-switched is not a new point)
    skip_all_existing_points: bool = False
    #: skip a single/shared group whose switches are all existing
    skip_all_existing_switches: bool = False
    #: use each disputed group's first alt reading instead of the drawn one
    use_alt_readings: bool = False


def _classify(g: dict[str, Any], lifec: dict[str, str], cls: dict[str, str], r: CompositeRules) -> list[str]:
    sw = [s for s in g["switchIds"] if not (r.fan_switch_anywhere and cls.get(s) == "switch_fan")]
    fans = len(g["switchIds"]) - len(sw)
    codes: list[str] = []
    if r.fan_switch_anywhere:
        codes += [r.add_fan] * fans
    kind = g["kind"]
    lums = g.get("luminaireIds") or []
    pts = g.get("pointIds") or lums
    if kind == "sensor":
        return codes + [r.sensor]
    if kind == "add_to_existing":
        if fans and not sw:
            return codes
        return codes + ([r.add_fan] if any(cls.get(s) == "switch_fan" for s in sw) else [r.add_two_way])
    if kind == "two_way":
        return codes + [r.two_way]
    if r.skip_all_existing_points and lums and all(lifec.get(i) == "existing" for i in lums):
        return codes
    if r.skip_all_existing_switches and sw and all(lifec.get(i) == "existing" for i in sw):
        return codes
    if kind == "single" or len(pts) == 1:
        return codes + [r.single]
    for n, code in r.shared:
        if len(pts) == n:
            return codes + [code]
    return codes + [f"shared:{len(pts)}"]


def implied_composite_counts(
    truth_docs: dict[str, dict[str, Any]], truth: Project, rules: CompositeRules | None = None
) -> dict[str, Any]:
    rules = rules or CompositeRules()
    lifec: dict[str, str] = {}
    cls: dict[str, str] = {}
    for sh in truth.sheets.values():
        for f in sh.features:
            lifec[f.id] = str(f.get("lifecycle"))
            cls[f.id] = f.cls
    counts: Counter[str] = Counter()
    by_floor: dict[str, Counter[str]] = {}
    dup_lums: set[str] = set()
    trace: list[dict[str, Any]] = []
    for sid, doc in sorted(truth_docs.items()):
        for g in doc.get("groups", []):
            dup = g.get("cross_sheet_duplicate_of")
            if dup:
                dup_lums |= set(g.get("luminaireIds", []))
                trace.append({"group": g["id"], "codes": [], "note": f"cross-sheet duplicate of {dup.get('group_id')}"})
                continue
            variants = [g]
            if rules.use_alt_readings and g.get("alt_readings"):
                variants = [dict(x, id=f"{g['id']}#alt{i}") for i, x in enumerate(g["alt_readings"][0]["groups"])]
            for v in variants:
                codes = _classify(v, lifec, cls, rules)
                fl = g.get("floor")
                fl = fl if isinstance(fl, str) else "/".join(fl or [])
                for c in codes:
                    counts[c] += 1
                    by_floor.setdefault(c, Counter())[fl] += 1
                trace.append({"group": v["id"], "kind": v["kind"], "codes": codes})
    # install count: every luminaire position, minus ceiling fans, minus cross-sheet duplicates
    lum_all = []
    for doc in truth_docs.values():
        ids = [i for g in doc.get("groups", []) for i in g.get("luminaireIds", [])] + [
            u["id"] for u in doc.get("unlinked_luminaires", [])
        ]
        lum_all += ids
    fans = [i for i in lum_all if cls.get(i) == "ceiling_fan"]
    install = len(lum_all) - len(fans) - len(dup_lums)
    counts[rules.install] = install
    return {
        "counts": dict(sorted(counts.items())),
        "by_floor": {k: dict(v) for k, v in sorted(by_floor.items())},
        "install_breakdown": {
            "luminaires": len(lum_all),
            "ceiling_fans": len(fans),
            "cross_sheet_duplicates": len(dup_lums),
            "existing": sum(1 for i in lum_all if lifec.get(i) == "existing" and cls.get(i) != "ceiling_fan"),
        },
        "trace": trace,
    }


def render_links_markdown(m: dict[str, Any]) -> str:
    L = m["links"]
    p = L["pooled"]

    def f(r: dict[str, Any]) -> str:
        return f"{r['k']}/{r['n']} = {r['p']}" + (f" (LB95 {r['wilson_lb95']:.3f})" if r.get("wilson_lb95") is not None else "")

    lines = [
        "# kbench — link groups",
        "",
        f"gt_version: {m.get('gt_version')} · model: {m.get('model_version')}",
        "",
        "| metric | pooled |",
        "| --- | --- |",
    ]
    for k, v in p.items():
        lines.append(f"| {k} | {f(v)} |")
    lines += [
        "",
        "| sheet | truth groups | pred groups | exact R | exact P | switch acc | kind acc | green P |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for sid, s in L["sheets"].items():
        lines.append(
            f"| {sid} | {s['n_truth_groups']} | {s['n_pred_groups']} | {s['group_exact']['recall']['p']} | "
            f"{s['group_exact']['precision']['p']} | {s['switch_assignment']['p']} | {s['kind_accuracy']['p']} | "
            f"{s['green_precision']['p']} |"
        )
    if L["missing_pred_sheets"]:
        lines += ["", f"Sheets without predicted links: {', '.join(L['missing_pred_sheets'])}"]
    lines += ["", "## Errors", ""]
    for sid, s in L["sheets"].items():
        for e in s["errors"]:
            lines.append(f"- {sid} {json.dumps(e, ensure_ascii=False)}")
        for d in s["disputed"]:
            lines.append(f"- {sid} disputed (not gated) {d['truth_group']} {d['dispute_id']} exact={d['exact']}")
    return "\n".join(lines) + "\n"
