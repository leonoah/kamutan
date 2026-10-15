/**
 * Sprint 2 — "understanding" shapes (docs/agents/SPRINT2_BRIEF.md, exact):
 *  - Storage artifacts per sheet version (gzip JSON next to the tiles): legend.json.gz (`kamutan.legend/1`),
 *    detections.json.gz (`kamutan.detections/1`), rooms.json.gz (`kamutan.rooms/1`) + small webp crops
 *    `legend/{entryId}.webp`, `unknown/{clusterId}.webp`.
 *  - Firestore: project-level `legendEntries/{entryId}` and org-level `symbolMappings/{signature}`.
 *  - API DTOs: overlay, legend-entries list/patch, unknown-cluster resolve.
 *
 * Coordinates are paper millimetres, origin top-left, y down; points are `{x, y}` objects (Firestore cannot store
 * nested arrays). Item codes are TEXT. Python workers mirror these via json-schema/*.json; `.superRefine` checks
 * (level ⇔ reasons, unknown ⇔ clusterId, unique ids, cross references) are NOT in the JSON Schema — the worker
 * re-checks them (see the superRefine blocks below for the exact rules).
 */
import { z } from 'zod';
import { pageOf, TimestampSchema } from './common.js';
import { ItemCodeSchema, LIFECYCLES, SUPPLY_KINDS } from './boq.js';
import { DocIdSchema, UidSchema } from './org.js';
import { ConfidenceLevelSchema, type ConfidenceLevel } from './review.js';
import { FloorSchema, PointMmSchema, VersionStatsSchema } from './sheets.js';
import { DetectionClassSchema, SymbolClassSchema } from './taxonomy.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const LEGEND_SCHEMA = 'kamutan.legend/1' as const;
export const DETECTIONS_SCHEMA = 'kamutan.detections/1' as const;
export const ROOMS_SCHEMA = 'kamutan.rooms/1' as const;
export const FIXTURES_SCHEMA = 'kamutan.fixtures/1' as const;
export const WALLS_SCHEMA = 'kamutan.walls/1' as const;

/** Axis-aligned box in paper mm (x, y = top-left corner). */
export const BBoxMmSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    w: z.number().finite().nonnegative(),
    h: z.number().finite().nonnegative(),
  })
  .strict();
export type BBoxMm = z.infer<typeof BBoxMmSchema>;

const conf01 = z.number().min(0).max(1);
/** Hebrew reason chips (UX §confidence language). */
const ReasonsSchema = z.array(z.string().min(1).max(200)).max(16);

/**
 * Stable hash of the normalised symbol strokes. Used as the Firestore doc id of `symbolMappings/{signature}`,
 * so it must be a valid doc id (hex / base64url).
 */
export const SymbolSignatureSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, 'invalid symbol signature');

const idWith = (prefix: string) =>
  z
    .string()
    .max(128)
    .regex(new RegExp(`^${prefix}[A-Za-z0-9_-]+$`), `id must look like "${prefix}…"`);

/** `le_<sheetId>_<n>` (worker) or `le_<sheetId>_u_<n>` (API, from a resolved unknown cluster). */
export const LegendEntryIdSchema = idWith('le_');
export const LegendIdSchema = idWith('lg');
export const DetectionIdSchema = idWith('d_');
export const RoomIdSchema = idWith('r_');
export const ClusterIdSchema = idWith('u_');

/** Relative crop paths inside the artifact JSON (the API never signs these strings; it re-derives paths from ids). */
const LegendThumbSchema = z.string().regex(/^legend\/le_[A-Za-z0-9_-]{1,125}\.webp$/, 'thumb must be legend/{entryId}.webp');
const UnknownThumbSchema = z.string().regex(/^unknown\/u_[A-Za-z0-9_-]{1,125}\.webp$/, 'thumb must be unknown/{clusterId}.webp');

