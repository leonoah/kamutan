/**
 * Sprint 7 — BOQ preview ("תצוגה מקדימה של כתב הכמויות"), owner request 1.
 *
 * `BoqDocumentModel` is THE layout of the main Excel sheet "כמויות": the API builds it once and BOTH the xlsx writer
 * (apps/api/src/boq/excel.ts) and `GET /v1/projects/:pid/boq/document` consume it — fidelity by construction, no second
 * layout logic in the browser. Text in the model is what the user / template wrote (NOT formula-escaped); the xlsx
 * writer passes every text cell through `sanitizeCell` (leading `= + - @ TAB CR` → `'`), the web renders it as text.
 *
 * Row order of the xlsx main sheet = `titleRows` (one merged row each) → header (`columns`) → per chapter: one row
 * with `chapter.title`, then `chapter.rows` in order (kind `note` = "הערות:" + one row per numbered note, `line` = one
 * row per line or per (line, floor) when split by floor, `subtotal` = "סה"כ" with the chapter SUM), then one blank
 * row → the grand-total rows (before VAT, after VAT).
 */
import { z } from 'zod';
import { BoqCountsSchema, BoqLineStatusSchema, ChapterCodeSchema, ExportSplitSchema } from './boq.js';
import { TimestampSchema } from './common.js';
import { DocIdSchema } from './org.js';
import { ConfidenceLevelSchema } from './review.js';

export const BOQ_DOCUMENT_SCHEMA = 'kamutan.boq-document/1' as const;

/** Column keys of the main sheet: the template's columns + the optional confidence / status columns. */
export const BOQ_DOCUMENT_COLUMN_KEYS = ['code', 'description', 'unit', 'qty', 'unitPrice', 'total', 'confidence', 'status'] as const;
export const BoqDocumentColumnKeySchema = z.enum(BOQ_DOCUMENT_COLUMN_KEYS);
export type BoqDocumentColumnKey = z.infer<typeof BoqDocumentColumnKeySchema>;

const qbool = (dflt: boolean) =>
  z
    .enum(['1', '0', 'true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? dflt : v === '1' || v === 'true'));

/**
 * GET /v1/projects/:pid/boq/document query = the export dialog's options.
 *  - `split`: `none` | `summed` (one row per line, default) or `floor` | `byFloor` (one row per (line, floor)).
 *  - `confidence`: `1` (default) / `0` — the "רמת ביטחון" + "סטטוס" columns.
 *  - `chapters`: comma-separated chapter codes ("04,05"; `chapterKey` match, ≤ 64); absent = every chapter with lines.
 *  - `templateId`: default = the org's default template. `markDraft`: `1` adds the draft title row.
 */
export const BoqDocumentQuerySchema = z
  .object({
    split: z
      .enum(['none', 'summed', 'floor', 'byFloor'])
      .optional()
      .transform((v): z.infer<typeof ExportSplitSchema> => (v === 'floor' || v === 'byFloor' ? 'byFloor' : 'summed')),
    confidence: qbool(true),
    chapters: z
      .string()
      .max(2000)
      .optional()
      .transform((v, ctx) => {
        if (v === undefined || v.trim() === '') return undefined;
        const codes = [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))];
        if (codes.length > 64 || codes.some((c) => !ChapterCodeSchema.safeParse(c).success)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'chapters: up to 64 comma-separated chapter codes' });
          return z.NEVER;
        }
        return codes;
      }),
    templateId: DocIdSchema.optional(),
    markDraft: qbool(false),
  })
  .strict();
export type BoqDocumentQuery = z.infer<typeof BoqDocumentQuerySchema>;
export type BoqDocumentQueryInput = z.input<typeof BoqDocumentQuerySchema>;

/** Options the model was built with (same for the preview and POST …/boq/export). */
export const BoqDocumentOptionsSchema = z.object({
  split: ExportSplitSchema,
  includeConfidence: z.boolean(),
  /** Requested chapter codes; null = all. */
  chapters: z.array(ChapterCodeSchema).nullable(),
  markDraft: z.boolean(),
});
export type BoqDocumentOptions = z.infer<typeof BoqDocumentOptionsSchema>;

/** `warning` = the non-green warning row (first), `title` = a template title row (variables filled), `draft` = "טיוטה…". */
export const BOQ_DOCUMENT_TITLE_KINDS = ['warning', 'title', 'draft'] as const;
export const BoqDocumentTitleRowSchema = z.object({ kind: z.enum(BOQ_DOCUMENT_TITLE_KINDS), text: z.string().max(2000) });
export type BoqDocumentTitleRow = z.infer<typeof BoqDocumentTitleRowSchema>;

export const BoqDocumentColumnSchema = z.object({ key: BoqDocumentColumnKeySchema, title: z.string().max(200), width: z.number().positive() });
export type BoqDocumentColumn = z.infer<typeof BoqDocumentColumnSchema>;

/** Number format of the quantity cell: `decimal2` for area / length units (m², m'), else `general`. */
export const QTY_FORMATS = ['general', 'decimal2'] as const;

