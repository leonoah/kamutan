# firebase/ — Firestore & Storage security rules, indexes, model (Sprint 0 + 1 + 2 + 3 + 4, ADR 0008)

Replaces the former `supabase/` directory (Postgres + RLS; still in git history on `main`).

## Files

| Path | Purpose |
| --- | --- |
| `firestore.rules` | Firestore rules: membership via `exists(orgs/{orgId}/members/{uid})`, role helpers, default deny, the 3 client-write surfaces |
| `storage.rules` | Storage rules (Sprint 1): the only client capability is **create** in `orgs/{orgId}/quarantine/{uuid}` (editor/admin, lowercase UUID name, ≤100 MB, drawing types). **Nothing is client-readable**; sources, project uploads, sheet-version artifacts and the Sprint-0 `uploads/`+`derived/` prefixes are explicit deny. Cross-service `firestore.exists/get` for membership |
| `firestore.indexes.json` | Composite indexes: reviewItems (level, status, riskScore↓) and (status, riskScore↓); boqLines (chapter, code), (status, chapter, code), (floor, chapter, code); jobs (orgId, createdAt↓), (orgId, projectId, createdAt↓); collection-group field override on `members.uid` |
| `model.ts` | TS doc shapes for every collection (Sprint-1 `Sheet`/`SheetVersion`/`Job` per the brief), `paths` incl. `quarantine`, `projectUpload`, `artifacts`, `tile`; `CLIENT_READABLE_STORAGE_PREFIXES = []`, `INGEST_STAGES`, `JOB_TYPES`, client-writable field lists, BOQ transitions |
| `firebase.rules-test.json` | Emulator config used ONLY by the rules tests (DevOps owns the real `firebase.json`) |
| `tests/` | `@kamutan/firebase-tests` (vitest + `@firebase/rules-unit-testing` 6): `rules.lint.test.ts` (static, always), `firestore.rules.test.ts`, `ingest.rules.test.ts` (Sprint 1), `understanding.rules.test.ts` (Sprint 2), `storage.rules.test.ts` (emulator) |

## Authorization summary

Reads: any member of the org reads everything under `orgs/{orgId}` **except** `shareLinks` (admin/editor) and
`auditLog` (admin). `jobs/{jobId}` is readable by members of `resource.data.orgId` (list queries must filter
`where('orgId','==',X)`). A user can find their own memberships with a collection-group query on `members`
where `uid == auth.uid` (member docs therefore carry a `uid` field equal to the doc id).

Client writes (everything else is `allow write: if false` → API / worker with firebase-admin):

| Path | Who | Rule |
| --- | --- | --- |
| ~~`projects/*/corrections/{id}`~~ | — | **Sprint 4: removed.** Corrections are API-only (`allow write: if false`); see below |
| `projects/*/reviewItems/{id}` | editor, reviewer, admin | update only; `diff().affectedKeys().hasOnly(['status','resolution','resolvedBy','resolvedAt'])`; resolving/dismissing requires `resolvedBy == uid` and `resolvedAt == request.time`; re-open requires both null; resolution ≤2000 |
| ~~`projects/*/boqLines/{id}`~~ | — | **Sprint 3: removed.** boqLines are API-only (`allow write: if false`); see below |

### Sprint 1 — ingest collections and storage

| Path | Client read | Client write | Tests |
| --- | --- | --- | --- |
| `orgs/*/projects/*/sheets/{sheetId}` | every member role of the org | **none** — confirm / floors / discipline / scale go through `POST .../sheets/:sid/confirm` (API, role check + audit) | `ingest.rules.test.ts` reads (4 roles), cross-org, outsider/anon, writes ×4 roles, collection-group denied |
| `.../sheets/{sheetId}/versions/{versionId}` | every member | **none** (status/progress/artifacts by worker; regions via API `PUT .../regions`) | same |
| `jobs/{jobId}` | members of `resource.data.orgId` (string), list must filter `orgId ==` | **none** | same + `in` / unfiltered / projectId-only lists denied, job without string orgId unreadable |
| Storage `orgs/{orgId}/quarantine/{uuid}` | **none** (not even the uploader) | create only: editor/admin, UUID name, 0 < size ≤ 100 MB, allowed content types, no overwrite/delete | `storage.rules.test.ts` quarantine block |
| Storage `orgs/*/projects/*/sources/**`, `.../uploads/**`, `.../sheets/*/versions/*/**`, `.../derived/**`, `orgs/*/derived/**`, `orgs/*/uploads/**` | **none** | **none** | `storage.rules.test.ts` artifacts block (×4 roles, cross-org, anon) |

### Sprint 2 — legend / understanding

