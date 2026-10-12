import { randomBytes } from 'node:crypto';
import {
  DEFAULT_ORG_SETTINGS,
  fsPaths,
  type Member,
  type Org,
  type Project,
  type Role,
  type Sheet,
  type SheetSet,
  type SheetVersion,
  type SheetVersionStatus,
} from '@kamutan/contracts';
import { auditHash } from './audit-chain';
import type { AuditInput, NewSheetSet, Repository, SheetSetBundle } from './repository';

type Doc = Record<string, unknown>;

/** Firestore-like 20-char auto id. */
export function autoId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(20);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d));

/**
 * In-process repository with the exact ADR 0008 document paths, for tests and
 * offline dev (DATA_DRIVER=memory; refused in production). Like the admin SDK
 * it performs NO authorization — that is the service layer's job.
 */
export class InMemoryRepository implements Repository {
  /** Full document path → data (timestamps as Date). */
  readonly docs = new Map<string, Doc>();
  private chain: Promise<unknown> = Promise.resolve();
  private clock = 0;

  private now(): Date {
    // Strictly increasing timestamps keep ordering deterministic.
    this.clock = Math.max(this.clock + 1, Date.now());
    return new Date(this.clock);
  }

  /** Serialized, all-or-nothing unit of work (like a Firestore transaction). */
  private tx<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const snapshot = new Map(this.docs);
      try {
        return await fn();
      } catch (err) {
        this.docs.clear();
        for (const [k, v] of snapshot) this.docs.set(k, v);
        throw err;
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Direct children docs of a collection path. */
  private children(collectionPath: string): Array<[string, Doc]> {
    const prefix = `${collectionPath}/`;
    return [...this.docs.entries()].filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'));
  }

  private group(collectionId: string): Array<[string, Doc]> {
    return [...this.docs.entries()].filter(([k]) => k.split('/').at(-2) === collectionId);
  }

  // --- test helpers ---------------------------------------------------------
  seedOrg(name: string, members: Record<string, Role> = {}, id = autoId()): Org {
    const createdAt = this.now();
    this.docs.set(fsPaths.org(id), { name, settings: { ...DEFAULT_ORG_SETTINGS }, createdAt });
    for (const [uid, role] of Object.entries(members)) this.docs.set(fsPaths.member(id, uid), { uid, role, createdAt });
    return { id, name, settings: { ...DEFAULT_ORG_SETTINGS }, createdAt: createdAt.toISOString() };
  }

  setMember(orgId: string, uid: string, role: Role): void {
    this.docs.set(fsPaths.member(orgId, uid), { uid, role, createdAt: this.now() });
  }

  // --- orgs & members -------------------------------------------------------
  async getMember(orgId: string, uid: string): Promise<Member | null> {
    const d = this.docs.get(fsPaths.member(orgId, uid));
    return d ? toMember(d) : null;
  }

  async listMembershipsOf(uid: string): Promise<Array<{ orgId: string; role: Role }>> {
    return this.group('members')
      .filter(([, d]) => d.uid === uid)
      .map(([k, d]) => ({ orgId: k.split('/')[1] as string, role: d.role as Role }));
  }

  async getOrg(orgId: string): Promise<Org | null> {
    const d = this.docs.get(fsPaths.org(orgId));
    return d ? toOrg(orgId, d) : null;
  }

  createOrgWithAdmin(name: string, admin: { uid: string; email?: string }): Promise<Org> {
    return this.tx(() => {
      const id = autoId();
      const createdAt = this.now();
      const org = { name, settings: { ...DEFAULT_ORG_SETTINGS }, createdAt };
      this.docs.set(fsPaths.org(id), org);
      this.docs.set(fsPaths.member(id, admin.uid), {
        uid: admin.uid,
        role: 'admin',
        ...(admin.email ? { email: admin.email } : {}),
        addedBy: admin.uid,
        createdAt,
      });
      this.appendAuditSync(id, { actorId: admin.uid, entity: 'orgs', entityId: id, action: 'create' });
      return toOrg(id, org);
    });
  }

  // --- projects -------------------------------------------------------------
  async findProjectOrgId(projectId: string): Promise<string | null> {
    const hit = this.group('projects').find(([, d]) => d.projectId === projectId);
    return hit ? (hit[0].split('/')[1] as string) : null;
  }

  async getProject(orgId: string, projectId: string): Promise<Project | null> {
    const d = this.docs.get(fsPaths.project(orgId, projectId));
    return d ? toProject(projectId, d) : null;
  }

  async listProjects(orgId: string, opts: { limit: number; cursor?: string }) {
    const all = this.children(`orgs/${orgId}/projects`)
      .map(([k, d]) => toProject(k.split('/').at(-1) as string, d))
      .sort((a, b) => (a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt)));
    let start = 0;
    if (opts.cursor) {
      const idx = all.findIndex((p) => p.id === opts.cursor);
      start = idx >= 0 ? idx + 1 : all.length;
    }
    const items = all.slice(start, start + opts.limit);
    const more = all.length > start + opts.limit;
    return { items, nextCursor: more && items.length ? (items.at(-1) as Project).id : null };
  }

