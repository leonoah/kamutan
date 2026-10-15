# @kamutan/api — notes (Sprint 0 + 1 + 2 + 3, Firebase, ADR 0008)

NestJS 11 (TypeScript strict) Core API. Sprint 0: **login → create project → upload & store a file**. Sprint 1:
**quarantine upload → ingest via Pub/Sub → sheets list / confirm / regions / tiles (signed URLs) / reprocess / job status**.
Sprint 2: **overlay artifacts (legend/detections/rooms + crops, signed) / legend confirmation / unknown-symbol resolution**.
Sprint 3: **item library + past-BOQ import, BOQ templates + rules, BOQ build request, lines + review PATCH, evidence, Excel
export (exceljs, client format)**.
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
| GET | `/projects/:projectId/sheets/:sheetId/versions/:versionId/overlay` | viewer | Sprint 2. `{sheetId, versionId, legend:{url}\|null, detections:{url}\|null, rooms:{url}\|null, thumbs:{le_…\|u_…: url}, stats, expiresAt}` (`OverlayManifest`). Signed like tiles (same signer, cache, TTL); paths derived from ids, never from worker strings. Crop ids come from the legend artifact (`entries[].thumb != null`) and detections artifact (`unknownClusters[].thumb != null`), read server-side (gzip JSON, lenient view, cached per version, ≤ 256 crops, legend rows first). `null` when the version has no such artifact (Sprint-1 versions). 409 `not_ready` unless status `ready`. Tier `TILES_THROTTLE_LIMIT`. |
| GET | `/projects/:projectId/legend-entries?status=&sheetId=&limit=&cursor=` | viewer | Sprint 2. `LegendEntryPage {items: LegendEntry+thumbUrl, nextCursor, expiresAt}`; doc-id order, limit ≤ 200 (100). `thumbUrl` only when the doc's `thumbPath` equals the path derived from org/project/sheet/version/id (legend crop, or the cluster crop of an API-created entry); anything else → null. |
| PATCH | `/projects/:projectId/legend-entries/:entryId` | editor | Sprint 2. `{action:'confirm', class?, itemCode?, label?}` (class defaults to a taxonomy `suggestedClass`, else 400) \| `{action:'reassign', class, itemCode?, label?}` \| `{action:'ignore'}` (strict). `label` (≤ 300, user-edited OCR text) is stored on the entry and used as the mapping label; the audit records only `labelChanged`. Class must be a `benchmark/schema/classes.json` id (`SymbolClassSchema`; "unknown" rejected). Transaction: entry (`status`, `class`, `itemCode`, `confirmedBy/At`, `updatedAt`) + upsert `orgs/{o}/symbolMappings/{signature}` `{class, itemCode, label, confirmedBy, confirmedAt, uses+1}` (not on ignore) + audit `legendEntries/{confirm\|reassign\|ignore}` (ids/classes only, no OCR text). → `{entry, mapping\|null}`. |
| POST | `/projects/:projectId/unknown-clusters/:clusterId/resolve` | editor | Sprint 2. `{sheetId, versionId, class? \| ignore: true (exactly one), itemCode?, createLegendEntry}`. **ignore ("לא רלוונטי")**: mapping `{class: null, itemCode: null, ignored: true, label: "לא רלוונטי"}`, optional entry with status `ignored`, audit `unknownClusters/ignore`, same reprocess (worker skips ignored signatures); response `mapping` nullable in the contract. → reads the cluster (signature, thumb) from the version's `detections.json.gz`; transaction: upsert mapping (label = taxonomy Hebrew name) + optional confirmed entry `le_<sheetId>_<clusterId>` (thumbPath = `unknown/<clusterId>.webp`) + audit `unknownClusters/resolve`; then **reprocess of that sheet through the Sprint-1 path** (`SheetsService.reprocess`: new version + job + audit + publish). `reprocess[]` outcome: `queued` (versionId, jobId) or `skipped` with `not_current` (resolved on an old version) / `in_progress` / `publish_failed` — the mapping is saved either way. 404 unknown cluster/sheet/version, 409 `not_ready` without detections, 409 `conflict` for an invalid signature. Strict rate limit. |
| GET | `/library/items?orgId=&chapter=&active=&q=&cursor=&limit≤500` | viewer | Sprint 3. Org item library (`ItemLibraryItem`), doc-id order, `q` = substring of code/description (in memory, ≤ 5000 items read). |
| POST | `/library/items` | editor of `body.orgId` | Sprint 3. `{orgId, code (TEXT), chapter, chapterTitle?, description, unit, tags?}` → id = `itemIdFor(code, description)`, source `manual`; 409 duplicate; audit `itemLibrary/create`. |
| PATCH | `/library/items/:itemId?orgId=` | editor | Sprint 3. `{unit?, chapterTitle?, tags?, active?}` (code/description = identity, immutable); audit `itemLibrary/update`. |
| POST | `/library/imports` | editor of `body.orgId` | Sprint 3. `{orgId, filename (.xls/.xlsx), sizeBytes ≤ 20MB, projectId?}` → `libraryImports/{uuid}` (`awaiting_upload`, 10 min) + upload slot `orgs/{o}/imports/{uuid}.{xls\|xlsx}` + contentType. Strict rate limit. |
| POST | `/library/imports/:importId/finalize` | editor (uploader only) | Sprint 3. 202. Reads the object (≤ 20MB → else 413), magic bytes must match the declared kind (xls = OLE CFB `D0CF11E0A1B11AE1`; xlsx = ZIP whose central directory lists `[Content_Types].xml` + `xl/workbook.xml`) → else 415 + object deleted + import `rejected`; expired slot 410; missing object 409 `upload_missing`. Then tx: `jobs/{jobId}` (`library.import`) + import `queued` + audit `libraryImports/finalize`, publish `LibraryImportJob` (503 + import `failed` on publish error). Idempotent once queued. Strict rate limit. |
| GET | `/library/imports/:importId?orgId=` | viewer | Sprint 3. `LibraryImportView` = import doc + `job {status, progress, error}`. |
| GET | `/boq-templates?orgId=` | viewer | Sprint 3. Seeds `tpl_default` (structure of the sample BOQ) + default rules when the org has no default template. |
| PATCH | `/boq-templates/:templateId?orgId=` | **admin** | Sprint 3. `{name?, chapters?, columns?, titleRows?, default: true?, vatRate?}`; `default: true` unsets the other default; audit `boqTemplates/update`. |
| GET | `/boq-rules?orgId=` | viewer | Sprint 3. Seeds `DEFAULT_BOQ_RULES` when empty. Sorted by priority desc. |
| PATCH | `/boq-rules/:ruleId?orgId=` | **admin** | Sprint 3. `{enabled?, priority?, itemCode?}`; audit `boqRules/update` with `{field: {from, to}}`; marks **every project of the org** `boq.stale` (`rule`). |
| POST | `/projects/:projectId/boq/build` | editor | Sprint 3. 202 `{build, deduplicated, jobId}`. Seeds org defaults, then tx: returns the pending build while it is queued/running and < 30 min old (`deduplicated: true`, nothing published); else `boqBuilds/{id}` (queued) + `jobs/{jobId}` (`boq.build`, `buildId`) + `project.boq.pendingBuildId` + audit `boqBuilds/request`, publish `BoqBuildJob`. Publish failure → build + job `failed`, pending cleared, 503. Strict rate limit. |
| GET | `/projects/:projectId/boq?cursor=&limit≤500&chapter=&level=&status=` | viewer | Sprint 3. `BoqView {summary {latestBuildId, builtAt, stale, staleReason, build (pending else latest), counts (all lines), floors, blockExportOnRed}, items, nextCursor}`; lines sorted (chapter, natural code "4.9" < "4.10", id); ≤ 5000 lines read. |
| PATCH | `/projects/:projectId/boq/lines/:lineId` | reviewer (+ editor for `qtyOverride`) | Sprint 3. `{status?, qtyOverride? (number + reason \| null), reason?, note?}` (strict). Tx re-reads the line: `BOQ_LINE_TRANSITIONS` (else 409), stamps `reviewedBy/At` / `approvedBy/At` (cleared when moving back), approved lines accept only `status: reviewed` (+ note) → else 409; override stores `qtyOverride{Reason,By,At}`. Audit `boqLines/update` (numbers + `noteChanged`, never the note text). |
| GET | `/projects/:projectId/boq/lines/:lineId/evidence` | viewer | Sprint 3. `{lineId, buildId, items[≤2000] {sheetId, versionId, detectionId, linkGroupId, floor}, bySheet, truncated}` from `boq/{buildId}/evidence.json.gz` (the line's `evidenceRef` only when it is THIS org/project's evidence path, else the line's `buildId` / project's `latestBuildId`). Lenient parse (malformed → []), gzip caps as Sprint 2, parsed `lines` cached per path (4). |
| GET | `/projects/:projectId/boq/evidence?sheetId=&versionId=` | viewer | Sprint 3 (integration). Marker → line lookup for one sheet version from the latest build's evidence: `{sheetId, versionId, buildId, detections {detectionId: lineIds[]}, linkGroups {linkGroupId: lineIds[]}}`. |
| POST | `/projects/:projectId/boq/export` | editor | Sprint 3. `{templateId?, split: summed\|byFloor, markDraft}` → 409 `export_blocked` (`issues: [{path:'red', message:'<n>'}]`) when org `blockExportOnRed` and red lines exist; 409 `not_ready` without lines; else xlsx (see below) → `orgs/{o}/projects/{p}/exports/{uuid}.xlsx` + `exports/{uuid}` record + audit `exports/create`; returns `{exportId, url (V4 signed, **120 s**, attachment + UTF-8 filename), expiresAt, fileName, counts, hasWarnings}`. Own tier `EXPORT_THROTTLE_LIMIT` (10/min/user). |
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
| Sprint 3 library | `orgs/{o}/itemLibrary/{itemId}`, `boqTemplates/{id}`, `boqRules/{id}`, `libraryImports/{uuid}` | API (manual items, seeds, admin edits, imports); worker (`library.import` upserts items / template, import status) |
| Sprint 3 BOQ | `.../projects/{p}/boqLines/{lineId}` (worker computes; API PATCH review fields), `boqBuilds/{id}` (API queued → worker), `exports/{id}` (API), project `boq {latestBuildId, builtAt, stale, pendingBuildId, staleReason, staleAt}` | see contracts `boq.ts`; API sets `pendingBuildId` + `stale=true`; worker sets `latestBuildId/builtAt/stale=false/pendingBuildId=null` |
| Sprint 3 Storage | `orgs/{o}/imports/{uuid}.{xls\|xlsx}` (client create-only), `.../boq/{buildId}/evidence.json.gz` (worker), `.../exports/{id}.xlsx` (API) | `BoqStorage` port: each method pinned to one path regex (`LIBRARY_IMPORT_PATH_RE`, `BOQ_EVIDENCE_PATH_RE`, `BOQ_EXPORT_PATH_RE`) |
| Audit | `orgs/{orgId}/auditLog/{eventId}` `{actorId, actorKind, entity, entityId, action, after, at, prevHash, hash}` | API: org/project create+update, upload, confirm, set_regions, reprocess, Sprint 2: `legendEntries/{confirm,reassign,ignore}`, `unknownClusters/resolve` (per-org SHA-256 chain in the same transaction) |
| LegendEntry (Sprint 2) | `.../projects/{pid}/legendEntries/{entryId}` `{sheetId, versionId, label, labelConfidence, suggestedClass, class, itemCode, signature, thumbPath, status suggested\|confirmed\|ignored, confirmedBy?, confirmedAt?, updatedAt}` | **worker** writes `suggested`; API: decisions + entries created from resolved clusters (`le_<sheetId>_<clusterId>`) |
| SymbolMapping (Sprint 2) | `orgs/{orgId}/symbolMappings/{signature}` `{class\|null, ignored, itemCode, label, confirmedBy, confirmedAt, uses}` | API only (confirm / reassign / resolve, upsert + uses++); worker reads |
| Understanding artifacts (Sprint 2) | Storage `.../versions/{vid}/legend.json.gz`, `detections.json.gz`, `rooms.json.gz`, `legend/{entryId}.webp`, `unknown/{clusterId}.webp` | worker; API signs (overlay, legend list) and reads the two JSON artifacts server-side (`ArtifactReader`: only these three names, ≤ 16 MB gz / 96 MB JSON) |
| Quarantine object | Storage `orgs/{orgId}/quarantine/{uuid}` | client (resumable upload, create-only); read + deleted/moved by API |
| Upload (source) | Storage `orgs/{orgId}/projects/{pid}/uploads/{sheetSetId}/source.{ext}` | API move after checks (`Content-Disposition: attachment`, metadata sha256/uploadedBy/fileId/originalName) |
| Artifacts | Storage `orgs/{orgId}/projects/{pid}/sheets/{sid}/versions/{vid}/` `tiles/{z}/{x}_{y}.webp`, `thumbnail.webp`, `primitives.msgpack.gz`, `text.json.gz` | worker; API only signs read URLs (paths derived from ids, never from the worker-written `prefix`) |

