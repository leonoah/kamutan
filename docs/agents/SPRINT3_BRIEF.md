# Sprint 3 — Electrical & lighting BOQ + Excel export: brief for all agents

Read first: AGENTS.md, docs/agents/SPRINT0_BRIEF.md (rules: own dirs only, flock for installs, NO git commits,
NOTES.md, tests must pass), docs/agents/SPRINT1_BRIEF.md + SPRINT2_BRIEF.md (interfaces still valid),
docs/sprints/sprint-2-report.md, docs/spec/01_PRD.md (FR-12, FR-16..FR-18, FR-25..FR-28), docs/spec/05_ux.md (review
workspace BOQ panel, export warning dialog copy), docs/spec/07_test_plan.md (BOQ-line metrics), docs/spec/08_workplan_v2.md.
Branch `sprint-3/boq` (orchestrator commits).

**Sprint goal (demo):** "a full electrical + lighting BOQ (chapter 04 + lighting install line) for בית משפחת נח,
every line traceable to the items on the drawing, exported to Excel in the client's format".

Reference format: the client's BOQ `/home/claude/kamutan-data/sample-noah/boq_sample.xls` (sheet "כמויות": title rows,
project name, columns סעיף | תאור העבודה | יחידה | כמות סה"כ | מחיר יח' | סה"כ ₪, chapter header rows "פרק 04 – עבודות
חשמל", numbered chapter notes, per-chapter "סה"כ" row, grand totals before/after VAT). Parsed reference:
/home/claude/kamutan-data/gt/noah/boq_truth.json (codes as TEXT, e.g. 4.10). Prices stay empty in the MVP.

## Domain rules (electrical/lighting, Israeli renovation practice — implement as configurable rules, not code constants)
- Socket lines count detections by class: socket_single→"שקע בודד", socket_double→"שקע כפול", socket_triple→
  "אביזר שלישיית שקעים", socket_power→"שקע כח", socket_power_double→"שקע כח כפול", socket_3phase→"שקע תלת פאזי",
  tv/data/phone/bezek points→"נק' תקשורת…", speaker→"נק' קצה לרמקול", socket_box_6→"אביזר עדה פלאסט…", intercom,
  doorbell, heater_feed→"הזנה לתנור חימום + מפסק", water_heater_feed, panel → panel lines.
- **Lighting composite lines come from the switch↔luminaire link graph** (dashed arcs on lighting sheets):
  each *switch group* = a set of switches that control the same set of luminaire points.
  - 1 switch → 1 point: "נק' מאור כוללת מפסק" (4.09)
  - 2 two-way switches → 1 point: "נק' מאור בעלת שני מפסקים מחליפים" (4.10)
  - 1 switch → 2 points: "שתי נק' מאור משותפות בעלות מפסק בודד" (4.11); → 3 points: 4.16
  - point without switch (sensor): 4.15; switch added to an existing point: 4.12 (2-way) / 4.14 (fan)
  - A "point" may be several luminaires wired together (same arc endpoint cluster) — the rule set must allow
    "luminaires within X mm connected by a solid/dashed wire = one point".
  - Lighting install line ("התקנת גופי התאורה", 9.01) = count of luminaire positions excluding ceiling fans and
    excluding client-supplied/existing per the org's rule (configurable flags).
- Floor: every line keeps a per-floor breakdown; export can be summed or split. Floors the user confirmed on the
  sheet-confirmation screen are authoritative and REMOVE the "קומה לא ודאית" reason from detections/lines.
- Cross-sheet de-duplication: an item drawn on both the electrical and lighting sheet of the same floor is counted
  once — authority per class family: sockets/comms/feeds from electrical sheets, switches/luminaires from lighting
  sheets (configurable). Duplicates matched by position after aligning sheets of the same floor.
- Line level = lowest level of its evidence; line reasons = union (deduplicated) of evidence reasons + rule reasons
  (e.g. "קישור מפסק לא ודאי", "שיוך לפריט לפי כלל ברירת מחדל").

## Shared interfaces
Firestore (under `orgs/{o}`):
- `itemLibrary/{itemId}`: `{ code (TEXT), chapter (e.g. "04"), chapterTitle, description, unit, tags[], source:
  'import'|'manual', sourceRef?, active, updatedAt }`. itemId = deterministic slug of code+description hash.
- `boqTemplates/{templateId}`: `{ name, chapters: [{code, title, notes[]}], columns: [...], titleRows, default: bool }`.
  A default template "תבנית ברירת מחדל (לפי כתב הכמויות לדוגמה)" is created from the sample on org bootstrap / import.
