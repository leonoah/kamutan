# Sprint 5 — security gate (share links, governance, offboarding, marked PDF, hardening)

Gate from `docs/spec/06_security.md` ("שערים לפי ספרינט", row 5): *קישורי שיתוף (SEC-26–29); CSP ב-enforce; תרגיל שחזור;
offboarding; DAST; בדיקת חדירה; צ'קליסט בטא*, plus SEC-35 (audit), SEC-40 (CSP), SEC-52 (offboarding) and
`docs/agents/SPRINT5_BRIEF.md` §3, §4, §5, §7. This is an independent review: the reviewer did not write the code.

Scope: `apps/api/src/share/`, `apps/api/src/governance/`, `apps/api/src/db/governance-*`, `apps/api/src/access/`,
`apps/api/src/auth/`, `apps/api/src/bootstrap.ts`, `apps/api/src/common/logging.ts`, `apps/api/src/scripts/offboard-purge.ts`,
`firebase/firestore.rules`, `firebase/storage.rules`, `firebase.json`, `workers/drawing/src/kamutan_drawing/export/`,
`workers/drawing/src/kamutan_drawing/calibration/`, `apps/web/src/features/share/`, `apps/web/src/api/http.ts`,
`.github/workflows/dast.yml`, `infra/scripts/zap_gate.py`, `.zap/rules.tsv`.

Status legend: **ok** = verified by reading the code path end to end (and by a test or PoC where noted); **finding** = see
the Findings section; **not run** = could not be executed here.

Date: 2026-10-21, `main` @ `32a33ab`, read-only. Independent security reviewer.

## Gate items

