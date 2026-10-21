import { REPROCESS_REQUEST_MAX_WAIT_S, ReprocessRequestSchema } from '@kamutan/contracts';
import type {
  AuditEvent,
  DeletionCertificate,
  ExportRecord,
  MarkedPdfOptions,
  Member,
  OffboardingExport,
  Org,
  OrgSettings,
  PatchOrgSettingsRequest,
  ProcessingError,
  ReprocessRequest,
  SheetVersion,
  ShareLink,
  ShareTokenIndex,
} from '@kamutan/contracts';
import type { AuditInput } from './repository';

export const GOVERNANCE_REPOSITORY = Symbol('GOVERNANCE_REPOSITORY');

/** Hard cap of events scanned by the chain verification (per request). */
export const MAX_AUDIT_VERIFY = 200_000;
/** Hard cap of audit events read for one entity (line history). */
export const MAX_ENTITY_AUDIT = 2_000;
/** Hard cap of share links per project. */
export const MAX_SHARE_LINKS = 500;
/** A `firing` claim older than this is retried (seconds). */
export const REPROCESS_CLAIM_TIMEOUT_S = 600;

export interface DueReprocessRequest {
  orgId: string;
  projectId: string;
  sheetId: string;
}

/** Tolerant parse of a worker-written request (epoch seconds); null when unusable. */
export function toReprocessRequest(sheetId: string, d: Record<string, unknown>): ReprocessRequest | null {
  const r = ReprocessRequestSchema.safeParse({ sources: [], reason: 'reference_walls', updatedAt: 0, firstRequestedAt: 0, ...d, sheetId });
  return r.success ? r.data : null;
}

/** An audit event + the exact body that was hashed (Firestore Timestamps converted back to Date). */
export interface StoredAuditEvent {
  event: AuditEvent;
  /** {actorId, actorKind, entity, entityId, action, after, at} as hashed by audit-chain.ts. */
  body: Record<string, unknown>;
}

export interface AuditListOpts {
  limit: number;
  cursor?: string;
  entity?: string;
  action?: string;
  entityId?: string;
}

export interface NewMarkedPdfExport {
  sheetIds: string[] | null;
  versionIds: Record<string, string> | null;
  options: MarkedPdfOptions;
  shareLinkId: string | null;
}

/** Project sub-collections the offboarding export dumps as JSON. */
export const DUMP_COLLECTIONS = ['sheetSets', 'sheets', 'boqLines', 'corrections', 'roomSettings', 'boqBuilds'] as const;
export type DumpCollection = (typeof DUMP_COLLECTIONS)[number];

export interface PurgeResult {
  /** Every deleted Firestore document path (sorted), for the certificate inventory hash. */
  docPaths: string[];
  jobs: number;
  shareTokens: number;
  members: number;
  projects: number;
  /** Last audit-chain hash before deletion. */
  auditHead: string | null;
  requestedBy: string | null;
  requestedAt: string | null;
  deleteAfter: string | null;
}

/**
 * Sprint 5 data access: audit log reads, marked-PDF exports, share links, org settings, offboarding and the purge.
 * Same contract as the other repositories: NO authorization here (callers authorize the org first); every path is
 * under orgs/{orgId}/… except `jobs/*` (with that orgId), `shareTokens/{hash}` and `offboardingCertificates/{orgId}`.
 * Mutations append to the org's audit hash chain in the same transaction.
 */
export interface GovernanceRepository {
  // --- audit --------------------------------------------------------------------------
  /** Newest first (at desc, id desc); equality filters; cursor = last event id. */
  listAudit(orgId: string, opts: AuditListOpts): Promise<{ items: AuditEvent[]; nextCursor: string | null }>;
  /** Every event of the org (≤ MAX_AUDIT_VERIFY), any order, with the hashed body. */
  auditForVerify(orgId: string): Promise<StoredAuditEvent[]>;
  /** Events with this entity + entityId (≤ MAX_ENTITY_AUDIT), any order. */
  auditForEntity(orgId: string, entity: string, entityId: string): Promise<AuditEvent[]>;
  listMembers(orgId: string): Promise<Member[]>;

  // --- exports ---------------------------------------------------------------------------
  /** Transaction: exports/{id} (marked_pdf, queued) + jobs/{jobId} (`export.marked_pdf`) + audit `exports/create`. */
  createMarkedPdfExport(orgId: string, projectId: string, input: NewMarkedPdfExport, actorUid: string, jobType: string): Promise<{ record: ExportRecord; jobId: string }>;
  getExport(orgId: string, projectId: string, exportId: string): Promise<ExportRecord | null>;
  /** Publish failure: export + job failed. */
  failExport(orgId: string, projectId: string, exportId: string, jobId: string, error: ProcessingError): Promise<void>;

