"""Compare by-eye sheet GT with a run's detections AFTER the GT exists (Sprint 11 Data/QA).

Lists per sheet: same-class matches, class confusions (GT and detection at the same place, different class),
GT-only items (misses) and detection-only items (false positives), and writes a marks file for
`render_tiles.py --marks` so that every disagreement is looked at again on the render.

    uv run python -I tools/gt/compare_detections.py <project> <run-dir> [--tol 3] [--sheet SHA8] [--out DIR]
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import os
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from scipy.optimize import linear_sum_assignment

Item = dict[str, object]


def data_dir() -> Path:
    return Path(os.environ.get("KAMUTAN_DATA_DIR", "/home/claude/kamutan-data"))


def load_truth(project: str) -> dict[str, list[Item]]:
    sheets: dict[str, list[Item]] = {}
    for path in sorted((data_dir() / "gt" / project / "sheets").glob("*.geojson")):
        doc = json.loads(path.read_text(encoding="utf-8"))
        items: list[Item] = []
        for feat in doc["features"]:
            props = feat["properties"]
            if feat["geometry"]["type"] != "Point":
                continue
            x, y = feat["geometry"]["coordinates"]
            items.append(
                {"id": props["id"], "cls": props["class"], "x": float(x), "y": float(y), "kind": props.get("kind", "symbol")}
            )
        sheets[doc["kamutan"]["sheet_id"]] = items
    return sheets


def load_detections(run_dir: Path, sheet_ids: set[str]) -> dict[str, list[Item]]:
    out: dict[str, list[Item]] = {}
    for path in sorted(run_dir.glob("artifacts/**/sheets/*/versions/*/detections.json.gz")):
        worker_id = path.parts[-4]
        sheet = next((s for s in sheet_ids if s in worker_id), None)
        if sheet is None:
            continue
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            doc = json.load(handle)
        items: list[Item] = []
        for det in doc.get("detections", []):
            centre = det.get("centerMm") or {}
            if "x" not in centre:
                box = det.get("bboxMm") or {}
                centre = {"x": box.get("x", 0) + box.get("w", 0) / 2, "y": box.get("y", 0) + box.get("h", 0) / 2}
            items.append(
                {
                    "id": det.get("id"),
                    "cls": det.get("class"),
                    "x": float(centre["x"]),
                    "y": float(centre["y"]),
                    "level": det.get("level"),
                    "score": det.get("score"),
                }
            )
        out[sheet] = items
    return out


def assign(gts: list[Item], prs: list[Item], tol: float) -> list[tuple[int, int]]:
    if not gts or not prs:
        return []
    cost = np.full((len(gts), len(prs)), 1e6)
    for i, g in enumerate(gts):
        for j, p in enumerate(prs):
            d = math.hypot(float(g["x"]) - float(p["x"]), float(g["y"]) - float(p["y"]))  # type: ignore[arg-type]
            if d <= tol:
                cost[i, j] = d
    rows, cols = linear_sum_assignment(cost)
    return [(int(i), int(j)) for i, j in zip(rows, cols, strict=True) if cost[i, j] < 1e6]


def compare_sheet(gts: list[Item], prs: list[Item], tol: float) -> dict[str, list[tuple[Item | None, Item | None]]]:
    """Same-class matching first (per class), then leftover GT vs leftover detections of any class."""
    result: dict[str, list[tuple[Item | None, Item | None]]] = {"match": [], "confusion": [], "fn": [], "fp": []}
    used_g: set[int] = set()
    used_p: set[int] = set()
    for cls in sorted({str(g["cls"]) for g in gts}):
        gi = [i for i, g in enumerate(gts) if g["cls"] == cls]
        pi = [j for j, p in enumerate(prs) if p["cls"] == cls]
        for a, b in assign([gts[i] for i in gi], [prs[j] for j in pi], tol):
            used_g.add(gi[a])
            used_p.add(pi[b])
            result["match"].append((gts[gi[a]], prs[pi[b]]))
    gi = [i for i in range(len(gts)) if i not in used_g]
    pi = [j for j in range(len(prs)) if j not in used_p]
    for a, b in assign([gts[i] for i in gi], [prs[j] for j in pi], tol):
        used_g.add(gi[a])
        used_p.add(pi[b])
        result["confusion"].append((gts[gi[a]], prs[pi[b]]))
    result["fn"] = [(gts[i], None) for i in range(len(gts)) if i not in used_g]
    result["fp"] = [(None, prs[j]) for j in range(len(prs)) if j not in used_p]
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project")
    parser.add_argument("run_dir", type=Path)
    parser.add_argument("--tol", type=float, default=3.0)
    parser.add_argument("--sheet", default=None)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()
    truth = load_truth(args.project)
    if args.sheet:
        truth = {args.sheet: truth[args.sheet]}
    dets = load_detections(args.run_dir, set(truth))
    totals: dict[str, Counter[str]] = defaultdict(Counter)
    for sheet, gts in truth.items():
        prs = dets.get(sheet)
        if prs is None:
            print(f"== {sheet}: no detections in run")
            continue
        res = compare_sheet(gts, prs, args.tol)
        print(
            f"== {sheet}: gt {len(gts)} det {len(prs)} match {len(res['match'])} confusion {len(res['confusion'])} fn {len(res['fn'])} fp {len(res['fp'])}"
        )
        marks: list[dict[str, object]] = []
        for g, p in res["match"]:
            assert g and p
            totals[str(g["cls"])]["tp"] += 1
        for g, p in res["confusion"]:
            assert g and p
            totals[str(g["cls"])]["fn"] += 1
            totals[str(p["cls"])]["fp"] += 1
            print(
                f"  CONF gt {g['cls']} ({g['x']:.1f},{g['y']:.1f}) [{g['id']}] <-> det {p['cls']} ({p['x']:.1f},{p['y']:.1f}) {p['level']}"
            )
            marks.append({"x": g["x"], "y": g["y"], "label": f"G:{g['cls']}", "color": "green", "r": 3.2})
            marks.append({"x": p["x"], "y": p["y"], "label": f"D:{p['cls']}", "color": "blue", "r": 2.4})
        for g, _ in res["fn"]:
            assert g
            totals[str(g["cls"])]["fn"] += 1
            print(f"  FN   gt {g['cls']} ({g['x']:.1f},{g['y']:.1f}) [{g['id']}]")
            marks.append({"x": g["x"], "y": g["y"], "label": f"G:{g['cls']}", "color": "green", "r": 3.2})
        for _, p in res["fp"]:
            assert p
            totals[str(p["cls"])]["fp"] += 1
            print(f"  FP   det {p['cls']} ({p['x']:.1f},{p['y']:.1f}) {p['level']} {p['id']}")
            marks.append({"x": p["x"], "y": p["y"], "label": f"D:{p['cls']}", "color": "blue", "r": 2.4})
        if args.out:
            args.out.mkdir(parents=True, exist_ok=True)
            (args.out / f"{args.project}_{sheet}_marks.json").write_text(json.dumps(marks))
            allm = [{"x": g["x"], "y": g["y"], "label": str(g["cls"]), "color": "green", "r": 3.0} for g in gts]
            (args.out / f"{args.project}_{sheet}_gt_marks.json").write_text(json.dumps(allm))
    print("class tp fp fn")
    for cls in sorted(totals):
        c = totals[cls]
        print(f"{cls} {c['tp']} {c['fp']} {c['fn']}")


if __name__ == "__main__":
    main()
