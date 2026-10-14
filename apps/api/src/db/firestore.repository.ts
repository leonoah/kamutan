import { randomUUID } from 'node:crypto';
import {
  FieldPath,
  Firestore,
  type DocumentData,
  type Query,
  type Transaction,
} from 'firebase-admin/firestore';
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

/** Authorization failure for a write the caller's role does not allow (maps like an RLS violation). */
export class AccessDenied extends Error {
  readonly code = '42501';
  constructor(what: string) {
    super(`access denied for ${what}`);
  }
}

export const COLLECTIONS = {
  orgs: 'orgs',
  memberships: 'memberships', // doc id `${orgId}_${userId}`
  orgSlugs: 'orgSlugs', // doc id = slug; enforces uniqueness
  projects: 'projects',
  sheetSets: 'sheetSets',
  sheetVersions: 'sheetVersions',
  jobs: 'jobs',
  audit: 'auditLog',
} as const;

const GRPC_ALREADY_EXISTS = 6;
const now = () => new Date().toISOString();
const memberId = (orgId: string, userId: string) => `${orgId}_${userId}`;

/**
 * Firestore-backed repository. There is no database-level RLS here: every method
 * checks the caller's membership/role explicitly, and Firestore security rules
 * deny all direct client access (only this API, via the Admin SDK, reads/writes).
 *
 * `run` is one Firestore transaction: reads go through the transaction snapshot,
 * writes are buffered and applied after `fn` finishes, so `fn` may interleave
 * reads and writes freely. Firestore retries `fn` on contention, which also makes
 * concurrent uploads of the same file dedupe correctly.
 */
export class FirestoreRepository implements Repository {
  private seq = 0;

  constructor(private readonly db: Firestore) {
    db.settings({ ignoreUndefinedProperties: true });
  }

  async run<T>(user: AuthContext, fn: (tx: RepositoryTx) => Promise<T>): Promise<T> {
    try {
      return await this.db.runTransaction(async (t) => {
        const tx = new FirestoreTx(this.db, t, user.userId, () => ++this.seq);
        const result = await fn(tx);
        tx.flush();
        return result;
      });
    } catch (err) {
      if ((err as { code?: number }).code === GRPC_ALREADY_EXISTS) throw conflict('resource already exists');
      throw err;
    }
  }

  async ping(): Promise<void> {
    await this.db.collection(COLLECTIONS.orgs).limit(1).get();
  }

  async close(): Promise<void> {
    await this.db.terminate();
  }
}

class FirestoreTx implements RepositoryTx {
  private readonly writes: Array<() => void> = [];

  constructor(
    private readonly db: Firestore,
    private readonly t: Transaction,
    private readonly userId: string,
    private readonly nextSeq: () => number,
  ) {}

  /** Applies buffered writes; Firestore requires them after all reads. */
  flush(): void {
    for (const w of this.writes) w();
  }

  private col(name: string) {
    return this.db.collection(name);
  }

  private async getDoc(collection: string, id: string): Promise<DocumentData | null> {
    const snap = await this.t.get(this.col(collection).doc(id));
    return snap.exists ? (snap.data() as DocumentData) : null;
  }

  private async getQuery(q: Query): Promise<DocumentData[]> {
    return (await this.t.get(q)).docs.map((d) => d.data());
  }

  private async role(orgId: string): Promise<Role | null> {
    const m = await this.getDoc(COLLECTIONS.memberships, memberId(orgId, this.userId));
    return (m?.role as Role | undefined) ?? null;
  }

  private async requireWrite(orgId: string, what: string): Promise<void> {
    const r = await this.role(orgId);
    if (!r || !roleSatisfies(r, 'editor')) throw new AccessDenied(what);
  }

  async listMyOrgs(): Promise<MyOrg[]> {
    const memberships = await this.getQuery(this.col(COLLECTIONS.memberships).where('userId', '==', this.userId));
    const orgs = await Promise.all(
      memberships.map(async (m) => {
        const org = await this.getDoc(COLLECTIONS.orgs, String(m.orgId));
        return org ? ({ ...(org as Org), role: m.role as Role } satisfies MyOrg) : null;
      }),
    );
    return orgs.filter((o): o is MyOrg => o !== null).sort((a, b) => a.name.localeCompare(b.name));
  }

