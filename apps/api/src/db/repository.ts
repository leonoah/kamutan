import type {
  Discipline,
  FileKind,
  Job,
  LegendEntry,
  LegendEntryStatus,
  Member,
  Org,
  ProcessingError,
  Project,
  ProjectStatus,
  Region,
  Role,
  Sheet,
  SheetSet,
  SheetSetStatus,
  SheetSummary,
  SheetVersion,
  SymbolClass,
  SymbolMapping,
} from '@kamutan/contracts';

export const REPOSITORY = Symbol('REPOSITORY');

/** Thrown by repository writes whose precondition no longer holds (→ 409). */
export class RepoConflictError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

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
  getSheetSet(orgId: string, projectId: string, sheetSetId: string): Promise<SheetSet | null>;
  /**
   * In one transaction: if sheetSets/{sha256} exists return it (deduplicated),
   * else create sheetSet (status `uploaded`, with `ingestJobId` + `versionId`) + jobs/{jobId}
   * (status `queued`) + audit event. Sheets are created by the worker while splitting.
   */
  createSheetSetIngest(orgId: string, projectId: string, input: NewSheetSet): Promise<{ sheetSet: SheetSet; deduplicated: boolean }>;
  /** The sheet set created from quarantine object `fileId` (makes finalize idempotent per upload token). */
  findSheetSetByUploadFileId(orgId: string, projectId: string, fileId: string): Promise<SheetSet | null>;
  setSheetSetStatus(orgId: string, projectId: string, sheetSetId: string, status: SheetSetStatus): Promise<void>;

  // --- sheets & versions --------------------------------------------------
  /** Ordered by document id (= `${sheetSetId}-p${i}`); cursor = last sheet id. */
  listSheets(
    orgId: string,
    projectId: string,
    opts: { limit: number; cursor?: string; sheetSetId?: string },
  ): Promise<{ items: SheetSummary[]; nextCursor: string | null }>;
  getSheet(orgId: string, projectId: string, sheetId: string): Promise<Sheet | null>;
  getVersion(orgId: string, projectId: string, sheetId: string, versionId: string): Promise<SheetVersion | null>;
  /**
   * Transaction: requires sheet.currentVersionId == expectedVersionId (else RepoConflictError), writes the
   * confirmed fields (+ regions on that version when given) and an audit event.
   */
  confirmSheet(orgId: string, projectId: string, sheetId: string, input: ConfirmInput, actorUid: string): Promise<Sheet | null>;
  /** Transaction: requires `versionId` to still be current; replaces its regions; audit event. */
  setRegions(
    orgId: string,
    projectId: string,
    sheetId: string,
    versionId: string,
    regions: Region[],
    actorUid: string,
  ): Promise<SheetVersion | null>;
  /**
   * Transaction: refuses (RepoConflictError 'in_progress') while the current version is queued/processing;
   * otherwise creates versions/{new} (status `queued`, regions copied), jobs/{jobId}, points
   * sheet.currentVersionId at it and appends an audit event.
   */
  createReprocessVersion(orgId: string, projectId: string, sheetId: string, actorUid: string, jobType: string): Promise<ReprocessResult | null>;
  /** Marks a job (and its version, when given) failed — used when publishing fails. */
  failJob(orgId: string, jobId: string, error: ProcessingError, version?: { projectId: string; sheetId: string; versionId: string }): Promise<void>;

  // --- legend entries & symbol mappings (Sprint 2) ------------------------
  /** Ordered by document id; optional equality filters; cursor = last entry id. */
  listLegendEntries(
    orgId: string,
    projectId: string,
    opts: { limit: number; cursor?: string; status?: LegendEntryStatus; sheetId?: string },
  ): Promise<{ items: LegendEntry[]; nextCursor: string | null }>;
  getLegendEntry(orgId: string, projectId: string, entryId: string): Promise<LegendEntry | null>;
  /**
   * Transaction: re-reads the entry (null when gone), writes the decision; for confirm/reassign upserts
   * orgs/{orgId}/symbolMappings/{entry.signature} (uses++); appends an audit event.
   */
  decideLegendEntry(
    orgId: string,
    projectId: string,
    entryId: string,
    decision: LegendDecision,
    actorUid: string,
  ): Promise<{ entry: LegendEntry; mapping: SymbolMapping | null } | null>;
  /**
   * Transaction: upserts symbolMappings/{signature} (uses++), optionally upserts a confirmed legend entry for the
   * cluster, appends an audit event.
   */
  resolveUnknownCluster(orgId: string, projectId: string, input: ResolveClusterInput, actorUid: string): Promise<{ mapping: SymbolMapping; legendEntry: LegendEntry | null }>;
  getSymbolMapping(orgId: string, signature: string): Promise<SymbolMapping | null>;

  // --- jobs ---------------------------------------------------------------
  /** jobs/{jobId} (top level). The caller must check membership of job.orgId. */
  getJob(jobId: string): Promise<Job | null>;

  // --- audit ------------------------------------------------------------
  /** Appends to orgs/{orgId}/auditLog with a per-org hash chain (SEC-35). */
  appendAudit(orgId: string, event: AuditInput): Promise<void>;

  ping(): Promise<void>;
}

export interface NewSheetSet {
  name: string;
  sha256: string;
  fileKind: FileKind;
  /** Verified upload: orgs/{orgId}/projects/{projectId}/uploads/{sha256}/source.{ext} */
  storagePath: string;
  uploadedBy: string;
  /** Quarantine object id (upload token `fid`). */
  uploadFileId: string;
  sizeBytes: number;
  jobType: string;
}

export interface ConfirmInput {
  discipline: Discipline;
  floors: string[];
  scaleDenominator: number | null;
  expectedVersionId: string | null;
  /** Replaces the regions of `expectedVersionId` when present. */
  regions?: Region[];
}

export interface ReprocessResult {
  sheet: Sheet;
  version: SheetVersion;
  sheetSet: SheetSet;
  jobId: string;
}

export interface AuditInput {
  actorId: string | null;
  /** Sprint 5: `user` (default), `share_link` (public share views), `system` (scripts / purge). Part of the hashed body. */
  actorKind?: 'user' | 'share_link' | 'system';
  entity: string;
  entityId: string | null;
  action: string;
  after?: Record<string, unknown> | null;
}

export type LegendDecision =
  | {
      action: 'confirm' | 'reassign';
      class: SymbolClass;
      /** undefined = keep the entry's current itemCode */
      itemCode?: string | null;
      /** User-edited label; undefined = keep the entry's label. */
      label?: string;
    }
  | { action: 'ignore' };

export interface ResolveClusterInput {
  clusterId: string;
  signature: string;
  sheetId: string;
  versionId: string;
  /** null iff `ignored` ("לא רלוונטי"). */
  class: SymbolClass | null;
  ignored: boolean;
  itemCode: string | null;
  /** Mapping / entry label (the taxonomy's Hebrew name of `class`, or "לא רלוונטי"). */
  label: string;
  /** When set, upsert this confirmed legend entry. */
  legendEntry: { id: string; thumbPath: string | null } | null;
}
