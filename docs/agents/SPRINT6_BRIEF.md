# Sprint 6 — Complete the BOQ: text & equipment items, remaining tiling, construction / gypsum / plaster

Read first: AGENTS.md, docs/agents/SPRINT0_BRIEF.md (own dirs, `flock` for installs, NO git commits, NOTES.md, tests
green, mypy the CI way), SPRINT3–5 briefs + docs/agents/STAGE10_FIX_BRIEF.md (interfaces still valid),
docs/sprints/stage-10-acceptance-report.md, docs/spec/01_PRD.md, docs/spec/05_ux.md.
**Git: ONE branch, `main`, in /home/claude/kamutan.** Never run state-changing git commands; the orchestrator commits.

**Goal (owner request, 01.11):** "can the system export this BOQ?" — today ~30/77 lines of the client's BOQ for בית
משפחת נח come out exact without touch, and 15 lines are never produced. Sprint goal: **every line of the client's BOQ is
present in the system's BOQ** — computed from the drawings when the drawings carry the information, otherwise offered as
a *suggested* line (yellow/red, "להשלמה ידנית", with the right unit, a one-click measure/count action and the evidence
that triggered it). Never a silent omission. Target: ≥ 45/77 exact or within tolerance without touch, 77/77 present.

Reference: client BOQ /home/claude/kamutan-data/sample-noah/boq_sample.xls (sheet "כמויות"; also sheet "חשמל" = the
designer's AutoCAD block-count report per floor, sheet "אינסטלציה" = fixtures per bathroom — both usable as extra GT
evidence), parsed truth /home/claude/kamutan-data/gt/noah/boq_truth.json, disputes.json (GT-D-*), the 15 Noah sheets in
/home/claude/kamutan-data/sample-noah/, artifacts in /home/claude/kamutan-data/artifacts/. Customer data never in git.

## Missing / weak lines (expected qty from the client BOQ)
- **04 electrical, text / equipment:** 4.06 עדה פלאסט 6-socket box (4), 4.08 free conduit from floor for the island (1),
  4.12 add two-way switch to an existing point (3), 4.17 heater feed + switch (3), 4.18 intercom (1), 4.19 ventilator feed
  + switch (1), 4.20 cobra 50 mm 1.5 m (5), 4.21 3-phase socket (3), 4.22 bell + switch feed (1), 4.23 boiler feed with
  timer switch (1), 4.24 14-module panel + sub-meter (1), 4.25 comms panel (1), 4.26 replace boiler switch with timer (1),
  4.27 cobra 3.5 m to ceiling projector (1), 4.28 36-module panel (1). Sources on drawings: symbols, legend rows, notes /
  callouts / leaders, panel schedules, "קיים/חדש" qualifiers. Some already exist — measure first.
