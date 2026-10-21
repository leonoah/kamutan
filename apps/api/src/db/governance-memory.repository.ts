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
import { isoDeep } from './boq-docs';
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
import { autoId, type InMemoryRepository } from './in-memory.repository';
import { toMember, toOrg, type Doc } from './mappers';
import type { AuditInput } from './repository';

const idOf = (path: string) => path.split('/').at(-1) as string;

/** In-memory Sprint 5 repository sharing the core in-memory store (docs map, transaction chain, audit chain). */
export class InMemoryGovernanceRepository implements GovernanceRepository {
  constructor(private readonly core: InMemoryRepository) {}

  private get docs() {
    return this.core.docs;
  }

  private sortedAudit(orgId: string): Array<[string, Doc]> {
    return this.core
      .children(`orgs/${orgId}/auditLog`)
      .sort(([ka, a], [kb, b]) => (b.at as Date).getTime() - (a.at as Date).getTime() || (kb < ka ? -1 : kb > ka ? 1 : 0));
  }

  // --- audit ------------------------------------------------------------------------
  async listAudit(orgId: string, opts: AuditListOpts) {
    const all = this.sortedAudit(orgId).filter(
      ([, d]) => (!opts.entity || d.entity === opts.entity) && (!opts.action || d.action === opts.action) && (!opts.entityId || d.entityId === opts.entityId),
    );
    let start = 0;
    if (opts.cursor) {
      const idx = all.findIndex(([k]) => idOf(k) === opts.cursor);
      start = idx >= 0 ? idx + 1 : all.length;
    }
    const page = all.slice(start, start + opts.limit);
    const items = page.map(([k, d]) => toAuditEvent(idOf(k), d));
    return { items, nextCursor: all.length > start + opts.limit && items.length ? (items.at(-1)?.id ?? null) : null };
  }

  async auditForVerify(orgId: string): Promise<StoredAuditEvent[]> {
    return this.core
      .children(`orgs/${orgId}/auditLog`)
      .slice(0, MAX_AUDIT_VERIFY)
      .map(([k, d]) => ({ event: toAuditEvent(idOf(k), d), body: auditBody(d) }));
  }

  async getAuditHead(orgId: string) {
    const d = this.docs.get(fsPaths.auditHead(orgId));
    return d ? { hash: typeof d.hash === 'string' ? d.hash : null, count: typeof d.count === 'number' ? d.count : null } : null;
  }

  async auditForEntity(orgId: string, entity: string, entityId: string) {
    return this.core
      .children(`orgs/${orgId}/auditLog`)
      .filter(([, d]) => d.entity === entity && d.entityId === entityId)
      .slice(0, MAX_ENTITY_AUDIT)
      .map(([k, d]) => toAuditEvent(idOf(k), d));
  }

  async listMembers(orgId: string): Promise<Member[]> {
    return this.core.children(`orgs/${orgId}/members`).map(([, d]) => toMember(d));
  }

  // --- exports ------------------------------------------------------------------------
  private writeMarkedPdf(orgId: string, projectId: string, input: NewMarkedPdfExport, actorUid: string, jobType: string): { record: ExportRecord; jobId: string } {
    const exportId = autoId();
    const jobId = autoId();
    const now = this.core.now();
    const doc: Doc = {
      kind: 'marked_pdf',
      status: 'queued',
      storagePath: storagePaths.markedPdf(orgId, projectId, exportId),
      pageCount: null,
      sizeBytes: null,
      sheetIds: input.sheetIds,
      versionIds: input.versionIds,
      options: input.options,
      shareLinkId: input.shareLinkId,
      jobId,
      createdBy: actorUid,
      createdAt: now,
      finishedAt: null,
      error: null,
    };
    this.docs.set(fsPaths.boqExport(orgId, projectId, exportId), doc);
    this.docs.set(fsPaths.job(jobId), {
      orgId,
      projectId,
      exportId,
      type: jobType,
      status: 'queued',
      progress: { stage: 'queued', pct: 0 },
      attempts: 0,
      error: null,
      createdBy: actorUid,
      createdAt: now,
      updatedAt: now,
    });
    this.core.appendAuditSync(orgId, {
      actorId: actorUid,
      entity: 'exports',
      entityId: exportId,
      action: 'create',
      after: markedPdfAudit(projectId, input, jobId),
    });
    return { record: toExportRecord(exportId, doc), jobId };
  }

