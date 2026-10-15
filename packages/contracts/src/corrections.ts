/**
 * Sprint 4 — human corrections, room settings (tiling inputs), review queue and "learn from correction"
 * (docs/agents/SPRINT4_BRIEF.md, exact field names).
 *
 * Firestore (all API-only writes; members read):
 *  - orgs/{o}/projects/{p}/corrections/{corrId}         Correction
 *  - orgs/{o}/projects/{p}/correctionBatches/{batchId}  CorrectionBatch (one per POST …/corrections/batch)
 *  - orgs/{o}/projects/{p}/roomSettings/{sheetId}__{roomId}  RoomSettings
 *  - orgs/{o}/projects/{p}/similarSearches/{searchId}   SimilarSearch (API creates `queued`, worker fills)
 * Storage:
 *  - orgs/{o}/projects/{p}/similar/{searchId}/{candidateId}.webp  candidate crops (worker; signed URL only)
 *
 * Semantics (brief): corrections are applied AFTER automatic detection in `boq.build` and re-matched to newer
 * versions by `anchorMm` within `radiusMm` (paper mm) + class family; a correction that matched nothing in the
 * build's current version is reported back (evidence `corrections.unmatched`) and shown red in the queue
 * ("תיקון לא הותאם"). Undo = `revertedAt` (never a delete). accept → detection human-verified (green, "אושר ידנית");
 * reject → removed from the count.
 */
import { z } from 'zod';
import { TimestampSchema, pageOf } from './common.js';
import { ItemCodeSchema, LinkGroupIdSchema } from './boq.js';
import { DocIdSchema, UidSchema } from './org.js';
import { ConfidenceLevelSchema } from './review.js';
import { FloorSchema, PointMmSchema } from './sheets.js';
import { SymbolClassSchema } from './taxonomy.js';
import { BBoxMmSchema, RoomIdSchema, RoomTypeSchema, SymbolSignatureSchema, WallIdSchema } from './understanding.js';

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

export const CORRECTION_KINDS = ['add', 'remove', 'reclassify', 'move', 'link', 'unlink', 'measure', 'count', 'accept', 'reject'] as const;
export const CorrectionKindSchema = z.enum(CORRECTION_KINDS);
export type CorrectionKind = z.infer<typeof CorrectionKindSchema>;

/**
 * Role needed per kind (decision, SEC-07 "תיקון פריטים ושינוי סטטוס"): accept / reject are review decisions
 * (reviewer+); every kind that changes WHAT is counted or measured is an edit (editor+), like `qtyOverride` in
 * Sprint 3. A batch needs the highest role of its items; a revert needs the role of the reverted kind.
 */
export const CORRECTION_KIND_MIN_ROLE: Readonly<Record<CorrectionKind, 'editor' | 'reviewer'>> = Object.freeze({
  add: 'editor',
  remove: 'editor',
  reclassify: 'editor',
  move: 'editor',
  link: 'editor',
  unlink: 'editor',
  measure: 'editor',
  count: 'editor',
  accept: 'reviewer',
  reject: 'reviewer',
});

/** Default re-match radius (paper mm). */
export const CORRECTION_DEFAULT_RADIUS_MM = 3;
export const CORRECTION_MAX_RADIUS_MM = 50;
/** Max items of POST …/corrections/batch (one batchId). */
export const CORRECTION_BATCH_MAX = 500;

export const CORRECTION_UNITS = ['m2', 'm', 'unit'] as const;
export const CorrectionUnitSchema = z.enum(CORRECTION_UNITS);
export type CorrectionUnit = z.infer<typeof CorrectionUnitSchema>;