| Path | Client read | Client write | Tests |
| --- | --- | --- | --- |
| `orgs/*/projects/*/legendEntries/{entryId}` `{sheetId, versionId, label, labelConfidence, suggestedClass, class, itemCode, signature, thumbPath, status, confirmedBy?, confirmedAt?, updatedAt}` | every member role | **none** — confirm / ignore / reassign = `PATCH /v1/projects/:pid/legend-entries/:id` (editor+, audited); worker writes `suggested` | `understanding.rules.test.ts`: reads ×4 roles (get/list/status query), cross-org, outsider/anon, collection group denied, update/set/create-confirmed/delete ×4 roles |
| `orgs/*/symbolMappings/{signature}` `{class\|null, ignored, itemCode, label, confirmedBy, confirmedAt, uses}` | every member role | **none** — API upsert on confirm / reassign / resolve (no forged "learned" mappings) | same |
| Storage `.../versions/*/legend.json.gz`, `detections.json.gz`, `rooms.json.gz`, `legend/{entryId}.webp`, `unknown/{clusterId}.webp` | **none** (existing `versions/{versionId}/{rest=**}` deny) | **none** | `understanding.rules.test.ts` storage block (×4 roles, cross-org, outsider, anon: download URL, metadata, put, delete) |
| Storage `orgs/{orgId}/llm-cache/**` (LLM gateway cache, SEC-23) | **none** — new explicit deny match | **none** (worker / admin SDK) | same + list denied |

