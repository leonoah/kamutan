# firebase/ — Firestore & Storage security rules, indexes, model (Sprint 0, ADR 0008)

Replaces the former `supabase/` directory (Postgres + RLS; still in git history on `main`).

## Files

| Path | Purpose |
| --- | --- |
| `firestore.rules` | Firestore rules: membership via `exists(orgs/{orgId}/members/{uid})`, role helpers, default deny, the 3 client-write surfaces |
| `storage.rules` | Storage rules: `orgs/{orgId}/uploads/{uid}/{fileId}` create-only, `orgs/{orgId}/derived/**` read-only, cross-service `firestore.exists/get` |
| `firestore.indexes.json` | Composite indexes: reviewItems (level, status, riskScore↓) and (status, riskScore↓); boqLines (chapter, code), (status, chapter, code), (floor, chapter, code); jobs (orgId, createdAt↓), (orgId, projectId, createdAt↓); collection-group field override on `members.uid` |
| `model.ts` | TS doc shapes for every collection, names identical to ADR 0008, plus `paths`, `COLLECTIONS`, client-writable field lists and the BOQ transition table |
| `firebase.rules-test.json` | Emulator config used ONLY by the rules tests (DevOps owns the real `firebase.json`) |
| `tests/` | `@kamutan/firebase-tests` (vitest + `@firebase/rules-unit-testing` 6) |

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
- `.github/workflows/ci.yml` still references `@kamutan/db-tests` (removed) — DevOps agent must switch it to
  `@kamutan/firebase-tests` (`test` everywhere, `test:emulator` in the emulator job).