export const CORRECTION_GEOMETRY_TYPES = ['point', 'polygon', 'polyline'] as const;
/** Paper-mm geometry: `point` = 1..2000 points (manual count clicks / moved position), `polygon` ≥ 3, `polyline` ≥ 2. */
export const CorrectionGeometrySchema = z
  .object({
    type: z.enum(CORRECTION_GEOMETRY_TYPES),
    mm: z.array(PointMmSchema).min(1).max(2000),
  })
  .strict()
  .superRefine((g, ctx) => {
    const min = g.type === 'polygon' ? 3 : g.type === 'polyline' ? 2 : 1;
    if (g.mm.length < min) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mm'], message: `${g.type} needs at least ${min} points` });
  });
export type CorrectionGeometry = z.infer<typeof CorrectionGeometrySchema>;

const shortId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, 'invalid id');
const DetectionRefSchema = shortId; // d_… (auto) or m_… (manual, from a correction)
export const CorrectionIdSchema = DocIdSchema;
export const BatchIdSchema = DocIdSchema;

/** Fields the client sends (POST …/corrections and each item of …/corrections/batch). */
const correctionInputShape = {
  kind: CorrectionKindSchema,
  sheetId: DocIdSchema,
  /** Version the user edited on (must exist; normally the sheet's current version). */
  versionId: DocIdSchema,
  /** Stable re-match key: the item's center (paper mm) at the time of the edit. */
  anchorMm: PointMmSchema,
  radiusMm: z.number().finite().positive().max(CORRECTION_MAX_RADIUS_MM).default(CORRECTION_DEFAULT_RADIUS_MM),
  detectionId: DetectionRefSchema.nullable().default(null),
  signature: SymbolSignatureSchema.nullable().default(null),
  class: SymbolClassSchema.nullable().default(null),
  itemCode: ItemCodeSchema.nullable().default(null),
  linkGroupId: LinkGroupIdSchema.nullable().default(null),
  switchIds: z.array(DetectionRefSchema).max(16).optional(),
  pointIds: z.array(DetectionRefSchema).max(64).optional(),
  geometry: CorrectionGeometrySchema.nullable().default(null),
  quantity: z.number().finite().min(0).max(1_000_000).nullable().default(null),
  unit: CorrectionUnitSchema.nullable().default(null),
  roomId: RoomIdSchema.nullable().default(null),
  floor: FloorSchema.nullable().default(null),
  /** Short free text ("לא שקע, זה גלאי"). Never copied into the audit log. */
  reason: z.string().trim().max(500).nullable().default(null),
} as const;

/** Per-kind requirements (shared by the request and the stored doc; NOT in JSON Schema — the worker re-checks). */
function refineCorrection(c: z.infer<z.ZodObject<typeof correctionInputShape>>, ctx: z.RefinementCtx): void {
  const need = (cond: boolean, path: string, message: string) => {
    if (!cond) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  };
  const g = c.geometry;
  switch (c.kind) {
    case 'add':
      need(c.class !== null || c.itemCode !== null, 'class', 'add needs a class or an itemCode');
      need(c.detectionId === null, 'detectionId', 'add creates a new item (no detectionId)');
      need(g === null || (g.type === 'point' && g.mm.length === 1), 'geometry', 'add takes at most one point');
      break;
    case 'remove':
    case 'accept':
    case 'reject':
      need(c.detectionId !== null || c.linkGroupId !== null || (c.kind !== 'remove' && c.roomId !== null), 'detectionId', `${c.kind} needs a detectionId${c.kind === 'remove' ? ' or linkGroupId' : ', linkGroupId or roomId'}`);
      break;
    case 'reclassify':
      need(c.detectionId !== null, 'detectionId', 'reclassify needs a detectionId');
      need(c.class !== null || c.itemCode !== null, 'class', 'reclassify needs a class or an itemCode');
      break;
    case 'move':
      need(c.detectionId !== null, 'detectionId', 'move needs a detectionId');
      need(g !== null && g.type === 'point' && g.mm.length === 1, 'geometry', 'move needs geometry {type: point, mm: [new center]}');
      break;
    case 'link':
      need((c.switchIds?.length ?? 0) > 0 || c.linkGroupId !== null, 'switchIds', 'link needs switchIds (new group) or a linkGroupId (extend a group)');
      need((c.pointIds?.length ?? 0) > 0, 'pointIds', 'link needs pointIds');
      break;
    case 'unlink':
      need(c.linkGroupId !== null, 'linkGroupId', 'unlink needs a linkGroupId');
      break;
    case 'measure':
      need(c.itemCode !== null, 'itemCode', 'measure needs an itemCode');
      need(g !== null && g.type !== 'point', 'geometry', 'measure needs a polygon (m²) or polyline (m\')');
      if (g && g.type !== 'point') need(c.unit === (g.type === 'polygon' ? 'm2' : 'm'), 'unit', `a ${g.type} is measured in ${g.type === 'polygon' ? 'm2' : 'm'}`);
      break;
    case 'count':
      need(c.itemCode !== null || c.class !== null, 'itemCode', 'count needs an itemCode or a class');
      need(g !== null && g.type === 'point', 'geometry', 'count needs geometry {type: point, mm: [clicks]}');
      need(c.unit === null || c.unit === 'unit', 'unit', 'count is in units');
      if (g && c.quantity !== null) need(c.quantity === g.mm.length, 'quantity', 'quantity must equal the number of clicks');
      break;
  }
  if (c.kind !== 'measure' && c.kind !== 'count') need(c.unit === null, 'unit', `unit is only for measure / count`);
}