  createProject(orgId: string, input: { name: string; address?: string }, actorUid: string): Promise<Project> {
    return this.tx(() => {
      if (!this.docs.has(fsPaths.org(orgId))) throw new Error(`org ${orgId} does not exist`);
      const id = autoId();
      const doc: Doc = {
        projectId: id,
        orgId,
        name: input.name,
        ...(input.address ? { address: input.address } : {}),
        templateId: null,
        floors: [],
        status: 'active',
        createdBy: actorUid,
        createdAt: this.now(),
      };
      this.docs.set(fsPaths.project(orgId, id), doc);
      this.appendAuditSync(orgId, { actorId: actorUid, entity: 'projects', entityId: id, action: 'create' });
      return toProject(id, doc);
    });
  }

  updateProject(orgId: string, projectId: string, patch: { name?: string; address?: string; status?: Project['status'] }, actorUid: string) {
    return this.tx(() => {
      const path = fsPaths.project(orgId, projectId);
      const d = this.docs.get(path);
      if (!d) return null;
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      const next = { ...d, ...clean, updatedAt: this.now() };
      this.docs.set(path, next);
      this.appendAuditSync(orgId, { actorId: actorUid, entity: 'projects', entityId: projectId, action: 'update', after: clean });
      return toProject(projectId, next);
    });
  }

  // --- sheet sets -------------------------------------------------------------
  async findSheetSetBySha(orgId: string, projectId: string, sha256: string): Promise<SheetSetBundle | null> {
    return this.bundleFor(orgId, projectId, sha256);
  }

  private bundleFor(orgId: string, projectId: string, setId: string): SheetSetBundle | null {
    const set = this.docs.get(fsPaths.sheetSet(orgId, projectId, setId));
    if (!set) return null;
    const sheetHit = this.children(`orgs/${orgId}/projects/${projectId}/sheets`).find(([, d]) => d.sheetSetId === setId);
    if (!sheetHit) return null;
    const sheetId = sheetHit[0].split('/').at(-1) as string;
    const versionId = sheetHit[1].currentVersionId as string;
    const version = this.docs.get(fsPaths.version(orgId, projectId, sheetId, versionId));
    if (!version) return null;
    return {
      sheetSet: toSheetSet(orgId, projectId, setId, set),
      sheet: toSheet(sheetId, sheetHit[1]),
      sheetVersion: toVersion(sheetId, versionId, version),
      jobId: set.ingestJobId as string,
    };
  }

  createSheetSetBundle(orgId: string, projectId: string, input: NewSheetSet) {
    return this.tx(() => {
      const existing = this.bundleFor(orgId, projectId, input.sha256);
      if (existing) return { bundle: existing, deduplicated: true };
      if (!this.docs.has(fsPaths.project(orgId, projectId))) throw new Error('project does not exist');
      const now = this.now();
      const setId = input.sha256;
      const sheetId = autoId();
      const versionId = autoId();
      const jobId = autoId();
      const set: Doc = {
        fileKind: input.fileKind,
        sha256: input.sha256,
        storagePath: input.storagePath,
        status: 'uploaded',
        name: input.name,
        uploadedBy: input.uploadedBy,
        sizeBytes: input.sizeBytes,
        ingestJobId: jobId,
        createdAt: now,
      };
      const sheet: Doc = {
        logicalKey: `upload:${setId.slice(0, 12)}`,
        discipline: [],
        floorRegions: [],
        scale: null,
        currentVersionId: versionId,
        sheetSetId: setId,
      };
      const version: Doc = { versionNo: 1, status: 'uploaded', sha256: input.sha256, pageIndex: 0, artifacts: {}, createdAt: now };
      this.docs.set(fsPaths.sheetSet(orgId, projectId, setId), set);
      this.docs.set(fsPaths.sheet(orgId, projectId, sheetId), sheet);
      this.docs.set(fsPaths.version(orgId, projectId, sheetId, versionId), version);
      this.docs.set(fsPaths.job(jobId), {
        orgId,
        projectId,
        versionId,
        sheetId,
        sheetSetId: setId,
        type: input.jobType,
        status: 'queued',
        progress: 0,
        createdAt: now,
      });
      this.appendAuditSync(orgId, {
        actorId: input.uploadedBy,
        entity: 'sheetSets',
        entityId: setId,
        action: 'upload',
        after: { projectId, fileKind: input.fileKind, sha256: input.sha256, sizeBytes: input.sizeBytes },
      });
      return {
        bundle: {
          sheetSet: toSheetSet(orgId, projectId, setId, set),
          sheet: toSheet(sheetId, sheet),
          sheetVersion: toVersion(sheetId, versionId, version),
          jobId,
        },
        deduplicated: false,
      };
    });
  }

