import { fsPaths } from '@kamutan/contracts';
import { exportTouches, linkTouches, setBytes, sheetSetBusy, type HousekeepingRepository, type ProjectDeleteBegin, type SheetSetDeleteBegin } from './housekeeping-repository';
import type { InMemoryRepository } from './in-memory.repository';
import { isDeleting, type Doc } from './mappers';
import { RepoConflictError } from './repository';

const idOf = (path: string) => path.split('/').at(-1) as string;

/** In-memory Sprint 8 deletes over the shared core store (docs map, transaction chain, audit chain). */
export class InMemoryHousekeepingRepository implements HousekeepingRepository {
  constructor(private readonly core: InMemoryRepository) {}

  private get docs() {
    return this.core.docs;
  }

  beginSheetSetDelete(orgId: string, projectId: string, setId: string, actorUid: string) {
    return this.core.tx((): SheetSetDeleteBegin | null => {
      const pPath = fsPaths.project(orgId, projectId);
      const sPath = fsPaths.sheetSet(orgId, projectId, setId);
      const p = this.docs.get(pPath);
      const set = this.docs.get(sPath);
      if (!p || isDeleting(p) || !set) return null;
      const now = this.core.now();
      if (!set.deletedAt && sheetSetBusy(set, now.getTime())) throw new RepoConflictError('busy');
      const sheetIds = this.core
        .children(fsPaths.sheets(orgId, projectId))
        .filter(([, d]) => d.sheetSetId === setId)
        .map(([k]) => idOf(k))
        .sort();
      const ids = new Set(sheetIds);
      const exportIds = this.core
        .children(`orgs/${orgId}/projects/${projectId}/exports`)
        .filter(([, d]) => exportTouches(d, ids))
        .map(([k]) => idOf(k));
      if (set.deletedAt) {
        return { sheetIds, exportIds, releasedBytes: 0, storageBytes: (p.storageBytes as number | undefined) ?? 0, revokedShareLinks: 0, storagePath: typeof set.storagePath === 'string' ? set.storagePath : null };
      }
      const released = setBytes(set);
      const storageBytes = Math.max(0, ((p.storageBytes as number | undefined) ?? 0) - released);
      let revoked = 0;
      for (const [k, d] of this.core.children(fsPaths.shareLinks(orgId, projectId))) {
        if (d.revokedAt || !linkTouches(d, ids)) continue;
        this.docs.set(k, { ...d, revokedAt: now, revokedBy: actorUid, revokeReason: 'sheet_set_deleted' });
        revoked++;
      }
      this.docs.set(sPath, { ...set, deletedAt: now, deletedBy: actorUid, storageReleasedAt: set.storageReleasedAt ?? now });
      const boq = (p.boq as Doc | undefined) ?? { latestBuildId: null, builtAt: null };
      this.docs.set(pPath, { ...p, storageBytes, boq: { ...boq, stale: true, staleReason: 'sheet', staleAt: now } });
      if (revoked) this.core.appendAuditSync(orgId, { actorId: actorUid, entity: 'shareLinks', entityId: null, action: 'revoke_all', after: { projectId, reason: 'sheet_set_deleted', sheetSetId: setId, count: revoked } });
      this.core.appendAuditSync(orgId, { actorId: actorUid, entity: 'sheetSets', entityId: setId, action: 'delete', after: { projectId, sheets: sheetIds.length, releasedBytes: released, revokedShareLinks: revoked } });
      return { sheetIds, exportIds, releasedBytes: released, storageBytes, revokedShareLinks: revoked, storagePath: typeof set.storagePath === 'string' ? set.storagePath : null };
    });
  }

