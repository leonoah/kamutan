import { z } from 'zod';
import { Sha256HexSchema, TimestampSchema, UuidSchema } from './common.js';
import { FileKindSchema, SheetSetSchema, SheetVersionSchema } from './sheets.js';

/** Upload object path: `{orgId}/upload/{uploadId}` (no user-controlled segments, SEC-13). */
export const StoragePathSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/upload\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'invalid storage path',
  );

/** Per-file size limit (SEC-14). */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** Signed upload URL / upload token lifetime (SEC-13). */
export const UPLOAD_TTL_SECONDS = 10 * 60;
/** Allowed extensions → file kind. Extension is a hint only; magic bytes are authoritative. */
export const EXTENSION_TO_KIND = Object.freeze({
  pdf: 'pdf',
  dwg: 'dwg',
  dxf: 'dxf',
  png: 'png',
} as const);

/**
 * Original filename as supplied by the client. It is stored only as sanitized
 * metadata and never used in a storage path (SEC-13).
 */
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
    /** Optional client-computed sha256; verified server-side on finalize. */
    sha256: Sha256HexSchema.optional(),
  })
  .strict();
export type CreateUploadRequest = z.infer<typeof CreateUploadRequestSchema>;

export const CreateUploadResponseSchema = z.object({
  uploadId: UuidSchema,
  /** Opaque signed token; pass it back to finalize. */
  uploadToken: z.string().min(16),
  /** Where the client uploads the raw bytes. */
  uploadUrl: z.string().url(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  storagePath: z.string(),
  fileKind: FileKindSchema,
  maxBytes: z.number().int().positive(),
  expiresAt: TimestampSchema,
});
export type CreateUploadResponse = z.infer<typeof CreateUploadResponseSchema>;

/** POST /v1/projects/:projectId/sheet-sets — finalize an upload and start ingest. */
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
  sheetVersion: SheetVersionSchema,
  /** True when an identical file (same sha256) already existed in this project. */
  deduplicated: z.boolean(),
  /** Ingest job id (`jobs.id`, also the BullMQ job id); on dedupe, the existing job. */
  jobId: z.string().nullable(),
});
export type FinalizeUploadResponse = z.infer<typeof FinalizeUploadResponseSchema>;
