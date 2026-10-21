"""DEV ONLY: build ``calibration/table.json`` (``kamutan.calibration/1``) from kbench DEV evaluation outputs.

    cd workers/drawing
    uv run python scripts/calibration_table.py --eval EVAL.json [--links LINKS.json] \
        --gt-version gt-v0.4.1-draft --version cal-… [--out src/kamutan_drawing/calibration/table.json]

* ``--eval``: ``kbench eval --pred-detections`` output (``symbols.items``: one record per predicted item with
  ``cls``, ``domain``, ``confidence``, ``level``, ``reasons``; detection-correct = no ``unmatched`` / ``class``
  reason) and its ``rooms`` summary (matched / predicted rooms → class ``room``).
* ``--links``: ``kbench eval-links`` output (per-sheet ``kind_confusion`` of the matched groups → ``link:<kind>``;
  unmatched predicted groups count as wrong under their kind is not recoverable from the report, so the counts are
  matched groups only — documented in the table's ``notes``).
* DEV split only (the Noah set); never point it at holdout results. The table holds class statistics only.
* **Superseded** by Data/QA's ``kbench calibrate`` (same schema), which now generates the committed table; this
  stopgap refuses to write ``calibration/table.json`` and is kept only for quick local experiments.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from kamutan_drawing.calibration import TABLE_PATH, Record, build_table, link_key

WRONG = {"unmatched", "class"}
# brief domains: electrical | lighting | plumbing | tiling — AC drain points are BOQ chapter 03 (plumbing, 3.01)
DOMAIN_MAP = {"hvac": "plumbing"}


def records_from_eval(doc: dict[str, Any]) -> list[Record]:
    out: list[Record] = []
    for it in (doc.get("symbols") or {}).get("items") or []:
        conf = it.get("confidence")
        out.append(
            Record(
                cls=str(it["cls"]),
                domain=DOMAIN_MAP.get(str(it.get("domain") or "other"), str(it.get("domain") or "other")),
                score=float(conf) if isinstance(conf, int | float) else None,
                correct=not (WRONG & set(it.get("reasons") or [])),
            )
        )
    rooms = doc.get("rooms") or {}
    n_pred, n_ok = int(rooms.get("n_pred") or rooms.get("n_predicted") or 0), int(rooms.get("n_matched") or 0)
    out += [Record("room", "tiling", None, i < n_ok) for i in range(max(n_pred, n_ok))]
    return out


def records_from_links(doc: dict[str, Any]) -> list[Record]:
    out: list[Record] = []
    for sh in ((doc.get("links") or {}).get("sheets") or {}).values():
        for row in sh.get("kind_confusion") or []:
            pred = row.get("pred")
            if not pred:
                continue
            for _ in range(int(row.get("n") or 0)):
                out.append(Record(link_key(str(pred)), "lighting", None, row.get("truth") == pred))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--eval", type=Path, required=True)
    ap.add_argument("--links", type=Path, action="append", default=[])
    ap.add_argument("--gt-version", required=True)
    ap.add_argument("--version", required=True)
    ap.add_argument("--min-map-n", type=int, default=100)
    ap.add_argument("--out", type=Path, required=True, help="never the committed table (kbench calibrate owns it)")
    a = ap.parse_args()
    if a.out.resolve() == TABLE_PATH.resolve():
        print("refusing to overwrite the committed table: use kbench calibrate", file=sys.stderr)
        return 2
    ev = json.loads(a.eval.read_text())
    recs = records_from_eval(ev)
    for p in a.links:
        recs += records_from_links(json.loads(p.read_text()))
    doc = build_table(
        recs,
        version=a.version,
        generated_at=datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        gt_version=a.gt_version,
        mode="conservative",
        min_map_n=a.min_map_n,
        source="workers/drawing/scripts/calibration_table.py from kbench DEV eval (eval-worker items, eval-links kinds)",
    )
    doc["notes"] = [
        "DEV = the Noah sample project only (15 sheets); no class reaches 200 DEV items, so none may be green.",
        "link:<kind> counts are matched groups (kbench eval-links kind_confusion), not all predicted groups.",
        "room = predicted rooms matched to truth rooms at IoU >= 0.5 (kbench eval rooms summary).",
        "domain hvac (ac_unit) is reported under plumbing (BOQ 3.01).",
        "scoreMap is null where fewer than --min-map-n scored DEV items exist (isotonic fit would be noise).",
    ]
    a.out.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    n_allowed = sum(1 for c in doc["classes"].values() if c["greenAllowed"])
    print(f"{a.out}: {len(doc['classes'])} classes, {n_allowed} green-allowed, {len(recs)} records")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
