# @kamutan/contracts — notes (Firebase, ADR 0008; through Sprint 4)

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
- **Sprint 4 — `corrections.ts`** (brief shapes, exact field names): `Correction` (`kind` add|remove|reclassify|move|link|
  unlink|measure|count|accept|reject, `sheetId`, `versionId`, `anchorMm`, `radiusMm` (default 3, ≤ 50), `detectionId`,
  `signature`, `class` (taxonomy, never "unknown"), `itemCode`, `linkGroupId`, `switchIds?`, `pointIds?`, `geometry
  {type point|polygon|polyline, mm[]}`, `quantity`, `unit` m2|m|unit, `roomId`, `floor`, `reason`, `batchId`, `by`, `at`,
  `revertedAt`, `revertedBy?`) with per-kind superRefine (add: class|itemCode, no detectionId; remove: detectionId|
  linkGroupId; accept/reject: + roomId; reclassify: detectionId + class|itemCode; move: detectionId + 1 point; link:
  pointIds + switchIds|linkGroupId; unlink: linkGroupId; measure: itemCode + polygon/m2 | polyline/m; count: points,
  quantity = clicks; unit only for measure/count) — **not in JSON Schema, Python must re-check**.
  `CORRECTION_KIND_MIN_ROLE` (accept/reject reviewer, else editor), `CreateCorrectionRequest`,
  `CreateCorrectionBatchRequest` (1..`CORRECTION_BATCH_MAX` 500, `source` cluster|lasso|similar|selection|other,
  `similarSearchId`), `CorrectionBatch` (doc), `RebuildOutcome`, `ListCorrectionsQuery`, `CorrectionPage`, revert
  responses. `RoomSettings` / `PutRoomSettingsRequest` (`claddingHeightM` 0..6, `floorTiled`, material codes,
  `partialCladding [{wallId w_…, fromM < toM, heightM, bottomM?}]`, `wasteFactor` 0..0.5, `includeInWaterproofing`,
  `keepOpenings?`, `type?` override), `defaultRoomSettings(type, wet)` (bathroom/wc 2.6 m + floor + waterproofing;
  courtyard floor; kitchen none — backsplash `KITCHEN_BACKSPLASH_HEIGHT_M` 0.6 via partialCladding), `roomSettingsId`.
  `ReviewQueueItem/Query/Page` (kinds detection|cluster|unknown_cluster|link_group|room|unmatched_correction|line,
  `REVIEW_LEVEL_WEIGHT`, `REVIEW_DEFAULT_SCORE`, `REVIEW_CLUSTER_MIN` 3). Find-similar: `SimilarExemplar`,
  `CreateSimilarSearchRequest`, `SimilarCandidate` (`c_…`, `thumb` = `{id}.webp`|null), `SimilarSearch` (doc),
  `SimilarSearchView` (+ `thumbUrls`).
