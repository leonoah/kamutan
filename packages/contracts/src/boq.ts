/**
 * Bill of quantities (כתב כמויות) — Sprint 3 (docs/agents/SPRINT3_BRIEF.md).
 *
 * Firestore:
 *  - orgs/{o}/projects/{p}/boqLines/{lineId}   worker-computed lines (+ API-only review fields, see below)
 *  - orgs/{o}/projects/{p}/boqBuilds/{buildId} one aggregation run (API creates `queued`, worker runs it)
 *  - orgs/{o}/projects/{p}/exports/{exportId}  one Excel export (API)
 *  - project doc field `boq` (ProjectBoqSummary)
 * Storage:
 *  - orgs/{o}/projects/{p}/boq/{buildId}/evidence.json.gz      `kamutan.boq-evidence/1`
 *  - orgs/{o}/projects/{p}/sheets/{s}/versions/{v}/links.json.gz `kamutan.links/1`
 *  - orgs/{o}/projects/{p}/exports/{exportId}.xlsx              API-written, signed URL only
 *
 * Item codes are TEXT everywhere ("4.10" !== "4.1", decision #9).
 */
import { z } from 'zod';
import { pageOf, TimestampSchema } from './common.js';
import { DocIdSchema, UidSchema } from './org.js';
import { ConfidenceLevelSchema, type ConfidenceLevel } from './review.js';
import { FloorSchema, ProcessingErrorSchema } from './sheets.js';

export const BOQ_LINE_STATUSES = ['draft', 'reviewed', 'approved'] as const;
export const BoqLineStatusSchema = z.enum(BOQ_LINE_STATUSES);
export type BoqLineStatus = z.infer<typeof BoqLineStatusSchema>;

/**
 * Allowed status transitions. Since Sprint 3 they are performed ONLY through
 * `PATCH /v1/projects/:pid/boq/lines/:lineId` (reviewer+, audited); boqLines are not client-writable in
 * firestore.rules anymore.
 */
export const BOQ_LINE_TRANSITIONS: Readonly<Record<BoqLineStatus, readonly BoqLineStatus[]>> = Object.freeze({
  draft: ['reviewed'],
  reviewed: ['approved', 'draft'],
  approved: ['reviewed'],
});

export const canTransition = (from: BoqLineStatus, to: BoqLineStatus): boolean => BOQ_LINE_TRANSITIONS[from].includes(to);

/** Hebrew status labels (UX §statuses; also the export's "סטטוס" column). */
export const BOQ_STATUS_HE: Readonly<Record<BoqLineStatus, string>> = Object.freeze({ draft: 'טיוטה', reviewed: 'נבדק', approved: 'אושר' });
/** Hebrew confidence labels (UX §confidence language; also the export's "רמת ביטחון" column). */
export const CONFIDENCE_HE: Readonly<Record<ConfidenceLevel, string>> = Object.freeze({ green: 'מאומת', yellow: 'סביר', red: 'לבדיקה' });

export const LIFECYCLES = ['existing', 'new', 'demolish'] as const;
export const SUPPLY_KINDS = ['contractor', 'client', 'existing'] as const;

/** BOQ item code is TEXT ("4.10" !== "4.1") in every layer (decision #9). */
export const ItemCodeSchema = z.string().min(1).max(32).regex(/^[0-9A-Za-z.\-/]+$/, 'invalid item code');

/** Chapter code ("04", "08"); compared after stripping leading zeros (`chapterKey`). */
export const ChapterCodeSchema = z.string().min(1).max(32);
/** "04" → "4", "4" → "4", "A1" → "a1". */
export const chapterKey = (code: string): string => code.trim().toLowerCase().replace(/^0+(?=\w)/, '');