export const CreateCorrectionRequestSchema = z.object(correctionInputShape).strict().superRefine(refineCorrection);
export type CreateCorrectionRequest = z.infer<typeof CreateCorrectionRequestSchema>;
export type CreateCorrectionInput = z.input<typeof CreateCorrectionRequestSchema>;

/** orgs/{o}/projects/{p}/corrections/{corrId} (DTO = doc + id). Immutable except `revertedAt` / `revertedBy`. */
export const CorrectionSchema = z
  .object({
    id: CorrectionIdSchema,
    ...correctionInputShape,
    radiusMm: z.number().finite().positive().max(CORRECTION_MAX_RADIUS_MM),
    detectionId: DetectionRefSchema.nullable(),
    signature: SymbolSignatureSchema.nullable(),
    class: SymbolClassSchema.nullable(),
    itemCode: ItemCodeSchema.nullable(),
    linkGroupId: LinkGroupIdSchema.nullable(),
    geometry: CorrectionGeometrySchema.nullable(),
    quantity: z.number().finite().min(0).nullable(),
    unit: CorrectionUnitSchema.nullable(),
    roomId: RoomIdSchema.nullable(),
    floor: FloorSchema.nullable(),
    reason: z.string().max(500).nullable(),
    batchId: BatchIdSchema.nullable(),
    by: UidSchema,
    at: TimestampSchema,
    revertedAt: TimestampSchema.nullable(),
    revertedBy: UidSchema.nullable().optional(),
  })
  .superRefine(refineCorrection);
export type Correction = z.infer<typeof CorrectionSchema>;

/** Where a batch came from (UX: cluster card, lasso popover, learn-from-correction, multi-select). */
export const CORRECTION_BATCH_SOURCES = ['cluster', 'lasso', 'similar', 'selection', 'other'] as const;
export const CorrectionBatchSourceSchema = z.enum(CORRECTION_BATCH_SOURCES);

/** POST /v1/projects/:pid/corrections/batch — 1..500 items, all-or-nothing, one batchId. */
export const CreateCorrectionBatchRequestSchema = z
  .object({
    items: z.array(CreateCorrectionRequestSchema).min(1).max(CORRECTION_BATCH_MAX),
    source: CorrectionBatchSourceSchema.default('other'),
    /** similar-search that produced the batch ("החל על 9"). */
    similarSearchId: DocIdSchema.nullable().default(null),
  })
  .strict();
export type CreateCorrectionBatchRequest = z.infer<typeof CreateCorrectionBatchRequestSchema>;