- **Sprint 4 — other files**: `understanding` Room + optional `type` (`ROOM_TYPES`), `wet`, `walls [{id w_…, aMm, bMm,
  lengthM, exterior}]`, `openings [{id o_…, kind door|window|opening, wallId, widthM, heightM|null, centerMm}]`,
  `externalCorners` (superRefine: unique wall/opening ids, opening.wallId ∈ walls); Detection + optional `signature`.
  `library` rule kinds `plumbing_point {fixtureClasses, with/withoutFaucetClasses, faucetRadiusMm, roomTypes,
  roomNamePatterns, floors, perRoom}`, `tiling_floor {roomTypes?, wetOnly}`, `tiling_cladding {roomTypes?, mode
  full|partial, subtractOpenings, defaultDoor/WindowHeightM}`, `tiling_corner {roomTypes?}`, `waterproofing {roomTypes?,
  wetOnly}`, `one_off_suggestion {always?, classes?, textPatterns?, roomTypes?, floors?, quantity}` (never green,
  `ONE_OFF_SUGGESTION_REASON`), rule `wasteFactor?`; **`DEFAULT_BOQ_RULES_VERSION` 3** (3.01–3.07, 3.11–3.13 points,
  3.08–3.10/3.14/3.15 suggestions, 5.01/5.02/5.03/5.05/5.06/5.07 tiling with 7% waste, `r_auth_fixtures`
  (plumbing sheets win) + `r_auth_ac` (electrical), faucets + floor_tiling/wall_cladding → `r_none_*`). `boq`:
  `BoqLine.orderQty/wasteFactor/manualCount`, evidence item `source auto|manual`, `correctionId`, `quantity`, `roomId`,
  `verified`; evidence artifact `corrections {applied[], unmatched[UnmatchedCorrection]}`; `BoqBuild.trigger/
  debounceUntil/afterBuildId`, `BOQ_REBUILD_DEBOUNCE_MS` 5 000 / `BOQ_REBUILD_MAX_WAIT_MS` 60 000; `STALE_REASONS` +
  correction, room; `bySheet.count` no longer int. `org`: `OrgSettings.autoRebuild` (default true). `jobs`:
  `JOB_TYPES.findSimilar` + `FindSimilarJob` v1 (in `IngestTopicJob`), `Job.searchId`. `firestore`: `fsPaths.
  corrections/correction/correctionBatch/roomSettings/similarSearch`, `storagePaths.similarThumb`,
  `SIMILAR_THUMB_PATH_RE`. Taxonomy regenerated (50 classes: + fixture_shower/bath/kitchen_sink/washing_machine,
  garden_tap, ac_unit). **Breaking**: the Sprint-0 client `Correction` (`targetType/action/payload`) and
  `CORRECTION_TARGET_TYPES/ACTIONS` are gone. 121 JSON schemas.
- **Sprint 4 integration (rules v4, for the Worker integrator to mirror)**: `DEFAULT_BOQ_RULES_VERSION` **4**
  (regenerated `json-schema/defaults/boq-defaults.json`). Per Data's back-solve:
  `r_tile_cladding_wet` match `{roomTypes [bathroom, wc], mode full, subtractOpenings, defaultDoorHeightM 2.1,
  defaultWindowSillM 1.0, defaultWindowHeadM 2.1, capAtCeiling: true, excludeNiches: true}` — H = settings
  claddingHeightM capped at the room's `ceilingHeightM`; doors subtract width × min(2.1 or drawn height, H), windows
  width × (min(head, H) − sill)⁺; niches are not clad. `r_tile_corners` = externalCorners × H (unchanged formula).
  `r_tile_floor_wet` `{roomTypes [bathroom, wc], wetOnly false, includeNiches: true}` (the niche area counts with its
  room). `r_waterproofing_wet` `{roomTypes [bathroom, wc], wetOnly: true, requireFixtureClasses [fixture_shower,
  fixture_bath]}` — default only for rooms with a shower / bath; an explicit room setting wins.
  `defaultRoomSettings(type, wet, {ceilingHeightM, niche, hasShowerOrBath})` implements the same defaults
  (`DEFAULT_CLADDING_HEIGHT_M` 2.6; unknown fixtures → bathroom waterproofed, wc not). Room + optional
  `ceilingHeightM`, `niche`; RoomSettings + optional `ceilingHeightM`.
  **Artifacts**: `VersionArtifacts.fixtures` (`fixtures.json.gz`, `FixturesArtifact` `kamutan.fixtures/1` = Worker-B
  `fixtures_json`: `FixtureRecord` = Detection fields with `id` any ≤ 128 chars + optional `source`, `attachedTo`,
  `label`, `leaderMm`, `sheetId`, `duplicates`, extra keys passthrough) and `VersionArtifacts.walls` (`walls.json.gz`,
  `WallsArtifact` `kamutan.walls/1` = `rooms.reference_walls_json`: `drawings [{floor, scaleDenominator, sheetId,
  regionId, polygonsMm [{exterior, holes}], closuresMm?}]`); `storagePaths.fixtures/walls`; `ARTIFACT_PATH_RE` /
  `UNDERSTANDING_ARTIFACT_PATH_RE` include both; `OverlayManifest.fixtures/walls` (`{url}|null`). Taxonomy domains are
  free strings (`hvac` for `ac_unit` needs no generator change). 124 JSON schemas.
