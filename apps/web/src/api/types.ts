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
export type SheetSetStatus = "uploaded" | "splitting" | "ready" | "failed";
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
export interface Sheet {
  id: string;
  logicalKey: string;
  sheetSetId: string;
  currentVersionId: string | null;
  titleBlock?: { sheetTitle?: string; sheetNumber?: string; scaleText?: string };
}
export interface SheetVersion {
  id: string;
  sheetId: string;
  versionNo: number;
  status: SheetVersionStatus;
  createdAt: string;
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
    onData: (rows: { sheet: Sheet; version: SheetVersion | null }[]) => void,
    onError: OnError,
  ): Unsubscribe;
}

export interface Backend {
  api: ApiClient;
  uploads: UploadTransport;
  realtime: RealtimeSource;
}
