# @kamutan/contracts — Sprint 0 notes

Zod schemas + inferred TS types shared by web, api and (via JSON Schema) the Python workers.

- `roles` — `admin | editor | reviewer | viewer`, `ROLE_RANK`, `roleSatisfies()`.
- `org` — Org, OrgSettings, Membership, MyOrg, MeResponse, CreateOrgRequest.
- `project` — Project, Create/UpdateProjectRequest, ListProjectsQuery, ProjectPage (cursor pagination).
- `sheets` — FileKind (`pdf|dwg|dxf|png`; DB stores png as `image` → `DB_FILE_KIND`, `fileKindFromDb`), SheetSet,
  SheetVersion (+ status enum matching `public.sheet_version_status`), PipelineState.
- `uploads` — limits (`MAX_UPLOAD_BYTES` 100MB, `UPLOAD_TTL_SECONDS` 600), StoragePath (`{orgId}/upload/{uuid}`),
  CreateUpload request/response, FinalizeUpload request/response.
- `jobs` — queue names, `JOB_TYPES.ingestSheetVersion = 'ingest.sheet_version'`, `IngestSheetVersionJobSchema`
  (`schemaVersion, sheetVersionId, orgId, projectId, storagePath, sha256, fileKind, traceparent`; storagePath must be
  inside the org prefix), JobStatus (matches `public.job_status`).
- `errors` — `ApiErrorSchema` (`{error: {code, message, requestId, issues?}}`) and the error code enum.
- `auth` — AccessTokenClaims (Supabase JWT claims the API relies on).

Build: `pnpm --filter @kamutan/contracts build` → `dist/cjs` (require), `dist/esm` (import), `dist/types`.
JSON Schema: `pnpm --filter @kamutan/contracts gen` → `json-schema/<Name>.json` + `index.json` (draft-07,
inlined refs) for `datamodel-code-generator` → `py-packages/kamutan_contracts`. Registry: `src/registry.ts`.
Tests: `pnpm --filter @kamutan/contracts test`.

Gap: some refinements (filename extension check, storagePath-in-org-prefix) are `.refine()` and do not appear in the
JSON Schema; Python must re-check them (the worker validates ids against the DB anyway).