/** Level thresholds (brief): green ≥ 0.85 without a warning reason, red < 0.5, else yellow. Raster sheets cap at yellow. */
export const LEVEL_THRESHOLDS = Object.freeze({ green: 0.85, red: 0.5 });

export function levelForScore(score: number, opts: { warning?: boolean; raster?: boolean } = {}): ConfidenceLevel {
  if (score < LEVEL_THRESHOLDS.red) return 'red';
  if (score >= LEVEL_THRESHOLDS.green && !opts.warning && !opts.raster) return 'green';
  return 'yellow';
}

// ---------------------------------------------------------------------------
// legend.json.gz — kamutan.legend/1
// ---------------------------------------------------------------------------

export const LegendBlockSchema = z.object({
  id: LegendIdSchema,
  bboxMm: BBoxMmSchema,
  title: z.string().max(200).nullable(),
  confidence: conf01,
});
export type LegendBlock = z.infer<typeof LegendBlockSchema>;

export const LegendArtifactEntrySchema = z.object({
  id: LegendEntryIdSchema,
  legendId: LegendIdSchema,
  symbolBboxMm: BBoxMmSchema,
  labelBboxMm: BBoxMmSchema,
  label: z.string().max(300),
  labelConfidence: conf01,
  /** Taxonomy id, "unknown", or null when nothing could be suggested. */
  suggestedClass: DetectionClassSchema.nullable(),
  classConfidence: conf01,
  signature: SymbolSignatureSchema,
  /** `legend/{entryId}.webp` (≤ 256 px), relative to the version prefix; null when no crop was written. */
  thumb: LegendThumbSchema.nullable(),
});
export type LegendArtifactEntry = z.infer<typeof LegendArtifactEntrySchema>;

export const LegendArtifactSchema = z
  .object({
    schema: z.literal(LEGEND_SCHEMA),
    legends: z.array(LegendBlockSchema).max(32),
    entries: z.array(LegendArtifactEntrySchema).max(1000),
  })
  .superRefine((a, ctx) => {
    uniqueIds(a.legends, ['legends'], ctx);
    uniqueIds(a.entries, ['entries'], ctx);
    const legends = new Set(a.legends.map((l) => l.id));
    a.entries.forEach((e, i) => {
      if (!legends.has(e.legendId)) issue(ctx, ['entries', i, 'legendId'], 'unknown legendId');
      if (e.thumb !== null && e.thumb !== `legend/${e.id}.webp`) issue(ctx, ['entries', i, 'thumb'], 'thumb must be legend/{id}.webp');
    });
  });
export type LegendArtifact = z.infer<typeof LegendArtifactSchema>;

// ---------------------------------------------------------------------------
// detections.json.gz — kamutan.detections/1
// ---------------------------------------------------------------------------

export const DETECTION_LIFECYCLES = [...LIFECYCLES, 'unknown'] as const;
export const DetectionLifecycleSchema = z.enum(DETECTION_LIFECYCLES);
export const SupplySchema = z.enum(SUPPLY_KINDS);

export const DetectionSchema = z.object({
  id: DetectionIdSchema,
  class: DetectionClassSchema,
  legendEntryId: LegendEntryIdSchema.nullable(),
  centerMm: PointMmSchema,
  bboxMm: BBoxMmSchema,
  angleDeg: z.number().finite().min(-360).max(360),
  score: conf01,
  level: ConfidenceLevelSchema,
  reasons: ReasonsSchema,
  roomId: RoomIdSchema.nullable(),
  floor: FloorSchema.nullable(),
  lifecycle: DetectionLifecycleSchema,
  supply: SupplySchema.nullable(),
  /** Raw annotations near the symbol ("2X", "H=30"). */
  annotations: z.array(z.string().min(1).max(32)).max(16),
  clusterId: ClusterIdSchema.nullable(),
  /** Sprint 4 (optional): stroke signature of the symbol (groups review-queue clusters, find_similar exemplar). */
  signature: SymbolSignatureSchema.nullable().optional(),
});
export type Detection = z.infer<typeof DetectionSchema>;

