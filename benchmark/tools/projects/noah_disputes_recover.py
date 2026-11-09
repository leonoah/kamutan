#!/usr/bin/env python3
"""Sprint 10 Data/QA: re-add the Noah disputes lost with the data volume on 09.11 to gt/noah/disputes.json.

`benchmark/scripts/build_noah_draft_gt.py` rebuilds GT-D-001..004 only (Sprint-0 text). GT-D-005..008 and the
Sprint-2..4 hypotheses lived only in the lost gt/noah/disputes.json. They are reconstructed here from what git still
holds: benchmark/NOTES.md (Sprint 3 / 4 GT sections), workers/drawing/NOTES.md (Sprint 3 links results, Sprint 4 / 5 gaps,
Stage 10, Sprint 8 "Disputes … for Data/QA to record") and docs/sprints/sprint-{3,4,5,6,8}-report.md. Every
reconstructed entry says so (`reconstructed`), and its `evidence` points at the lost files it used to cite.

All reconstructed disputes carry `lines: []` (as they did before the loss: GT-D-005 excluded a LINK group, not a BOQ line;
GT-D-006/007/008 were informational). So the gated set stays GT-D-001..004 = 11 lines, as in every pre-loss run.
GT-D-009 (4.05, proposed by Worker-Accuracy in Sprint 8, never recorded) is added with `lines: []` too, to keep the
baseline comparable; move "4.05" into its `lines` once the owner sees it.

    uv run python -I tools/projects/noah_disputes_recover.py        # idempotent; existing ids are updated in place
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from catalogue import GT

RECON = "reconstructed 09.11 (Sprint 10 Data/QA) from benchmark/NOTES.md, workers/drawing/NOTES.md and docs/sprints; the original entry was lost with gt/noah on 09.11"

# hypotheses appended to the summaries of the rebuilt GT-D-001..004 (text as quoted in the repo docs)
HYPOTHESES: dict[str, list[str]] = {
    "GT-D-001": [
        (
            "Sprint-2 hypothesis: per-type drawing counts match the BOQ on 4.00 (23), 4.02, 4.04, 4.21 and 4.03 (7 power glyphs + "
            "the water-heater feed drawn with the power glyph = 8). Only 4.01 differs (16 drawn doubles vs 15). The AutoCAD 42 looks "
            "like a count of the generic socket block from another revision."
        ),
        (
            "Sprint-8 (Worker-Accuracy): 4.01 drawing 16 doubles (ground 5: dining bay, living H=20, patio H=110, island ×2), BOQ 15; "
            "4.03 = 8 only if the water-heater feed's socket glyph is priced as a power socket as well (4.23 already prices it)."
        ),
    ],
    "GT-D-002": [
        (
            "Sprint-3 hypothesis (link GT gt-v0.3-draft): 9.01 = 49 luminaire tags − 5 type-17 ceiling fans − 1 cross-sheet duplicate "
            "(exterior stair type 9 drawn on both lighting sheets) = 43 = BOQ. Sprint 8 confirmed (43)."
        ),
    ],
    "GT-D-003": ["Sprint-4 hypothesis (plumbing fixture GT gt-v0.4-draft): drawings = BOQ."],
    "GT-D-004": ["Sprint-4 hypothesis (plumbing fixture GT gt-v0.4-draft): drawings = BOQ."],
}


def _d(id_: str, title: str, summary: str, **kw: Any) -> dict[str, Any]:
    return {
        "id": id_,
        "title": title,
        "summary": summary,
        "lines": [],
        "link_groups": kw.get("link_groups", []),
        "values": kw.get("values", {}),
        "questions": kw.get("questions", []),
        "interim_rule": kw.get("interim_rule", "Informational: no BOQ line excluded."),
        "status": "open — awaiting owner",
        "resolution": None,
        "evidence": kw.get("evidence", []),
        "reconstructed": RECON,
    }


RECOVERED = [
    _d(
        "GT-D-005",
        "Master-suite fan-switch arc ends at the type-23 spot (link pairing ambiguous)",
        "Sprint 3, sheet 1bbe4113 (parents' suite): at the dashed-arc junction below the fan switch the arc of the master "
        "fan switch ends at the type-23 spot, so it can be read as fan switch → fan + new 2-way → type-23 spot, or the "
        "opposite pairing (the link GT read the opposite pairing to the worker). The link group was excluded from link "
        "gating; no BOQ line excluded. Related: 4.10 (existing 2-way at the bed head + new 2-way → existing fan point, "
        "GT group 1bbe4113-G13 per workers/drawing NOTES Stage 10) and 4.14.",
        link_groups=[],
        values={
            "sheet": "1bbe4113",
            "lost_link_group_ids": "unknown (gt/noah/links/1bbe4113.json lost); GT-D-005 area = parents' suite",
        },
        questions=["Which switch controls the type-23 spot in the parents' suite, and which the fan?"],
        interim_rule="Link group excluded from link gating (ids lost with links/*.json — link GT must be rebuilt before link evals). No BOQ line excluded.",
        evidence=["links/1bbe4113.json (lost)", "reconcile_log.md#sprint-3 (lost)"],
    ),
    _d(
        "GT-D-006",
        "4.09 single-switch lighting points: drawing implies 17, BOQ 16",
        "Sprint 3: the link GT implies 17 single-switch groups (default mapping single → 4.09); the BOQ says 16. The worker's "
        "implied count is 17 too. Informational; 4.09 stays gated at the BOQ's 16.",
        values={"boq": 16, "link_gt_implied": 17, "worker_implied_sprint3": 17},
        questions=["Is 4.09 16 or 17 (which single-switch point is not priced as 4.09)?"],
        evidence=["links/b2046277.json, links/1bbe4113.json (lost)", "docs/sprints/sprint-3-report.md"],
    ),
    _d(
        "GT-D-007",
        "5.02 floor tiling: is the English courtyard included?",
        "Sprint 4: the 5.02 text names the courtyard, but its quantity matches the bathrooms + guest WC incl. laundry niches "
        "WITHOUT the courtyard (Data F1 18.109 vs BOQ 18.1). Default: courtyard OUT (contracts library.ts, packages/contracts "
        "NOTES). Informational.",
        values={"boq": 18.1, "without_courtyard": 18.109},
        questions=["Is the English courtyard floor part of 5.02?"],
        evidence=["tiling/wet_rooms.json, tiling/expected_tiling.json (lost)", "docs/sprints/sprint-4-report.md"],
    ),
    _d(
        "GT-D-008",
        "5.01 / 5.03 cladding height, niches and external-corner rule",
        "Sprint 4: 5.01 (cladding) and 5.03 (grunge corner cuts, length) depend on the cladding height, whether laundry niches "
        "are clad, and which external corners count; the master bath's diagonal-wall corner is 15 cm from the door jamb — "
        "the worker excludes corners within 30 cm of a door, the GT counted it (6 vs 7 corners). Informational.",
        values={"5.03_boq": 15.6, "corners": {"worker_rule_30cm": 6, "gt": 7}},
        questions=["Does a corner next to a door jamb count in 5.03?", "Cladding height and niches for 5.01?"],
        evidence=["tiling/expected_tiling.json (lost)", "docs/sprints/sprint-4-report.md", "docs/sprints/sprint-5-report.md"],
    ),
    _d(
        "GT-D-009",
        "4.05 communication points: drawing 10, BOQ 11 (proposed in Sprint 8, recorded now)",
        "Worker-Accuracy Sprint 8: 10 comms points drawn (basement 2 data / 2 TV / 1 TEL, first floor the same), BOQ 11. No "
        "unmatched comms glyph or label on any of the 15 sheets. Candidates for the 11th: a point in the comms panel, or one "
        "of the 6-socket boxes' data/TV/phone points (4.06) counted again.",
        values={"boq": 11, "drawing": 10},
        questions=["Where is the 11th communication point of 4.05?"],
        interim_rule="Recorded with lines [] so the gated set stays comparable with the pre-loss runs; put '4.05' in lines when the owner confirms the question is open.",
        evidence=["workers/drawing/NOTES.md Sprint 8 'Disputes (documented, not fitted)'"],
    ),
]


def main() -> int:
    f = GT / "noah" / "disputes.json"
    doc = json.loads(f.read_text(encoding="utf-8"))
    by_id = {d["id"]: d for d in doc["disputes"]}
    for did, hyps in HYPOTHESES.items():
        d = by_id.get(did)
        if d is None:
            continue
        for h in hyps:
            if h not in d.get("summary", ""):
                d["summary"] = (d.get("summary", "") + " | " + h).strip(" |")
    for rec in RECOVERED:
        if rec["id"] in by_id:
            by_id[rec["id"]].update(rec)
        else:
            doc["disputes"].append(rec)
    doc["disputes"].sort(key=lambda d: d["id"])
    f.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{f}: {[(d['id'], len(d['lines'])) for d in doc['disputes']]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
