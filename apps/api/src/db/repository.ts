import type {
  FileKind,
  Member,
  Org,
  Project,
  ProjectStatus,
  Role,
  Sheet,
  SheetSet,
  SheetVersion,
  SheetVersionStatus,
} from '@kamutan/contracts';

export const REPOSITORY = Symbol('REPOSITORY');

/**
 * Data access over Firestore (ADR 0008 layout). firebase-admin bypasses
 * Security Rules, so this layer does NOT authorize: every tenant method takes
 * the `orgId` and only ever touches documents under `orgs/{orgId}/...`
 * (or `jobs/*` with `orgId` set). Callers (services) must have checked the
 * caller's membership/role via AccessService first.
 */
export interface Repository {
  // --- orgs & members ---------------------------------------------------
  getMember(orgId: string, uid: string): Promise<Member | null>;
  /** Collection-group query members where uid == uid. */
  listMembershipsOf(uid: string): Promise<Array<{ orgId: string; role: Role }>>;
  getOrg(orgId: string): Promise<Org | null>;
  /** Creates orgs/{id} + members/{uid}(admin) + audit event atomically. */
  createOrgWithAdmin(name: string, admin: { uid: string; email?: string }): Promise<Org>;

  // --- projects ---------------------------------------------------------
  /** Collection-group lookup projects where projectId == id → orgId (ids are unguessable auto ids). */
  findProjectOrgId(projectId: string): Promise<string | null>;
  getProject(orgId: string, projectId: string): Promise<Project | null>;
  listProjects(orgId: string, opts: { limit: number; cursor?: string }): Promise<{ items: Project[]; nextCursor: string | null }>;
  createProject(orgId: string, input: { name: string; address?: string }, actorUid: string): Promise<Project>;
  updateProject(
    orgId: string,
    projectId: string,
    patch: { name?: string; address?: string; status?: ProjectStatus },
    actorUid: string,
  ): Promise<Project | null>;

  // --- sheet sets / ingest ----------------------------------------------
  findSheetSetBySha(orgId: string, projectId: string, sha256: string): Promise<SheetSetBundle | null>;
  /**
   * In one transaction: if sheetSets/{sha256} exists return it (deduplicated),
   * else create sheetSet + sheet + version (status `uploaded`) + jobs/{jobId}
   * (status `queued`) + audit event.
   */
  createSheetSetBundle(orgId: string, projectId: string, input: NewSheetSet): Promise<{ bundle: SheetSetBundle; deduplicated: boolean }>;
  setVersionStatus(orgId: string, projectId: string, sheetId: string, versionId: string, status: SheetVersionStatus): Promise<void>;

  // --- audit ------------------------------------------------------------
  /** Appends to orgs/{orgId}/auditLog with a per-org hash chain (SEC-35). */
  appendAudit(orgId: string, event: AuditInput): Promise<void>;

  ping(): Promise<void>;
}

export interface NewSheetSet {
  name: string;
  sha256: string;
  fileKind: FileKind;
  /** Verified source object: orgs/{orgId}/projects/{projectId}/sources/{sha256}.{ext} */
  storagePath: string;
  uploadedBy: string;
  sizeBytes: number;
  jobType: string;
}

export interface SheetSetBundle {
  sheetSet: SheetSet;
  sheet: Sheet;
  sheetVersion: SheetVersion;
  jobId: string;
}

export interface AuditInput {
  actorId: string | null;
  entity: string;
  entityId: string | null;
  action: string;
  after?: Record<string, unknown> | null;
}