  async setVersionStatus(orgId: string, projectId: string, sheetId: string, versionId: string, status: SheetVersionStatus) {
    const path = fsPaths.version(orgId, projectId, sheetId, versionId);
    const d = this.docs.get(path);
    if (!d) throw new Error('version not found');
    this.docs.set(path, { ...d, status });
  }

  // --- audit --------------------------------------------------------------------
  appendAudit(orgId: string, event: AuditInput): Promise<void> {
    return this.tx(() => this.appendAuditSync(orgId, event));
  }

  private appendAuditSync(orgId: string, event: AuditInput): void {
    const log = this.children(`orgs/${orgId}/auditLog`).sort(
      ([, a], [, b]) => (a.at as Date).getTime() - (b.at as Date).getTime(),
    );
    const prevHash = (log.at(-1)?.[1].hash as string | undefined) ?? null;
    const at = this.now();
    const body = {
      actorId: event.actorId,
      actorKind: 'user',
      entity: event.entity,
      entityId: event.entityId,
      action: event.action,
      after: event.after ?? null,
      at: at.toISOString(),
    };
    this.docs.set(fsPaths.auditEvent(orgId, autoId()), { ...body, at, prevHash, hash: auditHash(prevHash, body) });
  }

  async ping(): Promise<void> {}
}

function toOrg(id: string, d: Doc): Org {
  return { id, name: String(d.name), settings: d.settings as Org['settings'], createdAt: iso(d.createdAt) };
}
function toMember(d: Doc): Member {
  return {
    uid: String(d.uid),
    role: d.role as Role,
    ...(d.email ? { email: String(d.email) } : {}),
    ...(d.addedBy ? { addedBy: String(d.addedBy) } : {}),
    createdAt: iso(d.createdAt),
  };
}
function toProject(id: string, d: Doc): Project {
  return {
    id,
    orgId: String(d.orgId),
    name: String(d.name),
    ...(typeof d.address === 'string' ? { address: d.address } : {}),
    templateId: (d.templateId as string | null | undefined) ?? null,
    floors: (d.floors as Project['floors']) ?? [],
    status: d.status as Project['status'],
    createdBy: String(d.createdBy),
    createdAt: iso(d.createdAt),
  };
}
function toSheetSet(orgId: string, projectId: string, id: string, d: Doc): SheetSet {
  return {
    id,
    orgId,
    projectId,
    fileKind: d.fileKind as SheetSet['fileKind'],
    sha256: String(d.sha256),
    storagePath: String(d.storagePath),
    status: d.status as SheetSet['status'],
    ...(typeof d.name === 'string' ? { name: d.name } : {}),
    uploadedBy: String(d.uploadedBy),
    createdAt: iso(d.createdAt),
  };
}
function toSheet(id: string, d: Doc): Sheet {
  return {
    id,
    logicalKey: String(d.logicalKey),
    discipline: (d.discipline as string[]) ?? [],
    floorRegions: (d.floorRegions as Sheet['floorRegions']) ?? [],
    scale: (d.scale as number | null) ?? null,
    currentVersionId: (d.currentVersionId as string | null) ?? null,
    sheetSetId: String(d.sheetSetId),
  };
}
function toVersion(sheetId: string, id: string, d: Doc): SheetVersion {
  return {
    id,
    sheetId,
    versionNo: Number(d.versionNo),
    status: d.status as SheetVersion['status'],
    sha256: String(d.sha256),
    pageIndex: Number(d.pageIndex),
    artifacts: (d.artifacts as SheetVersion['artifacts']) ?? {},
    createdAt: iso(d.createdAt),
  };
}

export const mappers = { toOrg, toMember, toProject, toSheetSet, toSheet, toVersion };