- **Sprint 4 final (rules v5, Worker integrator)**: `DEFAULT_BOQ_RULES_VERSION` **5**. `AuthorityMatchSchema` + optional
  `authorityOrder` (disciplines; per floor the first one with a sheet on that floor is the authority), `matchRooms`
  (secondary copies placed by room-outline alignment and matched one-to-one, same room first; unmatched kept yellow),
  `roomMatchRadiusMm`. `r_auth_ac` = `{discipline 'plumbing', authorityOrder [plumbing, electrical], matchRooms true,
  roomMatchRadiusMm 1600}`: the plumbing sheet's drain marks are the plan of record for 3.01, the electrical AC sockets
  only fill floors without a plumbing sheet. Floor tiling (`r_tile_floor_wet`) stays bathrooms + WCs (+ niches): the
  English courtyard is **out by default** — the sample 5.02 description names it but the quantity (18.1) matches the
  bathrooms + guest WC incl. niches without it (Data's F1 18.109; GT-D-007 open). `defaultRoomSettings` unchanged
  (v4 already: waterproofing only with shower / bath, unknown → bathroom yes, wc no; the worker mirrors it exactly).
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

## Stage 10 fix round (API agent)
All additive (see apps/api/NOTES.md "Stage 10 fix round" for the full list and the consumers): `members.ts` (invites /
members DTOs); library `DEFAULT_ITEM_LIBRARY` (+ version, units, `defaultUnitFor`), generic `DEFAULT_BOQ_TEMPLATE` v2,
`ITEM_SOURCES` + `default`, rule kinds `template_chapter` / `fixture_combination` + default rule
`r_template_demolition`; boq `approvedQty`, `approvalInvalidated`, `byRoom`, build `approvalsInvalidated` /
`approvalsAuditedAt`, evidence `target`, `needsReapproval` / `effectiveStatus` / `exportBlockingLines` /
`qtyChangedReason`, `applyRebuild` demotes changed approvals (not overridden lines); corrections all reviewer; audit
`summary` + `auditSummaryHe`; sheets / uploads supersede fields; share `boqBuildId`; `TEXT_ARTIFACT_PATH_RE`;
`ProjectStats` type. New data file `json-schema/defaults/library-defaults.json`. Tests: `test/stage10.test.ts`.

## Sprint 6 published (API agent) — Worker-Text / Worker-Geometry / Worker-BOQ / Web read this

All additive; `json-schema/` regenerated (**176 schemas, +10**), `defaults/boq-defaults.json` (rules **v6**) and
`defaults/library-defaults.json` (library **v2**, template **v3**) regenerated. Tests: `test/sprint6.test.ts`.

**Artifacts (`takeoff.ts`)** — the shapes Worker-Text / Worker-Geometry published in workers/drawing/NOTES.md, adopted
as-is (lenient: `.passthrough()`, nullable-optional fields; ids unique, non-green ⇒ ≥ 1 reason in superRefine):
- `TextItemsArtifactSchema` **`kamutan.textItems/1`** (`text_items.json.gz`): items `t_{n}`, `kind`
  note|callout|detail_ref|legend_row|panel_schedule|conduit, `text`, `normalized`, `bboxMm`, `anchorMm`, `lineIdx`,
  `floor`, `roomId`, `lifecycle` new|existing|replace|add|demolish, `qty`, `unit`, `lengthM`, `matchedPattern`,
  `itemCode`, `role` item|feed|switch, `pairedWith`, `corroborates`, `suggested`, `confidence`, `scoreRaw`, `level`, `reasons`.
- `GeometryArtifactSchema` **`kamutan.geometry/1`** (`geometry.json.gz`): `stairs` (`st_`), `regions` (`hr_`),
  `wallRuns` (`wr_`), `lines` (`ln_`), `ceilings` (`cl_`), `courtyards` (`cy_`), `measures [{key, unit, qty|null,
  computable, reason, estimate {qty, method}|null, floor, refs, level, reasons}]`, `heights`, `levels`, `stats`.
  `GEOMETRY_MEASURE_KEYS` = the 16 keys Worker-Geometry listed + `demolished_wall_length`, `valance_length` (follow-up); `GEOMETRY_CATEGORIES` = region categories + wall-run
  kinds + line kinds (codes stay open `[a-z][a-z0-9_]*`).
- `storagePaths.textItems / geometry`; `VersionArtifacts.textItems / geometry` (full object paths, set by the
  orchestrator from `textItemsFile` / `geometryFile`); `UNDERSTANDING_ARTIFACT_PATH_RE` includes both (API server-side
  reads); `ARTIFACT_PATH_RE` (signable) includes **geometry only** — drawing text is never served raw;
  `OverlayManifest.geometry {url}|null` (API sets it).
- `normalizeHebrewText(s)` — the normalisation every text match uses (NFC → strip niqqud → maqaf/dashes "-" → final
  letters → regular → geresh variants `'` → gershayim variants and `''` → `"` → lower-case → collapse whitespace incl.
  NBSP/LRM/RLM). Python mirrors it; examples in `test/sprint6.test.ts`. `isPortableRegex` / `TextPatternSchema`: rule
  patterns must compile in JS (`u`) and mean the same in Python `re` (no `(?<name>`, `\k<`, `\p{}`, inline flags,
  atomic/possessive; fixed-width look-behind OK; ≤ 200 chars). Both pattern and text are normalised (finals!), the
  match is case-insensitive.

**Rule kinds (`library.ts`)** — `BOQ_RULE_KINDS` + `text_item`, `area_item`, `length_item`, `suggested_item`
(itemCode non-null for all four):
- `text_item` `match: {patterns[1..16], excludePatterns?, scope: legend|note|callout|panel_schedule|any, disciplines?,
  qty: count|number_in_text|length_in_text_m|one, proximityMm?, nearClasses?, consumeNear?, lifecycle?, floors?,
  matchCatalogCode? (default true: a text item whose catalog itemCode = the rule's code matches too)}`. Evidence kind
  `text` per item, line origin `text`. Worker-Text's `textitems.boq.text_units` may implement it.
- `area_item` / `length_item` `match: {source: hatch|room|wall_run|polyline|stair, keys? (measure keys — preferred),
  categories?, legendPatterns?, disciplines?, floors?, roomTypes?, lifecycle?, measure?: area|length|wall_area|count|
  treads, heightM?, sides? 1|2, minQty?}` (keys / categories / legendPatterns required except stairs). With `keys` the
  quantity is the project-level measure (`geometry_units`); non-computable + estimate → yellow, else `needsInput`.
  Origin `geometry`, evidence kind `geometry` / `stair` with `geometryMm`.
- `suggested_item` `match: {trigger: {kind: sheet_discipline, disciplines} | {kind: text, patterns, scope?,
  disciplines?} | {kind: demolition, categories?} | {kind: always}, estimate?: null | {kind: fixed, quantity} |
  {kind: geometry, match: <area/length match>} | {kind: room_area, roomTypes?, floors?}, reason, quickAction?,
  level?: yellow|red}`. ONE line, origin `suggested`, never green; no estimate → `needsInput: true`, qty 0, red;
  skipped when any other rule produced the code; quick-measure corrections bound to the line REPLACE the estimate.

**Defaults** — `DEFAULT_BOQ_RULES_VERSION` **6** (every `source: 'default'` doc is reseeded) + `SPRINT6_RULES` (38
rules): text rules 4.08 / 4.19 / 4.25 (near `panel`, consume) / 4.26 / 4.27 / 4.28 (near `panel`, consume) / 7.04 /
9.03; geometry rules by measure key 2.01, 2.03, 5.04, 5.06, 5.07, 7.01, 7.02, 7.03, 7.05, 7.06, 7.07, 8.02; and a
`suggested_item` fallback for each of those + 2.02, 5.08 (estimate = `courtyard_waterproofing`), 8.01 (demolition, 1),
8.03 / 8.04 (building sheets, 1). 5.02 / 5.03 unchanged (GT-D-007 / 008). `DEFAULT_ITEM_LIBRARY_VERSION` **2** (+23
generic items 2.01–2.03, 4.08, 4.19, 4.25–4.28, 5.04, 5.08, 7.01–7.07, 8.01–8.04, 9.03; each item's
`defaultsVersion` = the version that introduced it; 7.xx → chapter **06**, 8.xx → **07**, `DEFAULT_ITEM_LIBRARY_ADDITIONS`);
`planDefaultLibrarySeed({empty, hasDefault, existingIds, takenCodes})` (empty → all; org with the default library →
missing ids whose code the org does not have; import-only org → none). `DEFAULT_BOQ_TEMPLATE_VERSION` **3**: chapters
01 / 02 / 03 / 04 / 05 / 06 (codePrefixes 7) / 07 (8) / 09 "תאורה ושונות"; `templateNeedsUpgrade(doc)` = unedited
generic v2 seed (replaced; `default` flag kept).

**BOQ lines (`boq.ts`)** — `origin?: detected|text|geometry|suggested|manual` (absent = detected, `lineOrigin()`),
`needsInput?: boolean` (qty is then 0), `quickAction?: {kind: measure_area|measure_length|count|confirm, sheetId|null}
| null`; `LINE_ORIGIN_HE`, `NEEDS_INPUT_HE` "להשלמה ידנית", `defaultQuickActionFor(unit)`.
Evidence item + `kind?: detection|text|geometry|stair|sheet|room|manual`, `bboxMm?` (text box), `geometryMm?
{type polygon|polyline, mm ≤ 2000}`, `stair? {treads, risers?}`; `target.kind` + geometry|stair.
`BoqBuildStats.coverage? {libraryCodes, produced, suggested, missing[≤500], byChapter?: {chapterKey: {libraryCodes,
produced, suggested, missing}}}` (`BoqCoverageSchema`).

**Corrections** — `Correction.lineId?`, `quickAction?` (only on corrections made by quick-measure); `accept` may be
bound to a line by `lineId` alone. **Worker-BOQ semantics**: active corrections with `lineId` contribute to that line
(`itemCode` = its code) — measure m² / m', count clicks, accept = confirmed `quantity`; on `origin: suggested` /
`needsInput` lines they REPLACE the estimate (sum of the bound items), on computed lines they ADD (Sprint 4 measure
semantics); confirm → verified (`needsInput` false).

**Endpoints** — `QuickMeasureRequest {kind, sheetId, versionId?, geometry?, quantity?, reason?}` (per-kind refine) →
`QuickMeasureResponse {correction, line, rebuild}`. `BatchLineStatusRequest {lineIds (1..500, unique), to:
reviewed|approved, includeRed = false}` → `BatchLineStatusResponse {batchId, updated [{lineId, from, to}], skipped
[{lineId, reason: already|forbidden|red|not_found}]}`; `BATCH_ACTION_HE` "פעולה קבוצתית". Semantics: apps/api/NOTES.md
"Sprint 6".

**Sprint 6 follow-up — rules v7 (Worker-BOQ requests, workers/drawing/NOTES.md "Sprint 6 — rule kinds …")**:
`DEFAULT_BOQ_RULES_VERSION` **7** (every `source: 'default'` rule doc reseeded; `user` docs kept). (1)
`r_suggest_slab_stairs` (2.02) also triggers on `גרם\s*מדרגות`. (2) 8.02 (`r_geo_plaster_walls`,
`r_suggest_plaster_walls`) → "שתי שכבות טיח על קירות חצר אנגלית וקירות בלוק חדשים", 9.03 (`r_text_vent_pipe`) →
"התקנת צינור אוורור 4" למפוח ונטה" — rules AND default library items (new item ids; orgs already holding the old 8.02 /
9.03 default items keep them — the top-up skips taken codes, default-library orgs resolve by exact code). (3)
`CONSUME_NEAR_MAX_MM` = 8: `consumeNear` consumes only a detection within 8 paper mm of the text; `proximityMm` stays
the `nearClasses` filter. (4) Geometry `keys`: `computable: false` → suggested line, `needsInput`, qty 0, red, reasons
= the measure's reason + "הערכה: …" hint (never a yellow quantity); a suggested `{kind: geometry}` estimate uses
computable measures only. **Not changed**: 7.04 (counts explicit service-opening notes: 1 vs BOQ 3) — the proposed
"one per AC gypsum closure" needs a text-count estimator that no estimate kind expresses yet; open for a v8 contract
change. Worker conventions (per-floor sheet authority for text / geometry, catalog fill-in, catalog anchor consumes the
detection, room-settings tiling over geometry) are acknowledged as worker behaviour, not yet contract text.

