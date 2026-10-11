import type {
  FileKind,
  MyOrg,
  Org,
  Project,
  ProjectStatus,
  Role,
  SheetSet,
  SheetVersion,
  SheetVersionStatus,
} from '@kamutan/contracts';
import type { AuthContext } from '../auth/auth-context';

export const REPOSITORY = Symbol('REPOSITORY');

export interface ProjectListOptions {
  orgId?: string;
  limit: number;
  /** Opaque cursor from a previous page. */
  cursor?: string;
}

export interface NewProject {
  orgId: string;
  name: string;
  address: string | null;
}

export interface ProjectPatch {
  name?: string;
  address?: string | null;
  status?: ProjectStatus;
}

export interface NewSheetSetUpload {
  orgId: string;
  projectId: string;
  name: string;
  storagePath: string;
  sha256: string;
  fileKind: FileKind;
}

export interface SheetSetWithVersion {
  sheetSet: SheetSet;
  sheetVersion: SheetVersion;
}

export interface NewJob {
  orgId: string;
  projectId: string;
  sheetVersionId: string;
  type: string;
  inputHash: string;
}

/**
 * Data access executed **as the end user** (RLS enforced). Every method runs in
 * the transaction opened by `Repository.run`.
 */
export interface RepositoryTx {
  listMyOrgs(): Promise<MyOrg[]>;
  getOrg(orgId: string): Promise<Org | null>;
  /** Creates an org; the caller becomes its admin (app.create_org). */
  createOrg(name: string, slug: string): Promise<Org>;
  /** The caller's role in an org, or null when not a member. */
  getMyRole(orgId: string): Promise<Role | null>;

  listProjects(opts: ProjectListOptions): Promise<{ items: Project[]; nextCursor: string | null }>;
  getProject(projectId: string): Promise<Project | null>;
  createProject(input: NewProject): Promise<Project>;
  updateProject(projectId: string, patch: ProjectPatch): Promise<Project | null>;

  /**
   * Serializes concurrent finalizations of the same file in a project
   * (transaction-scoped advisory lock).
   */
  lockProjectFile(projectId: string, sha256: string): Promise<void>;
  /** An existing upload of the same bytes in the project (dedupe), if any. */
  findSheetSetBySha(projectId: string, sha256: string): Promise<SheetSetWithVersion | null>;
  /** Creates sheet_set + placeholder sheet + sheet_version v1 (status `uploaded`). */
  createSheetSetWithVersion(input: NewSheetSetUpload): Promise<SheetSetWithVersion>;
  setSheetVersionStatus(sheetVersionId: string, status: SheetVersionStatus): Promise<void>;
  /** Inserts a `jobs` row (status queued) and returns its id. */
  createJob(input: NewJob): Promise<string>;
  /** Latest job id of a type for a sheet version. */
  findJobId(sheetVersionId: string, type: string): Promise<string | null>;

  /** Append-only audit entry (app.write_audit, SEC-35). Never pass file content or PII. */
  writeAudit(entry: AuditEntry): Promise<void>;
}

export interface AuditEntry {
  orgId: string;
  entity: string;
  entityId: string;
  action: string;
  after?: Record<string, unknown>;
}

export interface Repository {
  /** Runs `fn` in one DB transaction as `user` (RLS: request.jwt.claims + role authenticated). */
  run<T>(user: AuthContext, fn: (tx: RepositoryTx) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id]), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(v) &&
      v.length === 2 &&
      typeof v[0] === 'string' &&
      typeof v[1] === 'string' &&
      !Number.isNaN(Date.parse(v[0])) &&
      /^[0-9a-f-]{36}$/i.test(v[1])
    ) {
      return { createdAt: v[0], id: v[1] };
    }
  } catch {
    /* fallthrough */
  }
  return null;
}