  createMarkedPdfExport(orgId: string, projectId: string, input: NewMarkedPdfExport, actorUid: string, jobType: string) {
    return this.core.tx(() => this.writeMarkedPdf(orgId, projectId, input, actorUid, jobType));
  }

  async getExport(orgId: string, projectId: string, exportId: string): Promise<ExportRecord | null> {
    const d = this.docs.get(fsPaths.boqExport(orgId, projectId, exportId));
    return d ? toExportRecord(exportId, d) : null;
  }

  async failExport(orgId: string, projectId: string, exportId: string, jobId: string, error: ProcessingError) {
    const now = this.core.now();
    const p = fsPaths.boqExport(orgId, projectId, exportId);
    const d = this.docs.get(p);
    if (d) this.docs.set(p, { ...d, status: 'failed', error, finishedAt: now });
    const j = this.docs.get(fsPaths.job(jobId));
    if (j && j.orgId === orgId) this.docs.set(fsPaths.job(jobId), { ...j, status: 'failed', error, updatedAt: now });
  }

  // --- share links ------------------------------------------------------------------------
  createShareLink(
    orgId: string,
    projectId: string,
    link: Omit<ShareLink, 'pdfExportId'>,
    pdf: { options: NewMarkedPdfExport['options']; versionIds: Record<string, string>; jobType: string } | null,
  ) {
    return this.core.tx(() => {
      const id = link.id;
      const now = new Date(link.createdAt);
      let pdfOut: { exportId: string; jobId: string } | null = null;
      if (pdf) {
        const r = this.writeMarkedPdf(orgId, projectId, { sheetIds: Object.keys(pdf.versionIds), versionIds: pdf.versionIds, options: pdf.options, shareLinkId: id }, link.createdBy, pdf.jobType);
        pdfOut = { exportId: r.record.id, jobId: r.jobId };
      }
      const doc: Doc = { ...link, expiresAt: new Date(link.expiresAt), revokedAt: null, createdAt: now, pdfExportId: pdfOut?.exportId ?? null, viewCount: 0, lastViewedAt: null };
      this.docs.set(fsPaths.shareLink(orgId, projectId, id), doc);
      this.docs.set(fsPaths.shareToken(link.tokenHash), { orgId, projectId, linkId: id, createdAt: now });
      this.core.appendAuditSync(orgId, { actorId: link.createdBy, entity: 'shareLinks', entityId: id, action: 'create', after: { ...shareLinkAudit(projectId, link), pdfExportId: pdfOut?.exportId ?? null } });
      return { link: toShareLink(id, doc), pdf: pdfOut };
    });
  }

  async listShareLinks(orgId: string, projectId: string): Promise<ShareLink[]> {
    return this.core
      .children(fsPaths.shareLinks(orgId, projectId))
      .slice(0, MAX_SHARE_LINKS)
      .map(([k, d]) => toShareLink(idOf(k), d));
  }

  async getShareLink(orgId: string, projectId: string, linkId: string): Promise<ShareLink | null> {
    const d = this.docs.get(fsPaths.shareLink(orgId, projectId, linkId));
    return d ? toShareLink(linkId, d) : null;
  }

  revokeShareLink(orgId: string, projectId: string, linkId: string, actorUid: string) {
    return this.core.tx(() => {
      const p = fsPaths.shareLink(orgId, projectId, linkId);
      const d = this.docs.get(p);
      if (!d) return null;
      if (d.revokedAt) return { link: toShareLink(linkId, d), changed: false };
      const next = { ...d, revokedAt: this.core.now(), revokedBy: actorUid, revokeReason: 'user' };
      this.docs.set(p, next);
      this.core.appendAuditSync(orgId, { actorId: actorUid, entity: 'shareLinks', entityId: linkId, action: 'revoke', after: { projectId, reason: 'user' } });
      return { link: toShareLink(linkId, next), changed: true };
    });
  }

