import { randomUUID } from 'node:crypto';
import {
  roleSatisfies,
  type MyOrg,
  type Org,
  type Project,
  type Role,
  type SheetSet,
  type SheetVersion,
  type SheetVersionStatus,
} from '@kamutan/contracts';
import type { AuthContext } from '../auth/auth-context';
import { conflict } from '../common/api-exception';
import {
  decodeCursor,
  encodeCursor,
  type AuditEntry,
  type NewJob,
  type NewProject,
  type NewSheetSetUpload,
  type ProjectListOptions,
  type ProjectPatch,
  type Repository,
  type RepositoryTx,
  type SheetSetWithVersion,
} from './repository';

/** Error mimicking a Postgres RLS violation (SQLSTATE 42501). */
export class RlsViolation extends Error {
  readonly code = '42501';
  constructor(what: string) {
    super(`new row violates row-level security policy for ${what}`);
  }
}

interface Store {
  orgs: Map<string, Org>;
  memberships: Map<string, Role>; // key `${orgId}:${userId}`
  projects: Map<string, Project>;
  sheetSets: Map<string, SheetSet>;
  sheetVersions: Map<string, SheetVersion & { sheetSetId: string }>;
  jobs: Map<string, NewJob & { id: string; createdAt: number }>;
  audit: (AuditEntry & { actorId: string })[];
}

const now = () => new Date().toISOString();

/**
 * In-process repository for tests and DB-less local dev (DATA_DRIVER=memory,
 * never in production). Emulates the RLS rules the API depends on: rows of
 * orgs you are not a member of are invisible; writes need editor or admin.
 */
export class InMemoryRepository implements Repository {
  readonly store: Store = {
    orgs: new Map(),
    memberships: new Map(),
    projects: new Map(),
    sheetSets: new Map(),
    sheetVersions: new Map(),
    jobs: new Map(),
    audit: [],
  };
  private seq = 0;
  private chain: Promise<unknown> = Promise.resolve();

  /** Test helper: create an org with members. */
  seedOrg(org: { id?: string; name: string; slug: string }, members: Record<string, Role> = {}): Org {
    const o: Org = { id: org.id ?? randomUUID(), name: org.name, slug: org.slug, settings: {}, createdAt: now(), updatedAt: now() };
    this.store.orgs.set(o.id, o);
    for (const [userId, role] of Object.entries(members)) this.store.memberships.set(`${o.id}:${userId}`, role);
    return o;
  }

  /** Transactions are serialized and all-or-nothing (snapshot + restore on error). */
  run<T>(user: AuthContext, fn: (tx: RepositoryTx) => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      const snapshot = this.snapshot();
      try {
        return await fn(new InMemoryTx(this, user.userId));
      } catch (err) {
        this.restore(snapshot);
        throw err;
      }
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  async ping(): Promise<void> {}
  async close(): Promise<void> {}

  nextSeq(): number {
    return ++this.seq;
  }

  private snapshot(): Store {
    return {
      orgs: new Map(this.store.orgs),
      memberships: new Map(this.store.memberships),
      projects: new Map(this.store.projects),
      sheetSets: new Map(this.store.sheetSets),
      sheetVersions: new Map(this.store.sheetVersions),
      jobs: new Map(this.store.jobs),
      audit: [...this.store.audit],
    };
  }

  private restore(s: Store): void {
    Object.assign(this.store, s);
  }
}

class InMemoryTx implements RepositoryTx {
  constructor(
    private readonly repo: InMemoryRepository,
    private readonly userId: string,
  ) {}

  private get s(): Store {
    return this.repo.store;
  }

  private role(orgId: string): Role | null {
    return this.s.memberships.get(`${orgId}:${this.userId}`) ?? null;
  }

  private canWrite(orgId: string, what: string): void {
    const r = this.role(orgId);
    if (!r || !roleSatisfies(r, 'editor')) throw new RlsViolation(what);
  }

