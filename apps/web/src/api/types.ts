/**
 * App-local DTOs mirroring @kamutan/contracts (packages/contracts/src/*.ts) field-for-field.
 * Kept local so the web app builds without the contracts package; switch to
 * `import type { … } from "@kamutan/contracts"` once its build is wired into turbo for web.
 */
export type Role = "admin" | "editor" | "reviewer" | "viewer";
export type FileKind = "pdf" | "dwg" | "dxf" | "png";

export interface MyOrg {
  id: string;
  name: string;
  role: Role;
}
export interface MeResponse {
  uid: string;
  mfa: boolean;
  orgs: MyOrg[];
}

export interface ProjectStats {
  sheets: number;
  reviewOpen: number;
  boqLines: number;
  red: number;
  yellow: number;
  green: number;
}

/** contracts ProjectSchema */
export interface Project {
  id: string;
  orgId: string;
  name: string;
  address?: string;
  templateId?: string | null;
  floors: { code: string; name: string; sortOrder: number }[];
  stats?: ProjectStats;
  status: "active" | "archived";
  createdBy: string;
  createdAt: string; // ISO
}

export interface CreateProjectInput {
  orgId: string;
  name: string;
  address?: string;
}

/** POST /api/v1/projects/:projectId/uploads */
export interface CreateUploadRequest {
  filename: string;
  sizeBytes: number;
  sha256?: string;
}
export interface CreateUploadResponse {
  fileId: string;
  /** orgs/{orgId}/uploads/{uid}/{fileId} */
  storagePath: string;
  uploadToken: string;
  contentType: string;
  fileKind: FileKind;
  maxBytes: number;
  expiresAt: string;
}

/** POST /api/v1/projects/:projectId/sheet-sets */
export interface FinalizeUploadRequest {
  uploadToken: string;
  name?: string;
}
export type SheetSetStatus = "uploaded" | "queued" | "splitting" | "ready" | "failed";
export type SheetVersionStatus = "uploaded" | "queued" | "processing" | "ready" | "failed";

export interface SheetSet {
  id: string;
  orgId: string;
  projectId: string;
  fileKind: FileKind;
  sha256: string;
  storagePath: string;
  status: SheetSetStatus;
  name?: string;
  uploadedBy: string;
  createdAt: string;
}
/* ---------- Sprint 1: ingest (docs/agents/SPRINT1_BRIEF.md, packages/contracts/src/sheets.ts + tiles.ts) ----------
 * TODO(contracts): hand-kept mirror of @kamutan/contracts (Sprint 1 shapes, still in flight on the API side).
 * Replace with `import type` from @kamutan/contracts once web depends on the built package.
 */
export const INGEST_STAGES = ["ingest", "render", "ocr", "classify", "scale", "done"] as const;
export type IngestStage = (typeof INGEST_STAGES)[number];
export type ClassificationLevel = "green" | "yellow" | "red";

export interface SheetClassification {
  discipline: string | null;
  floors: string[];
  sheetTitle: string | null;
  scaleText: string | null;
  confidence: number; // 0..1
  level: ClassificationLevel;
  /** Reason codes (UI maps known codes to Hebrew; unknown codes are shown verbatim). */
  reasons: string[];
}

/** Tiles pyramid meta stored on the version doc (z = 0 fits one 256 px tile). */
export interface TilesMeta {
  prefix: string;
  format: "webp";
  tileSize: number;
  dpi: number;
  levels: number;
  widthPx: number;
  heightPx: number;
}

/** Point in paper mm. `{x, y}` (not `[x, y]`): Firestore cannot store nested arrays (contracts PointMmSchema). */
export interface PointMm {
  x: number;
  y: number;
}

/** contracts RegionSchema: id [A-Za-z0-9_-], ≤ 8 regions, 3..256 points, implicitly closed. */
export interface SheetRegion {
  id: string;
  floor: string;
  /** Paper mm, origin top-left, y down. */
  polygonMm: PointMm[];
  scaleDenominator: number;
}

/** orgs/{o}/projects/{p}/sheets/{sheetId}; sheetId = `${sheetSetId}-p${pageIndex}`. */
export interface Sheet {
  id: string;
  sheetSetId: string;
  currentVersionId: string | null;
  /** Sprint 0 field; Sprint 1 docs may omit it. */
  logicalKey?: string;
  titleBlock?: { sheetTitle?: string; sheetNumber?: string; scaleText?: string };
  pageIndex?: number;
  title?: string | null;
  discipline?: string | null;
  floors?: string[];
  scaleDenominator?: number | null;
  classification?: SheetClassification;
  confirmed?: boolean;
  confirmedBy?: string | null;
  confirmedAt?: string | null;
  updatedAt?: string;
}
export interface SheetVersion {
  id: string;
  sheetId: string;
  versionNo?: number;
  status: SheetVersionStatus;
  createdAt: string;
  progress?: { stage: IngestStage; pct: number };
  error?: { code: string; message: string } | null;
  page?: { widthMm: number; heightMm: number; rotation: number };
  artifacts?: { tiles?: TilesMeta; primitives?: string; text?: string; thumbnail?: string };
  regions?: SheetRegion[];
  stats?: { paths?: number; segments?: number; textLines?: number; glyphs?: number };
  workerVersion?: string;
  updatedAt?: string;
}
export interface SheetRow {
  sheet: Sheet;
  version: SheetVersion | null;
}

