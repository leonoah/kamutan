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
  reviewItem: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/reviewItems/${id}`,
  correction: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/corrections/${id}`,
  boqLine: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/boqLines/${id}`,
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
  `^orgs/(${ID})/projects/(${ID})/sheets/(${ID})/versions/(${ID})/(?:tiles/\\d{1,2}/\\d{1,5}_\\d{1,5}\\.webp|thumbnail\\.webp|primitives\\.msgpack\\.gz|text\\.json\\.gz)$`,
);
/** @deprecated Sprint 0 (see storagePaths.upload). */
export const UPLOAD_PATH_RE = new RegExp(`^orgs/(${ID})/uploads/(${ID})/(${ID})$`);
/** @deprecated Sprint 0 (see storagePaths.source). */
export const SOURCE_PATH_RE = new RegExp(`^orgs/(${ID})/projects/(${ID})/sources/([a-f0-9]{64})\\.(pdf|dwg|dxf|png)$`);
