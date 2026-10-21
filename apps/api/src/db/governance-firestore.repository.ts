import {
  fsPaths,
  storagePaths,
  type DeletionCertificate,
  type ExportRecord,
  type Member,
  type OffboardingExport,
  type OrgSettings,
  type PatchOrgSettingsRequest,
  type ProcessingError,
  type ReprocessRequest,
  type SheetVersion,
  type ShareLink,
  type ShareTokenIndex,
} from '@kamutan/contracts';
import { FieldPath, FieldValue, Timestamp, type DocumentData, type DocumentReference, type Firestore, type Query, type QueryDocumentSnapshot, type Transaction } from 'firebase-admin/firestore';
import { isoDeep } from './boq-docs';
import type { FirestoreRepository } from './firestore.repository';
import { auditBody, settingsDiff, shareLinkAudit, toAuditEvent, toExportRecord, toOffboardingExport, toShareLink } from './governance-docs';
import {
  MAX_AUDIT_VERIFY,
  MAX_ENTITY_AUDIT,
  MAX_SHARE_LINKS,
  type AuditListOpts,
  type DumpCollection,
  type GovernanceRepository,
  type NewMarkedPdfExport,
  type PurgeResult,
  type StoredAuditEvent,
  claimable,
  REPROCESS_CLAIM_TIMEOUT_S,
  toReprocessRequest,
  type DueReprocessRequest,
} from './governance-repository';
import { markedPdfAudit } from './governance-memory.repository';
import { mappers, type Doc } from './mappers';
import type { AuditInput } from './repository';

/** Top-level Timestamps → Date (what the shared mappers expect). */
function plain(d: DocumentData | undefined): Doc | null {
  if (!d) return null;
  const out: Doc = {};
  for (const [k, v] of Object.entries(d)) out[k] = v instanceof Timestamp ? v.toDate() : v;
  return out;
}

/**
 * Firestore implementation of the Sprint 5 collections. Audit list queries need composite indexes
 * (entity|action|entityId + at desc) — firebase/firestore.indexes.json. The token index `shareTokens/{hash}` is a
 * direct document read (no query, no index, same cost for known and unknown tokens).
 */
export class FirestoreGovernanceRepository implements GovernanceRepository {
  constructor(private readonly core: FirestoreRepository) {}

  private get db(): Firestore {
    return this.core.db;
  }

  // --- audit ------------------------------------------------------------------------
  async listAudit(orgId: string, opts: AuditListOpts) {
    const col = this.db.collection(`orgs/${orgId}/auditLog`);
    let q: Query = col;
    if (opts.entity) q = q.where('entity', '==', opts.entity);
    if (opts.action) q = q.where('action', '==', opts.action);
    if (opts.entityId) q = q.where('entityId', '==', opts.entityId);
    q = q.orderBy('at', 'desc').orderBy(FieldPath.documentId(), 'desc');
    if (opts.cursor) {
      const snap = await col.doc(opts.cursor).get();
      if (!snap.exists) return { items: [], nextCursor: null };
      q = q.startAfter(snap);
    }
    const snap = await q.limit(opts.limit + 1).get();
    const docs = snap.docs.slice(0, opts.limit);
    const items = docs.map((d) => toAuditEvent(d.id, d.data() as Doc));
    return { items, nextCursor: snap.docs.length > opts.limit && items.length ? (items.at(-1)?.id ?? null) : null };
  }

  async auditForVerify(orgId: string): Promise<StoredAuditEvent[]> {
    const out: StoredAuditEvent[] = [];
    let last: QueryDocumentSnapshot | null = null;
    const col = this.db.collection(`orgs/${orgId}/auditLog`);
    while (out.length < MAX_AUDIT_VERIFY) {
      let q = col.orderBy(FieldPath.documentId()).limit(1000);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      for (const d of snap.docs) out.push({ event: toAuditEvent(d.id, d.data() as Doc), body: auditBody(d.data() as Doc) });
      if (snap.docs.length < 1000) break;
      last = snap.docs.at(-1) ?? null;
    }
    return out.slice(0, MAX_AUDIT_VERIFY);
  }