/** orgs/{o}/projects/{p}/correctionBatches/{batchId}. Undo of the whole batch = one step (UX §undo). */
export const CorrectionBatchSchema = z.object({
  id: BatchIdSchema,
  count: z.number().int().min(1).max(CORRECTION_BATCH_MAX),
  /** kind → number of items. */
  kinds: z.record(CorrectionKindSchema, z.number().int().nonnegative()),
  sheetIds: z.array(DocIdSchema).max(CORRECTION_BATCH_MAX),
  source: CorrectionBatchSourceSchema,
  similarSearchId: DocIdSchema.nullable(),
  by: UidSchema,
  at: TimestampSchema,
  revertedAt: TimestampSchema.nullable(),
  revertedBy: UidSchema.nullable().optional(),
});
export type CorrectionBatch = z.infer<typeof CorrectionBatchSchema>;

/** What happened to the BOQ after a change (stale flag + debounced auto rebuild). */
export const RebuildOutcomeSchema = z.object({
  stale: z.boolean(),
  /** `scheduled` = new debounced build created; `debounced` = an existing queued build was pushed back; `followup` = queued behind a running build; `off` = org autoRebuild false; `failed` = publish error (stale stays true). */
  autoRebuild: z.enum(['scheduled', 'debounced', 'followup', 'off', 'failed']),
  buildId: DocIdSchema.nullable(),
  /** The build will not start before this time (debounce). */
  notBefore: TimestampSchema.nullable(),
});
export type RebuildOutcome = z.infer<typeof RebuildOutcomeSchema>;

export const CreateCorrectionResponseSchema = z.object({ correction: CorrectionSchema, rebuild: RebuildOutcomeSchema });
export type CreateCorrectionResponse = z.infer<typeof CreateCorrectionResponseSchema>;

export const CreateCorrectionBatchResponseSchema = z.object({
  batch: CorrectionBatchSchema,
  items: z.array(CorrectionSchema),
  rebuild: RebuildOutcomeSchema,
});
export type CreateCorrectionBatchResponse = z.infer<typeof CreateCorrectionBatchResponseSchema>;

export const RevertCorrectionResponseSchema = z.object({ correction: CorrectionSchema, rebuild: RebuildOutcomeSchema });
export type RevertCorrectionResponse = z.infer<typeof RevertCorrectionResponseSchema>;

export const RevertCorrectionBatchResponseSchema = z.object({
  batch: CorrectionBatchSchema,
  /** Items reverted by this call (already-reverted items are skipped). */
  reverted: z.number().int().nonnegative(),
  rebuild: RebuildOutcomeSchema,
});
export type RevertCorrectionBatchResponse = z.infer<typeof RevertCorrectionBatchResponseSchema>;