/** Natural order of item codes: "4.9" < "4.10" < "4.11" (numeric parts compared as numbers). */
export function compareItemCodes(a: string, b: string): number {
  const pa = a.split(/[.\-/]/);
  const pb = b.split(/[.\-/]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
      if (x.length !== y.length) return x.length - y.length; // "4.1" before "4.10" only when numerically equal
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Per-floor quantities (`{floor: qty}`); floor = FloorSchema text, "" is not allowed. */
export const ByFloorSchema = z.record(FloorSchema, z.number().finite());

export const SourceVersionRefSchema = z.object({ sheetId: DocIdSchema, versionId: DocIdSchema }).strict();
export type SourceVersionRef = z.infer<typeof SourceVersionRefSchema>;

const ReasonsSchema = z.array(z.string().min(1).max(200)).max(32);

/** Stage 10: one room of `BoqLine.byRoom`. `type` = a RoomType of understanding.ts (kept open here). */
export const BoqLineRoomSchema = z.object({
  sheetId: DocIdSchema.nullable(),
  roomId: z.string().max(128).nullable(),
  name: z.string().max(100).nullable(),
  type: z.string().max(32).nullable(),
  floor: z.string().max(32).nullable(),
  qty: z.number().finite(),
});
export type BoqLineRoom = z.infer<typeof BoqLineRoomSchema>;

// --- Sprint 6: line origin, manual-completion flag and quick action -------------------------------------------

export const LINE_ORIGINS = ['detected', 'text', 'geometry', 'suggested', 'manual'] as const;
export const LineOriginSchema = z.enum(LINE_ORIGINS);
export type LineOrigin = z.infer<typeof LineOriginSchema>;
/** Hebrew origin labels (BOQ panel badge; Excel "ראיות" column "מקור"). */
export const LINE_ORIGIN_HE: Readonly<Record<LineOrigin, string>> = Object.freeze({
  detected: 'זוהה בשרטוט',
  text: 'מטקסט בשרטוט',
  geometry: 'נמדד מהשרטוט',
  suggested: 'הצעה',
  manual: 'הוזן ידנית',
});
/** Chip / label of a line whose quantity must still be entered (`needsInput`). */
export const NEEDS_INPUT_HE = 'להשלמה ידנית';

/** One-click actions of a line (UX: opens the measure / count tool pre-bound to the line and the sheet, or confirms). */
export const QUICK_ACTION_KINDS = ['measure_area', 'measure_length', 'count', 'confirm'] as const;
export const QuickActionKindSchema = z.enum(QUICK_ACTION_KINDS);
export type QuickActionKind = z.infer<typeof QuickActionKindSchema>;
export const QuickActionSchema = z.object({ kind: QuickActionKindSchema, sheetId: DocIdSchema.nullable() }).strict();
export type QuickAction = z.infer<typeof QuickActionSchema>;

/** Default quick action for a unit: מ"ר → measure_area, מ"א → measure_length, קומפלט → confirm, everything else → count. */
export function defaultQuickActionFor(unit: string | null | undefined): QuickActionKind {
  const u = (unit ?? '').trim();
  if (['מ"ר', 'מ״ר', "מ''ר", 'm2', 'm²'].includes(u)) return 'measure_area';
  if (['מ"א', 'מ״א', "מ''א", "מ'", 'm'].includes(u)) return 'measure_length';
  if (['קומפלט', 'קומפ\'', 'lump'].includes(u)) return 'confirm';
  return 'count';
}

/** Effective origin of a line (absent = `detected`, the Sprint 3–5 behaviour). */
export const lineOrigin = (l: { origin?: LineOrigin | undefined }): LineOrigin => l.origin ?? 'detected';

/**
 * orgs/{orgId}/projects/{projectId}/boqLines/{lineId}.
 * Worker-written (boq.build): chapter, code, description, qty, unit, floor, level, reasons, byFloor, evidenceCount,
 * ruleId, sourceVersions, computedAt, evidenceRef. API-written (PATCH, audited): status + stamps, qtyOverride (+ reason,
 * by, at), note. A rebuild NEVER overwrites `BOQ_LINE_PRESERVED_FIELDS` (see `applyRebuild`).
 */
export const BoqLineSchema = z.object({
  id: DocIdSchema,
  chapter: ChapterCodeSchema,
  code: ItemCodeSchema,
  description: z.string().max(2000),
  /** Computed quantity (sum of byFloor). */
  qty: z.number().finite(),
  /** User override (editor+, reason required). Effective quantity = qtyOverride ?? qty (`effectiveQty`). */
  qtyOverride: z.number().finite().nullable().optional(),
  qtyOverrideReason: z.string().max(500).nullable().optional(),
  qtyOverrideBy: UidSchema.nullable().optional(),
  qtyOverrideAt: TimestampSchema.nullable().optional(),
  unit: z.string().max(32),
  /** Single floor when the line is floor-specific; null for project-wide lines (use byFloor). */
  floor: z.string().max(32).nullable().optional(),
  lifecycle: z.enum(LIFECYCLES).optional(),
  supply: z.enum(SUPPLY_KINDS).optional(),
  /** Min level of its evidence (decision #7). */
  level: ConfidenceLevelSchema,
  /** Union of evidence reasons + rule reasons (Hebrew chips), deduplicated. */
  reasons: ReasonsSchema.optional(),
  /** Storage path of the build's evidence file (orgs/{o}/projects/{p}/boq/{buildId}/evidence.json.gz). */
  evidenceRef: z.string().max(1024).nullable().optional(),
  locked: z.boolean().optional(),
  status: BoqLineStatusSchema,
  reviewedBy: UidSchema.nullable().optional(),
  reviewedAt: TimestampSchema.nullable().optional(),
  approvedBy: UidSchema.nullable().optional(),
  approvedAt: TimestampSchema.nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
  // --- Sprint 3 (worker) ---
  byFloor: ByFloorSchema.optional(),
  evidenceCount: z.number().int().nonnegative().optional(),
  /** boqRules/{ruleId} that produced the line (null = manual / unmapped). */
  ruleId: DocIdSchema.nullable().optional(),
  sourceVersions: z.array(SourceVersionRefSchema).max(500).optional(),
  computedAt: TimestampSchema.nullable().optional(),
  /** boqBuilds/{buildId} that last computed the line. */
  buildId: DocIdSchema.nullable().optional(),
  // --- Sprint 4 (worker) ---
  /** Order quantity = effective qty × (1 + wasteFactor), for material lines (tiling); null/absent = same as qty. */
  orderQty: z.number().finite().nonnegative().nullable().optional(),
  /** Waste factor used for `orderQty` (0.07 = 7%). */
  wasteFactor: z.number().finite().min(0).max(0.5).nullable().optional(),
  /** Manual items (corrections add/count/measure) behind this line. */
  manualCount: z.number().int().nonnegative().optional(),
  // --- Stage 10 (A-API-06 / A-pipeline-08) ---
  /**
   * Computed `qty` at the moment of approval (API stamps it on approve; the worker keeps it while the approval holds).
   * A rebuild whose qty differs from it invalidates the approval (`needsReapproval`).
   */
  approvedQty: z.number().finite().nullable().optional(),
  /** `approvedAt` the `approvedQty` belongs to (worker bookkeeping: a re-approval starts a new baseline). */
  approvedQtyAt: TimestampSchema.nullable().optional(),
  /**
   * Stage 10 (Worker-BOQ, A-pipeline-08): set by the rebuild that dropped an approved line to `reviewed` because its
   * computed qty changed; kept while the line stays `reviewed`, removed on re-approval or when it goes back to draft.
   */
  approvalInvalidated: z
    .object({
      fromQty: z.number().finite(),
      toQty: z.number().finite(),
      approvedBy: UidSchema.nullable().optional(),
      approvedAt: TimestampSchema.nullable().optional(),
      buildId: DocIdSchema.nullable().optional(),
      at: TimestampSchema.nullable().optional(),
    })
    .nullable()
    .optional(),
  /**
   * Stage 10 (Worker-BOQ, A-pipeline-12): quantity per canonical room of the floor (≤ 200), sorted by floor then name;
   * `roomId: null` = items outside every room. Sums to `qty`. Excel sheet "פירוט לפי חדר".
   */
  byRoom: z.array(BoqLineRoomSchema).max(200).optional(),
  // --- Sprint 6 (Worker-BOQ writes; all optional, absent on older lines) ---
  /**
   * Where the quantity comes from: `detected` = symbols / link groups / rooms (Sprints 3–5 rules; the default when
   * absent), `text` = notes / callouts / legend rows / panel schedules (`text_item`), `geometry` = hatches / wall runs /
   * polylines / stairs (`area_item` / `length_item`), `suggested` = offered by a `suggested_item` / one-off /
   * template rule (never green), `manual` = only manual items (corrections) behind it.
   */
  origin: LineOriginSchema.optional(),
  /** True when the quantity still has to be entered / measured by a person ("להשלמה ידנית"); then `qty` is 0. */
  needsInput: z.boolean().optional(),
  /** The one-click action the BOQ panel offers (pre-bound to the line and, when known, the sheet). */
  quickAction: QuickActionSchema.nullable().optional(),
});
export type BoqLine = z.infer<typeof BoqLineSchema>;

/** Stage 10: chip of a line whose computed quantity changed after a human approved it (prefix of the full reason). */
export const QTY_CHANGED_REASON = 'הכמות השתנתה מאז האישור';
const fmtQty = (n: number): string => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
/** "הכמות השתנתה מאז האישור (6 → 7)" — the reason the rebuild writes when it drops an approved line to "נבדק". */
export const qtyChangedReason = (from: number, to: number): string => `${QTY_CHANGED_REASON} (${fmtQty(from)} → ${fmtQty(to)})`;
/** True for reasons written by `qtyChangedReason` (or the bare Sprint-5 chip). */
export const isQtyChangedReason = (r: string): boolean => r === QTY_CHANGED_REASON || r.startsWith(`${QTY_CHANGED_REASON} (`);

/**
 * Stage 10 decision: an approved line whose computed quantity changed since the approval is NOT approved any more
 * (the export gate, the share snapshot and the Excel status treat it as "נבדק" until a human re-approves it). True when
 * the line is still `approved` but its `approvedQty` differs from `qty`, or it carries the qty-changed chip (a worker
 * that keeps the status, Sprint 5 behaviour).
 */
export function needsReapproval(l: Pick<BoqLine, 'status' | 'qty'> & { approvedQty?: number | null; qtyOverride?: number | null; reasons?: readonly string[] | undefined }): boolean {
  if (l.status !== 'approved') return false;
  const overridden = typeof l.qtyOverride === 'number';
  if (!overridden && typeof l.approvedQty === 'number' && Number.isFinite(l.approvedQty) && l.approvedQty !== l.qty) return true;
  return (l.reasons ?? []).some(isQtyChangedReason);
}

/** Status a line effectively has for exports / gates (`approved` lines that need re-approval count as `reviewed`). */
export const effectiveStatus = (l: Parameters<typeof needsReapproval>[0]): BoqLineStatus => (needsReapproval(l) ? 'reviewed' : l.status);

/**
 * FR-31 export gate (Stage 10: every export — xlsx, marked PDF, share link): lines that block while the org's
 * `blockExportOnRed` is on = red lines not (effectively) approved + approved lines whose qty changed since approval.
 */
export function exportBlockingLines<T extends Pick<BoqLine, 'status' | 'qty' | 'level'> & { approvedQty?: number | null; qtyOverride?: number | null; reasons?: readonly string[] | undefined }>(lines: readonly T[]): T[] {
  return lines.filter((l) => needsReapproval(l) || (l.level === 'red' && l.status !== 'approved'));
}

/** Effective quantity of a line (override wins). */
export const effectiveQty = (l: Pick<BoqLine, 'qty' | 'qtyOverride'>): number => l.qtyOverride ?? l.qty;

/**
 * @deprecated Sprint 3: boqLines are no longer client-writable (firestore.rules: write false). Status / note /
 * qtyOverride changes go through `PATCH /v1/projects/:pid/boq/lines/:lineId`. Kept for older imports.
 */
export const BOQ_LINE_CLIENT_FIELDS = ['status', 'reviewedBy', 'reviewedAt', 'approvedBy', 'approvedAt', 'note'] as const;

/** Fields the API PATCH may change (role-checked, audited). */
export const BOQ_LINE_API_FIELDS = [
  'status',
  'reviewedBy',
  'reviewedAt',
  'approvedBy',
  'approvedAt',
  'note',
  'qtyOverride',
  'qtyOverrideReason',
  'qtyOverrideBy',
  'qtyOverrideAt',
  'updatedAt',
] as const;

/** Fields a rebuild (worker `boq.build`) must NEVER overwrite on an existing line (human wins, UX principle 5). */
export const BOQ_LINE_PRESERVED_FIELDS = [
  'status',
  'reviewedBy',
  'reviewedAt',
  'approvedBy',
  'approvedAt',
  'note',
  'qtyOverride',
  'qtyOverrideReason',
  'qtyOverrideBy',
  'qtyOverrideAt',
  'locked',
] as const;

/**
 * Reference semantics of a rebuild (the Python worker implements the same): computed fields come from the new build,
 * preserved fields from the existing doc; a new line starts as `draft` without override.
 * Stage 10 (A-API-06 / A-pipeline-08 decision): an APPROVED line whose computed qty differs from the approved baseline
 * (`approvedQty`, else the previous `qty`) drops to `reviewed` (approval stamps cleared) with the reason
 * `qtyChangedReason(X, Y)` — it must be re-approved. Not when the line has a `qtyOverride` (the human quantity was
 * approved, not the computed one). The worker lists it in the build's `approvalsInvalidated`; the
 * API appends one audit event `boqLines/approval_invalidated` {projectId, buildId, code, fromQty, toQty} per entry.
 */
export function applyRebuild<T extends Record<string, unknown>>(existing: Record<string, unknown> | null, computed: T): T & Record<string, unknown> {
  const out: Record<string, unknown> = { ...computed };
  for (const f of BOQ_LINE_PRESERVED_FIELDS) {
    if (existing && f in existing) out[f] = existing[f];
    else if (f === 'status') out[f] = 'draft';
  }
  const reasons = (Array.isArray(computed.reasons) ? (computed.reasons as unknown[]) : []).filter((r): r is string => typeof r === 'string' && !isQtyChangedReason(r));
  // A line with a qtyOverride keeps its approval: the human quantity is what was approved (Worker-BOQ, same rule).
  if (existing && existing.status === 'approved' && typeof computed.qty === 'number' && typeof existing.qtyOverride !== 'number') {
    const base = typeof existing.approvedQty === 'number' ? existing.approvedQty : typeof existing.qty === 'number' ? existing.qty : null;
    if (base !== null && base !== computed.qty) {
      out.status = 'reviewed';
      out.approvedBy = null;
      out.approvedAt = null;
      out.approvedQty = null;
      out.approvedQtyAt = null;
      out.reasons = [qtyChangedReason(base, computed.qty), ...reasons].slice(0, 32);
      return out as T & Record<string, unknown>;
    }
    out.approvedQty = base;
    out.approvedQtyAt = existing.approvedQtyAt ?? existing.approvedAt ?? null;
  }
  if (Array.isArray(computed.reasons)) out.reasons = reasons;
  return out as T & Record<string, unknown>;
}

/** Stage 10: audit action of the rebuild that drops an approved line to "נבדק" (worker-written, see applyRebuild). */
export const APPROVAL_INVALIDATED_ACTION = 'approval_invalidated';

// ---------------------------------------------------------------------------
// Builds + project summary
// ---------------------------------------------------------------------------

export const BOQ_BUILD_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export const BoqBuildStatusSchema = z.enum(BOQ_BUILD_STATUSES);
export type BoqBuildStatus = z.infer<typeof BoqBuildStatusSchema>;

/**
 * Sprint 6: how much of the org library the build covers. `libraryCodes` = distinct codes of active library items;
 * `produced` = of those, codes with a computed line (origin detected / text / geometry / manual); `suggested` = codes
 * with a suggested line (origin suggested, incl. needsInput); `missing` = active library codes with no line at all
 * (natural order, ≤ 500). `byChapter` (optional, key = `chapterKey`, e.g. "4") feeds "x מתוך y סעיפים חושבו מהשרטוט".
 */
const CoverageCountsSchema = z.object({
  libraryCodes: z.number().int().nonnegative(),
  produced: z.number().int().nonnegative(),
  suggested: z.number().int().nonnegative(),
});
export const BoqCoverageSchema = CoverageCountsSchema.extend({
  missing: z.array(ItemCodeSchema).max(500),
  byChapter: z.record(z.string().max(32), CoverageCountsSchema.extend({ missing: z.number().int().nonnegative() })).optional(),
}).passthrough();
export type BoqCoverage = z.infer<typeof BoqCoverageSchema>;

export const BoqBuildStatsSchema = z
  .object({
    lines: z.number().int().nonnegative(),
    green: z.number().int().nonnegative(),
    yellow: z.number().int().nonnegative(),
    red: z.number().int().nonnegative(),
    sheets: z.number().int().nonnegative(),
    evidence: z.number().int().nonnegative(),
    /** Detections counted twice and removed by cross-sheet de-duplication. */
    duplicatesRemoved: z.number().int().nonnegative().optional(),
    /** Detections no enabled rule mapped to an item. */
    unmapped: z.number().int().nonnegative().optional(),
    /** Sprint 5: calibration table the build's levels were capped with. */
    calibration: z.object({ mode: z.enum(["conservative", "full"]), version: z.string().min(1).max(64) }).optional(),
    /** Sprint 6: library coverage of the build (Worker-BOQ). */
    coverage: BoqCoverageSchema.optional(),
  })
  .passthrough();
export type BoqBuildStats = z.infer<typeof BoqBuildStatsSchema>;

/** orgs/{o}/projects/{p}/boqBuilds/{buildId}. API creates `queued` (+ jobs/{jobId}); the worker moves it on. */
export const BoqBuildSchema = z.object({
  id: DocIdSchema,
  status: BoqBuildStatusSchema,
  jobId: DocIdSchema.nullable(),
  requestedBy: UidSchema.nullable(),
  createdAt: TimestampSchema.nullable(),
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
  stats: BoqBuildStatsSchema.nullable(),
  error: ProcessingErrorSchema.nullable(),
  /** Set by the worker on success: orgs/{o}/projects/{p}/boq/{buildId}/evidence.json.gz */
  evidenceRef: z.string().max(1024).nullable().optional(),
  // --- Sprint 4: debounced automatic rebuilds (see BOQ_REBUILD_DEBOUNCE_MS) ---
  /** `manual` = POST …/boq/build; `auto` = scheduled by a correction / room-settings change. */
  trigger: z.enum(['manual', 'auto']).optional(),
  /**
   * The worker must not start before this time: on receipt it sleeps until `debounceUntil`, RE-READS the build doc
   * (further edits push it back) and loops, capped at BOQ_REBUILD_MAX_WAIT_MS after `createdAt`.
   */
  debounceUntil: TimestampSchema.nullable().optional(),
  /** Follow-up build queued while another build was running: start only once that build is terminal. */
  afterBuildId: DocIdSchema.nullable().optional(),
  // --- Stage 10 (A-pipeline-08 / A-API-06) ---
  /** Worker: approved lines this build dropped to `reviewed` (qty changed), ≤ 500. */
  approvalsInvalidated: z
    .array(z.object({ lineId: DocIdSchema, code: z.string().max(32), fromQty: z.number().finite(), toQty: z.number().finite() }))
    .max(500)
    .optional(),
  /** API: when it appended the `boqLines/approval_invalidated` audit events of `approvalsInvalidated` (idempotency stamp). */
  approvalsAuditedAt: TimestampSchema.nullable().optional(),
});
export type BoqBuild = z.infer<typeof BoqBuildSchema>;

/**
 * Project doc field `boq`. Worker: `latestBuildId`, `builtAt`, `stale=false` on success. API: `pendingBuildId` when a
 * build is requested, `stale=true` when a legend entry / unknown cluster / sheet confirmation / rule changes.
 */
export const ProjectBoqSummarySchema = z.object({
  latestBuildId: DocIdSchema.nullable(),
  builtAt: TimestampSchema.nullable(),
  stale: z.boolean(),
  /** Build requested by the API and not finished yet (dedupe of POST build). */
  pendingBuildId: DocIdSchema.nullable().optional(),
  /** Why the BOQ became stale (last change), e.g. "legend", "cluster", "sheet", "rule". */
  staleReason: z.string().max(64).nullable().optional(),
  staleAt: TimestampSchema.nullable().optional(),
});
export type ProjectBoqSummary = z.infer<typeof ProjectBoqSummarySchema>;

export const STALE_REASONS = ['legend', 'cluster', 'sheet', 'rule', 'mapping', 'library', 'correction', 'room'] as const;
export type StaleReason = (typeof STALE_REASONS)[number];

/** A build stuck in queued/running longer than this no longer blocks a new POST build. */
export const BOQ_BUILD_STUCK_MS = 30 * 60 * 1000;
/** Sprint 4: automatic rebuild after a correction / room-settings change starts ≥ this long after the LAST change. */
export const BOQ_REBUILD_DEBOUNCE_MS = 5_000;
/** Upper bound of the debounce wait (continuous editing still rebuilds at least this often). */
export const BOQ_REBUILD_MAX_WAIT_MS = 60_000;

export const RequestBoqBuildResponseSchema = z.object({
  build: BoqBuildSchema,
  /** True when an unfinished build already existed and was returned instead of a new one. */
  deduplicated: z.boolean(),
  jobId: DocIdSchema.nullable(),
});
export type RequestBoqBuildResponse = z.infer<typeof RequestBoqBuildResponseSchema>;

// ---------------------------------------------------------------------------
// GET /v1/projects/:pid/boq
// ---------------------------------------------------------------------------

export const BOQ_LINES_MAX_PAGE = 500;

export const GetBoqQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(BOQ_LINES_MAX_PAGE).default(200),
  chapter: ChapterCodeSchema.optional(),
  level: ConfidenceLevelSchema.optional(),
  status: BoqLineStatusSchema.optional(),
});
export type GetBoqQuery = z.infer<typeof GetBoqQuerySchema>;

