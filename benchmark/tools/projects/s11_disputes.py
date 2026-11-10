"""Sprint 11 Data/QA: add the drawing-vs-BOQ disputes of the Sprint 10 reports (workers/drawing/NOTES.md) and of the
Sprint 11 by-eye sheet GT to `gt/<p>/disputes.json` (GT-D-11x / GT-D-12x). Idempotent.

All entries carry `lines: []` and name the lines in `candidate_lines`: the gated set of a running sprint must not move
under the other agents; the owner's answer decides whether a line becomes disputed (then move the code to `lines`).

    uv run python -I tools/projects/s11_disputes.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

GT = Path(os.environ.get("KAMUTAN_DATA_DIR", "/home/claude/kamutan-data")) / "gt"
OPEN = "open — awaiting owner"
INTERIM = "Scored as written (lines stay gated) until the owner answers."


def entry(
    did: str, title: str, summary: str, lines: list[str], values: dict[str, Any], question: str, source: str
) -> dict[str, Any]:
    return {
        "id": did,
        "title": title,
        "summary": summary,
        "lines": [],
        "candidate_lines": lines,
        "values": values,
        "questions": [question],
        "interim_rule": INTERIM,
        "status": OPEN,
        "resolution": None,
        "source": source,
    }


S10_ACC = "Sprint 10 Worker-Accuracy report (workers/drawing/NOTES.md)"
S10_LIGHT = "Sprint 10 Worker-Lighting report (workers/drawing/NOTES.md)"
S11_GT = "Sprint 11 by-eye sheet GT eye-s11-v1 (gt/<p>/sheets, expected_counts.json drawn_total)"

DISPUTES: dict[str, list[dict[str, Any]]] = {
    "achituv": [
        entry(
            "GT-D-111",
            "4.17 USB / Type-C add-on: 5 drawn vs BOQ 4",
            "'+TYPE C' is written beside 5 sockets: ground 2, first 2, basement 1 (written '+type c' beside the H=90 socket).",
            ["4.17"],
            {"boq": 4, "drawn": 5, "per_floor": {"ground": 2, "first": 2, "basement": 1}},
            "Is the basement '+type c' socket part of 4.17 (5), or is 4 intended?",
            f"{S10_ACC}; confirmed by {S11_GT}",
        ),
        entry(
            "GT-D-112",
            "4.07 comms points: 37 or 38 drawn vs BOQ 38",
            "Sprint 10 counted 37 (data 13, camera 7, alarm detector 15, siren 1, keypad 1). The by-eye GT finds the same 37 "
            "plus one NEW intercom (circle-א, ground entrance) = 38 = the BOQ; a second intercom at the gate is an existing line.",
            ["4.07"],
            {"boq": 38, "drawn_s10": 37, "drawn_s11_gt": 38, "difference": "new intercom at the entrance"},
            "Does the designer count the entrance intercom as a comms point (then drawing = BOQ and this closes)?",
            f"{S10_ACC}; {S11_GT}",
        ),
        entry(
            "GT-D-113",
            "4.02 double socket: 21 drawn vs BOQ 19 (and 4.01 single: 32 drawn vs 34)",
            "By eye: 21 double sockets (ground 11, first 8, basement 2) and 32 new single sockets (ground 12, first 11, "
            "basement 9). Doubles + singles = 53 in both the drawing and the BOQ, so two glyphs are probably read the other way "
            "by the designer (a single glyph with an 'X2' note counts as double here).",
            ["4.01", "4.02"],
            {"boq": {"4.01": 34, "4.02": 19}, "drawn": {"4.01": 32, "4.02": 21}},
            "Is a single-socket glyph annotated 'X2' one double socket (drawing) or two singles / one single (BOQ)?",
            f"{S10_ACC}; {S11_GT}",
        ),
        entry(
            "GT-D-114",
            "4.33 / 4.36 lighting circuits: 6 two-fixture and 2 three-fixture drawn vs BOQ 9 / 1",
            "Drawn one-switch circuits: 6 with two fixtures, 2 with three (A2 = 3 island pendants, N3).",
            ["4.33", "4.36"],
            {"boq": {"4.33": 9, "4.36": 1}, "drawn": {"4.33": 6, "4.36": 2}},
            "Which circuits does the designer count as two-fixture / three-fixture?",
            S10_LIGHT,
        ),
        entry(
            "GT-D-115",
            "Title block says 'קומת קרקע' on the first-floor sheets",
            "חשמל / תאורה / בניה - קומה א carry 'קומת קרקע' in the sheet-name box (copy-paste); plan content and file names are "
            "the first floor. GT and manifests use the file name.",
            [],
            {"sheets": ["634431e4", "a4635b44"], "title_block": "קומת קרקע", "truth": "first"},
            "Confirm the first-floor sheets are mislabelled in the title block.",
            f"{S10_ACC}; seen again in {S11_GT}",
        ),
    ],
    "yahav": [
        entry(
            "GT-D-111",
            "4.37 lighting circuits: 6 drawn vs BOQ 5; circuit A6 has no line",
            "Drawn: A7, A10, C4, D1, D3, D5 = 6. A6 (pergola, one switch) has no BOQ line; on the drawing A6 is two "
            "'ceiling light + fan' glyphs.",
            ["4.37"],
            {"boq": 5, "drawn": 6, "circuits": ["A7", "A10", "C4", "D1", "D3", "D5"]},
            "Which of the six circuits is not in 4.37, and where is A6 priced?",
            S10_LIGHT,
        ),
        entry(
            "GT-D-112",
            "4.01 single socket: 49 drawn vs BOQ 46; 4.07 comms: 26 drawn vs 25; 4.02 double: 22 vs 21",
            "By-eye count of NEW symbols on the three electrical sheets (existing meter excluded). Singles include 8 AC "
            "sockets, the socket inside the comms panel and the garden / gate / pump feeds.",
            ["4.01", "4.02", "4.07"],
            {"boq": {"4.01": 46, "4.02": 21, "4.07": 25}, "drawn": {"4.01": 49, "4.02": 22, "4.07": 26}},
            "Which drawn sockets are outside 4.01 (panel socket, gate feed, pump)? Are all 10 cameras + 4 speakers in 4.07?",
            S11_GT,
        ),
    ],
    "rubel": [
        entry(
            "GT-D-111",
            "4.41 / 4.43 garden lighting chains: 11 and 15(+4) drawn vs BOQ 12 / 17",
            "Chain D1 = 11 points and D3 = 15 (+4 on the first floor) on the drawing; BOQ says 12 / 17 (unit question: GT-D-101).",
            ["4.41", "4.43"],
            {"boq": {"4.41": 12, "4.43": 17}, "drawn": {"4.41": 11, "4.43": "15 (+4 first floor)"}},
            "Are the chain sizes in the BOQ text counted from an older drawing revision?",
            S10_LIGHT,
        ),
        entry(
            "GT-D-112",
            "4.01 single socket: 48 drawn vs BOQ 42; 4.07 comms: 64 drawn vs 58",
            "By-eye count of NEW symbols on the three electrical sheets. Singles: first 17, ground 26, basement 5 (13 of them "
            "purple AC sockets, 6 outdoor). Comms: data 10, speaker 18, camera 14, alarm detector 22 (incl. two-detector "
            "positions), no TV glyphs drawn.",
            ["4.01", "4.07"],
            {"boq": {"4.01": 42, "4.07": 58}, "drawn": {"4.01": 48, "4.07": 64}},
            "Are AC sockets ('מיקום מדויק שקע מזגן יסומן בשטח') inside 4.01? Are paired alarm detectors one point?",
            S11_GT,
        ),
        entry(
            "GT-D-113",
            "4.03 power 7 drawn vs 8, 4.02 double 26 vs 27, 4.05 triple 5 + D18 vs 7",
            "One short on each line against the by-eye GT; the three filled half-circles for pool room / sauna / pool shed "
            "are read as 3-phase feeds (4.13 / 4.15), which may be the missing power sockets.",
            ["4.02", "4.03", "4.05"],
            {"boq": {"4.02": 27, "4.03": 8, "4.05": 7}, "drawn": {"4.02": 26, "4.03": 7, "4.05": "5 triple + 1 D18"}},
            "Is the pool-shed feed a single power socket (4.03) rather than 3-phase?",
            S11_GT,
        ),
    ],
}


def main() -> None:
    for project, new in DISPUTES.items():
        path = GT / project / "disputes.json"
        doc = json.loads(path.read_text(encoding="utf-8"))
        ids = {d["id"] for d in new}
        doc["disputes"] = [d for d in doc["disputes"] if d["id"] not in ids] + new
        path.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
        print(project, [d["id"] for d in doc["disputes"]])


if __name__ == "__main__":
    main()