  async listMyOrgs(): Promise<MyOrg[]> {
    return [...this.s.orgs.values()]
      .filter((o) => this.role(o.id))
      .map((o) => ({ ...o, role: this.role(o.id) as Role }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getOrg(orgId: string): Promise<Org | null> {
    return this.role(orgId) ? (this.s.orgs.get(orgId) ?? null) : null;
  }

  async createOrg(name: string, slug: string): Promise<Org> {
    if ([...this.s.orgs.values()].some((o) => o.slug === slug)) throw conflict('org slug already taken');
    return this.repo.seedOrg({ name, slug }, { [this.userId]: 'admin' });
  }

  async getMyRole(orgId: string): Promise<Role | null> {
    return this.role(orgId);
  }

  async listProjects(opts: ProjectListOptions): Promise<{ items: Project[]; nextCursor: string | null }> {
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
    const all = [...this.s.projects.values()]
      .filter((p) => this.role(p.orgId) && p.status !== ('deleted' as string))
      .filter((p) => !opts.orgId || p.orgId === opts.orgId)
      .sort((a, b) => (a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt)))
      .filter((p) => !cur || p.createdAt < cur.createdAt || (p.createdAt === cur.createdAt && p.id < cur.id));
    const items = all.slice(0, opts.limit);
    const last = items[items.length - 1];
    return { items, nextCursor: all.length > opts.limit && last ? encodeCursor(last.createdAt, last.id) : null };
  }

  async getProject(projectId: string): Promise<Project | null> {
    const p = this.s.projects.get(projectId);
    return p && this.role(p.orgId) ? p : null;
  }

  async createProject(input: NewProject): Promise<Project> {
    this.canWrite(input.orgId, 'projects');
    // Distinct, strictly increasing timestamps keep cursor pagination deterministic.
    const t = new Date(Date.now() + this.repo.nextSeq()).toISOString();
    const p: Project = {
      id: randomUUID(),
      orgId: input.orgId,
      name: input.name,
      address: input.address,
      status: 'active',
      createdBy: this.userId,
      createdAt: t,
      updatedAt: t,
    };
    this.s.projects.set(p.id, p);
    return p;
  }

  async updateProject(projectId: string, patch: ProjectPatch): Promise<Project | null> {
    const p = await this.getProject(projectId);
    if (!p) return null;
    this.canWrite(p.orgId, 'projects');
    const next: Project = { ...p, ...stripUndefined(patch), updatedAt: now() };
    this.s.projects.set(p.id, next);
    return next;
  }

  async lockProjectFile(): Promise<void> {
    // Transactions are already serialized.
  }

  async findSheetSetBySha(projectId: string, sha256: string): Promise<SheetSetWithVersion | null> {
    const ss = [...this.s.sheetSets.values()].find(
      (x) => x.projectId === projectId && x.sourceSha256 === sha256 && this.role(x.orgId),
    );
    if (!ss) return null;
    const sv = [...this.s.sheetVersions.values()].find((v) => v.sheetSetId === ss.id && v.sourceSha256 === sha256);
    if (!sv) return null;
    const { sheetSetId: _ignored, ...sheetVersion } = sv;
    return { sheetSet: ss, sheetVersion };
  }

  async createSheetSetWithVersion(input: NewSheetSetUpload): Promise<SheetSetWithVersion> {
    this.canWrite(input.orgId, 'sheet_sets');
    if (!input.storagePath.startsWith(`${input.orgId}/`)) throw new Error('storage_path outside org prefix');
    const sheetSet: SheetSet = {
      id: randomUUID(),
      orgId: input.orgId,
      projectId: input.projectId,
      name: input.name,
      uploadedBy: this.userId,
      sourceFilePath: input.storagePath,
      sourceSha256: input.sha256,
      fileKind: input.fileKind,
      createdAt: now(),
    };
    const sheetVersion: SheetVersion = {
      id: randomUUID(),
      orgId: input.orgId,
      sheetId: randomUUID(),
      versionNo: 1,
      sourceSha256: input.sha256,
      storagePath: input.storagePath,
      pageIndex: 0,
      status: 'uploaded',
      widthMm: null,
      heightMm: null,
      scale: null,
      isRaster: false,
      pipelineState: {},
      createdAt: now(),
    };
    this.s.sheetSets.set(sheetSet.id, sheetSet);
    this.s.sheetVersions.set(sheetVersion.id, { ...sheetVersion, sheetSetId: sheetSet.id });
    return { sheetSet, sheetVersion };
  }

  async setSheetVersionStatus(sheetVersionId: string, status: SheetVersionStatus): Promise<void> {
    const sv = this.s.sheetVersions.get(sheetVersionId);
    if (!sv || !this.role(sv.orgId)) return;
    this.canWrite(sv.orgId, 'sheet_versions');
    this.s.sheetVersions.set(sheetVersionId, { ...sv, status });
  }

  async createJob(input: NewJob): Promise<string> {
    this.canWrite(input.orgId, 'jobs');
    const id = randomUUID();
    this.s.jobs.set(id, { ...input, id, createdAt: this.repo.nextSeq() });
    return id;
  }

  async findJobId(sheetVersionId: string, type: string): Promise<string | null> {
    const jobs = [...this.s.jobs.values()]
      .filter((j) => j.sheetVersionId === sheetVersionId && j.type === type && this.role(j.orgId))
      .sort((a, b) => b.createdAt - a.createdAt);
    return jobs[0]?.id ?? null;
  }

  async writeAudit(entry: AuditEntry): Promise<void> {
    if (!this.role(entry.orgId)) throw new RlsViolation('audit_log');
    this.s.audit.push({ ...entry, actorId: this.userId });
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
