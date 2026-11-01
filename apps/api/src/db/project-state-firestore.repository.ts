import { fsPaths } from '@kamutan/contracts';
import { Timestamp, type DocumentData, type Query } from 'firebase-admin/firestore';
import type { FirestoreRepository } from './firestore.repository';
import type { Doc } from './mappers';
import type { MatchSheet, PendingSupersede, ProjectCounters, ProjectStateRepository, SupersedePlan } from './project-state-repository';
import { RepoConflictError } from './repository';

const count = async (q: Query): Promise<number> => (await q.count().get()).data().count;
const data = (d: DocumentData | undefined): Doc => (d ?? {}) as Doc;

/**
 * Firestore implementation. Counters use count() aggregations (billed per 1 000 index entries, no document reads):
 * sheets total − superseded, lines by level, approved non-green lines. Equality filters only (single-field indexes).
 */
export class FirestoreProjectStateRepository implements ProjectStateRepository {
  constructor(private readonly core: FirestoreRepository) {}

  private get db() {
    return this.core.db;
  }

  async counters(orgId: string, projectId: string): Promise<ProjectCounters> {
    const sheets = this.db.collection(fsPaths.sheets(orgId, projectId));
    const lines = this.db.collection(fsPaths.boqLines(orgId, projectId));
    const [allSheets, superseded, total, green, yellow, red, approvedNonGreen] = await Promise.all([
      count(sheets),
      count(sheets.where('superseded', '==', true)),
      count(lines),
      count(lines.where('level', '==', 'green')),
      count(lines.where('level', '==', 'yellow')),
      count(lines.where('level', '==', 'red')),
      count(lines.where('status', '==', 'approved').where('level', 'in', ['yellow', 'red'])),
    ]);
    return { sheets: Math.max(0, allSheets - superseded), boqLines: total, green, yellow, red, reviewOpen: Math.max(0, yellow + red - approvedNonGreen) };
  }

  async startSupersede(orgId: string, projectId: string, oldSetId: string, newSetId: string, actorUid: string): Promise<void> {
    if (oldSetId === newSetId) throw new RepoConflictError('same_set');
    const oref = this.db.doc(fsPaths.sheetSet(orgId, projectId, oldSetId));
    const nref = this.db.doc(fsPaths.sheetSet(orgId, projectId, newSetId));
    await this.db.runTransaction(async (tx) => {
      const head = await this.core.auditHead(tx, orgId);
      const [os, ns] = await tx.getAll(oref, nref);
      if (!os?.exists || !ns?.exists) throw new RepoConflictError('not_found');
      const o = data(os.data());
      const n = data(ns.data());
      if (o.supersededBySetId === newSetId && n.replacesSheetSetId === oldSetId) return;
      if (o.supersededBySetId) throw new RepoConflictError('already_superseded');
      if (n.replacesSheetSetId && n.replacesSheetSetId !== oldSetId) throw new RepoConflictError('already_superseded');
      tx.update(oref, { supersededBySetId: newSetId, supersededAt: Timestamp.now() });
      tx.update(nref, { replacesSheetSetId: oldSetId, supersede: { status: 'pending', matchedAt: null } });
      this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'sheetSets', entityId: newSetId, action: 'supersede', after: { projectId, from: oldSetId, to: newSetId, status: 'pending' } });
    });
  }

  async pendingSupersedes(orgId: string, projectId: string): Promise<PendingSupersede[]> {
    const snap = await this.db.collection(`${fsPaths.project(orgId, projectId)}/sheetSets`).where('supersede.status', '==', 'pending').limit(50).get();
    return snap.docs
      .filter((d) => typeof d.get('replacesSheetSetId') === 'string')
      .map((d) => ({ newSetId: d.id, oldSetId: d.get('replacesSheetSetId') as string, newSetStatus: String(d.get('status') ?? 'uploaded') }));
  }

  async setSheets(orgId: string, projectId: string, sheetSetId: string): Promise<MatchSheet[]> {
    const snap = await this.db.collection(fsPaths.sheets(orgId, projectId)).where('sheetSetId', '==', sheetSetId).limit(500).get();
    const refs = snap.docs.flatMap((d) => (typeof d.get('currentVersionId') === 'string' ? [this.db.doc(fsPaths.version(orgId, projectId, d.id, d.get('currentVersionId') as string))] : []));
    const status = new Map<string, string>();
    if (refs.length) for (const v of await this.db.getAll(...refs)) if (v.exists) status.set(`${v.ref.parent.parent?.id}/${v.id}`, String(v.get('status')));
    return snap.docs.map((doc) => {
      const d = data(doc.data());
      return {
        id: doc.id,
        pageIndex: typeof d.pageIndex === 'number' ? d.pageIndex : 0,
        title: typeof d.title === 'string' ? d.title : null,
        discipline: typeof d.discipline === 'string' ? d.discipline : null,
        floors: Array.isArray(d.floors) ? (d.floors as unknown[]).filter((f): f is string => typeof f === 'string') : [],
        status: typeof d.currentVersionId === 'string' ? (status.get(`${doc.id}/${d.currentVersionId}`) ?? null) : null,
      };
    });
  }

  async applySupersede(orgId: string, projectId: string, pending: PendingSupersede, plan: SupersedePlan): Promise<boolean> {
    const nref = this.db.doc(fsPaths.sheetSet(orgId, projectId, pending.newSetId));
    const applied = await this.db.runTransaction(async (tx) => {
      const head = await this.core.auditHead(tx, orgId);
      const ns = await tx.get(nref);
      if (!ns.exists || (data(ns.data()).supersede as Doc | undefined)?.status !== 'pending') return false;
      const now = Timestamp.now();
      for (const [oldId, newId] of Object.entries(plan.sheetMap)) {
        tx.set(this.db.doc(fsPaths.sheet(orgId, projectId, oldId)), { superseded: true, supersededBySetId: pending.newSetId, supersededBy: newId, supersededMatch: plan.match[oldId] ?? 'none', updatedAt: now }, { merge: true });
        if (newId) tx.set(this.db.doc(fsPaths.sheet(orgId, projectId, newId)), { supersedes: oldId, updatedAt: now }, { merge: true });
      }
      tx.update(nref, { supersede: { status: 'matched', matchedAt: now, sheetMap: plan.sheetMap } });
      tx.set(this.db.doc(fsPaths.project(orgId, projectId)), { boq: { stale: true, staleReason: 'sheet', staleAt: now } }, { merge: true });
      const values = Object.values(plan.sheetMap);
      this.core.writeAudit(tx, orgId, head, { actorId: null, actorKind: 'system', entity: 'sheetSets', entityId: pending.newSetId, action: 'supersede', after: { projectId, from: pending.oldSetId, to: pending.newSetId, status: 'matched', matched: values.filter(Boolean).length, unmatched: values.filter((v) => !v).length } });
      return true;
    });
    if (applied) {
      // The worker's `stats.sheets` counted old + new sheets; correct it (A-LIVE-02).
      const sheets = this.db.collection(fsPaths.sheets(orgId, projectId));
      const current = Math.max(0, (await count(sheets)) - (await count(sheets.where('superseded', '==', true))));
      await this.db.doc(fsPaths.project(orgId, projectId)).set({ stats: { sheets: current } }, { merge: true });
    }
    return applied;
  }
}