**Polygons are `[{x, y}, ...]`, not `[[x, y], ...]`**: Firestore rejects nested arrays, so the brief's tuple form
cannot be stored. The contract (`RegionSchema.polygonMm`) uses objects everywhere (Firestore, API, web).

## Sprint 3 — BOQ, library, export

- **Code layout**: `src/library/` (LibraryService + Library/Templates/Rules controllers, `spreadsheet-magic.ts`),
  `src/boq/` (BoqService, BoqController, `excel.ts` builder, `boq-storage.ts`), `src/db/boq-*.ts` (BoqRepository port,
  Firestore + in-memory implementations sharing the core store and the audit hash chain, `boq-docs.ts` mappers + the
  pure `planLinePatch` state machine). `BOQ_REPOSITORY` / `BOQ_STORAGE` are global providers.
- **Queue**: `IngestQueue.publish` takes the contracts union `IngestTopicJob` (`ingest.sheet_version` | `boq.build` |
  `library.import`); attributes `type/jobId/orgId/schemaVersion` come from the payload.
- **Stale flag** (`project.boq.stale=true` + `staleReason` + `staleAt`): legend PATCH (`legend`), unknown-cluster resolve
  (`cluster`), sheet confirm (`sheet`), rule PATCH (`rule`, all projects of the org). Best effort (logged, never fails the
  user's request). The worker only clears `stale` when `staleAt` did not move during its build.
- **Defaults**: `POST /orgs` seeds `tpl_default` + `DEFAULT_BOQ_RULES` (create-if-missing, admin edits survive); also
  lazily on GET templates/rules, POST build and export. Same data as `packages/contracts/json-schema/defaults/boq-defaults.json`.
- **Override vs rebuild**: the API never recomputes lines; `qtyOverride`/status/stamps/note are in
  `BOQ_LINE_PRESERVED_FIELDS` (contracts `applyRebuild` = reference semantics the worker follows). Effective quantity
  everywhere (summary, export) = `qtyOverride ?? qty`.
- **Excel** (`src/boq/excel.ts`, exceljs 4.4.0): sheet "כמויות" RTL, frozen under the header; optional warning row (UX
  dialog copy with the red/yellow counts) when any line is non-green; template title rows (`{projectName}`, `{date}`,
  `{orgName}`), optional "טיוטה – כולל פריטים שלא אומתו"; header = template columns + "רמת ביטחון" + "סטטוס" (last =
  far left in RTL); chapters in template order (matched by `chapterKey(line.chapter)`, then by `codePrefixes`; unknown
  chapters appended as "פרק X"; **empty chapters are omitted**), each: title row, "הערות:" + notes, line rows (code =
  string + numFmt `@`, unit price empty, total `=D{r}*E{r}`), "סה"כ" `SUM`; grand totals `SUM(chapter totals)` and
  `*(1+vatRate)`. `byFloor` split = one row per floor ("תאור – קומה"; an overridden line stays one row with a cell note).
  Sheet "פירוט לפי קומה" (floors as columns + SUM + final qty + confidence), sheet "ראיות" (line → sheet title / floor /
  count + reasons). **Every text cell** goes through `sanitizeCell` (leading `= + - @ TAB CR` → `'`, control chars
  dropped) — titles, notes, descriptions, units, codes, floors, sheet titles, reasons, project name.
- Price/total/totals use the sample's currency format `"₪"\ #,##0`; VAT = org `settings.vatRate` (default 0.18) else the
  template's. Worker floor codes (basement/ground/first, -1/0/1…) are shown in Hebrew (`DEFAULT_FLOOR_NAMES`, project
  `floors[].name` wins); "ראיות" adds the detection ids of each (sheet, floor) group.