export const BoqCountsSchema = z.object({
  lines: z.number().int().nonnegative(),
  green: z.number().int().nonnegative(),
  yellow: z.number().int().nonnegative(),
  red: z.number().int().nonnegative(),
  draft: z.number().int().nonnegative(),
  reviewed: z.number().int().nonnegative(),
  approved: z.number().int().nonnegative(),
  overridden: z.number().int().nonnegative(),
});
export type BoqCounts = z.infer<typeof BoqCountsSchema>;

export const BoqSummarySchema = z.object({
  latestBuildId: DocIdSchema.nullable(),
  builtAt: TimestampSchema.nullable(),
  stale: z.boolean(),
  staleReason: z.string().max(64).nullable(),
  /** The pending build when one is queued/running, else the latest one (null before the first build). */
  build: BoqBuildSchema.nullable(),
  /** Counts over ALL lines of the project (not just this page). */
  counts: BoqCountsSchema,
  /** Floors present in any line's byFloor, in first-seen order of the sorted lines. */
  floors: z.array(z.string()),
  /** Org setting: export refused (409) while red lines exist. */
  blockExportOnRed: z.boolean(),
});
export type BoqSummary = z.infer<typeof BoqSummarySchema>;

/** Lines sorted by (chapter, natural code, id); cursor = last line id of the page. */
export const BoqViewSchema = z.object({
  summary: BoqSummarySchema,
  items: z.array(BoqLineSchema),
  nextCursor: z.string().nullable(),
});
export type BoqView = z.infer<typeof BoqViewSchema>;