| # | Gate item | Status | Evidence | What is missing |
| --- | --- | --- | --- | --- |
| S1 | Share token: 256-bit, base64url, only SHA-256 stored, returned once (SEC-26) | **ok** | `share-links.service.ts:94-99` `randomBytes(32).toString('base64url')`, `tokenHash = sha256Hex(token)`; `toView` strips `tokenHash`; `shareLinks/**` and `shareTokens/**` deny-all in `firestore.rules:68-71,168-170`. e2e "editor creates…" asserts the token is in no stored doc or audit event. | — |
| S2 | 404 / 410 same body, near-equal timing | **ok** | `public-share.service.ts:106-121`: unknown → index read + dummy link read (2 reads), expired/revoked → 2 reads then 410; `timingSafeEqual` on equal-length hex; controller emits one body for both (`public-share.controller.ts:38-41`), only status + `x-share-state` differ. Malformed tokens skip the index read (shape is public, no oracle). | — |
| S3 | Version lock: no other org / project / sheet / newer version | **ok** for meta, overlay, tiles, pdf; **finding F-4** for `boq` | org/project come only from the `shareTokens/{hash}` index; `lockedVersion` (`:163-169`) only serves `lock[sheetId]` (DocIdSchema-checked) and `status == ready`; tiles path built by `storagePaths.tile` + `TILE_PATH_RE` assert. `GET boq` serves the live `boqLines` of the project. | F-4 |
| S4 | Path params of tiles / overlay (IDOR, traversal) | **ok** | `z/x/y` `^\d{1,5}$`, `z ≤ 19`, bounds-checked against `tileLevels` (`:298-299`); `sheetId` must be a key of the link's lock; storage helpers assert path regexes. | — |
| S5 | Rate limit 60/min per IP + per token, lockout after 10 unknown tokens (SEC-29) | **finding F-2** | Logic is correct (`share-rate-limit.ts`, e2e) but keyed on `req.ip`, which `trust proxy = true` takes from the client-controlled left end of `X-Forwarded-For`. PoC passes. Per-instance memory (documented in NOTES). | F-2 |
| S6 | Response headers on every public response | **ok** (canonical path) / **finding F-5** (case variants) | `publicShareMiddleware` (`bootstrap.ts:21-32`) + helmet `no-referrer` + global `no-store`; Hosting `/api/**` adds the same. `/api/v1/PUBLIC/share/...` is routed but skips the middleware. | F-5 |
| S7 | Watermark and title-block mask cannot be bypassed | **ok** for tiles watermark; **findings F-3, F-6** | Tiles: watermark + mask burned into pixels server-side (`watermark.ts:265-289`), every level re-masked. Overlay drops detections/rooms whose centre is in the mask, no text layer. PDF: real raster redaction when a title-block box is known (PoC: no extractable text, 0 dark pixels in the box). Gaps: no mask at all in the PDF and only a fixed 45 mm bottom strip on tiles when the worker found no title block (F-3); PDF watermark is a strippable text object (F-6). | F-3, F-6 |
| S8 | No PII when `hideTitleBlock` | **finding F-3** | `meta` drops `project.address` (`:208`), `page tag` drops the sheet title in the PDF. Still exposed: the unmasked title block (F-3), `sheets[].title` (falls back to the title-block `classification.sheetTitle`, `:184`), `project.name` (often the client's family name, e.g. the test fixture "בית משפחת נח"). | F-3 |
| S9 | Share token never logged | **finding F-5** | pino serializer rewrites the token segment (`logging.ts:7-16`), no headers/query/IP logged; audit events carry `linkId` only. Gaps: case-variant paths are not redacted; Cloud Functions / Cloud Run platform request logs (`httpRequest.requestUrl`) record every token. | F-5 |
| S10 | Non-GET on /public → 405; share token on member API → 403 | **ok** | middleware 405 before routing; `AuthGuard` (`auth.guard.ts:31-32`) answers 403 to a non-GET/HEAD/OPTIONS that carries `X-Share-Token` or a 43-char bearer; GET with a share token → 401 (verifier rejects). e2e "405 for every non-GET…". | — |
| G1 | Audit + history admin/role enforcement, cross-org | **ok** | `audit`, `audit/verify`: `@RequireRole('admin')` + `AccessService.requireRole` in the service; history reviewer+ via `requireProjectRole`; non-member → 404. `auditLog` rules admin-read only, writes denied. | — |
| G2 | Hash chain integrity and verify | **ok** (append) / **finding F-8** (verify) | Appends serialize on `auditMeta/head` inside the transaction (`firestore.repository.ts:466-512`), canonical JSON, prevHash linking, fork detection. Verify never compares against `auditMeta/head` → deleting the newest events verifies `ok` (PoC). | F-8 |
| G3 | Audit has no drawing content / full IPs | **ok** | `share.view` stores `ipPrefix` (/24, /48; `governance-docs.ts:168-180`) and a control-char-stripped UA ≤ 200 chars; settings `{field:{from,to}}`; offboarding `hasReason` only; note text never logged. | — |
| G4 | Line history correctness | **finding F-9** | History query filters by org + `entityId` only; line ids are deterministic (`ln_<code>`) so projects of one org share history (PoC). | F-9 |
| O1 | MFA + recent auth for offboarding; not switchable off in prod | **ok** for `POST offboarding`, `POST offboarding/export`; **finding F-7** for the download | `requireOffboardingAdmin` = admin + `requireMfa: cfg.OFFBOARDING_REQUIRE_MFA` + `auth_time ≤ 10 min`; `config.ts:70-71` refuses `OFFBOARDING_REQUIRE_MFA=false` when `NODE_ENV=production`; ID tokens verified with `checkRevoked: true`. | F-7 |
| O2 | Typed confirmation | **ok** | `req.confirm.trim() === org.name.trim()` checked after MFA/recent-auth (`offboarding.service.ts:109`). The brief says "slug"; the org name is used — equivalent. | — |
| O3 | Blocked state on ALL member routes | **ok** for the API / **finding F-1** for Firestore + Storage | Every API controller route either has `@RequireRole` or calls `AccessService` in the service (`jobs.service.ts:21`, `orgs.service.ts:43`); `allowOffboarding` only on org read + offboarding endpoints. **Security Rules have no org-status check** — the web reads sheets, versions, project, BOQ builds and jobs straight from Firestore. | F-1 |
| O4 | Export ZIP only contains that org | **ok** | Projects from `orgs/{orgId}/projects`; sources only when `PROJECT_UPLOAD_PATH_RE` org + project groups equal the job's (`offboarding.service.ts:216-218`); zip entry names built from validated ids; writer path asserted by `OFFBOARDING_ZIP_PATH_RE`. | — |
| O5 | Purge deletes only the right prefix; dry-run safe | **ok** | `ORG_ID_RE` check, prefix `orgs/${orgId}/` with trailing slash (`governance-storage.ts:110-121`); Firestore `recursiveDelete(orgs/{id})` + `jobs`/`shareTokens` where `orgId ==`; `--dry-run` returns before any delete (`offboard-purge.ts:47`); only orgs with `status == offboarding && deleteAfter <= now`. | Info I-4 |
| O6 | Certificate content | **ok** | ids, counts, inventory hashes, audit head, timestamps, `requestedBy` uid; no names/content; self-hash over canonical JSON; tombstone in `offboardingCertificates/{orgId}` (deny-all rules). | — |
| C1 | Org settings PATCH: ranges, admin-only, audited | **ok** | `PatchOrgSettingsRequestSchema` (`greenThreshold` 0.9–0.995, finite), admin via guard + service, diff audited in the same transaction. | — |
| C2 | `greenThreshold` can never be MORE permissive than the table | **ok** | Worker: `CalibrationTable.green_allowed` (`calibration/__init__.py:151-158`) only adds a condition (`wilson_lb ≥ threshold`) on top of the table's `greenAllowed`; `clean_green_threshold` drops out-of-range values; the threshold is only consulted when the level is already green, so it can only demote to yellow. The API never computes levels from it. | — |
| R1 | Rules for new collections / paths | **ok** (read) / **not run** (emulator) | `shareLinks`, `shareTokens`, `offboardingCertificates`, `auditMeta`, `reprocessRequests` deny-all; `auditLog`/`offboardingExports` admin-read; `exports` member-read; storage `offboarding/**`, `exports/**` (incl. `marked.pdf`) deny-all. Rules lint + `firestore.rules.test.ts` cover these. | Emulator JAR download is blocked by the egress allowlist here; a PoC rules test for F-1 is in the scratch dir (`rules/offboarded.poc.test.ts`), not executed. |
| P1 | Marked PDF: customer bytes only in the sandbox | **ok** | `render.py` runs only via `run_task("export_marked")` (`job.py:364,379`; `sandbox/tasks.py:71,254`); inputs copied into the workdir, `_inside()` rejects traversal; output `%PDF-` + size + page-count checked; job `storagePath` bound to org/project/export (`contracts.py:65-68`); source path must equal `{proj}/uploads/{set}/source.pdf`. | — |
| P2 | JS / embedded files / annotations stripped | **ok** (PoC) | PoC: synthetic source with `/JavaScript` open action, an embedded file and a link annotation → none of them in any output (vector or raster). | Info I-3 (raster path renders source annotations as pixels) |
| P3 | Redaction is real (rasterised) | **ok** when a box is known (PoC) / **finding F-3** otherwise | PoC `hide_with_tb`: background `raster`, `extract_text()` empty, secret bytes absent, 0 dark pixels in the box. PoC `hide_no_tb_detected`: `maskSource none`, title block fully visible (1 454 dark pixels). | F-3 |
| W1 | `/s/:token` uses only the public client; no Referer / analytics / XSS leak | **ok** | `createPublicShareClient` GET-only, `credentials: omit`, `referrerPolicy: no-referrer`; `/s/**` Hosting headers `Referrer-Policy: no-referrer`, strict CSP (`script-src 'self'`, `connect-src 'self'`) — even with analytics consent on, gtag cannot load or beacon from `/s/`; no `dangerouslySetInnerHTML` in `features/share`, labels/descriptions rendered as React text; PDF link has `referrerPolicy="no-referrer"`. | Token stays in browser history (inherent to a path token; Info). |
| H1 | CSP enforce, HSTS, Permissions-Policy, X-Frame-Options | **ok** | `firebase.json`: enforced CSP on app paths (regex excludes `/s/`, `/api/`, `/__/`), stricter CSP on `/s/**`, HSTS preload, nosniff, Permissions-Policy, XFO DENY; API helmet `default-src 'none'`. `style-src 'unsafe-inline'` kept (documented WARN 10055). | — |
| H2 | DAST workflow + gate | **ok** | `zap_gate.py` fails on any non-IGNOREd High, any FAIL-rule alert, and on missing/unreadable reports (fail closed); no High rule is IGNOREd in `.zap/rules.tsv`; actions pinned by SHA; read-only token. | Info I-5 (ZAP image floating `:stable`); scans are unauthenticated and the in-memory API has no seeded share link. |
| D1 | sharp | **ok** | Only `watermark.ts`; inputs are worker-produced tiles from Storage (never raw customer uploads), `limitInputPixels: 4096*4096`; the Pango text is markup-escaped and stripped of control / bidi-override characters, ≤ 160 chars. | — |
| D2 | fflate | **ok** | Only `Zip`/`ZipDeflate`/`ZipPassThrough` (write side) in the offboarding export; no decompression of customer data. | — |
| D3 | pypdf, reportlab | **ok** | Only in `export/render.py`, inside the sandbox; `PdfReader(strict=False)` on customer PDFs is the parsing step SEC-17 covers. | — |

## Findings

### F-1 (High) — Offboarding block is not enforced by Firestore / Storage Security Rules
- **Where:** `firebase/firestore.rules:33-38` (`isMember` has no org-status check) and every `allow read: if isMember(orgId)` /
  `canCorrect(orgId)` below it (`:82-243`); `firebase/storage.rules:60-65` (`canUpload`). The block exists only in
  `apps/api/src/access/access.service.ts:65`.
- **Exploit:** an admin offboards the org (`POST /v1/orgs/:id/offboarding`). The API revokes refresh tokens, but
  (a) rules do not check revocation, so the current ID token keeps working for up to 1 h; (b) accounts are not
  disabled, so any member just signs in again. With the Firebase client SDK, which the web app already uses
  (`apps/web/src/api/firebaseBackend.ts`: project, sheets, versions, sheetSets, boqBuilds, jobs), every member keeps reading
  the project docs (name + address), `boqLines`, `sheets`/`versions`, `corrections`, `legendEntries`,
  `similarSearches`, `itemLibrary`, `boqTemplates`, `members` and, for admins, `auditLog`, for the full 30-day grace
  period. Reviewers can still update `reviewItems`. Editors can still create quarantine and import objects in Storage.
  SEC-52 / brief §5 require "all access blocked except export download".
- **Fix:** add `function orgActive(orgId) { return get(/databases/$(database)/documents/orgs/$(orgId)).data.get('status', 'active') != 'offboarding'; }`
  and require it in `isMember` / `roleIn`. Keep exceptions only for `orgs/{orgId}` itself and `offboardingExports` (admin).
  Apply the same check in `storage.rules` `canUpload` (`firestore.get(/databases/(default)/documents/orgs/$(orgId)).data.get('status','active') != 'offboarding'`).
  Add emulator tests: member of an offboarding org → read fails on project / boqLines / sheets, reviewItems update fails, quarantine create fails.

### F-2 (Medium) — Share rate limits, lockout and audit IP use the client-controlled `X-Forwarded-For`
- **Where:** `apps/api/src/bootstrap.ts:37` (`app.set('trust proxy', true)`), `apps/api/src/share/public-share.service.ts:99-104,113,127`
  (`ctx.ip` = `req.ip`), `apps/api/src/share/share-rate-limit.ts:158-174`.
- **Exploit:** with `trust proxy = true`, Express uses the left-most `X-Forwarded-For` entry. That entry is whatever
  the client sent; Firebase Hosting and the GFE append the real address to the right. A scanner sends
  `X-Forwarded-For: <random>` on each request:
  - the 10-unknown-tokens lockout never triggers;
  - the 60/min per-IP limit never applies;
  - a lockout already in place is lifted by changing the header;
  - `share.view` audit events record any `ipPrefix` the attacker chooses, so the SEC-29 view log can be forged.
  The PoC (`api/test/share.poc.test.ts` › F-XFF) sends 50 unknown tokens with rotating XFF and gets 50 × 404 and no
  lockout. After a lockout, a new XFF gets 200. IPv6 clients can also rotate within their /64 without spoofing,
  because the key is the full address. Token guessing is still infeasible (256 bits), so the impact is a broken
  SEC-29 control and forgeable audit data, not token disclosure.
- **Fix:** set `trust proxy` to the exact number of trusted hops (Hosting → Functions), or take the right-most entry that
  the GFE added. Key IPv6 by /64. Move the lockout and unknown-token counters to a shared store (Firestore/Memorystore)
  so they hold across instances.

### F-3 (Medium) — `hideTitleBlock` (default true) silently fails when no title-block box was detected
- **Where:** tiles and overlay: `apps/api/src/share/public-share.service.ts:156-161`. Without `titleBlockMm` the mask is a fixed
  45 mm **bottom** strip. Marked PDF: `workers/drawing/src/kamutan_drawing/export/render.py:565-587` + `write_pages:639`
  (`find_title_block` → `(None, "none")` → no mask at all) and `export/job.py:290`. The two components use different
  fallbacks. Meta: `public-share.service.ts:184` (`sheet.title || classification.sheetTitle`, text read from the title
  block) and `:208` (`project.name`).
- **Exploit:** `titleBlockMm` is written only by the Sprint-5 ingest (`service/pipeline.py:545-548`) and only when
  `classify_page` found a box. Every version ingested before Sprint 5, and every raster or scanned sheet with no text
  layer, has none. An editor shares such a project with the default settings and believes the client data is hidden.
  - **Tiles:** if the title block is a right-hand column, the common layout on Israeli drawings, the 45 mm bottom
    strip does not cover it. Client name, address, phone and architect are served in the watermarked tiles.
  - **PDF (`allowPdfDownload`):** the page is rasterised with no mask. In the PoC
    (`pdf/poc_redact.py` › `hide_no_tb_detected`), `maskSource` is `none` and 1 454 dark pixels of the "CLIENT
    SECRETNAME 054-…" text remain in the title-block area.
- **Fix:** fail closed.
  - When a locked sheet has no title-block box, either refuse `hideTitleBlock` links and PDFs for it with an explicit
    error in the share dialog, or mask a conservative union (bottom strip **and** right-hand column) in both the API
    and the worker. Use one shared constant in contracts.
  - Backfill `titleBlockMm` for existing versions.
  - Return `maskSource` per sheet in `meta` so the UI can warn.
  - When `hideTitleBlock` is set, do not fall back to `classification.sheetTitle` for the sheet title. Consider
    offering a share-specific project display name.

### F-4 (Medium) — `GET /public/share/:token/boq` is not version-locked (SEC-26)
- **Where:** `apps/api/src/share/public-share.service.ts:215-236` (`this.boq.listLines(orgId, projectId)` = live lines).
- **Exploit:** a link is sent to a subcontractor for a bid on revision A. Later the editor uploads revision B, rebuilds,
  overrides quantities and adds new chapters. Every later visit to the old link shows the live BOQ: new lines, new
  quantities, statuses and `byFloor`, including lines from sheets that were never in the lock. The PoC
  (`share.poc.test.ts` › F-BOQ) adds a line after the link was created, and `/boq` serves it. Tiles, overlay and the PDF
  stay on the locked versions, so the external view becomes internally inconsistent. SEC-26 requires that the link be
  "limited to the project and a specific version". Brief §4 does not state a lock for `boq`, so this is a spec
  conflict the owner must resolve.
- **Fix:** freeze the BOQ at link creation: store a snapshot (`shareLinks/{id}` → Storage `…/share/{linkId}/boq.json`, or
  pin `latestBuildId` and serve a frozen per-build line snapshot) and serve only that. At the same time, drop `reasons`
  and `overridden` server-side; the web already strips them per spec S15 (`apps/web/src/api/http.ts:298-301`), so the API
  sends data the external view must not show.

### F-5 (Low) — Share token reaches logs (case-variant paths; platform request logs)
- **Where:** `apps/api/src/common/logging.ts:7` (case-sensitive `SHARE_PATH_RE`), `apps/api/src/bootstrap.ts:22`
  (case-sensitive `startsWith`); Express/Nest routing is case-insensitive.
- **Exploit:** (a) `GET /api/v1/PUBLIC/share/<token>/meta` is routed and returns 200, but without `X-Robots-Tag`.
  `logPath` does not redact it, so the raw token is written to the pino log, and `POST` on that path is a 404, not a
  405 (PoC › F-CASE). (b) Independently of pino, Cloud Functions / Cloud Run request logs record
  `httpRequest.requestUrl` with the token for **every** public request. That gives every principal with
  `logging.viewer` a list of live bearer tokens, contrary to "share token never logged".
- **Fix:** match `/api/v1/public/` case-insensitively in both places, or enable case-sensitive routing. Add a Cloud
  Logging exclusion or redaction for `/api/v1/public/share/` request logs. Longer term, send the token in a header
  (`Authorization: Share <token>`) for API calls, keeping it in the path only for the web route.

### F-6 (Low) — Share PDF watermark is removable; with `hideTitleBlock=false` the original vector page is handed out
- **Where:** `workers/drawing/src/kamutan_drawing/export/render.py:385-400` (`draw_watermark`: one diagonal reportlab text
  object, 20 % alpha) and `write_pages:614-631` (vector path `merge_transformed_page` of the source page).
- **Exploit:** in PoC `pdf/poc_strip_wm.py`, deleting the `BT…ET` blocks from the page content stream removes the
  watermark while the drawing image stays intact, so a leaked PDF can no longer be traced to its link. The tiles burn
  the watermark into the pixels; the PDF does not. With `hideTitleBlock=false` and `allowPdfDownload`, the share PDF also
  embeds the customer's original vector content stream. All text is extractable (PoC `vector_nohide`:
  `secretInText: true`), which is close to "access to the source file" (SEC-26).