- `boqRules/{ruleId}`: `{ kind: 'class_to_item'|'composite_lighting'|'install_count'|'authority', match: {...},
  itemCode, priority, enabled, updatedAt }` — default rule set seeded from the domain rules above; editable later.
Project (under `orgs/{o}/projects/{p}`):
- `boqLines/{lineId}`: contracts `BoqLineSchema` (packages/contracts/src/boq.ts) + `byFloor: {floor: qty}`,
  `evidenceCount`, `ruleId`, `sourceVersions: [{sheetId, versionId}]`, `computedAt`. `evidenceRef` = storage path of
  the line's evidence file. `qtyOverride` and `status`/approval fields are NEVER overwritten by a rebuild.
- Storage: `orgs/{o}/projects/{p}/boq/{buildId}/evidence.json.gz` (`kamutan.boq-evidence/1`:
  `{lines: {lineId: [{sheetId, versionId, detectionId, linkGroupId|null, floor}]}}`) and `links` per version:
  `.../versions/{v}/links.json.gz` (`kamutan.links/1`: `{groups: [{id, switchIds[], pointIds[], luminaireIds[], kind:
  'single'|'two_way'|'shared'|'sensor'|'add_to_existing', confidence, level, reasons[]}]}`).
- `boqBuilds/{buildId}`: `{status queued|running|succeeded|failed, startedAt, finishedAt, stats, error}` and project doc
  `boq: {latestBuildId, builtAt, stale: bool}` (stale=true when any current sheet version / mapping / rule changed).
Jobs (Pub/Sub topic `ingest` reused, new `type` values; contracts `jobs.ts` discriminated union):
- `boq.build` `{orgId, projectId, buildId}` — worker aggregates all current, ready sheet versions.
- `library.import` `{orgId, projectId?, storagePath, sourceKind: 'xls'|'xlsx'}` — parse a past BOQ into itemLibrary
  (+ create a template from its structure if none). Upload path `orgs/{o}/imports/{uuid}.{ext}` (quarantine rules as uploads).
Excel export (API, exceljs): RTL sheet, template layout (title rows, chapter headers + notes, columns as the sample),
codes written as TEXT, prices empty, per-chapter and grand-total formulas, extra columns at the far left/end:
"רמת ביטחון" (מאומת/סביר/לבדיקה) and "סטטוס" (טיוטה/נבדק/אושר); a second sheet "פירוט לפי קומה" and a third
"ראיות" (line → sheet/floor/count). If any red line exists and org setting `blockExportOnRed` → 409; otherwise export
with a warning row at the top. Excel cells from OCR/user text are sanitized against formula injection (SEC).

## Ownership
| agent | owns | delivers |
| --- | --- | --- |
| Worker-A (links) | workers/drawing: `links/`, tweaks in `symbols/`/`pipeline/understand.py`; NOT `service/`, NOT `boq/` | switch↔luminaire link graph from dashed arcs → links.json.gz + version artifact/stats; floor-confirmation effect on reasons |
| Worker-BOQ | workers/drawing: `boq/`, `library_import/`, `service/` job routing for `boq.build` + `library.import` | aggregation, de-dup, rules engine, composite lighting lines, per-floor, evidence file, Firestore boqLines (preserving overrides/approvals), stale flag handling; xls/xlsx import |
| API | apps/api, packages/contracts, firebase/ | contracts (jobs union, library, templates, rules, lines+byFloor, builds, links, evidence), endpoints: library CRUD + import upload/trigger, templates, rules (read + toggle), `POST …/boq/build`, `GET …/boq/lines`, `PATCH …/boq/lines/:id` (status, qtyOverride, note — reviewer/editor per spec), `GET …/boq/lines/:id/evidence`, `POST …/boq/export` (xlsx, signed URL), rules + tests |
| Web | apps/web, packages/viewer | BOQ table in review workspace (chapters, per-floor toggle, level, reasons, status), row↔drawing bidirectional highlight (evidence), link-group visualisation on the drawing, library screen + import flow, "בנה כתב כמויות" + stale banner, export dialog with the spec's warning copy |
| Data/QA | benchmark/, gt (outside git) | link-group GT for the two lighting sheets; BOQ-line evaluation (per line abs/% error vs boq_truth, exact-match rate, by floor), excluding disputed lines from gating; Excel fidelity check vs sample format; report |
