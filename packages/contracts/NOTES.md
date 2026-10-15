# @kamutan/contracts — notes (Firebase, ADR 0008)

Zod schemas + inferred TS types shared by web, api and (via JSON Schema) the Python worker. Field names mirror
`firebase/model.ts` (DB agent); **this package is the TS source of truth**. DTO convention: Firestore doc fields +
`id` (+ `orgId`/`projectId` where useful); Firestore `Timestamp`s are ISO-8601 strings in DTOs.

- `roles` — `admin | editor | reviewer | viewer`, `ROLE_RANK`, `roleSatisfies()`.
- `org` — `DocIdSchema`, `UidSchema`, Org (+ `OrgSettings`, `DEFAULT_ORG_SETTINGS`), Member, MyOrg, MeResponse, CreateOrgRequest.
- `project` — Project (+ FloorMeta, stats), Create/UpdateProjectRequest, ListProjectsQuery (`orgId` required), ProjectPage.
- `sheets` (Sprint 1, brief shapes) — FileKind; SheetSet (+ `ingestJobId`, `versionId`, `pageCount`; status adds
  `queued`); **Sheet** `{sheetSetId, pageIndex, title, discipline, floors, scaleDenominator, classification, confirmed,
  confirmedBy?, confirmedAt?, currentVersionId, updatedAt}` with `SheetClassification {discipline, floors, sheetTitle,
  scaleText, confidence 0..1, level, reasons}`; **SheetVersion** `{status queued|processing|ready|failed, progress
  {stage ingest|render|ocr|classify|scale|done, pct}, error?, page {widthMm, heightMm, rotation}, artifacts {tiles
  (TilesArtifact: prefix, webp, 256, dpi, levels, widthPx, heightPx), primitives, text, thumbnail}, regions, stats
  {paths, segments, textLines, glyphs}, workerVersion, updatedAt}`; **Region** `{id, floor, polygonMm: [{x,y}],
  scaleDenominator}` (≤ 8 per version, 3..256 points); DTOs SheetSummary/SheetPage/ListSheetsQuery,
  ConfirmSheetRequest, PutRegionsRequest/Response, ReprocessSheetResponse. `DISCIPLINE_CODES` lists the worker's codes;
  `DisciplineSchema` is an open lower-case code. Legacy `FloorRegionSchema` kept (deprecated).
- **Polygons are `{x, y}` objects**, not `[x, y]` tuples as in the brief: Firestore does not allow nested arrays.
- `geometry` — `polygonSelfIntersects`, `polygonSignedArea`, `segmentsIntersect`, `tileLevels(meta)` (level z size =
  ceil(full / 2^(levels-1-z)), cols/rows = ceil(size/256), mmPerPx) and `levelsFor(w, h, 256)` (level 0 fits one tile).
  The worker must cut tiles with exactly this geometry.
- `tiles` — `TilesManifestQuery` (`z` + inclusive `x0,x1,y0,y1`), `TilesManifest` (`tiles`, `levelGrid`,
  `thumbnailUrl`, `urls {"z/x_y": url}`, `expiresAt`, `maxBatch`), `TILES_MAX_BATCH = 256`, `SIGNED_URL_TTL_SECONDS = 900`, `tileKey()`.
- `review` — ConfidenceLevel, ReviewItem, Correction, client-writable field list.
- `boq` — BoqLine (`code` is TEXT, `ItemCodeSchema`), status enum + `BOQ_LINE_TRANSITIONS`. **Sprint 3** (below).
- `share` — ShareLink (tokenHash only), default/max days.
- `firestore` — `fsPaths` (doc paths, + `sheets`), `sheetIdFor(setId, i)` = `${setId}-p${i}`, `storagePaths`
  (`quarantine`, `projectUpload` = `orgs/{o}/projects/{p}/uploads/{setId}/source.{ext}`, `versionArtifacts`,
  `tilesPrefix`, `tile`, `thumbnail`, `primitives`, `text`; deprecated `upload`/`source`/`derived`),
  `QUARANTINE_PATH_RE`, `PROJECT_UPLOAD_PATH_RE`, `ARTIFACT_PATH_RE` (deprecated `UPLOAD_PATH_RE`, `SOURCE_PATH_RE`).