## Sprint 7 published (API agent) — Web / Worker-BOQ read this

All additive (one default added to `ExportBoqRequest`); `json-schema/` regenerated (**180 schemas, +4**: `BoqDocumentQuery`,
`BoqDocumentModel`, `BoqDocumentRow`, `SheetSetStatusResponse`). Tests: `test/sprint7.test.ts`.

**BOQ preview — `boq-document.ts`** (`GET /v1/projects/:pid/boq/document`, viewer+):
- Query `BoqDocumentQuerySchema` = the export dialog options: `split=none|summed|floor|byFloor` (→ `summed`/`byFloor`),
  `confidence=1|0` (default 1: "רמת ביטחון" + "סטטוס" columns), `chapters=04,05` (chapterKey match, ≤ 64; absent =
  all), `templateId?`, `markDraft=0|1`. POST `…/boq/export` takes the same options: `ExportBoqRequest` + 
  **`includeConfidence` (default true)** + **`chapters?: string[]`**.
- `BoqDocumentModel {schema 'kamutan.boq-document/1', projectId, templateId, buildId, options, titleRows [{kind
  warning|title|draft, text}], columns [{key code|description|unit|qty|unitPrice|total|confidence|status, title,
  width}], chapters [{code, title, notes[], rows[], subtotal}], totals {beforeVat, vat, afterVat, vatRate}, warnings
  [{kind red|reapproval|unapproved|needsInput, count>0}], exportBlocked, counts (BoqCounts of the lines in the
  document), generatedAt}`.