export const UnknownClusterSchema = z.object({
  id: ClusterIdSchema,
  signature: SymbolSignatureSchema,
  count: z.number().int().min(1),
  exemplarBboxMm: BBoxMmSchema,
  /** `unknown/{clusterId}.webp` (≤ 256 px), relative to the version prefix; null when no crop was written. */
  thumb: UnknownThumbSchema.nullable(),
});
export type UnknownCluster = z.infer<typeof UnknownClusterSchema>;

export const MAX_DETECTIONS = 50_000;

export const DetectionsArtifactSchema = z
  .object({
    schema: z.literal(DETECTIONS_SCHEMA),
    detections: z.array(DetectionSchema).max(MAX_DETECTIONS),
    unknownClusters: z.array(UnknownClusterSchema).max(2000),
  })
  .superRefine((a, ctx) => {
    uniqueIds(a.detections, ['detections'], ctx);
    uniqueIds(a.unknownClusters, ['unknownClusters'], ctx);
    const clusters = new Set(a.unknownClusters.map((c) => c.id));
    a.detections.forEach((d, i) => {
      if (d.level !== 'green' && d.reasons.length === 0) issue(ctx, ['detections', i, 'reasons'], 'a non-green detection needs at least one reason');
      if (d.class === 'unknown' && d.clusterId === null) issue(ctx, ['detections', i, 'clusterId'], 'an unknown detection needs a clusterId');
      if (d.clusterId !== null && !clusters.has(d.clusterId)) issue(ctx, ['detections', i, 'clusterId'], 'clusterId not in unknownClusters');
    });
    a.unknownClusters.forEach((c, i) => {
      if (c.thumb !== null && c.thumb !== `unknown/${c.id}.webp`) issue(ctx, ['unknownClusters', i, 'thumb'], 'thumb must be unknown/{id}.webp');
    });
  });
export type DetectionsArtifact = z.infer<typeof DetectionsArtifactSchema>;

// ---------------------------------------------------------------------------
// rooms.json.gz — kamutan.rooms/1
// ---------------------------------------------------------------------------

/** Sprint 4: room types (Worker-B classifies from the room name + fixtures). */
export const ROOM_TYPES = ['bathroom', 'wc', 'kitchen', 'bedroom', 'living', 'corridor', 'balcony', 'courtyard', 'storage', 'stairs', 'other'] as const;
export const RoomTypeSchema = z.enum(ROOM_TYPES);
export type RoomType = z.infer<typeof RoomTypeSchema>;
/** Room types that are wet by default (tiling / waterproofing defaults). */
export const WET_ROOM_TYPES: readonly RoomType[] = Object.freeze(['bathroom', 'wc']);

export const WallIdSchema = idWith('w_');
export const OpeningIdSchema = idWith('o_');

/** Sprint 4: one wall segment of a room outline (paper mm; `lengthM` at the region's scale). */
export const RoomWallSchema = z
  .object({
    id: WallIdSchema,
    aMm: PointMmSchema,
    bMm: PointMmSchema,
    lengthM: z.number().finite().nonnegative(),
    /** true = faces outside the room's building envelope (not shared with another room). */
    exterior: z.boolean(),
  })
  .strict();
export type RoomWall = z.infer<typeof RoomWallSchema>;

export const OPENING_KINDS = ['door', 'window', 'opening'] as const;
export const OpeningKindSchema = z.enum(OPENING_KINDS);

/** Sprint 4: a door / window / opening in one of the room's walls (subtracted from cladding). */
export const RoomOpeningSchema = z
  .object({
    id: OpeningIdSchema,
    kind: OpeningKindSchema,
    wallId: WallIdSchema,
    widthM: z.number().finite().nonnegative(),
    /** null when the drawing does not give it (the tiling rule then uses its default height). */
    heightM: z.number().finite().nonnegative().nullable(),
    centerMm: PointMmSchema,
  })
  .strict();
