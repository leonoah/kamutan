# @kamutan/contracts — notes (Firebase, ADR 0008)

Zod schemas + inferred TS types shared by web, api and (via JSON Schema) the Python worker. Field names mirror
`firebase/model.ts` (DB agent); **this package is the TS source of truth**. DTO convention: Firestore doc fields +
`id` (+ `orgId`/`projectId` where useful); Firestore `Timestamp`s are ISO-8601 strings in DTOs.

- `roles` — `admin | editor | reviewer | viewer`, `ROLE_RANK`, `roleSatisfies()`.
- `org` — `DocIdSchema`, `UidSchema`, Org (+ `OrgSettings`, `DEFAULT_ORG_SETTINGS`), Member, MyOrg, MeResponse, CreateOrgRequest.
- `project` — Project (+ FloorMeta, stats), Create/UpdateProjectRequest, ListProjectsQuery (`orgId` required), ProjectPage.
- `sheets` — FileKind `pdf|dwg|dxf|png`, SheetSet, Sheet (+ FloorRegion), SheetVersion, status enums.
- `review` — ConfidenceLevel, ReviewItem, Correction, client-writable field list.
- `boq` — BoqLine (`code` is TEXT, `ItemCodeSchema`), status enum + `BOQ_LINE_TRANSITIONS`.
- `share` — ShareLink (tokenHash only), default/max days.
- `firestore` — `fsPaths` (doc paths), `storagePaths` (`upload`, `source`, `derived`), `UPLOAD_PATH_RE`, `SOURCE_PATH_RE`.
- `uploads` — limits (100MB, 10 min), `KIND_TO_CONTENT_TYPE`, CreateUpload / FinalizeUpload request+response.
- `jobs` — `TOPICS.ingest`, `JOB_TYPES`, **`IngestSheetVersionJobSchema`** (Pub/Sub message data, schemaVersion 2:
  `type, jobId, orgId, projectId, sheetSetId, sheetId, versionId, storagePath (sources path), sha256, fileKind,
  traceparent`), Job doc, JobStatus.
- `errors` — `ApiErrorSchema` + codes. `auth` — `IdTokenClaimsSchema` (Firebase ID token claims).

Build: `pnpm --filter @kamutan/contracts build` → `dist/cjs`, `dist/esm`, `dist/types`.
JSON Schema: `pnpm --filter @kamutan/contracts gen` → `json-schema/<Name>.json` + `index.json` (27 schemas) for
`datamodel-code-generator`. Tests: `pnpm --filter @kamutan/contracts test`.

The API does not list this package as an npm dependency (Cloud Functions build); it bundles it — see apps/api/NOTES.md.

Gap: `.refine()` checks (filename extension, storagePath ↔ org/project/sha) are not expressible in JSON Schema; the
Python side must re-check them.
