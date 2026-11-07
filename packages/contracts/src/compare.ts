/**
 * Sprint 8 — version comparison ("מה השתנה", docs/agents/SPRINT8_BRIEF.md §2).
 *
 * Worker-BOQ writes, for every SUCCEEDED build, a compact snapshot of the lines it produced:
 *   orgs/{o}/projects/{p}/boq/{buildId}/lines.json.gz  (`kamutan.boq-lines/1`, gzip JSON; `BoqBuild.linesRef` = its path)
 * The API compares two snapshots (`GET /v1/projects/:pid/boq/compare`, viewer+) and exports the comparison to Excel
 * ("תוספות ושינויים", `POST …/boq/compare/export`, editor+). Snapshots are never served raw or signed.
 */
import { z } from 'zod';
import { TimestampSchema } from './common.js';
import { BoqLineStatusSchema, SourceVersionRefSchema } from './boq.js';
import { DocIdSchema } from './org.js';
import { LinePriceSourceSchema } from './prices.js';
import { ConfidenceLevelSchema } from './review.js';

export const BOQ_LINES_SNAPSHOT_SCHEMA = 'kamutan.boq-lines/1' as const;
/** ≤ 5000 lines per snapshot (= MAX_BOQ_LINES of the API). */
export const BOQ_LINES_SNAPSHOT_MAX = 5000;

/**
 * One line of a build snapshot. `qty` is the EFFECTIVE quantity at build time (`qtyOverride ?? qty`; a needsInput line
 * without override → 0, `needsInput: true`), `price` the effective unit price (`priceOverride ?? library price`, null =
 * "ללא מחיר"); `description` = `displayDescription(line)`. `sourceVersions` = the sheet versions the line's evidence
 * came from (cause attribution).
 */
export const BoqLinesSnapshotLineSchema = z
  .object({
    lineId: DocIdSchema,
    chapter: z.string().max(32),
    code: z.string().min(1).max(32),
    description: z.string().max(2000),
    unit: z.string().max(32),
    qty: z.number().finite(),
    /** Computed (worker) quantity; equals `qty` unless overridden. */
    computedQty: z.number().finite().optional(),
    qtyOverride: z.number().finite().nullable().optional(),
    price: z.number().finite().nullable(),
    priceSource: LinePriceSourceSchema.nullable().optional(),
    /** The override value itself (to tell an override change from a library price change). */
    priceOverride: z.number().finite().nullable().optional(),
    byFloor: z.record(z.string().max(32), z.number().finite()).optional(),
    level: ConfidenceLevelSchema.optional(),
    status: BoqLineStatusSchema.optional(),
    needsInput: z.boolean().optional(),
    sourceVersions: z.array(SourceVersionRefSchema).max(500).optional(),
  })
  .passthrough();
export type BoqLinesSnapshotLine = z.infer<typeof BoqLinesSnapshotLineSchema>;

export const BoqLinesSnapshotSchema = z
  .object({
    schema: z.literal(BOQ_LINES_SNAPSHOT_SCHEMA),
    projectId: DocIdSchema,
    buildId: DocIdSchema,
    createdAt: TimestampSchema,
    /** sheetId → the version the build read for that sheet (every current sheet of the build, ≤ 500). */
    sheetVersions: z.record(DocIdSchema, DocIdSchema).optional(),
    /** sheetId → display title (optional; the API falls back to the sheet docs). */
    sheetTitles: z.record(DocIdSchema, z.string().max(300)).optional(),
    lines: z.array(BoqLinesSnapshotLineSchema).max(BOQ_LINES_SNAPSHOT_MAX),
  })
  .passthrough();
export type BoqLinesSnapshot = z.infer<typeof BoqLinesSnapshotSchema>;

// ---------------------------------------------------------------------------
// GET /v1/projects/:pid/boq/compare?from=&to=&base=
// ---------------------------------------------------------------------------