export type RoomOpening = z.infer<typeof RoomOpeningSchema>;

export const RoomSchema = z.object({
  id: RoomIdSchema,
  /** OCR'd room name ("סלון"); null when the room has no readable label. */
  name: z.string().max(100).nullable(),
  nameConfidence: conf01,
  floor: FloorSchema.nullable(),
  /** Implicitly closed polygon. */
  polygonMm: z.array(PointMmSchema).min(3).max(4096),
  /** Using the region's scale (m², m). */
  areaM2: z.number().finite().nonnegative(),
  perimeterM: z.number().finite().nonnegative(),
  confidence: conf01,
  level: ConfidenceLevelSchema,
  reasons: ReasonsSchema,
  // --- Sprint 4 (Worker-B; optional so Sprint-2/3 artifacts stay valid) ---
  type: RoomTypeSchema.optional(),
  /** Wet room (bathroom / wc / shower / laundry …): floor tiling + waterproofing defaults. */
  wet: z.boolean().optional(),
  walls: z.array(RoomWallSchema).max(512).optional(),
  openings: z.array(RoomOpeningSchema).max(256).optional(),
  /** Number of external (convex) corners where cladding meets — corner trim = n × cladding height. */
  externalCorners: z.number().int().min(0).max(256).optional(),
  /** Ceiling height (m) when the drawing gives it (section / note); caps the default cladding height. */
  ceilingHeightM: z.number().finite().positive().max(10).nullable().optional(),
  /** Niche (washing-machine alcove …): floor tiled with its room, walls NOT clad. */
  niche: z.boolean().optional(),
});
export type Room = z.infer<typeof RoomSchema>;

export const RoomsArtifactSchema = z
  .object({
    schema: z.literal(ROOMS_SCHEMA),
    rooms: z.array(RoomSchema).max(2000),
  })
  .superRefine((a, ctx) => {
    uniqueIds(a.rooms, ['rooms'], ctx);
    a.rooms.forEach((r, i) => {
      if (r.level !== 'green' && r.reasons.length === 0) issue(ctx, ['rooms', i, 'reasons'], 'a non-green room needs at least one reason');
      // Sprint 4: wall / opening ids unique within the room; every opening sits on one of the room's walls.
      if (r.walls) uniqueIds(r.walls, ['rooms', String(i), 'walls'], ctx);
      if (r.openings) {
        uniqueIds(r.openings, ['rooms', String(i), 'openings'], ctx);
        const walls = new Set((r.walls ?? []).map((w) => w.id));
        r.openings.forEach((o, j) => {
          if (!walls.has(o.wallId)) issue(ctx, ['rooms', i, 'openings', j, 'wallId'], 'opening.wallId is not a wall of this room');
        });
      }
    });
  });
export type RoomsArtifact = z.infer<typeof RoomsArtifactSchema>;

// ---------------------------------------------------------------------------
// fixtures.json.gz — kamutan.fixtures/1 (Sprint 4, Worker-B `fixtures_json`)
// ---------------------------------------------------------------------------

/**
 * A fixture record = a Detection (same fields; the id may lack the `d_` prefix in older files) + Worker-B's extended,
 * all-optional fields: `source` (shape | text | shape+text), `attachedTo` (faucet → basin/sink/shower id), `label`
 * (supporting plumbing text), `leaderMm` (leader polyline), `sheetId` + `duplicates` ("sheetId/detectionId" copies on
 * other sheets, after floor de-duplication). Unknown extra keys are allowed (passthrough).
 */
