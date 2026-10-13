# @kamutan/api — notes (Sprint 0 + Sprint 1, Firebase, ADR 0008)

NestJS 11 (TypeScript strict) Core API. Sprint 0: **login → create project → upload & store a file**. Sprint 1:
**quarantine upload → ingest via Pub/Sub → sheets list / confirm / regions / tiles (signed URLs) / reprocess / job status**.
Runs as Cloud Functions 2nd gen `api` (europe-west1) behind the Firebase Hosting rewrite `/api/**`
(same origin → no CORS needed), and locally via `src/main.ts`. Contracts (Zod, source of truth for DTOs,
Firestore doc shapes and job payloads) live in `packages/contracts` (`@kamutan/contracts`).

## Endpoints (all under `/api/v1`, JSON, `Authorization: Bearer <Firebase ID token>`)

| Method | Path | Min role | Notes |
| --- | --- | --- | --- |
| GET | `/health` | public | Liveness. |
| GET | `/health/ready` | public | Firestore reachability (Pub/Sub check is a no-op); 503 when degraded. |
| GET | `/me` | any user | `uid`, `mfa`, orgs with my role (collection-group query on `members.uid`). |
| GET | `/orgs` | any user | My orgs. |
| POST | `/orgs` | any user | `{name}` → `orgs/{id}` + `members/{uid}` (admin) + audit, one transaction. |
| GET | `/orgs/:orgId` | viewer | 404 for non-members. |
| GET | `/projects?orgId=&limit=&cursor=` | viewer of `orgId` | `orgId` required; newest first; cursor = last project id. |
| POST | `/projects` | editor of `body.orgId` | `{orgId, name, address?}`; audited. |
| GET | `/projects/:projectId` | viewer | Project → org resolved by collection-group query on `projects.projectId`. |
| PATCH | `/projects/:projectId` | editor | `{name?, address?, status?: active\|archived}`; audited. |
| POST | `/projects/:projectId/uploads` | editor | `{filename, sizeBytes ≤ 100MB, sha256?}` → `{fileId, storagePath, uploadToken (HMAC, 10 min), contentType, fileKind, maxBytes, expiresAt}`. Stricter rate limit. |
| POST | `/projects/:projectId/sheet-sets` | editor | `{uploadToken, name?}` → size + magic bytes → sheetSet + job + audit → move quarantine → uploads → publish. Returns `{sheetSet, deduplicated, jobId, versionId}`. Idempotent per token. Stricter rate limit. |
| GET | `/projects/:projectId/sheets?limit=&cursor=&sheetSetId=` | viewer | Sheets with classification, confirmed fields and `currentVersion {id,status,progress,error}`. Ordered by doc id (`{set}-p{i}`), each page re-sorted by (set, pageIndex); cursor = last sheet id. limit ≤ 200 (default 100). |
| GET | `/projects/:projectId/sheets/:sheetId/versions/:versionId` | viewer | `SheetVersion` (status, progress, page, artifacts, regions, stats). |
| GET | `/projects/:projectId/sheets/:sheetId/versions/:versionId/tiles-manifest?z=&x0=&x1=&y0=&y1=` | viewer | Tile meta + `levelGrid` + signed thumbnail URL; with `z` (+ optional inclusive range, clamped) a map `"z/x_y" → URL`, **≤ 256 per call** (400 above). Storage V4 signed, 15 min, `expiresAt` = earliest expiry. 409 `not_ready` unless status `ready` with tiles. Own rate-limit tier `TILES_THROTTLE_LIMIT` (60/min/user). |
| POST | `/projects/:projectId/sheets/:sheetId/confirm` | editor | `{discipline, floors[], scaleDenominator\|null, regions?}` → `confirmed=true, confirmedBy, confirmedAt` (+ regions on the current version); transaction + audit `sheets/confirm`. 409 if the current version changed meanwhile. |
| PUT | `/projects/:projectId/sheets/:sheetId/regions` | editor | `{regions[≤8]}` replaces the current version's regions: every vertex inside the page (±0.5 mm), simple polygon (no self-intersection / duplicate vertex / fold-back), area ≥ 1 mm², unique ids. 409 `not_ready` while the page geometry is unknown. Audit `sheetVersions/set_regions`. |
| POST | `/projects/:projectId/sheets/:sheetId/reprocess` | editor | 202 → new `versions/{v}` (status `queued`, versionNo+1, **regions carried over**), `jobs/{j}`, `currentVersionId` switched, audit `sheets/reprocess`, publish (`sheetId`+`pageIndex` set). 409 while current version is queued/processing. Publish failure → version + job `failed` (`publish_failed`) and 503. Stricter rate limit. |
| GET | `/jobs/:jobId` | viewer of `job.orgId` | Top-level job doc; membership checked in the service against the doc's `orgId` (non-members → 404). Tolerates worker docs with numeric `progress` + `stage`. |

