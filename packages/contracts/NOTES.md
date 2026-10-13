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
- `boq` — BoqLine (`code` is TEXT, `ItemCodeSchema`), status enum + `BOQ_LINE_TRANSITIONS`.
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
- `errors` — `ApiErrorSchema` + codes (+ `not_ready`). `auth` — `IdTokenClaimsSchema` (Firebase ID token claims).

Build: `pnpm --filter @kamutan/contracts build` → `dist/cjs`, `dist/esm`, `dist/types`.
JSON Schema: `pnpm --filter @kamutan/contracts gen` (= gen:taxonomy + build + export) → `json-schema/<Name>.json` +
`index.json` (56 schemas; Sprint 2 added VersionStage, DetectionStats, SymbolClass, DetectionClass, BBoxMm,
LegendArtifact, DetectionsArtifact, Detection, UnknownCluster, RoomsArtifact, Room, LegendEntry, SymbolMapping,
OverlayManifest, LegendEntryPage, PatchLegendEntryRequest/Response, ResolveUnknownClusterRequest/Response —
workers validate `*.json.gz` output against `DetectionsArtifact.json` etc.; `test/understanding.test.ts` fails when
`json-schema/` is stale; Sprint 1 added SheetClassification, SheetSummary, SheetPage, Region, TilesArtifact,
TilesManifest, ConfirmSheetRequest, PutRegionsRequest/Response, ReprocessSheetResponse) for
`datamodel-code-generator`. Tests: `pnpm --filter @kamutan/contracts test`.

The API does not list this package as an npm dependency (Cloud Functions build); it bundles it — see apps/api/NOTES.md.

Gap: `.refine()`/`.superRefine()` checks (filename extension, storagePath ↔ org/project/sheetSet/fileKind,
sheetId ⇔ pageIndex, duplicate region ids, tiles-query range) are not expressible in JSON Schema; the Python side
must re-check them. Bounds/self-intersection of regions are checked by the API against the page (geometry helpers).