// ---------------------------------------------------------------------------
// PATCH /v1/projects/:pid/boq/lines/:lineId
// ---------------------------------------------------------------------------

/**
 * - `status` (reviewer+): must follow BOQ_LINE_TRANSITIONS; stamps reviewedBy/At (→reviewed from draft),
 *   approvedBy/At (→approved), clears them when moving back.
 * - `qtyOverride` (editor+): number ≥ 0 sets the override and REQUIRES `reason`; null clears it.
 * - `note` (reviewer+): string ≤ 2000 or null.
 * An approved line only accepts `status: 'reviewed'` (un-approve) — anything else → 409.
 */
export const PatchBoqLineRequestSchema = z
  .object({
    status: BoqLineStatusSchema.optional(),
    qtyOverride: z.number().finite().min(0).max(1_000_000).nullable().optional(),
    reason: z.string().trim().min(1).max(500).optional(),
    note: z.string().max(2000).nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.status === undefined && v.qtyOverride === undefined && v.note === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: 'one of status, qtyOverride, note is required' });
    }
    if (typeof v.qtyOverride === 'number' && !v.reason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'a reason is required to override a quantity' });
    }
    if (v.reason !== undefined && v.qtyOverride === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'reason is only allowed with qtyOverride' });
    }
  });
