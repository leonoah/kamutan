# firebase/ — Firestore & Storage security rules, indexes, model (Sprint 0 + Sprint 1, ADR 0008)

Replaces the former `supabase/` directory (Postgres + RLS; still in git history on `main`).

## Files

| Path | Purpose |
| --- | --- |
| `firestore.rules` | Firestore rules: membership via `exists(orgs/{orgId}/members/{uid})`, role helpers, default deny, the 3 client-write surfaces |
| `storage.rules` | Storage rules (Sprint 1): the only client capability is **create** in `orgs/{orgId}/quarantine/{uuid}` (editor/admin, lowercase UUID name, ≤100 MB, drawing types). **Nothing is client-readable**; sources, project uploads, sheet-version artifacts and the Sprint-0 `uploads/`+`derived/` prefixes are explicit deny. Cross-service `firestore.exists/get` for membership |
| `firestore.indexes.json` | Composite indexes: reviewItems (level, status, riskScore↓) and (status, riskScore↓); boqLines (chapter, code), (status, chapter, code), (floor, chapter, code); jobs (orgId, createdAt↓), (orgId, projectId, createdAt↓); collection-group field override on `members.uid` |
| `model.ts` | TS doc shapes for every collection (Sprint-1 `Sheet`/`SheetVersion`/`Job` per the brief), `paths` incl. `quarantine`, `projectUpload`, `artifacts`, `tile`; `CLIENT_READABLE_STORAGE_PREFIXES = []`, `INGEST_STAGES`, `JOB_TYPES`, client-writable field lists, BOQ transitions |
| `firebase.rules-test.json` | Emulator config used ONLY by the rules tests (DevOps owns the real `firebase.json`) |
| `tests/` | `@kamutan/firebase-tests` (vitest + `@firebase/rules-unit-testing` 6): `rules.lint.test.ts` (static, always), `firestore.rules.test.ts`, `ingest.rules.test.ts` (Sprint 1), `storage.rules.test.ts` (emulator) |

## Authorization summary

Reads: any member of the org reads everything under `orgs/{orgId}` **except** `shareLinks` (admin/editor) and
`auditLog` (admin). `jobs/{jobId}` is readable by members of `resource.data.orgId` (list queries must filter
`where('orgId','==',X)`). A user can find their own memberships with a collection-group query on `members`
where `uid == auth.uid` (member docs therefore carry a `uid` field equal to the doc id).

Client writes (everything else is `allow write: if false` → API / worker with firebase-admin):

| Path | Who | Rule |
| --- | --- | --- |
| `projects/*/corrections/{id}` | editor, reviewer, admin | create only; `authorId == auth.uid`; `createdAt == request.time`; whitelisted keys; enums for `targetType`/`action`; string sizes (ids ≤128, note ≤2000); `payload` map ≤20 keys; no update/delete |
| `projects/*/reviewItems/{id}` | editor, reviewer, admin | update only; `diff().affectedKeys().hasOnly(['status','resolution','resolvedBy','resolvedAt'])`; resolving/dismissing requires `resolvedBy == uid` and `resolvedAt == request.time`; re-open requires both null; resolution ≤2000 |
| `projects/*/boqLines/{id}` | reviewer, admin | update only, status transitions: draft→reviewed (stamp `reviewedBy/At`), reviewed→approved (stamp `approvedBy == uid`, `approvedAt == request.time`), reviewed→draft and approved→reviewed (clear the stamp). Only `status`, the stamp fields and `note` may change; no skipping draft→approved; approved lines are otherwise immutable |

### Sprint 1 — ingest collections and storage

| Path | Client read | Client write | Tests |
| --- | --- | --- | --- |
| `orgs/*/projects/*/sheets/{sheetId}` | every member role of the org | **none** — confirm / floors / discipline / scale go through `POST .../sheets/:sid/confirm` (API, role check + audit) | `ingest.rules.test.ts` reads (4 roles), cross-org, outsider/anon, writes ×4 roles, collection-group denied |
| `.../sheets/{sheetId}/versions/{versionId}` | every member | **none** (status/progress/artifacts by worker; regions via API `PUT .../regions`) | same |
| `jobs/{jobId}` | members of `resource.data.orgId` (string), list must filter `orgId ==` | **none** | same + `in` / unfiltered / projectId-only lists denied, job without string orgId unreadable |
| Storage `orgs/{orgId}/quarantine/{uuid}` | **none** (not even the uploader) | create only: editor/admin, UUID name, 0 < size ≤ 100 MB, allowed content types, no overwrite/delete | `storage.rules.test.ts` quarantine block |
| Storage `orgs/*/projects/*/sources/**`, `.../uploads/**`, `.../sheets/*/versions/*/**`, `.../derived/**`, `orgs/*/derived/**`, `orgs/*/uploads/**` | **none** | **none** | `storage.rules.test.ts` artifacts block (×4 roles, cross-org, anon) |