export const BOQ_DOCUMENT_ROW_KINDS = ['line', 'subtotal', 'note'] as const;
export const BoqDocumentRowSchema = z.object({
  kind: z.enum(BOQ_DOCUMENT_ROW_KINDS),
  /** The BOQ line (kind `line`) — the preview opens it in the review workspace; null for note / subtotal rows. */
  lineId: DocIdSchema.nullable(),
  /** Item code as TEXT ("4.10"); null for note / subtotal rows. */
  code: z.string().max(32).nullable(),
  /**
   * Line: `displayDescription(line)` (+ " – {floor name}" for a by-floor row); note: "הערות:" or the note text;
   * subtotal: "סה"כ".
   */
  description: z.string().max(4000),
  unit: z.string().max(32).nullable(),
  /** Effective quantity of the row; null = empty cell ("להשלמה ידנית" line without an override). */
  qty: z.number().finite().nullable(),
  qtyFormat: z.enum(QTY_FORMATS).optional(),
  /** Unit price — empty in every export today (the client prices the BOQ); null = empty cell. */
  price: z.number().finite().nullable(),
  /** Row total = qty × price (the xlsx cell is that formula; 0 while the price is empty); subtotal row = chapter SUM. */
  total: z.number().finite().nullable(),
  /** Only with `options.includeConfidence`. */
  level: ConfidenceLevelSchema.optional(),
  /** Effective status (`effectiveStatus`: approved lines needing re-approval show "נבדק"); only with includeConfidence. */
  status: BoqLineStatusSchema.optional(),
  // --- markers (line rows) ---
  /** Floor code of a by-floor split row (display name is already in `description`). */
  floor: z.string().max(32).nullable().optional(),
  needsInput: z.boolean().optional(),
  qtyOverridden: z.boolean().optional(),
  /** "✎ ידני" — the description is the project's rename. */
  descriptionOverridden: z.boolean().optional(),
  /** Comment of the quantity cell in the xlsx ("להשלמה ידנית", "כמות שונתה ידנית (מחושב: …)…"). */
  cellNote: z.string().max(1000).nullable().optional(),
});
export type BoqDocumentRow = z.infer<typeof BoqDocumentRowSchema>;

export const BoqDocumentChapterSchema = z.object({
  /** Template chapter code ("04"), or the line chapter / code major of a chapter missing from the template. */
  code: z.string().max(32),
  /** Header text (template title verbatim; "פרק X" for chapters missing from the template). */
  title: z.string().max(500),
  /** The template's numbered notes (also present as `note` rows, after the "הערות:" row). */
  notes: z.array(z.string().max(2000)),
  rows: z.array(BoqDocumentRowSchema),
  /** SUM of the chapter's row totals. */
  subtotal: z.number().finite(),
});
export type BoqDocumentChapter = z.infer<typeof BoqDocumentChapterSchema>;

/**
 * Banner of the preview = the export gate (`exportBlockingLines`, org `blockExportOnRed`), over ALL project lines:
 * `red` = red lines not approved, `reapproval` = approved lines whose qty changed since approval, `unapproved` = lines
 * not (effectively) approved, `needsInput` = lines still "להשלמה ידנית" (no override). Only kinds with count > 0.
 */
export const BOQ_DOCUMENT_WARNING_KINDS = ['red', 'reapproval', 'unapproved', 'needsInput'] as const;
export const BoqDocumentWarningSchema = z.object({ kind: z.enum(BOQ_DOCUMENT_WARNING_KINDS), count: z.number().int().positive() });
export type BoqDocumentWarning = z.infer<typeof BoqDocumentWarningSchema>;

export const BoqDocumentModelSchema = z.object({
  schema: z.literal(BOQ_DOCUMENT_SCHEMA),
  projectId: DocIdSchema,
  templateId: DocIdSchema.nullable(),
  /** Build the lines come from (project `boq.latestBuildId`). */
  buildId: DocIdSchema.nullable(),
  options: BoqDocumentOptionsSchema,
  titleRows: z.array(BoqDocumentTitleRowSchema),
  columns: z.array(BoqDocumentColumnSchema),
  /** Chapters in template order; empty chapters omitted (as in the xlsx). */
  chapters: z.array(BoqDocumentChapterSchema),
  totals: z.object({ beforeVat: z.number().finite(), vat: z.number().finite(), afterVat: z.number().finite(), vatRate: z.number().min(0).max(1) }),
  warnings: z.array(BoqDocumentWarningSchema),
  /** True when POST …/boq/export would answer 409 `export_blocked` right now. */
  exportBlocked: z.boolean(),
  /** Counts over the lines IN the document (chapter filter applied). */
  counts: BoqCountsSchema,
  /** ISO time the model was built (the xlsx "{date}" title variable uses the same instant). */
  generatedAt: TimestampSchema,
});
export type BoqDocumentModel = z.infer<typeof BoqDocumentModelSchema>;

/** Hebrew banner text per warning kind (preview; the export dialog uses the same wording). */
export const BOQ_DOCUMENT_WARNING_HE: Readonly<Record<z.infer<typeof BoqDocumentWarningSchema>['kind'], (n: number) => string>> = Object.freeze({
  red: (n: number) => `${n} שורות "לבדיקה" שלא אושרו`,
  reapproval: (n: number) => `${n} שורות שהכמות שלהן השתנתה מאז האישור`,
  unapproved: (n: number) => `${n} שורות שעדיין לא אושרו`,
  needsInput: (n: number) => `${n} שורות להשלמה ידנית`,
});