- **Fix:** for share-link PDFs always take the raster path. Burn the watermark into the raster with Pillow, as a tiled
  pattern like the API's tiles, before embedding. The reportlab text watermark can stay on top as a second layer.

### F-7 (Low) — Offboarding ZIP download has no MFA / recent-auth check
- **Where:** `apps/api/src/governance/offboarding.service.ts:92-101` (`getExport`: admin only), controller `:114-120`.
- **Exploit:** creating the export needs admin + MFA + a sign-in within the last 10 minutes. Downloading it needs only
  an admin ID token. The ZIP holds the whole organisation, including every source drawing, and a fresh 24-hour signed
  URL can be minted at any time until the purge. A stolen admin session without MFA, which SEC-02 is meant to stop for
  admin-level actions, can exfiltrate everything. Firestore rules never expose sources.
- **Fix:** call `requireOffboardingAdmin` before signing the URL. Status reads without a URL can stay admin-only.

### F-8 (Low) — Audit chain verify does not detect truncation of the newest events
- **Where:** `apps/api/src/governance/audit.service.ts:32-66`, `apps/api/src/db/governance-firestore.repository.ts:78-91`.
- **Exploit:** someone with Firestore write access, the only party the hash chain defends against, deletes the last N
  events (for example the `share.view` or `offboard` record). `GET audit/verify` still returns `ok: true`. `checked`
  shrinks, but nothing compares it with `auditMeta/head`, which still holds the true head hash and count (PoC
  `verify.poc.test.ts`).
