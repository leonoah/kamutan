import { z } from 'zod';
import { pageOf, Sha256HexSchema, TimestampSchema } from './common.js';
import { DocIdSchema, UidSchema } from './org.js';
import { ConfidenceLevelSchema } from './review.js';

/** Accepted source file kinds (SEC-14), as detected by magic bytes. */
export const FILE_KINDS = ['pdf', 'dwg', 'dxf', 'png'] as const;
export const FileKindSchema = z.enum(FILE_KINDS);
export type FileKind = z.infer<typeof FileKindSchema>;

/** `queued` = ingest published; `splitting` = worker running; `ready`/`failed` set by the worker. */
export const SHEET_SET_STATUSES = ['uploaded', 'queued', 'splitting', 'ready', 'failed'] as const;
export const SheetSetStatusSchema = z.enum(SHEET_SET_STATUSES);
export type SheetSetStatus = z.infer<typeof SheetSetStatusSchema>;

/** orgs/{orgId}/projects/{projectId}/sheetSets/{setId} (setId = sha256 → per-project dedupe). One uploaded file. */
export const SheetSetSchema = z.object({
  id: DocIdSchema,
  orgId: DocIdSchema,
  projectId: DocIdSchema,
  fileKind: FileKindSchema,
  sha256: Sha256HexSchema,
  /** Verified upload: orgs/{orgId}/projects/{projectId}/uploads/{sheetSetId}/source.{ext} */
  storagePath: z.string().min(1).max(1024),
  status: SheetSetStatusSchema,
  name: z.string().max(255).optional(),
  uploadedBy: UidSchema,
  sizeBytes: z.number().int().nonnegative().optional(),
  /** jobs/{jobId} of the initial ingest. */
  ingestJobId: DocIdSchema.optional(),
  /** Version id the worker uses for every page sheet of the initial ingest. */
  versionId: DocIdSchema.optional(),
  /** Number of pages (sheets), set by the worker after splitting. */
  pageCount: z.number().int().nonnegative().nullable().optional(),
  createdAt: TimestampSchema,
});
export type SheetSet = z.infer<typeof SheetSetSchema>;

// ---------------------------------------------------------------------------
// Classification / confirmation
// ---------------------------------------------------------------------------

/** Discipline codes produced by the worker classifier (workers/drawing titleblock/classify.py). Open set. */
export const DISCIPLINE_CODES = [
  'electrical',
  'lighting',
  'plumbing',
  'demolition',
  'construction',
  'architecture_master',
  'architecture',
  'furniture',
  'hvac',
  'flooring',
  'ceiling',
  'other',
] as const;
/** Lower-case code; not an enum so the classifier can add codes without a contract bump. */
export const DisciplineSchema = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'invalid discipline code');
export type Discipline = z.infer<typeof DisciplineSchema>;

/** Floor code ("ground", "first", "roof", "-1", ...) or a short label. No control characters. */
export const FloorSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'invalid floor');
export type Floor = z.infer<typeof FloorSchema>;

/** Drawing scale 1:N → N. */
export const ScaleDenominatorSchema = z.number().int().min(1).max(10_000);

/** Automatic classification of a sheet (worker). Never contains title-block PII (project name/address). */
export const SheetClassificationSchema = z.object({
  discipline: DisciplineSchema.nullable(),
  floors: z.array(FloorSchema).max(16),
  sheetTitle: z.string().max(300).nullable(),
  scaleText: z.string().max(100).nullable(),
  /** 0..1 */
  confidence: z.number().min(0).max(1),
  level: ConfidenceLevelSchema,
  reasons: z.array(z.string().max(200)).max(32),
});
export type SheetClassification = z.infer<typeof SheetClassificationSchema>;

/**
 * orgs/{orgId}/projects/{projectId}/sheets/{sheetId}, sheetId = `${sheetSetId}-p${pageIndex}`.
 * Created by the worker when splitting; `discipline/floors/scaleDenominator` start as the classifier's
 * guess and become authoritative once `confirmed` (API only; the worker never overwrites confirmed fields).
 */
export const SheetSchema = z.object({
  id: DocIdSchema,
  sheetSetId: DocIdSchema,
  pageIndex: z.number().int().nonnegative(),
  title: z.string().max(300).nullable(),
  discipline: DisciplineSchema.nullable(),
  floors: z.array(FloorSchema).max(16),
  scaleDenominator: ScaleDenominatorSchema.nullable(),
  classification: SheetClassificationSchema.nullable(),
  confirmed: z.boolean(),
  confirmedBy: UidSchema.nullable().optional(),
  confirmedAt: TimestampSchema.nullable().optional(),
  currentVersionId: DocIdSchema.nullable(),
  updatedAt: TimestampSchema.nullable(),
});
export type Sheet = z.infer<typeof SheetSchema>;

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export const SHEET_VERSION_STATUSES = ['queued', 'processing', 'ready', 'failed'] as const;
export const SheetVersionStatusSchema = z.enum(SHEET_VERSION_STATUSES);
export type SheetVersionStatus = z.infer<typeof SheetVersionStatusSchema>;

