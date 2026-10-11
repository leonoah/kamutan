# @kamutan/api — Sprint 0 notes

NestJS 10 (TypeScript strict, CommonJS build) Core API for Sprint 0: **login → create project → upload & store a file**.
Contracts (Zod, the source of truth for DTOs and job payloads) live in `packages/contracts` (`@kamutan/contracts`).

## Endpoints (all under `/v1`, JSON, `Authorization: Bearer <Supabase access token>`)

| Method | Path | Min role | Notes |
| --- | --- | --- | --- |
| GET | `/health` | public | Liveness. |
| GET | `/health/ready` | public | DB + queue reachability; 503 when degraded. |
| GET | `/me` | any user | `userId`, `aal`, orgs with my role. |
| GET | `/orgs` | any user | My orgs. |
| POST | `/orgs` | any user | `{name, slug}` → creates org via `app.create_org`; caller becomes admin. 409 on slug clash. |
| GET | `/orgs/:orgId` | viewer | 404 for non-members. |
| GET | `/projects?orgId=&limit=&cursor=` | member | Projects of my orgs, newest first, cursor pagination. |
| POST | `/projects` | editor (of `body.orgId`) | `{orgId, name, address?}`. Audited (`projects/create`). |
| GET | `/projects/:projectId` | viewer | |
| PATCH | `/projects/:projectId` | editor | `{name?, address?, status?: active\|archived}`. |
| POST | `/projects/:projectId/uploads` | editor | `{filename, sizeBytes ≤ 100MB, sha256?}` → signed upload target + `uploadToken` (10 min). Stricter rate limit. |
| POST | `/projects/:projectId/sheet-sets` | editor | `{uploadToken, name?}` → verify, hash, dedupe, create rows, enqueue ingest. Stricter rate limit. |
| PUT | `/local-storage/:token` | signed token | **Dev/test only** (`STORAGE_DRIVER=local`): receives the raw bytes. Not mounted with Supabase storage. |

OpenAPI: `GET /docs` (UI) and `/docs/openapi.json` when `SWAGGER_ENABLED=true` and not production.
A static copy is generated with `pnpm --filter @kamutan/api openapi` → `apps/api/openapi.json`.

Errors always use the contract shape `{"error": {"code", "message", "requestId", "issues?"}}`
(`ApiErrorSchema`); the UI maps `code` to Hebrew strings. Non-members get **404** (no existence leak), members
with an insufficient role get **403**, MFA-gated actions return `403 mfa_required` (aal2, SEC-02; no Sprint 0
endpoint needs it yet, the `RequireRole(..., {requireMfa: true})` option is ready).

## Upload flow

1. `POST /projects/:id/uploads` — validates extension (pdf/dwg/dxf/png) and declared size; picks a server-generated
   path `{orgId}/upload/{uuid}` in the private `drawings` bucket (no user filename in the path, SEC-13); returns a
   signed upload URL and an HMAC-signed, stateless `uploadToken` (org, project, user, path, sanitized name, kind, exp).
2. Client `PUT`s the bytes to `uploadUrl` with the returned headers.
3. `POST /projects/:id/sheet-sets {uploadToken}` — token must match project + user + org; the API streams the object
   once: sha256, size (aborts > 100MB → 413), and the first 4KB for **magic bytes** (SEC-14): `%PDF-n`, PNG
   signature + `IHDR`, DWG `AC10xx`, DXF text (`0/SECTION/2/<known section>` after optional `999` comments/BOM) or
   binary DXF sentinel. Detected kind must equal the extension's kind, else 415 and the object is deleted.
4. In one RLS transaction (as the user): advisory lock on (project, sha256) → if the same bytes already exist in the
   project, return the existing set/version/job (`deduplicated: true`, duplicate object deleted); otherwise insert
   `sheet_sets` + placeholder `sheets` (`logical_key = upload:{sheetSetId}`, the ingest worker splits pages into real
   sheets) + `sheet_versions` v1 (`status=uploaded`) + `jobs` row (`queued`) + `audit_log` (`app.write_audit`).
5. After commit: enqueue `ingest.sheet_version` on queue `ingest` with `jobId = jobs.id` (idempotent), then set the
   version to `queued`. If enqueue fails → 503 and the version stays `uploaded`; retrying finalize re-enqueues.

Job payload (`IngestSheetVersionJobSchema`, ids only per SEC-24):
`{schemaVersion: 1, sheetVersionId, orgId, projectId, storagePath, sha256, fileKind, traceparent}`.

## Architecture

- `src/auth` — `AuthGuard` (global) verifies Supabase JWTs with `jose`: HS256 (`SUPABASE_JWT_SECRET`) and/or
  JWKS (RS256/ES256/EdDSA; `JWT_USE_JWKS` / `SUPABASE_JWKS_URL`); audience + issuer checked; **only
  `role=authenticated` tokens** (anon/service_role keys rejected); alg confusion prevented (HS256 only with a secret,
  asymmetric only with JWKS). `RolesGuard` (global) + `@RequireRole(minRole, {from: param|body|query|project-param})`
  reads membership **from the DB through RLS** (authoritative; role changes apply immediately).
  `UserThrottlerGuard` rate-limits per user (hashed IP for public routes); `@StrictRateLimit()` for uploads.
  Guard order: auth → throttle → roles.