- **Fix:** in verify, require the chain head to equal `auditMeta/head.hash`, and when present `count`. Anchor the head
  outside Firestore: log `hash` in `logAuditEvent`, and run the weekly export to a locked bucket required by SEC-35.

### F-9 (Low) — BOQ line history mixes projects of the same org
- **Where:** `apps/api/src/governance/audit.service.ts:113` → `auditForEntity(orgId, 'boqLines', lineId)`
  (`governance-firestore.repository.ts:93-97`); line ids are deterministic per code
  (`workers/drawing/src/kamutan_drawing/boq/aggregate.py:848`, `ln_<code>`).
- **Exploit:** an approval or override, with its reason, on line `ln_4_01` of project B appears in the history of
  `ln_4_01` in project A (PoC `history.poc.test.ts`). The data stays inside the org, but the FR-26 / E2E-11 approval
  trail becomes misleading.
- **Fix:** filter events on `after.projectId === projectId`, since `planLinePatch` already writes it, or use
  `entityId = ${projectId}/${lineId}` for new events.

### Info
- **I-1:** the share limiter and the view-audit dedup are per instance and in memory (documented in NOTES).
  Effective limits scale with the number of instances.
- **I-2:** the brief's "typed slug" is implemented as the typed org name. Equivalent, but document it.
- **I-3:** `render_pdf_raster` uses `draw_annots=True`, so on the share (raster) path the source PDF's annotations
  (reviewer comments, stamps) are painted into the pixels. The vector path drops `/Annots`. Use `draw_annots=False`
  for share exports.