  async lookupShareToken(tokenHash: string): Promise<ShareTokenIndex | null> {
    const d = this.docs.get(fsPaths.shareToken(tokenHash));
    if (!d || typeof d.orgId !== 'string' || typeof d.projectId !== 'string' || typeof d.linkId !== 'string') return null;
    return { orgId: d.orgId, projectId: d.projectId, linkId: d.linkId, createdAt: (isoDeep(d.createdAt) as string) ?? new Date(0).toISOString() };
  }

  recordShareView(orgId: string, projectId: string, linkId: string, opts: { count: boolean; audit: AuditInput | null }) {
    return this.core.tx(() => {
      const p = fsPaths.shareLink(orgId, projectId, linkId);
      const d = this.docs.get(p);
      if (!d) return;
      if (opts.count) this.docs.set(p, { ...d, viewCount: ((d.viewCount as number | undefined) ?? 0) + 1, lastViewedAt: this.core.now() });
      if (opts.audit) this.core.appendAuditSync(orgId, opts.audit);
    });
  }

  revokeAllShareLinks(orgId: string, actorUid: string) {
    return this.core.tx(() => {
      const now = this.core.now();
      let n = 0;
      for (const [k, d] of [...this.docs.entries()]) {
        const parts = k.split('/');
        if (parts.length === 6 && parts[0] === 'orgs' && parts[1] === orgId && parts[2] === 'projects' && parts[4] === 'shareLinks' && !d.revokedAt) {
          this.docs.set(k, { ...d, revokedAt: now, revokedBy: actorUid, revokeReason: 'offboarding' });
          n++;
        }
      }
      this.core.appendAuditSync(orgId, { actorId: actorUid, entity: 'shareLinks', entityId: null, action: 'revoke_all', after: { reason: 'offboarding', count: n } });
      return n;
    });
  }

  // --- org settings / offboarding ---------------------------------------------------------
  patchOrgSettings(orgId: string, patch: PatchOrgSettingsRequest, actorUid: string) {
    return this.core.tx((): OrgSettings | null => {
      const p = fsPaths.org(orgId);
      const d = this.docs.get(p);
      if (!d) return null;
      const before = (d.settings ?? {}) as OrgSettings;
      const diff = settingsDiff(before, patch);
      const settings = { ...before, ...patch } as OrgSettings;
      this.docs.set(p, { ...d, settings, updatedAt: this.core.now() });
      this.core.appendAuditSync(orgId, { actorId: actorUid, entity: 'orgs', entityId: orgId, action: 'update_settings', after: { changes: diff } });
      return settings;
    });
  }

