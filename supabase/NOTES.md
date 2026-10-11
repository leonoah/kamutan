# supabase/ — DB schema, RLS, tests (Sprint 0)

## What is here

| Path | Purpose |
| --- | --- |
| `migrations/20261011000001_extensions_and_types.sql` | `extensions` + `app` schemas, PostGIS/pgcrypto (in `extensions`), enums, generic helpers, `kamutan_worker` role (NOLOGIN) |
| `migrations/20261011000002_tenancy.sql` | `orgs`, `profiles` (spec name `users`), `memberships`; RLS helpers `app.is_member`, `app.has_role`, `app.my_org_ids`, `app.shares_org_with`; `app.create_org`; "keep at least one admin" trigger |
| `migrations/20261011000003_projects_and_drawings.sql` | `projects`, `project_floors`, `sheet_sets`, `sheets`, `sheet_versions`, `sheet_regions`, `legends`, `legend_entries`, `symbol_templates`, `rooms`, `detections`, `links`, `jobs` |
| `migrations/20261011000004_boq.sql` | `boq_templates`, `item_library`, `symbol_item_mappings`, `boq_lines`, `boq_line_evidence` + approval-rules trigger |
| `migrations/20261011000005_sharing_and_audit.sql` | `share_links` (hash only, version-locked, revoke-only), `audit_log` (append-only, per-org SHA-256 hash chain), `app.write_audit`, automatic audit triggers |
| `migrations/20261011000006_rls_policies.sql` | ENABLE + FORCE RLS on every public table, `org_id` immutability, per-role policies, grants, anon revoked |
| `migrations/20261011000007_worker_role.sql` | `kamutan_worker` grants + org-scoped policies |
| `migrations/20261011000008_storage.sql` | private bucket `drawings`, `storage.objects` policies by `<org_id>/` prefix (skipped when no `storage` schema) |
| `migrations/20261011000009_rls_guard.sql` | `app.rls_coverage_report()` used by CI |
| `migrations/20261011000010_vector_optional.sql` | pgvector + `embedding vector(768)` columns, only if the extension is available |
| `seed.sql` | demo org "משרד הדגמה", project "בית משפחת נח", 3 floors. No users / PII |
| `config.toml` | minimal Supabase CLI config |
| `tests/` | `@kamutan/db-tests` (vitest + PGlite + PostGIS) |
| `tests/sql/rls_guard.sql` | CI guard script — raises if any public table lacks RLS/FORCE RLS/policy/`org_id` or grants anything to `anon` |
| `tests/bootstrap/supabase_stub.sql` | TEST-ONLY stub of Supabase's `auth` (users, `auth.uid()` from GUC `request.jwt.claim.sub` or `request.jwt.claims`), `storage` (buckets, objects, `foldername`) and API roles |

## Conventions

- Every tenant table: `id uuid`, `org_id uuid NOT NULL`, `created_at`, `updated_at`, and `UNIQUE (id, org_id)`.
  Children reference parents with **composite FKs `(parent_id, org_id)`**: FK checks bypass RLS, so this is what
  stops a user from attaching rows in their org to another org's parent by uuid. `org_id` is immutable (trigger).
- Geometry: `extensions.geometry(<type>, 0)`, paper millimetres, origin top-left, **y down**. GiST indexes on
  `detections.geom`, `rooms.geom`, `sheet_regions.polygon`.
- Item codes are `text` (`'4.10'`), quantities `numeric`.
- `sheet_versions.storage_path` must start with `<org_id>/` (check constraint) — same prefix the storage policies use.

## Roles & policies (end users = role `authenticated`)

| | viewer | reviewer | editor | admin |
| --- | --- | --- | --- | --- |
| read org data | ✓ | ✓ | ✓ | ✓ |
| write project/sheets/legends/rooms/items/templates | | | ✓ | ✓ |
| correct detections / links, mappings | | ✓ | ✓ | ✓ |
| BOQ lines: create (draft), edit content | | | ✓ | ✓ |
| BOQ lines: approve / un-approve | | ✓ | | ✓ |
| share links: list / create / revoke | | | ✓ | ✓ |
| memberships, org settings, read audit log | | | | ✓ |

BOQ rules live in trigger `app.boq_lines_guard`: inserts must be `draft`; `approved_by/approved_at` are stamped by
the DB; approved lines are content-locked; reviewers may only change `status`/`note`; only draft lines can be deleted.
Detections, sheets, sheet_versions, links and jobs have no DELETE policy (reject/supersede instead, FR-02).
`anon` has no privileges in `public` — external viewers go through the API (decision #6).

## Worker role

`kamutan_worker` (NOLOGIN, NOBYPASSRLS). Ops creates a login role in it:
`create role kamutan_worker_login login password '…' in role kamutan_worker;` (inherits its privileges;
policies are written `to kamutan_worker`, which also matches members).
At the start of every transaction the worker must run
`select set_config('kamutan.org_id', '<job org_id>', true);` — policies expose only rows of that org.
Grants: `sheet_versions` (SELECT + UPDATE of status/pipeline columns only), `legends`, `legend_entries`,
`symbol_templates`, `detections`, `rooms`, `links` (SELECT/INSERT/UPDATE, no DELETE), `jobs` (SELECT + UPDATE of
progress columns). No access to memberships, share_links, audit_log, orgs, profiles, projects, BOQ tables.

## Running the tests

```bash
# from repo root (once)
flock /tmp/kamutan-pnpm.lock pnpm install
pnpm --filter @kamutan/db-tests test        # vitest run
pnpm --filter @kamutan/db-tests typecheck
```

`src/global-setup.ts` builds one migrated DB and snapshots it (`dumpDataDir`); test files load the snapshot.
`migrations.test.ts` always applies every migration to a brand-new DB. PostGIS loads fine in PGlite via
`@electric-sql/pglite-postgis` — **no compatibility shim was needed**. Runtime ≈ 2–2.5 min on a busy 2-core box
(mostly PostGIS WASM startup).

Against a real Postgres/Supabase (CI with `supabase start`), the guard is:
`psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/sql/rls_guard.sql`.

## Known gaps / follow-ups

- **Not validated against a real Supabase instance** (no Docker/cloud). Things to check on first `supabase db reset`:
  Supabase's `postgres` role must keep BYPASSRLS (it does by default) because of FORCE RLS; Supabase default
  privileges re-grant `anon` on future tables — every new migration must `revoke all … from anon` or the guard fails.
- pgvector is not available in PGlite 0.5.8, so `0010` is exercised only on its "skip" path in tests.
- `share_viewer` JWT role / RLS for external viewers (04_architecture) not implemented — share access is API-only for now.
- MFA (`aal2`) enforcement for admin actions (SEC-02) not in RLS yet.
- Worker org scoping is a guard against mistakes, not against a compromised worker (it can set any `kamutan.org_id`).
  Hardening option: a `SECURITY DEFINER app.claim_job(job_id)` that sets the GUC from the job row.
- Worker has no grants on `boq_lines`/`boq_line_evidence`/`sheet_regions`/storage, per the Sprint 0 scope; the
  project-aggregate stage (BOQ generation) will need either grants or an API call.
- Tables from 04_architecture not yet created: `scale_regions` (superseded by `sheet_regions`), `sheet_alignments`,
  `text_spans`, `glyph_dictionary`, `link_groups`, `conversion_rules`, `review_items`, `pipeline_runs`,
  `calibration_models`, `llm_calls`, `exports`, `ground_truth_annotations`.
- Audit hash chain is computed in a trigger with a per-org advisory lock; the weekly export / external anchoring
  (SEC-35) is not implemented.
