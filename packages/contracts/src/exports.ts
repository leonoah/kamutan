import { z } from 'zod';
import { TimestampSchema } from './common.js';
import { DocIdSchema, UidSchema } from './org.js';
import { ProcessingErrorSchema } from './sheets.js';

/**
 * Sprint 5 exports (FR-29). orgs/{o}/projects/{p}/exports/{exportId} now holds two kinds:
 *  - `xlsx` (Sprint 3, API-generated synchronously; old docs have no `kind`/`status` → xlsx / ready),
 *  - `marked_pdf` (API creates `queued` + job `export.marked_pdf`; the worker writes status/pageCount/error and the file
 *    orgs/{o}/projects/{p}/exports/{exportId}/marked.pdf).
 */
export const EXPORT_KINDS = ['xlsx', 'marked_pdf'] as const;
export const ExportKindSchema = z.enum(EXPORT_KINDS);
export type ExportKind = z.infer<typeof ExportKindSchema>;

/** Worker may write `succeeded` (job vocabulary); readers treat it as `ready`. */
export const EXPORT_STATUSES = ['queued', 'running', 'ready', 'failed'] as const;
export const ExportStatusSchema = z.enum(EXPORT_STATUSES);
export type ExportStatus = z.infer<typeof ExportStatusSchema>;

export const MarkedPdfOptionsSchema = z
  .object({
    /** Legend page/box "קוד · תיאור · כמות · צבע" (always on). */
    legend: z.literal(true).default(true),
    /** One page group per floor. */
    floorSplit: z.boolean().default(false),
    /** Diagonal text on every page (share links: the link's watermark). */
    watermark: z.string().trim().min(1).max(200).nullable().default(null),
    hideTitleBlock: z.boolean().default(false),
  })
  .strict();
export type MarkedPdfOptions = z.infer<typeof MarkedPdfOptionsSchema>;

/** POST /v1/projects/:pid/boq/export/marked-pdf (editor+). `sheetIds` null = every current ready sheet with evidence. */
export const CreateMarkedPdfRequestSchema = z
  .object({
    sheetIds: z.array(DocIdSchema).min(1).max(200).nullable().default(null),
    options: MarkedPdfOptionsSchema.omit({ legend: true }).partial().strict().default({}),
  })
  .strict();
export type CreateMarkedPdfRequest = z.infer<typeof CreateMarkedPdfRequestSchema>;

export const CreateMarkedPdfResponseSchema = z.object({ exportId: DocIdSchema, jobId: DocIdSchema });
export type CreateMarkedPdfResponse = z.infer<typeof CreateMarkedPdfResponseSchema>;

/** Marked PDF download URL lifetime (15 minutes, brief §3). */
export const MARKED_PDF_URL_TTL_SECONDS = 15 * 60;

/** The `exports/{id}` doc as returned by `GET /v1/projects/:pid/exports/:id` (both kinds). */
export const ExportRecordSchema = z.object({
  id: DocIdSchema,
  kind: ExportKindSchema,
  status: ExportStatusSchema,
  storagePath: z.string().max(1024),
  pageCount: z.number().int().nonnegative().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  createdBy: UidSchema,
  createdAt: TimestampSchema,
  /** Worker bookkeeping (marked_pdf): when rendering started. */
  startedAt: TimestampSchema.nullable().optional(),
  finishedAt: TimestampSchema.nullable(),
  error: ProcessingErrorSchema.nullable(),
  /** marked_pdf only. */
  sheetIds: z.array(DocIdSchema).nullable().optional(),
  options: MarkedPdfOptionsSchema.optional(),
  jobId: DocIdSchema.nullable().optional(),
  /** Set when the export was produced for a share link (per-link watermark). */
  shareLinkId: DocIdSchema.nullable().optional(),
  /** sheetId → versionId rendered (share links: the locked versions). */
  versionIds: z.record(DocIdSchema, DocIdSchema).nullable().optional(),
  /** Security gate F-3 (worker): every exported sheet had its title block masked (null when hideTitleBlock is off). */
  titleBlockMasked: z.boolean().nullable().optional(),
  /** Security gate F-3 (worker): sheetId → masked; sheets with `false` were left out of the PDF. */
  titleBlockBySheet: z.record(DocIdSchema, z.boolean()).nullable().optional(),
});
export type ExportRecord = z.infer<typeof ExportRecordSchema>;

export const ExportStatusResponseSchema = z.object({
  export: ExportRecordSchema,
  /** Hebrew message for `export.error.code` / omitted sheets (F-3), null when nothing to say. */
  message: z.string().nullable().optional(),
  /** V4 signed download URL (attachment) when `status = ready`; marked PDF 15 min, xlsx 2 min. */
  url: z.string().url().nullable(),
  expiresAt: TimestampSchema.nullable(),
  fileName: z.string().nullable(),
});
export type ExportStatusResponse = z.infer<typeof ExportStatusResponseSchema>;

/**
 * Non-retryable worker error codes of `export.marked_pdf` (export doc `error.code`). `title_block_not_found`:
 * hideTitleBlock was requested and NO sheet's title block could be located → nothing was written (fail closed).
 */
export const EXPORT_ERROR_CODES = Object.freeze({ titleBlockNotFound: 'title_block_not_found' } as const);
/** Hebrew UI text per export error code (web dialog / share viewer). */
export const EXPORT_ERROR_MESSAGES_HE: Readonly<Record<string, string>> = Object.freeze({
  title_block_not_found: 'לא נמצאה טבלת כותרת להסתרה באף גיליון, ולכן ה-PDF לא נוצר. בטלו את הסתרת טבלת הכותרת או בחרו גיליונות אחרים.',
});
/** Hebrew warning when some sheets were omitted from a hideTitleBlock export. */
export const EXPORT_SHEETS_OMITTED_HE = 'חלק מהגיליונות הושמטו: לא נמצאה בהם טבלת כותרת להסתרה.';