/**
 * `to` (default: the project's CURRENT lines, "live" — see `BoqComparison.to.live`; else that build's snapshot) vs `from`:
 *  - explicit `from` (any succeeded build of the project with a snapshot) → base `explicit`;
 *  - else `base=previous` (default): the newest succeeded build with a snapshot created before `to`;
 *  - `base=export` ("מאז הייצוא האחרון"): the build of the latest BOQ Excel export (`exports`, purpose `boq`).
 * 404 unknown build id; 409 `not_ready` (Hebrew message) when there is no build to compare with or a snapshot is
 * missing (builds before Sprint 8).
 */
export const BOQ_COMPARE_BASES = ['previous', 'export'] as const;
export const BoqCompareQuerySchema = z
  .object({
    from: DocIdSchema.optional(),
    to: DocIdSchema.optional(),
    base: z.enum(BOQ_COMPARE_BASES).default('previous'),
  })
  .strict();
export type BoqCompareQuery = z.infer<typeof BoqCompareQuerySchema>;
export type BoqCompareQueryInput = z.input<typeof BoqCompareQuerySchema>;

export const BOQ_COMPARE_SCHEMA = 'kamutan.boq-compare/1' as const;
export const BOQ_COMPARE_KINDS = ['added', 'removed', 'changed'] as const;
export const BoqCompareKindSchema = z.enum(BOQ_COMPARE_KINDS);
export const BOQ_COMPARE_KIND_HE: Readonly<Record<z.infer<typeof BoqCompareKindSchema>, string>> = Object.freeze({ added: 'נוסף', removed: 'הוסר', changed: 'שונה' });
export const BOQ_COMPARE_FIELDS = ['qty', 'price', 'description', 'unit'] as const;

/**
 * Why a line changed: `sheet` = a sheet version the line's evidence came from differs between the builds (a new
 * revision / re-process / added or removed sheet); `qty_override` / `price_override` = the project's manual value
 * changed; `library_price` = the org price list changed; `other` = none of these (rules, corrections, legend …).
 */
export const BoqCompareCauseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sheet'), sheetId: DocIdSchema, title: z.string().max(300).nullable(), fromVersionId: DocIdSchema.nullable(), toVersionId: DocIdSchema.nullable() }),
  z.object({ kind: z.literal('qty_override') }),
  z.object({ kind: z.literal('price_override') }),
  z.object({ kind: z.literal('library_price') }),
  z.object({ kind: z.literal('other') }),
]);
export type BoqCompareCause = z.infer<typeof BoqCompareCauseSchema>;

export const BoqCompareItemSchema = z.object({
  kind: BoqCompareKindSchema,
  lineId: DocIdSchema,
  chapter: z.string(),
  code: z.string(),
  /** Display description of `to` (removed lines: of `from`). */
  description: z.string(),
  unit: z.string(),
  fromQty: z.number().nullable(),
  toQty: z.number().nullable(),
  /** toQty − fromQty (null side = 0). */
  deltaQty: z.number(),
  fromPrice: z.number().nullable(),
  toPrice: z.number().nullable(),
  fromTotal: z.number().nullable(),
  toTotal: z.number().nullable(),
  /** toTotal − fromTotal (null side = 0); null when neither side has a price. */
  deltaTotal: z.number().nullable(),
  /** What differs (changed lines): qty / price / description / unit. */
  changes: z.array(z.enum(BOQ_COMPARE_FIELDS)),
  /** Floors whose quantity differs (from byFloor), when both snapshots carry it. */
  byFloor: z.array(z.object({ floor: z.string(), fromQty: z.number(), toQty: z.number(), deltaQty: z.number() })).optional(),
  causes: z.array(BoqCompareCauseSchema),
});
export type BoqCompareItem = z.infer<typeof BoqCompareItemSchema>;

const BuildRef = z.object({
  buildId: DocIdSchema,
  /** finishedAt ?? createdAt of the build. */
  at: TimestampSchema.nullable(),
});

