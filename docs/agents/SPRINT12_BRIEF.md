# Sprint 12 — Accuracy, round 2 (owner: "you have four projects, each with many drawings and the designer's BOQ — that is enough")

Read first: AGENTS.md, SPRINT0_BRIEF.md, SPRINT11_BRIEF.md (rules still apply: flock evals, NO commits, NOTES.md, gates, Noah cold+warm identical on all 77 lines).

**The designer's BOQ IS the ground truth.** Where a rule is unclear (what a line includes), read the BOQ line text, the notes on the sheet and the other projects' BOQs, and implement the rule the designer evidently uses. The owner does not need to be asked again for these.

**Anti-overfit protocol (mandatory):** a rule is developed on at most two projects and VALIDATED on the others (leave-one-project-out). Report the held-out result per rule. A rule that only fits the project it was written on is rejected. Never tune a threshold to a number; find the drawn cause (render and look).

## Work items (by owner)
- **Worker-Accuracy (symbols/, lighting/ marked "Sprint 12 — keep"):** (a) per-fixture attributes derived from the drawing — outdoor/garden (timer-circuit notes, landscape-architect banners, room containment, wall-light/spike symbol families), existing ("קיים" leaders, dashed/grey lifecycle), profile-feed (leader notes "הזנה לשנאי / פרופיל") — so that "התקנת גוף תאורה" lines (Achituv 4.40, Yahav 4.46, Rubel 4.44) price plain indoor fixtures only; generalise `lighting/circuits.py` note reader beyond "D6 D3" style; (b) Rubel 4.36/4.37 switches from circuit tags; (c) shutter switch via per-template legend-vs-plan scale (not a wider tolerance); (d) panels: ask Data/QA what the H=220 hatched rectangle is by reading the BOQ + drawing.
- **Data/QA (gt/, benchmark/):** by-eye marks, from the drawings and the BOQ text, of: water-protected accessories (Achituv 16, Rubel 25, Yahav 28 — which devices), outdoor/existing/profile-feed on Rubel f1b6df02 and the other lighting sheets, the H=220 rectangle, panels per project; write them to gt/<p>/ in the sheet-GT format. Publish what you found in NOTES so Accuracy can validate.
- **Worker-Rooms (rooms/, geometry/):** Rubel ground floor trusted-floor registration + basement; Achituv guest WC and stair hall as rooms; outdoor polygons (garden / terrace / paving) so 5.01 outdoor paving and the water-protected rule have areas.
- **Worker-Areas (plumbing/area/length inputs):** chapter 07 (gypsum ceilings m², partitions, סינר מ"א), block walls, profile lengths; remaining plumbing lines; leftover chapter-05 lines (Rubel 5.08–5.13, Yahav 5.07/5.14 to exact).

Baseline (exact/lines): Noah 61/77, Achituv 40/85, Yahav 43/110, Rubel 37/115. Final report per agent as in Sprint 11: cause on the drawing, fix, per-project before→after per line, held-out validation, tests, open questions.