- `uploads` — limits (100MB, 10 min), `KIND_TO_CONTENT_TYPE`, CreateUpload / FinalizeUpload request+response.
  **Breaking (Sprint 1):** `FinalizeUploadResponse` is now `{sheetSet, deduplicated, jobId, versionId}` — sheets are
  created by the worker, so `sheet`/`sheetVersion` are gone. `CreateUploadResponse.storagePath` is the quarantine path.
- `jobs` — `TOPICS.ingest`, `JOB_TYPES`, **`IngestSheetVersionJobSchema` (schemaVersion 3)**: `type, jobId, orgId,
  projectId, sheetSetId, sheetId|null, pageIndex|null, versionId, storagePath (= projectUpload path of
  org/project/sheetSet/fileKind, refined), sha256, fileKind, traceparent`. `sheetId=null, pageIndex=null` → initial
  ingest: split all pages into `sheets/{sheetSetId}-p{i}` each with `versions/{versionId}`; both set → reprocess that
  page into the already-created queued version. v2 kept as `IngestSheetVersionJobV2Schema` (deprecated, not published).
  **Job** doc `{orgId, projectId, sheetSetId, sheetId?, versionId?, type, status, progress {stage, pct}, attempts,
  error?, createdBy?, createdAt?, updatedAt}`.
- **Sprint 2** — `sheets`: `VERSION_STAGES` = ingest, render, ocr, classify, scale, **legend, detect, rooms**, done;
  `VersionArtifacts` + `legend`, `detections`, `rooms` (full object paths); `VersionStats` + optional
  `detections {total, green, yellow, red, unknown, byClass}` (`DetectionStatsSchema`), `rooms`, `legendEntries`.