/** POST /v1/projects/:pid/sheets/:sid/confirm (contracts ConfirmSheetRequestSchema, strict). */
export interface ConfirmSheetRequest {
  discipline: string;
  floors: string[];
  /** Integer 1..10000; null for sheets without a scale (legends, schedules). */
  scaleDenominator: number | null;
  /** Replaces the current version's regions when present. */
  regions?: SheetRegion[];
}

/** PUT /v1/projects/:pid/sheets/:sid/regions response. */
export interface PutRegionsResponse {
  sheetId: string;
  versionId: string;
  regions: SheetRegion[];
}

/**
 * GET /v1/projects/:pid/sheets/:sid/versions/:vid/tiles-manifest (contracts TilesManifestQuerySchema).
 * No params → meta + thumbnail; `z` + inclusive `x0..x1, y0..y1` window → signed URLs (≤ maxBatch tiles).
 */
export interface TilesManifestQuery {
  z: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
export interface TileLevel {
  z: number;
  widthPx: number;
  heightPx: number;
  cols: number;
  rows: number;
  mmPerPx: number;
}
/** contracts TilesManifestSchema. Signed URLs live 15 min. */
export interface TilesManifest {
  sheetId: string;
  versionId: string;
  page: { widthMm: number; heightMm: number; rotation: number } | null;
  tiles: Omit<TilesMeta, "prefix">;
  levelGrid: TileLevel[];
  thumbnailUrl: string | null;
  /** Signed URLs keyed "{z}/{x}_{y}" for the requested window (empty without `z`). */
  urls: Record<string, string>;
  /** Earliest expiry among the returned URLs. */
  expiresAt: string;
  maxBatch: number;
}

export interface FinalizeUploadResponse {
  sheetSet: SheetSet;
  sheet: Sheet;
  sheetVersion: SheetVersion;
  deduplicated: boolean;
  jobId: string;
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
/** jobs/{jobId} */
export interface Job {
  id: string;
  orgId: string;
  projectId?: string;
  /** Sprint 1 brief: the ingest job is per sheetSet (one uploaded file). */
  sheetSetId?: string;
  versionId?: string;
  type: string;
  status: JobStatus;
  progress: number; // 0–100
  stage?: string;
  error?: { code: string; message: string } | null;
  createdAt: string;
  updatedAt?: string;
}

/** contracts ApiErrorSchema body: { error: { code, message, requestId } } */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClient {
  getMe(): Promise<MeResponse>;
  listProjects(orgId: string): Promise<Project[]>;
  getProject(id: string): Promise<Project>;
  createProject(input: CreateProjectInput): Promise<Project>;
  createUpload(projectId: string, req: CreateUploadRequest): Promise<CreateUploadResponse>;
  finalizeUpload(projectId: string, req: FinalizeUploadRequest): Promise<FinalizeUploadResponse>;
  /** Sprint 1: confirm a sheet's classification (sets confirmed/confirmedBy/confirmedAt). */
  confirmSheet(projectId: string, sheetId: string, req: ConfirmSheetRequest): Promise<Sheet>;
  /** Sprint 1: replace the floor regions of the sheet's current version (multi-floor sheets). */
  saveSheetRegions(projectId: string, sheetId: string, regions: SheetRegion[]): Promise<PutRegionsResponse>;
  /** Sprint 1: tiles meta + thumbnail (no query) or short-lived signed tile URLs for a window. */
  getTilesManifest(projectId: string, sheetId: string, versionId: string, q?: TilesManifestQuery): Promise<TilesManifest>;
}

/* ---------- Storage (resumable uploads) ---------- */

export type UploadTaskState = "running" | "paused" | "success" | "canceled" | "error";

export interface UploadHandle {
  pause(): boolean;
  resume(): boolean;
  cancel(): boolean;
  /** Resolves on success; rejects with `UploadCanceledError` or a transport error. */
  done: Promise<void>;
}

export class UploadCanceledError extends Error {
  constructor() {
    super("upload canceled");
    this.name = "UploadCanceledError";
  }
}

export interface UploadTransport {
  start(
    storagePath: string,
    file: Blob,
    contentType: string,
    onProgress: (bytesTransferred: number, totalBytes: number, state: UploadTaskState) => void,
  ): UploadHandle;
}

/* ---------- Realtime (Firestore listeners) ---------- */

export type Unsubscribe = () => void;
export type OnError = (err: Error) => void;

export interface RealtimeSource {
  /** jobs where orgId == X (and projectId == Y if given), newest first. */
  jobs(orgId: string, projectId: string | null, onData: (jobs: Job[]) => void, onError: OnError): Unsubscribe;
  sheetSets(orgId: string, projectId: string, onData: (sets: SheetSet[]) => void, onError: OnError): Unsubscribe;
  /** Sheets of a project joined with their current version (status). */
  sheets(
    orgId: string,
    projectId: string,
    onData: (rows: SheetRow[]) => void,
    onError: OnError,
  ): Unsubscribe;
}

export interface Backend {
  api: ApiClient;
  uploads: UploadTransport;
  realtime: RealtimeSource;
}
