# Sprint 11 — Accuracy only

Read first: AGENTS.md, docs/agents/SPRINT0_BRIEF.md (own dirs, `flock` for installs, NO git commits, NOTES.md, tests
green, mypy the CI way), SPRINT10_BRIEF.md, and the "Sprint 10 …" sections of workers/drawing/NOTES.md (final reports
of Worker-Classify / Worker-Accuracy / Worker-Lighting / Worker-BOQ / Perf). **Git: ONE branch, `main`.** Never run
state-changing git commands. Customer files never enter git.

**Owner (10.11): "the most important thing to me is accuracy."** No new features this sprint. The only goal is more
BOQ lines exact against the designer's BOQ on the four real projects, with Noah never regressing (cold AND warm).

Baseline on the committed tree (exact / lines): Noah 61 / 77 (within 63), Rubel 30 / 115, Achituv 33 / 85,
Yahav 35 / 110. Data: `/home/claude/kamutan-data/{projects,gt,sample-*}`.

## Rules for every agent
- **Evals:** `benchmark/tools/projects/run_eval.sh <project> <label>` with `KAMUTAN_AV_SCAN=off`, ALWAYS wrapped in
  `flock /tmp/kamutan-eval.lock` (one eval on the box at a time — memory). Use your own label prefix.
- **Measure before you fix:** for each line you target, state truth / before, find the cause on the drawing (render and
  look), fix the cause — never tune to the number. A line where the drawing disagrees with the BOQ is a dispute for
  the owner (add to `gt/<p>/disputes.json` notes in your report), not something to fit.
- **No regression:** Noah cold and warm identical to baseline on every line; no line on the other three gets worse
  without an explanation on the drawing. Report per project before → after per line you touched, and the exact total.
- Every fix has a unit test. Gates: ruff, format, mypy (CI way), bandit -ll, pytest.

## Work items
1. **Rooms on the new projects (Worker-Rooms: `rooms/`, `geometry/`, room-type propagation):** Achituv ground has no
   rooms at all; merges (37.9 m²); electrical-sheet rooms typed `other` because cross-sheet matching needs the same
   floor and registration (sheets of one floor sit 40–90 mm apart on paper → add a registration step); outdoor areas
   (garden / pergola / balcony) have no polygon. Targets: "תוספת עבור אביזר מוגן מים" (truth 25 / 16 / 28, now
   10 / 0 / 0), waterproofing per חדר, tiling areas by location (bathroom floors/walls, outdoor), room counts.
2. **Symbols (Worker-Accuracy: `symbols/`, `ocr/`, `fixtures/`)** — after the warm-determinism fix: Rubel ceiling fans
   41 vs 6; leader notes that re-class a socket (Yahav 4.03 and 3-phase 0 / 6); undetected garden pins / outdoor wall
   lights / Rubel first-floor fixtures (they cap the lighting circuits: Yahav 4.44, Rubel sets 11/19 vs 12/17 — check
   which side is right); "X2" at 3.5 mm vs the 3.0 mm gate; cobra arcs; panels (0 of 4 / 5 / 4); shutter-switch
   template; "פרט A" six-socket boxes; power vs 3-phase swapped pair; Rubel's lost tv_point ×13 and the 4.08 drop;
   luminaire over-count (Achituv 81 vs 62, Yahav 69 vs 58, Rubel 103 vs 96).
3. **Plumbing + areas (Worker-Areas: `boq/plumbing.py` inputs, `fixtures/` plumbing, areas from תקרה / בניה sheets,
   lighting profile lengths):** AC drains (Rubel 22 vs 10), showers (11 vs 4), basin points; interpuz 3/4-way, rain
   head, hand shower, drain type as annotations feeding the plumbing-point lines; ceilings m², gypsum partitions by
   colour / thickness, סינר, STR, נישה, block walls m²; lighting profiles מ"א. Coordinate with Worker-Rooms on room
   polygons (publish what you need in NOTES).
4. **Ground truth for greens (Data/QA: gt outside git, `benchmark/`):** independent symbol-level GT by eye (render
   crops and look — NOT seeded from the detector) for the electrical + lighting sheets of Achituv, Yahav, Rubel and
   the rest of Noah, in the kbench sheet-GT format, so per-class precision can be measured on ≥ 200 checked items for
   the big classes (single / double sockets, luminaires, switches, comms). Also: remap `expected_counts.json` to the
   new classes; take floors for the three no-floor manifest entries from the title blocks; record the disputes listed
   in the Sprint 10 reports; `kbench` per-class P/R report across the four projects; BOQ double counts found by others
   (Achituv bell 4.15: text item must yield to the class — hand to Worker-BOQ's files with a marked change).

## Ownership
| agent | owns |
| --- | --- |
| Worker-Rooms | workers/drawing `rooms/`, `geometry/`, `tiling/` |
| Worker-Accuracy | workers/drawing `symbols/`, `ocr/`, `fixtures/` (electrical) |
| Worker-Areas | workers/drawing plumbing fixtures + plumbing/area/length BOQ inputs, `walls/`, ceilings |
| Data/QA | `/home/claude/kamutan-data/gt`, `benchmark/` |

Touching another owner's file is allowed for a needed fix when marked "Sprint 11 (<agent>) — keep" and noted in NOTES.

Final report per agent: causes found, fixes, per-project before → after per line, exact totals, tests, disputes for
the owner, open issues.