- **I-4:** `offboard-purge` is destructive by default, and `--now <ISO>` can move "now" into the future with no
  guard, so orgs are purged before `deleteAfter`. Consider making dry-run the default with `--execute`, and refusing
  `--now` later than the real time.
- **I-5:** `dast.yml` runs `ghcr.io/zaproxy/zaproxy:stable` (floating tag, chosen on purpose and recorded in the
  summary). It is the only unpinned third-party artefact in CI (SEC-46).
- **I-6:** there is no project-delete endpoint yet, so the `project_deleted` revoke reason is unused. `meta` returns
  410 for a missing project, but `tiles` and `overlay` do not re-check project existence.

## Notes
* Commands run:
  - `cd apps/api && npx vitest run` → 26 files passed, 1 skipped (279 tests passed, 21 skipped).
  - `cd workers/drawing && .venv/bin/python -m pytest -q tests/test_export.py tests/test_calibration.py` → 58 passed.
* PoCs (scratch dir only, no repo changes), under
  `/tmp/claude-0/-home-claude/f061e704-d760-5c6d-ac8c-efaa67cb7367/scratchpad/secgate/`:
  - `api/test/share.poc.test.ts` (F-2, F-4, F-5), `api/test/history.poc.test.ts` (F-9) and
    `api/test/verify.poc.test.ts` (F-8). Run with `cd apps/api && npx vitest run --dir <scratch>/api`: all pass, which
    confirms the findings.
  - `pdf/poc_redact.py` (P2, P3, F-3, F-6) and `pdf/poc_strip_wm.py` (F-6). Run with the worker venv; the script
    calls `render.run` outside the sandbox on a synthetic PDF.
  - `rules/offboarded.poc.test.ts` (F-1). Not executed: the Firestore emulator JAR download is blocked by egress.
