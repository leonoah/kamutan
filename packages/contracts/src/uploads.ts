import { z } from 'zod';
import { Sha256HexSchema, TimestampSchema } from './common.js';
import { DocIdSchema } from './org.js';
import { JobProgressSchema, JobStatusSchema } from './jobs.js';
import { FileKindSchema, SheetSetSchema } from './sheets.js';

/** Per-file size limit (SEC-14). */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** Upload token lifetime (SEC-13). */
export const UPLOAD_TTL_SECONDS = 10 * 60;
/** Allowed extensions → file kind. Extension is a hint only; magic bytes are authoritative. */
export const EXTENSION_TO_KIND = Object.freeze({ pdf: 'pdf', dwg: 'dwg', dxf: 'dxf', png: 'png' } as const);
/** Content-Type the client should set on the Storage upload (must satisfy storage.rules). */
export const KIND_TO_CONTENT_TYPE = Object.freeze({
  pdf: 'application/pdf',
  png: 'image/png',
  dxf: 'application/dxf',
  dwg: 'application/acad',
} as const);

/** Original filename: sanitized metadata only, never part of a storage path (SEC-13). */
export const UploadFilenameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((s) => /\.(pdf|dwg|dxf|png)$/i.test(s.trim()), {
    message: 'unsupported file extension (allowed: pdf, dwg, dxf, png)',
  });

export const CreateUploadRequestSchema = z
  .object({
    filename: UploadFilenameSchema,
    sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
    /** Optional client-computed sha256; the server always recomputes it. */
    sha256: Sha256HexSchema.optional(),
  })
  .strict();
export type CreateUploadRequest = z.infer<typeof CreateUploadRequestSchema>;

/**
 * POST /api/v1/projects/:projectId/uploads. The client then uploads the bytes
 * directly to Cloud Storage (resumable, Firebase JS SDK) at `storagePath`.
 */
export const CreateUploadResponseSchema = z.object({
  /** UUID of the pending upload. */
  fileId: DocIdSchema,
  /** orgs/{orgId}/quarantine/{fileId} (SEC-13; create-only for editors, see storage.rules). */
  storagePath: z.string(),
  /** Opaque HMAC token (10 min); pass it to finalize. */
  uploadToken: z.string().min(16),
  contentType: z.string(),
  fileKind: FileKindSchema,
  maxBytes: z.number().int().positive(),
  expiresAt: TimestampSchema,
});
export type CreateUploadResponse = z.infer<typeof CreateUploadResponseSchema>;

/** POST /api/v1/projects/:projectId/sheet-sets — verify the upload and start ingest. */
export const FinalizeUploadRequestSchema = z
  .object({
    uploadToken: z.string().min(16).max(4096),
    /** Display name for the sheet set; defaults to the sanitized filename. */
    name: z.string().trim().min(1).max(255).optional(),
    /**
     * Stage 10 (A-API-05): this upload is a REVISION of an existing set of the project. The old set's sheets become
     * superseded versions of the matching new sheets (title/number + discipline/floor, else page order) once the
     * revision is processed; the BOQ build then counts only the new sheets. 409 when the set is already superseded
     * or the bytes are identical to it.
     */
    replacesSheetSetId: DocIdSchema.optional(),
  })
  .strict();
export type FinalizeUploadRequest = z.infer<typeof FinalizeUploadRequestSchema>;

/**
 * Sprint 1: finalize no longer creates sheet/version docs — the worker creates `sheets/{sheetSetId}-p{i}`
 * (+ `versions/{versionId}`) while splitting. Follow progress on jobs/{jobId}.
 */
export const FinalizeUploadResponseSchema = z.object({
  sheetSet: SheetSetSchema,
  /** True when identical bytes (same sha256) already existed in this project. */
  deduplicated: z.boolean(),
  /** jobs/{jobId} of the ingest job (the existing one when deduplicated). */
  jobId: DocIdSchema,
  /** Version id every page sheet of this set will get. */
  versionId: DocIdSchema,
});
export type FinalizeUploadResponse = z.infer<typeof FinalizeUploadResponseSchema>;