/** GET /v1/projects/:pid/corrections?sheetId=&batchId=&kind=&includeReverted=&cursor=&limit= (newest first). */
export const ListCorrectionsQuerySchema = z
  .object({
    sheetId: DocIdSchema.optional(),
    batchId: BatchIdSchema.optional(),
    kind: CorrectionKindSchema.optional(),
    includeReverted: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .default('false'),
    cursor: DocIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();
export type ListCorrectionsQuery = z.infer<typeof ListCorrectionsQuerySchema>;

export const CorrectionPageSchema = pageOf(CorrectionSchema);
export type CorrectionPage = z.infer<typeof CorrectionPageSchema>;

// ---------------------------------------------------------------------------
// Room settings (tiling inputs)
// ---------------------------------------------------------------------------

/** Default waste factor of tiling materials (order qty = net × (1 + waste)). */
export const DEFAULT_WASTE_FACTOR = 0.07;
export const MAX_CLADDING_HEIGHT_M = 6;

export const PartialCladdingSchema = z
  .object({
    wallId: WallIdSchema,
    /** Along the wall from its `aMm` end (m). */
    fromM: z.number().finite().min(0).max(200),
    toM: z.number().finite().min(0).max(200),
    heightM: z.number().finite().positive().max(MAX_CLADDING_HEIGHT_M),
    /** Optional height above the floor where the strip starts (kitchen backsplash over the counter). */
    bottomM: z.number().finite().min(0).max(MAX_CLADDING_HEIGHT_M).optional(),
  })
  .strict()
  .refine((p) => p.toM > p.fromM, { message: 'toM must be greater than fromM', path: ['toM'] });
export type PartialCladding = z.infer<typeof PartialCladdingSchema>;

const roomSettingsShape = {
  /** Full-height wall cladding (m); 0 = no full cladding. */
  claddingHeightM: z.number().finite().min(0).max(MAX_CLADDING_HEIGHT_M),
  floorTiled: z.boolean(),
  floorMaterialItemCode: ItemCodeSchema.nullable(),
  wallMaterialItemCode: ItemCodeSchema.nullable(),
  partialCladding: z.array(PartialCladdingSchema).max(64),
  wasteFactor: z.number().finite().min(0).max(0.5),
  includeInWaterproofing: z.boolean(),
  /** Openings (door / window ids of the room) the user chose NOT to subtract from the cladding. */
  keepOpenings: z.array(z.string().max(128).regex(/^o_[A-Za-z0-9_-]+$/)).max(256).optional(),
  /** User override of the room type (e.g. an unnamed room that is a laundry). */
  type: RoomTypeSchema.nullable().optional(),
  /** Ceiling height (m) entered by the user (or copied from the room); the cladding height must not exceed it. */
  ceilingHeightM: z.number().finite().positive().max(10).nullable().optional(),
} as const;

/** PUT /v1/projects/:pid/rooms/:sheetId/:roomId/settings (editor+). Whole document (strict). */
export const PutRoomSettingsRequestSchema = z.object(roomSettingsShape).strict();
export type PutRoomSettingsRequest = z.infer<typeof PutRoomSettingsRequestSchema>;

/** orgs/{o}/projects/{p}/roomSettings/{sheetId}__{roomId} (DTO adds the ids). */
export const RoomSettingsSchema = z.object({
  ...roomSettingsShape,
  sheetId: DocIdSchema,
  roomId: RoomIdSchema,
  by: UidSchema.nullable(),
  at: TimestampSchema.nullable(),
});
export type RoomSettings = z.infer<typeof RoomSettingsSchema>;

/** Doc id of a room's settings. */
export const roomSettingsId = (sheetId: string, roomId: string) => `${sheetId}__${roomId}`;

/** Default full-cladding height of wet rooms (m). */
export const DEFAULT_CLADDING_HEIGHT_M = 2.6;

export interface RoomDefaultFacts {
  /** Ceiling height from the drawing; caps the cladding height. */
  ceilingHeightM?: number | null;
  /** Niche (washing-machine alcove): floor tiled, walls not clad, not waterproofed on its own. */
  niche?: boolean | null;
  /** Shower / bath detected in the room (null = unknown). Waterproofing defaults to true only with one. */
  hasShowerOrBath?: boolean | null;
}

/**
 * Defaults by room type (brief + Data back-solve, rules v4): bathroom / wc → cladding 2.6 m (capped at the ceiling
 * height when known), floor tiled; waterproofed only with a shower / bath (unknown → bathroom yes, wc no); niche →
 * floor tiled, no cladding, no waterproofing; kitchen → no full cladding (backsplash via partialCladding 0.6 m);
 * courtyard → floor tiled; others none.
 */
export function defaultRoomSettings(type: string | null | undefined, wet?: boolean | null, facts: RoomDefaultFacts = {}): PutRoomSettingsRequest {
  const base: PutRoomSettingsRequest = {
    claddingHeightM: 0,
    floorTiled: false,
    floorMaterialItemCode: null,
    wallMaterialItemCode: null,
    partialCladding: [],
    wasteFactor: DEFAULT_WASTE_FACTOR,
    includeInWaterproofing: false,
  };
  const ceiling = facts.ceilingHeightM ?? null;
  if (facts.niche) return { ...base, floorTiled: true, ...(ceiling ? { ceilingHeightM: ceiling } : {}) };
  if (type === 'bathroom' || type === 'wc' || ((type == null || type === 'other') && wet === true)) {
    const cladding = ceiling ? Math.min(DEFAULT_CLADDING_HEIGHT_M, ceiling) : DEFAULT_CLADDING_HEIGHT_M;
    const waterproof = facts.hasShowerOrBath ?? type !== 'wc';
    return { ...base, claddingHeightM: cladding, floorTiled: true, includeInWaterproofing: waterproof, ...(ceiling ? { ceilingHeightM: ceiling } : {}) };
  }
  if (type === 'courtyard') return { ...base, floorTiled: true };
  return base;
}

/** Kitchen backsplash height used by the web when the user marks a counter wall. */
export const KITCHEN_BACKSPLASH_HEIGHT_M = 0.6;

/** GET (and PUT response): stored settings, or the type defaults with `isDefault: true`. */
export const RoomSettingsResponseSchema = z.object({
  settings: RoomSettingsSchema,
  isDefault: z.boolean(),
  /** Room facts from the current version's rooms.json.gz (null when the artifact has no such room). */
  room: z
    .object({
      versionId: DocIdSchema,
      name: z.string().nullable(),
      type: RoomTypeSchema.nullable(),
      wet: z.boolean().nullable(),
      areaM2: z.number().nullable(),
      perimeterM: z.number().nullable(),
      walls: z.array(z.object({ id: WallIdSchema, lengthM: z.number(), exterior: z.boolean() })),
      openings: z.array(z.object({ id: z.string(), kind: z.string(), wallId: z.string(), widthM: z.number(), heightM: z.number().nullable() })),
      externalCorners: z.number().int().nullable(),
      ceilingHeightM: z.number().nullable().optional(),
      niche: z.boolean().optional(),
      /** Shower / bath detected inside the room (current version's detections; null = no detections artifact). */
      hasShowerOrBath: z.boolean().nullable().optional(),
    })
    .nullable(),
  rebuild: RebuildOutcomeSchema.optional(),
});
export type RoomSettingsResponse = z.infer<typeof RoomSettingsResponseSchema>;

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------

export const REVIEW_QUEUE_KINDS = ['detection', 'cluster', 'unknown_cluster', 'link_group', 'room', 'unmatched_correction', 'line'] as const;
export const ReviewQueueKindSchema = z.enum(REVIEW_QUEUE_KINDS);
export type ReviewQueueKind = z.infer<typeof ReviewQueueKindSchema>;

export const REVIEW_SUGGESTED_ACTIONS = [
  'accept', // A
  'reject', // R
  'reclassify', // E
  'resolve_unknown', // סמל לא מוכר → choose class / not relevant
  'review_link', // G
  'room_settings', // room panel
  'name_room',
  'close_room',
  'redo_correction', // unmatched → re-apply on the new version
  'review_line',
] as const;
export const ReviewSuggestedActionSchema = z.enum(REVIEW_SUGGESTED_ACTIONS);

/** Level weight of the risk formula (brief: risk = |qty impact| × (1 − score) × level weight). */
export const REVIEW_LEVEL_WEIGHT = Object.freeze({ red: 3, yellow: 1, green: 0 });
/** Score assumed when the item has none (rooms without confidence, lines, unmatched corrections). */
export const REVIEW_DEFAULT_SCORE = Object.freeze({ red: 0.25, yellow: 0.6, green: 1 });
/** Detections with the same key (signature|legend entry + class + level + first reason + line) form a cluster from this size on. */
export const REVIEW_CLUSTER_MIN = 3;
/** Thumbnails signed per queue page. */
export const REVIEW_QUEUE_MAX_THUMBS = 64;

export const ReviewQueueItemSchema = z.object({
  /** Stable id (`det:<sheet>:<version>:<detId>`, `cl:<hash>`, `uc:<sheet>:<version>:<u_…>`, `lg:…`, `room:<sheet>:<r_…>`, `corr:<corrId>`, `line:<lineId>`). */
  id: z.string().min(1).max(300),
  kind: ReviewQueueKindSchema,
  level: ConfidenceLevelSchema,
  /** Ranking key (desc). */
  risk: z.number().finite().nonnegative(),
  score: z.number().min(0).max(1).nullable(),
  /** |quantity impact| on the affected BOQ line(s) in the line's unit. */
  qtyImpact: z.number().finite().nonnegative(),
  /** Short Hebrew title ("שקע כפול (4.01) · 12 מופעים"). */
  title: z.string().max(300),
  reasons: z.array(z.string().max(200)).max(32),
  suggestedAction: ReviewSuggestedActionSchema,
  sheetId: DocIdSchema.nullable(),
  versionId: DocIdSchema.nullable(),
  floor: z.string().max(32).nullable(),
  bboxMm: BBoxMmSchema.nullable(),
  /** Signed crop (unknown clusters / similar candidates) when one exists; null otherwise (the web crops from tiles). */
  thumbUrl: z.string().url().nullable(),
  class: z.string().max(64).nullable(),
  itemCode: ItemCodeSchema.nullable(),
  lineIds: z.array(DocIdSchema).max(32),
  /** Members (cluster: lowest score first, ≤ 500) or the single detection. */
  detectionIds: z.array(z.string().max(128)).max(500),
  /** Bounding boxes of the members, same order as `detectionIds` (hover → flash on the drawing). */
  memberBboxesMm: z.array(BBoxMmSchema).max(500).optional(),
  count: z.number().int().min(1),
  ref: z
    .object({
      detectionId: z.string().max(128).optional(),
      clusterId: z.string().max(128).optional(),
      linkGroupId: z.string().max(128).optional(),
      roomId: z.string().max(128).optional(),
      correctionId: z.string().max(128).optional(),
      lineId: z.string().max(128).optional(),
      signature: z.string().max(128).optional(),
    })
    .strict(),
});
export type ReviewQueueItem = z.infer<typeof ReviewQueueItemSchema>;

export const ReviewQueueQuerySchema = z
  .object({
    kind: ReviewQueueKindSchema.optional(),
    sheetId: DocIdSchema.optional(),
    floor: FloorSchema.optional(),
    level: z.enum(['yellow', 'red']).optional(),
    /** Opaque (offset in the ranked list of this build + overlay state). */
    cursor: z.string().regex(/^\d{1,6}$/).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type ReviewQueueQuery = z.infer<typeof ReviewQueueQuerySchema>;

export const ReviewQueuePageSchema = z.object({
  items: z.array(ReviewQueueItemSchema),
  nextCursor: z.string().nullable(),
  /** Items matching the filter (all pages). */
  total: z.number().int().nonnegative(),
  counts: z.object({
    byKind: z.record(ReviewQueueKindSchema, z.number().int().nonnegative()),
    byLevel: z.object({ yellow: z.number().int().nonnegative(), red: z.number().int().nonnegative() }),
  }),
  /** Build the queue was computed from (null before the first build: only unmatched corrections / nothing). */
  buildId: DocIdSchema.nullable(),
  stale: z.boolean(),
  generatedAt: TimestampSchema,
  /** Earliest expiry of the thumb URLs on this page (null without thumbs). */
  expiresAt: TimestampSchema.nullable(),
});
export type ReviewQueuePage = z.infer<typeof ReviewQueuePageSchema>;

// ---------------------------------------------------------------------------
// Learn from correction: symbols.find_similar
// ---------------------------------------------------------------------------

export const SIMILAR_SCOPES = ['sheet', 'project'] as const;
export const SimilarScopeSchema = z.enum(SIMILAR_SCOPES);
export const SIMILAR_MAX_CANDIDATES = 500;

export const SimilarExemplarSchema = z
  .object({
    sheetId: DocIdSchema,
    versionId: DocIdSchema,
    bboxMm: BBoxMmSchema.refine((b) => b.w > 0 && b.h > 0 && b.w <= 200 && b.h <= 200, { message: 'exemplar box must be 0 < w,h ≤ 200 mm' }),
    class: SymbolClassSchema.nullable(),
  })
  .strict();
export type SimilarExemplar = z.infer<typeof SimilarExemplarSchema>;

/** POST /v1/projects/:pid/similar-searches (reviewer+). */
export const CreateSimilarSearchRequestSchema = z
  .object({
    exemplar: SimilarExemplarSchema,
    scope: SimilarScopeSchema.default('project'),
    /** Correction that triggered the search (UX banner after a reclassify / reject), for provenance. */
    correctionId: CorrectionIdSchema.nullable().default(null),
  })
  .strict();
export type CreateSimilarSearchRequest = z.infer<typeof CreateSimilarSearchRequestSchema>;

export const SimilarCandidateIdSchema = z.string().regex(/^c_[A-Za-z0-9_-]{1,64}$/, 'candidate id must look like "c_…"');

export const SimilarCandidateSchema = z
  .object({
    id: SimilarCandidateIdSchema,
    sheetId: DocIdSchema,
    versionId: DocIdSchema,
    centerMm: PointMmSchema,
    bboxMm: BBoxMmSchema,
    score: z.number().min(0).max(1),
    /** Detection already at that position (null = nothing detected there). */
    alreadyDetected: z.string().max(128).nullable(),
    currentClass: z.string().max(64).nullable(),
    /** `{candidateId}.webp` under the search's crop prefix, or null when no crop was written. */
    thumb: z.string().regex(/^c_[A-Za-z0-9_-]{1,64}\.webp$/).nullable(),
  })
  .strict();
export type SimilarCandidate = z.infer<typeof SimilarCandidateSchema>;

export const SIMILAR_SEARCH_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;

/** orgs/{o}/projects/{p}/similarSearches/{searchId}. API creates `queued`; the worker writes status + candidates. */
export const SimilarSearchSchema = z
  .object({
    id: DocIdSchema,
    status: z.enum(SIMILAR_SEARCH_STATUSES),
    exemplar: SimilarExemplarSchema,
    scope: SimilarScopeSchema,
    correctionId: CorrectionIdSchema.nullable(),
    jobId: DocIdSchema.nullable(),
    requestedBy: UidSchema,
    createdAt: TimestampSchema,
    finishedAt: TimestampSchema.nullable(),
    /** Sorted by score desc. */
    candidates: z.array(SimilarCandidateSchema).max(SIMILAR_MAX_CANDIDATES),
    /** Number of candidate crops written (`thumbs` of the brief). */
    thumbs: z.number().int().nonnegative(),
    error: z.object({ code: z.string().max(64), message: z.string().max(500) }).nullable(),
  })
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    s.candidates.forEach((c, i) => {
      if (seen.has(c.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['candidates', i, 'id'], message: 'duplicate id' });
      seen.add(c.id);
      if (c.thumb !== null && c.thumb !== `${c.id}.webp`) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['candidates', i, 'thumb'], message: 'thumb must be {id}.webp' });
    });
  });
export type SimilarSearch = z.infer<typeof SimilarSearchSchema>;

export const CreateSimilarSearchResponseSchema = z.object({ search: SimilarSearchSchema, jobId: DocIdSchema });
export type CreateSimilarSearchResponse = z.infer<typeof CreateSimilarSearchResponseSchema>;

/** GET /v1/projects/:pid/similar-searches/:id — the doc + signed crop URLs (≤ 256, best scores first). */
export const SimilarSearchViewSchema = z.object({
  search: SimilarSearchSchema,
  thumbUrls: z.record(SimilarCandidateIdSchema, z.string().url()),
  expiresAt: TimestampSchema.nullable(),
});
export type SimilarSearchView = z.infer<typeof SimilarSearchViewSchema>;
