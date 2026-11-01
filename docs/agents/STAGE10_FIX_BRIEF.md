# Stage 10 — Fix round: brief for developers

Read first: docs/agents/STAGE10_ACCEPTANCE_BRIEF.md (environment, data rules), docs/agents/SPRINT0_BRIEF.md (own dirs,
`flock` for installs, NOTES.md, tests green, mypy the CI way), the defect files (outside git):
- /home/claude/kamutan-data/acceptance/pipeline/defects.md (A-pipeline-NN)
- /home/claude/kamutan-data/acceptance/api/defects.md (A-API-NN)
- /home/claude/kamutan-data/acceptance/ui/defects.md (A-UI-NN)
- /home/claude/kamutan-data/acceptance/live/defects.md (A-LIVE-NN, found on the deployed system)

**Git: ONE branch, `main`.** No git commands that change state; the orchestrator commits.
Every fix: a regression test, and flip the acceptance test for that defect (`test.fixme` / `it.fails` / `it.todo` /
`xfail`) to a passing test. Spec wins over NOTES.md decisions unless stated below.

## Product decisions for this round (orchestrator)
- **Default library (A-LIVE-01):** a new org must get a usable BOQ without importing anything. Ship a generic default
  item library + template (chapters 01 הריסה, 03 אינסטלציה, 04 חשמל, 05 ריצוף וחיפוי, 09 תאורה — codes/descriptions/units
  aligned with the default BOQ rules in packages/contracts) as versioned contract defaults, seeded idempotently on org
  bootstrap and for existing orgs whose library is empty (lazy on first build or a one-off backfill). Generic trade
  wording only — no client names, prices or project data. Import of a past BOQ still overrides/extends it. When a line
  has no library item, keep the rule's unit (m², m', יח', קומפלט) and the rule's description; never "פריט 5.01" / "יחידה".
- **Approved line whose quantity changed in a rebuild (A-API-06 / A-pipeline-08):** the line drops to "נבדק" with reason
  "הכמות השתנתה מאז האישור (X → Y)" and must be re-approved; the export gate treats it as not approved. Audit event.
- **Export policy (A-API-04):** `blockExportOnRed` applies to every export: xlsx, marked PDF, share-link creation.
- **Roles (A-API-03, A-API-07):** follow the spec — reviewers may add/remove/reclassify/move/measure on the drawing
  (corrections), viewers may read line history.
- **MFA on admin settings (A-API-02):** org settings, templates and rules changes need MFA + recent auth like offboarding.
- **Members (A-API-01):** minimal member management for beta: invite by email (admin), change role, remove; audited.
  Invitation = pending membership claimed on first sign-in with that verified email. No email sending service yet: the
  admin copies an invite link.
- **Revised upload (A-API-05):** finalize accepts `replacesSheetSetId`; the old set's sheets become superseded versions
  of the matching new sheets (match by sheet title/number + discipline/floor, else by page order); the BOQ build uses
  only current versions; corrections re-match as in E2E-12.
- **Owner-pending (do not change behaviour now):** 5.02 courtyard (GT-D-007), 5.03 corner rule near doors (GT-D-008),
  4.09 16 vs 17 (GT-D-006). Fix only the geometric/detection parts of A-pipeline-03/04 that are wrong regardless.
- **Deferred to a separate item (not this round):** ClamAV (A-API-12), per-project quota (A-API-13), DWG via dwg2dxf.

## Ownership
| agent | owns | defects |
| --- | --- | --- |
| Worker-Accuracy | workers/drawing: `symbols/`, `legend/`, `links/`, `parse/`, `ocr/`, `pipeline/`, `rooms/`, `fixtures/` | A-pipeline-01 (4.05 comms: phone/data/TV), A-pipeline-02 (4.10 two-way groups), A-pipeline-06 (PNG-only: detections, discipline/floor, reason text "גיליון רסטר" = A-pipeline-11), A-pipeline-05 (DXF INSERT blocks: block count + graphic count, mismatch yellow), A-pipeline-03/04 non-convention parts (wall faces inset), A-UI-19 (floor vs title contradiction flag), A-LIVE-03 (why the deployed lighting sheet shows 39 green under conservative calibration — check calibration packaging in the image/wheel, the reprocess path, and any green path that bypasses `calibration.calibrate`) |
| Worker-BOQ | workers/drawing: `boq/`, `service/` (BOQ build routing), `library_import/` | A-pipeline-08 (approval invalidation, with the API), A-pipeline-07 (chapter 01 template lines offered as קומפלט 1.0), A-pipeline-10 (line with qty and no evidence), A-pipeline-12 (per-room breakdown on lines + Excel "פירוט לפי חדר"; combination rule e.g. "אסלה תלויה + מיכל סמוי = 1 × 3.04"), A-LIVE-01 worker side (rule unit/description fallback when no library item), `stats` for A-LIVE-02 if the worker owns the counters |
| API | apps/api, packages/contracts, firebase/ | A-LIVE-01 (default library/template contracts + seeding + backfill), A-LIVE-02 (project card counts: sheets, % verified — whoever writes the project doc), A-API-01..11 except deferred, A-UI-06 (stable history order: tie-break), A-UI-08 (manual add appears in line history — verify on the real API), A-UI-13 (audit details: Hebrew, readable summary field from the API) |
| Web | apps/web, packages/viewer | A-UI-01..23 (except those owned above), A-LIVE-04, BOQ panel/hub empty-library prompt and the default-library state, re-upload action (A-UI-05), revised-upload flow (choose "replaces set X"), members screen (invite link, roles), MFA/reauth on settings, a11y A-UI-03/04/16 (axe 0 serious/critical), mobile A-UI-01/02/10/21 |

Contract changes: API owns packages/contracts; others request in NOTES.md "Contract requests" and mirror locally.
Final report per agent: defect → fixed how → test; anything not fixed and why.
