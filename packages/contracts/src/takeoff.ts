/**
 * Sprint 6 — text / equipment items and geometry take-off (docs/agents/SPRINT6_BRIEF.md "Shared interfaces").
 *
 * Storage (gzip JSON, one per sheet version, worker-written; immutable per version):
 *  - orgs/{o}/projects/{p}/sheets/{s}/versions/{v}/text_items.json.gz  `kamutan.textItems/1` (Worker-Text)
 *  - orgs/{o}/projects/{p}/sheets/{s}/versions/{v}/geometry.json.gz    `kamutan.geometry/1`   (Worker-Geometry)
 * Both are read by Worker-BOQ (`text_item`, `area_item`, `length_item`, `suggested_item` rules). The API reads them
 * server-side only (lenient views); the web gets geometry through the overlay manifest (signed URL) and text /
 * geometry evidence inline in the BOQ evidence (`BoqEvidenceItem.bboxMm` / `geometryMm`).
 *
 * Coordinates are paper millimetres, y down (decision #8); real-world quantities (m², m', treads) are computed by the
 * producing worker with the version's scale and stored next to the shape.
 */
import { z } from 'zod';
import { ConfidenceLevelSchema } from './review.js';
import { FloorSchema, PointMmSchema } from './sheets.js';
import { BBoxMmSchema } from './understanding.js';

export const TEXT_ITEMS_SCHEMA = 'kamutan.textItems/1' as const;
export const GEOMETRY_SCHEMA = 'kamutan.geometry/1' as const;

const idWith = (prefix: string) =>
  z
    .string()
    .max(128)
    .regex(new RegExp(`^${prefix}[A-Za-z0-9_-]+$`), `id must look like "${prefix}…"`);
const conf01 = z.number().min(0).max(1);
const ReasonsSchema = z.array(z.string().min(1).max(200)).max(16);

// ---------------------------------------------------------------------------
// Hebrew-normalised text matching (shared by text_item / suggested_item rules; the worker mirrors it exactly)
// ---------------------------------------------------------------------------

