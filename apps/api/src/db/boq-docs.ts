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
  isQtyChangedReason,
  LINE_ORIGINS,
  needsReapproval,
  QuickActionSchema,
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
    // Sprint 4 (worker): order quantity / waste for material lines, number of manual items.
    ...(typeof d.orderQty === 'number' && Number.isFinite(d.orderQty) && d.orderQty >= 0 ? { orderQty: d.orderQty } : {}),
    ...(typeof d.wasteFactor === 'number' && d.wasteFactor >= 0 && d.wasteFactor <= 0.5 ? { wasteFactor: d.wasteFactor } : {}),
    ...(typeof d.manualCount === 'number' && Number.isInteger(d.manualCount) && d.manualCount >= 0 ? { manualCount: d.manualCount } : {}),
    // Stage 10 (A-API-06): approval baseline (API on approve; worker keeps / clears it on rebuild).
    ...(typeof d.approvedQty === 'number' && Number.isFinite(d.approvedQty) ? { approvedQty: d.approvedQty } : d.approvedQty === null ? { approvedQty: null } : {}),
    ...(d.approvedQtyAt !== undefined ? { approvedQtyAt: anyIso(d.approvedQtyAt) } : {}),
    ...(d.approvalInvalidated !== undefined ? { approvalInvalidated: approvalInvalidatedOf(d.approvalInvalidated) } : {}),
    // Stage 10 (A-pipeline-12): per-room split (worker).
    ...(Array.isArray(d.byRoom) ? { byRoom: byRoomOf(d.byRoom) } : {}),
    // Sprint 6 (worker): origin, manual-completion flag (qty null → 0 + needsInput), quick action.
    ...(oneOfOrNull(d.origin, LINE_ORIGINS) ? { origin: d.origin as BoqLine['origin'] } : {}),
    ...(typeof d.needsInput === 'boolean' ? { needsInput: d.needsInput } : d.qty === null ? { needsInput: true } : {}),
    ...(d.quickAction !== undefined ? { quickAction: quickActionOf(d.quickAction) } : {}),
  };
}

const oneOfOrNull = (v: unknown, allowed: readonly string[]): boolean => typeof v === 'string' && allowed.includes(v);

/** Worker-written quick action (tolerant: malformed → null = no action offered). */
export function quickActionOf(v: unknown): BoqLine['quickAction'] {
  const r = QuickActionSchema.safeParse(v);
  return r.success ? r.data : null;
}

function approvalInvalidatedOf(v: unknown): BoqLine['approvalInvalidated'] {
  if (!v || typeof v !== 'object') return null;
  const o = v as Doc;
  if (typeof o.fromQty !== 'number' || typeof o.toQty !== 'number' || !Number.isFinite(o.fromQty) || !Number.isFinite(o.toQty)) return null;
  return { fromQty: o.fromQty, toQty: o.toQty, approvedBy: str(o.approvedBy), approvedAt: anyIso(o.approvedAt), buildId: str(o.buildId), at: anyIso(o.at) };
}

function byRoomOf(v: unknown[]): NonNullable<BoqLine['byRoom']> {
  const s = (x: unknown, n: number) => (typeof x === 'string' ? x.slice(0, n) : null);
  return (v as Doc[])
    .filter((r) => r && typeof r.qty === 'number' && Number.isFinite(r.qty))
    .slice(0, 200)
    .map((r) => ({
      sheetId: typeof r.sheetId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(r.sheetId) ? r.sheetId : null,
      roomId: s(r.roomId, 128),
      name: s(r.name, 100),
      type: s(r.type, 32),
      floor: s(r.floor, 32),
      qty: r.qty as number,
    }));
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
    ...(d.trigger === 'manual' || d.trigger === 'auto' ? { trigger: d.trigger } : {}),
    ...(d.debounceUntil !== undefined ? { debounceUntil: anyIso(d.debounceUntil) } : {}),
    ...(d.afterBuildId !== undefined ? { afterBuildId: str(d.afterBuildId) } : {}),
    ...(Array.isArray(d.approvalsInvalidated) ? { approvalsInvalidated: approvalsInvalidatedOf(d.approvalsInvalidated) } : {}),
    ...(d.approvalsAuditedAt !== undefined ? { approvalsAuditedAt: anyIso(d.approvalsAuditedAt) } : {}),
  };
}

/** Stage 10: worker-written `approvalsInvalidated` (tolerant: malformed entries dropped, ≤ 500). */
export function approvalsInvalidatedOf(v: unknown): NonNullable<BoqBuild['approvalsInvalidated']> {
  if (!Array.isArray(v)) return [];
  return (v as Doc[])
    .filter((e) => e && typeof e.lineId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(e.lineId) && typeof e.fromQty === 'number' && Number.isFinite(e.fromQty) && typeof e.toQty === 'number' && Number.isFinite(e.toQty))
    .slice(0, 500)
    .map((e) => ({ lineId: e.lineId as string, code: String(e.code ?? '').slice(0, 32), fromQty: e.fromQty as number, toQty: e.toQty as number }));
}

