import {
  BOQ_BUILD_STUCK_MS,
  DEFAULT_BOQ_RULES,
  DEFAULT_BOQ_TEMPLATE,
  defaultRuleDoc,
  fsPaths,
  ruleNeedsReseed,
  JOB_TYPES,
  type BoqBuild,
  type BoqExport,
  type BoqLine,
  type BoqRule,
  type BoqTemplate,
  type ItemLibraryItem,
  type LibraryImport,
  type PatchBoqLineRequest,
  type PatchBoqRuleRequest,
  type PatchBoqTemplateRequest,
  type PatchLibraryItemRequest,
  type ProcessingError,
  type StaleReason,
} from '@kamutan/contracts';
import { planLinePatch, toBoqBuild, toBoqLine, toLibraryImport, toLibraryItem, toRule, toTemplate } from './boq-docs';
import { MAX_BOQ_LINES, MAX_LIBRARY_ITEMS, type BoqRepository } from './boq-repository';
import { autoId, type InMemoryRepository } from './in-memory.repository';
import type { Doc } from './mappers';
import { RepoConflictError } from './repository';

const idOf = (path: string) => path.split('/').at(-1) as string;
const strip = <T extends { id: string }>(v: T): Omit<T, 'id'> => {
  const { id: _id, ...rest } = v;
  return rest;
};

/** In-memory Sprint 3 repository sharing the core in-memory store (docs map, transaction chain, audit chain). */
export class InMemoryBoqRepository implements BoqRepository {
  constructor(private readonly core: InMemoryRepository) {}

  private get docs() {
    return this.core.docs;
  }

