import { fsPaths } from '@kamutan/contracts';
import { FieldValue, Timestamp, type DocumentData, type DocumentReference, type Firestore, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type { FirestoreRepository } from './firestore.repository';
import { exportTouches, linkTouches, setBytes, sheetSetBusy, type HousekeepingRepository, type ProjectDeleteBegin, type SheetSetDeleteBegin } from './housekeeping-repository';
import { isDeleting, type Doc } from './mappers';
import { RepoConflictError } from './repository';

/** Sheet-keyed project collections cleaned with a deleted sheet (single-field `sheetId ==` queries, auto-indexed). */
const SHEET_KEYED = ['corrections', 'legendEntries', 'reviewItems', 'roomSettings'] as const;
const IN_CHUNK = 30;

/**
 * Firestore deletes (Sprint 8). Phase 1 is one transaction (bookkeeping + audit + tombstone); phase 2 uses
 * `recursiveDelete` (BulkWriter) for the sheets / the project subtree — not transactional, but idempotent: a retry
 * re-runs phase 1 as a no-op (tombstone present) and finishes phase 2.
 */
export class FirestoreHousekeepingRepository implements HousekeepingRepository {
  constructor(
    private readonly db: Firestore,
    private readonly core: FirestoreRepository,
  ) {}

  private async sheetIdsOf(orgId: string, projectId: string, setId: string): Promise<string[]> {
    const snap = await this.db.collection(fsPaths.sheets(orgId, projectId)).where('sheetSetId', '==', setId).select().get();
    return snap.docs.map((d) => d.id).sort();
  }

  async beginSheetSetDelete(orgId: string, projectId: string, setId: string, actorUid: string): Promise<SheetSetDeleteBegin | null> {
    const sheetIds = await this.sheetIdsOf(orgId, projectId, setId);
    const ids = new Set(sheetIds);
    // Candidates read outside (queries), re-read inside the transaction.
    const [links, exports] = await Promise.all([
      this.db.collection(fsPaths.shareLinks(orgId, projectId)).get(),
      this.db.collection(`orgs/${orgId}/projects/${projectId}/exports`).where('kind', '==', 'marked_pdf').get(),
    ]);
    const linkRefs = links.docs.filter((d) => linkTouches(d.data() as Doc, ids)).map((d) => d.ref);
    const exportIds = exports.docs.filter((d) => exportTouches(d.data() as Doc, ids)).map((d) => d.id);
    const pRef = this.db.doc(fsPaths.project(orgId, projectId));
    const sRef = this.db.doc(fsPaths.sheetSet(orgId, projectId, setId));
    return this.db.runTransaction(async (tx) => {
      const [p, s, ...ls] = await tx.getAll(pRef, sRef, ...linkRefs);
      const pd = p?.data() as Doc | undefined;
      const sd = s?.data() as Doc | undefined;
      if (!pd || isDeleting(pd) || !sd) return null;
      const storagePath = typeof sd.storagePath === 'string' ? sd.storagePath : null;
      if (sd.deletedAt) return { sheetIds, exportIds, releasedBytes: 0, storageBytes: (pd.storageBytes as number | undefined) ?? 0, revokedShareLinks: 0, storagePath };
      if (sheetSetBusy(sd, Date.now())) throw new RepoConflictError('busy');
      const head = await this.core.auditHead(tx, orgId);
      const now = Timestamp.now();
      const released = setBytes(sd);
      const storageBytes = Math.max(0, ((pd.storageBytes as number | undefined) ?? 0) - released);
      let revoked = 0;
      for (const l of ls) {
        if (!l?.exists || (l.data() as Doc).revokedAt) continue;
        tx.update(l.ref, { revokedAt: now, revokedBy: actorUid, revokeReason: 'sheet_set_deleted' });
        revoked++;
      }
      tx.update(sRef, { deletedAt: now, deletedBy: actorUid, storageReleasedAt: sd.storageReleasedAt ?? now });
      tx.update(pRef, { storageBytes, 'boq.stale': true, 'boq.staleReason': 'sheet', 'boq.staleAt': now });
      if (revoked) this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'shareLinks', entityId: null, action: 'revoke_all', after: { projectId, reason: 'sheet_set_deleted', sheetSetId: setId, count: revoked } });
      this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'sheetSets', entityId: setId, action: 'delete', after: { projectId, sheets: sheetIds.length, releasedBytes: released, revokedShareLinks: revoked } });
      return { sheetIds, exportIds, releasedBytes: released, storageBytes, revokedShareLinks: revoked, storagePath };
    });
  }

  async finishSheetSetDelete(orgId: string, projectId: string, setId: string, plan: SheetSetDeleteBegin) {
    const base = fsPaths.project(orgId, projectId);
    let sheets = 0;
    let versions = 0;
    let docs = 0;
    for (const sheetId of plan.sheetIds) {
      const ref = this.db.doc(fsPaths.sheet(orgId, projectId, sheetId));
      const vs = await ref.collection('versions').listDocuments();
      versions += vs.length;
      if ((await ref.get()).exists) sheets++;
      await this.db.recursiveDelete(ref);
    }
    const others: DocumentReference[] = [];
    for (const col of SHEET_KEYED) {
      for (let i = 0; i < plan.sheetIds.length; i += IN_CHUNK) {
        const chunk = plan.sheetIds.slice(i, i + IN_CHUNK);
        const snap = await this.db.collection(`${base}/${col}`).where('sheetId', 'in', chunk).select().get();
        others.push(...snap.docs.map((d: QueryDocumentSnapshot<DocumentData>) => d.ref));
      }
    }
    for (const sheetId of plan.sheetIds) others.push(this.db.doc(fsPaths.reprocessRequest(orgId, projectId, sheetId)));
    for (const id of plan.exportIds) others.push(this.db.doc(fsPaths.boqExport(orgId, projectId, id)));
    const writer = this.db.bulkWriter();
    for (const r of others) {
      void writer.delete(r).then(
        () => void docs++,
        () => undefined,
      );
    }
    // Sheets the deleted revision had replaced are current again; the set it replaced is no longer "replaced".
    const [old, oldSets] = await Promise.all([
      this.db.collection(fsPaths.sheets(orgId, projectId)).where('supersededBySetId', '==', setId).get(),
      this.db.collection(`${base}/sheetSets`).where('supersededBySetId', '==', setId).get(),
    ]);
    const ignore = () => undefined; // per-op failures are reported by BulkWriter; a retry of the delete finishes the job
    for (const d of old.docs) writer.update(d.ref, { superseded: false, supersededBy: null, supersededBySetId: null, supersededMatch: null }).catch(ignore);
    for (const d of oldSets.docs) writer.update(d.ref, { supersededBySetId: null, supersededAt: null }).catch(ignore);
    writer.delete(this.db.doc(fsPaths.sheetSet(orgId, projectId, setId))).catch(ignore);
    await writer.close();
    const current = await this.core.countCurrentSheets(orgId, projectId);
    await this.db
      .doc(base)
      .update({ 'stats.sheets': current, updatedAt: FieldValue.serverTimestamp() })
      .catch(() => undefined);
    return { sheets, versions, docs };
  }

  async beginProjectDelete(orgId: string, projectId: string, actorUid: string): Promise<ProjectDeleteBegin | null> {
    const pRef = this.db.doc(fsPaths.project(orgId, projectId));
    const [links, sets] = await Promise.all([this.db.collection(fsPaths.shareLinks(orgId, projectId)).get(), this.db.collection(`${pRef.path}/sheetSets`).get()]);
    return this.db.runTransaction(async (tx) => {
      const [p, ...ls] = await tx.getAll(pRef, ...links.docs.map((d) => d.ref));
      const pd = p?.data() as Doc | undefined;
      if (!pd || isDeleting(pd)) return null;
      const head = await this.core.auditHead(tx, orgId);
      const now = Timestamp.now();
      let revoked = 0;
      const tokenHashes: string[] = [];
      for (const l of ls) {
        const d = l?.data() as Doc | undefined;
        if (!l || !d) continue;
        if (typeof d.tokenHash === 'string') tokenHashes.push(d.tokenHash);
        if (d.revokedAt) continue;
        tx.update(l.ref, { revokedAt: now, revokedBy: actorUid, revokeReason: 'project_deleted' });
        revoked++;
      }
      const released = typeof pd.storageBytes === 'number' ? pd.storageBytes : sets.docs.reduce((a, d) => a + setBytes(d.data() as Doc), 0);
      tx.update(pRef, { deletingAt: now, deletingBy: actorUid, storageBytes: 0 });
      if (revoked) this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'shareLinks', entityId: null, action: 'revoke_all', after: { projectId, reason: 'project_deleted', count: revoked } });
      this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'projects', entityId: projectId, action: 'delete', after: { projectId, name: String(pd.name ?? ''), sheetSets: sets.size, releasedBytes: released, revokedShareLinks: revoked } });
      return { name: String(pd.name ?? ''), releasedBytes: released, revokedShareLinks: revoked, tokenHashes };
    });
  }

  async finishProjectDelete(orgId: string, projectId: string, linkTokenHashes: readonly string[]): Promise<number> {
    let n = 0;
    const writer = this.db.bulkWriter();
    writer.onWriteResult(() => void n++);
    await this.db.recursiveDelete(this.db.doc(fsPaths.project(orgId, projectId)), writer);
    const w2 = this.db.bulkWriter();
    for (const h of linkTokenHashes) void w2.delete(this.db.doc(fsPaths.shareToken(h))).then(() => void n++, () => undefined);
    await w2.close();
    return n;
  }
}