  finishSheetSetDelete(orgId: string, projectId: string, setId: string, plan: SheetSetDeleteBegin) {
    return this.core.tx(() => {
      const base = `orgs/${orgId}/projects/${projectId}/`;
      const ids = new Set(plan.sheetIds);
      let sheets = 0;
      let versions = 0;
      let docs = 0;
      for (const [k, d] of [...this.docs.entries()]) {
        if (!k.startsWith(base)) continue;
        const rest = k.slice(base.length).split('/');
        const [col, id, sub] = rest;
        if (col === 'sheets' && id && ids.has(id)) {
          if (rest.length === 2) sheets++;
          else if (sub === 'versions' && rest.length === 4) versions++;
          else docs++;
          this.docs.delete(k);
        } else if (rest.length === 2 && ((['corrections', 'legendEntries', 'reviewItems', 'roomSettings'].includes(col as string) && typeof d.sheetId === 'string' && ids.has(d.sheetId)) || (col === 'reprocessRequests' && ids.has(id as string)) || (col === 'exports' && plan.exportIds.includes(id as string)))) {
          this.docs.delete(k);
          docs++;
        } else if (col === 'sheets' && rest.length === 2 && (d.supersededBySetId === setId || (typeof d.supersededBy === 'string' && ids.has(d.supersededBy)))) {
          // The revision being deleted had replaced these sheets → they are current again.
          this.docs.set(k, { ...d, superseded: false, supersededBy: null, supersededBySetId: null, supersededMatch: null });
        } else if (col === 'sheetSets' && rest.length === 2 && d.supersededBySetId === setId) {
          this.docs.set(k, { ...d, supersededBySetId: null, supersededAt: null });
        }
      }
      this.docs.delete(fsPaths.sheetSet(orgId, projectId, setId));
      const pPath = fsPaths.project(orgId, projectId);
      const p = this.docs.get(pPath);
      if (p) {
        const current = this.core.children(fsPaths.sheets(orgId, projectId)).filter(([, d]) => d.superseded !== true).length;
        this.docs.set(pPath, { ...p, stats: { ...((p.stats as Doc | undefined) ?? {}), sheets: current } });
      }
      return { sheets, versions, docs };
    });
  }

  beginProjectDelete(orgId: string, projectId: string, actorUid: string) {
    return this.core.tx((): ProjectDeleteBegin | null => {
      const pPath = fsPaths.project(orgId, projectId);
      const p = this.docs.get(pPath);
      if (!p || isDeleting(p)) return null;
      const now = this.core.now();
      let revoked = 0;
      const tokenHashes: string[] = [];
      for (const [k, d] of this.core.children(fsPaths.shareLinks(orgId, projectId))) {
        if (typeof d.tokenHash === 'string') tokenHashes.push(d.tokenHash);
        if (d.revokedAt) continue;
        this.docs.set(k, { ...d, revokedAt: now, revokedBy: actorUid, revokeReason: 'project_deleted' });
        revoked++;
      }
      const sets = this.core.children(`orgs/${orgId}/projects/${projectId}/sheetSets`);
      const released = typeof p.storageBytes === 'number' ? p.storageBytes : sets.reduce((a, [, d]) => a + setBytes(d), 0);
      this.docs.set(pPath, { ...p, deletingAt: now, deletingBy: actorUid, storageBytes: 0 });
      if (revoked) this.core.appendAuditSync(orgId, { actorId: actorUid, entity: 'shareLinks', entityId: null, action: 'revoke_all', after: { projectId, reason: 'project_deleted', count: revoked } });
      this.core.appendAuditSync(orgId, { actorId: actorUid, entity: 'projects', entityId: projectId, action: 'delete', after: { projectId, name: String(p.name ?? ''), sheetSets: sets.length, releasedBytes: released, revokedShareLinks: revoked } });
      return { name: String(p.name ?? ''), releasedBytes: released, revokedShareLinks: revoked, tokenHashes };
    });
  }

  finishProjectDelete(orgId: string, projectId: string, linkTokenHashes: readonly string[]) {
    return this.core.tx(() => {
      const pPath = fsPaths.project(orgId, projectId);
      let n = 0;
      for (const k of [...this.docs.keys()]) {
        if (k === pPath || k.startsWith(`${pPath}/`)) {
          this.docs.delete(k);
          n++;
        }
      }
      for (const h of linkTokenHashes) if (this.docs.delete(fsPaths.shareToken(h))) n++;
      return n;
    });
  }
}