- `src/db` — `Repository.run(user, fn)` = one transaction per operation with
  `set_config('request.jwt.claims', <verified claims>, true)` + `set local role authenticated`, so Supabase RLS applies
  (SEC-08). `PgRepository` over a tiny `SqlDatabase` port (`PgPoolDatabase` in prod, PGlite adapter in tests).
  `InMemoryRepository` (emulates the RLS rules we rely on) for e2e tests and DB-less dev (`DATA_DRIVER=memory`).
- `src/queue` — `IngestQueue` port: `BullMqIngestQueue` (`QUEUE_DRIVER=bullmq`, 3 attempts, exponential backoff
  10s) or `InMemoryIngestQueue` (`memory`, default; nothing consumes it).
- `src/uploads/storage` — `ObjectStorage` port: `SupabaseObjectStorage` (REST + service-role key; the only place the
  key is used) or `LocalObjectStorage` (filesystem + `PUT /v1/local-storage/:token`).
- Cross-cutting: pino via `nestjs-pino` (JSON; logs only request id, method, path, status, timing, userId/orgId — no
  headers, bodies, query strings, IPs, filenames or tokens), `X-Request-Id` accepted/minted and echoed, helmet
  (CSP `default-src 'none'` for the API, HSTS, no-referrer), `Cache-Control: no-store`, exact-match CORS allowlist
  without credentials, JSON body limit 256kb, Zod validation pipe (`.strict()` schemas reject unknown keys),
  OpenAPI generated from the Zod contracts. Config is Zod-validated; production refuses memory drivers, local storage,
  non-TLS Postgres/Redis and wildcard CORS.

## Running

```bash
# from repo root
flock /tmp/kamutan-pnpm.lock pnpm install
pnpm --filter @kamutan/contracts build          # API consumes the built contracts
cp apps/api/.env.example apps/api/.env          # fill SUPABASE_JWT_SECRET / UPLOAD_TOKEN_SECRET

# DB-less local dev (no Postgres/Redis/Supabase):
cd apps/api && set -a && . ./.env && set +a && DATA_DRIVER=memory pnpm dev
# against local Supabase (supabase start) + Redis: DATA_DRIVER=pg QUEUE_DRIVER=bullmq REDIS_URL=redis://...

pnpm --filter @kamutan/api build && node apps/api/dist/main.js   # production-style start
pnpm --filter @kamutan/api test        # vitest: unit + e2e + PGlite integration
pnpm --filter @kamutan/api typecheck
pnpm --filter @kamutan/contracts gen   # build + JSON Schema → packages/contracts/json-schema/
```

## Tests (`apps/api/test`)

- `unit/guards.test.ts` — JwtVerifier (HS256, JWKS/ES256, expiry, audience, issuer, service_role/anon rejection,
  alg=none, alg confusion), AuthGuard, RolesGuard (403/404/400, project→org resolution, aal2).
- `unit/magic-bytes.test.ts` — pdf/png/dwg/dxf(text, binary) positives and look-alike negatives.
- `unit/filename-token.test.ts` — filename sanitization (paths, bidi override, Hebrew), upload token tamper/expiry,
  streaming inspect with size limit.
- `unit/uploads.service.test.ts` — finalize flow, **dedupe** (same project / not across projects), 415 + delete on
  spoofed content, 409/400 token mismatches, enqueue failure → retry idempotency.
- `unit/config-openapi.test.ts` — production config guards; OpenAPI paths.
- `e2e/app.e2e.test.ts` — supertest against the real `AppModule` with fake repository + in-memory queue + local
  storage: headers, CORS, request ids, auth, orgs, projects (roles, isolation, pagination), full upload flow, rate limit 429.
- `integration/pg-repository.test.ts` — **production SQL** against PGlite + PostGIS with the real
  `supabase/migrations` and test stub (read-only), as role `authenticated` → RLS exercised (viewer write denied,
  outsider invisible, `file_kind` png→`image`, audit row). Skipped automatically if migrations are absent. ~40s.

## Known gaps / follow-ups

- **Quarantine bucket (SEC-13/15):** the DB migration defines a single private bucket `drawings` with `{org_id}/…`
  names and `sheet_versions.storage_path like org_id || '/%'`; uploads therefore go to `drawings/{orgId}/upload/{uuid}`.
  The `quarantine → originals` move after ClamAV is Sprint 1 (worker side).
- Supabase signed upload URLs are valid 2h (not configurable); the 10-minute window is enforced by the upload token.
  Resumable (TUS) uploads not implemented yet.
- `sheet_sets.file_kind` uses `image` for PNG in the DB; contracts use `png` and map via `DB_FILE_KIND` / `fileKindFromDb`.
- Finalize streams the whole object through the API to hash it (≤100MB). Fine for Sprint 0; consider worker-side hashing later.
- Throttler storage is in-memory (per instance). SEC-42 asks for Redis-backed limits + per-org quotas → Sprint 1.
- No OpenTelemetry yet: `traceparent` is propagated from the request header or minted.
- No DELETE project (admin + MFA, soft delete) and no membership/invite endpoints yet.
- The DB role in `DATABASE_URL` must be able to `SET ROLE authenticated` (Supabase `postgres` can). Don't use the
  service_role key for API DB access.
- `org_roles` JWT claim is parsed but not trusted; memberships come from the DB on every guarded request
  (one extra query per request).
