# @kamutan/api — Sprint 0 notes (Firebase, ADR 0008)

NestJS 10 (TypeScript strict) Core API: **login → create project → upload & store a file**.
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
| POST | `/projects/:projectId/sheet-sets` | editor | `{uploadToken, name?}` → verify + dedupe + docs + publish. Stricter rate limit. |

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

## Firestore / Storage mapping (ADR 0008)

| Data | Path | Written by API |
| --- | --- | --- |
| Org | `orgs/{orgId}` `{name, settings{llmEnabled, blockExportOnRed, greenThreshold, ...}, createdAt}` | create org |
| Member | `orgs/{orgId}/members/{uid}` `{uid, role, email?, addedBy, createdAt}` | create org (admin) |
| Project | `orgs/{orgId}/projects/{projectId}` `{projectId, orgId, name, address?, templateId, floors[], status, createdBy, createdAt}` | create/update |
| SheetSet | `.../projects/{pid}/sheetSets/{sha256}` `{fileKind, sha256, storagePath, status, name, uploadedBy, sizeBytes, ingestJobId, createdAt}` | finalize (doc id = sha256 → atomic per-project dedupe) |
| Sheet | `.../projects/{pid}/sheets/{sheetId}` `{logicalKey: "upload:<sha12>", discipline[], floorRegions[], scale, currentVersionId, sheetSetId}` | finalize (placeholder; the worker splits pages) |
| SheetVersion | `.../sheets/{sheetId}/versions/{versionId}` `{versionNo:1, status: uploaded→queued, sha256, pageIndex:0, artifacts{}, createdAt}` | finalize |
| Job | `jobs/{jobId}` `{orgId, projectId, sheetSetId, sheetId, versionId, type:"ingest.sheet_version", status:"queued", progress:0, createdAt}` | finalize |
| Audit | `orgs/{orgId}/auditLog/{eventId}` `{actorId, actorKind, entity, entityId, action, after, at, prevHash, hash}` | every write above; per-org SHA-256 chain computed in the same transaction |
| Upload object | Storage `orgs/{orgId}/uploads/{uid}/{fileId}` | client (resumable, storage.rules); deleted by API after finalize |
| Source object | Storage `orgs/{orgId}/projects/{pid}/sources/{sha256}.{ext}` | API copy (admin SDK), `Content-Disposition: attachment` |

## Upload flow

1. `POST .../uploads` — checks editor role, extension (pdf/dwg/dxf/png) and declared size; returns
   `storagePath = orgs/{orgId}/uploads/{uid}/{fileId}` (no user filename in the path) + signed upload token
   (org, project, uid, path, sanitized name, kind, exp).
2. Client uploads the bytes with the Firebase JS SDK (`uploadBytesResumable`, contentType from step 1).
3. `POST .../sheet-sets` — token must match project + uid + org; streams the object once via admin Storage:
   sha256, size (> 100MB → 413), first 4KB → magic bytes (`%PDF-n`, PNG + IHDR, DWG `AC10xx`, DXF text/binary) must
   equal the extension's kind (else 415 + upload deleted). Dedupe by sha256 in the project; otherwise copy to
   `sources/{sha256}.{ext}`, then one transaction creates sheetSet/sheet/version/job + audit (re-checks dedupe → race
   safe). Then publish `ingest` (Pub/Sub, payload `IngestSheetVersionJobSchema`, attributes `type, jobId, orgId,
   schemaVersion`), set version `queued`, delete the upload object. If publishing fails → 503, the upload object is
   kept and the version stays `uploaded`; retrying finalize re-publishes with the same `jobId` (worker must be
   idempotent on `jobs/{jobId}`, Pub/Sub is at-least-once).

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
- Cloud Build runs `npm install` on `apps/api/package.json`, which cannot resolve pnpm `workspace:` deps. Therefore
  `@kamutan/contracts` is **not** a package.json dependency: `scripts/build.cjs` compiles with tsc (keeps decorator
  metadata) and then esbuild-bundles `@kamutan/contracts` into `dist/*.js` (all npm packages stay external; the build
  fails if the bundle still requires the workspace package). Types resolve via tsconfig `paths` to
  `packages/contracts/dist/types`; vitest aliases to `packages/contracts/src`; `apps/api/turbo.json` makes
  build/typecheck/test depend on `@kamutan/contracts#build`.
- The build must run before deploy (DevOps: `functions.predeploy` → `pnpm --filter @kamutan/api build`), and
  `functions.ignore` should exclude `src`, `test`, `scripts`, `*.map`, `.env*`, `node_modules`.
- Runtime SA needs: Firestore user, Storage object admin on the bucket, Pub/Sub publisher on `ingest`,
  Firebase Auth (verifyIdToken with checkRevoked reads the user record). Secret `UPLOAD_TOKEN_SECRET` in Secret Manager.

## Tests (`apps/api/test`)

- `unit/guards.test.ts` — FirebaseIdTokenVerifier (mocked firebase-admin: `checkRevoked=true`, error mapping,
  malformed tokens, anonymous rejected, MFA claim), AuthGuard, RolesGuard (403/404/400, project→org, MFA,
  role change effective immediately).
- `unit/access-isolation.test.ts` — **cross-org access rejected at service level** (no guards): read, list, create,
  update, upload, finalize with a foreign token; in-org role checks; malformed ids.
- `unit/uploads.service.test.ts` — full finalize (paths, docs, job, audit chain, Pub/Sub payload + attributes),
  dedupe (same project / not across projects), all 4 kinds, 415 + delete, 409/400, publish failure → retry.
- `unit/magic-bytes.test.ts`, `unit/filename-token.test.ts` — validators, sanitizer, upload token, streaming inspect.
- `unit/function.test.ts` — the exported Cloud Function handler driven through Express (cached boot, pre-parsed body).
- `unit/config-openapi.test.ts` — defaults (kamutan-fba67), production guards, OpenAPI paths under `/api/v1`.
- `e2e/app.e2e.test.ts` — supertest on the real AppModule with fake auth + in-memory Firestore/Storage/PubSub.
- `integration/firestore.emulator.test.ts` — FirestoreRepository + services on the emulator: org/member/audit,
  collection-group lookups, cross-org rejection, pagination, concurrent dedupe (transaction), audit hash-chain
  verification; Storage-emulator finalize; Pub/Sub-emulator publish. **Skipped locally** (no emulator download).

## Known gaps / follow-ups

- Emulator suite has not run yet (blocked here) — first CI run is its real check.
- Needs a **collection-group field override on `projects.projectId`** (DB agent owns `firestore.indexes.json`;
  `members.uid` is already there).
- No package-lock for Cloud Build (`npm install` resolves ranges at deploy time). Recommend CI generating
  `apps/api/package-lock.json` (`npm install --package-lock-only`) or deploying from `pnpm deploy` output (SEC-44).
- Throttling is in-memory per function instance; shared store + per-org quotas (SEC-42) are a follow-up.
- Finalize streams the object through the function (≤100MB, 1GiB memory, 120s timeout). ClamAV scan before the
  source copy (SEC-15) is Sprint 1 (worker side).
- No OpenTelemetry yet (`traceparent` propagated or minted). No member/invite, delete-project or share endpoints yet.
- In Functions the JSON body is parsed by the framework (its own limit), so the 256kb API limit only applies locally.