export const FixtureRecordSchema = DetectionSchema.extend({
  id: z.string().min(1).max(128),
  source: z.string().max(32).optional(),
  attachedTo: z.string().max(128).nullable().optional(),
  label: z.string().max(300).nullable().optional(),
  leaderMm: z.array(PointMmSchema).max(512).optional(),
  sheetId: DocIdSchema.optional(),
  duplicates: z.array(z.string().max(300)).max(64).optional(),
}).passthrough();
export type FixtureRecord = z.infer<typeof FixtureRecordSchema>;

export const FixturesArtifactSchema = z
  .object({ schema: z.literal(FIXTURES_SCHEMA), fixtures: z.array(FixtureRecordSchema).max(MAX_DETECTIONS) })
  .passthrough()
  .superRefine((a, ctx) => uniqueIds(a.fixtures, ['fixtures'], ctx));
export type FixturesArtifact = z.infer<typeof FixturesArtifactSchema>;

// ---------------------------------------------------------------------------
// walls.json.gz — kamutan.walls/1 (Sprint 4, Worker-B `reference_walls_json`)
// ---------------------------------------------------------------------------

const RingSchema = z.array(PointMmSchema).max(20_000);
export const WallPolygonSchema = z.object({ exterior: RingSchema, holes: z.array(RingSchema).max(1000) }).passthrough();
/** One drawing (sheet region) of reference walls; polygons simplified at 0.1 mm, paper mm. */
export const WallsDrawingSchema = z
  .object({
    floor: FloorSchema.nullable(),
    scaleDenominator: z.number().int().positive().nullable(),
    sheetId: DocIdSchema.nullable(),
    regionId: z.string().max(64).nullable(),
    polygonsMm: z.array(WallPolygonSchema).max(5000),
    closuresMm: z.array(WallPolygonSchema).max(5000).optional(),
  })
  .passthrough();
export const WallsArtifactSchema = z.object({ schema: z.literal(WALLS_SCHEMA), drawings: z.array(WallsDrawingSchema).max(64) }).passthrough();
export type WallsArtifact = z.infer<typeof WallsArtifactSchema>;

// ---------------------------------------------------------------------------
// Firestore: legendEntries + symbolMappings
// ---------------------------------------------------------------------------

export const LEGEND_ENTRY_STATUSES = ['suggested', 'confirmed', 'ignored'] as const;
export const LegendEntryStatusSchema = z.enum(LEGEND_ENTRY_STATUSES);
export type LegendEntryStatus = z.infer<typeof LegendEntryStatusSchema>;

/**
 * orgs/{orgId}/projects/{projectId}/legendEntries/{entryId} (DTO = doc fields + id).
 * The worker writes `suggested` entries and never overwrites a `confirmed`/`ignored` entry with the same signature
 * (it links to it). Clients never write (firestore.rules) — confirm/ignore/reassign go through the API.
 */
export const LegendEntrySchema = z.object({
  id: LegendEntryIdSchema,
  sheetId: DocIdSchema,
  versionId: DocIdSchema,
  label: z.string().max(300),
  labelConfidence: conf01,
  suggestedClass: DetectionClassSchema.nullable(),
  /** null until confirmed. */
  class: SymbolClassSchema.nullable(),
  itemCode: ItemCodeSchema.nullable(),
  signature: SymbolSignatureSchema,
  /** Full storage path of the crop (…/versions/{v}/legend/{entryId}.webp or …/unknown/{clusterId}.webp) or null. */
  thumbPath: z.string().max(1024).nullable(),
  status: LegendEntryStatusSchema,
  /** Who confirmed / ignored it, and when (absent while `suggested`). */
  confirmedBy: UidSchema.nullable().optional(),
  confirmedAt: TimestampSchema.nullable().optional(),
  updatedAt: TimestampSchema.nullable(),
});
export type LegendEntry = z.infer<typeof LegendEntrySchema>;

