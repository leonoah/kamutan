# Stage 10 — Acceptance testing: brief for testers

Read first: docs/spec/07_test_plan.md (E2E-01..15, non-functional, devices), docs/spec/09_ia_redesign.md (IA v2 navigation),
docs/spec/05_ux.md, docs/sprints/sprint-5-report.md, docs/sprints/sprint-5-security-gate.md, AGENTS.md.

**Git: ONE branch, `main`, in /home/claude/kamutan.** No git commands that change state. The orchestrator commits.
**Testers test.** Do NOT fix product code (apps/*/src, packages/*/src, workers/*/src). You MAY add test code in your
own area (below) and test fixtures that contain no customer data. Report every defect.

Environment limits: the live site (kamutan-fba67.web.app), Google APIs, Docker Hub and the Firebase emulator JARs are not
reachable from this machine. The orchestrator checks the live system separately through a real browser. You test locally:
- web: `pnpm --filter @kamutan/web dev` / `build` + `preview` in **mock mode** (real Noah artifacts via the dev index in
  /home/claude/kamutan-data/artifacts/dev-index.json, see apps/web/NOTES.md), Playwright with the preinstalled Chromium
  (PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers; never `playwright install`);
- api: in-memory drivers (apps/api e2e harness);
- worker: the CLI on the real sample set /home/claude/kamutan-data/sample-noah/ (never commit these files or outputs).

Customer data (PDFs, rendered pages, artifacts, screenshots of drawings) stays OUTSIDE git, under
/home/claude/kamutan-data/acceptance/<your-area>/.

## Defect report format (each tester)
Write `/home/claude/kamutan-data/acceptance/<area>/defects.md` and return a summary. Per defect:
`ID (A-<area>-NN) · severity (Blocker/Critical/Major/Minor/Cosmetic) · scenario (E2E-xx or area) · steps · expected ·
actual · evidence path · suspected component (file:line if known)`. Plus a scenario table: E2E-xx → PASS / FAIL /
PARTIAL / NOT-TESTABLE-HERE (why) with evidence.

Severity: Blocker = scenario cannot be completed; Critical = wrong quantity/data leak/security; Major = wrong behaviour
with workaround; Minor = small functional/UX issue; Cosmetic = visual/copy.

## Areas
| tester | owns (may write) | scenarios |
| --- | --- | --- |
| UI-E2E | new `apps/web/e2e/**`, `apps/web/playwright.config.ts`, a `test:e2e` script in apps/web/package.json (devDependency `@playwright/test` pinned to the preinstalled Chromium's version — flock the install) | IA v2 navigation (landing → projects → hub → sheet analysis → project BOQ), E2E-02, E2E-03, E2E-06 (keyboard J/K/A/R, auto-focus), E2E-09 (share UI + external viewer), E2E-11 (history UI), E2E-13 (export dialogs), sheet/legend confirmation, upload dialog incl. E2E-14 UI, Hebrew/RTL, axe (0 serious/critical), mobile/tablet viewport (iPad: E2E-06, E2E-09 view/approve only), console errors |
| Pipeline | `benchmark/acceptance/**` (scripts + tests on synthetic data only) | E2E-01 quantities (table in 07_test_plan, confirmed vs disputed) from a full CLI ingest + BOQ build of the 15 Noah sheets; E2E-04 scale conflict (synthetic sheet); E2E-05 PNG-only (render Noah to PNG, ingest: no green, "גיליון רסטר", BOQ complete); E2E-07 DXF/DWG blocks (synthetic DXF with blocks + graphic duplicates); E2E-08 custom plumbing rule; E2E-12 new version keeps human approvals; E2E-14 truncated file in a set; E2E-15 LLM off → 0 egress; performance (A3 P95 < 60 s, set < 10 min) |
| API/Sec | `apps/api/test/acceptance/**` | E2E-09 (API: 403 on writes, 410 after revoke/expiry, headers), E2E-10 org isolation via URL/API (404/no leak in errors), E2E-11 (API history + org audit), E2E-12 API side, offboarding flow end to end in memory, roles matrix (viewer/reviewer/editor/admin) on every member endpoint, export gate on red lines, input validation/limits on uploads |