Static (`rules.lint.test.ts`, runs locally): both Firestore matches read = `isMember(orgId)` and every write `false`; no
collection-group match exposes them; `llm-cache/{rest=**}` exists with exactly `read, write: if false`; every Sprint-2
model object path (`paths.legendArtifact/detectionsArtifact/roomsArtifact/legendThumb/unknownThumb/llmCache`) lands in
exactly one deny-all match (versions/** or llm-cache/**); `INGEST_STAGES` = brief order; model `SymbolMapping` /
`LegendEntry` interfaces carry the brief fields (Sprint-0 `keyType/acceptCount` shape removed).
Index: `legendEntries (status, sheetId)` for the API list with both filters.
CI: `understanding.rules.test.ts` is in the "no skipped emulator tests" loop of `.github/workflows/ci.yml`.

### Sprint 3 — BOQ, library, imports, exports

**Decision: boqLines are API-only.** The Sprint-0 rule let reviewers move `status` from the client. Sprint 3 adds
`qtyOverride` (editor+, reason required), per-field roles, the "approved = locked" rule and an audit event on every
status change (SEC-35 / FR-26). Keeping a second write path in rules would duplicate the state machine and skip the
audit hash chain, so the client write was removed: `PATCH /v1/projects/:pid/boq/lines/:id` is the only path
(`BOQ_LINE_TRANSITIONS` enforced in the API transaction). `model.ts` keeps `BOQ_LINE_CLIENT_FIELDS` as deprecated and
adds `BOQ_LINE_API_FIELDS`.

| Path | Client read | Client write | Tests |
| --- | --- | --- | --- |
| `orgs/*/projects/*/boqLines/{lineId}` | every member | **none** (API PATCH; worker computes) | `firestore.rules.test.ts` "API-only" block: every former transition denied for all 4 roles, note / qtyOverride denied, no create/delete; lint: block = read member + write false |
| `orgs/*/projects/*/boqBuilds/{buildId}`, `.../exports/{exportId}` | every member | **none** | Sprint 3 collections block (×4 roles get/set/merge/delete, cross-org, outsider, anon) |
| `orgs/*/boqRules/{ruleId}`, `orgs/*/libraryImports/{importId}` (+ existing `itemLibrary`, `boqTemplates`) | every member | **none** | same + lint |
| project doc `boq` map | every member (project read) | **none** (project is API/worker-written) | "stale flag cannot be forged" |
| Storage `orgs/{orgId}/imports/{uuid}.{xls\|xlsx}` | **none** | **create only**: editor/admin, UUID + `.xls`/`.xlsx` name (`isImportName`, mirrors `LIBRARY_IMPORT_PATH_RE`), 0 < size ≤ 20 MB, content type `application/vnd.ms-excel` / `…spreadsheetml.sheet` / `application/octet-stream`; no overwrite/delete/list | `storage.rules.test.ts` imports block; lint: exactly two client-writable storage matches (quarantine + imports) |
| Storage `.../projects/*/exports/**` (xlsx), `.../projects/*/boq/**` (evidence.json.gz), `.../versions/*/links.json.gz` | **none** (exports: 2-minute signed URL from the API) | **none** | storage `serverObjects` (read/write/delete ×4 roles, cross-org) + lint deny-all coverage |

`JOB_TYPES` = `ingest.sheet_version`, `boq.build`, `library.import`. `COLLECTIONS` + `boqBuilds`, `exports`, `boqRules`,
`libraryImports`. `canApprove()` removed from firestore.rules (no user left).

**Decision: deny + signed URLs for artifacts.** Tiles / thumbnails / primitives / OCR text are served only via
short-lived V4 signed URLs from the API (`tiles-manifest`). Reasons: one authorization point that also serves
share-link viewers (no Firebase Auth, ADR 0005) and can audit (SEC-20); no per-tile cross-service Firestore read
(an A0 viewport = hundreds of billed rule evaluations); server hop needed anyway for watermark / title-block masking
(SEC-28); a leaked ID token cannot bulk-download an org's drawings. Cost: the API must sign (IAM `signBlob` as
itself — `infra/IAM.md` §3) and the viewer must refresh URLs before expiry.

Ported semantics from the Postgres design: approval stamping and lock-after-approve, append-only audit
(client create/update/delete denied; hash chain is computed server-side), share links hash-only and API-only,
tenant immutability (tenant = path, documents cannot move between orgs), memberships admin-managed (via API).

### Sprint 4 — corrections, room settings, find-similar

**Decision: corrections are API-only.** The Sprint-0 rule let editor/reviewer create corrections from the client. The
brief makes them the source of truth of human edits with a role per kind (accept/reject reviewer+, others editor+),
page/version checks, the audit hash chain and a debounced BOQ rebuild — none expressible in rules — so the client
create was removed. The only client write left in Firestore is `reviewItems` (status/resolution).

| Path | Client read | Client write | Tests |
| --- | --- | --- | --- |
| `orgs/*/projects/*/corrections/{id}` (brief shape, undo = `revertedAt`) | every member | **none** (API `POST …/corrections[/batch]`, `…/revert`) | `firestore.rules.test.ts` Sprint 4 block: create (brief + legacy shape) ×4 roles, revert/edit/delete ×3, list own project only, collection group denied; lint |
| `.../correctionBatches/{id}`, `.../roomSettings/{sheetId}__{roomId}`, `.../similarSearches/{id}` | every member | **none** (API; worker fills similar results) | same: get ×4 roles ok, set/merge/delete/create ×4 denied, other org / outsider / anon read denied, forged result denied; lint |
| Storage `.../projects/*/similar/**` (candidate crops) | **none** (API-signed URLs) | **none** | `storage.rules.test.ts` serverObjects; lint: lands in exactly one deny-all match |

`COLLECTIONS` + `correctionBatches`, `roomSettings`, `similarSearches`; `JOB_TYPES` + `symbols.find_similar`;
`model.ts` `Correction` = brief shape (Sprint-0 `CORRECTION_TARGET_TYPES/ACTIONS` replaced by `CORRECTION_KINDS`),
+ `CorrectionBatch`, `RoomSettings`, `SimilarSearch`, `paths.correctionBatch/roomSettings/similarSearch/similarThumb`.
No new composite index: the API queries corrections with one equality filter and sorts in memory.

### Sprint 5 — share links locked down, exports, offboarding, token index

| Path | Client read | Client write |
| --- | --- | --- |
| `.../projects/*/shareLinks/{id}` | **none** (was admin/editor; carries `tokenHash` → API list only) | none |
| `shareTokens/{sha256}`, `offboardingCertificates/{orgId}`, `orgs/*/auditMeta/{doc}`, `.../reprocessRequests/{sheetId}` | none | none |
| `orgs/*/offboardingExports/{id}` | admin | none |
| `.../projects/*/exports/{id}` (xlsx + marked PDF records) | members | none |
| Storage `.../exports/{id}/marked.pdf`, `orgs/*/offboarding/**` | none (API-signed URLs) | none |

`canEditShare()` removed. Indexes: auditLog (entity|action|entityId combos + at↓ + __name__↓), orgs (status,
deleteAfter), reprocessRequests collection group (status, notBefore) / (status, claimedAt). Tests: Sprint 5 block in
`firestore.rules.test.ts`, storage serverObjects + 2 paths, lint for the deny-all matches. Emulator: CI only.

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

- Sprint 4 rules (four new read-only matches, `similar/**` deny, corrections create removed) are statically checked
  here; the emulator suites run first in CI (same blocker as before). Unused rules helper `str()` kept for future use.

- Sprint 3 rules (imports slot with `[.]` in the name regex, the new collections, boqLines lock) are only statically
  checked here; the emulator suites run first in CI (same blocker as Sprints 1–2).
- The imports slot is shared by all editors of an org (UUID names, unguessable; finalize also requires the import doc's
  `createdBy == uid`). Abandoned import objects are not swept (same as quarantine).
- No composite index needed for Sprint 3 queries (equality filters + doc-id order; `boqLines` full-collection read).

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