OpenAPI: `/api/docs` (UI) and `/api/docs/openapi.json` when `SWAGGER_ENABLED=true` and not production; static copy
`apps/api/openapi.json` (`pnpm --filter @kamutan/api openapi` after build).

Errors always use `{"error": {"code", "message", "requestId", "issues?"}}` (`ApiErrorSchema`). Non-members → **404**,
insufficient role → **403**, MFA-gated → `403 mfa_required`.

## Authorization model

- `AuthGuard` (global): `IdTokenVerifier` port; prod = `FirebaseIdTokenVerifier` → `getAuth().verifyIdToken(token, true)`
  (signature, aud/iss = project, expiry, **revocation / disabled users**). Anonymous sign-ins are rejected. MFA =
  `firebase.sign_in_second_factor` present. Tests use `test/support/fake-verifier.ts`.
- `AccessService` (service layer, **mandatory**): reads `orgs/{orgId}/members/{uid}` (Firestore is authoritative,
  never token claims; cached per request). firebase-admin bypasses Security Rules, so every service method calls
  `requireRole` / `requireProjectRole` before touching data, and every repository method takes `orgId` and only
  addresses `orgs/{orgId}/...` (or `jobs/*` with `orgId`). Proven by `test/unit/access-isolation.test.ts`
  (services called directly, no guards) and the emulator suite.
- `RolesGuard` + `@RequireRole(minRole, {from: param|body|query|project-param}, {requireMfa})`: early route-level check
  through the same `AccessService`. Guard order: auth → per-user throttle → roles.

## Firestore / Storage mapping (ADR 0008 + Sprint 1 brief)

