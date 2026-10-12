import { z } from 'zod';
import { Sha256HexSchema, TimestampSchema } from './common.js';
import { DocIdSchema } from './org.js';
import { FileKindSchema, SheetSchema, SheetSetSchema, SheetVersionSchema } from './sheets.js';

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
  fileId: DocIdSchema,
  /** orgs/{orgId}/uploads/{uid}/{fileId} */
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
  })
  .strict();
export type FinalizeUploadRequest = z.infer<typeof FinalizeUploadRequestSchema>;

export const FinalizeUploadResponseSchema = z.object({
  sheetSet: SheetSetSchema,
  sheet: SheetSchema,
  sheetVersion: SheetVersionSchema,
  /** True when identical bytes (same sha256) already existed in this project. */
  deduplicated: z.boolean(),
  /** jobs/{jobId} of the ingest job (the existing one when deduplicated). */
  jobId: DocIdSchema,
});
export type FinalizeUploadResponse = z.infer<typeof FinalizeUploadResponseSchema>;
