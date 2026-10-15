# Sprint 4 — Plumbing, tiling, review queue & on-drawing corrections: brief for all agents

Read first: AGENTS.md, docs/agents/SPRINT0_BRIEF.md (rules: own dirs only, flock for installs, NO git commits,
NOTES.md, tests green, run mypy as CI does), SPRINT1/2/3 briefs (interfaces still valid), docs/sprints/sprint-3-report.md,
docs/spec/01_PRD.md (FR-14, FR-15, FR-19..FR-27), docs/spec/05_ux.md (review queue, correction tools, keyboard
table, cluster cards, "learn from correction", cladding dialog, confidence language), docs/spec/07_test_plan.md.
Branch `sprint-4/review` (orchestrator commits).

**Sprint goal (demo):** all 4 MVP disciplines in the BOQ (electrical, lighting, plumbing points, floor/wall tiling)
for בית משפחת נח, plus a review queue and correction tools so a reviewer can bring the BOQ to "verified" quickly:
100 queue items in < 5 minutes; corrections survive rebuilds and reprocessing; correcting one symbol offers to fix
all similar ones.

Targets from the client BOQ (/home/claude/kamutan-data/gt/noah/boq_truth.json):
- Plumbing chapter (sample codes 3.01–3.15): points per fixture — 3.02 basin + wall faucet (3), 3.03 basin + flower
  faucet (4), 3.04 concealed cistern WC (3), 3.05 washing machine (2), 3.06 garden tap (2), 3.07 monoblock WC (1),
  3.11/3.12/3.13 shower/bath per bathroom (1 each), AC drains 3.01 (9 — from AC positions on electrical sheets),
  plus one-off feeds/pumps (3.08–3.10, 3.14–3.15) suggested from templates/notes (yellow, never green).
