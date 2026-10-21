# Sprint 5 — requests from DevOps/Security to other agents

Status 2026-10-21: done in code (verified by DevOps) — R-A1 (`apps/api/src/common/logging.ts` redacts the token
segment), R-A2 (`apps/api/src/db/audit-chain.ts` `{event:'audit',…}` line), R-A5 (`bootstrap.ts` `useDefaults:false`
+ `X-Frame-Options: DENY`), R-A7 (`config.ts` refuses `OFFBOARDING_REQUIRE_MFA=false` in production), R-WEB2
(`apps/web/public/.well-known/security.txt`, contact still a placeholder; `firebase.json` now deploys `.well-known/`
directly instead of the earlier rewrite). Open: R-A3, R-A4, R-A6, R-A10, R-W2. Done: R-A8 (functions run as `API_SERVICE_ACCOUNT`, default `kamutan-api@`, `apps/api/src/function.ts`), R-A9 (one-line certificate), R-W1 (`workers/drawing/src/kamutan_drawing/service/logging_setup.py`, JSON lines with `severity`).

Sprint-5 security gate (docs/sprints/sprint-5-security-gate.md), status 2026-10-21: F-1 (High), F-2, F-3, F-4, F-5,
F-7, F-8, F-9 fixed in the API/rules (apps/api/NOTES.md "security gate fixes"), F-6 and I-3 fixed by Worker-Export.
Infra residuals handled by DevOps: F-2 direct invocation → infra/IAM.md §3c + deploy check + R-A10; F-5 platform
request logs → Cloud Logging exclusion `share-token-urls` (`infra/monitoring/setup-alerts.sh`); I-5 → `vars.ZAP_IMAGE`
digest pin (owner action). Still open: I-1 (per-instance limiter), I-4 (purge destructive by default), I-6.

DevOps does not edit `apps/api`, `packages/contracts` or `workers/`. Each item: owner, why, what, how to verify.
Priority: **P1** = before beta, **P2** = soon after.

## API agent (`apps/api`)

### R-A1 (P1, **done** 2026-10-21) — Never log the share token
`apps/api/src/common/logging.ts` serializes `req.path`; the public routes are `/api/v1/public/share/:token/…`, so every
external view writes the **raw 256-bit token** into Cloud Logging (anyone with `logging.viewer` could open the link;
SEC-26 says only the SHA-256 is stored). Also the `HttpExceptionFilter` / error logs if they include the URL.
- In the `req` serializer, replace the token segment: `path.replace(/^(\/api\/v1\/public\/share\/)[^/]+/, '$1<redacted>')`
  (or `<sha256:8 hex>` if correlation per link is wanted — the hash prefix is not usable as a token).
- Same for any `logger.*` call that receives `req.url`/`req.originalUrl` on public routes.
- Test: an e2e request to `/api/v1/public/share/<token>/meta` and assert the captured pino output does not contain the
  token. The monitoring filters (`infra/monitoring/setup-alerts.sh`) only rely on the `/api/v1/public/share/` prefix.
- Platform request logs (`httpRequest.requestUrl`): **done (DevOps, F-5)** — `_Default` sink exclusion
  `share-token-urls` in `infra/monitoring/setup-alerts.sh` (case-insensitive `/api/v1/public/share/` and `/s/<token>`).

### R-A2 (P2, **done** 2026-10-21) — Content-free audit log line for alerting (SEC-43)
Audit events live in Firestore (`orgs/{o}/auditLog`), which Cloud Monitoring cannot alert on. When `AuditService`
appends an event, also `logger.info({ event: 'audit', orgId, entity, action, actorType, actorUid }, 'audit')` — ids and
action names only, no `details`. Enables log alerts for: member/role changes (when an endpoint exists), share link
create/revoke, settings (`llmEnabled`, `trainingOptIn`), offboarding. DevOps will add the policies once the line exists.

### R-A3 (P2) — Configurable Firestore database id (DR, SEC-36 RTO)
Add `FIRESTORE_DATABASE_ID` (default `(default)`) to `config.ts` and pass it to `getFirestore(app, id)`. Then disaster
recovery restores into a new database and redeploys with the env var instead of deleting `(default)`
(docs/runbooks/restore-drill.md §6). Same request to the worker (R-W2).

### R-A4 (P2) — CORS hardening (SEC-41) — current state is already compliant
Checked `bootstrap.ts` / `config.ts`: same-origin by default, exact-origin allowlist via `CORS_ORIGINS`, `*` rejected,
`credentials: false`, e2e test for a foreign origin. Small additions:
- In `production`, reject `CORS_ORIGINS` entries that are not `https://` origins (no path, no trailing slash) and warn
  when the list is non-empty at all (production is same-origin behind Hosting; CORS should stay empty).
- Positive e2e test: an allow-listed origin gets `Access-Control-Allow-Origin` = that origin and `Vary: Origin`; the
  public share routes never send CORS headers.

