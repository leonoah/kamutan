/**
 * Firestore / Storage layout (ADR 0008, Sprint 1 brief). Mirrors firebase/model.ts `paths`.
 * Every tenant document lives under orgs/{orgId}; `jobs` is the only top-level
 * tenant collection and carries `orgId` as a field.
 */
export const fsPaths = Object.freeze({
  org: (orgId: string) => `orgs/${orgId}`,
  member: (orgId: string, uid: string) => `orgs/${orgId}/members/${uid}`,
  project: (orgId: string, projectId: string) => `orgs/${orgId}/projects/${projectId}`,
  sheetSet: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/sheetSets/${id}`,
  sheets: (o: string, p: string) => `orgs/${o}/projects/${p}/sheets`,
  sheet: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/sheets/${id}`,
  version: (o: string, p: string, s: string, id: string) => `orgs/${o}/projects/${p}/sheets/${s}/versions/${id}`,
  /** Sprint 2: project-level legend rows (worker writes `suggested`; API confirms/ignores). */
  legendEntries: (o: string, p: string) => `orgs/${o}/projects/${p}/legendEntries`,
  legendEntry: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/legendEntries/${id}`,
  /** Sprint 2: org memory of confirmed symbol → class/itemCode, doc id = symbol signature. API-written only. */
  symbolMapping: (o: string, signature: string) => `orgs/${o}/symbolMappings/${signature}`,
  reviewItem: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/reviewItems/${id}`,
  /** Sprint 4: human corrections (API-only writes). */
  corrections: (o: string, p: string) => `orgs/${o}/projects/${p}/corrections`,
  correction: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/corrections/${id}`,
  correctionBatch: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/correctionBatches/${id}`,
  /** Sprint 4: tiling inputs per room, doc id `{sheetId}__{roomId}` (API-only writes). */
  roomSettings: (o: string, p: string, sheetId: string, roomId: string) => `orgs/${o}/projects/${p}/roomSettings/${sheetId}__${roomId}`,
  /** Sprint 4: find_similar requests/results (API creates, worker fills). */
  similarSearch: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/similarSearches/${id}`,
  boqLines: (o: string, p: string) => `orgs/${o}/projects/${p}/boqLines`,
  boqLine: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/boqLines/${id}`,
  /** Sprint 3: aggregation runs (API creates `queued`; worker runs). */
  boqBuild: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/boqBuilds/${id}`,
  /** Sprint 3: Excel export records (API). */
  boqExport: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/exports/${id}`,
  /** Sprint 3: org item library / templates / rules / past-BOQ imports. */
  itemLibrary: (o: string) => `orgs/${o}/itemLibrary`,
  libraryItem: (o: string, id: string) => `orgs/${o}/itemLibrary/${id}`,
  boqTemplates: (o: string) => `orgs/${o}/boqTemplates`,
  boqTemplate: (o: string, id: string) => `orgs/${o}/boqTemplates/${id}`,
  boqRules: (o: string) => `orgs/${o}/boqRules`,
  boqRule: (o: string, id: string) => `orgs/${o}/boqRules/${id}`,
  libraryImport: (o: string, id: string) => `orgs/${o}/libraryImports/${id}`,
  shareLink: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/shareLinks/${id}`,
  auditEvent: (o: string, id: string) => `orgs/${o}/auditLog/${id}`,
  job: (id: string) => `jobs/${id}`,
});

/** Sheet doc id for page `pageIndex` of a sheet set (the worker creates these when splitting). */
export const sheetIdFor = (sheetSetId: string, pageIndex: number) => `${sheetSetId}-p${pageIndex}`;

/** Cloud Storage object paths (bucket kamutan-fba67.firebasestorage.app). */
export const storagePaths = Object.freeze({
  /**
   * Client upload target (SEC-13): orgs/{orgId}/quarantine/{uuid}. Create-only by editors of the org
   * (storage.rules); the user's filename is never part of the path. Read/delete only by the API.
   */
  quarantine: (orgId: string, fileId: string) => `orgs/${orgId}/quarantine/${fileId}`,
  /**
   * Verified upload, moved here by the API after size + magic-bytes checks:
   * orgs/{orgId}/projects/{projectId}/uploads/{sheetSetId}/source.{ext}. The `{filename}` of the brief is
   * the server-chosen `source.{ext}` (the sanitized original name is metadata only, SEC-13).
   */
  projectUpload: (orgId: string, projectId: string, sheetSetId: string, ext: string) =>
    `orgs/${orgId}/projects/${projectId}/uploads/${sheetSetId}/source.${ext}`,
  /** Worker output directory of one sheet version (trailing slash). */
  versionArtifacts: (o: string, p: string, s: string, v: string) => `orgs/${o}/projects/${p}/sheets/${s}/versions/${v}/`,
  tilesPrefix: (o: string, p: string, s: string, v: string) => `orgs/${o}/projects/${p}/sheets/${s}/versions/${v}/tiles/`,
  tile: (o: string, p: string, s: string, v: string, z: number, x: number, y: number) =>
    `orgs/${o}/projects/${p}/sheets/${s}/versions/${v}/tiles/${z}/${x}_${y}.webp`,
  thumbnail: (o: string, p: string, s: string, v: string) => `orgs/${o}/projects/${p}/sheets/${s}/versions/${v}/thumbnail.webp`,
  primitives: (o: string, p: string, s: string, v: string) => `orgs/${o}/projects/${p}/sheets/${s}/versions/${v}/primitives.msgpack.gz`,
  text: (o: string, p: string, s: string, v: string) => `orgs/${o}/projects/${p}/sheets/${s}/versions/${v}/text.json.gz`,
  /** Sprint 2 understanding artifacts (gzip JSON) and UI crops (≤ 256 px webp). */
  legend: (o: string, p: string, s: string, v: string) => `orgs/${o}/projects/${p}/sheets/${s}/versions/${v}/legend.json.gz`,
  detections: (o: string, p: string, s: string, v: string) => `orgs/${o}/projects/${p}/sheets/${s}/versions/${v}/detections.json.gz`,
  rooms: (o: string, p: string, s: string, v: string) => `orgs/${o}/projects/${p}/sheets/${s}/versions/${v}/rooms.json.gz`,
  legendThumb: (o: string, p: string, s: string, v: string, entryId: string) =>
    `orgs/${o}/projects/${p}/sheets/${s}/versions/${v}/legend/${entryId}.webp`,
  unknownThumb: (o: string, p: string, s: string, v: string, clusterId: string) =>
    `orgs/${o}/projects/${p}/sheets/${s}/versions/${v}/unknown/${clusterId}.webp`,
  /**
   * Per-org LLM gateway cache (SEC-23): orgs/{orgId}/llm-cache/… — worker only. Never client-readable
   * (storage.rules) and never signable by the API (not under a version prefix, see ARTIFACT_PATH_RE).
   */
  llmCachePrefix: (o: string) => `orgs/${o}/llm-cache/`,
  /** Sprint 3: switch↔luminaire link graph of a lighting sheet version (`kamutan.links/1`, worker). */
  links: (o: string, p: string, s: string, v: string) => `orgs/${o}/projects/${p}/sheets/${s}/versions/${v}/links.json.gz`,
  /** Sprint 4: fixtures (`kamutan.fixtures/1`) and reference walls (`kamutan.walls/1`) of a sheet version (worker). */
  fixtures: (o: string, p: string, s: string, v: string) => `orgs/${o}/projects/${p}/sheets/${s}/versions/${v}/fixtures.json.gz`,
  walls: (o: string, p: string, s: string, v: string) => `orgs/${o}/projects/${p}/sheets/${s}/versions/${v}/walls.json.gz`,
  /** Sprint 3: evidence of one BOQ build (`kamutan.boq-evidence/1`, worker; API reads server-side). */
  boqEvidence: (o: string, p: string, buildId: string) => `orgs/${o}/projects/${p}/boq/${buildId}/evidence.json.gz`,
  /** Sprint 3: Excel export (API writes; signed URL only, 2 min). */
  boqExportFile: (o: string, p: string, exportId: string) => `orgs/${o}/projects/${p}/exports/${exportId}.xlsx`,
  /** Sprint 4: find_similar candidate crop (worker; API signs, never client-readable). */
  similarThumb: (o: string, p: string, searchId: string, candidateId: string) => `orgs/${o}/projects/${p}/similar/${searchId}/${candidateId}.webp`,
  /** Sprint 3: past-BOQ upload slot (client create-only; API verifies magic bytes). */
  libraryImport: (o: string, importId: string, ext: 'xls' | 'xlsx') => `orgs/${o}/imports/${importId}.${ext}`,

  /** @deprecated Sprint 0 client upload target (orgs/{orgId}/uploads/{uid}/{fileId}); replaced by `quarantine`. */
  upload: (orgId: string, uid: string, fileId: string) => `orgs/${orgId}/uploads/${uid}/${fileId}`,
  /** @deprecated Sprint 0 content-addressed source path; replaced by `projectUpload`. */
  source: (orgId: string, projectId: string, sha256: string, ext: string) =>
    `orgs/${orgId}/projects/${projectId}/sources/${sha256}.${ext}`,
  /** @deprecated Sprint 0 derived prefix; artifacts now live under `versionArtifacts`. */
  derived: (orgId: string, rest: string) => `orgs/${orgId}/derived/${rest}`,
});

const ID = '[A-Za-z0-9_-]{1,128}';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const QUARANTINE_PATH_RE = new RegExp(`^orgs/(${ID})/quarantine/(${UUID})$`);
export const PROJECT_UPLOAD_PATH_RE = new RegExp(`^orgs/(${ID})/projects/(${ID})/uploads/(${ID})/source\\.(pdf|dwg|dxf|png)$`);
/** Any object under a sheet version's artifact directory (what the API may sign for reading). */
export const ARTIFACT_PATH_RE = new RegExp(
  `^orgs/(${ID})/projects/(${ID})/sheets/(${ID})/versions/(${ID})/(?:tiles/\\d{1,2}/\\d{1,5}_\\d{1,5}\\.webp|thumbnail\\.webp|primitives\\.msgpack\\.gz|text\\.json\\.gz` +
    `|legend\\.json\\.gz|detections\\.json\\.gz|rooms\\.json\\.gz|links\\.json\\.gz|fixtures\\.json\\.gz|walls\\.json\\.gz|legend/le_${ID}\\.webp|unknown/u_${ID}\\.webp)$`,
);
/** Sprint 3: evidence file of a build. */
export const BOQ_EVIDENCE_PATH_RE = new RegExp(`^orgs/(${ID})/projects/(${ID})/boq/(${ID})/evidence\\.json\\.gz$`);
/** Sprint 3: Excel export object. */
export const BOQ_EXPORT_PATH_RE = new RegExp(`^orgs/(${ID})/projects/(${ID})/exports/(${ID})\\.xlsx$`);
/** Sprint 4: find_similar candidate crops. */
export const SIMILAR_THUMB_PATH_RE = new RegExp(`^orgs/(${ID})/projects/(${ID})/similar/(${ID})/(c_[A-Za-z0-9_-]{1,64})\\.webp$`);
/** Sprint 3: past-BOQ upload slot. */
export const LIBRARY_IMPORT_PATH_RE = new RegExp(`^orgs/(${ID})/imports/(${UUID})\\.(xls|xlsx)$`);
/** The three Sprint-2 understanding artifacts (what the API may read server-side). */
export const UNDERSTANDING_ARTIFACT_PATH_RE = new RegExp(
  `^orgs/(${ID})/projects/(${ID})/sheets/(${ID})/versions/(${ID})/(legend|detections|rooms|links|fixtures|walls)\\.json\\.gz$`,
);
/** @deprecated Sprint 0 (see storagePaths.upload). */
export const UPLOAD_PATH_RE = new RegExp(`^orgs/(${ID})/uploads/(${ID})/(${ID})$`);
/** @deprecated Sprint 0 (see storagePaths.source). */
export const SOURCE_PATH_RE = new RegExp(`^orgs/(${ID})/projects/(${ID})/sources/([a-f0-9]{64})\\.(pdf|dwg|dxf|png)$`);
