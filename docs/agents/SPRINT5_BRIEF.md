# Sprint 5 — Confidence & readiness: brief for all agents

Read first: AGENTS.md, docs/agents/SPRINT0_BRIEF.md (rules: own dirs only, `flock` for installs, NO git commits,
NOTES.md, tests green, run mypy as CI does), SPRINT1–4 briefs (interfaces still valid), docs/sprints/sprint-4-report.md,
docs/spec/08_workplan_v2.md (§2 decisions win; sprint 5 row), docs/spec/01_PRD.md (FR-20, FR-26, FR-27, FR-29–FR-31, §6
confidence model, §7 NFR), docs/spec/06_security.md (SEC-26–29 share links, SEC-35 audit, SEC-38 restore drill, SEC-40 CSP,
SEC-43 alerts, SEC-52 offboarding, beta checklist), docs/spec/07_test_plan.md (calibration section, E2E-01..15, performance
table), docs/spec/05_ux.md (share dialog, external viewer, history panel, export dialogs, settings).

**Git: there is ONE branch — `main`.** All agents work in the same checkout /home/claude/kamutan. Do not run any git
command that changes state (commit, checkout, branch, stash, reset, merge, rebase). The orchestrator commits to main.

**Sprint goal (demo):** "conservative calibration is live and explained; a reviewer can approve the Noah BOQ, see who
changed what, export a marked PDF coloured by BOQ line, and send a read-only, expiring, revocable link to a contractor;
an admin can offboard an org; CSP is enforced; one A3 sheet processes in < 60 s P95".

## 1. Conservative calibration (FR-20, test plan §Calibration, workplan §1 last bullet)
Until 30 GT projects exist the product runs in **conservative calibration** mode:
- A class may emit green only if it is in the calibration table with `greenAllowed: true`. Rule (test plan): the class has
  ≥ 200 dev items AND precision 1.0 on them (Wilson LB 95% reported). Every other class is capped at yellow with reason
  "כיול שמרני: אין מספיק נתוני אמת לסוג זה". Human-accepted items (accept/correction) stay green ("אושר ידנית").
- The ceiling rules stay hard: raster → never green; scale conflict → area items red.
- Calibration table artifact (versioned, in repo, no customer data): `workers/drawing/src/kamutan_drawing/calibration/
  table.json` = `{ schema: "kamutan.calibration/1", version, mode: "conservative"|"full", generatedAt, gtVersion,
  classes: { <class>: { n, tp, fp, precision, wilsonLb, greenAllowed, scoreMap: [[raw, calibrated], …] | null } },
  domains: {electrical|lighting|plumbing|tiling: {...same stats}} }`. `scoreMap` = isotonic map fitted on DEV only
  (never holdout); detections store both `scoreRaw` and `score` (calibrated) — additive fields only.
- Version stats: `stats.calibration = { mode, version }` on each version doc; BOQ lines carry it through `stats` of the
  build. Org setting `greenThreshold` (default 0.98, range 0.9–0.995) is reported against wilsonLb; the worker never
  makes green MORE permissive than the table.
- Web shows a persistent, honest badge "כיול שמרני" with an explainer popover (copy in 05_ux confidence language).