export const BoqComparisonSchema = z.object({
  schema: z.literal(BOQ_COMPARE_SCHEMA),
  projectId: DocIdSchema,
  base: z.enum(['previous', 'export', 'explicit']),
  from: BuildRef.extend({ exportId: DocIdSchema.nullable().optional(), exportedAt: TimestampSchema.nullable().optional() }),
  /**
   * Integration: without an explicit `to` the "to" side is LIVE — the project's current lines priced now (overrides,
   * library prices, renames of today); `buildId` = the latest build they come from, `live: true`. An explicit `to` =
   * that build's stored snapshot (`live` absent / false).
   */
  to: BuildRef.extend({ live: z.boolean().optional() }),
  summary: z.object({
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    /** Σ line totals of each snapshot (null when it has no priced line). */
    fromTotal: z.number().nullable(),
    toTotal: z.number().nullable(),
    deltaTotal: z.number().nullable(),
  }),
  /** Sheets whose version differs between the two builds (added: only in `to`, removed: only in `from`). */
  sheetChanges: z.array(
    z.object({ sheetId: DocIdSchema, title: z.string().max(300).nullable(), kind: z.enum(['added', 'removed', 'revised']), fromVersionId: DocIdSchema.nullable(), toVersionId: DocIdSchema.nullable() }),
  ),
  /** Added / removed / changed lines in (chapter, natural code) order. */
  items: z.array(BoqCompareItemSchema),
  generatedAt: TimestampSchema,
});
export type BoqComparison = z.infer<typeof BoqComparisonSchema>;

/** POST /v1/projects/:pid/boq/compare/export (editor+): same selection as the GET → Excel "תוספות ושינויים". */
export const BoqCompareExportRequestSchema = z
  .object({ from: DocIdSchema.optional(), to: DocIdSchema.optional(), base: z.enum(BOQ_COMPARE_BASES).default('previous') })
  .strict();
export type BoqCompareExportRequest = z.infer<typeof BoqCompareExportRequestSchema>;
export const BoqCompareExportResponseSchema = z.object({
  exportId: DocIdSchema,
  url: z.string().url(),
  expiresAt: TimestampSchema,
  fileName: z.string(),
  fromBuildId: DocIdSchema,
  toBuildId: DocIdSchema,
});
export type BoqCompareExportResponse = z.infer<typeof BoqCompareExportResponseSchema>;

export const COMPARE_SHEET_NAME = 'תוספות ושינויים';

// ---------------------------------------------------------------------------
// Integration: GET /v1/projects/:pid/boq/builds (compare picker)
// ---------------------------------------------------------------------------

export const BoqBuildListQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).strict();
export type BoqBuildListQuery = z.infer<typeof BoqBuildListQuerySchema>;
export const BoqBuildSummarySchema = z.object({
  buildId: DocIdSchema,
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  trigger: z.enum(['manual', 'auto']).nullable(),
  createdAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
  /** `stats.lines` of the build (null when the worker did not report it). */
  lineCount: z.number().int().nonnegative().nullable(),
  /** The build has a lines snapshot (`linesRef`) → it can be compared. */
  hasSnapshot: z.boolean(),
  /** The latest BOQ Excel export made from this build (null = never exported). */
  exportedAt: TimestampSchema.nullable(),
  exportId: DocIdSchema.nullable(),
  /** This build is `project.boq.latestBuildId` (its lines are the live BOQ). */
  latest: z.boolean(),
});
export type BoqBuildSummary = z.infer<typeof BoqBuildSummarySchema>;
export const BoqBuildListSchema = z.object({ items: z.array(BoqBuildSummarySchema) });
export type BoqBuildList = z.infer<typeof BoqBuildListSchema>;
/** 409 messages of the comparison (Hebrew, shown as is). */
export const COMPARE_NO_PREVIOUS_HE = 'אין עדיין גרסה קודמת של כתב הכמויות להשוואה.';
export const COMPARE_NO_SNAPSHOT_HE = 'לחישוב זה אין תמונת מצב של השורות (חושב לפני העדכון). חשבו מחדש את כתב הכמויות כדי להשוות.';
export const COMPARE_NO_EXPORT_HE = 'עדיין לא בוצע ייצוא של כתב הכמויות בפרויקט.';