export type PatchBoqLineRequest = z.infer<typeof PatchBoqLineRequestSchema>;

export const PatchBoqLineResponseSchema = z.object({ line: BoqLineSchema });
export type PatchBoqLineResponse = z.infer<typeof PatchBoqLineResponseSchema>;

// ---------------------------------------------------------------------------
// Sprint 6: POST /v1/projects/:pid/boq/lines/batch-status (bulk review / approve)
// ---------------------------------------------------------------------------

export const BOQ_BATCH_STATUS_MAX = 500;
export const BATCH_STATUS_TARGETS = ['reviewed', 'approved'] as const;
/** Why a line was not moved: at / past the target, role not allowed, red without `includeRed`, unknown id. */
export const BATCH_STATUS_SKIP_REASONS = ['already', 'forbidden', 'red', 'not_found'] as const;
/** History / audit label suffix of a bulk change ("אושר (פעולה קבוצתית)"). */
export const BATCH_ACTION_HE = 'פעולה קבוצתית';

/**
 * Reviewer+ (same role as a single status PATCH). Each line moves forward with the single-PATCH state machine:
 * draft → reviewed; reviewed → approved; `to: 'approved'` on a draft line chains draft → reviewed → approved (both
 * stamps, ONE audit event). An `approved` line whose qty changed since approval (`needsReapproval`, Stage 10) is
 * re-approved by `to: 'approved'` (new `approvedQty`, chip dropped). Never moves a line backwards. Applied in chunked
 * transactions (each line re-read inside its transaction); one audit event `boqLines/update` per moved line, all with
 * the same `batchId`.
 */