  async auditForEntity(orgId: string, entity: string, entityId: string) {
    // Two equality filters: served by single-field indexes (no composite index needed).
    const snap = await this.db.collection(`orgs/${orgId}/auditLog`).where('entity', '==', entity).where('entityId', '==', entityId).limit(MAX_ENTITY_AUDIT).get();
    return snap.docs.map((d) => toAuditEvent(d.id, d.data() as Doc));
  }

  async listMembers(orgId: string): Promise<Member[]> {
    const snap = await this.db.collection(`orgs/${orgId}/members`).limit(1000).get();
    return snap.docs.map((d) => mappers.toMember(plain(d.data()) as Doc));
  }

  // --- exports ------------------------------------------------------------------------
  private writeMarkedPdf(tx: Transaction, head: string | null, orgId: string, projectId: string, input: NewMarkedPdfExport, actorUid: string, jobType: string, exportRef: DocumentReference) {
    const jobRef = this.db.collection('jobs').doc();
    const now = Timestamp.now();
    const doc: Doc = {
      kind: 'marked_pdf',
      status: 'queued',
      storagePath: storagePaths.markedPdf(orgId, projectId, exportRef.id),
      pageCount: null,
      sizeBytes: null,
      sheetIds: input.sheetIds,
      versionIds: input.versionIds,
      options: input.options,
      shareLinkId: input.shareLinkId,
      jobId: jobRef.id,
      createdBy: actorUid,
      createdAt: now,
      finishedAt: null,
      error: null,
    };
    tx.create(exportRef, doc);
    tx.create(jobRef, {
      orgId,
      projectId,
      exportId: exportRef.id,
      type: jobType,
      status: 'queued',
      progress: { stage: 'queued', pct: 0 },
      attempts: 0,
      error: null,
      createdBy: actorUid,
      createdAt: now,
      updatedAt: now,
    });
    this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'exports', entityId: exportRef.id, action: 'create', after: markedPdfAudit(projectId, input, jobRef.id) });
    return { record: toExportRecord(exportRef.id, { ...doc, createdAt: now.toDate() }), jobId: jobRef.id };
  }

  async createMarkedPdfExport(orgId: string, projectId: string, input: NewMarkedPdfExport, actorUid: string, jobType: string) {
    const ref = this.db.collection(`${fsPaths.project(orgId, projectId)}/exports`).doc();
    return this.db.runTransaction(async (tx) => {
      const head = await this.core.auditHead(tx, orgId);
      return this.writeMarkedPdf(tx, head, orgId, projectId, input, actorUid, jobType, ref);
    });
  }

  async getExport(orgId: string, projectId: string, exportId: string): Promise<ExportRecord | null> {
    const snap = await this.db.doc(fsPaths.boqExport(orgId, projectId, exportId)).get();
    return snap.exists ? toExportRecord(exportId, snap.data() as Doc) : null;
  }

  async failExport(orgId: string, projectId: string, exportId: string, jobId: string, error: ProcessingError) {
    const now = Timestamp.now();
    const batch = this.db.batch();
    batch.set(this.db.doc(fsPaths.boqExport(orgId, projectId, exportId)), { status: 'failed', error, finishedAt: now }, { merge: true });
    const job = await this.db.doc(fsPaths.job(jobId)).get();
    if (job.exists && job.get('orgId') === orgId) batch.set(job.ref, { status: 'failed', error, updatedAt: now }, { merge: true });
    await batch.commit();
  }

  // --- share links ------------------------------------------------------------------------
  async createShareLink(
    orgId: string,
    projectId: string,
    link: Omit<ShareLink, 'pdfExportId'>,
    pdf: { options: NewMarkedPdfExport['options']; versionIds: Record<string, string>; jobType: string } | null,
  ) {
    const ref = this.db.collection(fsPaths.shareLinks(orgId, projectId)).doc(link.id);
    const exportRef = this.db.collection(`${fsPaths.project(orgId, projectId)}/exports`).doc();
    return this.db.runTransaction(async (tx) => {
      const head = await this.core.auditHead(tx, orgId);
      const now = Timestamp.fromDate(new Date(link.createdAt));
      let pdfOut: { exportId: string; jobId: string } | null = null;
      if (pdf) {
        const r = this.writeMarkedPdf(tx, head, orgId, projectId, { sheetIds: Object.keys(pdf.versionIds), versionIds: pdf.versionIds, options: pdf.options, shareLinkId: ref.id }, link.createdBy, pdf.jobType, exportRef);
        pdfOut = { exportId: r.record.id, jobId: r.jobId };
      }
      const doc: Doc = {
        ...link,
        expiresAt: Timestamp.fromDate(new Date(link.expiresAt)),
        revokedAt: null,
        createdAt: now,
        pdfExportId: pdfOut?.exportId ?? null,
        viewCount: 0,
        lastViewedAt: null,
      };
      tx.create(ref, doc);
      tx.create(this.db.doc(fsPaths.shareToken(link.tokenHash)), { orgId, projectId, linkId: ref.id, createdAt: now });
      this.core.writeAudit(tx, orgId, head, { actorId: link.createdBy, entity: 'shareLinks', entityId: ref.id, action: 'create', after: { ...shareLinkAudit(projectId, link), pdfExportId: pdfOut?.exportId ?? null } });
      return { link: toShareLink(ref.id, { ...doc, createdAt: now.toDate(), expiresAt: new Date(link.expiresAt) }), pdf: pdfOut };
    });
  }

  async listShareLinks(orgId: string, projectId: string): Promise<ShareLink[]> {
    const snap = await this.db.collection(fsPaths.shareLinks(orgId, projectId)).limit(MAX_SHARE_LINKS).get();
    return snap.docs.map((d) => toShareLink(d.id, d.data() as Doc));
  }

  async getShareLink(orgId: string, projectId: string, linkId: string): Promise<ShareLink | null> {
    const snap = await this.db.doc(fsPaths.shareLink(orgId, projectId, linkId)).get();
    return snap.exists ? toShareLink(linkId, snap.data() as Doc) : null;
  }

  async revokeShareLink(orgId: string, projectId: string, linkId: string, actorUid: string) {
    const ref = this.db.doc(fsPaths.shareLink(orgId, projectId, linkId));
    return this.db.runTransaction(async (tx) => {
      const head = await this.core.auditHead(tx, orgId);
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const d = snap.data() as Doc;
      if (d.revokedAt) return { link: toShareLink(linkId, d), changed: false };
      const patch = { revokedAt: Timestamp.now(), revokedBy: actorUid, revokeReason: 'user' };
      tx.update(ref, patch);
      this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'shareLinks', entityId: linkId, action: 'revoke', after: { projectId, reason: 'user' } });
      return { link: toShareLink(linkId, { ...d, ...patch }), changed: true };
    });
  }

  async lookupShareToken(tokenHash: string): Promise<ShareTokenIndex | null> {
    const snap = await this.db.doc(fsPaths.shareToken(tokenHash)).get();
    const d = snap.data();
    if (!d || typeof d.orgId !== 'string' || typeof d.projectId !== 'string' || typeof d.linkId !== 'string') return null;
    return { orgId: d.orgId, projectId: d.projectId, linkId: d.linkId, createdAt: (isoDeep(d.createdAt) as string) ?? new Date(0).toISOString() };
  }

  async recordShareView(orgId: string, projectId: string, linkId: string, opts: { count: boolean; audit: AuditInput | null }) {
    const ref = this.db.doc(fsPaths.shareLink(orgId, projectId, linkId));
    if (!opts.audit) {
      if (opts.count) await ref.update({ viewCount: FieldValue.increment(1), lastViewedAt: Timestamp.now() });
      return;
    }
    const audit = opts.audit;
    await this.db.runTransaction(async (tx) => {
      const head = await this.core.auditHead(tx, orgId);
      if (opts.count) tx.update(ref, { viewCount: FieldValue.increment(1), lastViewedAt: Timestamp.now() });
      this.core.writeAudit(tx, orgId, head, audit);
    });
  }

  async revokeAllShareLinks(orgId: string, actorUid: string): Promise<number> {
    const projects = await this.listProjectIds(orgId);
    const now = Timestamp.now();
    let n = 0;
    for (const p of projects) {
      const snap = await this.db.collection(fsPaths.shareLinks(orgId, p)).where('revokedAt', '==', null).get();
      for (let i = 0; i < snap.docs.length; i += 400) {
        const batch = this.db.batch();
        for (const d of snap.docs.slice(i, i + 400)) batch.update(d.ref, { revokedAt: now, revokedBy: actorUid, revokeReason: 'offboarding' });
        await batch.commit();
      }
      n += snap.docs.length;
    }
    await this.core.appendAudit(orgId, { actorId: actorUid, entity: 'shareLinks', entityId: null, action: 'revoke_all', after: { reason: 'offboarding', count: n } });
    return n;
  }

  // --- org settings / offboarding ---------------------------------------------------------
  async patchOrgSettings(orgId: string, patch: PatchOrgSettingsRequest, actorUid: string): Promise<OrgSettings | null> {
    const ref = this.db.doc(fsPaths.org(orgId));
    return this.db.runTransaction(async (tx) => {
      const head = await this.core.auditHead(tx, orgId);
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const before = (snap.get('settings') ?? {}) as OrgSettings;
      const diff = settingsDiff(before, patch);
      const settings = { ...before, ...patch } as OrgSettings;
      tx.update(ref, { settings, updatedAt: Timestamp.now() });
      this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'orgs', entityId: orgId, action: 'update_settings', after: { changes: diff } });
      return settings;
    });
  }

  async createOffboardingExport(orgId: string, includeSources: boolean, actorUid: string, jobType: string) {
    const ref = this.db.collection(`orgs/${orgId}/offboardingExports`).doc();
    const jobRef = this.db.collection('jobs').doc();
    return this.db.runTransaction(async (tx) => {
      const head = await this.core.auditHead(tx, orgId);
      const now = Timestamp.now();
      const doc: Doc = {
        status: 'queued',
        storagePath: storagePaths.offboardingZip(orgId, ref.id),
        jobId: jobRef.id,
        includeSources,
        createdBy: actorUid,
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        sizeBytes: null,
        sha256: null,
        counts: null,
        error: null,
      };
      tx.create(ref, doc);
      tx.create(jobRef, { orgId, projectId: null, exportId: ref.id, type: jobType, status: 'queued', progress: { stage: 'queued', pct: 0 }, attempts: 0, error: null, createdBy: actorUid, createdAt: now, updatedAt: now });
      this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'offboardingExports', entityId: ref.id, action: 'create', after: { jobId: jobRef.id, includeSources } });
      return { export: toOffboardingExport(ref.id, { ...doc, createdAt: now.toDate() }), jobId: jobRef.id };
    });
  }

  async getOffboardingExport(orgId: string, exportId: string): Promise<OffboardingExport | null> {
    const snap = await this.db.doc(fsPaths.offboardingExport(orgId, exportId)).get();
    return snap.exists ? toOffboardingExport(exportId, snap.data() as Doc) : null;
  }

  async updateOffboardingExport(orgId: string, exportId: string, patch: Partial<Omit<OffboardingExport, 'id' | 'createdBy' | 'createdAt' | 'storagePath'>>) {
    const ref = this.db.doc(fsPaths.offboardingExport(orgId, exportId));
    await this.db.runTransaction(async (tx) => {
      const head = patch.status === 'ready' ? await this.core.auditHead(tx, orgId) : null;
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const jobId = snap.get('jobId') as string | undefined;
      const jobSnap = jobId ? await tx.get(this.db.doc(fsPaths.job(jobId))) : null;
      const clean: Doc = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      for (const k of ['startedAt', 'finishedAt'] as const) if (typeof clean[k] === 'string') clean[k] = Timestamp.fromDate(new Date(clean[k] as string));
      tx.update(ref, clean);
      if (jobSnap?.exists && jobSnap.get('orgId') === orgId && patch.status) {
        const status = patch.status === 'ready' ? 'succeeded' : patch.status;
        tx.update(jobSnap.ref, { status, error: patch.error ?? null, progress: { stage: patch.status, pct: patch.status === 'ready' ? 100 : 10 }, updatedAt: Timestamp.now() });
      }
      if (patch.status === 'ready') {
        this.core.writeAudit(tx, orgId, head, { actorId: null, actorKind: 'system', entity: 'offboardingExports', entityId: exportId, action: 'ready', after: { sizeBytes: patch.sizeBytes ?? null, sha256: patch.sha256 ?? null, counts: patch.counts ?? null } });
      }
    });
  }

  async startOffboarding(orgId: string, actorUid: string, deleteAfter: Date, reason: string | null) {
    const ref = this.db.doc(fsPaths.org(orgId));
    return this.db.runTransaction(async (tx) => {
      const head = await this.core.auditHead(tx, orgId);
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const d = plain(snap.data()) as Doc;
      if (d.status === 'offboarding') return { org: mappers.toOrg(orgId, d), already: true };
      const now = Timestamp.now();
      const patch = { status: 'offboarding', deleteAfter: Timestamp.fromDate(deleteAfter), offboardingRequestedAt: now, offboardingRequestedBy: actorUid };
      tx.update(ref, patch);
      this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'orgs', entityId: orgId, action: 'offboard', after: { deleteAfter: deleteAfter.toISOString(), hasReason: !!reason } });
      return { org: mappers.toOrg(orgId, { ...d, status: 'offboarding', deleteAfter, offboardingRequestedAt: now.toDate(), offboardingRequestedBy: actorUid }), already: false };
    });
  }

  async dumpProjectCollection(orgId: string, projectId: string, name: DumpCollection) {
    const snap = await this.db.collection(`orgs/${orgId}/projects/${projectId}/${name}`).limit(20_000).get();
    return snap.docs.map((d) => ({ id: d.id, data: isoDeep(d.data()) as Record<string, unknown> }));
  }

  async listProjectIds(orgId: string): Promise<string[]> {
    const refs = await this.db.collection(`orgs/${orgId}/projects`).listDocuments();
    return refs.map((r) => r.id);
  }

  // --- dependent re-process requests --------------------------------------------------------
  /** Collection-group queries: (status, notBefore) and (status, claimedAt) — firestore.indexes.json. */
  async listDueReprocessRequests(nowSec: number, limit: number): Promise<DueReprocessRequest[]> {
    const g = this.db.collectionGroup('reprocessRequests');
    const [pending, stale] = await Promise.all([
      g.where('status', '==', 'pending').where('notBefore', '<=', nowSec).limit(limit).get(),
      g.where('status', '==', 'firing').where('claimedAt', '<=', nowSec - REPROCESS_CLAIM_TIMEOUT_S).limit(limit).get(),
    ]);
    const out: DueReprocessRequest[] = [];
    for (const d of [...pending.docs, ...stale.docs]) {
      const parts = d.ref.path.split('/');
      if (parts.length !== 6 || parts[0] !== 'orgs' || parts[2] !== 'projects') continue;
      out.push({ orgId: parts[1] as string, projectId: parts[3] as string, sheetId: parts[5] as string });
    }
    return out.slice(0, limit);
  }

  async claimReprocessRequest(orgId: string, projectId: string, sheetId: string, nowSec: number) {
    const ref = this.db.doc(fsPaths.reprocessRequest(orgId, projectId, sheetId));
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const req = snap.exists ? toReprocessRequest(sheetId, snap.data() as Doc) : null;
      if (!req || !claimable(req, nowSec)) return null;
      tx.update(ref, { status: 'firing', claimedAt: nowSec });
      return { ...req, status: 'firing' as const, claimedAt: nowSec };
    });
  }

  async finishReprocessRequest(orgId: string, projectId: string, sheetId: string, patch: Partial<ReprocessRequest>) {
    await this.db.doc(fsPaths.reprocessRequest(orgId, projectId, sheetId)).set(patch, { merge: true });
  }

  async setVersionReprocessReason(orgId: string, projectId: string, sheetId: string, versionId: string, reason: NonNullable<SheetVersion['reprocessReason']>) {
    await this.db.doc(fsPaths.version(orgId, projectId, sheetId, versionId)).set({ reprocessReason: reason }, { merge: true });
  }

  // --- purge -----------------------------------------------------------------------------------
  async listOrgsDueForPurge(now: Date): Promise<string[]> {
    const snap = await this.db.collection('orgs').where('status', '==', 'offboarding').where('deleteAfter', '<=', Timestamp.fromDate(now)).get();
    return snap.docs.map((d) => d.id);
  }

  /** Walks the org subtree (inventory for the certificate), then deletes it with recursiveDelete (BulkWriter). */
  async purgeOrg(orgId: string): Promise<PurgeResult> {
    const orgRef = this.db.doc(fsPaths.org(orgId));
    const orgSnap = await orgRef.get();
    const org = plain(orgSnap.data());
    const headSnap = await this.db.doc(fsPaths.auditHead(orgId)).get();
    const docPaths: string[] = [];
    let members = 0;
    let projects = 0;
    const walk = async (ref: DocumentReference): Promise<void> => {
      const snap = await ref.get();
      if (snap.exists) docPaths.push(ref.path);
      for (const col of await ref.listCollections()) {
        for (const child of await col.listDocuments()) {
          if (col.id === 'members' && ref.path === orgRef.path) members++;
          if (col.id === 'projects' && ref.path === orgRef.path) projects++;
          await walk(child);
        }
      }
    };
    await walk(orgRef);
    const jobs = await this.db.collection('jobs').where('orgId', '==', orgId).get();
    const tokens = await this.db.collection('shareTokens').where('orgId', '==', orgId).get();
    for (const d of [...jobs.docs, ...tokens.docs]) docPaths.push(d.ref.path);
    await this.db.recursiveDelete(orgRef);
    const writer = this.db.bulkWriter();
    for (const d of [...jobs.docs, ...tokens.docs]) void writer.delete(d.ref);
    await writer.close();
    return {
      docPaths: docPaths.sort(),
      jobs: jobs.size,
      shareTokens: tokens.size,
      members,
      projects,
      auditHead: (headSnap.get('hash') as string | undefined) ?? null,
      requestedBy: (org?.offboardingRequestedBy as string | undefined) ?? null,
      requestedAt: org?.offboardingRequestedAt instanceof Date ? org.offboardingRequestedAt.toISOString() : null,
      deleteAfter: org?.deleteAfter instanceof Date ? org.deleteAfter.toISOString() : null,
    };
  }

  async writeCertificate(cert: DeletionCertificate): Promise<void> {
    await this.db.doc(fsPaths.offboardingCertificate(cert.orgId)).set(cert);
  }

  async getCertificate(orgId: string): Promise<DeletionCertificate | null> {
    const snap = await this.db.doc(fsPaths.offboardingCertificate(orgId)).get();
    return snap.exists ? (snap.data() as DeletionCertificate) : null;
  }
}