- Row `{kind line|subtotal|note, lineId|null, code|null, description, unit|null, qty|null, qtyFormat? general|decimal2,
  price|null, total|null, level?, status?, floor?, needsInput?, qtyOverridden?, descriptionOverridden?, cellNote?}`.
  Chapter rows in xlsx order: `note` rows ("הערות:" then one per note) → `line` rows (one per line, or per (line, floor)
  with `split=byFloor`; `description` = displayDescription + " – {floor name}") → one `subtotal` row ("סה"כ"). `qty: null`
  = empty cell (needsInput line without override, `cellNote` "להשלמה ידנית"). `price` is null today (no prices in the
  system) → `total` 0, as the xlsx formula `qty × price` evaluates. `level` / `status` only with confidence=1; status =
  `effectiveStatus`. Text is RAW (not formula-escaped) — the xlsx writer escapes, the web renders text.
- `warnings` / `exportBlocked` = the export gate over ALL project lines (`exportBlockingLines`, org `blockExportOnRed`);
  `BOQ_DOCUMENT_WARNING_HE[kind](n)` Hebrew banner text. The `warning` title row (= the xlsx warning row) counts the
  red / yellow lines in the document.
- The API builds this model ONCE (`apps/api/src/boq/boq-document.ts`) and the xlsx main sheet is written from it;
  `apps/api/test/unit/boq-document.test.ts` checks model ↔ xlsx row by row.

**Line rename — `boq.ts`**:
- `BoqLine.descriptionOverride` (≤ 500) + `descriptionOverrideBy`, `descriptionOverrideAt`, `descriptionOverrideReason`
  (all optional/nullable). In `BOQ_LINE_API_FIELDS` and **`BOQ_LINE_PRESERVED_FIELDS`** (Worker-BOQ: never write, keep
  across rebuilds — `applyRebuild` keeps them). `description` stays the original text.
- `displayDescription(line)` (override wins) / `isDescriptionOverridden(line)`; `DESCRIPTION_OVERRIDE_MAX` 500,
  `DESCRIPTION_OVERRIDE_HE` "✎ ידני", `DESCRIPTION_RESTORE_HE` "שחזר לנוסח המקורי", `DESCRIPTION_ALSO_LIBRARY_HE`,
  `normalizeDescriptionInput` (NFC, control chars → space, whitespace collapsed, trimmed).
- `PatchBoqLineRequest` + `description: string (1..500 after normalisation) | null` (null = restore; a text equal to the
  original also clears) and `alsoUpdateLibrary?: boolean` (only with a string description). `reason` is now allowed with
  `qtyOverride` and/or a string `description` (→ `descriptionOverrideReason`). Role: editor+ for `description` /
  `alsoUpdateLibrary` (route stays reviewer+, service re-checks). Works on approved lines (wording only).
- `PatchBoqLineResponse.library? {itemId, created, deactivatedItemIds[]}` when `alsoUpdateLibrary`.
- History: `LINE_HISTORY_ACTIONS` + `'description'` (before / after = the displayed text, reason); audit `boqLines/update`
  carries `description {from, to}` (+ `alsoUpdateLibrary`, `libraryItemId`); `auditSummaryHe` "שם השורה עודכן: «…» → «…»".

**Upload hardening**:
- `errors.ts` + `quota_exceeded` (413) and `file_infected`. `uploads.ts`: `FILE_INFECTED_ERROR`, `QUOTA_EXCEEDED_ERROR`,
  `quotaExceededMessageHe(used, quota, requested)` (the 413 `message` is this Hebrew text; `issues` =
  `usedBytes` / `quotaBytes` / `requestedBytes` as strings), `UPLOAD_ERROR_MESSAGES_HE` (file_infected, quota_exceeded,
  payload_too_large, …).
- `OrgSettings.projectQuotaBytes?` (stored; absent = `DEFAULT_PROJECT_QUOTA_BYTES` = 2 × 1024³), `projectQuotaOf(settings)`;
  `PatchOrgSettingsRequest.projectQuotaBytes` (`PROJECT_QUOTA_MIN_BYTES` 100 MB … `PROJECT_QUOTA_MAX_BYTES` 1 TB; admin +
  MFA + recent sign-in like every settings PATCH).
- `Project.storageBytes?` (API-maintained, absent = 0) and `Project.storageQuotaBytes?` (read-only, from the org).
- **`SheetSet.error? {code, message}|null`** — Worker-BOQ: on an infected file write the set `status: 'failed'`,
  `error: {code: 'file_infected', message: <signature name>}` (+ the job error with the same code). New
  **`GET /v1/projects/:pid/sheet-sets/:setId`** (viewer+) → `SheetSetStatusResponse {sheetSet, job {id, status,
  progress}|null, error {code, message, messageHe}|null, infected}` (error = set error, else job error); `GET /jobs/:id`
  passes `error.code` through unchanged. The API releases an infected set's bytes from `storageBytes` (idempotent,
  on that read / the project read).

**Sprint 7 follow-up (Worker-BOQ requests)**: `storagePaths.infected(o, p, setId, sha256)` =
`orgs/{o}/projects/{p}/infected/{setId}/{sha256}.bin`, `storagePaths.infectedImport(o, importId, sha256)` =
`orgs/{o}/infected/imports/{importId}/{sha256}.bin`, `INFECTED_PATH_RE` (not matched by `ARTIFACT_PATH_RE`: never
signed). `SCAN_UNAVAILABLE_ERROR` (`scan_unavailable`, retryable) + its Hebrew text in `UPLOAD_ERROR_MESSAGES_HE`.
**Decision: infected bytes are EXCLUDED from `storageBytes`** — the API releases a set's bytes as soon as it reads
`error.code == 'file_infected'` (the user cannot use or delete that file); they stay in `infected/` until the org purge
(`orgs/{o}/` prefix) or a future project delete (prefix `orgs/{o}/projects/{p}/`). Tests: `test/sprint7.test.ts`.