**Decision: deny + signed URLs for artifacts.** Tiles / thumbnails / primitives / OCR text are served only via
short-lived V4 signed URLs from the API (`tiles-manifest`). Reasons: one authorization point that also serves
share-link viewers (no Firebase Auth, ADR 0005) and can audit (SEC-20); no per-tile cross-service Firestore read
(an A0 viewport = hundreds of billed rule evaluations); server hop needed anyway for watermark / title-block masking
(SEC-28); a leaked ID token cannot bulk-download an org's drawings. Cost: the API must sign (IAM `signBlob` as
itself — `infra/IAM.md` §3) and the viewer must refresh URLs before expiry.

Ported semantics from the Postgres design: approval stamping and lock-after-approve, append-only audit
(client create/update/delete denied; hash chain is computed server-side), share links hash-only and API-only,
tenant immutability (tenant = path, documents cannot move between orgs), memberships admin-managed (via API).

## Running

```bash
# local (emulator blocked here): static lint suite runs, emulator suites skip cleanly
pnpm --filter @kamutan/firebase-tests test
pnpm --filter @kamutan/firebase-tests typecheck

# CI (Java + network to download the emulator jars)
pnpm --filter @kamutan/firebase-tests test:emulator
#   = firebase emulators:exec --only firestore,storage --project demo-kamutan \
#       --config ../firebase.rules-test.json "vitest run"
```

`firestore.rules.test.ts` skips unless `FIRESTORE_EMULATOR_HOST` is set; `storage.rules.test.ts` additionally needs
`FIREBASE_STORAGE_EMULATOR_HOST` (both set by `emulators:exec`). `rules.lint.test.ts` always runs: rules_version,
balanced braces, default deny, no `if true`, the exact set of client-writable match paths, every `match` under
`orgs` states a write policy, model ↔ rules consistency (collections, client field lists, BOQ transitions),
storage write surface, index coverage.

## Known gaps / not verified

- **Sprint 1 rules have not been compiled either** (same emulator block). New syntax used: `isUuid()` / `opaqueId()`
  with `String.matches`, recursive `{rest=**}` under a nested `match`. The CI `db` job now fails if any of the
  three emulator suites skips (vitest JSON report check), so the first CI run is the real verification.
- Quarantine object name has no uid in it: any editor of the org could race-write another editor's pending UUID.
  UUIDs are unguessable and finalize re-checks the signed upload token (uid + path), so impact is a failed upload.
  If needed: require `request.resource.metadata.uploadedBy == request.auth.uid` (the web must then set it).
- Abandoned quarantine objects are not auto-expired: GCS lifecycle rules match prefixes only from the bucket root,
  and `orgs/{orgId}/quarantine/` has the org in front. Options: a `quarantine/{orgId}/{uuid}` layout (lifecycle
  `matchesPrefix: ["quarantine/"]`, age 1 day) or a scheduled API sweep. SEC-13 asks for 10 min upload TTL.

- **The rules have never been compiled**: there is no offline validator in firebase-tools 13 and the emulator jar
  download (storage.googleapis.com) is blocked here. The first CI run of `test:emulator` is the real syntax and
  behaviour check — expect possible small fixes.
- `jobs` list rule uses `exists(...$(resource.data.orgId)...)`; Firestore must be able to prove it from the query's
  `orgId ==` filter. Covered by a test; if the emulator rejects it, fallback is `jobs` under `orgs/{orgId}/jobs`.
- Rules cannot verify that `approvedBy` differs from `reviewedBy` (four-eyes) — not required now; enforce in the API if wanted.
- Rules cannot validate the upload's real content (magic bytes) — only `contentType`/size; the worker must re-check (SEC-17).
- Storage rules check the member doc on every upload (`firestore.get` counts toward Firestore reads/billing).
- Cannot be expressed in rules (left to API/worker): audit hash chain, share-link 14/90-day expiry, version lock,
  "keep at least one admin", BOQ content edits / `level = min(evidence)`.
- CI: the `db` job runs all three emulator suites via `emulators:exec` and fails if any test is skipped or not passed.