## 2. Line statuses & history (FR-26, E2E-11)
Keep the Sprint-3 decision: an override on an approved line moves it to "נבדק" (reviewed) and requires re-approval
(document this deviation from E2E-11's "טיוטה" wording in the test plan — QA agent edits docs/spec/07_test_plan.md).
- API `GET /v1/projects/:pid/boq/lines/:lineId/history` → `{ items: [{ at, by: {uid, displayName|null}, action:
  'status'|'qtyOverride'|'note'|'rebuild'|'correction', before, after, reason|null }] }`, newest first, built from the
  audit log (entity 'boqLines', entityId lineId) + corrections affecting the line's evidence. Reviewer+ may read.
- Admin `GET /v1/orgs/:orgId/audit?cursor=&entity=&action=` (paginated, admin only) + chain verification endpoint
  `GET /v1/orgs/:orgId/audit/verify` → `{ ok, checked, brokenAt|null }`.

## 3. Marked PDF (FR-29, E2E-13)
Job `export.marked_pdf` (new JOB_TYPES value; contracts jobs union) `{orgId, projectId, exportId, sheetIds[]|null,
 options: {legend: true, floorSplit: bool, watermark: string|null, hideTitleBlock: bool}}`.
Worker (`workers/drawing/src/kamutan_drawing/export/`, license-clean: pypdfium2 + pure-python writers only — pypdf (BSD)
and/or reportlab (BSD) are allowed; NO PyMuPDF): for each current sheet version, take the original page (vector PDFs) or
the rendered raster (PNG/DXF), overlay every detection that is evidence of a BOQ line, coloured by line (stable
palette by line code, colour-blind-safe, see dataviz palette in docs/spec/05_ux.md if present else Okabe-Ito + shapes
per level ●▲◆), plus a legend page/box "קוד · תיאור · כמות · צבע", plus confidence glyphs. Title block masked when
`hideTitleBlock`. Watermark text diagonal on every page when set. Output
`orgs/{o}/projects/{p}/exports/{exportId}/marked.pdf`; export doc `exports/{exportId}`: `{kind:'xlsx'|'marked_pdf',
status, storagePath, pageCount, createdBy, createdAt, error}`. API `POST /v1/projects/:pid/boq/export/marked-pdf`
(editor+) → `{exportId}`; `GET …/exports/:id` → status + 15-min signed URL when ready. Hebrew text must render (embed a
free Hebrew font that is already in the image/OS, e.g. DejaVu Sans / Noto Sans Hebrew if available; check license; never
download fonts at runtime).

## 4. Share links (FR-30, SEC-26–29, E2E-09)
Contract `ShareLinkSchema` exists (packages/contracts/src/share.ts) — extend additively: `label`, `recipient|null`,
`hideTitleBlock` (default true), `allowPdfDownload` (default false), `viewCount`, `lastViewedAt`.
- `POST /v1/projects/:pid/share-links` (editor+) `{days (1..90, default 14), label, recipient?, hideTitleBlock?,
  allowPdfDownload?}` → `{ link: ShareLink(without tokenHash), url }` — raw 256-bit base64url token returned ONCE.
  `versionLock` = current version id per sheet at creation. `GET …/share-links` (list, active+revoked), `DELETE
  …/share-links/:id` (revoke, immediate). Project delete / offboarding revoke all.
- Public, unauthenticated, read-only API under `/v1/public/share/:token/…`: `GET meta` (project name, link label,
  expiry, sheets list — no address/client name when hideTitleBlock), `GET boq` (lines incl. levels, statuses, byFloor),
  `GET sheets/:sheetId/overlay` (detections+links+rooms of the locked version, no raw text layer), `GET
  sheets/:sheetId/tiles/:z/:x/:y` (API-proxied, watermark "שותף עם {recipient|label} • {date} • {linkId-short}" burned
  in, title block masked) and `GET pdf` (only if allowPdfDownload; watermarked marked PDF). Token lookup by SHA-256 hash;
  expired → 410, revoked → 410, unknown → 404 (same body/timing as 410 except status). Headers on every public
  response: `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. Rate limit 60
  req/min per IP and per token; 10 unknown-token hits/min per IP → 429 for 15 min. Every view → audit event
  `share.view` {linkId, ipPrefix (/24 or /48), userAgent}. Any non-GET on /public → 405; any write with a share token →
  403.
- Web: share dialog (create, copy link once, list with expiry/views, revoke), external viewer route `/s/:token` (no
  auth, no edit controls, BOQ + drawing with evidence highlight, watermark overlay, Hebrew RTL, "פג תוקף" / "בוטל"
  screens).

## 5. Offboarding (SEC-52) & org settings (FR-31)
- `POST /v1/orgs/:orgId/offboarding/export` (admin, recent-auth/MFA claim `auth_time` ≤ 10 min) → job that builds a ZIP
  (sources, BOQ xlsx per project, JSON of lines/corrections/rooms) → signed URL 24 h. Implement in the API (Cloud
  Function, streaming zip, e.g. `archiver`/`yazl` MIT) or worker — API agent decides, document in NOTES.md.
- `POST /v1/orgs/:orgId/offboarding` (admin + MFA + typed org slug confirmation) → status `offboarding` (all access
  blocked except export download), revoke all share links + Firebase sessions (revokeRefreshTokens for members),
  schedule hard delete at +30 days (`deleteAfter`). Script `apps/api/src/scripts/offboard-purge.ts` deletes Firestore
  subtree + Storage prefix for orgs past `deleteAfter`, writes a minimal audit tombstone (no content) to
  `offboardingCertificates/{orgId}` and emits a deletion certificate JSON (`orgId`, counts, hashes, timestamps). Tested
  against the in-memory fakes; emulator test in CI.
- `PATCH /v1/orgs/:orgId/settings` (admin) — `greenThreshold`, `blockExportOnRed`, `llmEnabled`, `trainingOptIn`;
  every change audited.

## 6. Performance (NFR, test plan §Performance)
- Target: A3 vector sheet P95 < 60 s from upload to BOQ lines (worker side measured stage by stage), 15-sheet set
  < 10 min, find-similar < 3 s (already). Worker emits per-stage timings into `stats.timingsMs` (additive).
- Data/QA adds `kbench perf` (15 Noah sheets × N repeats, P50/P95 per stage, peak RSS) and wires it to nightly.

## 7. Security hardening (beta checklist)
- CSP **enforce** (move the Report-Only policy to `Content-Security-Policy` after verifying the app works with it:
  no inline scripts, Google sign-in popup, Firestore, Storage), HSTS, `Permissions-Policy`, CORS allowlist for the API.
  Share-viewer route gets the same CSP plus `Referrer-Policy: no-referrer`.
- DAST: OWASP ZAP baseline workflow (`.github/workflows/dast.yml`, nightly + manual) against a CI-local stack (vite
  preview + API in-memory mode) — 0 High gate; report artifact.
- Restore drill: `docs/runbooks/restore-drill.md` + script (`infra/scripts/`) for Firestore managed export/import and
  Storage object versioning restore into a scratch project; record the RPO/RTO measured fields to fill in when run.
- Pentest prep pack: `docs/security/pentest-scope.md` (scope, test accounts plan, rules of engagement, focus: tenancy,
  uploads/parsers, share links, auth).

## 8. Open accuracy items from Sprint 4
- Laundry niches as sub-rooms (not cladded on the open side, floor area included) → 5.01/5.02.
- Master bathroom window missed (room not closed).
- Upload-order dependency: when an architecture/construction sheet of a floor becomes ready after electrical/plumbing
  sheets of the same floor, re-run understanding for those dependents automatically (idempotent, debounced).

## Ownership
| agent | owns | delivers |
| --- | --- | --- |
| Worker-Cal (calibration + perf) | workers/drawing: `symbols/` scoring, `links/` levels, new `calibration/`, `pipeline/`, `service/pipeline.py` (timings) | §1 worker side (table loader, scoreRaw/score, caps + reasons, stats.calibration), §6 timings + profiling + optimizations to hit A3 P95 < 60 s |
| Worker-B (rooms) | workers/drawing: `rooms/`, `fixtures/`, `lifecycle/` | §8 (niches, window, dependents re-run) |
| Worker-Export | workers/drawing: new `export/`; ONLY the job-routing line for `export.marked_pdf` in `service/` (coordinate: Worker-Cal owns the rest of service/) | §3 worker side |
| API | apps/api, packages/contracts, firebase/ | §2, §3 API side, §4 API, §5, contracts for everything (jobs union, exports, share additive fields, calibration stats, org settings) + rules tests |
| Web | apps/web, packages/viewer | calibration badge, history panel, audit log screen, marked-PDF export dialog, share dialog + external viewer `/s/:token`, org settings, offboarding screen (admin), CSP-compatibility of the app |
| DevOps/Sec | firebase.json, .github/**, infra/**, docs/runbooks, docs/security | §7 |
| Data/QA | benchmark/, gt (outside git) | calibration report in kbench (`kbench calibrate`: reliability diagram data, ECE/MCE/Brier, Wilson LB per class & domain, ceiling-rule checks) producing the table in §1 from DEV only; `kbench perf`; updated eval for chapters 03/04/05 + 9.01 |

Contract changes: API agent owns packages/contracts; others request shape changes by putting them in their NOTES.md
"Contract requests" section AND mirroring locally until merged. Additive-only changes to existing shapes.
