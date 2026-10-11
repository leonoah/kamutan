import { z } from 'zod';
import { Sha256HexSchema, TimestampSchema, UuidSchema } from './common.js';

/**
 * Accepted source file kinds (SEC-14), as detected by magic bytes.
 * NOTE: the DB column `sheet_sets.file_kind` stores `png` as `image`
 * (see DB_FILE_KIND / fileKindFromDb).
 */
export const FILE_KINDS = ['pdf', 'dwg', 'dxf', 'png'] as const;
export const FileKindSchema = z.enum(FILE_KINDS);
export type FileKind = z.infer<typeof FileKindSchema>;

/** DB representation of a file kind (`sheet_sets.file_kind`). */
export const DB_FILE_KIND: Readonly<Record<FileKind, 'pdf' | 'dwg' | 'dxf' | 'image'>> = Object.freeze({
  pdf: 'pdf',
  dwg: 'dwg',
  dxf: 'dxf',
  png: 'image',
});
export function fileKindFromDb(v: string): FileKind {
  if (v === 'image') return 'png';
  return FileKindSchema.parse(v);
}

export const SHEET_VERSION_STATUSES = ['uploaded', 'queued', 'processing', 'ready', 'failed'] as const;
export const SheetVersionStatusSchema = z.enum(SHEET_VERSION_STATUSES);
export type SheetVersionStatus = z.infer<typeof SheetVersionStatusSchema>;

export const SheetSetSchema = z.object({
  id: UuidSchema,
  orgId: UuidSchema,
  projectId: UuidSchema,
  name: z.string().min(1).max(255),
  uploadedBy: UuidSchema.nullable(),
  sourceFilePath: z.string().min(1).max(1024).nullable(),
  sourceSha256: Sha256HexSchema.nullable(),
  fileKind: FileKindSchema,
  createdAt: TimestampSchema,
});
export type SheetSet = z.infer<typeof SheetSetSchema>;

export const PIPELINE_STAGE_STATUSES = ['pending', 'queued', 'running', 'done', 'failed', 'skipped'] as const;
export const PipelineStageStatusSchema = z.enum(PIPELINE_STAGE_STATUSES);

export const PipelineStateSchema = z.record(
  z.string(),
  z.object({
    status: PipelineStageStatusSchema,
    stageVersion: z.string().optional(),
    updatedAt: TimestampSchema.optional(),
    error: z.string().max(2000).optional(),
  }),
);
export type PipelineState = z.infer<typeof PipelineStateSchema>;

export const SheetVersionSchema = z.object({
  id: UuidSchema,
  orgId: UuidSchema,
  sheetId: UuidSchema,
  versionNo: z.number().int().positive(),
  sourceSha256: Sha256HexSchema,
  /** Object path inside the private `drawings` bucket; always starts with `{orgId}/`. */
  storagePath: z.string().min(1).max(1024),
  pageIndex: z.number().int().nonnegative(),
  status: SheetVersionStatusSchema,
  widthMm: z.number().positive().nullable(),
  heightMm: z.number().positive().nullable(),
  scale: z.number().positive().nullable(),
  isRaster: z.boolean(),
  pipelineState: PipelineStateSchema,
  createdAt: TimestampSchema,
});
export type SheetVersion = z.infer<typeof SheetVersionSchema>;
