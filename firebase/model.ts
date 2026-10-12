/**
 * Firestore document shapes — ADR 0008 data model.
 *
 * Collection and field names here are the contract between firestore.rules,
 * the API (firebase-admin) and the web client. Keep them identical to ADR 0008;
 * packages/contracts mirrors these as Zod schemas.
 *
 * Conventions:
 *  - Every tenant document lives under `orgs/{orgId}` (tenant = path; it can never
 *    be "moved" to another org). The only top-level tenant collection is `jobs`,
 *    which carries `orgId` as a field.
 *  - Item codes are TEXT ("4.10" !== "4.1").
 *  - Geometry is NOT stored in Firestore: it lives in Storage artifacts
 *    (`orgs/{orgId}/derived/...`), paper millimetres, y down.
 *  - Timestamps are Firestore `Timestamp`s; typed here as `FsTimestamp` to stay SDK-agnostic.
 */

/** Structural stand-in for firebase/firestore Timestamp and firebase-admin Timestamp. */
export interface FsTimestamp {
  seconds: number;
  nanoseconds: number;
  toDate(): Date;
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
export const ROLES = ['admin', 'editor', 'reviewer', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const CONFIDENCE_LEVELS = ['green', 'yellow', 'red'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const BOQ_LINE_STATUSES = ['draft', 'reviewed', 'approved'] as const;
export type BoqLineStatus = (typeof BOQ_LINE_STATUSES)[number];

/** Allowed client-side status transitions on boqLines (reviewer/admin only). */
export const BOQ_LINE_TRANSITIONS: Readonly<Record<BoqLineStatus, readonly BoqLineStatus[]>> = {
  draft: ['reviewed'],
  reviewed: ['approved', 'draft'],
  approved: ['reviewed'], // un-approve is the only change allowed on an approved line
};

export const REVIEW_ITEM_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type ReviewItemStatus = (typeof REVIEW_ITEM_STATUSES)[number];

export const CORRECTION_TARGET_TYPES = ['detection', 'room', 'link', 'legendEntry', 'reviewItem', 'measurement'] as const;
export type CorrectionTargetType = (typeof CORRECTION_TARGET_TYPES)[number];

export const CORRECTION_ACTIONS = ['accept', 'reject', 'reclass', 'add', 'move', 'remove', 'setSupply', 'setLifecycle'] as const;
export type CorrectionAction = (typeof CORRECTION_ACTIONS)[number];

export const FILE_KINDS = ['pdf', 'dwg', 'dxf', 'png'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const SHEET_SET_STATUSES = ['uploaded', 'splitting', 'ready', 'failed'] as const;
export type SheetSetStatus = (typeof SHEET_SET_STATUSES)[number];

export const SHEET_VERSION_STATUSES = ['uploaded', 'queued', 'processing', 'ready', 'failed'] as const;
export type SheetVersionStatus = (typeof SHEET_VERSION_STATUSES)[number];

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const LIFECYCLES = ['existing', 'new', 'demolish'] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

export const SUPPLY_KINDS = ['contractor', 'client', 'existing'] as const;
export type SupplyKind = (typeof SUPPLY_KINDS)[number];

export const ACTOR_KINDS = ['user', 'system', 'share', 'worker'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/** orgs/{orgId} — server-written. */
export interface Org {
  name: string;
  settings: {
    llmEnabled: boolean;
    blockExportOnRed: boolean;
    greenThreshold: number;
    trainingOptIn?: boolean;
    llmMonthlyBudgetUsd?: number;
  };
  createdAt: FsTimestamp;
}

/** orgs/{orgId}/members/{uid} — server-written (admin via API). Doc id = Firebase Auth uid. */
export interface Member {
  /** == doc id; duplicated so a collection-group query can find "my orgs". */
  uid: string;
  role: Role;
  email?: string;
  displayName?: string;
  addedBy?: string;
  createdAt: FsTimestamp;
}

export interface FloorMeta {
  code: string; // '-1', '0', '1', 'R'
  name: string; // 'קומת קרקע'
  sortOrder: number;
  elevationM?: number;
}

/** orgs/{orgId}/projects/{projectId} — server-written. */
export interface Project {
  name: string;
  address?: string;
  templateId?: string | null;
  floors: FloorMeta[];
  stats?: { sheets: number; reviewOpen: number; boqLines: number; red: number; yellow: number; green: number };
  status: 'active' | 'archived';
  createdBy: string;
  createdAt: FsTimestamp;
}

/** orgs/{orgId}/projects/{projectId}/sheetSets/{setId} — server-written. */
export interface SheetSet {
  fileKind: FileKind;
  sha256: string;
  storagePath: string; // orgs/{orgId}/uploads/{uid}/{fileId}
  status: SheetSetStatus;
  name?: string;
  uploadedBy: string;
  createdAt: FsTimestamp;
}

/** A floor/scale region of a sheet (decision #10). Polygon in paper mm, y down. */
export interface FloorRegion {
  floor: string;
  scale: number; // 50 => 1:50
  polygon: Array<[number, number]>;
  source: 'auto' | 'manual';
}

/** orgs/{orgId}/projects/{projectId}/sheets/{sheetId} — server/worker-written. */
export interface Sheet {
  logicalKey: string;
  discipline: string[];
  floorRegions: FloorRegion[];
  scale: number | null;
  /** Title block WITHOUT PII (no client name / address). */
  titleBlock?: { sheetTitle?: string; sheetNumber?: string; discipline?: string; scaleText?: string };
  currentVersionId: string | null;
  sheetSetId: string;
}

/** .../sheets/{sheetId}/versions/{versionId} — worker-written. */
export interface SheetVersion {
  versionNo: number;
  status: SheetVersionStatus;
  sha256: string;
  pageIndex: number;
  widthMm?: number;
  heightMm?: number;
  /** Storage paths under orgs/{orgId}/derived/... (gzip JSON / tiles manifest). */
  artifacts: { primitives?: string; tiles?: string; detections?: string; rooms?: string };
  stats?: { detections: number; green: number; yellow: number; red: number; rooms: number };
  createdAt: FsTimestamp;
}

/** orgs/{orgId}/projects/{projectId}/legendEntries/{entryId} — worker/server-written. */
export interface LegendEntry {
  sheetId: string;
  label: string;
  templateRef: string | null;
  itemCode: string | null; // TEXT
  rowIndex?: number;
  conf?: number;
}

/** orgs/{orgId}/projects/{projectId}/reviewItems/{itemId} — yellow/red items and clusters. */
export interface ReviewItem {
  level: ConfidenceLevel; // normally yellow/red; green clusters may be queued for spot checks
  reasons: string[];
  clusterId: string | null;
  status: ReviewItemStatus;
  sheetId?: string;
  versionId?: string;
  targetRef?: string; // id inside the detections artifact
  riskScore?: number;
  /** Client-writable (editor/reviewer) together with status: */
  resolution?: string | null;
  resolvedBy?: string | null;
  resolvedAt?: FsTimestamp | null;
}

/** Field names a client may change on a reviewItem. */
export const REVIEW_ITEM_CLIENT_FIELDS = ['status', 'resolution', 'resolvedBy', 'resolvedAt'] as const;

/**
 * orgs/{orgId}/projects/{projectId}/corrections/{correctionId}
 * Client-created by editor/reviewer, immutable afterwards. Overrides automatic
 * output and is never overwritten by a pipeline re-run.
 */
export interface Correction {
  authorId: string; // == request.auth.uid
  createdAt: FsTimestamp; // == request.time
  targetType: CorrectionTargetType;
  targetId: string;
  action: CorrectionAction;
  sheetId?: string;
  versionId?: string;
  payload?: Record<string, unknown>; // e.g. { legendEntryId, point: [x, y] }
  note?: string;
}

/** orgs/{orgId}/projects/{projectId}/boqLines/{lineId} */
export interface BoqLine {
  chapter: string;
  code: string; // TEXT
  description: string;
  qty: number;
  qtyOverride?: number | null;
  unit: string;
  floor?: string | null;
  lifecycle?: Lifecycle;
  supply?: SupplyKind;
  level: ConfidenceLevel; // min level of its evidence (decision #7)
  reasons?: string[];
  evidenceRef?: string | null;
  locked?: boolean;
  status: BoqLineStatus;
  /** Set by the client on draft→reviewed (== auth.uid / request.time). */
  reviewedBy?: string | null;
  reviewedAt?: FsTimestamp | null;
  /** Set by the client on reviewed→approved (== auth.uid / request.time); cleared on un-approve. */
  approvedBy?: string | null;
  approvedAt?: FsTimestamp | null;
  note?: string | null;
}

/** Field names a client may change on a boqLine (status transitions only). */
export const BOQ_LINE_CLIENT_FIELDS = ['status', 'reviewedBy', 'reviewedAt', 'approvedBy', 'approvedAt', 'note'] as const;

/** orgs/{orgId}/projects/{projectId}/shareLinks/{linkId} — API-only; token stored as SHA-256 hex only. */
export interface ShareLink {
  tokenHash: string;
  versionLock: string[]; // sheet version ids
  expiresAt: FsTimestamp; // default 14d, max 90d
  revokedAt: FsTimestamp | null;
  allowPdfDownload: boolean;
  createdBy: string;
  createdAt: FsTimestamp;
}

/** orgs/{orgId}/itemLibrary/{itemId} — server-written. */
export interface ItemLibraryEntry {
  code: string; // TEXT
  chapter: string;
  description: string;
  unit: string;
  tags?: string[];
  sourceFile?: string;
}

/** orgs/{orgId}/boqTemplates/{id} — server-written. */
export interface BoqTemplate {
  name: string;
  chapters: Array<{ code: string; title: string; note?: string }>;
  columns: Array<{ key: string; title: string }>;
  xlsxTemplatePath?: string;
}

/** orgs/{orgId}/symbolMappings/{id} — server-written. */
export interface SymbolMapping {
  keyType: 'template_hash' | 'block_name' | 'pattern';
  key: string;
  itemId: string;
  acceptCount: number;
  rejectCount: number;
  lastUsedAt?: FsTimestamp;
}

/** orgs/{orgId}/auditLog/{eventId} — server-only, append-only, per-org hash chain. */
export interface AuditEvent {
  actorId: string | null;
  actorKind: ActorKind;
  entity: string;
  entityId: string | null;
  action: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  at: FsTimestamp;
  prevHash: string | null;
  hash: string;
}

/** jobs/{jobId} — server/worker-written; readable by members of `orgId`. */
export interface Job {
  orgId: string;
  projectId?: string;
  versionId?: string;
  type: string;
  status: JobStatus;
  progress: number; // 0..100
  stage?: string;
  error?: { code: string; message: string } | null;
  createdAt: FsTimestamp;
  updatedAt?: FsTimestamp;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
export const paths = {
  org: (orgId: string) => `orgs/${orgId}`,
  member: (orgId: string, uid: string) => `orgs/${orgId}/members/${uid}`,
  project: (orgId: string, projectId: string) => `orgs/${orgId}/projects/${projectId}`,
  sheetSet: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/sheetSets/${id}`,
  sheet: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/sheets/${id}`,
  version: (o: string, p: string, s: string, id: string) => `orgs/${o}/projects/${p}/sheets/${s}/versions/${id}`,
  legendEntry: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/legendEntries/${id}`,
  reviewItem: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/reviewItems/${id}`,
  correction: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/corrections/${id}`,
  boqLine: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/boqLines/${id}`,
  shareLink: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/shareLinks/${id}`,
  itemLibrary: (o: string, id: string) => `orgs/${o}/itemLibrary/${id}`,
  boqTemplate: (o: string, id: string) => `orgs/${o}/boqTemplates/${id}`,
  symbolMapping: (o: string, id: string) => `orgs/${o}/symbolMappings/${id}`,
  auditEvent: (o: string, id: string) => `orgs/${o}/auditLog/${id}`,
  job: (id: string) => `jobs/${id}`,
  /** Storage */
  upload: (o: string, uid: string, fileId: string) => `orgs/${o}/uploads/${uid}/${fileId}`,
  derived: (o: string, rest: string) => `orgs/${o}/derived/${rest}`,
} as const;

/** Every collection id used in the model (checked against firestore.rules by the lint test). */
export const COLLECTIONS = [
  'orgs', 'members', 'projects', 'sheetSets', 'sheets', 'versions', 'legendEntries', 'reviewItems',
  'corrections', 'boqLines', 'shareLinks', 'itemLibrary', 'boqTemplates', 'symbolMappings', 'auditLog', 'jobs',
] as const;
export type CollectionId = (typeof COLLECTIONS)[number];
