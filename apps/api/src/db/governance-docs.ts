import {
  EXPORT_STATUSES,
  MarkedPdfOptionsSchema,
  OFFBOARDING_EXPORT_STATUSES,
  ProcessingErrorSchema,
  type AuditEvent,
  type ExportRecord,
  type ExportStatus,
  type OffboardingExport,
  type OrgSettings,
  type PatchOrgSettingsRequest,
  type ProcessingError,
  type ShareLink,
} from '@kamutan/contracts';
import { isoDeep } from './boq-docs';
import { anyIso, type Doc } from './mappers';

/** Mappers + pure helpers for the Sprint 5 collections (shared by the Firestore and in-memory repositories). */

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const intOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
const err = (v: unknown): ProcessingError | null => {
  const r = ProcessingErrorSchema.safeParse(v);
  return r.success ? r.data : null;
};
const idRecord = (v: unknown): Record<string, string> | null => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Doc)) if (/^[A-Za-z0-9_-]{1,128}$/.test(k) && typeof x === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(x)) out[k] = x;
  return out;
};

const boolRecord = (v: unknown): Record<string, boolean> | null => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return Object.fromEntries(Object.entries(v as Doc).filter(([k, x]) => /^[A-Za-z0-9_-]{1,128}$/.test(k) && typeof x === 'boolean')) as Record<string, boolean>;
};

/** Timestamps (any depth) → Date, so the hashed audit body can be recomputed exactly as it was written. */
export function datesDeep(v: unknown, depth = 0): unknown {
  if (v instanceof Date) return v;
  if (v && typeof v === 'object' && typeof (v as { toDate?: unknown }).toDate === 'function') return (v as { toDate: () => Date }).toDate();
  if (depth >= 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => datesDeep(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Doc).map(([k, x]) => [k, datesDeep(x, depth + 1)]));
}

/** The exact object `writeAudit` hashed: {actorId, actorKind, entity, entityId, action, after, at (ISO string)}. */
export function auditBody(d: Doc): Record<string, unknown> {
  return {
    actorId: d.actorId ?? null,
    actorKind: d.actorKind ?? 'user',
    entity: d.entity,
    entityId: d.entityId ?? null,
    action: d.action,
    after: datesDeep(d.after ?? null),
    at: anyIso(d.at),
  };
}

export function toAuditEvent(id: string, d: Doc): AuditEvent {
  const after = d.after && typeof d.after === 'object' && !Array.isArray(d.after) ? (isoDeep(d.after) as Record<string, unknown>) : null;
  return {
    id,
    actorId: str(d.actorId),
    actorKind: str(d.actorKind) ?? 'user',
    entity: String(d.entity ?? ''),
    entityId: str(d.entityId),
    action: String(d.action ?? ''),
    after,
    at: anyIso(d.at) ?? new Date(0).toISOString(),
    prevHash: str(d.prevHash),
    hash: String(d.hash ?? ''),
  };
}

