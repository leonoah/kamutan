/**
 * Firestore / Storage layout (ADR 0008). Mirrors firebase/model.ts `paths`.
 * Every tenant document lives under orgs/{orgId}; `jobs` is the only top-level
 * tenant collection and carries `orgId` as a field.
 */
export const fsPaths = Object.freeze({
  org: (orgId: string) => `orgs/${orgId}`,
  member: (orgId: string, uid: string) => `orgs/${orgId}/members/${uid}`,
  project: (orgId: string, projectId: string) => `orgs/${orgId}/projects/${projectId}`,
  sheetSet: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/sheetSets/${id}`,
  sheet: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/sheets/${id}`,
  version: (o: string, p: string, s: string, id: string) => `orgs/${o}/projects/${p}/sheets/${s}/versions/${id}`,
  reviewItem: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/reviewItems/${id}`,
  correction: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/corrections/${id}`,
  boqLine: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/boqLines/${id}`,
  shareLink: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/shareLinks/${id}`,
  auditEvent: (o: string, id: string) => `orgs/${o}/auditLog/${id}`,
  job: (id: string) => `jobs/${id}`,
});

/** Cloud Storage object paths (bucket kamutan-fba67.firebasestorage.app). */
export const storagePaths = Object.freeze({
  /** Client upload target (storage.rules: create-only by the uid, editor/admin). */
  upload: (orgId: string, uid: string, fileId: string) => `orgs/${orgId}/uploads/${uid}/${fileId}`,
  /** Verified, deduplicated source written by the API (admin SDK only). */
  source: (orgId: string, projectId: string, sha256: string, ext: string) =>
    `orgs/${orgId}/projects/${projectId}/sources/${sha256}.${ext}`,
  derived: (orgId: string, rest: string) => `orgs/${orgId}/derived/${rest}`,
});

const ID = '[A-Za-z0-9_-]{1,128}';
export const UPLOAD_PATH_RE = new RegExp(`^orgs/(${ID})/uploads/(${ID})/(${ID})$`);
export const SOURCE_PATH_RE = new RegExp(`^orgs/(${ID})/projects/(${ID})/sources/([a-f0-9]{64})\\.(pdf|dwg|dxf|png)$`);