/**
 * orgs/{orgId}/symbolMappings/{signature} — org memory ("learn once, reuse"). Written by the API on confirm /
 * reassign / unknown-cluster resolve (upsert, `uses` incremented); read by the worker:
 *  - `ignored: false` → `class` is a taxonomy id: pre-fill `suggestedClass` with high confidence;
 *  - `ignored: true` → `class` and `itemCode` are null: the user said "לא רלוונטי" — the worker must NOT emit
 *    detections / unknown clusters for this signature.
 * Docs written before `ignored` existed have no such field: treat a missing `ignored` as false.
 */
export const SymbolMappingSchema = z.object({
  signature: SymbolSignatureSchema,
  /** null iff `ignored`. */
  class: SymbolClassSchema.nullable(),
  ignored: z.boolean(),
  itemCode: ItemCodeSchema.nullable(),
  label: z.string().max(300),
  confirmedBy: UidSchema,
  confirmedAt: TimestampSchema,
  uses: z.number().int().min(1),
});
export type SymbolMapping = z.infer<typeof SymbolMappingSchema>;

// ---------------------------------------------------------------------------
// API DTOs
// ---------------------------------------------------------------------------

/** A signed URL (Storage V4, SIGNED_URL_TTL_SECONDS). */
export const SignedUrlRefSchema = z.object({ url: z.string().url() });

/** GET /v1/projects/:pid/sheets/:sid/versions/:vid/overlay (viewer+). */
export const OverlayManifestSchema = z.object({
  sheetId: DocIdSchema,
  versionId: DocIdSchema,
  /** null when the artifact was not produced for this version (no legend on the sheet, Sprint-1 version, …). */
  legend: SignedUrlRefSchema.nullable(),
  detections: SignedUrlRefSchema.nullable(),
  rooms: SignedUrlRefSchema.nullable(),
  /** Sprint 3: links.json.gz (kamutan.links/1, switch↔luminaire arcs); null when the version has none. Always set by the API. */
  links: SignedUrlRefSchema.nullable().optional(),
  /** Sprint 4: fixtures.json.gz (kamutan.fixtures/1) / walls.json.gz (kamutan.walls/1); null when absent. Always set by the API. */
  fixtures: SignedUrlRefSchema.nullable().optional(),
  walls: SignedUrlRefSchema.nullable().optional(),
  /** Crop URLs keyed by legend entry id (`le_…`) or unknown cluster id (`u_…`). */
  thumbs: z.record(z.string().regex(/^(le|u)_[A-Za-z0-9_-]+$/), z.string().url()),
  stats: VersionStatsSchema.nullable(),
  /** Earliest expiry among the returned URLs; re-request before then. */
  expiresAt: TimestampSchema,
});
export type OverlayManifest = z.infer<typeof OverlayManifestSchema>;

/** Max crops signed per overlay call (each is an IAM signBlob in Functions). */
export const OVERLAY_MAX_THUMBS = 256;

export const ListLegendEntriesQuerySchema = z
  .object({
    status: LegendEntryStatusSchema.optional(),
    sheetId: DocIdSchema.optional(),
    cursor: DocIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
export type ListLegendEntriesQuery = z.infer<typeof ListLegendEntriesQuerySchema>;

/** List item: the entry + a short-lived signed URL of its crop (null without a crop). */
export const LegendEntryItemSchema = LegendEntrySchema.extend({ thumbUrl: z.string().url().nullable() });
export type LegendEntryItem = z.infer<typeof LegendEntryItemSchema>;

export const LegendEntryPageSchema = pageOf(LegendEntryItemSchema).extend({ expiresAt: TimestampSchema.nullable() });
export type LegendEntryPage = z.infer<typeof LegendEntryPageSchema>;

/**
 * PATCH /v1/projects/:pid/legend-entries/:entryId (editor+).
 *  - `confirm`: status → confirmed with `class` (defaults to the entry's `suggestedClass` when it is a taxonomy id).
 *  - `reassign`: same, but `class` is required (the user picked a different class than suggested).
 *  - `ignore`: status → ignored ("not an item"); no mapping is written.
 * confirm/reassign upsert `orgs/{o}/symbolMappings/{signature}` (uses++). Every action is audited.
 */
export const PatchLegendEntryRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('confirm'),
      class: SymbolClassSchema.optional(),
      itemCode: ItemCodeSchema.nullable().optional(),
      /** User-edited legend text (replaces the OCR label on the entry and becomes the mapping label). */
      label: z.string().max(300).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('reassign'),
      class: SymbolClassSchema,
      itemCode: ItemCodeSchema.nullable().optional(),
      label: z.string().max(300).optional(),
    })
    .strict(),
  z.object({ action: z.literal('ignore') }).strict(),
]);
export type PatchLegendEntryRequest = z.infer<typeof PatchLegendEntryRequestSchema>;