- **05 tiling:** 5.04 stair treads to the basement (11 יח'), 5.06 kitchen backsplash in the unit (2 m²), 5.07 guest WC
  partial brick-look cladding (1.2 m²), 5.08 courtyard wall waterproofing (קומפלט 1); 5.02 / 5.03 stay owner-pending
  (GT-D-007/008) — do not change their conventions.
- **02 construction:** 2.01 retaining walls of the new English courtyard (11 m²), 2.02 basement floor + stairs (קומפלט),
  2.03 closing the kitchen door opening in block (2 m²).
- **06 gypsum (codes 7.xx):** 7.01 gypsum ceiling per ceiling plan (4 m²), 7.02 valance as ventilator screen (4.3 m'),
  7.03 inner gypsum closing of an existing window (1.5 m²), 7.04 access panels (3), 7.05 curtain valance (7 m'), 7.06
  partitions with rock wool (35.2 m²), 7.07 double partition unit ↔ stairs (7.5 m²).
- **07 plaster & paint (8.xx):** 8.01 repairs after demolition (קומפלט), 8.02 two plaster coats on courtyard walls +
  the new block wall (22 m²), 8.03 paint whole interior (קומפלט), 8.04 American putty ground floor (קומפלט).
- **08 misc:** 9.03 4" ventilation pipe for the ventilator (1).
- **01 demolition:** offered as קומפלט 1.0 already; wording comes from the library (import of the client BOQ).

## Shared interfaces (additive)
- New rule kinds in `boqRules` (contracts by API agent; worker implements):
  - `text_item` — `{patterns: [regex], scope: legend|note|callout|panel_schedule|any, disciplines[], itemCode, unit,
    qty: 'count'|'number_in_text'|'length_in_text_m'|'one', proximityMm?}` → one evidence per matched text (kind
    `text`, bbox). Hebrew-normalised matching (final letters, geresh/gershayim, quotes, spacing).
  - `area_item` / `length_item` — geometry-driven quantity from rooms/walls/hatches/polylines:
    `{source: 'hatch'|'room'|'wall_run'|'polyline'|'stair', match: {...}, itemCode, unit: 'מ"ר'|'מ"א'|'יח\''}`.
  - `suggested_item` — `{itemCode, unit, trigger: {kind: 'sheet_discipline'|'text'|'demolition'|'always', ...},
    reason}` → a yellow/red line with qty from a simple estimator or null ("להשלמה ידנית"), never green.
- BOQ line additive fields: `origin: 'detected'|'text'|'geometry'|'suggested'|'manual'`, `needsInput: bool`,
  `quickAction: {kind: 'measure_area'|'measure_length'|'count'|'confirm', sheetId|null}|null`.
- Evidence kinds additive: `text` (exists), `geometry` (polygon/polyline mm on a sheet), `stair` (treads).
- Default library (contracts) gains generic items for chapters 02, 06/07 (gypsum / plaster & paint) and the new 04/05
  codes, generic wording only. Import of the client BOQ still overrides wording.

## Ownership
| agent | owns | delivers |
| --- | --- | --- |
| Worker-Text | workers/drawing: new `textitems/`, `legend/`, `ocr/` (shared — coordinate), `pipeline/understand.py` hook for text items | the chapter-04 text/equipment lines + 9.03: find the evidence on the Noah sheets (notes, callouts with leaders, legend rows, panel schedules, "קיים"), produce `text_items.json.gz` per version (contracts by API), plus symbol additions where the item is a symbol (4.06, 4.18, 4.21, 4.22). Measure each line before/after |
| Worker-Geometry | workers/drawing: `rooms/`, `fixtures/`, new `geometry/` | stairs (tread count from the stair symbol / construction plan), hatched regions by legend (gypsum, block, new walls, demolished walls, waterproofing), wall runs by kind (new block / gypsum single / double), partial cladding regions (5.06/5.07 when drawn, else suggested), courtyard walls; artifact `geometry.json.gz` |
| Worker-BOQ | workers/drawing: `boq/`, `service/` | rule kinds `text_item`, `area_item`, `length_item`, `suggested_item`; default rules for every line above; `origin`/`needsInput`/`quickAction`; evidence; per-floor / per-room; chapter coverage report in build stats (`coverage: {libraryCodes, produced, suggested, missing[]}`) |
| API | apps/api, packages/contracts, firebase/ | contracts for everything above (rules, artifacts, line fields, evidence kinds), default library + rules additions (generic wording), endpoints unchanged except: `POST …/boq/lines/:id/quick-measure` (stores a `measure`/`count` correction bound to the line, recomputes), Excel unchanged format + origin note in the evidence sheet |
| Web | apps/web, packages/viewer | BOQ panel: suggested lines with "להשלמה ידנית" + quick action (opens the measure/count tool pre-bound to the line and sheet), origin badges, coverage summary per chapter ("x מתוך y סעיפים חושבו מהשרטוט"), text/geometry evidence highlight on the drawing; Playwright specs for the new flows |
| Data/QA | benchmark/, gt (outside git) | GT for the new lines (evidence locations on the Noah sheets, using the "חשמל"/"אינסטלציה" sheets of the client file as cross-checks), `kbench eval-boq` extended to all chapters with a coverage metric (present / exact / within tolerance / suggested), before/after report |

Contract changes: API owns packages/contracts; others publish requests in NOTES.md and mirror locally until merged.
Final report per agent: what was built, before → after per line, tests, open issues.