### R-A5 (P2, **done** 2026-10-21) — helmet CSP defaults on the JSON API
`helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], … } } })` merges helmet's defaults, so the
API actually sends `font-src 'self' https: data:; style-src 'self' https: 'unsafe-inline'; …` (seen in the DAST
smoke run). Use `useDefaults: false` with `default-src 'none'; frame-ancestors 'none'; base-uri 'none';
form-action 'none'` for the JSON routes, and `xFrameOptions: { action: 'deny' }` (helmet default is SAMEORIGIN).
ZAP flags these as low/informational; not a gate blocker.

### R-A6 (P2) — Optional CSP report endpoint
If wanted, `POST /api/v1/csp-report` (unauthenticated, `application/csp-report` / `application/reports+json`, 8 KB
cap, rate-limited, logs `effective-directive` + `blocked-uri` origin only). DevOps would then add `report-to` /
`report-uri` to the Report-Only candidate policy in `firebase.json` to collect real-browser data before tightening.

### R-A7 (P1, **done** 2026-10-21) — MFA for offboarding cannot be switched off in production
`OFFBOARDING_REQUIRE_MFA` defaults to `true` but is a plain env toggle. In `config.ts` `superRefine`, refuse `false`
when `NODE_ENV=production` (same pattern as the memory drivers), so a mis-set variable cannot disable SEC-02/SEC-52.
Also consider `requireMfa` on every admin-only route (settings PATCH, templates/rules PATCH, audit read).

### R-A8 (P1) — Run all three functions as `kamutan-api@` — **done**
`function.ts` sets no `serviceAccount`, so `api`, `apiJobs` and `reprocessDependents` run as the **default compute
SA** (Editor on older projects) and none of the least-privilege bindings in infra/IAM.md §3 apply. Add
`setGlobalOptions({ serviceAccount: process.env.FUNCTIONS_SERVICE_ACCOUNT ?? 'kamutan-api@<project>.iam.gserviceaccount.com' })`
(or a `defineString('API_SERVICE_ACCOUNT')` param so staging/production projects differ) before the exports.

### R-A9 (P2) — Purge certificate on one log line
`offboard-purge.ts` prints the certificate with `JSON.stringify(c, null, 2)`; on Cloud Run each line becomes a separate
log entry. Print `JSON.stringify(c)` (one line → `jsonPayload`), keep the pretty file for `--out`.

### R-A10 (P2) — Sprint-5 gate F-2 residual (direct invocation)
See infra/IAM.md §3c. (a) If the staging experiment shows Hosting rewrites still work with restricted ingress, set
`ingressSettings: 'ALLOW_INTERNAL_AND_GCLB'` on `api` in `function.ts` (the ingress of a gen2 function is owned by the
code; a manual `gcloud` change is reverted by the next deploy). (b) Either way, add an IP-independent circuit breaker
for unknown share tokens (e.g. > 200 unknown-token hits/min across all callers → short global 429 on unknown tokens;
valid tokens unaffected), so rotating a spoofed XFF hop cannot keep guessing at full speed. Keep `TRUST_PROXY_HOPS=2`
(chain documented in IAM.md §3c).

## Worker agents (`workers/drawing`)

### R-W1 (P1) — Configure logging in the service (SEC-43) — **done**
`kamutan_drawing/service` never configures `logging`, so Python's last-resort handler prints only WARNING+ as plain text:
the per-call `llm_call {…}` INFO line (cost, status) is **dropped in production** and cannot feed the LLM cost metric.
Configure a JSON formatter at INFO on stdout in `service/app.py` startup with Cloud Logging field names:
`{"severity": "INFO", "message": "...", "jobId", "orgId", "code"}` (no file contents, SEC-34). Keep the message texts
`job <id> failed: <code> …` and `llm_call <json>` — the alert filters in `infra/monitoring/setup-alerts.sh` match them
in either `textPayload` or `jsonPayload.message`.

### R-W2 (P2) — Configurable Firestore database id
Same as R-A3 for the worker's Firestore client.

### R-W3 (done) — Marked-PDF dependencies in the image
Worker-Export reports the Hebrew font ships inside the wheel (no system font needed). Applied their optional request:
the image smoke check in `infra/docker/worker-drawing.Dockerfile` now imports `pypdf` and `reportlab` too.

## Web agent (`apps/web`)

### R-WEB2 (P1, **done — placeholder contact**) — `security.txt` (beta checklist, SECURITY.md)
Add `apps/web/public/security.txt` (RFC 9116): `Contact: mailto:<security address from the owner>`,
`Expires: <≤ 1 year>`, `Preferred-Languages: he, en`, `Policy:` link to the disclosure policy. Delivered at
`apps/web/public/.well-known/security.txt`; `firebase.json` `hosting.ignore` no longer drops dot-directories (explicit
dotfile list instead of `**/.*`), verified in the Hosting emulator (200, text/plain). Owner: replace the placeholder
`Contact`.

### R-WEB1 (info) — CSP is enforced now
`firebase.json` enforces the policy documented in `docs/security/csp.md`. Anything new that loads from another
origin (analytics, Sentry, fonts, a CDN) must be added there first — `infra/scripts/csp-verify.mjs` fails the nightly
DAST run on any enforced violation. Inline `<script>` and `eval` will never be allowed; inline `<style>` is allowed
today only because Radix (`react-remove-scroll`) injects one.
