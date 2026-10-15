import {
  BOQ_BUILD_STATUSES,
  BoqRuleSchema,
  BoqTemplateSchema,
  canTransition,
  CONFIDENCE_LEVELS,
  ItemLibraryItemSchema,
  LIBRARY_IMPORT_STATUSES,
  LibraryImportSchema,
  ProcessingErrorSchema,
  BOQ_LINE_STATUSES,
  type BoqBuild,
  type BoqLine,
  type BoqRule,
  type BoqTemplate,
  type ItemLibraryItem,
  type LibraryImport,
  type PatchBoqLineRequest,
  type ProcessingError,
  OVERRIDE_REASON,
} from '@kamutan/contracts';
import { anyIso, type Doc } from './mappers';
import { RepoConflictError } from './repository';

/** Mappers + pure write planning for the Sprint 3 collections (shared by the Firestore and in-memory repositories). */

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;
const err = (v: unknown): ProcessingError | null => {
  const r = ProcessingErrorSchema.safeParse(v);
  return r.success ? r.data : null;
};

/** Replace every Timestamp/Date (any depth ≤ 3) by an ISO string so Zod can parse API/worker docs. */
export function isoDeep(v: unknown, depth = 0): unknown {
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === 'object' && typeof (v as { toDate?: unknown }).toDate === 'function') return anyIso(v);
  if (depth >= 3 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => isoDeep(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Doc).map(([k, x]) => [k, isoDeep(x, depth + 1)]));
}

/** Worker-written line → DTO (tolerant: malformed optional fields are dropped, never fail the request). */
export function toBoqLine(id: string, d: Doc): BoqLine {
  const byFloor: Record<string, number> = {};
  if (d.byFloor && typeof d.byFloor === 'object') {
    for (const [k, v] of Object.entries(d.byFloor as Doc)) if (k.trim() && typeof v === 'number' && Number.isFinite(v)) byFloor[k] = v;
  }
  const sourceVersions = Array.isArray(d.sourceVersions)
    ? (d.sourceVersions as Doc[]).filter((s) => s && typeof s.sheetId === 'string' && typeof s.versionId === 'string').map((s) => ({ sheetId: String(s.sheetId), versionId: String(s.versionId) }))
    : [];
  const override = typeof d.qtyOverride === 'number' && Number.isFinite(d.qtyOverride) ? d.qtyOverride : null;
  return {
    id,
    chapter: String(d.chapter ?? ''),
    code: String(d.code ?? ''),
    description: String(d.description ?? ''),
    qty: num(d.qty, 0),
    qtyOverride: override,
    qtyOverrideReason: str(d.qtyOverrideReason),
    qtyOverrideBy: str(d.qtyOverrideBy),
    qtyOverrideAt: anyIso(d.qtyOverrideAt),
    unit: String(d.unit ?? ''),
    floor: str(d.floor),
    ...(typeof d.lifecycle === 'string' ? { lifecycle: d.lifecycle as BoqLine['lifecycle'] } : {}),
    ...(typeof d.supply === 'string' ? { supply: d.supply as BoqLine['supply'] } : {}),
    level: oneOf(d.level, CONFIDENCE_LEVELS, 'red'),
    reasons: withOverrideReason(
      Array.isArray(d.reasons) ? (d.reasons as unknown[]).filter((r): r is string => typeof r === 'string' && r.length > 0).slice(0, 31) : [],
      override !== null,
    ),
    evidenceRef: str(d.evidenceRef),
    ...(typeof d.locked === 'boolean' ? { locked: d.locked } : {}),
    status: oneOf(d.status, BOQ_LINE_STATUSES, 'draft'),
    reviewedBy: str(d.reviewedBy),
    reviewedAt: anyIso(d.reviewedAt),
    approvedBy: str(d.approvedBy),
    approvedAt: anyIso(d.approvedAt),
    note: str(d.note),
    byFloor,
    evidenceCount: typeof d.evidenceCount === 'number' && Number.isInteger(d.evidenceCount) && d.evidenceCount >= 0 ? d.evidenceCount : 0,
    ruleId: str(d.ruleId),
    sourceVersions,
    computedAt: anyIso(d.computedAt),
    buildId: str(d.buildId),
  };
}

/** "כמות שונתה ידנית" is present iff the line has an override (derived, so a worker rebuild cannot drop it). */
export function withOverrideReason(reasons: string[], overridden: boolean): string[] {
  const rest = reasons.filter((r) => r !== OVERRIDE_REASON);
  return overridden ? [...rest, OVERRIDE_REASON] : rest;
}

export function toBoqBuild(id: string, d: Doc): BoqBuild {
  return {
    id,
    status: oneOf(d.status, BOQ_BUILD_STATUSES, 'queued'),
    jobId: str(d.jobId),
    requestedBy: str(d.requestedBy),
    createdAt: anyIso(d.createdAt),
    startedAt: anyIso(d.startedAt),
    finishedAt: anyIso(d.finishedAt),
    stats: d.stats && typeof d.stats === 'object' ? (isoDeep(d.stats) as BoqBuild['stats']) : null,
    error: err(d.error),
    evidenceRef: str(d.evidenceRef),
  };
}

/** Strictly parsed (API- or worker-written); null when the doc does not match the contract. */
export function toLibraryItem(id: string, d: Doc): ItemLibraryItem | null {
  const r = ItemLibraryItemSchema.safeParse({ tags: [], chapterTitle: '', active: true, updatedAt: null, ...(isoDeep(d) as Doc), id });
  return r.success ? r.data : null;
}