  // --- library ---------------------------------------------------------------
  async listLibraryItems(orgId: string, opts: { chapter?: string; active?: boolean }): Promise<ItemLibraryItem[]> {
    return this.core
      .children(fsPaths.itemLibrary(orgId))
      .filter(([, d]) => (opts.chapter === undefined || d.chapter === opts.chapter) && (opts.active === undefined || (d.active ?? true) === opts.active))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, MAX_LIBRARY_ITEMS)
      .map(([k, d]) => toLibraryItem(idOf(k), d))
      .filter((x): x is ItemLibraryItem => x !== null);
  }

  async getLibraryItem(orgId: string, itemId: string): Promise<ItemLibraryItem | null> {
    const d = this.docs.get(fsPaths.libraryItem(orgId, itemId));
    return d ? toLibraryItem(itemId, d) : null;
  }

  createLibraryItem(orgId: string, item: Omit<ItemLibraryItem, 'updatedAt' | 'updatedBy'>, actorUid: string) {
    return this.core.tx(() => {
      const path = fsPaths.libraryItem(orgId, item.id);
      if (this.docs.has(path)) throw new RepoConflictError('exists');
      const doc: Doc = { ...strip(item), updatedAt: this.core.now(), updatedBy: actorUid };
      this.docs.set(path, doc);
      this.core.appendAuditSync(orgId, { actorId: actorUid, entity: 'itemLibrary', entityId: item.id, action: 'create', after: { code: item.code, chapter: item.chapter } });
      return toLibraryItem(item.id, doc) as ItemLibraryItem;
    });
  }

  patchLibraryItem(orgId: string, itemId: string, patch: PatchLibraryItemRequest, actorUid: string) {
    return this.core.tx(() => {
      const path = fsPaths.libraryItem(orgId, itemId);
      const d = this.docs.get(path);
      if (!d) return null;
      const next = { ...d, ...patch, updatedAt: this.core.now(), updatedBy: actorUid };
      this.docs.set(path, next);
      this.core.appendAuditSync(orgId, { actorId: actorUid, entity: 'itemLibrary', entityId: itemId, action: 'update', after: { fields: Object.keys(patch).sort(), active: patch.active ?? null } });
      return toLibraryItem(itemId, next);
    });
  }

  // --- imports ---------------------------------------------------------------
  async createLibraryImport(orgId: string, doc: LibraryImport): Promise<LibraryImport> {
    const stored: Doc = { ...strip(doc), createdAt: new Date(doc.createdAt), expiresAt: new Date(doc.expiresAt) };
    this.docs.set(fsPaths.libraryImport(orgId, doc.id), stored);
    return toLibraryImport(doc.id, stored);
  }

  async getLibraryImport(orgId: string, importId: string): Promise<LibraryImport | null> {
    const d = this.docs.get(fsPaths.libraryImport(orgId, importId));
    return d ? toLibraryImport(importId, d) : null;
  }

  queueLibraryImport(orgId: string, importId: string, actorUid: string) {
    return this.core.tx(() => {
      const path = fsPaths.libraryImport(orgId, importId);
      const d = this.docs.get(path);
      if (!d) return null;
      if (d.status !== 'awaiting_upload') return { doc: toLibraryImport(importId, d), jobId: (d.jobId as string | null) ?? null, created: false };
      const now = this.core.now();
      const jobId = autoId();
      this.docs.set(fsPaths.job(jobId), {
        orgId,
        projectId: d.projectId ?? null,
        sheetSetId: null,
        importId,
        type: JOB_TYPES.libraryImport,
        status: 'queued',
        progress: { stage: 'import', pct: 0 },
        attempts: 0,
        error: null,
        createdBy: actorUid,
        createdAt: now,
        updatedAt: now,
      });
      const next = { ...d, status: 'queued', jobId, finalizedAt: now };
      this.docs.set(path, next);
      this.core.appendAuditSync(orgId, {
        actorId: actorUid,
        entity: 'libraryImports',
        entityId: importId,
        action: 'finalize',
        after: { jobId, sourceKind: d.sourceKind, sizeBytes: d.sizeBytes, projectId: d.projectId ?? null },
      });
      return { doc: toLibraryImport(importId, next), jobId, created: true };
    });
  }

  async failLibraryImport(orgId: string, importId: string, status: 'rejected' | 'failed', error: ProcessingError): Promise<void> {
    const path = fsPaths.libraryImport(orgId, importId);
    const d = this.docs.get(path);
    if (!d) return;
    this.docs.set(path, { ...d, status, error });
    const jobId = d.jobId as string | null | undefined;
    const job = jobId ? this.docs.get(fsPaths.job(jobId)) : undefined;
    if (jobId && job && job.orgId === orgId) this.docs.set(fsPaths.job(jobId), { ...job, status: 'failed', error, updatedAt: this.core.now() });
  }

  // --- templates & rules ---------------------------------------------------------
  seedDefaults(orgId: string) {
    return this.core.tx(() => {
      let templates = 0;
      let rules = 0;
      const tplPath = fsPaths.boqTemplate(orgId, DEFAULT_BOQ_TEMPLATE.id);
      if (!this.docs.has(tplPath)) {
        const hasDefault = this.core.children(fsPaths.boqTemplates(orgId)).some(([, d]) => d.default === true);
        this.docs.set(tplPath, { ...strip(structuredClone(DEFAULT_BOQ_TEMPLATE) as BoqTemplate), default: !hasDefault, updatedAt: this.core.now(), updatedBy: null });
        templates++;
      }
      for (const r of DEFAULT_BOQ_RULES) {
        const p = fsPaths.boqRule(orgId, r.id);
        if (!ruleNeedsReseed(this.docs.get(p) as { source?: string; defaultsVersion?: number } | undefined)) continue;
        this.docs.set(p, { ...strip(structuredClone(defaultRuleDoc(r))), updatedAt: this.core.now(), updatedBy: null });
        rules++;
      }
      return { templates, rules };
    });
  }

  async listTemplates(orgId: string): Promise<BoqTemplate[]> {
    return this.core
      .children(fsPaths.boqTemplates(orgId))
      .map(([k, d]) => toTemplate(idOf(k), d))
      .filter((t): t is BoqTemplate => t !== null)
      .sort((a, b) => Number(b.default) - Number(a.default) || a.name.localeCompare(b.name));
  }

  async getTemplate(orgId: string, templateId: string): Promise<BoqTemplate | null> {
    const d = this.docs.get(fsPaths.boqTemplate(orgId, templateId));
    return d ? toTemplate(templateId, d) : null;
  }

  patchTemplate(orgId: string, templateId: string, patch: PatchBoqTemplateRequest, actorUid: string) {
    return this.core.tx(() => {
      const path = fsPaths.boqTemplate(orgId, templateId);
      const d = this.docs.get(path);
      if (!d) return null;
      const now = this.core.now();
      if (patch.default) {
        for (const [k, o] of this.core.children(fsPaths.boqTemplates(orgId))) if (k !== path && o.default === true) this.docs.set(k, { ...o, default: false, updatedAt: now });
      }
      const next = { ...d, ...patch, updatedAt: now, updatedBy: actorUid };
      this.docs.set(path, next);
      this.core.appendAuditSync(orgId, { actorId: actorUid, entity: 'boqTemplates', entityId: templateId, action: 'update', after: { fields: Object.keys(patch).sort() } });
      return toTemplate(templateId, next);
    });
  }

  async listRules(orgId: string): Promise<BoqRule[]> {
    return this.core
      .children(fsPaths.boqRules(orgId))
      .map(([k, d]) => toRule(idOf(k), d))
      .filter((r): r is BoqRule => r !== null)
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  }

  patchRule(orgId: string, ruleId: string, patch: PatchBoqRuleRequest, actorUid: string) {
    return this.core.tx(() => {
      const path = fsPaths.boqRule(orgId, ruleId);
      const d = this.docs.get(path);
      if (!d) return null;
      // An admin edit turns a shipped default into a user rule: re-seeding never overwrites it again.
      const next = { ...d, ...patch, ...(d.source === 'default' ? { source: 'user' } : {}), updatedAt: this.core.now(), updatedBy: actorUid };
      const rule = toRule(ruleId, next);
      if (!rule) throw new RepoConflictError('invalid_rule');
      this.docs.set(path, next);
      this.core.appendAuditSync(orgId, { actorId: actorUid, entity: 'boqRules', entityId: ruleId, action: 'update', after: ruleAudit(d, patch) });
      return rule;
    });
  }

  // --- builds --------------------------------------------------------------------
  requestBuild(orgId: string, projectId: string, actorUid: string, jobType: string) {
    return this.core.tx(() => {
      const pPath = fsPaths.project(orgId, projectId);
      const project = this.docs.get(pPath);
      if (!project) return null;
      const boq = (project.boq as Doc | undefined) ?? {};
      const pendingId = typeof boq.pendingBuildId === 'string' ? boq.pendingBuildId : null;
      if (pendingId) {
        const pending = this.docs.get(fsPaths.boqBuild(orgId, projectId, pendingId));
        if (pending && isActive(pending.status, pending.createdAt as Date | undefined, Date.now())) {
          return { build: toBoqBuild(pendingId, pending), jobId: (pending.jobId as string | null) ?? null, deduplicated: true };
        }
      }
      const now = this.core.now();
      const buildId = autoId();
      const jobId = autoId();
      const build: Doc = { status: 'queued', jobId, requestedBy: actorUid, createdAt: now, startedAt: null, finishedAt: null, stats: null, error: null, evidenceRef: null };
      this.docs.set(fsPaths.boqBuild(orgId, projectId, buildId), build);
      this.docs.set(fsPaths.job(jobId), {
        orgId,
        projectId,
        sheetSetId: null,
        buildId,
        type: jobType,
        status: 'queued',
        progress: { stage: 'boq', pct: 0 },
        attempts: 0,
        error: null,
        createdBy: actorUid,
        createdAt: now,
        updatedAt: now,
      });
      this.docs.set(pPath, {
        ...project,
        boq: { latestBuildId: boq.latestBuildId ?? null, builtAt: boq.builtAt ?? null, stale: boq.stale ?? true, ...boq, pendingBuildId: buildId },
      });
      this.core.appendAuditSync(orgId, { actorId: actorUid, entity: 'boqBuilds', entityId: buildId, action: 'request', after: { projectId, jobId } });
      return { build: toBoqBuild(buildId, build), jobId, deduplicated: false };
    });
  }

  async failBuild(orgId: string, projectId: string, buildId: string, jobId: string, error: ProcessingError): Promise<void> {
    const now = this.core.now();
    const bPath = fsPaths.boqBuild(orgId, projectId, buildId);
    const b = this.docs.get(bPath);
    if (b) this.docs.set(bPath, { ...b, status: 'failed', error, finishedAt: now });
    const job = this.docs.get(fsPaths.job(jobId));
    if (job && job.orgId === orgId) this.docs.set(fsPaths.job(jobId), { ...job, status: 'failed', error, updatedAt: now });
    const pPath = fsPaths.project(orgId, projectId);
    const p = this.docs.get(pPath);
    const boq = p?.boq as Doc | undefined;
    if (p && boq && boq.pendingBuildId === buildId) this.docs.set(pPath, { ...p, boq: { ...boq, pendingBuildId: null } });
  }

  async getBuild(orgId: string, projectId: string, buildId: string): Promise<BoqBuild | null> {
    const d = this.docs.get(fsPaths.boqBuild(orgId, projectId, buildId));
    return d ? toBoqBuild(buildId, d) : null;
  }

  async markStale(orgId: string, projectId: string, reason: StaleReason): Promise<void> {
    const pPath = fsPaths.project(orgId, projectId);
    const p = this.docs.get(pPath);
    if (!p) return;
    const boq = (p.boq as Doc | undefined) ?? { latestBuildId: null, builtAt: null };
    this.docs.set(pPath, { ...p, boq: { ...boq, stale: true, staleReason: reason, staleAt: this.core.now() } });
  }

  async markOrgStale(orgId: string, reason: StaleReason): Promise<number> {
    const projects = this.core.children(`orgs/${orgId}/projects`);
    for (const [k] of projects) await this.markStale(orgId, idOf(k), reason);
    return projects.length;
  }

  // --- lines -----------------------------------------------------------------------
  async listLines(orgId: string, projectId: string): Promise<BoqLine[]> {
    return this.core
      .children(fsPaths.boqLines(orgId, projectId))
      .slice(0, MAX_BOQ_LINES)
      .map(([k, d]) => toBoqLine(idOf(k), d));
  }

  async getLine(orgId: string, projectId: string, lineId: string): Promise<BoqLine | null> {
    const d = this.docs.get(fsPaths.boqLine(orgId, projectId, lineId));
    return d ? toBoqLine(lineId, d) : null;
  }

  patchLine(orgId: string, projectId: string, lineId: string, req: PatchBoqLineRequest, actorUid: string) {
    return this.core.tx(() => {
      const path = fsPaths.boqLine(orgId, projectId, lineId);
      const d = this.docs.get(path);
      if (!d) return null;
      const { patch, audit } = planLinePatch(projectId, toBoqLine(lineId, d), req, actorUid, this.core.now());
      const next = { ...d, ...patch };
      this.docs.set(path, next);
      this.core.appendAuditSync(orgId, { actorId: actorUid, entity: 'boqLines', entityId: lineId, action: 'update', after: audit });
      return toBoqLine(lineId, next);
    });
  }

  /** Test helper: a line as the worker writes it. */
  seedLine(orgId: string, projectId: string, line: Partial<BoqLine> & { id: string; code: string }): BoqLine {
    const doc: Doc = {
      chapter: '04',
      description: line.code,
      qty: 1,
      unit: 'יחידה',
      level: 'green',
      reasons: [],
      status: 'draft',
      byFloor: {},
      evidenceCount: 0,
      ruleId: null,
      sourceVersions: [],
      computedAt: this.core.now(),
      ...strip(line),
    };
    this.docs.set(fsPaths.boqLine(orgId, projectId, line.id), doc);
    return toBoqLine(line.id, doc);
  }

  // --- exports ---------------------------------------------------------------------
  createExport(orgId: string, projectId: string, doc: BoqExport) {
    return this.core.tx(() => {
      this.docs.set(fsPaths.boqExport(orgId, projectId, doc.id), { ...strip(doc), createdAt: new Date(doc.createdAt) });
      this.core.appendAuditSync(orgId, {
        actorId: doc.createdBy,
        entity: 'exports',
        entityId: doc.id,
        action: 'create',
        after: { projectId, templateId: doc.templateId, split: doc.split, markDraft: doc.markDraft, buildId: doc.buildId, sha256: doc.sha256, lines: doc.counts.lines, red: doc.counts.red, yellow: doc.counts.yellow },
      });
      return doc;
    });
  }
}

/** queued/running and younger than BOQ_BUILD_STUCK_MS. */
export function isActive(status: unknown, createdAt: Date | undefined, nowMs: number): boolean {
  if (status !== 'queued' && status !== 'running') return false;
  return !createdAt || nowMs - createdAt.getTime() < BOQ_BUILD_STUCK_MS;
}

export function ruleAudit(before: Doc, patch: PatchBoqRuleRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(patch) as Array<keyof PatchBoqRuleRequest>) out[k] = { from: before[k] ?? null, to: patch[k] ?? null };
  return out;
}