- `taxonomy` (**generated** by `scripts/gen-taxonomy.cjs` from `benchmark/schema/classes.json`; `pnpm gen:taxonomy`;
  `test/taxonomy.test.ts` fails on drift; the JSON's `"unknown"` id is skipped — it is the reserved detection class, 44 assignable classes now) — `SYMBOL_CLASSES`, `SYMBOL_CLASS_INFO {domain, core, he}`,
  `SymbolClassSchema` (assignable by users, never "unknown"), `DetectionClassSchema` (+ `"unknown"`), `UNKNOWN_CLASS`.
- `understanding` (brief shapes, exact) — artifacts `LegendArtifactSchema` (`kamutan.legend/1`: legends[], entries[]),
  `DetectionsArtifactSchema` (`kamutan.detections/1`: detections[], unknownClusters[]), `RoomsArtifactSchema`
  (`kamutan.rooms/1`); items `Detection`, `UnknownCluster`, `Room`, `LegendBlock`, `LegendArtifactEntry`, `BBoxMm
  {x,y,w,h}`; ids `le_…` / `lg…` / `d_…` / `r_…` / `u_…`; `SymbolSignatureSchema` = doc-id-safe `[A-Za-z0-9_-]{8,128}`
  (it is the `symbolMappings` doc id); crops `legend/{entryId}.webp` / `unknown/{clusterId}.webp` (or null);
  `LEVEL_THRESHOLDS` + `levelForScore()` (green ≥ 0.85 w/o warning, red < 0.5, raster capped at yellow). Firestore:
  `LegendEntrySchema` (status suggested|confirmed|ignored), `SymbolMappingSchema` {signature (= doc id), class|null,
  **ignored**, itemCode, label, confirmedBy, confirmedAt, uses}.
  **Worker-A note — `orgs/{o}/symbolMappings/{signature}`:** `ignored: false` → pre-fill `suggestedClass = class`
  (high confidence, "נלמד ממשרד"); `ignored: true` (class/itemCode null, label "לא רלוונטי") → the user resolved the
  symbol as not relevant: **emit no detections and no unknown cluster for that signature**. A doc without `ignored`
  (written before this change) means `ignored: false`. A later class resolve/confirm flips it back to `ignored: false`. DTOs: `OverlayManifest` (+ `OVERLAY_MAX_THUMBS` 256),
  `ListLegendEntriesQuery`, `LegendEntryItem/Page`, `PatchLegendEntryRequest` (discriminated: confirm|reassign|ignore,
  strict; confirm/reassign take an optional user-edited `label` ≤ 300) / `Response`, `ResolveUnknownClusterRequest`
  (exactly one of `class` / `ignore: true`, no itemCode with ignore — superRefine) / `Response` (`mapping` nullable),
  `ReprocessOutcome`.
  superRefine rules (NOT in JSON Schema — Python must re-check): unique ids; entry.legendId exists; thumb equals
  `legend/{id}.webp` / `unknown/{id}.webp`; every non-green detection/room has ≥ 1 reason; `class == "unknown"` ⇒
  clusterId; clusterId ∈ unknownClusters.
- `firestore` — + `fsPaths.legendEntries/legendEntry/symbolMapping`, `storagePaths.legend/detections/rooms/
  legendThumb/unknownThumb/llmCachePrefix`; `ARTIFACT_PATH_RE` now also matches the three JSON artifacts and the
  `legend/le_*.webp` / `unknown/u_*.webp` crops (never `llm-cache/`); `UNDERSTANDING_ARTIFACT_PATH_RE` (the three JSONs).
- **Sprint 3 — `boq.ts`** (brief shapes): `BoqLine` + `byFloor {floor: qty}`, `evidenceCount`, `ruleId`,
  `sourceVersions [{sheetId, versionId}]`, `computedAt`, `buildId`, `qtyOverrideReason/By/At` (all optional for old docs);
  `effectiveQty` (= qtyOverride ?? qty), `compareItemCodes` (natural: 4.9 < 4.10), `chapterKey` ("04" ≡ "4"),
  `canTransition`, `BOQ_STATUS_HE` / `CONFIDENCE_HE` (export labels), `BOQ_LINE_API_FIELDS` (PATCH-writable),
  **`BOQ_LINE_PRESERVED_FIELDS` + `applyRebuild(existing, computed)`** = what a rebuild must never overwrite (status +
  stamps, note, qtyOverride*, locked). `BOQ_LINE_CLIENT_FIELDS` is deprecated (boqLines are API-only now).
  `BoqBuild {status queued|running|succeeded|failed, jobId, requestedBy, createdAt, startedAt, finishedAt, stats,
  error, evidenceRef}`, `ProjectBoqSummary` (project field `boq`: `latestBuildId, builtAt, stale, pendingBuildId?,
  staleReason?, staleAt?`), `BOQ_BUILD_STUCK_MS` (30 min), artifacts **`BoqEvidenceArtifact` (`kamutan.boq-evidence/1`:
  `{schema, buildId?, lines: {lineId: [{sheetId, versionId, detectionId, linkGroupId|null, floor|null}]}}`)** and
  **`LinksArtifact` (`kamutan.links/1`: `{schema, groups: [{id lk_…, switchIds, pointIds, luminaireIds, kind
  single|two_way|shared|sensor|add_to_existing, confidence, level, reasons}]}`**, unique ids + non-green ⇒ reason in
  superRefine). DTOs: `RequestBoqBuildResponse`, `GetBoqQuery`, `BoqView {summary, items, nextCursor}`, `BoqCounts`,
  `PatchBoqLineRequest` (strict; qtyOverride number ⇒ reason; reason only with qtyOverride), `BoqLineEvidenceResponse`,
  `ExportBoqRequest {templateId?, split summed|byFloor, markDraft}`, `ExportBoqResponse`, `BoqExport` (record),
  `EXPORT_URL_TTL_SECONDS` = 120 (SEC-20).
- **Sprint 3 integration round**: `LinkGroup` + optional `floor`, `fan`, `inferredSwitches`, `arcIds`; `LinksArtifact` +
  optional `points [{id pt_…, luminaireIds, centerMm, lifecycle existing|new}]`, `arcs [{id a_…, polylineMm ≤ 2000,
  ends [id|null, id|null], ambiguous [b,b], inferredSwitch [b,b]}]`, `unlinkedLuminaireIds` (test validates the real
  worker files under /home/claude/kamutan-data/artifacts when present); `VersionArtifacts.links`; `OverlayManifest.links`
  (`{url}|null`, optional for old producers); `OrgSettings.vatRate` (default 0.18); `LibraryImportStats.ambiguousCodes`,
  `templateName`; `BoqSheetEvidenceQuery/Response`; `OVERRIDE_REASON`. Defaults: `r_install_luminaires` now
  excludeSupply [] / excludeLifecycle ['demolish'] (sample 9.01 = 43 = all positions − fans); 7 `r_none_<class>`
  class_to_item rules with `itemCode: null` (waterproof_marker, note_point, breaker, legend_entry, legend_box, region,
  room) = "not counted", configurable by setting an itemCode. 92 JSON schemas.
- **Integration round 2**: `LinkStatsSchema` (strict; `groups` required; green/yellow/red/arcs/danglingEnds/
  inferredSwitches/unlinkedSwitches/unlinkedLuminaires/byKind optional) as `VersionStats.links`; `BoqRule.source` +
  `'user'` and `defaultsVersion`; `DEFAULT_BOQ_RULES_VERSION` (2) + `ruleNeedsReseed()`; seeded docs carry
  `defaultsVersion`; `BoqLineEvidenceResponse.linkGroups?`; `UNDERSTANDING_ARTIFACT_PATH_RE` includes `links.json.gz`.
- **Sprint 3 — `library.ts`**: `ItemLibraryItem {code, chapter, chapterTitle, description, unit, tags, source
  import|manual, sourceRef?, active, updatedAt}`, **`itemIdFor(code, description)` = `it_` + code (non `[A-Za-z0-9_-]`
  → `-`) + `_` + sha256(code + "\n" + normalizeDescription(desc))[:16]** (`normalizeDescription`: NFC, whitespace incl.
  NBSP/LRM/RLM → one space, trim; pure-TS `sha256Hex` in `sha256.ts`, tested against node:crypto; the worker's Python
  copy is byte-identical). `BoqTemplate {name, chapters [{code, title (header text verbatim), notes[], codePrefixes?}],
  columns [{key code|description|unit|qty|unitPrice|total, title, width?}], titleRows ({projectName} {date} {orgName}),
  default, source, vatRate}`, `BoqRule` = discriminated union on `kind` (`class_to_item {classes}`, `composite_lighting
  {groupKind, pointCount?, switchCount?, switchClasses?, pointMergeMm?}`, `install_count {classes, excludeClasses,
  excludeSupply, excludeLifecycle}`, `authority {family, classes, discipline, radiusMm}`) + `itemCode|null`,
  `itemDescription`, `priority`, `enabled`, `reasons?`, `source`. Patch DTOs (template admin, rule `{enabled, priority,
  itemCode}`), `LibraryImport` / `CreateLibraryImportRequest` (xls/xlsx ≤ 20 MB) / `Response` / `Finalize…` / `View`.
  **Defaults**: `DEFAULT_BOQ_TEMPLATE` (`tpl_default`, structure + notes of the sample "כמויות" sheet, 8 chapters,
  codePrefixes 06→7, 07→8, 08→9) and `DEFAULT_BOQ_RULES` (brief domain rules, codes of the sample: sockets 4.00–4.07,
  lighting composites 4.09/4.10/4.11/4.12/4.14/4.15/4.16, feeds, panel 4.24 with a default-rule reason, install 9.01
  excluding ceiling fans + client/existing supply, 5 authority families) — exported as data to
  `json-schema/defaults/boq-defaults.json` by `pnpm gen` (the worker diffs it; `test/boq.test.ts` too).
- **Sprint 3 — `jobs.ts`**: `JOB_TYPES` + `boq.build`, `library.import`; `BoqBuildJobSchema` (v1: `jobId, orgId,
  projectId, buildId, traceparent`), `LibraryImportJobSchema` (v1: `+ projectId|null, importId (uuid), storagePath =
  orgs/{o}/imports/{importId}.{sourceKind}` (refine), `sourceKind xls|xlsx`), **`IngestTopicJobSchema`** = union of all
  three (JSON Schema `IngestTopicJob.json`, anyOf — dispatch on `type`). `JobSchema`: `projectId` nullable,
  `sheetSetId` optional/nullable, `buildId?`, `importId?`. `ingest.sheet_version` unchanged.
- **Sprint 3 — `firestore.ts`**: `fsPaths.boqLines/boqBuild/boqExport/itemLibrary/libraryItem/boqTemplates/boqTemplate/
  boqRules/boqRule/libraryImport`; `storagePaths.links/boqEvidence/boqExportFile/libraryImport`; `BOQ_EVIDENCE_PATH_RE`,
  `BOQ_EXPORT_PATH_RE`, `LIBRARY_IMPORT_PATH_RE`; `ARTIFACT_PATH_RE` also matches `links.json.gz` (exports/evidence are
  never signable as sheet artifacts). `project.ts`: `Project.boq?`. `errors.ts`: + `export_blocked`.
- `errors` — `ApiErrorSchema` + codes (+ `not_ready`, `export_blocked`). `auth` — `IdTokenClaimsSchema` (Firebase ID token claims).

Build: `pnpm --filter @kamutan/contracts build` → `dist/cjs`, `dist/esm`, `dist/types`.
JSON Schema: `pnpm --filter @kamutan/contracts gen` (= gen:taxonomy + build + export) → `json-schema/<Name>.json` +
`index.json` (89 schemas; Sprint 3 added 33: IngestTopicJob, BoqBuildJob, LibraryImportJob, ItemLibraryItem,
LibraryItemPage, Create/PatchLibraryItemRequest, BoqTemplate(+List, Patch…), BoqRule(+List, Patch…), LibraryImport(+View,
Create… Request/Response, Finalize…), BoqBuild, ProjectBoqSummary, RequestBoqBuildResponse, GetBoqQuery, BoqView,
PatchBoqLineRequest/Response, BoqEvidenceItem, BoqEvidenceArtifact, BoqLineEvidenceResponse, LinkGroup, LinksArtifact,
Export Boq Request/Response, BoqExport; plus `defaults/boq-defaults.json`. Sprint 2 had 56; Sprint 2 added VersionStage, DetectionStats, SymbolClass, DetectionClass, BBoxMm,
LegendArtifact, DetectionsArtifact, Detection, UnknownCluster, RoomsArtifact, Room, LegendEntry, SymbolMapping,
OverlayManifest, LegendEntryPage, PatchLegendEntryRequest/Response, ResolveUnknownClusterRequest/Response —
workers validate `*.json.gz` output against `DetectionsArtifact.json` etc.; `test/understanding.test.ts` fails when
`json-schema/` is stale; Sprint 1 added SheetClassification, SheetSummary, SheetPage, Region, TilesArtifact,
TilesManifest, ConfirmSheetRequest, PutRegionsRequest/Response, ReprocessSheetResponse) for
`datamodel-code-generator`. Tests: `pnpm --filter @kamutan/contracts test`.

The API does not list this package as an npm dependency (Cloud Functions build); it bundles it — see apps/api/NOTES.md.

Sprint 3 gaps: refine-only rules not in JSON Schema — LibraryImportJob storagePath ↔ org/importId/kind, LinksArtifact
unique ids + non-green ⇒ reason, PatchBoqLineRequest reason rules, template duplicate chapter / required columns.
`compareItemCodes` puts "4.1" before "4.01" (numeric tie → shorter first).

Gap: `.refine()`/`.superRefine()` checks (filename extension, storagePath ↔ org/project/sheetSet/fileKind,
sheetId ⇔ pageIndex, duplicate region ids, tiles-query range) are not expressible in JSON Schema; the Python side
must re-check them. Bounds/self-intersection of regions are checked by the API against the page (geometry helpers).
