"""Per-class precision / recall of a run against the by-eye sheet GT, across projects (Sprint 11 Data/QA).

Reads the `kbench eval --truth gt/<p> --pred-detections <run>/artifacts` metrics of each project (runs kbench when
the JSON is missing or `--rerun`), sums TP / FP / FN per class, adds class *families* (any luminaire, any switch, any
socket) matched class-agnostically inside the family, and says which classes have >= 200 checked items.

    uv run python -I tools/gt/pr_report.py --run warmfix_cold [--projects ...] [--rerun] [--out gt/eval_sprint11_symbols.md]
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from collections import Counter, defaultdict
from pathlib import Path

from compare_detections import compare_sheet, load_detections, load_truth

FAMILIES: dict[str, set[str]] = {
    "luminaire (ceiling+wall+pendant+outdoor+fan light)": {
        "luminaire_ceiling",
        "luminaire_wall",
        "luminaire_pendant",
        "luminaire_outdoor",
        "ceiling_fan",
    },
    "switch (single+2way+cross+shutter+fan)": {"switch_single", "switch_2way", "switch_cross", "switch_shutter", "switch_fan"},
    "socket (single+double+triple)": {"socket_single", "socket_double", "socket_triple"},
    "socket, power family (power+power_double+3phase)": {"socket_power", "socket_power_double", "socket_3phase"},
    "comms point (data+tv+phone)": {"data_point", "tv_point", "phone_point"},
}
# Not scored as detection classes: linear items, free-text notes, and AC units (GT position = centre of the dashed
# outline, the worker's ac_unit comes from the fixtures stage with another anchor).
NOT_SCORED = {"conduit_cobra", "luminaire_strip", "note_point", "unknown", "ac_unit"}
MIN_CHECKED = 200


def data_dir() -> Path:
    return Path(os.environ.get("KAMUTAN_DATA_DIR", "/home/claude/kamutan-data"))


def kbench_metrics(project: str, run: str, rerun: bool) -> dict[str, object]:
    out = data_dir() / "gt" / project / "eval" / f"s11_symbols_{run}.json"
    if rerun or not out.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                "kbench",
                "eval",
                "--truth",
                str(data_dir() / "gt" / project),
                "--pred-detections",
                str(data_dir() / "s10qa" / project / run / "artifacts"),
                "--out",
                str(out),
                "--report",
                str(out.with_suffix(".md")),
            ],
            check=True,
            capture_output=True,
        )
    return json.loads(out.read_text(encoding="utf-8"))  # type: ignore[no-any-return]


def prf(tp: int, fp: int, fn: int) -> tuple[str, str]:
    precision = f"{tp / (tp + fp):.3f}" if tp + fp else "–"
    recall = f"{tp / (tp + fn):.3f}" if tp + fn else "–"
    return precision, recall


def family_counts(project: str, run: str, classes: set[str], tol: float) -> Counter[str]:
    truth = load_truth(project)
    dets = load_detections(data_dir() / "s10qa" / project / run, set(truth))
    total: Counter[str] = Counter()
    for sheet, gts in truth.items():
        if sheet not in dets:
            continue
        fam_g = [dict(g, cls="fam") for g in gts if g["cls"] in classes and g.get("kind") == "symbol"]
        fam_p = [dict(p, cls="fam") for p in dets[sheet] if p["cls"] in classes]
        res = compare_sheet(fam_g, fam_p, tol)
        total["tp"] += len(res["match"])
        total["fn"] += len(res["fn"])
        total["fp"] += len(res["fp"])
    return total


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", default="warmfix_cold")
    parser.add_argument("--projects", nargs="*", default=["noah", "rubel", "achituv", "yahav"])
    parser.add_argument("--rerun", action="store_true")
    parser.add_argument("--tol", type=float, default=3.0)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    per_project: dict[str, dict[str, Counter[str]]] = {}
    levels: dict[str, Counter[str]] = defaultdict(Counter)
    sheets: dict[str, list[str]] = {}
    for project in args.projects:
        if not (data_dir() / "gt" / project / "sheets").is_dir():
            continue
        metrics = kbench_metrics(project, args.run, args.rerun)
        symbols = metrics["symbols"]
        assert isinstance(symbols, dict)
        per_project[project] = {
            cls: Counter(tp=row["tp"], fp=row["fp"], fn=row["fn"]) for cls, row in symbols["detection"]["per_class"].items()
        }
        for item in symbols["items"]:
            if item["cls"] in NOT_SCORED:
                continue
            levels[str(item.get("level"))]["n"] += 1
            levels[str(item.get("level"))]["correct"] += (
                1 if not any("class" in r or "unmatched" in r for r in item["reasons"]) else 0
            )
        sheet_rows = metrics["sheets"]
        assert isinstance(sheet_rows, dict)
        sheets[project] = sorted(str(row) for row in sheet_rows["symbols"])

    classes = sorted({cls for rows in per_project.values() for cls in rows})
    lines = [
        f"# Sprint 11 — per-class precision / recall against the by-eye GT (run `{args.run}`, centre tolerance {args.tol:g} mm)",
        "",
        "GT: `gt/<p>/sheets/*.geojson` (`eye-s11-v1`, independent by-eye annotation, not seeded from the detector).",
        "Sheets scored: " + "; ".join(f"{p}: {', '.join(s)}" for p, s in sheets.items()),
        "",
        "`checked (pred)` = TP + FP = detections of that class compared with the GT (the precision denominator, what the",
        f"green rule needs >= {MIN_CHECKED} of); `GT` = TP + FN. Classes in italics are not scored as detection classes.",
        "",
        "| class | GT | checked (pred) | TP | FP | FN | P | R | " + " | ".join(f"{p} TP/FP/FN" for p in per_project) + " |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | " + " | ".join("---" for _ in per_project) + " |",
    ]
    eligible: list[str] = []
    for cls in classes:
        tot: Counter[str] = Counter()
        cells = []
        for rows in per_project.values():
            row = rows.get(cls, Counter())
            tot.update(row)
            cells.append(f"{row['tp']}/{row['fp']}/{row['fn']}" if row else "–")
        precision, recall = prf(tot["tp"], tot["fp"], tot["fn"])
        name = f"*{cls}*" if cls in NOT_SCORED else cls
        lines.append(
            f"| {name} | {tot['tp'] + tot['fn']} | {tot['tp'] + tot['fp']} | {tot['tp']} | {tot['fp']} | {tot['fn']} | {precision} | {recall} | "
            + " | ".join(cells)
            + " |"
        )
        if cls not in NOT_SCORED and tot["tp"] + tot["fp"] >= MIN_CHECKED:
            eligible.append(f"{cls}: {tot['tp'] + tot['fp']} checked, precision {precision}")
    lines += ["", "## Class families (matched class-agnostically inside the family)", ""]
    lines += ["| family | GT | checked (pred) | TP | FP | FN | P | R |", "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    for name, members in FAMILIES.items():
        tot = Counter()
        for project in per_project:
            tot.update(family_counts(project, args.run, members, args.tol))
        precision, recall = prf(tot["tp"], tot["fp"], tot["fn"])
        lines.append(
            f"| {name} | {tot['tp'] + tot['fn']} | {tot['tp'] + tot['fp']} | {tot['tp']} | {tot['fp']} | {tot['fn']} | {precision} | {recall} |"
        )
        if tot["tp"] + tot["fp"] >= MIN_CHECKED:
            eligible.append(f"family '{name}': {tot['tp'] + tot['fp']} checked, precision {precision}")
    lines += ["", f"## Classes with >= {MIN_CHECKED} checked items", ""]
    lines += [f"* {row}" for row in eligible] or ["* none"]
    lines += ["", "## Detections by level (scored classes)", ""]
    for level, row in sorted(levels.items()):
        lines.append(f"* {level}: {row['n']} detections")
    text = "\n".join(lines) + "\n"
    out = args.out or data_dir() / "gt" / f"eval_sprint11_symbols_{args.run}.md"
    out.write_text(text, encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
