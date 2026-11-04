# Sprint 7 — BOQ preview, editable line names, heights & raster spike, upload hardening

Read first: AGENTS.md, docs/agents/SPRINT0_BRIEF.md (own dirs, `flock` for installs, NO git commits, NOTES.md, tests
green, mypy the CI way), SPRINT3–6 briefs + STAGE10 briefs (interfaces still valid), docs/sprints/sprint-6-report.md,
docs/spec/05_ux.md, docs/spec/06_security.md. **Git: ONE branch, `main`.** Never run state-changing git commands.

## Owner requests (04.11) — top priority
1. **BOQ preview ("תצוגה מקדימה של כתב הכמויות").** Before exporting, the user sees the BOQ exactly as the Excel will
   look: title rows (project name, address, date), chapters with their titles and numbered notes, columns
   סעיף | תאור העבודה | יחידה | כמות | מחיר יח' | סה"כ, per-chapter "סה"כ" rows, grand totals before/after VAT, the
   optional "רמת ביטחון"/"סטטוס" columns, and a warning banner when red / unapproved lines exist (same rules as the
   export gate). Options as in the export dialog (summed / split by floor, include confidence columns, which chapters).
   **Fidelity by construction:** the API builds ONE export model (`BoqDocumentModel`) used by both the Excel writer
   and the preview endpoint — no second layout logic in the browser. Lines "להשלמה ידנית" show as in the Excel (empty
   qty + note). From the preview: "ייצוא לאקסל", "הדפסה" (print CSS, A4 portrait, RTL, repeating header row),
   and clicking a row opens that line in the review workspace. Works on desktop and tablet; on mobile a readable list.
2. **Rename a line ("לעדכן שם של שורה").** Any editor+ can change a line's description in the project:
   `descriptionOverride` (+ reason optional), stored like `qtyOverride` — **never overwritten by a rebuild**, shown in the
   BOQ panel / hub / preview / Excel / share snapshot, with an "✎ ידני" marker and "שחזר לנוסח המקורי". Audited, shown in
   line history (before → after). Option in the edit popover: "עדכן גם בספריית הסעיפים" (editor+, MFA rules as library
   edits) so future projects get the new wording — this updates the org's library item for that code (`source` becomes
   'manual' for that item; default items stay seeded for codes not touched). Edits inline (double-click / Enter on the
   description cell, Esc cancels), max 500 chars, sanitized on export (formula-injection rules).

## Engineering items
3. **Heights from the drawings (7.06/7.07/2.03/7.03):** read "H=…", "גובה …", section-level marks and ceiling-plan levels
   near walls/openings; partitions then use the drawn height instead of the floor's ceiling height. Re-measure 7.06
   (27.8 vs 35.2), 7.07, 2.01, 2.03, 7.03, 5.07. 7.04 access panels: one per gypsum AC closure / ceiling access note.
4. **4.10 two-way in the master bedroom:** read "מפסק מחליף קיים" near the bed-head switch; pair two-way switches
   ("a two-way switch needs a two-way partner") — then re-check 4.14 per Worker-BOQ's Sprint 6 note. No regression on
   4.09/4.12/4.14/4.11/4.16 (cold and warm glyph store).
5. **Raster (PNG-only) spike — E2E-05:** time-boxed. Goal: a Go / No-go with numbers for symbol detection on raster
   sheets (render the Noah PDFs to PNG at 200/300 dpi as the test set). Try template matching from the legend crop +
   rotation/scale search, and/or line-art vectorisation limited to symbol-sized blobs. Report recall/precision per class
   and time per A3. Ship only if precision ≥ 0.9 on the main classes with everything capped yellow ("גיליון רסטר");
   otherwise leave a documented prototype behind a flag.
6. **Upload hardening (deferred from Stage 10):** ClamAV scan of every uploaded file before parsing (worker side, in the
   sandbox's input path; infected → quarantined + `file_infected` error shown to the user; signature DB updated in the
   image build and daily), per-project storage quota (default 2 GB, org-configurable by admin; 413 with a Hebrew
   message; usage shown on the hub).

## Shared interfaces (additive)
- BoqLine: `descriptionOverride: string|null`, `descriptionOverrideBy`, `descriptionOverrideAt`, `descriptionOverrideReason`.
  PATCH `/boq/lines/:id` accepts `description` (null = restore) and `alsoUpdateLibrary: boolean`.
- `GET /v1/projects/:pid/boq/document?split=floor|none&confidence=1&chapters=…` → `BoqDocumentModel`
  `{titleRows[], columns[], chapters:[{code,title,notes[],rows:[{lineId|null, code, description, unit, qty|null,
  price|null, total|null, level?, status?, kind:'line'|'subtotal'|'note'}], subtotal}], totals:{beforeVat, vat, afterVat},
  warnings:[{kind:'red'|'unapproved'|'needsInput', count}], generatedAt}` — the Excel writer consumes the same model.
- Version/sheet: `stats.heights` (count read, used); errors `file_infected`, `quota_exceeded`; project `storageBytes`;
  org settings `projectQuotaBytes`.

## Ownership
| agent | owns | delivers |
| --- | --- | --- |
| API | apps/api, packages/contracts, firebase/ | `BoqDocumentModel` + refactor of the Excel writer onto it (Excel fidelity tests unchanged), preview endpoint, description override (PATCH, history, audit, library update with MFA rules, share snapshot, Excel), quota (accounting on finalize, 413, org setting), `file_infected` surfacing |
| Worker-BOQ | workers/drawing: `boq/`, `service/` | preserve `descriptionOverride*` across rebuilds (like qtyOverride/approvals), never write them; ClamAV call in the ingest path before the sandbox (clamd/clamscan in the image, timeout, fail-closed), `file_infected` |
| Worker-Accuracy | workers/drawing: `ocr/`, `symbols/`, `links/`, `geometry/`, `rooms/`, `textitems/` | items 3 and 4 with before/after on Noah (clean ingest, cold + warm store) |
| Raster-Spike | workers/drawing: new `raster_symbols/` (behind `KAMUTAN_RASTER_SYMBOLS=1`), benchmark scripts outside git | item 5, Go/No-go report |
| Web | apps/web, packages/viewer | preview screen (route `/projects/:id/boq/preview`, from the hub card, the BOQ panel and the export dialog; print CSS; row → review), inline rename + popover (restore, "עדכן גם בספרייה"), "✎ ידני" marker on the description, history entries, quota usage on the hub + 413 message, `file_infected` message; Playwright in both modes, axe 0 serious |
| DevOps | infra/, .github/, Dockerfiles | ClamAV in the worker image (+ freshclam at build and a daily job), CI image scan stays green (Trivy), size/time budget note |

Final report per agent: what was built, tests, numbers (where relevant), open issues.
