import {
  fsPaths,
  JOB_TYPES,
  roomSettingsId,
  type Correction,
  type CorrectionBatch,
  type CreateCorrectionRequest,
  type ProcessingError,
  type RoomSettings,
  type SimilarExemplar,
  type SimilarSearch,
} from '@kamutan/contracts';
import { toBoqBuild } from './boq-docs';
import { autoId, type InMemoryRepository } from './in-memory.repository';
import type { Doc } from './mappers';
import { RepoConflictError } from './repository';
import {
  batchAudit,
  batchDoc,
  correctionAudit,
  correctionDoc,
  MAX_CORRECTIONS,
  planAutoBuild,
  roomSettingsAudit,
  toBatch,
  toCorrection,
  toRoomSettings,
  toSimilarSearch,
  type ActiveBuildInfo,
  type NewCorrectionBatch,
  type ReviewRepository,
  type ScheduleBuildInput,
  type ScheduleBuildResult,
} from './review-repository';

const idOf = (path: string) => path.split('/').at(-1) as string;

/** In-memory Sprint 4 repository sharing the core store (docs map, transactions, audit chain). */
export class InMemoryReviewRepository implements ReviewRepository {
  constructor(private readonly core: InMemoryRepository) {}

  private get docs() {
    return this.core.docs;
  }

  // --- corrections ---------------------------------------------------------------
  createCorrections(orgId: string, projectId: string, items: readonly CreateCorrectionRequest[], batch: NewCorrectionBatch | null, actorUid: string) {
    return this.core.tx(() => {
      const at = this.core.now();
      const batchId = batch ? autoId() : null;
      const corrections: Correction[] = [];
      for (const it of items) {
        const id = autoId();
        const doc = { ...correctionDoc(it, batchId, actorUid), at };
        this.docs.set(fsPaths.correction(orgId, projectId, id), doc);
        const c = toCorrection(id, doc);
        if (!c) throw new Error('correction did not round-trip');
        corrections.push(c);
      }
      let b: CorrectionBatch | null = null;
      if (batch && batchId) {
        const doc = { ...batchDoc(items, batch, actorUid), at };
        this.docs.set(fsPaths.correctionBatch(orgId, projectId, batchId), doc);
        b = toBatch(batchId, doc);
        this.core.appendAuditSync(orgId, { actorId: actorUid, entity: 'corrections', entityId: batchId, action: 'batch', after: batchAudit(projectId, b as CorrectionBatch, corrections.map((c) => c.id)) });
      } else {
        const c = corrections[0] as Correction;
        this.core.appendAuditSync(orgId, { actorId: actorUid, entity: 'corrections', entityId: c.id, action: 'create', after: correctionAudit(projectId, c) });
      }
      return { corrections, batch: b };
    });
  }

  async getCorrection(orgId: string, projectId: string, correctionId: string): Promise<Correction | null> {
    const d = this.docs.get(fsPaths.correction(orgId, projectId, correctionId));
    return d ? toCorrection(correctionId, d) : null;
  }

  async listCorrections(orgId: string, projectId: string, filter: { sheetId?: string; batchId?: string }): Promise<Correction[]> {
    return this.core
      .children(fsPaths.corrections(orgId, projectId))
      .filter(([, d]) => (filter.sheetId === undefined || d.sheetId === filter.sheetId) && (filter.batchId === undefined || d.batchId === filter.batchId))
      .slice(0, MAX_CORRECTIONS)
      .map(([k, d]) => toCorrection(idOf(k), d))
      .filter((c): c is Correction => c !== null);
  }

  revertCorrection(orgId: string, projectId: string, correctionId: string, actorUid: string) {
    return this.core.tx(() => {
      const path = fsPaths.correction(orgId, projectId, correctionId);
      const d = this.docs.get(path);
      if (!d) return null;
      if (d.revertedAt) throw new RepoConflictError('already_reverted');
      const next = { ...d, revertedAt: this.core.now(), revertedBy: actorUid };
      this.docs.set(path, next);
      this.core.appendAuditSync(orgId, { actorId: actorUid, entity: 'corrections', entityId: correctionId, action: 'revert', after: { projectId, kind: d.kind, batchId: d.batchId ?? null } });
      return toCorrection(correctionId, next);
    });
  }

  async getBatch(orgId: string, projectId: string, batchId: string): Promise<CorrectionBatch | null> {
    const d = this.docs.get(fsPaths.correctionBatch(orgId, projectId, batchId));
    return d ? toBatch(batchId, d) : null;
  }