export const BatchLineStatusRequestSchema = z
  .object({
    lineIds: z
      .array(DocIdSchema)
      .min(1)
      .max(BOQ_BATCH_STATUS_MAX)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'duplicate line ids' }),
    to: z.enum(BATCH_STATUS_TARGETS),
    /** Red lines are skipped (`red`) unless true. */
    includeRed: z.boolean().default(false),
  })
  .strict();
export type BatchLineStatusRequest = z.infer<typeof BatchLineStatusRequestSchema>;
export type BatchLineStatusInput = z.input<typeof BatchLineStatusRequestSchema>;

export const BatchLineStatusResponseSchema = z.object({
  /** Shared by the audit events of this call. */
  batchId: DocIdSchema,
  updated: z.array(z.object({ lineId: DocIdSchema, from: BoqLineStatusSchema, to: BoqLineStatusSchema })),
  skipped: z.array(z.object({ lineId: z.string().max(128), reason: z.enum(BATCH_STATUS_SKIP_REASONS) })),
});
export type BatchLineStatusResponse = z.infer<typeof BatchLineStatusResponseSchema>;

// ---------------------------------------------------------------------------
// Evidence (kamutan.boq-evidence/1) and links (kamutan.links/1) artifacts
// ---------------------------------------------------------------------------

export const BOQ_EVIDENCE_SCHEMA = 'kamutan.boq-evidence/1' as const;
export const LINKS_SCHEMA = 'kamutan.links/1' as const;

const idWith = (prefix: string) =>
  z
    .string()
    .max(128)
    .regex(new RegExp(`^${prefix}[A-Za-z0-9_-]+$`), `id must look like "${prefix}…"`);
/** Link-group id `lk_…`. */
export const LinkGroupIdSchema = idWith('lk_');