  async getOrg(orgId: string): Promise<Org | null> {
    if (!(await this.role(orgId))) return null;
    return ((await this.getDoc(COLLECTIONS.orgs, orgId)) as Org | null) ?? null;
  }

  async createOrg(name: string, slug: string): Promise<Org> {
    const slugRef = this.col(COLLECTIONS.orgSlugs).doc(slug);
    if ((await this.t.get(slugRef)).exists) throw conflict('org slug already taken');
    const ts = now();
    const org: Org = { id: randomUUID(), name, slug, settings: {}, createdAt: ts, updatedAt: ts };
    this.writes.push(() => {
      this.t.create(slugRef, { orgId: org.id });
      this.t.create(this.col(COLLECTIONS.orgs).doc(org.id), org);
      this.t.create(this.col(COLLECTIONS.memberships).doc(memberId(org.id, this.userId)), {
        orgId: org.id,
        userId: this.userId,
        role: 'admin',
        createdAt: ts,
      });
    });
    return org;
  }

  async getMyRole(orgId: string): Promise<Role | null> {
    return this.role(orgId);
  }

  async listProjects(opts: ProjectListOptions): Promise<{ items: Project[]; nextCursor: string | null }> {
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
    let orgIds: string[];
    if (opts.orgId) {
      orgIds = (await this.role(opts.orgId)) ? [opts.orgId] : [];
    } else {
      const ms = await this.getQuery(this.col(COLLECTIONS.memberships).where('userId', '==', this.userId));
      orgIds = ms.map((m) => String(m.orgId));
    }

    const perOrg = await Promise.all(
      orgIds.map(async (orgId) => {
        let q: Query = this.col(COLLECTIONS.projects)
          .where('orgId', '==', orgId)
          .orderBy('createdAt', 'desc')
          .orderBy(FieldPath.documentId(), 'desc');
        if (cur) q = q.startAfter(cur.createdAt, cur.id);
        return (await this.getQuery(q.limit(opts.limit + 1))) as Project[];
      }),
    );

    const all = perOrg
      .flat()
      .filter((p) => p.status !== ('deleted' as string))
      .sort((a, b) => (a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt)));
    const items = all.slice(0, opts.limit);
    const last = items[items.length - 1];
    return { items, nextCursor: all.length > opts.limit && last ? encodeCursor(last.createdAt, last.id) : null };
  }

  async getProject(projectId: string): Promise<Project | null> {
    const p = (await this.getDoc(COLLECTIONS.projects, projectId)) as Project | null;
    if (!p || p.status === ('deleted' as string)) return null;
    return (await this.role(p.orgId)) ? p : null;
  }

  async createProject(input: NewProject): Promise<Project> {
    await this.requireWrite(input.orgId, 'projects');
    // Distinct, strictly increasing timestamps keep cursor pagination deterministic.
    const ts = new Date(Date.now() + this.nextSeq()).toISOString();
    const p: Project = {
      id: randomUUID(),
      orgId: input.orgId,
      name: input.name,
      address: input.address,
      status: 'active',
      createdBy: this.userId,
      createdAt: ts,
      updatedAt: ts,
    };
    this.writes.push(() => this.t.create(this.col(COLLECTIONS.projects).doc(p.id), p));
    return p;
  }

  async updateProject(projectId: string, patch: ProjectPatch): Promise<Project | null> {
    const p = await this.getProject(projectId);
    if (!p) return null;
    await this.requireWrite(p.orgId, 'projects');
    const next: Project = { ...p, ...stripUndefined(patch), updatedAt: now() };
    this.writes.push(() => this.t.set(this.col(COLLECTIONS.projects).doc(p.id), next));
    return next;
  }

  async lockProjectFile(): Promise<void> {
    // The surrounding Firestore transaction retries on conflicting writes, so the
    // find-then-create sequence in the caller is already serialized per document.
  }

  async findSheetSetBySha(projectId: string, sha256: string): Promise<SheetSetWithVersion | null> {
    const sets = (await this.getQuery(
      this.col(COLLECTIONS.sheetSets).where('projectId', '==', projectId).where('sourceSha256', '==', sha256).limit(1),
    )) as SheetSet[];
    const sheetSet = sets[0];
    if (!sheetSet || !(await this.role(sheetSet.orgId))) return null;
    const versions = await this.getQuery(
      this.col(COLLECTIONS.sheetVersions).where('sheetSetId', '==', sheetSet.id).where('sourceSha256', '==', sha256).limit(1),
    );
    const sv = versions[0];
    if (!sv) return null;
    const { sheetSetId: _ignored, ...sheetVersion } = sv;
    return { sheetSet, sheetVersion: sheetVersion as SheetVersion };
  }

  async listSheetSets(projectId: string): Promise<SheetSet[]> {
    const sets = (await this.getQuery(this.col(COLLECTIONS.sheetSets).where('projectId', '==', projectId))) as SheetSet[];
    const visible: SheetSet[] = [];
    for (const s of sets) if (await this.role(s.orgId)) visible.push(s);
    return visible.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async createSheetSetWithVersion(input: NewSheetSetUpload): Promise<SheetSetWithVersion> {
    await this.requireWrite(input.orgId, 'sheet_sets');
    if (!input.storagePath.startsWith(`${input.orgId}/`)) throw new Error('storage_path outside org prefix');
    const ts = now();
    const sheetSet: SheetSet = {
      id: randomUUID(),
      orgId: input.orgId,
      projectId: input.projectId,
      name: input.name,
      uploadedBy: this.userId,
      sourceFilePath: input.storagePath,
      sourceSha256: input.sha256,
      fileKind: input.fileKind,
      createdAt: ts,
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
      createdAt: ts,
    };
    this.writes.push(() => {
      this.t.create(this.col(COLLECTIONS.sheetSets).doc(sheetSet.id), sheetSet);
      this.t.create(this.col(COLLECTIONS.sheetVersions).doc(sheetVersion.id), { ...sheetVersion, sheetSetId: sheetSet.id });
    });
    return { sheetSet, sheetVersion };
  }

  async setSheetVersionStatus(sheetVersionId: string, status: SheetVersionStatus): Promise<void> {
    const sv = await this.getDoc(COLLECTIONS.sheetVersions, sheetVersionId);
    if (!sv || !(await this.role(String(sv.orgId)))) return;
    await this.requireWrite(String(sv.orgId), 'sheet_versions');
    this.writes.push(() => this.t.update(this.col(COLLECTIONS.sheetVersions).doc(sheetVersionId), { status }));
  }

  async createJob(input: NewJob): Promise<string> {
    await this.requireWrite(input.orgId, 'jobs');
    const id = randomUUID();
    const doc = { ...input, id, status: 'queued', createdBy: this.userId, createdAt: now(), seq: Date.now() * 1000 + this.nextSeq() };
    this.writes.push(() => this.t.create(this.col(COLLECTIONS.jobs).doc(id), doc));
    return id;
  }

  async findJobId(sheetVersionId: string, type: string): Promise<string | null> {
    const jobs = await this.getQuery(
      this.col(COLLECTIONS.jobs).where('sheetVersionId', '==', sheetVersionId).where('type', '==', type),
    );
    const visible: DocumentData[] = [];
    for (const j of jobs) if (await this.role(String(j.orgId))) visible.push(j);
    visible.sort((a, b) => Number(b.seq) - Number(a.seq));
    return visible[0] ? String(visible[0].id) : null;
  }

  async writeAudit(entry: AuditEntry): Promise<void> {
    if (!(await this.role(entry.orgId))) throw new AccessDenied('audit_log');
    const doc = { ...entry, actorId: this.userId, createdAt: now() };
    // Append-only: the API only ever creates audit entries.
    this.writes.push(() => this.t.create(this.col(COLLECTIONS.audit).doc(randomUUID()), doc));
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