  revertBatch(orgId: string, projectId: string, batchId: string, actorUid: string) {
    return this.core.tx(() => {
      const bPath = fsPaths.correctionBatch(orgId, projectId, batchId);
      const b = this.docs.get(bPath);
      if (!b) return null;
      if (b.revertedAt) throw new RepoConflictError('already_reverted');
      const now = this.core.now();
      let reverted = 0;
      for (const [k, d] of this.core.children(fsPaths.corrections(orgId, projectId))) {
        if (d.batchId !== batchId || d.revertedAt) continue;
        this.docs.set(k, { ...d, revertedAt: now, revertedBy: actorUid });
        reverted++;
      }
      const next = { ...b, revertedAt: now, revertedBy: actorUid };
      this.docs.set(bPath, next);
      this.core.appendAuditSync(orgId, { actorId: actorUid, entity: 'corrections', entityId: batchId, action: 'revert_batch', after: { projectId, reverted } });
      return { batch: toBatch(batchId, next) as CorrectionBatch, reverted };
    });
  }

  // --- room settings ----------------------------------------------------------------
  async getRoomSettings(orgId: string, projectId: string, sheetId: string, roomId: string): Promise<RoomSettings | null> {
    const d = this.docs.get(fsPaths.roomSettings(orgId, projectId, sheetId, roomId));
    return d ? toRoomSettings(d) : null;
  }

  async listRoomSettingsIds(orgId: string, projectId: string): Promise<string[]> {
    return this.core.children(`orgs/${orgId}/projects/${projectId}/roomSettings`).map(([k]) => idOf(k));
  }

  putRoomSettings(orgId: string, projectId: string, s: Omit<RoomSettings, 'by' | 'at'>, actorUid: string) {
    return this.core.tx(() => {
      const path = fsPaths.roomSettings(orgId, projectId, s.sheetId, s.roomId);
      const before = this.docs.get(path) ?? null;
      const doc: Doc = { ...s, by: actorUid, at: this.core.now() };
      this.docs.set(path, doc);
      this.core.appendAuditSync(orgId, { actorId: actorUid, entity: 'roomSettings', entityId: roomSettingsId(s.sheetId, s.roomId), action: 'update', after: roomSettingsAudit(projectId, s, before) });
      return toRoomSettings(doc) as RoomSettings;
    });
  }

  // --- similar searches ----------------------------------------------------------------
  createSimilarSearch(
    orgId: string,
    projectId: string,
    input: { exemplar: SimilarExemplar; scope: SimilarSearch['scope']; correctionId: string | null },
    actorUid: string,
    jobType: string,
  ) {
    return this.core.tx(() => {
      const now = this.core.now();
      const searchId = autoId();
      const jobId = autoId();
      const doc: Doc = { status: 'queued', ...input, jobId, requestedBy: actorUid, createdAt: now, finishedAt: null, candidates: [], thumbs: 0, error: null };
      this.docs.set(fsPaths.similarSearch(orgId, projectId, searchId), doc);
      this.docs.set(fsPaths.job(jobId), {
        orgId,
        projectId,
        sheetSetId: null,
        searchId,
        type: jobType,
        status: 'queued',
        progress: { stage: 'similar', pct: 0 },
        attempts: 0,
        error: null,
        createdBy: actorUid,
        createdAt: now,
        updatedAt: now,
      });
      this.core.appendAuditSync(orgId, {
        actorId: actorUid,
        entity: 'similarSearches',
        entityId: searchId,
        action: 'request',
        after: { projectId, jobId, scope: input.scope, sheetId: input.exemplar.sheetId, versionId: input.exemplar.versionId, class: input.exemplar.class, correctionId: input.correctionId },
      });
      return { search: toSimilarSearch(searchId, doc) as SimilarSearch, jobId };
    });
  }

  async getSimilarSearch(orgId: string, projectId: string, searchId: string): Promise<SimilarSearch | null> {
    const d = this.docs.get(fsPaths.similarSearch(orgId, projectId, searchId));
    return d ? toSimilarSearch(searchId, d) : null;
  }