- **Composite counting**: evidence grouped per (sheet, version, floor) counts one unit per distinct (sheet, version,
  linkGroupId) (floor of its first item) and one per item without a group, so "ראיות" / `bySheet` sum to the line qty.
  `GET …/lines/:id/evidence` adds `linkGroups[{sheetId, versionId, linkGroupId, floor, kind, switchIds, pointIds,
  luminaireIds}]` read from the version's links.json.gz (ArtifactReader now also allows `links.json.gz`); the export's
  "ראיות" column "קבוצות מפסק↔גוף תאורה" lists `lk_N: מפסקים … → נקודות …`.
- **Rule reseed**: `seedDefaults` creates missing default rules and REPLACES docs with `source: 'default'` and
  `defaultsVersion < DEFAULT_BOQ_RULES_VERSION` (now 2); admin PATCH turns a default into `source: 'user'`, which is never
  re-seeded. GET /boq-rules reseeds when any default is missing/outdated.
- Version stats mapper keeps `stats.links` (`LinkStatsSchema`) when well-formed.
- Overlay manifest has `links {url} | null` (version `artifacts.links`, signed like the other artifacts).
- Sample for the Data agent's fidelity check — from Worker-BOQ's REAL local build (dev-index `boqLines` pointer →
  boq-lines.json + evidence): `EXPORT_SAMPLE_PATH=/home/claude/kamutan-data/debug/export_sample.xlsx npx vitest run
  test/unit/export-real-sample.test.ts` (skipped when the data dir is absent). The fixture-based sample
  (`test/fixtures/noah-boq.ts`) is written by excel.test.ts to `EXPORT_FIXTURE_SAMPLE_PATH` / tmp.

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
- `unit/understanding.service.test.ts` (Sprint 2) — services without guards: org B admin → 404 on overlay / list /
  patch / resolve (also with its own project id), viewer read-only, reprocess race → `in_progress`, publish failure →
  `publish_failed` with mapping kept, crop cap (256, legend first), malformed artifact → no crops, artifact reader path
  guard + gzip-bomb cap, signer refuses `llm-cache/` and foreign crop names, tolerant version mapper.
