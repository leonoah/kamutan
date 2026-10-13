import { z } from 'zod';
import { TimestampSchema } from './common.js';
import { DocIdSchema } from './org.js';
import { PageGeometrySchema, TILE_SIZE } from './sheets.js';

/** Max signed tile URLs per tiles-manifest call (signing is expensive). */
export const TILES_MAX_BATCH = 256;
/** Signed read URL lifetime (Storage v4 signing). */
export const SIGNED_URL_TTL_SECONDS = 15 * 60;

const int = z.coerce.number().int().min(0);

/**
 * GET /v1/projects/:pid/sheets/:sid/versions/:vid/tiles-manifest query.
 * No params → meta + thumbnail only. `z` alone → the whole level (≤ TILES_MAX_BATCH tiles).
 * `z` + `x0,x1,y0,y1` (inclusive, clamped to the level grid) → that window (≤ TILES_MAX_BATCH tiles).
 */
export const TilesManifestQuerySchema = z
  .object({
    z: int.max(19).optional(),
    x0: int.max(99_999).optional(),
    x1: int.max(99_999).optional(),
    y0: int.max(99_999).optional(),
    y1: int.max(99_999).optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    const range = [q.x0, q.x1, q.y0, q.y1];
    const given = range.filter((v) => v !== undefined).length;
    if (given !== 0 && given !== 4) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['x0'], message: 'x0, x1, y0, y1 must be given together' });
    }
    if (given > 0 && q.z === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['z'], message: 'z is required with a tile range' });
    }
    if (given === 4 && ((q.x0 as number) > (q.x1 as number) || (q.y0 as number) > (q.y1 as number))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['x1'], message: 'range must satisfy x0 <= x1 and y0 <= y1' });
    }
  });
export type TilesManifestQuery = z.infer<typeof TilesManifestQuerySchema>;

export const TileLevelSchema = z.object({
  z: z.number().int().nonnegative(),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  mmPerPx: z.number().positive(),
});
export type TileLevelDto = z.infer<typeof TileLevelSchema>;

export const TilesManifestSchema = z.object({
  sheetId: DocIdSchema,
  versionId: DocIdSchema,
  page: PageGeometrySchema.nullable(),
  tiles: z.object({
    format: z.literal('webp'),
    tileSize: z.literal(TILE_SIZE),
    dpi: z.number().int().positive(),
    levels: z.number().int().positive(),
    widthPx: z.number().int().positive(),
    heightPx: z.number().int().positive(),
  }),
  /** Geometry per level (see `tileLevels()`). */
  levelGrid: z.array(TileLevelSchema),
  thumbnailUrl: z.string().url().nullable(),
  /** Signed URLs keyed `"{z}/{x}_{y}"` for the requested window (empty without `z`). */
  urls: z.record(z.string().regex(/^\d+\/\d+_\d+$/), z.string().url()),
  /** Earliest expiry among the returned URLs; re-request before then. */
  expiresAt: TimestampSchema,
  maxBatch: z.number().int().positive(),
});
export type TilesManifest = z.infer<typeof TilesManifestSchema>;

export const tileKey = (level: number, x: number, y: number) => `${level}/${x}_${y}`;
