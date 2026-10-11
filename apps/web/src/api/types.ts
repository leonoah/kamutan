/**
 * Thin, app-local DTOs. These mirror the planned Zod contracts in packages/contracts
 * (docs/spec/04_architecture.md §API) and will be replaced by imports from
 * @kamutan/contracts once that package is published. Keep field names identical.
 */
export type ProjectStatus = "draft" | "uploading" | "processing" | "review" | "approved";

export interface Project {
  id: string;
  name: string;
  address: string | null;
  status: ProjectStatus;
  /** % of BOQ rows at level "green" (מאומת), 0–100. Computed by rows, not items. */
  verifiedPct: number;
  sheetsCount: number;
  toReviewCount: number;
  updatedAt: string; // ISO
}

export interface CreateProjectInput {
  name: string;
  address?: string | null;
  boqTemplateId?: string | null;
}

export type FileKind = "pdf" | "dwg" | "dxf" | "png";

export interface UploadRequest {
  fileName: string;
  sizeBytes: number;
  kind: FileKind;
}

/** Returned by POST /v1/projects/:id/uploads — a short-lived signed URL into the quarantine bucket. */
export interface UploadTarget {
  uploadId: string;
  url: string;
  method: "PUT" | "POST";
  headers: Record<string, string>;
  expiresAt: string;
}

export interface SheetSet {
  id: string;
  projectId: string;
  name: string;
  fileCount: number;
  createdAt: string;
}

export interface ApiErrorShape {
  status: number;
  code: string;
  message: string;
}

export class ApiError extends Error implements ApiErrorShape {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type UploadProgress = (loadedBytes: number, totalBytes: number) => void;

export interface ApiClient {
  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project>;
  createProject(input: CreateProjectInput): Promise<Project>;
  listSheetSets(projectId: string): Promise<SheetSet[]>;
  createUpload(projectId: string, req: UploadRequest): Promise<UploadTarget>;
  /** PUTs the bytes to the signed URL. Resolves when the object is stored. */
  uploadFile(target: UploadTarget, file: File, onProgress: UploadProgress, signal?: AbortSignal): Promise<void>;
  /** After all uploads finish: registers the set and triggers ingest. */
  createSheetSet(projectId: string, uploadIds: string[], name: string): Promise<SheetSet>;
}