- `e2e/understanding.e2e.test.ts` (Sprint 2) — supertest: overlay (URLs scoped to the org, crop ids, cache, Sprint-1
  version → nulls, 404/409/401, cross-org 404), legend list (status filter, paging, sheet filter, foreign thumbPath never
  signed, other org never listed), PATCH (viewer/reviewer 403, outsider/cross-org 404, taxonomy + strict-body 400,
  confirm → mapping uses 1 + exact brief fields + chained audit without OCR text, reassign → uses 2, ignore → no mapping,
  org memory per org), resolve (role/org/taxonomy/404/409, mapping + confirmed entry + audit + reprocess published,
  listed with cluster crop, not_current).
- `e2e/app.e2e.test.ts`, `e2e/sheets.e2e.test.ts` — supertest on the real AppModule with fake auth, in-memory
  Firestore/Storage/PubSub and `FakeUrlSigner`; contract-shape parsing of every response; tiles per-user 429.
- `integration/firestore.emulator.test.ts` — FirestoreRepository + services on the emulator: org/member/audit,
  collection-group lookups, cross-org rejection, pagination, concurrent ingest dedupe, sheets list via `getAll`,
  regions stored as maps, confirm/regions/reprocess transactions + audit, jobs; Storage-emulator quarantine move;
  Pub/Sub-emulator v3 publish; Sprint 2: legend list (equality filter + doc-id order), confirm/reassign transactions
  with mapping upsert (uses 2, Timestamp, exact fields) + audit. **Skipped locally** (needs `FIRESTORE_EMULATOR_HOST`, CI only).

