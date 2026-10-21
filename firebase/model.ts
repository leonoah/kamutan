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
 *    (`orgs/{orgId}/projects/{p}/sheets/{s}/versions/{v}/...`), paper millimetres, y down,
 *    served to browsers only through short-lived signed URLs.
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

/**
 * Allowed boqLine status transitions. Sprint 3: enforced by the API (`PATCH /v1/projects/:pid/boq/lines/:id`,
 * reviewer+, audited) — boqLines are NOT client-writable anymore (firestore.rules: write false).
 */
export const BOQ_LINE_TRANSITIONS: Readonly<Record<BoqLineStatus, readonly BoqLineStatus[]>> = {
  draft: ['reviewed'],
  reviewed: ['approved', 'draft'],
  approved: ['reviewed'], // un-approve is the only change allowed on an approved line
};

export const REVIEW_ITEM_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type ReviewItemStatus = (typeof REVIEW_ITEM_STATUSES)[number];

/** Sprint 4 (brief): correction kinds — mirrors packages/contracts CORRECTION_KINDS. */
export const CORRECTION_KINDS = ['add', 'remove', 'reclassify', 'move', 'link', 'unlink', 'measure', 'count', 'accept', 'reject'] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];

export const FILE_KINDS = ['pdf', 'dwg', 'dxf', 'png'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const SHEET_SET_STATUSES = ['uploaded', 'splitting', 'ready', 'failed'] as const;
export type SheetSetStatus = (typeof SHEET_SET_STATUSES)[number];

export const SHEET_VERSION_STATUSES = ['uploaded', 'queued', 'processing', 'ready', 'failed'] as const;
export type SheetVersionStatus = (typeof SHEET_VERSION_STATUSES)[number];

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const JOB_TYPES = ['ingest.sheet_version', 'boq.build', 'library.import', 'symbols.find_similar', 'export.marked_pdf', 'offboarding.export'] as const;
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
    /** Sprint 3: VAT of the export grand total (default 0.18). */
    vatRate?: number;
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
  /** Sprint 3: worker writes latestBuildId/builtAt/stale=false; API writes pendingBuildId and stale=true (+reason). */
  boq?: {
    latestBuildId: string | null;
    builtAt: FsTimestamp | null;
    stale: boolean;
    pendingBuildId?: string | null;
    staleReason?: string | null;
    staleAt?: FsTimestamp | null;
  };
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

/** Version processing stages in order (Sprint 2 added legend, detect, rooms). Mirrors contracts VERSION_STAGES. */
export const INGEST_STAGES = ['ingest', 'render', 'ocr', 'classify', 'scale', 'legend', 'detect', 'rooms', 'done'] as const;
export type IngestStage = (typeof INGEST_STAGES)[number];

/** Sheet classification produced by the worker (Sprint 1 brief). */
export interface SheetClassification {
  discipline: string | null;
  floors: string[];
  sheetTitle: string | null;
  scaleText: string | null;
  confidence: number; // 0..1
  level: ConfidenceLevel;
  reasons: string[];
}

/**
 * orgs/{orgId}/projects/{projectId}/sheets/{sheetId} — worker-written; confirm/regions via the API.
 * Sprint 1: one sheet per page of a sheetSet, sheetId = `${sheetSetId}-p${pageIndex}`.
 * NO client write (firestore.rules) — confirming a sheet is `POST .../sheets/:sid/confirm`.
 */
export interface Sheet {
  sheetSetId: string;
  pageIndex?: number;
  title?: string | null;
  discipline: string | string[] | null; // Sprint 0 stored string[]; Sprint 1 a single discipline
  floors?: string[];
  scaleDenominator?: number | null;
  classification?: SheetClassification;
  confirmed?: boolean;
  confirmedBy?: string | null;
  confirmedAt?: FsTimestamp | null;
  currentVersionId: string | null;
  updatedAt?: FsTimestamp;
  /** Sprint 0 placeholder fields. */
  logicalKey?: string;
  floorRegions?: FloorRegion[];
  scale?: number | null;
  /** Title block WITHOUT PII (no client name / address). */
  titleBlock?: { sheetTitle?: string; sheetNumber?: string; discipline?: string; scaleText?: string };
}

/** Tiles pyramid of a sheet version (z = 0 fits one 256 px tile). */
export interface TilesArtifact {
  prefix: string; // orgs/{o}/projects/{p}/sheets/{s}/versions/{v}/tiles
  format: 'webp';
  tileSize: 256;
  dpi: number;
  levels: number;
  widthPx: number;
  heightPx: number;
}

/** .../sheets/{sheetId}/versions/{versionId} — worker-written (regions also by the API). */
export interface SheetVersion {
  status: SheetVersionStatus;
  progress?: { stage: IngestStage; pct: number };
  error?: { code: string; message: string } | null;
  page?: { widthMm: number; heightMm: number; rotation: number };
  /** Storage object paths. NOT client-readable via storage.rules — use the API's signed URLs. */
  artifacts: {
    tiles?: TilesArtifact | string;
    primitives?: string;
    text?: string;
    thumbnail?: string;
    /** Sprint 2 — full object paths: legend.json.gz / detections.json.gz / rooms.json.gz */
    legend?: string;
    detections?: string;
    rooms?: string;
  };
  // Points are {x, y} objects (packages/contracts PointMmSchema): Firestore rejects nested arrays.
  regions?: Array<{ id: string; floor: string; polygonMm: Array<{ x: number; y: number }>; scaleDenominator: number }>;
  stats?: {
    paths?: number;
    segments?: number;
    textLines?: number;
    glyphs?: number;
    /** Sprint 2 */
    detections?: { total: number; green: number; yellow: number; red: number; unknown: number; byClass: Record<string, number> };
    rooms?: number;
    legendEntries?: number;
  };
  workerVersion?: string;
  updatedAt?: FsTimestamp;
  /** Sprint 0 fields. */
  versionNo?: number;
  sha256?: string;
  pageIndex?: number;
  createdAt?: FsTimestamp;
}

export const LEGEND_ENTRY_STATUSES = ['suggested', 'confirmed', 'ignored'] as const;
export type LegendEntryStatus = (typeof LEGEND_ENTRY_STATUSES)[number];

/**
 * orgs/{orgId}/projects/{projectId}/legendEntries/{entryId} — Sprint 2 brief. Worker writes `suggested`
 * (never overwrites a confirmed/ignored entry with the same signature); the API confirms / ignores / reassigns.
 * NO client write (firestore.rules).
 */
export interface LegendEntry {
  sheetId: string;
  versionId: string;
  label: string;
  labelConfidence: number;
  suggestedClass: string | null; // benchmark/schema/classes.json id or 'unknown'
  class: string | null; // null until confirmed
  itemCode: string | null; // TEXT
  signature: string; // stable hash of the normalised symbol strokes
  thumbPath: string | null; // Storage object, NOT client-readable
  status: LegendEntryStatus;
  confirmedBy?: string | null;
  confirmedAt?: FsTimestamp | null;
  updatedAt: FsTimestamp;
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
 * orgs/{orgId}/projects/{projectId}/corrections/{correctionId} — Sprint 4: written ONLY by the API
 * (POST /v1/projects/:pid/corrections[/batch], role per kind, audited). Immutable except revertedAt/revertedBy (undo).
 * Applied by `boq.build` after automatic detection; re-matched to newer versions by anchorMm within radiusMm.
 */
export interface Correction {
  kind: CorrectionKind;
  sheetId: string;
  versionId: string; // at time of edit
  anchorMm: { x: number; y: number };
  radiusMm: number;
  detectionId: string | null;
  signature: string | null;
  class: string | null;
  itemCode: string | null;
  linkGroupId: string | null;
  switchIds?: string[];
  pointIds?: string[];
  geometry: { type: 'point' | 'polygon' | 'polyline'; mm: Array<{ x: number; y: number }> } | null;
  quantity: number | null;
  unit: 'm2' | 'm' | 'unit' | null;
  roomId: string | null;
  floor: string | null;
  reason: string | null;
  batchId: string | null;
  by: string;
  at: FsTimestamp;
  revertedAt: FsTimestamp | null;
  revertedBy?: string | null;
}

/** orgs/{orgId}/projects/{projectId}/correctionBatches/{batchId} — API only (one per batch POST). */
export interface CorrectionBatch {
  count: number;
  kinds: Partial<Record<CorrectionKind, number>>;
  sheetIds: string[];
  source: 'cluster' | 'lasso' | 'similar' | 'selection' | 'other';
  similarSearchId: string | null;
  by: string;
  at: FsTimestamp;
  revertedAt: FsTimestamp | null;
  revertedBy?: string | null;
}

/** orgs/{orgId}/projects/{projectId}/roomSettings/{sheetId}__{roomId} — tiling inputs, API only (editor+). */
export interface RoomSettings {
  sheetId: string;
  roomId: string;
  claddingHeightM: number;
  floorTiled: boolean;
  floorMaterialItemCode: string | null;
  wallMaterialItemCode: string | null;
  partialCladding: Array<{ wallId: string; fromM: number; toM: number; heightM: number; bottomM?: number }>;
  wasteFactor: number;
  includeInWaterproofing: boolean;
  keepOpenings?: string[];
  type?: string | null;
  by: string;
  at: FsTimestamp;
}

/** orgs/{orgId}/projects/{projectId}/similarSearches/{searchId} — API creates (queued); worker fills. */
export interface SimilarSearch {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  exemplar: { sheetId: string; versionId: string; bboxMm: { x: number; y: number; w: number; h: number }; class: string | null };
  scope: 'sheet' | 'project';
  correctionId: string | null;
  jobId: string | null;
  requestedBy: string;
  createdAt: FsTimestamp;
  finishedAt: FsTimestamp | null;
  candidates: Array<{ id: string; sheetId: string; versionId: string; centerMm: { x: number; y: number }; bboxMm: { x: number; y: number; w: number; h: number }; score: number; alreadyDetected: string | null; currentClass: string | null; thumb: string | null }>;
  thumbs: number;
  error: { code: string; message: string } | null;
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
  // --- Sprint 3 ---
  /** API (PATCH, editor+, reason required). Effective qty = qtyOverride ?? qty. Never overwritten by a rebuild. */
  qtyOverrideReason?: string | null;
  qtyOverrideBy?: string | null;
  qtyOverrideAt?: FsTimestamp | null;
  /** Worker (boq.build). */
  byFloor?: Record<string, number>;
  evidenceCount?: number;
  ruleId?: string | null;
  sourceVersions?: Array<{ sheetId: string; versionId: string }>;
  computedAt?: FsTimestamp | null;
  buildId?: string | null;
}

/**
 * @deprecated Sprint 3: boqLines are not client-writable (firestore.rules `allow write: if false`); these fields are
 * changed by the API PATCH only. Kept for compatibility.
 */
export const BOQ_LINE_CLIENT_FIELDS = ['status', 'reviewedBy', 'reviewedAt', 'approvedBy', 'approvedAt', 'note'] as const;
/** Sprint 3: fields the API PATCH may change (role-checked + audited). Mirrors packages/contracts BOQ_LINE_API_FIELDS. */
export const BOQ_LINE_API_FIELDS = [
  'status', 'reviewedBy', 'reviewedAt', 'approvedBy', 'approvedAt', 'note', 'qtyOverride', 'qtyOverrideReason', 'qtyOverrideBy', 'qtyOverrideAt', 'updatedAt',
] as const;

/** orgs/{orgId}/projects/{projectId}/boqBuilds/{buildId} — API creates `queued`, worker runs it. No client write. */
export interface BoqBuild {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  jobId: string | null;
  requestedBy: string | null;
  createdAt: FsTimestamp;
  startedAt: FsTimestamp | null;
  finishedAt: FsTimestamp | null;
  stats: Record<string, number> | null;
  error: { code: string; message: string } | null;
  evidenceRef?: string | null;
}

/** orgs/{orgId}/projects/{projectId}/exports/{exportId} — API-written export record (file: Storage, signed URL only). */
export interface BoqExport {
  templateId: string | null;
  split: 'summed' | 'byFloor';
  markDraft: boolean;
  storagePath: string; // orgs/{o}/projects/{p}/exports/{exportId}.xlsx
  buildId: string | null;
  counts: Record<string, number>;
  sha256: string;
  sizeBytes: number;
  createdBy: string;
  createdAt: FsTimestamp;
}

/** orgs/{orgId}/boqRules/{ruleId} — seeded defaults + admin edits via API. No client write. */
export interface BoqRule {
  kind: 'class_to_item' | 'composite_lighting' | 'install_count' | 'authority';
  match: Record<string, unknown>;
  itemCode: string | null; // TEXT
  itemDescription?: string | null;
  unit?: string | null;
  priority: number;
  enabled: boolean;
  reasons?: string[];
  source: 'default' | 'custom';
  updatedAt: FsTimestamp | null;
  updatedBy?: string | null;
}

/** orgs/{orgId}/libraryImports/{importId} — API creates/finalizes; worker may write status/stats/error. No client write. */
export interface LibraryImport {
  orgId: string;
  projectId: string | null;
  sourceKind: 'xls' | 'xlsx';
  storagePath: string; // orgs/{orgId}/imports/{importId}.{xls|xlsx}
  originalName: string;
  sizeBytes: number;
  status: 'awaiting_upload' | 'queued' | 'running' | 'succeeded' | 'failed' | 'rejected';
  jobId: string | null;
  createdBy: string;
  createdAt: FsTimestamp;
  expiresAt: FsTimestamp;
  finalizedAt: FsTimestamp | null;
  stats: Record<string, number> | null;
  error: { code: string; message: string } | null;
}

/** orgs/{orgId}/projects/{projectId}/shareLinks/{linkId} — API-only (Sprint 5: not client-readable); SHA-256 only. */
export interface ShareLink {
  tokenHash: string;
  versionLock: string[]; // sheet version ids
  expiresAt: FsTimestamp; // default 14d, max 90d
  revokedAt: FsTimestamp | null;
  allowPdfDownload: boolean;
  createdBy: string;
  createdAt: FsTimestamp;
  // Sprint 5 (additive)
  versionLockBySheet?: Record<string, string>;
  label?: string;
  recipient?: string | null;
  hideTitleBlock?: boolean;
  viewCount?: number;
  lastViewedAt?: FsTimestamp | null;
  revokedBy?: string | null;
  revokeReason?: 'user' | 'offboarding' | 'project_deleted' | null;
  pdfExportId?: string | null;
}

/** orgs/{orgId}/itemLibrary/{itemId} — API (manual) / worker (library.import). itemId = itemIdFor(code, description). */
export interface ItemLibraryEntry {
  code: string; // TEXT
  chapter: string; // "04"
  chapterTitle: string;
  description: string;
  unit: string;
  tags: string[];
  source: 'import' | 'manual';
  sourceRef?: string | null;
  active: boolean;
  updatedAt: FsTimestamp | null;
  updatedBy?: string | null;
}

/** orgs/{orgId}/boqTemplates/{id} — API (seed `tpl_default`, admin PATCH) / worker (import). */
export interface BoqTemplate {
  name: string;
  chapters: Array<{ code: string; title: string; notes: string[]; codePrefixes?: string[] }>;
  columns: Array<{ key: 'code' | 'description' | 'unit' | 'qty' | 'unitPrice' | 'total'; title: string; width?: number }>;
  titleRows: string[];
  default: boolean;
  source: 'default' | 'import' | 'manual';
  sourceRef?: string | null;
  vatRate: number;
  updatedAt: FsTimestamp | null;
  updatedBy?: string | null;
}

/**
 * orgs/{orgId}/symbolMappings/{signature} — Sprint 2 brief. API-written on confirm / reassign / unknown-cluster
 * resolve (upsert, uses++); the worker reads it to pre-fill suggestedClass ("learn once, reuse"). NO client write.
 */
export interface SymbolMapping {
  class: string | null; // null iff ignored
  /** true = resolved as "לא רלוונטי": the worker skips this signature. Missing on older docs = false. */
  ignored: boolean;
  itemCode: string | null; // TEXT
  label: string;
  confirmedBy: string;
  confirmedAt: FsTimestamp;
  uses: number;
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
  sheetSetId?: string;
  versionId?: string;
  type: (typeof JOB_TYPES)[number] | string;
  attempts?: number;
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
  /** Sprint 4 Firestore docs (API only). */
  correctionBatch: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/correctionBatches/${id}`,
  roomSettings: (o: string, p: string, sheetId: string, roomId: string) => `orgs/${o}/projects/${p}/roomSettings/${sheetId}__${roomId}`,
  similarSearch: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/similarSearches/${id}`,
  boqLine: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/boqLines/${id}`,
  shareLink: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/shareLinks/${id}`,
  itemLibrary: (o: string, id: string) => `orgs/${o}/itemLibrary/${id}`,
  boqTemplate: (o: string, id: string) => `orgs/${o}/boqTemplates/${id}`,
  /** Sprint 3 Firestore docs. */
  boqRule: (o: string, id: string) => `orgs/${o}/boqRules/${id}`,
  libraryImport: (o: string, id: string) => `orgs/${o}/libraryImports/${id}`,
  boqBuild: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/boqBuilds/${id}`,
  boqExport: (o: string, p: string, id: string) => `orgs/${o}/projects/${p}/exports/${id}`,
  symbolMapping: (o: string, id: string) => `orgs/${o}/symbolMappings/${id}`,
  auditEvent: (o: string, id: string) => `orgs/${o}/auditLog/${id}`,
  job: (id: string) => `jobs/${id}`,
  /** Storage — client quarantine slot (SEC-13; mirrors packages/contracts storagePaths.quarantine). */
  quarantine: (o: string, uuid: string) => `orgs/${o}/quarantine/${uuid}`,
  /** Verified upload of a sheet set, moved here by the API (admin SDK only). */
  projectUpload: (o: string, p: string, sheetSetId: string, ext: string) => `orgs/${o}/projects/${p}/uploads/${sheetSetId}/source.${ext}`,
  /** @deprecated Sprint-0 client upload slot — closed by storage.rules in Sprint 1. */
  upload: (o: string, uid: string, fileId: string) => `orgs/${o}/uploads/${uid}/${fileId}`,
  /** Sprint-0 artifact prefix (worker only; no client read). */
  derived: (o: string, rest: string) => `orgs/${o}/derived/${rest}`,
  /** @deprecated Sprint-0 verified originals written by the API (no client access). */
  source: (o: string, p: string, sha256: string, ext: string) => `orgs/${o}/projects/${p}/sources/${sha256}.${ext}`,
  /** Sprint-1 artifact prefix of a sheet version (worker writes; clients via signed URLs only). */
  artifacts: (o: string, p: string, s: string, v: string) => `orgs/${o}/projects/${p}/sheets/${s}/versions/${v}`,
  tile: (o: string, p: string, s: string, v: string, z: number, x: number, y: number) =>
    `orgs/${o}/projects/${p}/sheets/${s}/versions/${v}/tiles/${z}/${x}_${y}.webp`,
  /** Sprint 2 artifacts + UI crops (worker only; clients via the API's signed URLs). */
  legendArtifact: (o: string, p: string, s: string, v: string) => `orgs/${o}/projects/${p}/sheets/${s}/versions/${v}/legend.json.gz`,
  detectionsArtifact: (o: string, p: string, s: string, v: string) => `orgs/${o}/projects/${p}/sheets/${s}/versions/${v}/detections.json.gz`,
  roomsArtifact: (o: string, p: string, s: string, v: string) => `orgs/${o}/projects/${p}/sheets/${s}/versions/${v}/rooms.json.gz`,
  legendThumb: (o: string, p: string, s: string, v: string, entryId: string) => `orgs/${o}/projects/${p}/sheets/${s}/versions/${v}/legend/${entryId}.webp`,
  unknownThumb: (o: string, p: string, s: string, v: string, clusterId: string) => `orgs/${o}/projects/${p}/sheets/${s}/versions/${v}/unknown/${clusterId}.webp`,
  /** Sprint 2 per-org LLM gateway cache (SEC-23) — worker only, never client-readable. */
  llmCache: (o: string, key: string) => `orgs/${o}/llm-cache/${key}`,
  /** Sprint 3 Storage objects — none client-readable. */
  linksArtifact: (o: string, p: string, s: string, v: string) => `orgs/${o}/projects/${p}/sheets/${s}/versions/${v}/links.json.gz`,
  boqEvidence: (o: string, p: string, buildId: string) => `orgs/${o}/projects/${p}/boq/${buildId}/evidence.json.gz`,
  boqExportFile: (o: string, p: string, exportId: string) => `orgs/${o}/projects/${p}/exports/${exportId}.xlsx`,
  /** Client create-only upload slot for past BOQs (editor/admin, ≤ 20 MB, spreadsheet types); API verifies magic bytes. */
  libraryImportObject: (o: string, uuid: string, ext: 'xls' | 'xlsx') => `orgs/${o}/imports/${uuid}.${ext}`,
  /** Sprint 4: find_similar candidate crops (worker writes; API signs; never client-readable). */
  similarThumb: (o: string, p: string, searchId: string, candidateId: string) => `orgs/${o}/projects/${p}/similar/${searchId}/${candidateId}.webp`,
  /** Sprint 5 Firestore docs (no client access unless stated). */
  shareToken: (tokenHash: string) => `shareTokens/${tokenHash}`,
  offboardingCertificate: (orgId: string) => `offboardingCertificates/${orgId}`,
  auditHead: (o: string) => `orgs/${o}/auditMeta/head`,
  offboardingExport: (o: string, id: string) => `orgs/${o}/offboardingExports/${id}`, // admin read
  reprocessRequest: (o: string, p: string, sheetId: string) => `orgs/${o}/projects/${p}/reprocessRequests/${sheetId}`,
  /** Sprint 5 Storage objects — none client-readable. */
  markedPdf: (o: string, p: string, exportId: string) => `orgs/${o}/projects/${p}/exports/${exportId}/marked.pdf`,
  offboardingZip: (o: string, exportId: string) => `orgs/${o}/offboarding/${exportId}.zip`,
  shareBoqSnapshot: (o: string, p: string, linkId: string) => `orgs/${o}/projects/${p}/share/${linkId}/boq.json.gz`,
} as const;

/** Storage prefixes a client may READ directly. Empty by design: every read is a signed URL (SEC-20). */
export const CLIENT_READABLE_STORAGE_PREFIXES: readonly string[] = [];

/** Every collection id used in the model (checked against firestore.rules by the lint test). */
export const COLLECTIONS = [
  'orgs', 'members', 'projects', 'sheetSets', 'sheets', 'versions', 'legendEntries', 'reviewItems',
  'corrections', 'boqLines', 'shareLinks', 'itemLibrary', 'boqTemplates', 'symbolMappings', 'auditLog', 'jobs',
  // Sprint 3
  'boqBuilds', 'exports', 'boqRules', 'libraryImports',
  // Sprint 4
  'correctionBatches', 'roomSettings', 'similarSearches',
  // Sprint 5
  'shareTokens', 'offboardingCertificates', 'auditMeta', 'offboardingExports', 'reprocessRequests',
] as const;
export type CollectionId = (typeof COLLECTIONS)[number];