export function toShareLink(id: string, d: Doc): ShareLink {
  const lock = idRecord(d.versionLockBySheet);
  return {
    id,
    tokenHash: String(d.tokenHash ?? ''),
    versionLock: Array.isArray(d.versionLock) ? (d.versionLock as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    expiresAt: anyIso(d.expiresAt) ?? new Date(0).toISOString(),
    revokedAt: d.revokedAt ? anyIso(d.revokedAt) : null,
    allowPdfDownload: d.allowPdfDownload === true,
    createdBy: String(d.createdBy ?? ''),
    createdAt: anyIso(d.createdAt) ?? new Date(0).toISOString(),
    ...(lock ? { versionLockBySheet: lock } : {}),
    ...(typeof d.label === 'string' ? { label: d.label } : {}),
    recipient: str(d.recipient),
    hideTitleBlock: d.hideTitleBlock !== false,
    viewCount: intOrNull(d.viewCount) ?? 0,
    lastViewedAt: d.lastViewedAt ? anyIso(d.lastViewedAt) : null,
    revokedBy: str(d.revokedBy),
    revokeReason: d.revokeReason === 'user' || d.revokeReason === 'offboarding' || d.revokeReason === 'project_deleted' ? d.revokeReason : null,
    pdfExportId: str(d.pdfExportId),
    ...(d.titleBlockMaskedBySheet && typeof d.titleBlockMaskedBySheet === 'object'
      ? { titleBlockMaskedBySheet: Object.fromEntries(Object.entries(d.titleBlockMaskedBySheet as Doc).filter(([k, v]) => /^[A-Za-z0-9_-]{1,128}$/.test(k) && typeof v === 'boolean')) as Record<string, boolean> }
      : {}),
    ...(typeof d.includeUnmaskedSheets === 'boolean' ? { includeUnmaskedSheets: d.includeUnmaskedSheets } : {}),
    ...(idRecord(d.excludedSheets) ? { excludedSheets: idRecord(d.excludedSheets) as Record<string, string> } : {}),
    boqSnapshotPath: str(d.boqSnapshotPath),
  };
}

export function exportStatus(v: unknown, dflt: ExportStatus): ExportStatus {
  if (v === 'succeeded') return 'ready';
  return (EXPORT_STATUSES as readonly string[]).includes(v as string) ? (v as ExportStatus) : dflt;
}

/** exports/{id} → ExportRecord. Sprint-3 xlsx docs (no `kind`) → xlsx / ready. */
export function toExportRecord(id: string, d: Doc): ExportRecord {
  const kind = d.kind === 'marked_pdf' ? 'marked_pdf' : 'xlsx';
  const opts = MarkedPdfOptionsSchema.safeParse(isoDeep(d.options));
  return {
    id,
    kind,
    status: kind === 'xlsx' ? exportStatus(d.status, 'ready') : exportStatus(d.status, 'queued'),
    storagePath: String(d.storagePath ?? ''),
    pageCount: intOrNull(d.pageCount),
    sizeBytes: intOrNull(d.sizeBytes),
    createdBy: String(d.createdBy ?? ''),
    createdAt: anyIso(d.createdAt) ?? new Date(0).toISOString(),
    ...(d.startedAt !== undefined ? { startedAt: d.startedAt ? anyIso(d.startedAt) : null } : {}),
    finishedAt: d.finishedAt ? anyIso(d.finishedAt) : null,
    error: err(d.error),
    ...(kind === 'marked_pdf'
      ? {
          sheetIds: Array.isArray(d.sheetIds) ? (d.sheetIds as unknown[]).filter((x): x is string => typeof x === 'string') : null,
          ...(opts.success ? { options: opts.data } : {}),
          jobId: str(d.jobId),
          shareLinkId: str(d.shareLinkId),
          versionIds: idRecord(d.versionIds),
          ...(typeof d.titleBlockMasked === 'boolean' || d.titleBlockMasked === null ? { titleBlockMasked: d.titleBlockMasked as boolean | null } : {}),
          ...(d.titleBlockBySheet !== undefined ? { titleBlockBySheet: boolRecord(d.titleBlockBySheet) } : {}),
        }
      : {}),
  };
}

export function toOffboardingExport(id: string, d: Doc): OffboardingExport {
  const c = d.counts && typeof d.counts === 'object' ? (d.counts as Doc) : null;
  return {
    id,
    status: (OFFBOARDING_EXPORT_STATUSES as readonly string[]).includes(d.status as string) ? (d.status as OffboardingExport['status']) : 'queued',
    storagePath: String(d.storagePath ?? ''),
    jobId: str(d.jobId),
    createdBy: String(d.createdBy ?? ''),
    createdAt: anyIso(d.createdAt) ?? new Date(0).toISOString(),
    startedAt: d.startedAt ? anyIso(d.startedAt) : null,
    finishedAt: d.finishedAt ? anyIso(d.finishedAt) : null,
    sizeBytes: intOrNull(d.sizeBytes),
    sha256: typeof d.sha256 === 'string' && /^[a-f0-9]{64}$/.test(d.sha256) ? d.sha256 : null,
    counts: c ? { projects: intOrNull(c.projects) ?? 0, sources: intOrNull(c.sources) ?? 0, files: intOrNull(c.files) ?? 0 } : null,
    error: err(d.error),
  };
}

/** `{field: {from, to}}` of the settings that actually change (audit `orgs/update_settings`). */
export function settingsDiff(before: Partial<OrgSettings>, patch: PatchOrgSettingsRequest): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(patch)) {
    const from = (before as Record<string, unknown>)[k] ?? null;
    if (v !== undefined && from !== v) out[k] = { from, to: v };
  }
  return out;
}

/** Audit payload of a share link (no token, no hash, no recipient text — only ids and flags). */
export function shareLinkAudit(projectId: string, link: Pick<ShareLink, 'expiresAt' | 'allowPdfDownload' | 'versionLock'> & { hideTitleBlock?: boolean; recipient?: string | null }): Record<string, unknown> {
  return {
    projectId,
    expiresAt: link.expiresAt,
    allowPdfDownload: link.allowPdfDownload,
    hideTitleBlock: link.hideTitleBlock !== false,
    hasRecipient: !!link.recipient,
    sheets: link.versionLock.length,
  };
}

/** /24 for IPv4, /48 for IPv6 (SEC-29: shortened IP in the view log). */
export function ipPrefix(ip: string | undefined | null): string {
  if (!ip) return 'unknown';
  let a = ip.trim();
  if (a.startsWith('::ffff:') && a.includes('.')) a = a.slice(7);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(a)) return `${a.split('.').slice(0, 3).join('.')}.0/24`;
  if (a.includes(':')) {
    const [head] = a.split('::');
    const full = a.includes('::') ? head?.split(':').filter(Boolean) ?? [] : a.split(':');
    const groups = [...full, '0', '0', '0'].slice(0, 3).map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''));
    return `${groups.join(':')}::/48`;
  }
  return 'unknown';
}

/** F-2: rate-limit key of a client IP — the full IPv4 address, the /64 of an IPv6 address (one host owns a /64). */
export function ipLimitKey(ip: string | undefined | null): string {
  if (!ip) return 'unknown';
  let a = ip.trim().toLowerCase();
  if (a.startsWith('::ffff:') && a.includes('.')) a = a.slice(7);
  if (!a.includes(':')) return a;
  const [head = '', tail = ''] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = a.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${full.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