- Tiling chapter (sample 5.xx): 5.02 floor tiling of wet rooms + English courtyard (m²), 5.01 wall cladding of
  bathrooms (m²) = perimeter × user-entered height − openings, 5.03 external corner trim (m'), 5.06/5.07 partial wall
  cladding (user-drawn or height×length), 5.05 waterproofing per wet room (קומפלט), waste factor per material
  (order qty column, default 7%).

## Shared interfaces

### Fixtures & openings (worker artifacts)
Detections gain plumbing classes (benchmark/schema/classes.json): fixture_wc_concealed, fixture_wc_monoblock,
fixture_basin, fixture_shower, fixture_bath, fixture_kitchen_sink, fixture_washing_machine, faucet_wall, faucet_basin,
garden_tap, ac_unit (AC position, from electrical "מזגן"/AC sockets) — add to classes.json if missing (Data agent owns
the file; coordinate via adding in your own PR area is NOT allowed — ask main).
`rooms.json.gz` rooms gain: `type` ('bathroom'|'wc'|'kitchen'|'bedroom'|'living'|'corridor'|'balcony'|'courtyard'|
'storage'|'stairs'|'other'), `wet: bool`, `perimeterM`, `walls: [{id, aMm{x,y}, bMm{x,y}, lengthM, exterior: bool}]`,
`openings: [{id, kind: 'door'|'window'|'opening', wallId, widthM, heightM|null, centerMm}]`, `externalCorners: n`.

### Corrections (the source of truth for human edits)
Firestore `orgs/{o}/projects/{p}/corrections/{corrId}` (written ONLY via the API):
`{ kind: 'add'|'remove'|'reclassify'|'move'|'link'|'unlink'|'measure'|'count'|'accept'|'reject',
   sheetId, versionId (at time of edit), anchorMm {x,y} (stable re-match key), radiusMm,
   detectionId|null, signature|null, class|null, itemCode|null, linkGroupId|null, switchIds?, pointIds?,
   geometry: {type:'point'|'polygon'|'polyline', mm: [{x,y}]}|null, quantity|null, unit|null,
   roomId|null, floor|null, reason|null, batchId|null, by, at, revertedAt|null }`
Semantics: corrections are applied AFTER automatic detection in `boq.build` and re-matched to new versions by
`anchorMm` within `radiusMm` (default 3 mm paper) + class family; a correction never applied to a newer version is
reported as "תיקון לא הותאם" (red) in the queue. accept/reject mark a detection human-verified (level → green with
reason "אושר ידנית" / removed). `measure` creates manual area/length items (unit m²/m'), `count` a manual count.
Undo = `revertedAt`.

### Room settings (tiling inputs)
`orgs/{o}/projects/{p}/roomSettings/{sheetId}__{roomId}` (API only): `{ claddingHeightM, floorTiled: bool,
 floorMaterialItemCode|null, wallMaterialItemCode|null, partialCladding: [{wallId, fromM, toM, heightM}],
 wasteFactor, includeInWaterproofing: bool, by, at }`. Defaults by room type (bathroom/wc: cladding 2.6 m, floor tiled,
 waterproofed; kitchen: backsplash 0.6 m over counter walls only if user marks them).

### Review queue
API `GET /v1/projects/:pid/review-queue?filter=` returns items ranked by risk = |qty impact on BOQ line| × (1 − score)
× level weight; item kinds: `detection` (yellow/red), `cluster` (similar detections grouped by signature+class+level,
batch accept/reject), `unknown_cluster`, `link_group`, `room` (unclosed/unnamed/settings missing),
`unmatched_correction`, `line` (BOQ line red without per-item cause, e.g. rule default). Each item carries
sheetId/versionId, bbox, thumbUrl when available, reasons, suggested action.

### Learn from correction
Job `symbols.find_similar` `{orgId, projectId, jobId, exemplar: {sheetId, versionId, bboxMm, class}, scope:
'sheet'|'project'}` → result doc `similarSearches/{id}` `{status, candidates: [{sheetId, versionId, centerMm, bboxMm,
score, alreadyDetected: detectionId|null, currentClass|null}], thumbs}`; the web shows a preview with a similarity
slider; "apply" posts a batch of corrections with one `batchId`.

## Ownership
| agent | owns | delivers |
| --- | --- | --- |
| Worker-B (rooms & fixtures) | workers/drawing: `rooms/`, `lifecycle/`, new `fixtures/` | plumbing fixture detection on architecture + plumbing sheets (blocks drawn as WC/basin/shower/bath/kitchen-sink/washing-machine shapes + plumbing text labels + faucet symbols), AC positions, room types/wet flags, walls, openings (door swings/window marks), perimeters, external corners; Worker-A integrates calls in pipeline/understand.py — coordinate signatures by message |
| Worker-A (symbols & similarity) | workers/drawing: `symbols/`, `links/`, `pipeline/understand.py`, `service/` job routing for `symbols.find_similar` | find_similar job (template from exemplar strokes → search sheet/project, candidates with alreadyDetected), integrate Worker-B's fixtures/rooms upgrades into understand |
| Worker-BOQ | workers/drawing: `boq/` | plumbing rules (fixture→points per room incl. wall vs flower faucet by nearby faucet class, bathroom shower/bath lines, AC drains from ac_unit, one-off suggestions), tiling rules (floor area wet rooms + courtyard, cladding perimeter×height−openings, partial cladding, corner trim, waterproofing per wet room, waste/order qty), corrections application + re-matching + unmatched reporting, roomSettings consumption |
| API | apps/api, packages/contracts, firebase/ | contracts for all shapes above, endpoints: corrections CRUD (+ batch, undo), review-queue (ranked), roomSettings GET/PUT, find-similar trigger + result, rebuild-on-demand, audit, rules |
| Web | apps/web, packages/viewer | review queue panel (risk-ordered, cluster cards with thumbs, keyboard A/R/E/N/G/… per spec), correction tools on the drawing (click add/remove, lasso select, reclassify, move, link/unlink switch↔point, manual count, area/length measure with snapping, 2-click scale calibration), learn-from-correction preview with slider, room panel (type, cladding height, floor tiled, partial cladding, waterproofing), plumbing + tiling chapters in the BOQ panel, undo/redo |
| Data/QA | benchmark/, gt (outside git), benchmark/schema/classes.json | plumbing fixture GT (all floors, from architecture + plumbing sheets), room types/wet flags + perimeters/openings for wet rooms, expected tiling quantities given heights, BOQ eval for chapters 03 + 05, queue-speed protocol (simulate 100 actions via Playwright on mock to measure UI latency) |