* F-1 must be re-verified with the emulator in CI (`pnpm --filter @kamutan/firebase-tests test:emulator`) once fixed.

## Verdict: **FAIL for beta** (as of `32a33ab`)

`06_security` requires 0 open Critical/High findings at beta, and F-1 is High: the SEC-52 offboarding block, a Must,
is bypassed through the client SDK, which is the web app's primary read path. This becomes **PASS-with-conditions**
once:
1. F-1 is fixed with emulator rules tests;
2. F-3 is fixed before beta (it is a PII leak under the default `hideTitleBlock=true`) or share links are restricted
   to sheets with a detected title block;
3. F-2 and F-4 have a fix plan within 30 days, with the F-4 spec conflict resolved by the owner;
4. the Lows are tracked.

The core share-link design holds:
- the token is unguessable and stored only as a hash;
- unknown and expired/revoked links get the same response;
- a token cannot reach another org, project or sheet;
- tiles are proxied with the watermark burned in;
- non-GET calls and writes are refused.
The worker sandboxing, tenant scoping of the export ZIP and purge, and the `greenThreshold` monotonicity are sound.

## Remediation (21.10.2026, same sprint)
| Finding | Status | Fix / evidence |
| --- | --- | --- |
| F-1 High | fixed (pending CI emulator run) | `firebase/firestore.rules` + `storage.rules`: member checks require org `status != offboarding`; tests in `firebase/tests/firestore.rules.test.ts` ("F-1"), `storage.rules.test.ts`, `rules.lint.test.ts` |
| F-2 Medium | fixed in API; residual documented | `TRUST_PROXY_HOPS` (default 2), IPv6 /64 keys; direct-invocation residual + staging experiment in `infra/IAM.md` §3c; `apps/api/test/e2e/secgate.e2e.test.ts` |
| F-3 Medium | fixed | no guessed mask; unmasked sheets excluded unless `includeUnmaskedSheets`; worker omits/refuses (`title_block_not_found`); neutral titles; tests in secgate e2e + `workers/drawing/tests/test_export.py` |
| F-4 Medium | fixed | BOQ snapshot at link creation (`share/{linkId}/boq.json.gz`), no `reasons`/`overridden` |
| F-5 Low | fixed | case-insensitive `/public` middleware + redaction; Cloud Run log exclusion `share-token-urls` |
| F-6 Low | fixed | share PDFs raster-only with burned-in watermark |
| F-7 Low | fixed | ZIP URL needs admin + MFA + recent sign-in |
| F-8 Low | fixed | verify compares tip with `auditMeta/head` |
| F-9 Low | fixed | history filtered by `projectId` |
| I-1, I-4, I-6 | open | per-instance limiter; purge default destructive; no project-delete endpoint |
| I-3 | fixed | raster path ignores source annotations |
| I-5 | open (owner) | pin `ZAP_IMAGE` digest after first DAST run |

## Re-verification (2026-10-21, `main` @ `a2abf29`)

Inputs:
- the remediation table in `docs/sprints/sprint-5-security-gate.md` §Remediation;
- `git diff 32a33ab a2abf29`, which touches the rules, API share/governance, worker `export/`, infra and web;
- the original PoCs re-run against HEAD, plus new PoCs aimed at the fixes.

Test runs:
- `apps/api` vitest: 292 passed, 21 skipped (27 files).
- Worker `test_export.py` + `test_calibration.py`: 62 passed.
- `firebase/tests` locally: lint passed, emulator suites skipped. The emulator JAR download is blocked here.
- GitHub CI on `a2abf29` (run 39610763630): every job `success`, including "DB (Firebase rules + emulator)". That job has
  a "rules suites actually ran (no skipped emulator tests)" guard, so the F-1 emulator tests did run. I could not read
  the job log itself because the egress allowlist blocks the log blob.

### Per finding