  async failSimilarSearch(orgId: string, projectId: string, searchId: string, jobId: string, error: ProcessingError): Promise<void> {
    const now = this.core.now();
    const path = fsPaths.similarSearch(orgId, projectId, searchId);
    const d = this.docs.get(path);
    if (d) this.docs.set(path, { ...d, status: 'failed', error, finishedAt: now });
    const job = this.docs.get(fsPaths.job(jobId));
    if (job && job.orgId === orgId) this.docs.set(fsPaths.job(jobId), { ...job, status: 'failed', error, updatedAt: now });
  }

  /** Test helper: what Worker-A writes when the search finishes. */
  completeSimilarSearch(orgId: string, projectId: string, searchId: string, candidates: unknown[]): void {
    const path = fsPaths.similarSearch(orgId, projectId, searchId);
    const d = this.docs.get(path);
    if (!d) throw new Error('no such search');
    this.docs.set(path, { ...d, status: 'succeeded', candidates, thumbs: candidates.length, finishedAt: this.core.now() });
  }

  // --- debounced rebuild ----------------------------------------------------------------
  scheduleAutoBuild(orgId: string, projectId: string, input: ScheduleBuildInput): Promise<ScheduleBuildResult | null> {
    return this.core.tx(() => {
      const pPath = fsPaths.project(orgId, projectId);
      const project = this.docs.get(pPath);
      if (!project) return null;
      const org = this.docs.get(fsPaths.org(orgId));
      const autoRebuild = ((org?.settings as Doc | undefined)?.autoRebuild ?? true) !== false;
      const boq = (project.boq as Doc | undefined) ?? {};
      const info = (id: unknown): ActiveBuildInfo | null => {
        if (typeof id !== 'string') return null;
        const b = this.docs.get(fsPaths.boqBuild(orgId, projectId, id));
        return b ? { id, status: b.status, createdAtMs: b.createdAt instanceof Date ? b.createdAt.getTime() : null } : null;
      };
      const plan = planAutoBuild(autoRebuild, [info(boq.pendingBuildId), info(boq.autoBuildId)], input.nowMs, input.debounceMs);
      const now = this.core.now();
      const stale = { stale: true, staleReason: input.reason, staleAt: now };
      if (plan.kind === 'off') {
        this.docs.set(pPath, { ...project, boq: { latestBuildId: null, builtAt: null, ...boq, ...stale } });
        return { outcome: 'off', build: null, jobId: null, publish: false, notBeforeMs: null };
      }
      if (plan.kind === 'debounce') {
        const bPath = fsPaths.boqBuild(orgId, projectId, plan.buildId);
        const b: Doc = { ...(this.docs.get(bPath) as Doc), debounceUntil: new Date(plan.untilMs) };
        this.docs.set(bPath, b);
        this.docs.set(pPath, { ...project, boq: { latestBuildId: null, builtAt: null, ...boq, ...stale } });
        return { outcome: 'debounced', build: toBoqBuild(plan.buildId, b), jobId: (b.jobId as string | null) ?? null, publish: false, notBeforeMs: plan.untilMs };
      }
      const buildId = autoId();
      const jobId = autoId();
      const build: Doc = {
        status: 'queued',
        jobId,
        requestedBy: input.actorUid,
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        stats: null,
        error: null,
        evidenceRef: null,
        trigger: 'auto',
        debounceUntil: new Date(plan.untilMs),
        afterBuildId: plan.afterBuildId,
      };
      this.docs.set(fsPaths.boqBuild(orgId, projectId, buildId), build);
      this.docs.set(fsPaths.job(jobId), {
        orgId,
        projectId,
        sheetSetId: null,
        buildId,
        type: input.jobType,
        status: 'queued',
        progress: { stage: 'boq', pct: 0 },
        attempts: 0,
        error: null,
        createdBy: input.actorUid,
        createdAt: now,
        updatedAt: now,
      });
      this.docs.set(pPath, { ...project, boq: { latestBuildId: null, builtAt: null, ...boq, ...stale, pendingBuildId: buildId, autoBuildId: buildId } });
      this.core.appendAuditSync(orgId, {
        actorId: input.actorUid,
        entity: 'boqBuilds',
        entityId: buildId,
        action: 'request',
        after: { projectId, jobId, trigger: 'auto', reason: input.reason, afterBuildId: plan.afterBuildId },
      });
      return { outcome: plan.afterBuildId ? 'followup' : 'scheduled', build: toBoqBuild(buildId, build), jobId, publish: true, notBeforeMs: plan.untilMs };
    });
  }
}

/** Job type of find-similar jobs (re-exported for tests). */
export const FIND_SIMILAR_JOB_TYPE = JOB_TYPES.findSimilar;
