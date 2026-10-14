import {
  fsPaths,
  roomSettingsId,
  type Correction,
  type CorrectionBatch,
  type CreateCorrectionRequest,
  type ProcessingError,
  type RoomSettings,
  type SimilarExemplar,
  type SimilarSearch,
} from '@kamutan/contracts';
import { FieldValue, Timestamp, type DocumentReference, type Firestore, type Query } from 'firebase-admin/firestore';
import { toBoqBuild } from './boq-docs';
import type { FirestoreRepository } from './firestore.repository';
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

/**
 * Firestore implementation of the Sprint 4 collections. Batches of ≤ 500 corrections commit in ONE transaction
 * (Firestore no longer caps a commit at 500 writes; the 10 MiB request limit is kept by the service's geometry cap).
 * List reads use a single equality filter (auto single-field index) and sort/page in memory: no composite index.
 */
export class FirestoreReviewRepository implements ReviewRepository {
  constructor(private readonly core: FirestoreRepository) {}

  private get db(): Firestore {
    return this.core.db;
  }

  // --- corrections ---------------------------------------------------------------
  async createCorrections(orgId: string, projectId: string, items: readonly CreateCorrectionRequest[], batch: NewCorrectionBatch | null, actorUid: string) {
    const col = this.db.collection(fsPaths.corrections(orgId, projectId));
    return this.db.runTransaction(async (tx) => {
      const head = await this.core.auditHead(tx, orgId);
      const at = Timestamp.now();
      const bRef = batch ? this.db.collection(`${fsPaths.project(orgId, projectId)}/correctionBatches`).doc() : null;
      const corrections: Correction[] = [];
      for (const it of items) {
        const ref = col.doc();
        const doc = { ...correctionDoc(it, bRef?.id ?? null, actorUid), at };
        tx.create(ref, doc);
        const c = toCorrection(ref.id, doc);
        if (!c) throw new Error('correction did not round-trip');
        corrections.push(c);
      }
      let b: CorrectionBatch | null = null;
      if (batch && bRef) {
        const doc = { ...batchDoc(items, batch, actorUid), at };
        tx.create(bRef, doc);
        b = toBatch(bRef.id, doc);
        this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'corrections', entityId: bRef.id, action: 'batch', after: batchAudit(projectId, b as CorrectionBatch, corrections.map((c) => c.id)) });
      } else {
        const c = corrections[0] as Correction;
        this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'corrections', entityId: c.id, action: 'create', after: correctionAudit(projectId, c) });
      }
      return { corrections, batch: b };
    });
  }

  async getCorrection(orgId: string, projectId: string, correctionId: string): Promise<Correction | null> {
    const snap = await this.db.doc(fsPaths.correction(orgId, projectId, correctionId)).get();
    return snap.exists ? toCorrection(correctionId, snap.data() as Doc) : null;
  }

  async listCorrections(orgId: string, projectId: string, filter: { sheetId?: string; batchId?: string }): Promise<Correction[]> {
    let q: Query = this.db.collection(fsPaths.corrections(orgId, projectId));
    if (filter.batchId !== undefined) q = q.where('batchId', '==', filter.batchId);
    else if (filter.sheetId !== undefined) q = q.where('sheetId', '==', filter.sheetId);
    const snap = await q.limit(MAX_CORRECTIONS).get();
    return snap.docs
      .map((d) => toCorrection(d.id, d.data()))
      .filter((c): c is Correction => c !== null && (filter.sheetId === undefined || c.sheetId === filter.sheetId));
  }

  async revertCorrection(orgId: string, projectId: string, correctionId: string, actorUid: string): Promise<Correction | null> {
    const ref = this.db.doc(fsPaths.correction(orgId, projectId, correctionId));
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const d = snap.data() as Doc;
      if (d.revertedAt) throw new RepoConflictError('already_reverted');
      const head = await this.core.auditHead(tx, orgId);
      const upd = { revertedAt: Timestamp.now(), revertedBy: actorUid };
      tx.update(ref, upd);
      this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'corrections', entityId: correctionId, action: 'revert', after: { projectId, kind: d.kind, batchId: d.batchId ?? null } });
      return toCorrection(correctionId, { ...d, ...upd });
    });
  }

  async getBatch(orgId: string, projectId: string, batchId: string): Promise<CorrectionBatch | null> {
    const snap = await this.db.doc(fsPaths.correctionBatch(orgId, projectId, batchId)).get();
    return snap.exists ? toBatch(batchId, snap.data() as Doc) : null;
  }

  async revertBatch(orgId: string, projectId: string, batchId: string, actorUid: string) {
    const bRef = this.db.doc(fsPaths.correctionBatch(orgId, projectId, batchId));
    return this.db.runTransaction(async (tx) => {
      const b = await tx.get(bRef);
      if (!b.exists) return null;
      if (b.get('revertedAt')) throw new RepoConflictError('already_reverted');
      const items = await tx.get(this.db.collection(fsPaths.corrections(orgId, projectId)).where('batchId', '==', batchId).limit(1000));
      const head = await this.core.auditHead(tx, orgId);
      const upd = { revertedAt: Timestamp.now(), revertedBy: actorUid };
      let reverted = 0;
      for (const d of items.docs) {
        if (d.get('revertedAt')) continue;
        tx.update(d.ref, upd);
        reverted++;
      }
      tx.update(bRef, upd);
      this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'corrections', entityId: batchId, action: 'revert_batch', after: { projectId, reverted } });
      return { batch: toBatch(batchId, { ...b.data(), ...upd }) as CorrectionBatch, reverted };
    });
  }

  // --- room settings ----------------------------------------------------------------
  async getRoomSettings(orgId: string, projectId: string, sheetId: string, roomId: string): Promise<RoomSettings | null> {
    const snap = await this.db.doc(fsPaths.roomSettings(orgId, projectId, sheetId, roomId)).get();
    return snap.exists ? toRoomSettings(snap.data() as Doc) : null;
  }

  async listRoomSettingsIds(orgId: string, projectId: string): Promise<string[]> {
    const snap = await this.db.collection(`${fsPaths.project(orgId, projectId)}/roomSettings`).select().limit(5000).get();
    return snap.docs.map((d) => d.id);
  }

  async putRoomSettings(orgId: string, projectId: string, s: Omit<RoomSettings, 'by' | 'at'>, actorUid: string): Promise<RoomSettings> {
    const ref = this.db.doc(fsPaths.roomSettings(orgId, projectId, s.sheetId, s.roomId));
    return this.db.runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      const head = await this.core.auditHead(tx, orgId);
      const doc = { ...JSON.parse(JSON.stringify(s)), by: actorUid, at: Timestamp.now() };
      tx.set(ref, doc);
      this.core.writeAudit(tx, orgId, head, {
        actorId: actorUid,
        entity: 'roomSettings',
        entityId: roomSettingsId(s.sheetId, s.roomId),
        action: 'update',
        after: roomSettingsAudit(projectId, s, cur.exists ? (cur.data() as Doc) : null),
      });
      return toRoomSettings(doc) as RoomSettings;
    });
  }

  // --- similar searches ----------------------------------------------------------------
  async createSimilarSearch(
    orgId: string,
    projectId: string,
    input: { exemplar: SimilarExemplar; scope: SimilarSearch['scope']; correctionId: string | null },
    actorUid: string,
    jobType: string,
  ) {
    return this.db.runTransaction(async (tx) => {
      const head = await this.core.auditHead(tx, orgId);
      const now = Timestamp.now();
      const ref = this.db.collection(`${fsPaths.project(orgId, projectId)}/similarSearches`).doc();
      const jobRef = this.db.collection('jobs').doc();
      const doc = { status: 'queued', ...JSON.parse(JSON.stringify(input)), jobId: jobRef.id, requestedBy: actorUid, createdAt: now, finishedAt: null, candidates: [], thumbs: 0, error: null };
      tx.create(ref, doc);
      tx.create(jobRef, {
        orgId,
        projectId,
        sheetSetId: null,
        searchId: ref.id,
        type: jobType,
        status: 'queued',
        progress: { stage: 'similar', pct: 0 },
        attempts: 0,
        error: null,
        createdBy: actorUid,
        createdAt: now,
        updatedAt: now,
      });
      this.core.writeAudit(tx, orgId, head, {
        actorId: actorUid,
        entity: 'similarSearches',
        entityId: ref.id,
        action: 'request',
        after: { projectId, jobId: jobRef.id, scope: input.scope, sheetId: input.exemplar.sheetId, versionId: input.exemplar.versionId, class: input.exemplar.class, correctionId: input.correctionId },
      });
      return { search: toSimilarSearch(ref.id, doc) as SimilarSearch, jobId: jobRef.id };
    });
  }

  async getSimilarSearch(orgId: string, projectId: string, searchId: string): Promise<SimilarSearch | null> {
    const snap = await this.db.doc(fsPaths.similarSearch(orgId, projectId, searchId)).get();
    return snap.exists ? toSimilarSearch(searchId, snap.data() as Doc) : null;
  }

  async failSimilarSearch(orgId: string, projectId: string, searchId: string, jobId: string, error: ProcessingError): Promise<void> {
    const batch = this.db.batch();
    batch.update(this.db.doc(fsPaths.similarSearch(orgId, projectId, searchId)), { status: 'failed', error, finishedAt: FieldValue.serverTimestamp() });
    const job = await this.db.doc(fsPaths.job(jobId)).get();
    if (job.exists && job.get('orgId') === orgId) batch.update(job.ref, { status: 'failed', error, updatedAt: FieldValue.serverTimestamp() });
    await batch.commit();
  }

  // --- debounced rebuild ----------------------------------------------------------------
  async scheduleAutoBuild(orgId: string, projectId: string, input: ScheduleBuildInput): Promise<ScheduleBuildResult | null> {
    const pRef = this.db.doc(fsPaths.project(orgId, projectId));
    const oRef = this.db.doc(fsPaths.org(orgId));
    return this.db.runTransaction(async (tx) => {
      const [project, org] = await tx.getAll(pRef, oRef);
      if (!project?.exists) return null;
      const autoRebuild = org?.get('settings.autoRebuild') !== false;
      const boq = (project.get('boq') as Doc | undefined) ?? {};
      const ids = [...new Set([boq.pendingBuildId, boq.autoBuildId].filter((x): x is string => typeof x === 'string'))];
      const refs = ids.map((id) => this.db.doc(fsPaths.boqBuild(orgId, projectId, id)));
      const snaps = refs.length ? await tx.getAll(...refs) : [];
      const infos: ActiveBuildInfo[] = snaps
        .filter((s) => s.exists)
        .map((s) => ({ id: s.id, status: s.get('status'), createdAtMs: (s.get('createdAt') as Timestamp | undefined)?.toMillis() ?? null }));
      const plan = planAutoBuild(autoRebuild, infos, input.nowMs, input.debounceMs);
      const staleUpd = {
        'boq.stale': true,
        'boq.staleReason': input.reason,
        'boq.staleAt': FieldValue.serverTimestamp(),
        ...(boq.latestBuildId === undefined ? { 'boq.latestBuildId': null, 'boq.builtAt': null } : {}),
      };
      if (plan.kind === 'off') {
        tx.update(pRef, staleUpd);
        return { outcome: 'off', build: null, jobId: null, publish: false, notBeforeMs: null };
      }
      if (plan.kind === 'debounce') {
        const snap = snaps.find((s) => s.id === plan.buildId);
        const until = Timestamp.fromMillis(plan.untilMs);
        tx.update(this.db.doc(fsPaths.boqBuild(orgId, projectId, plan.buildId)) as DocumentReference, { debounceUntil: until });
        tx.update(pRef, staleUpd);
        return {
          outcome: 'debounced',
          build: toBoqBuild(plan.buildId, { ...(snap?.data() ?? {}), debounceUntil: until }),
          jobId: (snap?.get('jobId') as string | null | undefined) ?? null,
          publish: false,
          notBeforeMs: plan.untilMs,
        };
      }
      const head = await this.core.auditHead(tx, orgId);
      const now = Timestamp.now();
      const bRef = this.db.collection(`${fsPaths.project(orgId, projectId)}/boqBuilds`).doc();
      const jobRef = this.db.collection('jobs').doc();
      const build = {
        status: 'queued',
        jobId: jobRef.id,
        requestedBy: input.actorUid,
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        stats: null,
        error: null,
        evidenceRef: null,
        trigger: 'auto',
        debounceUntil: Timestamp.fromMillis(plan.untilMs),
        afterBuildId: plan.afterBuildId,
      };
      tx.create(bRef, build);
      tx.create(jobRef, {
        orgId,
        projectId,
        sheetSetId: null,
        buildId: bRef.id,
        type: input.jobType,
        status: 'queued',
        progress: { stage: 'boq', pct: 0 },
        attempts: 0,
        error: null,
        createdBy: input.actorUid,
        createdAt: now,
        updatedAt: now,
      });
      tx.update(pRef, { ...staleUpd, 'boq.pendingBuildId': bRef.id, 'boq.autoBuildId': bRef.id });
      this.core.writeAudit(tx, orgId, head, {
        actorId: input.actorUid,
        entity: 'boqBuilds',
        entityId: bRef.id,
        action: 'request',
        after: { projectId, jobId: jobRef.id, trigger: 'auto', reason: input.reason, afterBuildId: plan.afterBuildId },
      });
      return { outcome: plan.afterBuildId ? 'followup' : 'scheduled', build: toBoqBuild(bRef.id, build), jobId: jobRef.id, publish: true, notBeforeMs: plan.untilMs };
    });
  }
}