| # | Was | Now | Evidence |
| --- | --- | --- | --- |
| F-1 | High | **fixed** | `firestore.rules`: `orgActive()` (`get(org).status != 'offboarding'`) is ANDed into `isMember`, and so into `roleIn`, `isAdmin` and `canCorrect` for every tenant path and for `jobs`. A purged org has no doc, so `get` errors and the request is denied. While offboarding, members can read only the org doc (`isMemberAnyStatus`) and admins can read `offboardingExports` (`isAdminAnyStatus`). `storage.rules` `canUpload` adds `orgActive`. That makes 2 unique Firestore documents per evaluation (member + org); the cross-service limit is 2, so the rule stays valid. Tests: `firestore.rules.test.ts` "F-1" (21 collections × 4 roles, the original PoC, member docs, org doc and exports); `storage.rules.test.ts` "F-1" (quarantine + import). Green in CI. |
| F-1 exception | — | **acceptable** | Your own membership doc stays readable through the collection-group rule `/{path=**}/members/{memberId}` (`firestore.rules:92-94`, `resource.data.uid == request.auth.uid`). Rules are OR-ed, so this rule applies regardless of `isMember`. It exposes only data about the caller: uid, role, display name, email and createdAt. It does not expose org content or other members; reading another member's doc or listing `orgs/{o}/members` is denied, and both are tested. The app needs this read for "which orgs am I in" and to show the blocked screen. The org doc being readable is the same kind of exposure: name, settings, status, `deleteAfter`, and the requesting admin's uid. |
| F-2 | Medium | **fixed for the Hosting path; residual + new N-1** | `app.set('trust proxy', cfg.TRUST_PROXY_HOPS)` (default 2), and IPv6 is keyed by /64 (`ipLimitKey`). PoC `api/test/xff2.poc.test.ts`: with the modelled Hosting chain `spoof, client, edge`, spoofing no longer helps; lockout comes after 10 unknown tokens, including for a valid token. **Residual 1:** calling the function URL directly (`spoof, client`) still lets the client pick the IP; the PoC confirms it. This is documented in `infra/IAM.md` §3c with compensating controls and an owner staging experiment. **Residual 2:** the 2-hop chain is an assumption that nobody has checked against real traffic. If production appends one entry fewer, F-2 is fully back. If it appends one more, every client shares the edge IP and the lockout becomes a global DoS (see N-1). Original PoC `share.poc.test.ts` › F-XFF still "passes" because supertest sends a single XFF entry, the same as direct invocation; it does not model Hosting. |
| F-3 | Medium | **fixed** | API (`share-links.service.ts`): with `hideTitleBlock`, a sheet without `titleBlockMm` is **excluded** from the lock, with a warning. It is included only with the explicit `includeUnmaskedSheets` opt-in, which also returns a warning. `maskOf` never guesses a box. Meta shows "גיליון N" instead of title-block text, and the link label instead of `project.name`. Worker: `find_title_block` has no geometric fallback; with `hideTitleBlock`, a page with no box is **refused**; if no page is left the job fails `title_block_not_found`. The API serves the share PDF only when `rec.titleBlockMasked === true` (fails closed for older exports). PoC `pdf/poc_reverify.py`: `share_hide_no_tb` → `refused [0]`, 0 pages; `share_hide_tb` → raster, no source or title text, 0 dark pixels in the box. |
| F-4 | Medium | **fixed** | The BOQ is frozen at creation into `orgs/{o}/projects/{p}/share/{linkId}/boq.json.gz`. The public API reads it only when `link.boqSnapshotPath` equals the path recomputed from ids, and validates it with `ShareBoqSnapshotSchema` + `linkId`. `reasons` and `overridden` are no longer sent. The original PoC › F-BOQ now **fails**, as it should: the line added later is not served. **Snapshot path:** `SHARE_BOQ_SNAPSHOT_PATH_RE` is asserted on every read and write. Storage rules have an explicit deny-all `projects/{p}/share/**` (`storage.rules:156`), on top of default deny, covered by the "server objects never client-readable" matrix. Firebase Storage is the only client path to the object. The purge prefix `orgs/{o}/` covers it. Reads are bounded: metadata size ≤ `MAX_ARTIFACT_GZ_BYTES`, `gunzip maxOutputLength`. Info: the snapshot is not deleted on revoke, and if the link transaction fails it is left orphaned. Both are harmless; it is still purged with the org. |
| F-5 | Low | **fixed** | The middleware lower-cases the path before matching. Non-canonical case variants get the public headers, 405 for non-GET and 404 for GET. `SHARE_PATH_RE` is now case-insensitive. A Cloud Logging exclusion `share-token-urls` (`(?i)/api/v1/public/share/` and `/s/<token>`) is in `infra/monitoring/setup-alerts.sh`; the owner has to run it. PoC `case2.poc.test.ts`, as a variants table: the token is logged in no routed variant, and `X-Robots-Tag` is present on all of them. Info: a URL with a percent-encoded prefix (`/api/v1/publi%63/share/<token>/…`) is not routed (404), but pino logs its path unredacted and the exclusion regex does not match it. Only a holder deliberately sending their own token in that form can trigger it. |
| F-6 | Low | **partially fixed, new N-2** | Share PDFs (`watermark` set) never embed the original vector page; every page and the legend is a 150 dpi raster with the watermark burned into the pixels. PoC `share_nohide`: no source text, JS, embedded file or `/Annots`. **However**, the burned mark is almost invisible (N-2). |
| F-7 | Low | **fixed** | `getExport` calls `requireOffboardingAdmin` (admin + MFA + `auth_time ≤ 10 min`) before signing (`offboarding.service.ts:99`). A status read without a URL stays admin-only. |
| F-8 | Low | **fixed** | `verifyChain(events, head)` requires the tip hash, and the count when stored, to match `auditMeta/head`. The head hash is also logged with every audit event, which anchors it outside Firestore. The original PoC `verify.poc.test.ts` now **fails** (`ok: false`), as it should. An attacker who can rewrite both the events and the head doc defeats any in-DB check; the Cloud Logging hash is the anchor against that. |
| F-9 | Low | **fixed** | History keeps only events where `after.projectId === projectId` (`audit.service.ts:134`); every `boqLines` audit payload carries `projectId`. The original PoC `history.poc.test.ts` now **fails** (empty history for project A), as it should. No `rebuild` event emitter exists, so nothing is lost. |
| I-3 | Info | **fixed (code)** | `draw_annots=False` in `render_pdf_raster` (`render.py:541`) and in the share legend raster (`:741`). My dynamic check used a FreeText annotation without an appearance stream, which no renderer draws, so it proves nothing; this rests on reading the code. |

### New findings introduced by the fixes

