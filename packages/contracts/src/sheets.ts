import { z } from 'zod';
import { Sha256HexSchema, TimestampSchema } from './common.js';
import { DocIdSchema, UidSchema } from './org.js';

/** Accepted source file kinds (SEC-14), as detected by magic bytes. */
export const FILE_KINDS = ['pdf', 'dwg', 'dxf', 'png'] as const;
export const FileKindSchema = z.enum(FILE_KINDS);
export type FileKind = z.infer<typeof FileKindSchema>;

export const SHEET_SET_STATUSES = ['uploaded', 'splitting', 'ready', 'failed'] as const;
export const SheetSetStatusSchema = z.enum(SHEET_SET_STATUSES);
export type SheetSetStatus = z.infer<typeof SheetSetStatusSchema>;

export const SHEET_VERSION_STATUSES = ['uploaded', 'queued', 'processing', 'ready', 'failed'] as const;
export const SheetVersionStatusSchema = z.enum(SHEET_VERSION_STATUSES);
export type SheetVersionStatus = z.infer<typeof SheetVersionStatusSchema>;

/** orgs/{orgId}/projects/{projectId}/sheetSets/{setId}. storagePath = verified source object. */
export const SheetSetSchema = z.object({
  id: DocIdSchema,
  orgId: DocIdSchema,
  projectId: DocIdSchema,
  fileKind: FileKindSchema,
  sha256: Sha256HexSchema,
  storagePath: z.string().min(1).max(1024),
  status: SheetSetStatusSchema,
  name: z.string().max(255).optional(),
  uploadedBy: UidSchema,
  createdAt: TimestampSchema,
});
export type SheetSet = z.infer<typeof SheetSetSchema>;

const Point = z.tuple([z.number(), z.number()]);

/** A floor/scale region of a sheet (decision #10). Polygon in paper mm, y down. */
export const FloorRegionSchema = z.object({
  floor: z.string().min(1).max(16),
  scale: z.number().positive(),
  polygon: z.array(Point),
  source: z.enum(['auto', 'manual']),
});
export type FloorRegion = z.infer<typeof FloorRegionSchema>;

/** orgs/{orgId}/projects/{projectId}/sheets/{sheetId}. Title block never contains PII. */
export const SheetSchema = z.object({
  id: DocIdSchema,
  logicalKey: z.string().min(1).max(200),
  discipline: z.array(z.string().max(50)),
  floorRegions: z.array(FloorRegionSchema),
  scale: z.number().positive().nullable(),
  titleBlock: z
    .object({
      sheetTitle: z.string().optional(),
      sheetNumber: z.string().optional(),
      discipline: z.string().optional(),
      scaleText: z.string().optional(),
    })
    .optional(),
  currentVersionId: DocIdSchema.nullable(),
  sheetSetId: DocIdSchema,
});
export type Sheet = z.infer<typeof SheetSchema>;

/** .../sheets/{sheetId}/versions/{versionId}. Artifacts are Storage paths under orgs/{orgId}/derived/. */
export const SheetVersionSchema = z.object({
  id: DocIdSchema,
  sheetId: DocIdSchema,
  versionNo: z.number().int().positive(),
  status: SheetVersionStatusSchema,
  sha256: Sha256HexSchema,
  pageIndex: z.number().int().nonnegative(),
  widthMm: z.number().positive().optional(),
  heightMm: z.number().positive().optional(),
  artifacts: z.object({
    primitives: z.string().optional(),
    tiles: z.string().optional(),
    detections: z.string().optional(),
    rooms: z.string().optional(),
  }),
  stats: z
    .object({
      detections: z.number().int(),
      green: z.number().int(),
      yellow: z.number().int(),
      red: z.number().int(),
      rooms: z.number().int(),
    })
    .optional(),
  createdAt: TimestampSchema,
});
export type SheetVersion = z.infer<typeof SheetVersionSchema>;