export function toTemplate(id: string, d: Doc): BoqTemplate | null {
  const r = BoqTemplateSchema.safeParse({ vatRate: 0.18, default: false, source: 'import', titleRows: [], updatedAt: null, ...(isoDeep(d) as Doc), id });
  return r.success ? r.data : null;
}

export function toRule(id: string, d: Doc): BoqRule | null {
  const r = BoqRuleSchema.safeParse({ source: 'custom', updatedAt: null, ...(isoDeep(d) as Doc), id });
  return r.success ? r.data : null;
}

export function toLibraryImport(id: string, d: Doc): LibraryImport {
  const base = isoDeep(d) as Doc;
  const r = LibraryImportSchema.safeParse({ stats: null, error: null, finalizedAt: null, jobId: null, projectId: null, ...base, id });
  if (r.success) return r.data;
  // Worker may have written something odd; keep the API-owned fields readable.
  return {
    id,
    orgId: String(base.orgId),
    projectId: str(base.projectId),
    sourceKind: base.sourceKind === 'xlsx' ? 'xlsx' : 'xls',
    storagePath: String(base.storagePath),
    originalName: String(base.originalName ?? ''),
    sizeBytes: num(base.sizeBytes, 1),
    status: oneOf(base.status, LIBRARY_IMPORT_STATUSES, 'failed'),
    jobId: str(base.jobId),
    createdBy: String(base.createdBy),
    createdAt: String(base.createdAt),
    expiresAt: String(base.expiresAt),
    finalizedAt: str(base.finalizedAt),
    stats: null,
    error: err(base.error),
  };
}

// ---------------------------------------------------------------------------
// PATCH line planning (validated against the CURRENT doc inside the transaction)
// ---------------------------------------------------------------------------

export interface LinePatchPlan {
  patch: Doc;
  audit: Record<string, unknown>;
}

/**
 * Turns a validated PATCH request into the field changes for `cur`. Role checks happen in the service before the
 * transaction; this only enforces the state machine (BOQ_LINE_TRANSITIONS, approved lines locked).
 * Throws RepoConflictError('approved_locked' | 'invalid_transition').
 */
export function planLinePatch(projectId: string, cur: BoqLine, req0: PatchBoqLineRequest, actorUid: string, now: unknown): LinePatchPlan {
  let req = req0;
  const patch: Doc = {};
  const audit: Record<string, unknown> = { projectId, lineId: cur.id, code: cur.code };
  const nextStatus = req.status ?? cur.status;
  // Decision (Sprint 3 integration): an override on an APPROVED line is allowed and sends it back to `reviewed`
  // (re-approval required); on draft/reviewed lines the status is kept. Notes alone stay locked on approved lines.
  const overrideOnApproved = cur.status === 'approved' && req.qtyOverride !== undefined;
  if (cur.status === 'approved' && !overrideOnApproved) {
    if (nextStatus !== 'reviewed') throw new RepoConflictError('approved_locked');
  }
  if (overrideOnApproved && req.status !== undefined && req.status !== 'reviewed') throw new RepoConflictError('approved_locked');
  if (overrideOnApproved && req.status === undefined) req = { ...req, status: 'reviewed' };
  if (req.status !== undefined && req.status !== cur.status) {
    if (!canTransition(cur.status, req.status)) throw new RepoConflictError('invalid_transition');
    patch.status = req.status;
    if (cur.status === 'draft' && req.status === 'reviewed') Object.assign(patch, { reviewedBy: actorUid, reviewedAt: now });
    if (req.status === 'approved') Object.assign(patch, { approvedBy: actorUid, approvedAt: now });
    if (cur.status === 'reviewed' && req.status === 'draft') Object.assign(patch, { reviewedBy: null, reviewedAt: null });
    if (cur.status === 'approved' && req.status === 'reviewed') Object.assign(patch, { approvedBy: null, approvedAt: null });
    audit.from = cur.status;
    audit.to = req.status;
  }
  if (req.qtyOverride !== undefined) {
    if (req.qtyOverride === null) {
      Object.assign(patch, { qtyOverride: null, qtyOverrideReason: null, qtyOverrideBy: null, qtyOverrideAt: null });
    } else {
      Object.assign(patch, { qtyOverride: req.qtyOverride, qtyOverrideReason: req.reason ?? null, qtyOverrideBy: actorUid, qtyOverrideAt: now });
    }
    patch.reasons = withOverrideReason(cur.reasons ?? [], req.qtyOverride !== null);
    audit.qty = cur.qty;
    audit.prevQtyOverride = cur.qtyOverride ?? null;
    audit.qtyOverride = req.qtyOverride;
  }
  if (req.note !== undefined) {
    patch.note = req.note;
    audit.noteChanged = true; // the text itself stays out of the audit log
  }
  patch.updatedAt = now;
  return { patch, audit };
}

/** Line counts (summary + export). */
export function countLines(lines: readonly BoqLine[]) {
  const c = { lines: lines.length, green: 0, yellow: 0, red: 0, draft: 0, reviewed: 0, approved: 0, overridden: 0 };
  for (const l of lines) {
    c[l.level]++;
    c[l.status]++;
    if (l.qtyOverride !== null && l.qtyOverride !== undefined) c.overridden++;
  }
  return c;
}