| Data | Path | Written by |
| --- | --- | --- |
| Org | `orgs/{orgId}` `{name, settings{llmEnabled, blockExportOnRed, greenThreshold, ...}, createdAt}` | API: create org |
| Member | `orgs/{orgId}/members/{uid}` `{uid, role, email?, addedBy, createdAt}` | API: create org (admin) |
| Project | `orgs/{orgId}/projects/{projectId}` `{projectId, orgId, name, address?, templateId, floors[], status, createdBy, createdAt}` | API |
| SheetSet | `.../projects/{pid}/sheetSets/{sha256}` `{fileKind, sha256, storagePath, status uploaded→queued→splitting→ready\|failed, name, uploadedBy, uploadFileId, sizeBytes, ingestJobId, versionId, pageCount:null, createdAt}` | API: finalize (doc id = sha256 → atomic per-project dedupe); worker: status, pageCount |
| Sheet | `.../projects/{pid}/sheets/{sheetSetId}-p{i}` `{sheetSetId, pageIndex, title, discipline, floors[], scaleDenominator, classification{discipline, floors, sheetTitle, scaleText, confidence, level, reasons}, confirmed, confirmedBy?, confirmedAt?, currentVersionId, updatedAt}` | **worker** creates (split); API: confirm fields, `currentVersionId` on reprocess |
| SheetVersion | `.../sheets/{sid}/versions/{vid}` `{versionNo, status queued\|processing\|ready\|failed, progress{stage,pct}, error?, page{widthMm,heightMm,rotation}, artifacts{tiles{prefix,format,tileSize,dpi,levels,widthPx,heightPx}, primitives, text, thumbnail}, regions[{id, floor, polygonMm[{x,y}], scaleDenominator}], regionsUpdatedBy?, regionsUpdatedAt?, stats{paths,segments,textLines,glyphs}, workerVersion, jobId?, createdAt?, updatedAt}` | **worker** (initial: all pages share the set's `versionId`); API: `regions*` and the queued doc on reprocess |
| Job | `jobs/{jobId}` `{orgId, projectId, sheetSetId, sheetId (null = initial), versionId, type:"ingest.sheet_version", status queued\|running\|succeeded\|failed, progress{stage,pct}, attempts, error, createdBy, createdAt, updatedAt}` | API creates; worker updates |
| Audit | `orgs/{orgId}/auditLog/{eventId}` `{actorId, actorKind, entity, entityId, action, after, at, prevHash, hash}` | API: org/project create+update, upload, confirm, set_regions, reprocess (per-org SHA-256 chain in the same transaction) |
| Quarantine object | Storage `orgs/{orgId}/quarantine/{uuid}` | client (resumable upload, create-only); read + deleted/moved by API |
| Upload (source) | Storage `orgs/{orgId}/projects/{pid}/uploads/{sheetSetId}/source.{ext}` | API move after checks (`Content-Disposition: attachment`, metadata sha256/uploadedBy/fileId/originalName) |
| Artifacts | Storage `orgs/{orgId}/projects/{pid}/sheets/{sid}/versions/{vid}/` `tiles/{z}/{x}_{y}.webp`, `thumbnail.webp`, `primitives.msgpack.gz`, `text.json.gz` | worker; API only signs read URLs (paths derived from ids, never from the worker-written `prefix`) |

**Polygons are `[{x, y}, ...]`, not `[[x, y], ...]`**: Firestore rejects nested arrays, so the brief's tuple form
cannot be stored. The contract (`RegionSchema.polygonMm`) uses objects everywhere (Firestore, API, web).

## Upload flow (SEC-13/14/15)

1. `POST .../uploads` — editor; extension (pdf/dwg/dxf/png) + declared size; returns
   `storagePath = orgs/{orgId}/quarantine/{uuid}` (no user filename) + HMAC upload token v3 (org, project, uid, path,
   sanitized name, kind, size, exp 10 min).
2. Client uploads with the Firebase JS SDK (`uploadBytesResumable`, contentType from step 1) into quarantine.
3. `POST .../sheet-sets` — token must match project + uid + org; streams the quarantined object once: sha256, size
   (> 100MB → 413 + delete), first 4KB → magic bytes must equal the declared kind (else 415 + delete). Only then:
   transaction creates `sheetSets/{sha256}` + `jobs/{jobId}` + audit (dedupe-safe), the object is **moved** to
   `uploads/{sheetSetId}/source.{ext}` (or dropped if identical bytes are already there), the `ingest` message is
   published (schemaVersion 3, `sheetId=null, pageIndex=null` = split all pages) and the set becomes `queued`.
   Publish failure → 503 with the set left `uploaded`; retrying with the same token finds the set via
   `uploadFileId` and re-publishes the same `jobId` (worker must be idempotent on `jobs/{jobId}`; Pub/Sub is
   at-least-once).

## Ingest queue (Pub/Sub, ADR 0008)

`PubSubIngestQueue` (`@google-cloud/pubsub`, topic `INGEST_TOPIC`, default `ingest`; no ordering keys; batching off)
publishes JSON `IngestSheetVersionJob` v3 with attributes `type`, `orgId`, `jobId`, `schemaVersion`. The payload is
validated against the contract before publishing. `InMemoryIngestQueue` (`QUEUE_DRIVER=memory`) for tests/offline
dev; refused in production. BullMQ/Redis are not used anywhere.

## Running

```bash
# repo root
flock /tmp/kamutan-pnpm.lock pnpm install
pnpm --filter @kamutan/contracts build            # API typecheck/build use the built contracts (turbo does this)
pnpm --filter @kamutan/api build                  # tsc → esbuild bundle: dist/function.js, dist/main.js
pnpm --filter @kamutan/api test                   # vitest (unit + e2e); emulator suite skipped without emulators
pnpm --filter @kamutan/api typecheck
pnpm --filter @kamutan/api test:emulator          # CI: firebase emulators:exec (firestore, storage, pubsub)

# offline local run (no Google access)
cd apps/api && DATA_DRIVER=memory STORAGE_DRIVER=memory QUEUE_DRIVER=memory \
  UPLOAD_TOKEN_SECRET=$(openssl rand -base64 48) node dist/main.js   # http://localhost:3001/api/v1/health
# against emulators: set FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST / FIREBASE_STORAGE_EMULATOR_HOST /
# PUBSUB_EMULATOR_HOST and GOOGLE_CLOUD_PROJECT=demo-kamutan; real project: ADC only (never a key file in the repo).
```

### Deploying (`firebase deploy --only functions`, source `apps/api`)

- `package.json`: `"main": "dist/function.js"`, `"engines": {"node": "22"}`. `src/function.ts` exports
  `api = onRequest({region: 'europe-west1', memory: '1GiB', timeoutSeconds: 120, concurrency: 40,
  secrets: [UPLOAD_TOKEN_SECRET], invoker: 'public'})` and boots Nest once per instance (cached promise).
- Env (Sprint 1): `SIGNED_URL_TTL_SECONDS` (900), `TILES_THROTTLE_LIMIT` (60 per `THROTTLE_TTL_MS`).
- Cloud Build runs `npm install` on `apps/api/package.json`, which cannot resolve pnpm `workspace:` deps. Therefore
  `@kamutan/contracts` is **not** a package.json dependency: `scripts/build.cjs` compiles with tsc (keeps decorator
  metadata) and then esbuild-bundles `@kamutan/contracts` into `dist/*.js` (all npm packages stay external; the build
  fails if the bundle still requires the workspace package). Types resolve via tsconfig `paths` to
  `packages/contracts/dist/types`; vitest aliases to `packages/contracts/src`; `apps/api/turbo.json` makes
  build/typecheck/test depend on `@kamutan/contracts#build`.
- The build must run before deploy (DevOps: `functions.predeploy` → `pnpm --filter @kamutan/api build`), and
  `functions.ignore` should exclude `src`, `test`, `scripts`, `*.map`, `.env*`, `node_modules`.
- Runtime SA needs: Firestore user, Storage object admin on the bucket, Pub/Sub publisher on `ingest`,
  Firebase Auth (verifyIdToken with checkRevoked reads the user record), and **`roles/iam.serviceAccountTokenCreator`
  on itself** (V4 signed URLs without a key file go through IAM `signBlob`). Secret `UPLOAD_TOKEN_SECRET` in Secret Manager.

## Tests (`apps/api/test`)

- `unit/guards.test.ts` — FirebaseIdTokenVerifier (mocked firebase-admin: `checkRevoked=true`, error mapping,
  malformed tokens, anonymous rejected, MFA claim), AuthGuard, RolesGuard (403/404/400, project→org, MFA,
  role change effective immediately).
- `unit/access-isolation.test.ts` — **cross-org access rejected at service level** (no guards).
- `unit/uploads.service.test.ts` — quarantine path (uuid, no filename), finalize (move, set + job + audit chain,
  Pub/Sub v3 payload + attributes, no sheet docs), dedupe, 4 kinds, 415/413 + delete, 409/400, publish failure →
  idempotent retry.
- `unit/sheets.service.test.ts` — list (status/progress, pagination, filter), version, confirm (+regions, audit),
  regions (bounds/self-intersection/area, 409 without page), tiles manifest (meta-only, window clamp, whole level,
  256 cap, z range, 409 not ready, ids-derived paths only), reprocess (carry-over regions, v3 payload, 409 in flight,
  publish failure), jobs (membership, legacy progress), `validateRegions`, `CachingUrlSigner`. Services called
  directly (no guards), incl. outsider → 404.
- `unit/magic-bytes.test.ts`, `unit/filename-token.test.ts` — validators, sanitizer, upload token v3, streaming inspect.
- `unit/function.test.ts`, `unit/config-openapi.test.ts` — Cloud Function handler; config; OpenAPI paths (+ tiles query params).
- `e2e/app.e2e.test.ts`, `e2e/sheets.e2e.test.ts` — supertest on the real AppModule with fake auth, in-memory
  Firestore/Storage/PubSub and `FakeUrlSigner`; contract-shape parsing of every response; tiles per-user 429.
- `integration/firestore.emulator.test.ts` — FirestoreRepository + services on the emulator: org/member/audit,
  collection-group lookups, cross-org rejection, pagination, concurrent ingest dedupe, sheets list via `getAll`,
  regions stored as maps, confirm/regions/reprocess transactions + audit, jobs; Storage-emulator quarantine move;
  Pub/Sub-emulator v3 publish. **Skipped locally** (needs `FIRESTORE_EMULATOR_HOST`, CI only).

Commands (all green, 12.10.2026): `pnpm --filter @kamutan/contracts build test`,
`pnpm --filter @kamutan/api lint typecheck test build` (100 passed, 10 emulator-skipped), `pnpm --filter @kamutan/api openapi`.
`lint` = `tsc --noEmit --noUnusedLocals --noUnusedParameters` (no ESLint in the repo, same convention as web/viewer).

## Known gaps / follow-ups

- Emulator suite has not run yet (blocked here) — first CI run is its real check.
- Needs a **collection-group field override on `projects.projectId`** (DB agent owns `firestore.indexes.json`;
  `members.uid` is already there).
- No package-lock for Cloud Build (`npm install` resolves ranges at deploy time). Recommend CI generating
  `apps/api/package-lock.json` (`npm install --package-lock-only`) or deploying from `pnpm deploy` output (SEC-44).
- Throttling is in-memory per function instance; shared store + per-org quotas (SEC-42) are a follow-up.
- Finalize streams the object through the function (≤100MB, 1GiB memory, 120s timeout).
- **SEC-15 ClamAV is not in the path yet**: the API moves quarantine → uploads after size + magic bytes only. A scan
  step (worker or a dedicated Cloud Run scanner between quarantine and uploads) is still open.
- Signed URLs: one IAM `signBlob` per URL in Functions. Mitigated by the 256 cap, the per-user tier and a per-instance
  cache (URL reused while ≥ 10 of 15 minutes remain). If latency is a problem: a dedicated signing key in Secret
  Manager (local V4 signing) or serving tiles through Hosting/CDN with a signed cookie.
- SEC-20 says 5 minutes for tiles; the Sprint 1 brief says 15 → implemented 15 (`SIGNED_URL_TTL_SECONDS`). Needs an
  owner decision.
- Reprocess switches `currentVersionId` immediately (the UI shows the queued version's progress; tiles of the
  previous version stay readable via its id). Alternative (switch on `ready`) would need a `pendingVersionId` field.
- Sheets list order is by doc id (`p10` < `p2`) across pages; each page is re-sorted. A `sortKey` field written by
  the worker would make cross-page order exact.
- No OpenTelemetry yet (`traceparent` propagated or minted). No member/invite, delete-project or share endpoints yet.
- In Functions the JSON body is parsed by the framework (its own limit), so the 256kb API limit only applies locally.