Sprint 3 tests:
- `unit/excel.test.ts` — workbook read back with exceljs: 3 sheets RTL, warning row (counts), title rows, header incl.
  confidence/status columns, chapter 04 + 08 rows with notes (01..03 omitted), "4.10"/"4.00" are TEXT (`@`), natural
  order, empty price + `D*E` formulas, chapter `SUM` + grand total + VAT formulas, confidence/status Hebrew values,
  per-floor sheet (floor columns + SUM), evidence sheet rows, no warning when all green, markDraft row, byFloor split +
  override note, injection payloads neutralised in every sheet (only our formulas exist).
- `unit/spreadsheet-magic.test.ts` — real xlsx (exceljs), CFB xls, the sample .xls when readable, docx-like zip,
  truncated / corrupt zip, pdf/png/empty.
- `unit/boq-docs.test.ts` — full 3×3 status-transition matrix through `planLinePatch`, stamps set/cleared, approved
  lock, override set/clear + audit without note text, rebuild semantics (`applyRebuild` → effective qty), tolerant mapper.
- `unit/boq-isolation.test.ts` — services without guards: org B admin → 404 on every BOQ / library / template / rule /
  import method of org A (incl. finalize with A's import id), role matrix inside the org.
- `e2e/boq.e2e.test.ts` — build (roles, job + message contract-valid, pendingBuildId, dedupe, stuck > 30 min,
  publish failure 503), GET (order, counts, floors, paging, filters, cross-org), PATCH (roles per field, state machine,
  approved lock, strict body, override audited + preserved across a simulated worker rebuild), evidence (groups,
  malformed, foreign evidenceRef never read), export (403/404, 409 export_blocked, xlsx content + signed 120 s URL +
  record + audit, byFloor, unknown template, no lines 409, per-user 429), stale flag (legend / sheet / rule; other org untouched).
- `e2e/library.e2e.test.ts` — items CRUD + roles + duplicate + filters/paging + cross-org; imports (paths, xlsx/xls
  finalize → job + message + audit, idempotent, only uploader, 415 + delete + rejected for 3 wrong payloads, 409/410/413,
  publish failure); templates (seed once, admin-only PATCH, default switching); rules (seed, admin PATCH + audit
  before/after); org bootstrap seeding.
- `integration/firestore.emulator.test.ts` — + Sprint 3 block (seed idempotent, requestBuild dotted `boq.*` fields +
  dedupe + failBuild, patchLine transaction + audit, markStale, library + import queue + export record). CI only.

Commands (all green, 14.10.2026, Sprint 3): `pnpm turbo run lint typecheck test build --filter=@kamutan/api
--filter=@kamutan/contracts` (api 187 passed, 16 emulator-skipped; contracts 71 passed), `pnpm --filter @kamutan/api openapi`.

Commands (all green, 13.10.2026, Sprint 2): `pnpm turbo run lint typecheck test build --filter=@kamutan/api
--filter=@kamutan/contracts` (api 124 passed, 12 emulator-skipped; contracts 48 passed), `pnpm --filter @kamutan/api openapi`.

Sprint 1 commands (12.10.2026): `pnpm --filter @kamutan/contracts build test`,
`pnpm --filter @kamutan/api lint typecheck test build` (100 passed, 10 emulator-skipped), `pnpm --filter @kamutan/api openapi`.
`lint` = `tsc --noEmit --noUnusedLocals --noUnusedParameters` (no ESLint in the repo, same convention as web/viewer).

## Known gaps / follow-ups

Sprint 3:
- **Emulator suites not run here** (jar download blocked) — the new FirestoreBoqRepository block and the rules suites
  run first in CI. Firestore specifics to watch: dotted `boq.*` updates on projects without a `boq` map, `tx.getAll` +
  query in `seedDefaults`.
- GET /boq and export read **all** lines (≤ 5000) and page in memory; fine for renovation projects, not for towers.
- Library list reads ≤ 5000 items and filters `q` in memory (no search index).
- Export runs synchronously in the request (exceljs, ~50 KB for 30 lines); very large BOQs may need a job.
- Export uses the latest build's evidence for "ראיות"; sheet titles come from the sheets list (≤ 2000 sheets).
- Empty template chapters are not exported (the sample lists all chapters; ours only those with lines) — confirm with
  the owner/Data agent. Chapter header text is the template `title` verbatim.
- **Override decision (integration round)**: an override keeps draft/reviewed status; on an **approved** line it is
  allowed and moves the line back to `reviewed` (approval stamps cleared, re-approval required). The reason chip
  "כמות שונתה ידנית" (`OVERRIDE_REASON`) is stored and also derived on read whenever `qtyOverride` is set (a rebuild
  cannot drop it); clearing the override removes it. A note alone on an approved line is still 409.
- Templates/rules admin PATCH do not require MFA (SEC-02 lists admin actions; MFA enforcement is a cross-cutting follow-up).
- `itemCode` on rules / lines is not validated against the org library (contract format only).
- Import finalize reads up to 20 MB into memory (Cloud Function 1 GiB). No ClamAV on imports either (same gap as SEC-15).
- Rate limits are per instance (in-memory throttler), as before.

Sprint 2:
- Resolve reprocesses **only the sheet the cluster was resolved on** (and only if that version is still current).
  Other sheets whose clusters share the signature get the mapping on their next processing run; a project-wide
  "reprocess affected sheets" would need a signature index (e.g. the worker writing `unknownSignatures[]` on the version
  doc) instead of reading every detections artifact in the request.
- PATCH confirm does not trigger processing (UX "אשר מקרא ← העיבוד מתחיל"); the web calls `POST .../reprocess` per sheet,
  or we add a batch confirm endpoint later. No batch PATCH yet (one request per row).
- PATCH `ignore` on a legend entry is not remembered org-wide (no mapping written; only cluster resolve with `ignore` writes an ignored mapping) and never removes an existing mapping; un-learning a wrong
  mapping needs an admin endpoint (`DELETE /orgs/:o/symbol-mappings/:sig`, audited).
- Overlay reads are not audited (same as tiles-manifest); the mutations are.
- `itemCode` is not checked against the org item library (none in the API yet) — only `ItemCodeSchema` (TEXT).
- Crop-id cache is per instance and keyed by version; artifacts are immutable per version, so no invalidation needed.
- Legend list orders by doc id; with `status` + `sheetId` both set Firestore may ask for a composite index
  (`legendEntries (status, sheetId, __name__)`) — added to `firebase/firestore.indexes.json`.

Sprint 1:

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