/** Processing stages in order (Sprint 2 added legend, detect, rooms before done). */
export const VERSION_STAGES = ['ingest', 'render', 'ocr', 'classify', 'scale', 'legend', 'detect', 'rooms', 'done'] as const;
export const VersionStageSchema = z.enum(VERSION_STAGES);
export type VersionStage = z.infer<typeof VersionStageSchema>;

export const VersionProgressSchema = z.object({
  stage: VersionStageSchema,
  pct: z.number().min(0).max(100),
});
export type VersionProgress = z.infer<typeof VersionProgressSchema>;

export const ProcessingErrorSchema = z.object({ code: z.string().min(1).max(64), message: z.string().max(2000) });
export type ProcessingError = z.infer<typeof ProcessingErrorSchema>;

export const PageRotationSchema = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);

/** Page geometry in paper millimetres (origin top-left, y down). */
export const PageGeometrySchema = z.object({
  widthMm: z.number().positive().max(10_000),
  heightMm: z.number().positive().max(10_000),
  rotation: PageRotationSchema,
});
export type PageGeometry = z.infer<typeof PageGeometrySchema>;

export const TILE_SIZE = 256;
export const DEFAULT_TILE_DPI = 300;

/** Tile pyramid meta (geometry: see `tileLevels()` in geometry.ts). */
export const TilesArtifactSchema = z.object({
  /** orgs/{o}/projects/{p}/sheets/{s}/versions/{v}/tiles/ — files `{z}/{x}_{y}.webp`. */
  prefix: z.string().min(1).max(1024),
  format: z.literal('webp'),
  tileSize: z.literal(TILE_SIZE),
  dpi: z.number().int().min(10).max(1200),
  /** Level 0 fits one tile; level `levels-1` is full resolution at `dpi`. */
  levels: z.number().int().min(1).max(20),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
});
export type TilesArtifact = z.infer<typeof TilesArtifactSchema>;

/** Storage paths under orgs/{o}/projects/{p}/sheets/{s}/versions/{v}/ (empty until produced). */
export const VersionArtifactsSchema = z.object({
  tiles: TilesArtifactSchema.optional(),
  /** primitives.msgpack.gz */
  primitives: z.string().max(1024).optional(),
  /** text.json.gz — OCR lines {text, bboxMm, angle, confidence} */
  text: z.string().max(1024).optional(),
  /** thumbnail.webp (max 512px) */
  thumbnail: z.string().max(1024).optional(),
  /** Sprint 2 — full object paths (never relative to the version prefix): legend.json.gz (kamutan.legend/1) */
  legend: z.string().max(1024).optional(),
  /** detections.json.gz (kamutan.detections/1) */
  detections: z.string().max(1024).optional(),
  /** rooms.json.gz (kamutan.rooms/1) */
  rooms: z.string().max(1024).optional(),
  /** Sprint 3: links.json.gz (kamutan.links/1), lighting sheets only */
  links: z.string().max(1024).optional(),
  /** Sprint 4: fixtures.json.gz (kamutan.fixtures/1, plumbing fixtures / faucets / AC with extended fields) */
  fixtures: z.string().max(1024).optional(),
  /** Sprint 4: walls.json.gz (kamutan.walls/1, reference wall polygons of construction / architecture sheets) */
  walls: z.string().max(1024).optional(),
});
export type VersionArtifacts = z.infer<typeof VersionArtifactsSchema>;

/**
 * Point in paper mm. `{x, y}` rather than `[x, y]`: Firestore cannot store nested arrays, and the same
 * shape is used in Firestore docs, API DTOs and the web.
 */
export const PointMmSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();

export const MAX_REGIONS = 8;
export const MAX_REGION_POINTS = 256;

/** A floor/scale region of a sheet version (decision #10). Polygon `[{x,y},...]` in paper mm, y down, implicitly closed. */
export const RegionSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'invalid region id'),
  floor: FloorSchema,
  polygonMm: z.array(PointMmSchema).min(3).max(MAX_REGION_POINTS),
  scaleDenominator: ScaleDenominatorSchema,
});
export type Region = z.infer<typeof RegionSchema>;

/** Structural checks only; bounds + simplicity are checked by the API against the page geometry. */
export const RegionListSchema = z
  .array(RegionSchema)
  .max(MAX_REGIONS)
  .superRefine((regions, ctx) => {
    const seen = new Set<string>();
    regions.forEach((r, i) => {
      if (seen.has(r.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'id'], message: 'duplicate region id' });
      seen.add(r.id);
    });
  });

const count = z.number().int().nonnegative();

/** stats.detections of a version (Sprint 2): counts by confidence level, unknown symbols and class. */
export const DetectionStatsSchema = z.object({
  total: count,
  green: count,
  yellow: count,
  red: count,
  /** Detections with class "unknown" (they are also counted in their level). */
  unknown: count,
  byClass: z.record(z.string().max(64), count),
});
export type DetectionStats = z.infer<typeof DetectionStatsSchema>;