  createOffboardingExport(orgId: string, includeSources: boolean, actorUid: string, jobType: string) {
    return this.core.tx(() => {
      const id = autoId();
      const jobId = autoId();
      const now = this.core.now();
      const doc: Doc = {
        status: 'queued',
        storagePath: storagePaths.offboardingZip(orgId, id),
        jobId,
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
      this.docs.set(fsPaths.offboardingExport(orgId, id), doc);
      this.docs.set(fsPaths.job(jobId), { orgId, projectId: null, exportId: id, type: jobType, status: 'queued', progress: { stage: 'queued', pct: 0 }, attempts: 0, error: null, createdBy: actorUid, createdAt: now, updatedAt: now });
      this.core.appendAuditSync(orgId, { actorId: actorUid, entity: 'offboardingExports', entityId: id, action: 'create', after: { jobId, includeSources } });
      return { export: toOffboardingExport(id, doc), jobId };
    });
  }

  async getOffboardingExport(orgId: string, exportId: string): Promise<OffboardingExport | null> {
    const d = this.docs.get(fsPaths.offboardingExport(orgId, exportId));
    return d ? toOffboardingExport(exportId, d) : null;
  }

  updateOffboardingExport(orgId: string, exportId: string, patch: Partial<Omit<OffboardingExport, 'id' | 'createdBy' | 'createdAt' | 'storagePath'>>) {
    return this.core.tx(() => {
      const p = fsPaths.offboardingExport(orgId, exportId);
      const d = this.docs.get(p);
      if (!d) return;
      const clean: Doc = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      for (const k of ['startedAt', 'finishedAt'] as const) if (typeof clean[k] === 'string') clean[k] = new Date(clean[k] as string);
      this.docs.set(p, { ...d, ...clean });
      const jobId = d.jobId as string | undefined;
      const j = jobId ? this.docs.get(fsPaths.job(jobId)) : undefined;
      if (jobId && j && j.orgId === orgId && patch.status) {
        const status = patch.status === 'ready' ? 'succeeded' : patch.status;
        this.docs.set(fsPaths.job(jobId), { ...j, status, error: patch.error ?? null, progress: { stage: patch.status, pct: patch.status === 'ready' ? 100 : 10 }, updatedAt: this.core.now() });
      }
      if (patch.status === 'ready') {
        this.core.appendAuditSync(orgId, { actorId: null, actorKind: 'system', entity: 'offboardingExports', entityId: exportId, action: 'ready', after: { sizeBytes: patch.sizeBytes ?? null, sha256: patch.sha256 ?? null, counts: patch.counts ?? null } });
      }
    });
  }

  startOffboarding(orgId: string, actorUid: string, deleteAfter: Date, reason: string | null) {
    return this.core.tx(() => {
      const p = fsPaths.org(orgId);
      const d = this.docs.get(p);
      if (!d) return null;
      if (d.status === 'offboarding') return { org: toOrg(orgId, d), already: true };
      const now = this.core.now();
      const next = { ...d, status: 'offboarding', deleteAfter, offboardingRequestedAt: now, offboardingRequestedBy: actorUid };
      this.docs.set(p, next);
      this.core.appendAuditSync(orgId, { actorId: actorUid, entity: 'orgs', entityId: orgId, action: 'offboard', after: { deleteAfter: deleteAfter.toISOString(), hasReason: !!reason } });
      return { org: toOrg(orgId, next), already: false };
    });
  }

  async dumpProjectCollection(orgId: string, projectId: string, name: DumpCollection) {
    return this.core
      .children(`orgs/${orgId}/projects/${projectId}/${name}`)
      .slice(0, 20_000)
      .map(([k, d]) => ({ id: idOf(k), data: isoDeep(d) as Record<string, unknown> }));
  }

  async listProjectIds(orgId: string): Promise<string[]> {
    return this.core.children(`orgs/${orgId}/projects`).map(([k]) => idOf(k));
  }

  // --- dependent re-process requests --------------------------------------------------------
  async listDueReprocessRequests(nowSec: number, limit: number): Promise<DueReprocessRequest[]> {
    const out: DueReprocessRequest[] = [];
    for (const [k, d] of this.docs) {
      const parts = k.split('/');
      if (parts.length !== 6 || parts[0] !== 'orgs' || parts[2] !== 'projects' || parts[4] !== 'reprocessRequests') continue;
      const pendingDue = d.status === 'pending' && typeof d.notBefore === 'number' && d.notBefore <= nowSec;
      const staleClaim = d.status === 'firing' && typeof d.claimedAt === 'number' && d.claimedAt <= nowSec - REPROCESS_CLAIM_TIMEOUT_S;
      if (pendingDue || staleClaim) out.push({ orgId: parts[1] as string, projectId: parts[3] as string, sheetId: parts[5] as string });
      if (out.length >= limit) break;
    }
    return out;
  }

  claimReprocessRequest(orgId: string, projectId: string, sheetId: string, nowSec: number) {
    return this.core.tx(() => {
      const p = fsPaths.reprocessRequest(orgId, projectId, sheetId);
      const d = this.docs.get(p);
      const req = d ? toReprocessRequest(sheetId, d) : null;
      if (!req || !claimable(req, nowSec)) return null;
      this.docs.set(p, { ...d, status: 'firing', claimedAt: nowSec });
      return { ...req, status: 'firing' as const, claimedAt: nowSec };
    });
  }

  async finishReprocessRequest(orgId: string, projectId: string, sheetId: string, patch: Partial<ReprocessRequest>) {
    const p = fsPaths.reprocessRequest(orgId, projectId, sheetId);
    const d = this.docs.get(p);
    if (d) this.docs.set(p, { ...d, ...patch });
  }

  async setVersionReprocessReason(orgId: string, projectId: string, sheetId: string, versionId: string, reason: NonNullable<SheetVersion['reprocessReason']>) {
    const p = fsPaths.version(orgId, projectId, sheetId, versionId);
    const d = this.docs.get(p);
    if (d) this.docs.set(p, { ...d, reprocessReason: reason });
  }

  // --- purge -----------------------------------------------------------------------------------
  async listOrgsDueForPurge(now: Date): Promise<string[]> {
    return this.core
      .children('orgs')
      .filter(([, d]) => d.status === 'offboarding' && d.deleteAfter instanceof Date && d.deleteAfter.getTime() <= now.getTime())
      .map(([k]) => idOf(k));
  }

  purgeOrg(orgId: string) {
    return this.core.tx((): PurgeResult => {
      const prefix = `orgs/${orgId}/`;
      const org = this.docs.get(fsPaths.org(orgId));
      const head = this.docs.get(fsPaths.auditHead(orgId));
      const docPaths: string[] = [];
      let jobs = 0;
      let shareTokens = 0;
      let members = 0;
      let projects = 0;
      for (const [k, d] of [...this.docs.entries()]) {
        const inOrg = k === fsPaths.org(orgId) || k.startsWith(prefix);
        const isJob = k.startsWith('jobs/') && k.split('/').length === 2 && d.orgId === orgId;
        const isToken = k.startsWith('shareTokens/') && d.orgId === orgId;
        if (!inOrg && !isJob && !isToken) continue;
        if (isJob) jobs++;
        if (isToken) shareTokens++;
        if (k.startsWith(`${prefix}members/`) && k.split('/').length === 4) members++;
        if (k.startsWith(`${prefix}projects/`) && k.split('/').length === 4) projects++;
        docPaths.push(k);
        this.docs.delete(k);
      }
      return {
        docPaths: docPaths.sort(),
        jobs,
        shareTokens,
        members,
        projects,
        auditHead: (head?.hash as string | undefined) ?? null,
        requestedBy: (org?.offboardingRequestedBy as string | undefined) ?? null,
        requestedAt: org?.offboardingRequestedAt instanceof Date ? org.offboardingRequestedAt.toISOString() : null,
        deleteAfter: org?.deleteAfter instanceof Date ? org.deleteAfter.toISOString() : null,
      };
    });
  }

  async writeCertificate(cert: DeletionCertificate): Promise<void> {
    this.docs.set(fsPaths.offboardingCertificate(cert.orgId), { ...cert });
  }

  async getCertificate(orgId: string): Promise<DeletionCertificate | null> {
    const d = this.docs.get(fsPaths.offboardingCertificate(orgId));
    return d ? (d as unknown as DeletionCertificate) : null;
  }
}

export function markedPdfAudit(projectId: string, input: NewMarkedPdfExport, jobId: string): Record<string, unknown> {
  return {
    projectId,
    kind: 'marked_pdf',
    jobId,
    sheets: input.sheetIds ? input.sheetIds.length : null,
    floorSplit: input.options.floorSplit,
    hideTitleBlock: input.options.hideTitleBlock,
    watermark: input.options.watermark !== null,
    shareLinkId: input.shareLinkId,
  };
}