// ---------------------------------------------------------------------------
// Sprint 7: upload hardening (antivirus, per-project quota)
// ---------------------------------------------------------------------------

/** Worker error code (sheet set / version / job `error.code`) when the antivirus scan finds malware. */
export const FILE_INFECTED_ERROR = 'file_infected' as const;
/** Worker error code (job `error.code`, retryable): no antivirus verdict yet (engine unavailable) — Pub/Sub redelivers. */
export const SCAN_UNAVAILABLE_ERROR = 'scan_unavailable' as const;
/** API error code (413) when an upload would exceed the project's storage quota. */
export const QUOTA_EXCEEDED_ERROR = 'quota_exceeded' as const;

const gb = (n: number): string => {
  const v = n / 1024 ** 3;
  return v >= 10 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1);
};
/** Hebrew 413 message: "אין מספיק מקום בפרויקט: …". Used as the ApiError `message` of `quota_exceeded`. */
export const quotaExceededMessageHe = (usedBytes: number, quotaBytes: number, requestedBytes: number): string =>
  `אין מספיק מקום בפרויקט: נוצלו ${gb(usedBytes)} GB מתוך ${gb(quotaBytes)} GB, והקובץ דורש ${Math.max(1, Math.ceil(requestedBytes / 1024 ** 2))} MB נוספים. פנו למנהל הארגון כדי להגדיל את מכסת האחסון של הפרויקט.`;

/** Hebrew text per upload / processing error code (upload status, sheet-set card, toasts). */
export const UPLOAD_ERROR_MESSAGES_HE: Readonly<Record<string, string>> = Object.freeze({
  file_infected: 'נמצאה נוזקה בקובץ. הקובץ הועבר להסגר ולא עובד. בדקו את המקור והעלו קובץ נקי.',
  scan_unavailable: 'בדיקת האנטי-וירוס אינה זמינה כרגע. הקובץ ייבדק שוב אוטומטית; אין צורך להעלות אותו מחדש.',
  quota_exceeded: 'אין מספיק מקום בפרויקט. פנו למנהל הארגון כדי להגדיל את מכסת האחסון של הפרויקט.',
  payload_too_large: 'הקובץ גדול מדי (עד 100MB).',
  unsupported_file_type: 'סוג הקובץ אינו נתמך (PDF, DWG, DXF או PNG).',
  upload_expired: 'פג תוקף ההעלאה. נסו להעלות שוב.',
  upload_missing: 'הקובץ לא הגיע לשרת. נסו להעלות שוב.',
  /** Sprint 8 (SEC-14): ≤ 100 sheets per project (API 409 on upload / finalize; worker set error when a split exceeds it). */
  sheet_limit: 'בפרויקט יש יותר מדי גיליונות (עד 100 גיליונות לפרויקט). מחקו סט גיליונות שאינו בשימוש או פתחו פרויקט חדש.',
});

/**
 * Sprint 7: GET /v1/projects/:pid/sheet-sets/:setId (viewer+) — the upload's status after finalize: the set, its
 * ingest job and the effective error (set `error`, else the job's) with the Hebrew text of `UPLOAD_ERROR_MESSAGES_HE`
 * (`file_infected` → "נמצאה נוזקה בקובץ…"). `infected` is true for `file_infected`.
 */
export const SheetSetStatusResponseSchema = z.object({
  sheetSet: SheetSetSchema,
  job: z.object({ id: DocIdSchema, status: JobStatusSchema, progress: JobProgressSchema }).nullable(),
  error: z.object({ code: z.string().max(64), message: z.string().max(2000), messageHe: z.string().max(500).nullable() }).nullable(),
  infected: z.boolean(),
});
export type SheetSetStatusResponse = z.infer<typeof SheetSetStatusResponseSchema>;