/** Sprint 3: switch↔luminaire link stats of a lighting sheet version (Worker-A). Kinds mirror boq.ts LINK_GROUP_KINDS. */
export const LinkStatsSchema = z
  .object({
    groups: count,
    green: count.optional(),
    yellow: count.optional(),
    red: count.optional(),
    arcs: count.optional(),
    danglingEnds: count.optional(),
    inferredSwitches: count.optional(),
    unlinkedSwitches: count.optional(),
    unlinkedLuminaires: count.optional(),
    byKind: z
      .object({ single: count.optional(), two_way: count.optional(), shared: count.optional(), sensor: count.optional(), add_to_existing: count.optional() })
      .strict()
      .optional(),
  })
  .strict();
export type LinkStats = z.infer<typeof LinkStatsSchema>;

export const VersionStatsSchema = z.object({
  paths: count,
  segments: count,
  textLines: count,
  glyphs: count,
  /** Sprint 2 (absent on Sprint-1 versions). */
  detections: DetectionStatsSchema.optional(),
  rooms: count.optional(),
  legendEntries: count.optional(),
  /** Sprint 3 (lighting sheets with links.json.gz). */
  links: LinkStatsSchema.optional(),
});
export type VersionStats = z.infer<typeof VersionStatsSchema>;

/** orgs/{orgId}/projects/{projectId}/sheets/{sheetId}/versions/{versionId}. Worker-written except `regions` (API). */
export const SheetVersionSchema = z.object({
  id: DocIdSchema,
  sheetId: DocIdSchema,
  versionNo: z.number().int().positive().optional(),
  status: SheetVersionStatusSchema,
  progress: VersionProgressSchema,
  error: ProcessingErrorSchema.nullable().optional(),
  /** null until the worker has read the page. */
  page: PageGeometrySchema.nullable(),
  artifacts: VersionArtifactsSchema,
  regions: z.array(RegionSchema).max(MAX_REGIONS),
  stats: VersionStatsSchema.nullable(),
  workerVersion: z.string().max(64).nullable(),
  /** jobs/{jobId} that produces this version. */
  jobId: DocIdSchema.nullable().optional(),
  createdAt: TimestampSchema.nullable().optional(),
  updatedAt: TimestampSchema.nullable(),
});
export type SheetVersion = z.infer<typeof SheetVersionSchema>;

// ---------------------------------------------------------------------------
// API DTOs
// ---------------------------------------------------------------------------

/** Item of GET /v1/projects/:pid/sheets: sheet + status/progress of its current version. */
export const SheetSummarySchema = SheetSchema.extend({
  currentVersion: z
    .object({
      id: DocIdSchema,
      status: SheetVersionStatusSchema,
      progress: VersionProgressSchema,
      error: ProcessingErrorSchema.nullable().optional(),
    })
    .nullable(),
});
export type SheetSummary = z.infer<typeof SheetSummarySchema>;

export const ListSheetsQuerySchema = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    sheetSetId: DocIdSchema.optional(),
  })
  .strict();
export type ListSheetsQuery = z.infer<typeof ListSheetsQuerySchema>;

export const SheetPageSchema = pageOf(SheetSummarySchema);
export type SheetPage = z.infer<typeof SheetPageSchema>;

/** POST /v1/projects/:pid/sheets/:sid/confirm (editor+). */
export const ConfirmSheetRequestSchema = z
  .object({
    discipline: DisciplineSchema,
    floors: z.array(FloorSchema).max(16),
    /** null for sheets without a scale (legends, schedules). */
    scaleDenominator: ScaleDenominatorSchema.nullable(),
    /** Replaces the current version's regions when present. */
    regions: RegionListSchema.optional(),
  })
  .strict();
export type ConfirmSheetRequest = z.infer<typeof ConfirmSheetRequestSchema>;

/** PUT /v1/projects/:pid/sheets/:sid/regions (editor+) — replaces the current version's regions. */
export const PutRegionsRequestSchema = z.object({ regions: RegionListSchema }).strict();
export type PutRegionsRequest = z.infer<typeof PutRegionsRequestSchema>;

export const PutRegionsResponseSchema = z.object({
  sheetId: DocIdSchema,
  versionId: DocIdSchema,
  regions: z.array(RegionSchema),
});
export type PutRegionsResponse = z.infer<typeof PutRegionsResponseSchema>;

/** POST /v1/projects/:pid/sheets/:sid/reprocess (editor+). */
export const ReprocessSheetResponseSchema = z.object({
  sheet: SheetSchema,
  sheetVersion: SheetVersionSchema,
  jobId: DocIdSchema,
});
export type ReprocessSheetResponse = z.infer<typeof ReprocessSheetResponseSchema>;

// ---------------------------------------------------------------------------
// Legacy (Sprint 0) shapes — kept exported for backward compatibility.
// ---------------------------------------------------------------------------

const Point = z.tuple([z.number(), z.number()]);

/** @deprecated Sprint 0 floor region; use `RegionSchema` (on the version doc). */
export const FloorRegionSchema = z.object({
  floor: z.string().min(1).max(16),
  scale: z.number().positive(),
  polygon: z.array(Point),
  source: z.enum(['auto', 'manual']),
});
export type FloorRegion = z.infer<typeof FloorRegionSchema>;