export const PatchLegendEntryResponseSchema = z.object({
  entry: LegendEntrySchema,
  /** The upserted org mapping (null for `ignore`). */
  mapping: SymbolMappingSchema.nullable(),
});
export type PatchLegendEntryResponse = z.infer<typeof PatchLegendEntryResponseSchema>;

/**
 * POST /v1/projects/:pid/unknown-clusters/:clusterId/resolve (editor+). Exactly one of `class` / `ignore: true`:
 *  - `class` → mapping `{class, ignored: false}` (+ optional confirmed legend entry);
 *  - `ignore: true` ("לא רלוונטי") → mapping `{class: null, itemCode: null, ignored: true}` (+ optional `ignored`
 *    legend entry); the worker skips the signature on the next run.
 */
export const ResolveUnknownClusterRequestSchema = z
  .object({
    sheetId: DocIdSchema,
    versionId: DocIdSchema,
    class: SymbolClassSchema.optional(),
    ignore: z.boolean().optional(),
    itemCode: ItemCodeSchema.nullable().optional(),
    /** Also create a project legend entry (`le_<sheetId>_<clusterId>`; confirmed, or ignored with `ignore`). */
    createLegendEntry: z.boolean(),
  })
  .strict()
  .superRefine((b, ctx) => {
    const ignore = b.ignore === true;
    if (ignore === (b.class !== undefined)) issue(ctx, ['class'], 'give exactly one of class or ignore: true');
    if (ignore && b.itemCode != null) issue(ctx, ['itemCode'], 'itemCode is not allowed with ignore');
  });
export type ResolveUnknownClusterRequest = z.infer<typeof ResolveUnknownClusterRequestSchema>;

export const ReprocessOutcomeSchema = z.object({
  sheetId: DocIdSchema,
  status: z.enum(['queued', 'skipped']),
  /** Why it was skipped: `in_progress` (a run is already queued/processing), `not_current` (resolved on an old version), `publish_failed`. */
  reason: z.string().max(64).nullable(),
  versionId: DocIdSchema.nullable(),
  jobId: DocIdSchema.nullable(),
});
export type ReprocessOutcome = z.infer<typeof ReprocessOutcomeSchema>;

export const ResolveUnknownClusterResponseSchema = z.object({
  clusterId: ClusterIdSchema,
  signature: SymbolSignatureSchema,
  /** The upserted org mapping (an `ignored: true` record when resolved as "not relevant"). */
  mapping: SymbolMappingSchema.nullable(),
  legendEntry: LegendEntrySchema.nullable(),
  reprocess: z.array(ReprocessOutcomeSchema),
});
export type ResolveUnknownClusterResponse = z.infer<typeof ResolveUnknownClusterResponseSchema>;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function issue(ctx: z.RefinementCtx, path: Array<string | number>, message: string) {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function uniqueIds(items: ReadonlyArray<{ id: string }>, path: string[], ctx: z.RefinementCtx) {
  const seen = new Set<string>();
  items.forEach((it, i) => {
    if (seen.has(it.id)) issue(ctx, [...path, i, 'id'], 'duplicate id');
    seen.add(it.id);
  });
}
