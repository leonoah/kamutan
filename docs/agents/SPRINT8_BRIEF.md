# Sprint 8 — Prices & totals, version comparison, housekeeping, Claude-ready

Read first: AGENTS.md, docs/agents/SPRINT0_BRIEF.md (own dirs, `flock` for installs, NO git commits, NOTES.md, tests
green, mypy the CI way), SPRINT3–7 briefs (interfaces still valid), docs/sprints/sprint-7-report.md, docs/spec/05_ux.md,
docs/spec/06_security.md. **Git: ONE branch, `main`.** Never run state-changing git commands. Noah evals need
`KAMUTAN_AV_SCAN=off` (antivirus shelved by the owner).

## 1. Prices and totals (main theme)
- **Org price list:** a unit price per library item (`itemLibrary/{itemId}.price {amount, currency:'ILS', updatedAt, by,
  source:'manual'|'import'}`), editable in the library screen (editor+; bulk edit; history in audit).
- **Import prices** from a priced past BOQ (xls/xlsx, same importer as the library): fill prices for matched codes,
  report unmatched / conflicting rows, never overwrite a manual price without an explicit choice.
- **Project price overrides:** per BOQ line `priceOverride` (+by/at/reason), preserved across rebuilds like
  `qtyOverride` / `descriptionOverride`; and a project-level discount/markup % (optional).
- **Totals everywhere:** line total = effective qty × effective price; chapter subtotals; before VAT, VAT (org setting,
  default 18%), after VAT — in the BOQ panel, hub card, preview (`BoqDocumentModel`) and Excel (formulas kept).
  Lines without a price are flagged ("ללא מחיר") and counted in the warnings; export still works.
- **Share link:** prices are hidden by default; a per-link option "הצג מחירים" (editor+) — the snapshot stores prices
  only when chosen.

## 2. Version comparison ("מה השתנה")
- Each BOQ build stores a compact lines snapshot (`boq/{buildId}/lines.json.gz`: code, description, unit, qty, price,
  floor split). A comparison between any two builds (default: latest vs the one before; or "since last export"):
  added / removed / changed lines with Δqty, Δ₪, and the sheet versions that caused it.
- UI screen from the hub / BOQ panel; export the comparison to Excel ("תוספות ושינויים").

## 3. Housekeeping
- Delete a sheet set (and its sheets/versions/artifacts) and delete a project (admin; typed confirmation), releasing
  storage quota (`uploads/`, `infected/`, artifacts, exports) and revoking share links; audited.
- Enforce ≤ 100 sheets per project (Hebrew 409 message).
- Web performance: code-split the review workspace / viewer (deck.gl) and the preview so the landing, projects and hub
  load without the 900 KB drawing chunk; report bundle sizes before/after.

## 4. Accuracy (chapter 04 ±1)
4.00 (22 vs 23), 4.02 (6 vs 5), 4.03 (7 vs 8), 4.05 (10; drawing shows 10), 9.01 (44 vs 43, disputed GT-D-002). Find
the actual cause per line on the Noah sheets (GT in /home/claude/kamutan-data/gt/noah/); fix detection where the drawing
supports it, document disputes otherwise. No regressions; cold + warm glyph store.

## 5. Claude-ready (owner will provide an API key later)
New LLM gateway purposes, all behind the org toggle + budget, title block never sent, crops only:
`read_hard_text` (notes/marks the glyph dictionary + Tesseract could not read, e.g. "מפסק מחליף קיים", rotated H=),
`verify_symbol` (second opinion on yellow items: crop + legend row → agree / other class / unsure; never makes green),
batching (≤10 crops per call), prompt caching of legend crops, cost accounting per org. Tested with a fake provider;
a ready-to-run measurement script for Noah (before/after per line, $ per sheet) that runs when
`KAMUTAN_LLM_API_KEY` is present. Model id configurable (default `claude-sonnet-5-5`).

## Ownership
| agent | owns | delivers |
| --- | --- | --- |
| API | apps/api, packages/contracts, firebase/ | prices (library, import, overrides, VAT setting, totals in BoqDocumentModel + Excel), share option, comparison endpoint + Excel, deletes + quota release, 100-sheet limit |
| Worker-BOQ | workers/drawing: `boq/`, `library_import/`, `service/` | build lines snapshot per build, preserve `priceOverride*`, price import parsing (price column detection in xls/xlsx), cause attribution for changed lines (sheet versions) |
| Worker-Accuracy | workers/drawing: `symbols/`, `links/`, `ocr/`, `legend/` | item 4 with before/after |
| Worker-LLM | workers/drawing: `llm_gateway/`, hooks where hard text / yellow items are produced (coordinate in NOTES) | item 5 |
| Web | apps/web, packages/viewer | price list in the library (inline + bulk), price import flow, prices/totals in BOQ panel, hub, preview, line price override, discount %, VAT setting, share "הצג מחירים", comparison screen + export, delete flows, 100-sheet message, code-splitting; Playwright both modes, axe 0 serious |