  // --- share links -------------------------------------------------------------------------
  /**
   * Transaction: shareLinks/{id} + shareTokens/{tokenHash} + audit `shareLinks/create`; with `pdf`, also the per-link
   * marked-PDF export + job (link.pdfExportId).
   */
  createShareLink(
    orgId: string,
    projectId: string,
    link: Omit<ShareLink, 'pdfExportId'>,
    pdf: { options: MarkedPdfOptions; versionIds: Record<string, string>; jobType: string } | null,
  ): Promise<{ link: ShareLink; pdf: { exportId: string; jobId: string } | null }>;
  listShareLinks(orgId: string, projectId: string): Promise<ShareLink[]>;
  getShareLink(orgId: string, projectId: string, linkId: string): Promise<ShareLink | null>;
  /** Transaction: sets revokedAt/By/Reason (no-op + changed=false when already revoked); audit `shareLinks/revoke`. */
  revokeShareLink(orgId: string, projectId: string, linkId: string, actorUid: string): Promise<{ link: ShareLink; changed: boolean } | null>;
  lookupShareToken(tokenHash: string): Promise<ShareTokenIndex | null>;
  /** viewCount++ / lastViewedAt (when `count`) and an optional audit event, one transaction. */
  recordShareView(orgId: string, projectId: string, linkId: string, opts: { count: boolean; audit: AuditInput | null }): Promise<void>;
  /** Revokes every active link of the org (reason `offboarding`); ONE audit event `shareLinks/revoke_all`. */
  revokeAllShareLinks(orgId: string, actorUid: string): Promise<number>;

  // --- org settings / offboarding ---------------------------------------------------------
  /** Transaction + audit `orgs/update_settings` with `{field: {from, to}}`. null when the org is gone. */
  patchOrgSettings(orgId: string, patch: PatchOrgSettingsRequest, actorUid: string): Promise<OrgSettings | null>;
  /** Transaction: offboardingExports/{id} (queued) + jobs/{jobId} + audit `offboardingExports/create`. */
  createOffboardingExport(orgId: string, includeSources: boolean, actorUid: string, jobType: string): Promise<{ export: OffboardingExport; jobId: string }>;
  getOffboardingExport(orgId: string, exportId: string): Promise<OffboardingExport | null>;
  /** Status changes by the export runner (+ job status); `ready` appends audit `offboardingExports/ready`. */
  updateOffboardingExport(orgId: string, exportId: string, patch: Partial<Omit<OffboardingExport, 'id' | 'createdBy' | 'createdAt' | 'storagePath'>>): Promise<void>;
  /**
   * Transaction: org.status = offboarding, deleteAfter, offboardingRequestedAt/By + audit `orgs/offboard`.
   * `already` = it was offboarding before (nothing written). null when the org is gone.
   */
  startOffboarding(orgId: string, actorUid: string, deleteAfter: Date, reason: string | null): Promise<{ org: Org; already: boolean } | null>;
  /** Docs of a project sub-collection (ISO timestamps), ≤ 20 000. */
  dumpProjectCollection(orgId: string, projectId: string, name: DumpCollection): Promise<Array<{ id: string; data: Record<string, unknown> }>>;
  /** All project ids of the org. */
  listProjectIds(orgId: string): Promise<string[]>;

  // --- dependent re-process requests (Worker-B; scheduled consumer) -----------------------------
  /**
   * Requests to look at (any org): `pending` with notBefore ≤ nowSec, plus `firing` claims older than
   * REPROCESS_CLAIM_TIMEOUT_S (a consumer crashed between claim and fire). ≤ limit.
   */
  listDueReprocessRequests(nowSec: number, limit: number): Promise<DueReprocessRequest[]>;
  /**
   * Transaction: re-reads the request; when it is still `pending` and due (or a stale `firing` claim) sets
   * `{status: 'firing', claimedAt}` and returns the doc; else null (another consumer got it / the worker re-armed it).
   */
  claimReprocessRequest(orgId: string, projectId: string, sheetId: string, nowSec: number): Promise<ReprocessRequest | null>;
  /** Final state after a claim (`fired` + versionId + firedAt | `dropped` + dropReason | back to `pending`). */
  finishReprocessRequest(orgId: string, projectId: string, sheetId: string, patch: Partial<ReprocessRequest>): Promise<void>;
  /** `reprocessReason` on the version created for a fired request. */
  setVersionReprocessReason(orgId: string, projectId: string, sheetId: string, versionId: string, reason: NonNullable<SheetVersion['reprocessReason']>): Promise<void>;

  // --- purge (scripts/offboard-purge.ts) -------------------------------------------------------
  /** Orgs with status offboarding and deleteAfter <= now. */
  listOrgsDueForPurge(now: Date): Promise<string[]>;
  /** Deletes orgs/{orgId} recursively + jobs where orgId + shareTokens of the org. Idempotent. */
  purgeOrg(orgId: string): Promise<PurgeResult>;
  writeCertificate(cert: DeletionCertificate): Promise<void>;
  getCertificate(orgId: string): Promise<DeletionCertificate | null>;
}

/** Due and not claimed (or a stale claim). `notBefore` is honoured; never later than firstRequestedAt + max wait. */
export function claimable(req: ReprocessRequest, nowSec: number): boolean {
  if (req.status === 'firing') return typeof req.claimedAt === 'number' && req.claimedAt <= nowSec - REPROCESS_CLAIM_TIMEOUT_S;
  if (req.status !== 'pending') return false;
  const cap = req.firstRequestedAt > 0 ? req.firstRequestedAt + REPROCESS_REQUEST_MAX_WAIT_S : Infinity;
  return Math.min(req.notBefore, cap) <= nowSec;
}