**N-1 (Low): `TRUST_PROXY_HOPS` silently accepts a blank value as 0, also in production.**
- **Where:** `apps/api/src/config/config.ts:63`, `z.coerce.number().int().min(0).max(5).default(2)`.
- **Behaviour** (PoC `api/test/hops.poc.test.ts`, results in `secgate/hops.txt`): `''` → 0, `' '` → 0, `'0x2'` → 2, `'2e0'` → 2. Only `true`, `-1`, `1.5` and `6` are rejected. With 0, `req.ip` is the socket peer (the GFE), so every viewer shares one rate-limit key.
- **Exploit** (PoC `xff2.poc.test.ts`, third test): once an env var or secret is set empty, for example by a templated deploy with a missing value, any client sending 10 unknown tokens locks **every** share viewer out with 429 for 15 minutes. The 60/min per-IP limit also becomes global. A real hop count one higher than configured has the same effect.
- **Fix:**
  - parse as `z.string().regex(/^[0-5]$/)`, with no coercion of `''`;
  - in production require `>= 1` and refuse `0`;
  - on staging, log the XFF entry count once and pin the value, as IAM.md §3c already suggests.
  - Key the unknown-token lockout on (IP, token prefix), or add an IP-independent circuit breaker (R-A10), so a wrong hop count cannot turn the lockout into a global DoS.

**N-2 (Low): the burned-in share PDF watermark is applied at about 9 % instead of 30 % opacity.**
- **Where:** `workers/drawing/src/kamutan_drawing/export/render.py:604-627`. The stamp is drawn with `fill = 255·0.3`, then pasted with **itself as the mask** (`alpha.paste(stamp, (x, y), stamp)`, `:624`). That squares the opacity: 77·77/255 ≈ 23, about 9 %.
- **Measured:** on white, burned pixels are L = 242–243 (`secgate/pdf/wm_test.png`).
- **Exploit:** remove the vector text watermark (PoC `poc_strip_wm.py`, still works), then apply one "levels/threshold ≥ 240" step. That erases the burned mark completely while black or coloured line-art and the marks remain. Leak traceability (SEC-28) is effectively back to the pre-fix state. The tile watermark (≈ 35 %) is not affected.
- **Fix:** paste without the self-mask (`alpha.paste(stamp, (x, y))`, or `ImageChops.lighter`) so the opacity is the intended 0.3. Consider a darker or coloured mark, matching the tiles' `#7a0019` at 35 %. Add a test asserting burned pixels ≤ L 200 on white.

### Requested spot checks
- **F-4 snapshot path and rules:** ok (see the table). It is never client-readable, is path-bound to ids, is size-bounded and is purged with the org.
- **`TRUST_PROXY_HOPS` parsing:** N-1.
- **Case-insensitive `/public` middleware:** ok. Every case variant gets the headers and 405; non-canonical GETs get 404. Variants such as `/public/SHARE/…`, `…/META` and a trailing `/` are served normally with headers and with logs redacted. The percent-encoded prefix variant is Info only (not routed).
- **Share-PDF raster path:**
  - Fails closed per page, and the API requires `titleBlockMasked === true`.
  - It never takes the vector path.
  - Annotations are not drawn.
  - The placeholder for a chunk where every page was refused (≤ 11 pt page) is dropped in `assemble`.
  - The blank/tiles background is sized from the page mm at 150 dpi. The same sandbox memory limits as before apply, so there is no new DoS surface.
  - The only defect is N-2.

### Updated beta verdict: **PASS-with-conditions**

No Critical or High finding is open: F-1 is fixed and covered by emulator tests that ran in CI. Open items:

| Item | Severity | Condition |
| --- | --- | --- |
| F-2 residual (direct invocation; 2-hop assumption unverified) | Medium (residual) | Owner runs the IAM.md §3c staging check and logs the real XFF entry count **before beta**. Option A (ingress) or documented acceptance of B. |
| N-1 `TRUST_PROXY_HOPS` blank → 0 | Low | Strict parsing, and refuse 0 in production. Small fix; do it with the F-2 staging check. |
| N-2 watermark opacity squared | Low | One-line fix + test, within 30 days (recommended before beta, since it undoes most of F-6). |
| I-1, I-4, I-5, I-6; F-5 Info (`%63` variant); F-4 Info (snapshot on revoke) | Info | Track. |

Re-verification PoCs (scratch only), under `/tmp/claude-0/-home-claude/f061e704-d760-5c6d-ac8c-efaa67cb7367/scratchpad/secgate/`:
- `api/test/` — `share.poc.test.ts`, `history.poc.test.ts`, `verify.poc.test.ts` (original), plus `xff2.poc.test.ts`, `case2.poc.test.ts`, `hops.poc.test.ts` (new);
- `pdf/poc_reverify.py`;
- `pdf/wm_test.png`;
- `case2.json`;
- `hops.txt`.

### N-1 / N-2 follow-up (orchestrator, 21.10.2026)
- **N-1 fixed:** blank `TRUST_PROXY_HOPS` → default 2; production refuses 0 (`apps/api/src/config/config.ts`, test in `apps/api/test/unit/governance.unit.test.ts`). An IP-independent unknown-token limit remains open (R-A10).
- **N-2 fixed:** burned-in watermark max-combined instead of pasted with its own mask, so it keeps the configured 30% opacity (`export/render.py`, test `test_burned_watermark_keeps_its_configured_opacity`).