/** Final letters → regular letters (ך→כ, ם→מ, ן→נ, ף→פ, ץ→צ). */
export const HEBREW_FINAL_LETTERS: Readonly<Record<string, string>> = Object.freeze({ 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' });
/** Geresh-like characters → ASCII apostrophe. */
export const GERESH_CHARS = ["׳", '’', '‘', '`', '´'] as const;
/** Gershayim-like characters → ASCII double quote (`''` → `"` too). */
export const GERSHAYIM_CHARS = ['״', '”', '“', '„'] as const;

/**
 * Normalised form used for every text match (rules' patterns AND the drawing text are both normalised, then the
 * pattern is compiled and searched in the text):
 * NFC → niqqud / cantillation (U+0591–U+05C7 except maqaf U+05BE) removed → maqaf (U+05BE) / en / em dash → "-" →
 * final letters → regular letters → geresh variants → `'`, gershayim variants and `''` → `"` → Latin lower-case →
 * every whitespace run (incl. NBSP, LRM, RLM) → one space, trimmed.
 * Python: `kamutan_drawing` must implement the same function (same order); `test/sprint6.test.ts` lists examples.
 */
export function normalizeHebrewText(s: string): string {
  let t = s.normalize('NFC');
  t = t.replace(/[֑-ֽֿ-ׇ]/g, '');
  t = t.replace(/[־–—]/g, '-');
  t = t.replace(/[ךםןףץ]/g, (c) => HEBREW_FINAL_LETTERS[c] ?? c);
  t = t.replace(/[׳’‘`´]/g, "'");
  t = t.replace(/[״”“„]/g, '"').replace(/''/g, '"');
  t = t.toLowerCase();
  return t.replace(/[\s ‎‏]+/g, ' ').trim();
}

/** Max length of one rule pattern (regex source). */
export const MAX_TEXT_PATTERN_LENGTH = 200;

/**
 * True when `p` is a regex both JavaScript (`new RegExp(p, 'u')`) and Python `re` accept with the same meaning: no
 * named groups / back-references by name (`(?<n>`, `\k<`), no Unicode property escapes (`\p{…}` / `\P{…}`), no inline
 * flags (`(?i)`), no possessive / atomic syntax. Fixed-width look-behind (`(?<=…)`, `(?<!…)`) is allowed. Matching is
 * always case-insensitive on the normalised text (see `normalizeHebrewText`), so patterns need no flags.
 */
export function isPortableRegex(p: string): boolean {
  if (p.length === 0 || p.length > MAX_TEXT_PATTERN_LENGTH) return false;
  if (/\(\?<(?![=!])/.test(p) || /\\k</.test(p) || /\\[pP]\{/.test(p) || /\(\?[a-zA-Z]/.test(p) || /\(\?>/.test(p) || /[*+?}]\+/.test(p)) return false;
  try {
    new RegExp(p, 'u');
    return true;
  } catch {
    return false;
  }
}

export const TextPatternSchema = z
  .string()
  .min(1)
  .max(MAX_TEXT_PATTERN_LENGTH)
  .refine(isPortableRegex, { message: 'pattern must be a portable regex (JS + Python re; no named groups, \\p{}, inline flags)' });

// ---------------------------------------------------------------------------
// text_items.json.gz — kamutan.textItems/1 (Worker-Text; shape as published in workers/drawing/NOTES.md "Sprint 6 —
// text & equipment items (Worker-Text)"). Lenient: producers may add fields (passthrough).
// ---------------------------------------------------------------------------

/** Kind of a text item (Worker-Text). `text_item` rules filter with TEXT_RULE_SCOPES (library.ts). */
export const TEXT_ITEM_KINDS = ['note', 'callout', 'detail_ref', 'legend_row', 'panel_schedule', 'conduit'] as const;
export const TextItemKindSchema = z.enum(TEXT_ITEM_KINDS);
export type TextItemKind = z.infer<typeof TextItemKindSchema>;
/** Lifecycle qualifiers of texts ("קיים / חדש / להחליף / להוסיף / פירוק"). */
export const TEXT_LIFECYCLES = ['new', 'existing', 'replace', 'add', 'demolish'] as const;

const nn = <T extends z.ZodTypeAny>(t: T) => t.nullable().optional();

/** One logical text (`t_{n}`, stable per version in reading order). */
export const TextItemSchema = z
  .object({
    id: idWith('t_'),
    sheetId: z.string().max(128).optional(),
    kind: TextItemKindSchema,
    /** As read (≤ 400; note blocks joined with " / "). Never copied into audit logs or API responses. */
    text: z.string().max(1000),
    /** `normalizeHebrewText`-equivalent form. */
    normalized: z.string().max(1000).optional(),
    bboxMm: BBoxMmSchema,
    /** Leader terminal / run end the item names (null → bbox centre). */
    anchorMm: nn(PointMmSchema),
    /** Indexes into text.json.gz lines (evidence `text_{n}`). */
    lineIdx: z.array(z.number().int().nonnegative()).max(256).optional(),
    floor: nn(FloorSchema),
    roomId: nn(z.string().max(128)),
    lifecycle: nn(z.enum(TEXT_LIFECYCLES)),
    qty: nn(z.number().finite().nonnegative()),
    unit: nn(z.string().max(32)),
    lengthM: nn(z.number().finite().nonnegative()),
    /** Worker-Text catalog entry id; null = unmatched note. */
    matchedPattern: nn(z.string().max(128)),
    /** Reference item code of the catalog entry; null = unmatched. */
    itemCode: nn(z.string().max(32)),
    role: nn(z.enum(['item', 'feed', 'switch'])),
    pairedWith: nn(z.string().max(128)),
    /** The line is produced by symbols / links; this item is evidence only. */
    corroborates: z.boolean().optional(),
    /** The drawing shows a trigger, not the item (BOQ origin `suggested`). */
    suggested: z.boolean().optional(),
    confidence: conf01,
    scoreRaw: z.number().finite().optional(),
    level: ConfidenceLevelSchema,
    reasons: ReasonsSchema,
  })
  .passthrough();
export type TextItem = z.infer<typeof TextItemSchema>;

export const MAX_TEXT_ITEMS = 20_000;
export const MAX_GEOMETRY_ITEMS = 20_000;

const uniqueAndReasoned = (items: ReadonlyArray<{ id: string; level: string; reasons: readonly string[] }>, path: string, ctx: z.RefinementCtx, seen = new Set<string>()) => {
  items.forEach((it, i) => {
    if (seen.has(it.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path, i, 'id'], message: 'duplicate id' });
    seen.add(it.id);
    if (it.level !== 'green' && it.reasons.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path, i, 'reasons'], message: 'a non-green item needs at least one reason' });
  });
};

export const TextItemsArtifactSchema = z
  .object({
    schema: z.literal(TEXT_ITEMS_SCHEMA),
    sheetId: z.string().max(128).optional(),
    discipline: nn(z.string().max(40)),
    catalogVersion: z.number().int().nonnegative().optional(),
    items: z.array(TextItemSchema).max(MAX_TEXT_ITEMS),
    stats: z.record(z.unknown()).optional(),
  })
  .passthrough()
  .superRefine((a, ctx) => uniqueAndReasoned(a.items, 'items', ctx));
export type TextItemsArtifact = z.infer<typeof TextItemsArtifactSchema>;

// ---------------------------------------------------------------------------
// geometry.json.gz — kamutan.geometry/1 (Worker-Geometry; shape as published in workers/drawing/NOTES.md "Sprint 6 —
// Worker-Geometry"). Lenient (passthrough); ids unique across all collections of the file.
// ---------------------------------------------------------------------------

/** Shape collections; also the `source` of `area_item` / `length_item` rules (hatch = regions + ceilings, wall_run =
 * wallRuns, polyline = lines, stair = stairs, room = courtyards / rooms). */
export const GEOMETRY_SOURCES = ['hatch', 'room', 'wall_run', 'polyline', 'stair'] as const;
export const GeometrySourceSchema = z.enum(GEOMETRY_SOURCES);
export type GeometrySource = z.infer<typeof GeometrySourceSchema>;

/** Open lower-case code (`[a-z][a-z0-9_]{0,39}`): a region category, wall-run kind or line kind. */
export const GeometryCategorySchema = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'invalid geometry category');
/** Region categories / wall-run kinds / line kinds Worker-Geometry emits. */
export const GEOMETRY_CATEGORIES = [
  'gypsum', 'block', 'concrete', 'demolished', 'waterproofing', 'ceiling', 'valance', 'closure', 'cladding', 'unknown',
  'block_new', 'gypsum_single', 'gypsum_double', 'concrete_retaining', 'low_wall',
  'valance_curtain', 'valance_ventilator', 'cistern_screen', 'window_closure', 'gypsum_ceiling',
] as const;
/** Semantic measure keys of `measures[].key` (never item codes); `area_item` / `length_item` / estimates select on them. */
export const GEOMETRY_MEASURE_KEYS = [
  'stair_treads', 'retaining_wall_area', 'courtyard_wall_area', 'courtyard_floor_area', 'courtyard_waterproofing',
  'block_wall_area', 'gypsum_partition_area', 'gypsum_double_partition_area', 'gypsum_ceiling_area',
  'valance_ventilator_length', 'valance_curtain_length', 'window_closure_area', 'plaster_new_walls_area',
  'kitchen_backsplash_area', 'wc_partial_cladding_area', 'demolished_wall_area',
  // Sprint 6 follow-up (Worker-Geometry): emitted instead of / next to the keys above
  'demolished_wall_length', 'valance_length',
] as const;
export const GeometryMeasureKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'invalid measure key');

const shapeBase = {
  floor: nn(FloorSchema),
  confidence: conf01,
  scoreRaw: z.number().finite().optional(),
  level: ConfidenceLevelSchema,
  reasons: ReasonsSchema,
  polygonMm: nn(z.array(PointMmSchema).max(20_000)),
  bboxMm: nn(BBoxMmSchema),
  label: nn(z.string().max(300)),
};
const lifecycle = nn(z.enum(['new', 'existing', 'demolish', 'unknown']));
const nnum = nn(z.number().finite());

export const StairSchema = z
  .object({ id: idWith('st_'), regionId: nn(z.string().max(128)), lifecycle, treads: z.number().int().min(0).max(200), risers: nn(z.number().int().min(0).max(200)), lines: z.number().int().nonnegative().optional(), numbered: z.boolean().optional(), numbers: nn(z.array(z.number().int()).max(200)), descending: z.boolean().optional(), widthM: nnum, goingM: nnum, runLengthM: nnum, roomId: nn(z.string().max(128)), key: z.string().max(200).optional(), ...shapeBase })
  .passthrough();
export const HatchRegionSchema = z
  .object({ id: idWith('hr_'), category: GeometryCategorySchema, pattern: nn(z.string().max(32)), color: nn(z.string().max(16)), lifecycle, areaM2: nnum, perimeterM: nnum, roomId: nn(z.string().max(128)), roomName: nn(z.string().max(100)), roomType: nn(z.string().max(32)), labelBboxMm: nn(BBoxMmSchema), labelSource: nn(z.string().max(16)), ...shapeBase })
  .passthrough();
export const WallRunSchema = z
  .object({ id: idWith('wr_'), kind: GeometryCategorySchema, closure: z.boolean().optional(), lifecycle, lengthM: nnum, thicknessM: nnum, heightM: nnum, heightSource: nn(z.string().max(16)), areaM2: nnum, roomIds: z.array(z.string().max(128)).max(32).optional(), regionId: nn(z.string().max(128)), ...shapeBase })
  .passthrough();
export const GeometryLineSchema = z
  .object({ id: idWith('ln_'), kind: GeometryCategorySchema, lengthM: nnum, heightM: nnum, polylineMm: nn(z.array(PointMmSchema).max(20_000)), roomId: nn(z.string().max(128)), roomType: nn(z.string().max(32)), ...shapeBase })
  .passthrough();
export const CeilingSchema = z
  .object({ id: idWith('cl_'), kind: GeometryCategorySchema, areaM2: nnum, roomId: nn(z.string().max(128)), ...shapeBase })
  .passthrough();
/** One face of a courtyard (`opening`: a building face with a new door / window opening). */
export const CourtyardFaceSchema = z
  .object({ kind: z.string().max(32), lengthM: nnum, aMm: nn(PointMmSchema), bMm: nn(PointMmSchema), opening: z.boolean().optional() })
  .passthrough();
export const CourtyardSchema = z
  .object({ id: idWith('cy_'), floorAreaM2: nnum, stairId: nn(z.string().max(128)), wallRunIds: z.array(z.string().max(128)).max(256).optional(), wallLengthM: nnum, wallHeightM: nnum, wallAreaM2: nnum, waterproofing: z.boolean().optional(), faces: z.array(CourtyardFaceSchema).max(256).optional(), ...shapeBase })
  .passthrough();
/** A semantic quantity of the sheet (`key`), computable or with an estimate / a user-facing reason. */
export const GeometryMeasureSchema = z
  .object({
    key: GeometryMeasureKeySchema,
    unit: z.string().max(32),
    qty: nnum,
    computable: z.boolean(),
    reason: nn(z.string().max(300)),
    estimate: nn(
      z
        .object({ qty: z.number().finite(), method: z.string().max(300), widthM: nnum, courtyardM2: nnum, blockM2: nnum })
        .passthrough(),
    ),
    floor: nn(FloorSchema),
    refs: z.array(z.string().max(128)).max(1000).optional(),
    level: ConfidenceLevelSchema,
    reasons: ReasonsSchema,
  })
  .passthrough();
export type GeometryMeasure = z.infer<typeof GeometryMeasureSchema>;

export const GeometryArtifactSchema = z
  .object({
    schema: z.literal(GEOMETRY_SCHEMA),
    sheetId: z.string().max(128).optional(),
    discipline: nn(z.string().max(40)),
    scaleDenominator: nn(z.number().positive().max(100_000)),
    heights: z.array(z.record(z.unknown())).max(64).optional(),
    levels: z.array(z.record(z.unknown())).max(1000).optional(),
    stairs: z.array(StairSchema).max(MAX_GEOMETRY_ITEMS).default([]),
    regions: z.array(HatchRegionSchema).max(MAX_GEOMETRY_ITEMS).default([]),
    wallRuns: z.array(WallRunSchema).max(MAX_GEOMETRY_ITEMS).default([]),
    lines: z.array(GeometryLineSchema).max(MAX_GEOMETRY_ITEMS).default([]),
    ceilings: z.array(CeilingSchema).max(MAX_GEOMETRY_ITEMS).default([]),
    courtyards: z.array(CourtyardSchema).max(MAX_GEOMETRY_ITEMS).default([]),
    measures: z.array(GeometryMeasureSchema).max(1000).default([]),
    stats: z.record(z.unknown()).optional(),
  })
  .passthrough()
  .superRefine((a, ctx) => {
    const seen = new Set<string>();
    for (const k of ['stairs', 'regions', 'wallRuns', 'lines', 'ceilings', 'courtyards'] as const) uniqueAndReasoned(a[k], k, ctx, seen);
  });
export type GeometryArtifact = z.infer<typeof GeometryArtifactSchema>;