/** Sprint 6: evidence item kinds (additive: `geometry`, `stair`, `manual`; `text` / `sheet` / `room` existed as targets). */
export const EVIDENCE_KINDS = ['detection', 'text', 'geometry', 'stair', 'sheet', 'room', 'manual'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
/** API-derived `target.kind` (Stage 10) + Sprint 6 geometry / stair. */
export const EVIDENCE_TARGET_KINDS = ['detection', 'sheet', 'text', 'room', 'geometry', 'stair'] as const;
const EvidenceBBoxSchema = z.object({ x: z.number().finite(), y: z.number().finite(), w: z.number().finite().nonnegative(), h: z.number().finite().nonnegative() }).strict();
const EvidencePointSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
export const EvidenceGeometrySchema = z
  .object({ type: z.enum(['polygon', 'polyline']), mm: z.array(EvidencePointSchema).min(2).max(2000) })
  .strict()
  .refine((g) => g.type !== 'polygon' || g.mm.length >= 3, { message: 'a polygon needs at least 3 points', path: ['mm'] });
export type EvidenceGeometry = z.infer<typeof EvidenceGeometrySchema>;

export const BoqEvidenceItemSchema = z
  .object({
    sheetId: DocIdSchema,
    versionId: DocIdSchema,
    /** Detection id (`d_…`) in that version's detections.json.gz. */
    detectionId: z.string().min(1).max(128),
    linkGroupId: LinkGroupIdSchema.nullable(),
    floor: FloorSchema.nullable(),
    // --- Sprint 4 (optional) ---
    /** `auto` = automatic detection (default when absent); `manual` = created by a correction (add / count / measure). */
    source: z.enum(['auto', 'manual']).optional(),
    /** The correction that created (manual) or changed (reclassify / move / accept) this item. */
    correctionId: DocIdSchema.nullable().optional(),
    /** Quantity this item contributes when it is not 1 (m² / m' of a room or a measure). */
    quantity: z.number().finite().nonnegative().nullable().optional(),
    /** Room behind a tiling / waterproofing / per-room plumbing item. */
    roomId: z.string().max(128).nullable().optional(),
    /** Human-verified (accept correction) → the line's level is not lowered by this item. */
    verified: z.boolean().optional(),
    /**
     * Stage 10 (API-derived, never stored): what `detectionId` points at — a detection (`d_…`, `m_…`), the whole sheet
     * (`sheet`), a text line (`text_{n}`, with its `bboxMm` from text.json.gz when readable) or a room id. The web opens
     * the sheet and centres on `bboxMm` when present.
     */
    target: z
      .object({ kind: z.enum(EVIDENCE_TARGET_KINDS), bboxMm: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable().optional() })
      .optional(),
    // --- Sprint 6 (worker-written, optional) ---
    /**
     * What the item is (absent = derived from `detectionId` as in Stage 10): `detection` (`d_…` / `m_…`), `text`
     * (`ti_…` of text_items.json.gz or `text_{n}`), `geometry` (`g_…` of geometry.json.gz: hatch / wall run / polyline),
     * `stair` (`g_…` of kind stair; `quantity` = treads), `sheet` (whole sheet), `room` (`r_…`), `manual` (a correction).
     */
    kind: z.enum(EVIDENCE_KINDS).optional(),
    /** Text box (paper mm) of a `text` item — the web centres on it; the text itself is never in the evidence. */
    bboxMm: EvidenceBBoxSchema.nullable().optional(),
    /** Shape (paper mm) of a `geometry` / `stair` item, simplified to ≤ 2000 points, for the drawing highlight. */
    geometryMm: EvidenceGeometrySchema.nullable().optional(),
    /** Stair facts of a `stair` item. */
    stair: z.object({ treads: z.number().int().min(0).max(200), risers: z.number().int().min(0).max(200).nullable().optional() }).strict().nullable().optional(),
  })
  .strict();
export type BoqEvidenceItem = z.infer<typeof BoqEvidenceItemSchema>;

/** Sprint 4: a correction the build could not apply to the sheet's current version (queue: "תיקון לא הותאם"). */
export const UnmatchedCorrectionSchema = z
  .object({
    correctionId: DocIdSchema,
    sheetId: DocIdSchema,
    /** Version the build tried to apply it to. */
    versionId: DocIdSchema,
    reason: z.string().min(1).max(200),
  })
  .strict();
export type UnmatchedCorrection = z.infer<typeof UnmatchedCorrectionSchema>;

export const MAX_EVIDENCE_PER_LINE = 5000;

/** Storage orgs/{o}/projects/{p}/boq/{buildId}/evidence.json.gz (gzip JSON). */
export const BoqEvidenceArtifactSchema = z
  .object({
    schema: z.literal(BOQ_EVIDENCE_SCHEMA),
    buildId: DocIdSchema.optional(),
    lines: z.record(DocIdSchema, z.array(BoqEvidenceItemSchema).max(MAX_EVIDENCE_PER_LINE)),
    /** Sprint 4: which corrections the build applied / could not re-match. */
    corrections: z
      .object({
        applied: z.array(DocIdSchema).max(20_000),
        unmatched: z.array(UnmatchedCorrectionSchema).max(20_000),
      })
      .strict()
      .optional(),
  })
  .strict();
export type BoqEvidenceArtifact = z.infer<typeof BoqEvidenceArtifactSchema>;

export const LINK_GROUP_KINDS = ['single', 'two_way', 'shared', 'sensor', 'add_to_existing'] as const;
export const LinkGroupKindSchema = z.enum(LINK_GROUP_KINDS);
export type LinkGroupKind = z.infer<typeof LinkGroupKindSchema>;

/**
 * One switch group: the switches that control the same set of luminaire points. A point = one or more luminaires
 * wired together (same arc endpoint cluster); `pointIds` are point ids (`pt_…`, or the luminaire detection id when the
 * point is a single luminaire), `luminaireIds` all luminaire detection ids of those points.
 */
export const LinkGroupSchema = z
  .object({
    id: LinkGroupIdSchema,
    /** Optional (Worker-A): floor of the group, fan switch, number of switches inferred from arc ends, arcs used. */
    floor: FloorSchema.nullable().optional(),
    fan: z.boolean().optional(),
    inferredSwitches: z.number().int().min(0).optional(),
    arcIds: z.array(z.string().max(128)).max(256).optional(),
    switchIds: z.array(z.string().min(1).max(128)).max(16),
    pointIds: z.array(z.string().min(1).max(128)).max(64),
    luminaireIds: z.array(z.string().min(1).max(128)).max(256),
    kind: LinkGroupKindSchema,
    confidence: z.number().min(0).max(1),
    /** Raw (pre-calibration) confidence; since Sprint 5 only `level` is capped by the calibration table. */
    level: ConfidenceLevelSchema,
    reasons: ReasonsSchema,
  })
  .strict();
export type LinkGroup = z.infer<typeof LinkGroupSchema>;

const PointMm = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const pair = <T extends z.ZodTypeAny>(t: T) => z.tuple([t, t]);

/** A luminaire point: luminaires wired together (`pt_…`). */
export const LinkPointSchema = z
  .object({
    id: z.string().max(128).regex(/^pt_[A-Za-z0-9_-]+$/),
    luminaireIds: z.array(z.string().max(128)).max(256),
    centerMm: PointMm,
    lifecycle: z.enum(['existing', 'new']),
  })
  .strict();

/** A dashed switch↔luminaire arc (`a_…`); `ends` = attached item ids (null = loose end). */
export const LinkArcSchema = z
  .object({
    id: z.string().max(128).regex(/^a_[A-Za-z0-9_-]+$/),
    polylineMm: z.array(PointMm).max(2000),
    ends: pair(z.string().max(128).nullable()),
    ambiguous: pair(z.boolean()),
    inferredSwitch: pair(z.boolean()),
  })
  .strict();

/** Storage orgs/{o}/projects/{p}/sheets/{s}/versions/{v}/links.json.gz (gzip JSON), one per lighting sheet version. */
export const LinksArtifactSchema = z
  .object({
    schema: z.literal(LINKS_SCHEMA),
    groups: z.array(LinkGroupSchema).max(5000),
    points: z.array(LinkPointSchema).max(5000).optional(),
    arcs: z.array(LinkArcSchema).max(5000).optional(),
    unlinkedLuminaireIds: z.array(z.string().max(128)).max(5000).optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    const seen = new Set<string>();
    a.groups.forEach((g, i) => {
      if (seen.has(g.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['groups', i, 'id'], message: 'duplicate id' });
      seen.add(g.id);
      if (g.level !== 'green' && g.reasons.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['groups', i, 'reasons'], message: 'a non-green group needs at least one reason' });
      }
    });
  });
