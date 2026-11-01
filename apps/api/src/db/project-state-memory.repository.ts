import { fsPaths } from '@kamutan/contracts';
import { toBoqLine } from './boq-docs';
import type { InMemoryRepository } from './in-memory.repository';
import type { Doc } from './mappers';
import type { MatchSheet, PendingSupersede, ProjectCounters, ProjectStateRepository, SupersedePlan } from './project-state-repository';
import { RepoConflictError } from './repository';

const idOf = (path: string) => path.split('/').at(-1) as string;

export class InMemoryProjectStateRepository implements ProjectStateRepository {
  constructor(private readonly core: InMemoryRepository) {}

  private get docs() {
    return this.core.docs;
  }

  async counters(orgId: string, projectId: string): Promise<ProjectCounters> {
    const sheets = this.core.children(fsPaths.sheets(orgId, projectId)).filter(([, d]) => d.superseded !== true).length;
    const c = { sheets, boqLines: 0, green: 0, yellow: 0, red: 0, reviewOpen: 0 };
    for (const [k, d] of this.core.children(fsPaths.boqLines(orgId, projectId))) {
      const l = toBoqLine(idOf(k), d);
      c.boqLines++;
      c[l.level]++;
      if (l.level !== 'green' && l.status !== 'approved') c.reviewOpen++;
    }
    return c;
  }

  startSupersede(orgId: string, projectId: string, oldSetId: string, newSetId: string, actorUid: string): Promise<void> {
    return this.core.tx(() => {
      if (oldSetId === newSetId) throw new RepoConflictError('same_set');
      const op = fsPaths.sheetSet(orgId, projectId, oldSetId);
      const np = fsPaths.sheetSet(orgId, projectId, newSetId);
      const o = this.docs.get(op);
      const n = this.docs.get(np);
      if (!o || !n) throw new RepoConflictError('not_found');
      if (o.supersededBySetId === newSetId && n.replacesSheetSetId === oldSetId) return;
      if (o.supersededBySetId) throw new RepoConflictError('already_superseded');
      if (n.replacesSheetSetId && n.replacesSheetSetId !== oldSetId) throw new RepoConflictError('already_superseded');
      const now = this.core.now();
      this.docs.set(op, { ...o, supersededBySetId: newSetId, supersededAt: now });
      this.docs.set(np, { ...n, replacesSheetSetId: oldSetId, supersede: { status: 'pending', matchedAt: null } });
      this.core.appendAuditSync(orgId, { actorId: actorUid, entity: 'sheetSets', entityId: newSetId, action: 'supersede', after: { projectId, from: oldSetId, to: newSetId, status: 'pending' } });
    });
  }

  async pendingSupersedes(orgId: string, projectId: string): Promise<PendingSupersede[]> {
    return this.core
      .children(`${fsPaths.project(orgId, projectId)}/sheetSets`)
      .filter(([, d]) => (d.supersede as Doc | undefined)?.status === 'pending' && typeof d.replacesSheetSetId === 'string')
      .map(([k, d]) => ({ newSetId: idOf(k), oldSetId: d.replacesSheetSetId as string, newSetStatus: String(d.status ?? 'uploaded') }));
  }

  async setSheets(orgId: string, projectId: string, sheetSetId: string): Promise<MatchSheet[]> {
    return this.core
      .children(fsPaths.sheets(orgId, projectId))
      .filter(([, d]) => d.sheetSetId === sheetSetId)
      .map(([k, d]) => {
        const id = idOf(k);
        const v = typeof d.currentVersionId === 'string' ? this.docs.get(fsPaths.version(orgId, projectId, id, d.currentVersionId)) : undefined;
        return {
          id,
          pageIndex: typeof d.pageIndex === 'number' ? d.pageIndex : 0,
          title: typeof d.title === 'string' ? d.title : null,
          discipline: typeof d.discipline === 'string' ? d.discipline : null,
          floors: Array.isArray(d.floors) ? (d.floors as unknown[]).filter((f): f is string => typeof f === 'string') : [],
          status: typeof v?.status === 'string' ? v.status : null,
        };
      });
  }

  applySupersede(orgId: string, projectId: string, pending: PendingSupersede, plan: SupersedePlan): Promise<boolean> {
    return this.core.tx(() => {
      const np = fsPaths.sheetSet(orgId, projectId, pending.newSetId);
      const n = this.docs.get(np);
      if ((n?.supersede as Doc | undefined)?.status !== 'pending') return false;
      const now = this.core.now();
      for (const [oldId, newId] of Object.entries(plan.sheetMap)) {
        const p = fsPaths.sheet(orgId, projectId, oldId);
        const d = this.docs.get(p);
        if (d) this.docs.set(p, { ...d, superseded: true, supersededBySetId: pending.newSetId, supersededBy: newId, supersededMatch: plan.match[oldId] ?? 'none', updatedAt: now });
        if (newId) {
          const q = fsPaths.sheet(orgId, projectId, newId);
          const nd = this.docs.get(q);
          if (nd) this.docs.set(q, { ...nd, supersedes: oldId, updatedAt: now });
        }
      }
      this.docs.set(np, { ...n, supersede: { status: 'matched', matchedAt: now, sheetMap: plan.sheetMap } });
      const pp = fsPaths.project(orgId, projectId);
      const proj = this.docs.get(pp);
      // The worker's `stats.sheets` counted old + new sheets; the API corrects it now (A-LIVE-02).
      const sheets = this.core.children(fsPaths.sheets(orgId, projectId)).filter(([, x]) => x.superseded !== true).length;
      if (proj) this.docs.set(pp, { ...proj, stats: { ...((proj.stats as Doc | undefined) ?? {}), sheets }, boq: { ...((proj.boq as Doc | undefined) ?? {}), stale: true, staleReason: 'sheet', staleAt: now } });
      const values = Object.values(plan.sheetMap);
      this.core.appendAuditSync(orgId, { actorId: null, actorKind: 'system', entity: 'sheetSets', entityId: pending.newSetId, action: 'supersede', after: { projectId, from: pending.oldSetId, to: pending.newSetId, status: 'matched', matched: values.filter(Boolean).length, unmatched: values.filter((v) => !v).length } });
      return true;
    });
  }
}
