import { randomBytes } from 'node:crypto';
import {
  DEFAULT_ORG_SETTINGS,
  fsPaths,
  sheetIdFor,
  storagePaths,
  type Job,
  type LegendEntry,
  type LegendEntryStatus,
  type Member,
  type Org,
  type ProcessingError,
  type Project,
  type Region,
  type Role,
  type Sheet,
  type SheetSet,
  type SheetSetStatus,
  type SheetSummary,
  type SheetVersion,
  type SymbolMapping,
} from '@kamutan/contracts';
import { auditHash } from './audit-chain';
import { clusterLegendEntryDoc, decisionLabel, legendDecisionAudit, legendDecisionPatch, mappingDoc, resolveClusterAudit } from './legend-docs';
import { toJob, toLegendEntry, toMember, toOrg, toProject, toSheet, toSheetSet, toSymbolMapping, toVersion, versionSummary, type Doc } from './mappers';
import {
  RepoConflictError,
  type AuditInput,
  type ConfirmInput,
  type LegendDecision,
  type NewSheetSet,
  type ReprocessResult,
  type Repository,
  type ResolveClusterInput,
} from './repository';

/** Firestore-like 20-char auto id. */
export function autoId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(20);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}


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
  async getSheetSet(orgId: string, projectId: string, sheetSetId: string): Promise<SheetSet | null> {
    const d = this.docs.get(fsPaths.sheetSet(orgId, projectId, sheetSetId));
    return d ? toSheetSet(orgId, projectId, sheetSetId, d) : null;
  }

  createSheetSetIngest(orgId: string, projectId: string, input: NewSheetSet) {
    return this.tx(() => {
      const setPath = fsPaths.sheetSet(orgId, projectId, input.sha256);
      const existing = this.docs.get(setPath);
      if (existing) return { sheetSet: toSheetSet(orgId, projectId, input.sha256, existing), deduplicated: true };
      if (!this.docs.has(fsPaths.project(orgId, projectId))) throw new Error('project does not exist');
      const now = this.now();
      const setId = input.sha256;
      const versionId = autoId();
      const jobId = autoId();
      const set: Doc = {
        fileKind: input.fileKind,
        sha256: input.sha256,
        storagePath: input.storagePath,
        status: 'uploaded',
        name: input.name,
        uploadedBy: input.uploadedBy,
        uploadFileId: input.uploadFileId,
        sizeBytes: input.sizeBytes,
        ingestJobId: jobId,
        versionId,
        pageCount: null,
        createdAt: now,
      };
      this.docs.set(setPath, set);
      this.docs.set(fsPaths.job(jobId), {
        orgId,
        projectId,
        sheetSetId: setId,
        sheetId: null,
        versionId,
        type: input.jobType,
        status: 'queued',
        progress: { stage: 'ingest', pct: 0 },
        attempts: 0,
        error: null,
        createdBy: input.uploadedBy,
        createdAt: now,
        updatedAt: now,
      });
      this.appendAuditSync(orgId, {
        actorId: input.uploadedBy,
        entity: 'sheetSets',
        entityId: setId,
        action: 'upload',
        after: { projectId, fileKind: input.fileKind, sha256: input.sha256, sizeBytes: input.sizeBytes, jobId },
      });
      return { sheetSet: toSheetSet(orgId, projectId, setId, set), deduplicated: false };
    });
  }

  async findSheetSetByUploadFileId(orgId: string, projectId: string, fileId: string): Promise<SheetSet | null> {
    const hit = this.children(`orgs/${orgId}/projects/${projectId}/sheetSets`).find(([, d]) => d.uploadFileId === fileId);
    return hit ? toSheetSet(orgId, projectId, hit[0].split('/').at(-1) as string, hit[1]) : null;
  }

  async setSheetSetStatus(orgId: string, projectId: string, sheetSetId: string, status: SheetSetStatus) {
    const path = fsPaths.sheetSet(orgId, projectId, sheetSetId);
    const d = this.docs.get(path);
    if (!d) throw new Error('sheet set not found');
    this.docs.set(path, { ...d, status });
  }

  // --- sheets & versions -------------------------------------------------------
  async listSheets(orgId: string, projectId: string, opts: { limit: number; cursor?: string; sheetSetId?: string }) {
    const all = this.children(fsPaths.sheets(orgId, projectId))
      .map(([k, d]) => [k.split('/').at(-1) as string, d] as const)
      .filter(([, d]) => !opts.sheetSetId || d.sheetSetId === opts.sheetSetId)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const start = opts.cursor ? all.filter(([id]) => id <= (opts.cursor as string)).length : 0;
    const page = all.slice(start, start + opts.limit);
    const items: SheetSummary[] = page.map(([id, d]) => {
      const sheet = toSheet(id, d);
      const vd = sheet.currentVersionId ? this.docs.get(fsPaths.version(orgId, projectId, id, sheet.currentVersionId)) : undefined;
      return { ...sheet, currentVersion: versionSummary(vd && sheet.currentVersionId ? toVersion(id, sheet.currentVersionId, vd) : null) };
    });
    const more = all.length > start + opts.limit;
    return { items, nextCursor: more && items.length ? (items.at(-1) as SheetSummary).id : null };
  }

  async getSheet(orgId: string, projectId: string, sheetId: string): Promise<Sheet | null> {
    const d = this.docs.get(fsPaths.sheet(orgId, projectId, sheetId));
    return d ? toSheet(sheetId, d) : null;
  }

  async getVersion(orgId: string, projectId: string, sheetId: string, versionId: string): Promise<SheetVersion | null> {
    const d = this.docs.get(fsPaths.version(orgId, projectId, sheetId, versionId));
    return d ? toVersion(sheetId, versionId, d) : null;
  }

  confirmSheet(orgId: string, projectId: string, sheetId: string, input: ConfirmInput, actorUid: string) {
    return this.tx(() => {
      const path = fsPaths.sheet(orgId, projectId, sheetId);
      const d = this.docs.get(path);
      if (!d) return null;
      if ((d.currentVersionId ?? null) !== input.expectedVersionId) throw new RepoConflictError('version_changed');
      const now = this.now();
      if (input.regions && input.expectedVersionId) {
        const vPath = fsPaths.version(orgId, projectId, sheetId, input.expectedVersionId);
        const v = this.docs.get(vPath);
        if (!v) throw new RepoConflictError('version_missing');
        this.docs.set(vPath, { ...v, regions: input.regions, regionsUpdatedBy: actorUid, regionsUpdatedAt: now });
      }
      const next = {
        ...d,
        discipline: input.discipline,
        floors: input.floors,
        scaleDenominator: input.scaleDenominator,
        confirmed: true,
        confirmedBy: actorUid,
        confirmedAt: now,
        updatedAt: now,
      };
      this.docs.set(path, next);
      this.appendAuditSync(orgId, {
        actorId: actorUid,
        entity: 'sheets',
        entityId: sheetId,
        action: 'confirm',
        after: confirmAudit(projectId, input),
      });
      return toSheet(sheetId, next);
    });
  }

  setRegions(orgId: string, projectId: string, sheetId: string, versionId: string, regions: Region[], actorUid: string) {
    return this.tx(() => {
      const sheet = this.docs.get(fsPaths.sheet(orgId, projectId, sheetId));
      if (!sheet) return null;
      if (sheet.currentVersionId !== versionId) throw new RepoConflictError('version_changed');
      const vPath = fsPaths.version(orgId, projectId, sheetId, versionId);
      const v = this.docs.get(vPath);
      if (!v) return null;
      const now = this.now();
      const next = { ...v, regions, regionsUpdatedBy: actorUid, regionsUpdatedAt: now };
      this.docs.set(vPath, next);
      this.appendAuditSync(orgId, {
        actorId: actorUid,
        entity: 'sheetVersions',
        entityId: versionId,
        action: 'set_regions',
        after: regionsAudit(projectId, sheetId, regions),
      });
      return toVersion(sheetId, versionId, next);
    });
  }

  createReprocessVersion(orgId: string, projectId: string, sheetId: string, actorUid: string, jobType: string) {
    return this.tx((): ReprocessResult | null => {
      const sPath = fsPaths.sheet(orgId, projectId, sheetId);
      const sheetDoc = this.docs.get(sPath);
      if (!sheetDoc) return null;
      const sheet = toSheet(sheetId, sheetDoc);
      const setDoc = this.docs.get(fsPaths.sheetSet(orgId, projectId, sheet.sheetSetId));
      if (!setDoc) return null;
      const cur = sheet.currentVersionId ? this.docs.get(fsPaths.version(orgId, projectId, sheetId, sheet.currentVersionId)) : undefined;
      const curV = cur && sheet.currentVersionId ? toVersion(sheetId, sheet.currentVersionId, cur) : null;
      if (curV && (curV.status === 'queued' || curV.status === 'processing')) throw new RepoConflictError('in_progress');
      const now = this.now();
      const versionId = autoId();
      const jobId = autoId();
      const version: Doc = newVersionDoc(curV, jobId, now);
      this.docs.set(fsPaths.version(orgId, projectId, sheetId, versionId), version);
      this.docs.set(fsPaths.job(jobId), {
        orgId,
        projectId,
        sheetSetId: sheet.sheetSetId,
        sheetId,
        versionId,
        type: jobType,
        status: 'queued',
        progress: { stage: 'ingest', pct: 0 },
        attempts: 0,
        error: null,
        createdBy: actorUid,
        createdAt: now,
        updatedAt: now,
      });
      const nextSheet = { ...sheetDoc, currentVersionId: versionId, updatedAt: now };
      this.docs.set(sPath, nextSheet);
      this.appendAuditSync(orgId, {
        actorId: actorUid,
        entity: 'sheets',
        entityId: sheetId,
        action: 'reprocess',
        after: { projectId, versionId, previousVersionId: sheet.currentVersionId, jobId },
      });
      return {
        sheet: toSheet(sheetId, nextSheet),
        version: toVersion(sheetId, versionId, version),
        sheetSet: toSheetSet(orgId, projectId, sheet.sheetSetId, setDoc),
        jobId,
      };
    });
  }

  async failJob(orgId: string, jobId: string, error: ProcessingError, version?: { projectId: string; sheetId: string; versionId: string }) {
    const now = this.now();
    const job = this.docs.get(fsPaths.job(jobId));
    if (job && job.orgId === orgId) this.docs.set(fsPaths.job(jobId), { ...job, status: 'failed', error, updatedAt: now });
    if (version) {
      const p = fsPaths.version(orgId, version.projectId, version.sheetId, version.versionId);
      const v = this.docs.get(p);
      if (v) this.docs.set(p, { ...v, status: 'failed', error, updatedAt: now });
    }
  }

  // --- legend entries & symbol mappings ---------------------------------------------
  async listLegendEntries(orgId: string, projectId: string, opts: { limit: number; cursor?: string; status?: LegendEntryStatus; sheetId?: string }) {
    const all = this.children(fsPaths.legendEntries(orgId, projectId))
      .map(([k, d]) => [k.split('/').at(-1) as string, d] as const)
      .filter(([, d]) => (!opts.status || d.status === opts.status) && (!opts.sheetId || d.sheetId === opts.sheetId))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const start = opts.cursor ? all.filter(([id]) => id <= (opts.cursor as string)).length : 0;
    const items = all.slice(start, start + opts.limit).map(([id, d]) => toLegendEntry(id, d));
    const more = all.length > start + opts.limit;
    return { items, nextCursor: more && items.length ? (items.at(-1) as LegendEntry).id : null };
  }

  async getLegendEntry(orgId: string, projectId: string, entryId: string): Promise<LegendEntry | null> {
    const d = this.docs.get(fsPaths.legendEntry(orgId, projectId, entryId));
    return d ? toLegendEntry(entryId, d) : null;
  }

  decideLegendEntry(orgId: string, projectId: string, entryId: string, decision: LegendDecision, actorUid: string) {
    return this.tx(() => {
      const path = fsPaths.legendEntry(orgId, projectId, entryId);
      const d = this.docs.get(path);
      if (!d) return null;
      const cur = toLegendEntry(entryId, d);
      const now = this.now();
      const patch = legendDecisionPatch(cur, decision, actorUid, now);
      let mapping: SymbolMapping | null = null;
      if (decision.action !== 'ignore') {
        const mPath = fsPaths.symbolMapping(orgId, cur.signature);
        const m = mappingDoc(this.docs.get(mPath), { class: decision.class, itemCode: patch.itemCode as string | null, label: decisionLabel(cur, decision) }, actorUid, now);
        this.docs.set(mPath, m);
        mapping = toSymbolMapping(cur.signature, m);
      }
      const next = { ...d, ...patch };
      this.docs.set(path, next);
      this.appendAuditSync(orgId, legendDecisionAudit(projectId, cur, decision, patch, mapping?.uses ?? null, actorUid));
      return { entry: toLegendEntry(entryId, next), mapping };
    });
  }

  resolveUnknownCluster(orgId: string, projectId: string, input: ResolveClusterInput, actorUid: string) {
    return this.tx(() => {
      const now = this.now();
      const mPath = fsPaths.symbolMapping(orgId, input.signature);
      const m = mappingDoc(this.docs.get(mPath), input, actorUid, now);
      this.docs.set(mPath, m);
      let legendEntry: LegendEntry | null = null;
      if (input.legendEntry) {
        const doc = clusterLegendEntryDoc(input, input.legendEntry.thumbPath, actorUid, now);
        this.docs.set(fsPaths.legendEntry(orgId, projectId, input.legendEntry.id), doc);
        legendEntry = toLegendEntry(input.legendEntry.id, doc);
      }
      const mapping = toSymbolMapping(input.signature, m);
      this.appendAuditSync(orgId, resolveClusterAudit(projectId, input, mapping.uses, actorUid));
      return { mapping, legendEntry };
    });
  }

  async getSymbolMapping(orgId: string, signature: string): Promise<SymbolMapping | null> {
    const d = this.docs.get(fsPaths.symbolMapping(orgId, signature));
    return d ? toSymbolMapping(signature, d) : null;
  }

  /** Test helper: a `suggested` legend entry as the worker writes it. */
  seedLegendEntry(orgId: string, projectId: string, id: string, fields: Partial<Doc> & { sheetId: string; versionId: string; signature: string }): LegendEntry {
    const doc: Doc = {
      label: 'שקע כפול',
      labelConfidence: 0.9,
      suggestedClass: 'socket_double',
      class: null,
      itemCode: null,
      thumbPath: null,
      status: 'suggested',
      updatedAt: this.now(),
      ...fields,
    };
    this.docs.set(fsPaths.legendEntry(orgId, projectId, id), doc);
    return toLegendEntry(id, doc);
  }

  // --- jobs ---------------------------------------------------------------------
  async getJob(jobId: string): Promise<Job | null> {
    const d = this.docs.get(fsPaths.job(jobId));
    return d ? toJob(jobId, d) : null;
  }

  // --- worker emulation (tests / offline dev) -------------------------------------
  /** Writes a sheet + version doc as the worker would after splitting/processing. */
  seedWorkerSheet(orgId: string, projectId: string, sheetSetId: string, pageIndex: number, opts: SeedSheetOpts = {}): { sheetId: string; versionId: string } {
    const sheetId = sheetIdFor(sheetSetId, pageIndex);
    const versionId = opts.versionId ?? autoId();
    const now = this.now();
    this.docs.set(fsPaths.sheet(orgId, projectId, sheetId), {
      sheetSetId,
      pageIndex,
      title: opts.title ?? `Sheet ${pageIndex + 1}`,
      discipline: opts.discipline ?? 'electrical',
      floors: opts.floors ?? ['ground'],
      scaleDenominator: opts.scaleDenominator ?? 50,
      classification: {
        discipline: opts.discipline ?? 'electrical',
        floors: opts.floors ?? ['ground'],
        sheetTitle: opts.title ?? `Sheet ${pageIndex + 1}`,
        scaleText: '1:50',
        confidence: 0.8,
        level: 'yellow',
        reasons: ['seeded'],
      },
      confirmed: false,
      currentVersionId: versionId,
      updatedAt: now,
    });
    const status = opts.status ?? 'ready';
    this.docs.set(fsPaths.version(orgId, projectId, sheetId, versionId), {
      versionNo: 1,
      status,
      progress: status === 'ready' ? { stage: 'done', pct: 100 } : { stage: 'render', pct: 40 },
      page: { widthMm: opts.widthMm ?? 841, heightMm: opts.heightMm ?? 594, rotation: 0 },
      artifacts:
        status === 'ready'
          ? {
              tiles: {
                prefix: storagePaths.tilesPrefix(orgId, projectId, sheetId, versionId),
                format: 'webp',
                tileSize: 256,
                dpi: 300,
                levels: opts.levels ?? 7,
                widthPx: opts.widthPx ?? 9933,
                heightPx: opts.heightPx ?? 7016,
              },
              thumbnail: storagePaths.thumbnail(orgId, projectId, sheetId, versionId),
              primitives: storagePaths.primitives(orgId, projectId, sheetId, versionId),
              text: storagePaths.text(orgId, projectId, sheetId, versionId),
              ...(opts.understanding
                ? {
                    legend: storagePaths.legend(orgId, projectId, sheetId, versionId),
                    detections: storagePaths.detections(orgId, projectId, sheetId, versionId),
                    rooms: storagePaths.rooms(orgId, projectId, sheetId, versionId),
                  }
                : {}),
            }
          : {},
      regions: [],
      stats:
        status === 'ready'
          ? {
              paths: 10,
              segments: 100,
              textLines: 5,
              glyphs: 50,
              ...(opts.understanding
                ? { detections: { total: 2, green: 1, yellow: 0, red: 1, unknown: 1, byClass: { socket_double: 1, unknown: 1 } }, rooms: 1, legendEntries: 1 }
                : {}),
            }
          : null,
      workerVersion: 'test',
      updatedAt: now,
    });
    return { sheetId, versionId };
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

export interface SeedSheetOpts {
  versionId?: string;
  status?: 'queued' | 'processing' | 'ready' | 'failed';
  title?: string;
  discipline?: string;
  floors?: string[];
  scaleDenominator?: number;
  widthMm?: number;
  heightMm?: number;
  widthPx?: number;
  heightPx?: number;
  levels?: number;
  /** Sprint 2: also reference legend/detections/rooms artifacts + stats. */
  understanding?: boolean;
}

export function confirmAudit(projectId: string, input: ConfirmInput): Record<string, unknown> {
  return {
    projectId,
    discipline: input.discipline,
    floors: input.floors,
    scaleDenominator: input.scaleDenominator,
    versionId: input.expectedVersionId,
    regionCount: input.regions ? input.regions.length : null,
  };
}

export function regionsAudit(projectId: string, sheetId: string, regions: Region[]): Record<string, unknown> {
  return {
    projectId,
    sheetId,
    regions: regions.map((r) => ({ id: r.id, floor: r.floor, scaleDenominator: r.scaleDenominator, points: r.polygonMm.length })),
  };
}

/** New queued version for a reprocess: regions (user corrections) carry over from the previous version. */
export function newVersionDoc(prev: SheetVersion | null, jobId: string, now: unknown): Doc {
  return {
    versionNo: (prev?.versionNo ?? 1) + 1,
    status: 'queued',
    progress: { stage: 'ingest', pct: 0 },
    error: null,
    page: prev?.page ?? null,
    artifacts: {},
    regions: prev?.regions ?? [],
    stats: null,
    workerVersion: null,
    jobId,
    createdAt: now,
    updatedAt: now,
  };
}

export { mappers } from './mappers';