/** Audit payload of one invalidated approval (A-API-06; actor = the build). */
export const APPROVAL_INVALIDATED_ACTOR = 'system:boq.build';
export const approvalInvalidatedAudit = (projectId: string, buildId: string, e: { lineId: string; code: string; fromQty: number; toQty: number }) => ({
  actorId: APPROVAL_INVALIDATED_ACTOR,
  actorKind: 'system' as const,
  entity: 'boqLines',
  entityId: e.lineId,
  action: 'approval_invalidated',
  after: { projectId, buildId, lineId: e.lineId, code: e.code, fromQty: e.fromQty, toQty: e.toQty, from: 'approved', to: 'reviewed' },
});

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
    if (req.status === 'approved') {
      // Stage 10 (A-API-06): the computed qty a human approved — a rebuild that changes it invalidates the approval.
      Object.assign(patch, { approvedBy: actorUid, approvedAt: now, approvedQty: cur.qty, approvedQtyAt: now });
      const kept = (cur.reasons ?? []).filter((r) => !isQtyChangedReason(r));
      if (kept.length !== (cur.reasons ?? []).length) patch.reasons = kept;
      audit.qty = cur.qty;
    }
    if (cur.status === 'reviewed' && req.status === 'draft') Object.assign(patch, { reviewedBy: null, reviewedAt: null });
    if (cur.status === 'approved' && req.status === 'reviewed') Object.assign(patch, { approvedBy: null, approvedAt: null, approvedQty: null, approvedQtyAt: null });
    audit.from = cur.status;
    audit.to = req.status;
  }
  if (req.qtyOverride !== undefined) {
    if (req.qtyOverride === null) {
      Object.assign(patch, { qtyOverride: null, qtyOverrideReason: null, qtyOverrideBy: null, qtyOverrideAt: null });
    } else {
      Object.assign(patch, { qtyOverride: req.qtyOverride, qtyOverrideReason: req.reason ?? null, qtyOverrideBy: actorUid, qtyOverrideAt: now });
    }
    patch.reasons = withOverrideReason((patch.reasons as string[] | undefined) ?? cur.reasons ?? [], req.qtyOverride !== null);
    audit.qty = cur.qty;
    audit.prevQtyOverride = cur.qtyOverride ?? null;
    audit.qtyOverride = req.qtyOverride;
    // Sprint 5 (FR-26 history "before/after + reason"): the override's justification is part of the record. The free
    // text NOTE never is (noteChanged only).
    audit.reason = req.qtyOverride !== null ? (req.reason ?? null) : null;
  }
  if (req.note !== undefined) {
    patch.note = req.note;
    audit.noteChanged = true; // the text itself stays out of the audit log
  }
  patch.updatedAt = now;
  return { patch, audit };
}

// ---------------------------------------------------------------------------
// Sprint 6: bulk status (POST …/boq/lines/batch-status) — per-line plan, validated inside each line's transaction
// ---------------------------------------------------------------------------

export type BatchSkipReason = 'already' | 'forbidden' | 'red' | 'not_found';
export type BatchLinePlan = { skip: BatchSkipReason } | { patch: Doc; audit: Record<string, unknown>; from: BoqLine['status']; to: BoqLine['status'] };

/**
 * One line of a bulk status change, with exactly the single-PATCH rules (`planLinePatch`, reviewer role): forward only
 * (draft → reviewed; → approved chains draft → reviewed → approved in one plan and one audit event); an approved line
 * that needs re-approval (Stage 10: qty changed since the approval) is re-approved by `to: 'approved'` (new
 * approvedQty baseline, qty-changed chip dropped); red lines are skipped unless `includeRed`. The audit payload carries
 * `batchId` (history: "אושר (פעולה קבוצתית)").
 */
export function planBatchStatus(projectId: string, cur: BoqLine | null, to: 'reviewed' | 'approved', opts: { includeRed: boolean; allowed: boolean; batchId: string }, actorUid: string, now: unknown): BatchLinePlan {
  if (!cur) return { skip: 'not_found' };
  const reapprove = to === 'approved' && needsReapproval(cur);
  const rank = { draft: 0, reviewed: 1, approved: 2 } as const;
  if (!reapprove && rank[cur.status] >= rank[to]) return { skip: 'already' };
  if (!opts.allowed) return { skip: 'forbidden' };
  if (cur.level === 'red' && !opts.includeRed) return { skip: 'red' };
  let patch: Doc;
  let audit: Record<string, unknown>;
  if (reapprove) {
    patch = { approvedBy: actorUid, approvedAt: now, approvedQty: cur.qty, approvedQtyAt: now, approvalInvalidated: null, reasons: (cur.reasons ?? []).filter((r) => !isQtyChangedReason(r)), updatedAt: now };
    audit = { projectId, lineId: cur.id, code: cur.code, from: 'reviewed', to: 'approved', qty: cur.qty, reapproval: true };
  } else {
    const steps: Array<'reviewed' | 'approved'> = cur.status === 'draft' && to === 'approved' ? ['reviewed', 'approved'] : [to];
    let line = cur;
    patch = {};
    audit = {};
    for (const st of steps) {
      const p = planLinePatch(projectId, line, { status: st }, actorUid, now);
      Object.assign(patch, p.patch);
      audit = { ...audit, ...p.audit };
      line = { ...line, ...(p.patch as Partial<BoqLine>), status: st };
    }
    audit.from = cur.status;
    audit.to = to;
  }
  return { patch, audit: { ...audit, batchId: opts.batchId }, from: reapprove ? 'reviewed' : cur.status, to };
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