export type LinksArtifact = z.infer<typeof LinksArtifactSchema>;

/** GET /v1/projects/:pid/boq/lines/:lineId/evidence */
export const BoqLineEvidenceResponseSchema = z.object({
  lineId: DocIdSchema,
  buildId: DocIdSchema.nullable(),
  items: z.array(BoqEvidenceItemSchema),
  /** Per (sheet, floor) counts of the items (the export's "ראיות" sheet uses the same grouping). */
  /**
   * Per (sheet, floor) counts. Composite (lighting) evidence counts one unit per distinct (sheet, version, linkGroupId);
   * items without a linkGroupId count one each — so the counts sum to the line quantity.
   */
  /** Sprint 4: not an integer for measured lines (m², m') — items with a `quantity` contribute it. */
  bySheet: z.array(z.object({ sheetId: DocIdSchema, versionId: DocIdSchema, floor: z.string().nullable(), count: z.number().nonnegative() })),
  /** Switch groups behind a composite line, with ids from the version's links.json.gz (empty ids when unavailable). */
  linkGroups: z
    .array(
      z.object({
        sheetId: DocIdSchema,
        versionId: DocIdSchema,
        linkGroupId: z.string().max(128),
        floor: z.string().nullable(),
        kind: z.string().max(32).nullable(),
        switchIds: z.array(z.string().max(128)),
        pointIds: z.array(z.string().max(128)),
        luminaireIds: z.array(z.string().max(128)),
      }),
    )
    .optional(),
  truncated: z.boolean(),
});
export type BoqLineEvidenceResponse = z.infer<typeof BoqLineEvidenceResponseSchema>;

/** GET /v1/projects/:pid/boq/evidence?sheetId=&versionId= — marker → line lookup for one sheet version. */
export const BoqSheetEvidenceQuerySchema = z.object({ sheetId: DocIdSchema, versionId: DocIdSchema });
export type BoqSheetEvidenceQuery = z.infer<typeof BoqSheetEvidenceQuerySchema>;
export const BoqSheetEvidenceResponseSchema = z.object({
  sheetId: DocIdSchema,
  versionId: DocIdSchema,
  buildId: DocIdSchema.nullable(),
  /** detectionId → ids of the lines it counts toward (usually one). */
  detections: z.record(z.string().max(128), z.array(DocIdSchema)),
  /** linkGroupId → line ids (lighting composites). */
  linkGroups: z.record(z.string().max(128), z.array(DocIdSchema)),
});
export type BoqSheetEvidenceResponse = z.infer<typeof BoqSheetEvidenceResponseSchema>;

/** Reason chip added to a line whose quantity was overridden by a user. */
export const OVERRIDE_REASON = 'כמות שונתה ידנית';

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const EXPORT_SPLITS = ['summed', 'byFloor'] as const;
export const ExportSplitSchema = z.enum(EXPORT_SPLITS);

export const ExportBoqRequestSchema = z
  .object({
    /** boqTemplates/{id}; default = the org's default template (seeded from the sample). */
    templateId: DocIdSchema.optional(),
    /** `summed`: one row per line; `byFloor`: one row per (line, floor) in the main sheet. */
    split: ExportSplitSchema.default('summed'),
    /** UX checkbox: add "טיוטה – כולל פריטים שלא אומתו" to the title rows. */
    markDraft: z.boolean().default(false),
  })
  .strict();
export type ExportBoqRequest = z.infer<typeof ExportBoqRequestSchema>;

/** Signed download URL lifetime for exports (SEC-20: 2 minutes). */
export const EXPORT_URL_TTL_SECONDS = 120;

export const ExportBoqResponseSchema = z.object({
  exportId: DocIdSchema,
  url: z.string().url(),
  expiresAt: TimestampSchema,
  /** Suggested download name (sanitised project name). */
  fileName: z.string(),
  counts: BoqCountsSchema,
  /** True when non-green lines exist (the file carries the warning row). */
  hasWarnings: z.boolean(),
});
export type ExportBoqResponse = z.infer<typeof ExportBoqResponseSchema>;

/** orgs/{o}/projects/{p}/exports/{exportId} — API-written record of an export (members read). */
export const BoqExportSchema = z.object({
  id: DocIdSchema,
  /** Sprint 5 (optional; absent on Sprint-3 docs): always `xlsx` here — marked PDFs use exports.ts `ExportRecord`. */
  kind: z.literal('xlsx').optional(),
  /** Sprint 5 (optional): xlsx exports are written synchronously → `ready`. */
  status: z.literal('ready').optional(),
  templateId: DocIdSchema.nullable(),
  split: ExportSplitSchema,
  markDraft: z.boolean(),
  storagePath: z.string(),
  buildId: DocIdSchema.nullable(),
  counts: BoqCountsSchema,
  sha256: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  createdBy: UidSchema,
  createdAt: TimestampSchema,
});
export type BoqExport = z.infer<typeof BoqExportSchema>;

export const BoqLinePageSchema = pageOf(BoqLineSchema);
