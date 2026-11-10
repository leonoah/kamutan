/**
 * Sprint 3 — org item library, BOQ templates, BOQ rules and past-BOQ imports (docs/agents/SPRINT3_BRIEF.md).
 *
 * Firestore (under orgs/{orgId}), all API/worker-written, member-readable:
 *  - itemLibrary/{itemId}       ItemLibraryItem  (itemId = `itemIdFor(code, description)`)
 *  - boqTemplates/{templateId}  BoqTemplate      (default `tpl_default`, seeded from the sample BOQ)
 *  - boqRules/{ruleId}          BoqRule          (default set seeded from the domain rules, `DEFAULT_BOQ_RULES`)
 *  - libraryImports/{importId}  LibraryImport    (importId = UUID of the uploaded object)
 * Storage: orgs/{orgId}/imports/{importId}.{xls|xlsx} — client create-only upload slot, verified by the API.
 */
import { z } from 'zod';
import { pageOf, TimestampSchema } from './common.js';
import { ChapterCodeSchema, ItemCodeSchema, LIFECYCLES, LinkGroupKindSchema, QuickActionKindSchema, SUPPLY_KINDS } from './boq.js';
import { DocIdSchema, UidSchema } from './org.js';
import { JobProgressSchema, JobStatusSchema, LIBRARY_IMPORT_KINDS } from './jobs.js';
import { sha256Hex } from './sha256.js';
import { DisciplineSchema, ProcessingErrorSchema } from './sheets.js';
import { SymbolClassSchema, type SymbolClass } from './taxonomy.js';
import { GeometryCategorySchema, GeometryMeasureKeySchema, GeometrySourceSchema, TextPatternSchema } from './takeoff.js';
import { RoomTypeSchema, type RoomType } from './understanding.js';
import { ItemPriceSchema, LibraryImportModeSchema, PriceAmountSchema, PriceImportReportSchema } from './prices.js';

// ---------------------------------------------------------------------------
// Item library
// ---------------------------------------------------------------------------

/** NFC, every whitespace run (incl. NBSP) → one space, trimmed. */
export const normalizeDescription = (s: string): string => s.normalize('NFC').replace(/[\s ‏‎]+/g, ' ').trim();

/**
 * Deterministic itemLibrary doc id (Python must produce the same):
 * `it_` + code with every char outside [A-Za-z0-9_-] replaced by "-" + `_` +
 * first 16 hex chars of sha256(utf8(code + "\n" + normalizeDescription(description))).
 * e.g. ("4.10", "נק' מאור בעלת שני מפסקים מחליפים") → `it_4-10_<16 hex>`.
 */
export function itemIdFor(code: string, description: string): string {
  const slug = code.trim().replace(/[^A-Za-z0-9_-]/g, '-');
  return `it_${slug}_${sha256Hex(`${code.trim()}\n${normalizeDescription(description)}`).slice(0, 16)}`;
}

/** Stage 10: `default` = seeded from the shipped `DEFAULT_ITEM_LIBRARY` (an import / manual item of the same code wins). */
export const ITEM_SOURCES = ['import', 'manual', 'default'] as const;

const TagsSchema = z.array(z.string().trim().min(1).max(64)).max(32);

/** orgs/{orgId}/itemLibrary/{itemId}. */
export const ItemLibraryItemSchema = z.object({
  id: DocIdSchema,
  code: ItemCodeSchema,
  chapter: ChapterCodeSchema,
  chapterTitle: z.string().max(200),
  description: z.string().min(1).max(2000),
  unit: z.string().min(1).max(32),
  tags: TagsSchema,
  source: z.enum(ITEM_SOURCES),
  /** Import id / file reference for imported items; null for manual ones. */
  sourceRef: z.string().max(256).nullable().optional(),
  active: z.boolean(),
  updatedAt: TimestampSchema.nullable(),
  updatedBy: UidSchema.nullable().optional(),
  /** Stage 10: `DEFAULT_ITEM_LIBRARY_VERSION` of a seeded default item (absent on imported / manual items). */
  defaultsVersion: z.number().int().positive().optional(),
  /** Sprint 8: the org's unit price of the item (₪). Absent / null = no price ("ללא מחיר"). */
  price: ItemPriceSchema.nullable().optional(),
  /**
   * Sprint 10 (Worker-BOQ import): the client's line was cancelled (unit "בוטל" in the imported BOQ). The item stays in
   * the library (history, prices) but never produces a BOQ line and is never resolved by a rule.
   */
  cancelled: z.boolean().optional(),
  /**
   * Sprint 10: a "לא לסיכום / לספירה בסוף / אופציה" line of the client's BOQ — a unit price only (qty placeholder). A
   * BOQ line resolved to it carries `notForTotal: true` and is never counted in the totals.
   */
  notForTotal: z.boolean().optional(),
  /**
   * Sprint 10: identity of the description across imports (`descKey`: normalised tokens + parameters, worker-computed)
   * and the other codes the same description carried in other imported BOQs (codes drift between projects: the same
   * description in two BOQs is ONE item; a rule or user code matching an alias resolves to it).
   */
  descKey: z.string().max(512).optional(),
  codeAliases: z.array(ItemCodeSchema).max(16).optional(),
});
export type ItemLibraryItem = z.infer<typeof ItemLibraryItemSchema>;

const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');

export const ListLibraryItemsQuerySchema = z.object({
  orgId: DocIdSchema,
  chapter: ChapterCodeSchema.optional(),
  active: boolQuery.optional(),
  /** Case-insensitive substring of code or description. */
  q: z.string().trim().min(1).max(100).optional(),
  /** Sprint 8: only items with (`true`) / without (`false`) a price. */
  priced: boolQuery.optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type ListLibraryItemsQuery = z.infer<typeof ListLibraryItemsQuerySchema>;

export const LibraryItemPageSchema = pageOf(ItemLibraryItemSchema);
export type LibraryItemPage = z.infer<typeof LibraryItemPageSchema>;

export const CreateLibraryItemRequestSchema = z
  .object({
    orgId: DocIdSchema,
    code: ItemCodeSchema,
    chapter: ChapterCodeSchema,
    chapterTitle: z.string().trim().max(200).optional(),
    description: z.string().trim().min(1).max(2000),
    unit: z.string().trim().min(1).max(32),
    tags: TagsSchema.optional(),
  })
  .strict();
export type CreateLibraryItemRequest = z.infer<typeof CreateLibraryItemRequestSchema>;

/** code + description are the identity (itemIdFor) and cannot change: create a new item and deactivate the old one. */
export const PatchLibraryItemRequestSchema = z
  .object({
    unit: z.string().trim().min(1).max(32).optional(),
    chapterTitle: z.string().trim().max(200).optional(),
    tags: TagsSchema.optional(),
    active: z.boolean().optional(),
    /** Sprint 8 (editor+, audited): unit price in ₪ (`source: 'manual'`); null removes the price. */
    price: PriceAmountSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });
export type PatchLibraryItemRequest = z.infer<typeof PatchLibraryItemRequestSchema>;

/** Org scope of PATCH /v1/library/items/:itemId and the template/rule routes (`?orgId=`). */
export const OrgScopeQuerySchema = z.object({ orgId: DocIdSchema });
export type OrgScopeQuery = z.infer<typeof OrgScopeQuerySchema>;

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const BOQ_TEMPLATE_COLUMN_KEYS = ['code', 'description', 'unit', 'qty', 'unitPrice', 'total'] as const;
export const BoqTemplateColumnKeySchema = z.enum(BOQ_TEMPLATE_COLUMN_KEYS);
export type BoqTemplateColumnKey = z.infer<typeof BoqTemplateColumnKeySchema>;

export const BoqTemplateChapterSchema = z
  .object({
    /** "04" — matched against BoqLine.chapter with `chapterKey`. */
    code: ChapterCodeSchema,
    /** Header row text exactly as in the client's file, e.g. "פרק 04 – עבודות חשמל". */
    title: z.string().min(1).max(200),
    /** Numbered chapter notes ("הערות פרק"). */
    notes: z.array(z.string().max(2000)).max(50),
    /**
     * Item-code majors that belong to this chapter even when a line's `chapter` differs (the sample numbers
     * "פרק 08- שונות" but its codes are 9.xx). Optional.
     */
    codePrefixes: z.array(z.string().regex(/^[0-9A-Za-z]{1,8}$/)).max(8).optional(),
  })
  .strict();
export type BoqTemplateChapter = z.infer<typeof BoqTemplateChapterSchema>;

export const BoqTemplateColumnSchema = z
  .object({ key: BoqTemplateColumnKeySchema, title: z.string().min(1).max(64), width: z.number().min(4).max(120).optional() })
  .strict();
export type BoqTemplateColumn = z.infer<typeof BoqTemplateColumnSchema>;

const ColumnsSchema = z
  .array(BoqTemplateColumnSchema)
  .min(1)
  .max(BOQ_TEMPLATE_COLUMN_KEYS.length)
  .refine((cols) => new Set(cols.map((c) => c.key)).size === cols.length, { message: 'duplicate column key' })
  .refine((cols) => cols.some((c) => c.key === 'code') && cols.some((c) => c.key === 'qty'), { message: 'code and qty columns are required' });

const ChaptersSchema = z
  .array(BoqTemplateChapterSchema)
  .max(60)
  .refine((ch) => new Set(ch.map((c) => c.code.replace(/^0+(?=\w)/, '').toLowerCase())).size === ch.length, { message: 'duplicate chapter code' });

/** `{projectName}`, `{date}` (dd.mm.yyyy) and `{orgName}` are substituted in title rows. */
const TitleRowsSchema = z.array(z.string().max(500)).max(10);

export const TEMPLATE_SOURCES = ['default', 'import', 'manual'] as const;

/** orgs/{orgId}/boqTemplates/{templateId}. */
export const BoqTemplateSchema = z.object({
  id: DocIdSchema,
  name: z.string().min(1).max(200),
  chapters: ChaptersSchema,
  columns: ColumnsSchema,
  titleRows: TitleRowsSchema,
  default: z.boolean(),
  source: z.enum(TEMPLATE_SOURCES),
  sourceRef: z.string().max(256).nullable().optional(),
  /** VAT rate of the "כולל מע"מ" grand total (0.18 = 18%). */
  vatRate: z.number().min(0).max(1),
  updatedAt: TimestampSchema.nullable(),
  updatedBy: UidSchema.nullable().optional(),
  /** Stage 10: `DEFAULT_BOQ_TEMPLATE_VERSION` of a seeded default template (absent on Sprint-3 seeds and imports). */
  defaultsVersion: z.number().int().positive().optional(),
});
export type BoqTemplate = z.infer<typeof BoqTemplateSchema>;

export const BoqTemplateListSchema = z.object({ items: z.array(BoqTemplateSchema) });
export type BoqTemplateList = z.infer<typeof BoqTemplateListSchema>;

/** PATCH /v1/boq-templates/:id (admin). `default: true` makes it the org default (others are unset). */
export const PatchBoqTemplateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    chapters: ChaptersSchema.optional(),
    columns: ColumnsSchema.optional(),
    titleRows: TitleRowsSchema.optional(),
    default: z.literal(true).optional(),
    vatRate: z.number().min(0).max(1).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });
export type PatchBoqTemplateRequest = z.infer<typeof PatchBoqTemplateRequestSchema>;

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export const BOQ_RULE_KINDS = [
  'class_to_item',
  'composite_lighting',
  'install_count',
  'authority',
  // Sprint 4
  'plumbing_point',
  'tiling_floor',
  'tiling_cladding',
  'tiling_corner',
  'waterproofing',
  'one_off_suggestion',
  // Stage 10 (Worker-BOQ, A-pipeline-07 / A-pipeline-12)
  'template_chapter',
  'fixture_combination',
  // Sprint 6 (Worker-BOQ; text_items.json.gz / geometry.json.gz)
  'text_item',
  'area_item',
  'length_item',
  'suggested_item',
  // Sprint 10 (Worker-BOQ / Worker-Lighting)
  'marker_addon',
  'lighting_circuit',
] as const;
export const BoqRuleKindSchema = z.enum(BOQ_RULE_KINDS);
export type BoqRuleKind = z.infer<typeof BoqRuleKindSchema>;

const ClassesSchema = z.array(SymbolClassSchema).min(1).max(32);

/**
 * Every detection of one of `classes` counts 1 toward the rule's item.
 * Sprint 10 (optional): the detection's *label* — its annotations, its legend entry's label and the text lines within
 * `labelRadiusMm` paper mm (default 10), normalised like `normalizeHebrewText` — must match one of `labelPatterns` and
 * none of `excludeLabelPatterns` ("הזנה לתריס", "שקע תלת פאזי למזגן", "לוח משני"); rules are tried by priority and the
 * first whose label matches takes the detection (a bare class rule of lower priority is the fallback). `countOnly`:
 * the detection is counted but NOT consumed — another rule still counts it (one deep box per switch while the switch
 * still builds its lighting point). `params.length` / `params.diameter` = "label": the length / diameter written next
 * to the symbol (else the drawn run length) is passed to the item resolution, which picks the library item whose
 * stated bucket fits ("קוברה 50 מ"מ באורך עד 6 מטר"). A DEFAULT rule whose item the org's library lacks is skipped.
 */
export const ClassToItemMatchSchema = z
  .object({
    classes: ClassesSchema,
    labelPatterns: z.array(TextPatternSchema).min(1).max(16).optional(),
    excludeLabelPatterns: z.array(TextPatternSchema).max(16).optional(),
    labelRadiusMm: z.number().finite().positive().max(100).optional(),
    countOnly: z.boolean().optional(),
    params: z.object({ length: z.literal('label').optional(), diameter: z.literal('label').optional() }).strict().optional(),
  })
  .strict();

/**
 * A switch↔luminaire link group (kamutan.links/1) of `groupKind` (and, when given, exactly `pointCount` points /
 * `switchCount` switches) is one unit of the item. `pointMergeMm`: luminaires within this distance connected by a
 * wire are one point.
 */
export const CompositeLightingMatchSchema = z
  .object({
    groupKind: LinkGroupKindSchema,
    pointCount: z.number().int().min(1).max(16).optional(),
    switchCount: z.number().int().min(0).max(8).optional(),
    /** add_to_existing: which switch class was added (switch_2way → 4.12, switch_fan → 4.14). */
    switchClasses: z.array(SymbolClassSchema).max(8).optional(),
    pointMergeMm: z.number().min(0).max(5000).optional(),
  })
  .strict();

/** Count of luminaire positions (lighting install line), minus the excluded classes / supply / lifecycle. */
export const InstallCountMatchSchema = z
  .object({
    classes: ClassesSchema,
    excludeClasses: z.array(SymbolClassSchema).max(32),
    excludeSupply: z.array(z.enum(SUPPLY_KINDS)).max(3),
    excludeLifecycle: z.array(z.enum(LIFECYCLES)).max(3),
  })
  .strict();

/** Cross-sheet de-dup: for `classes` (a family), detections from sheets of `discipline` win; others within `radiusMm` are duplicates. */
export const AuthorityMatchSchema = z
  .object({
    family: z.string().min(1).max(32),
    classes: ClassesSchema,
    discipline: DisciplineSchema,
    radiusMm: z.number().min(0).max(5000),
    /**
     * v5: per floor, the first discipline of this list that has a sheet on the floor is the authority (overrides
     * `discipline`); e.g. AC: plumbing drain marks, electrical AC sockets only on floors without a plumbing sheet.
     */
    authorityOrder: z.array(DisciplineSchema).min(1).max(8).optional(),
    /**
     * v5: secondary items are placed by the sheets' room-outline alignment and matched one-to-one — same room first,
     * else within `roomMatchRadiusMm` (real mm); unmatched secondary items are kept (yellow).
     */
    matchRooms: z.boolean().optional(),
    roomMatchRadiusMm: z.number().min(0).max(5000).optional(),
  })
  .strict();

// --- Sprint 4: plumbing + tiling -------------------------------------------------------------------------------

const RoomTypesSchema = z.array(RoomTypeSchema).max(16);
const RoomNamePatternsSchema = z.array(z.string().trim().min(1).max(40)).max(8);
const FloorsFilterSchema = z.array(z.string().min(1).max(32)).max(16);

/**
 * One unit per fixture (`perRoom: false`) or per room that contains ≥ 1 matching fixture (`perRoom: true`, e.g.
 * shower / bath per bathroom). Faucet filters look for a detection of one of the faucet classes within
 * `faucetRadiusMm` of the fixture (3.02 basin + wall faucet vs 3.03 basin + flower faucet). Optional filters: room
 * types, room-name substrings ("הורים"), floors. Higher priority wins when several rules match the same fixture.
 */
export const PlumbingPointMatchSchema = z
  .object({
    fixtureClasses: ClassesSchema,
    withFaucetClasses: z.array(SymbolClassSchema).max(8).optional(),
    withoutFaucetClasses: z.array(SymbolClassSchema).max(8).optional(),
    faucetRadiusMm: z.number().min(0).max(3000).optional(),
    roomTypes: RoomTypesSchema.optional(),
    roomNamePatterns: RoomNamePatternsSchema.optional(),
    floors: FloorsFilterSchema.optional(),
    perRoom: z.boolean(),
    /** Sprint 10: label of the fixture (as in `ClassToItemMatch`): "אינטרפוץ 4 דרך", "3x", "מטבח חוץ" pick the variant. */
    labelPatterns: z.array(TextPatternSchema).min(1).max(16).optional(),
    excludeLabelPatterns: z.array(TextPatternSchema).max(16).optional(),
    labelRadiusMm: z.number().finite().positive().max(100).optional(),
  })
  .strict();

/**
 * Floor area (m²) of rooms whose room settings say `floorTiled` (defaults by type); optional type filter.
 * `includeNiches` (v4): niches inside / attached to a matching room (washing-machine alcove) count with it.
 */
export const TilingFloorMatchSchema = z.object({ roomTypes: RoomTypesSchema.optional(), wetOnly: z.boolean(), includeNiches: z.boolean().optional() }).strict();

/**
 * Wall cladding (m²). `full`: perimeter × H − openings, H = settings.claddingHeightM (capped at the room's
 * `ceilingHeightM` when known and `capAtCeiling`). Openings (not in settings.keepOpenings) subtract
 * width × clipped height: doors [0, `defaultDoorHeightM`] (when the drawing has no height), windows
 * [`defaultWindowSillM`, `defaultWindowHeadM`] ∩ [0, H] (legacy `defaultWindowHeightM` = head − sill when only that is
 * given). `excludeNiches`: niche rooms / walls are not clad. `partial`: Σ settings.partialCladding (toM − fromM) × heightM.
 */
export const TilingCladdingMatchSchema = z
  .object({
    roomTypes: RoomTypesSchema.optional(),
    mode: z.enum(['full', 'partial']),
    subtractOpenings: z.boolean(),
    defaultDoorHeightM: z.number().min(0).max(4).optional(),
    /** @deprecated v3; use defaultWindowSillM + defaultWindowHeadM. */
    defaultWindowHeightM: z.number().min(0).max(4).optional(),
    defaultWindowSillM: z.number().min(0).max(4).optional(),
    defaultWindowHeadM: z.number().min(0).max(4).optional(),
    capAtCeiling: z.boolean().optional(),
    excludeNiches: z.boolean().optional(),
  })
  .strict();

/** External corner trim (m') = room.externalCorners × the room's effective cladding height (rooms with full cladding). */
export const TilingCornerMatchSchema = z.object({ roomTypes: RoomTypesSchema.optional() }).strict();

/**
 * One unit (קומפלט) per room with settings.includeInWaterproofing. v4: `requireFixtureClasses` — the default only
 * includes rooms containing a detection of one of these classes (shower / bath); an explicit room setting wins.
 */
export const WaterproofingMatchSchema = z
  .object({ roomTypes: RoomTypesSchema.optional(), wetOnly: z.boolean(), requireFixtureClasses: z.array(SymbolClassSchema).max(8).optional() })
  .strict();

/**
 * One-off items (new water feed, manifold, pumps…) suggested from the drawing / notes. A line is produced with
 * `quantity` when ANY trigger fires (or always with `always: true`); the line is NEVER green (max yellow, reason
 * "הצעה – לאשר ידנית") until a reviewer accepts it.
 */
export const OneOffSuggestionMatchSchema = z
  .object({
    always: z.boolean().optional(),
    classes: z.array(SymbolClassSchema).max(32).optional(),
    /** Plain substrings searched in the sheet OCR text / notes (no regex). */
    textPatterns: z.array(z.string().trim().min(2).max(40)).max(16).optional(),
    roomTypes: RoomTypesSchema.optional(),
    floors: FloorsFilterSchema.optional(),
    quantity: z.number().finite().positive().max(1000),
  })
  .strict();

/**
 * Stage 10 (A-pipeline-07): when the project has a current ready sheet of one of `disciplines` (absent = always), every
 * active library item of `chapters` (item.chapter, else the template chapter's codePrefixes) that no other rule produced
 * becomes a line of `quantity` in the item's unit (else the rule's), never green, with the rule reasons; evidence = one
 * whole-sheet item per triggering sheet (`detectionId: "sheet"`). `itemCode` must be null.
 */
export const TemplateChapterMatchSchema = z
  .object({
    chapters: z.array(ChapterCodeSchema).min(1).max(16),
    disciplines: z.array(DisciplineSchema).max(8).optional(),
    /** Sprint 10: absent = "להשלמה ידנית" (needsInput, qty 0, the item's own unit). */
    quantity: z.number().finite().positive().max(1000).optional(),
    excludeCodes: z.array(ItemCodeSchema).max(64).optional(),
    /** Sprint 10: only the org's imported items (`source: 'import'`), never a `notForTotal` one. */
    importedOnly: z.boolean().optional(),
  })
  .strict();

/**
 * Stage 10 (A-pipeline-12): one unit of `itemCode` per complete set of fixtures — one live detection of each class, in
 * the same room of its sheet when `sameRoom`, all within `radiusMm` (real-world mm, like the other rule radii; default 1500) of the first class. The
 * members are consumed (not counted again by plumbing_point / class_to_item); incomplete sets fall through.
 */
export const FixtureCombinationMatchSchema = z
  .object({
    classes: z
      .array(SymbolClassSchema)
      .min(2)
      .max(4)
      .refine((c) => new Set(c).size === c.length, { message: 'classes must be distinct' }),
    sameRoom: z.boolean(),
    radiusMm: z.number().finite().min(0).max(5000).optional(),
    floors: FloorsFilterSchema.optional(),
    roomTypes: RoomTypesSchema.optional(),
    roomNamePatterns: RoomNamePatternsSchema.optional(),
  })
  .strict();

// --- Sprint 6: text / geometry / suggested items ----------------------------------------------------------------

/** Text scopes a `text_item` rule searches (`any` = every TextItemScope except `title`). */
export const TEXT_RULE_SCOPES = ['legend', 'note', 'callout', 'panel_schedule', 'any'] as const;
export const TextRuleScopeSchema = z.enum(TEXT_RULE_SCOPES);
/**
 * How a matched text becomes a quantity: `count` = 1 per matched text item (de-duplicated within `proximityMm`), or the
 * count written in it ("3 שקעים" → 3) when the pattern has a capture group 1 with a number; `number_in_text` = the
 * first number of capture group 1 (else the text item's first number); `length_in_text_m` = the first length in metres
 * (`lengthsM[0]`, else capture group 1); `one` = 1 for the whole project when any text matches (קומפלט / single items).
 */
export const TEXT_QTY_MODES = ['count', 'number_in_text', 'length_in_text_m', 'one'] as const;

const PatternsSchema = z.array(TextPatternSchema).min(1).max(16);

/**
 * Sprint 6: one evidence per matched text item of text_items.json.gz (evidence kind `text`, `detectionId` = the
 * `ti_…` id, `bboxMm` = its box). Matching is on `normalizeHebrewText` of BOTH pattern and text (final letters,
 * geresh / gershayim, quotes, spacing), case-insensitive; ANY pattern matches and NO `excludePatterns` may match.
 * Optional filters: sheet disciplines, floors, the text's lifecycle qualifier ("קיים" / "חדש"), and `nearClasses` (a
 * live detection of one of the classes within `proximityMm` paper mm of the text's anchor / box — then the text is
 * attached to it and that detection is NOT also counted by a class rule when `consumeNear`). `proximityMm` also merges
 * repeated texts (same rule) closer than it into one. Origin of the line: `text`.
 * v7: `consumeNear` consumes only a detection within `CONSUME_NEAR_MAX_MM` (8 paper mm) of the text — `proximityMm`
 * stays the `nearClasses` filter (an electric and a comms label 17 mm from one panel symbol: the symbol stays 4.24).
 */
export const CONSUME_NEAR_MAX_MM = 8;
export const TextItemMatchSchema = z
  .object({
    patterns: PatternsSchema,
    excludePatterns: z.array(TextPatternSchema).max(16).optional(),
    scope: TextRuleScopeSchema,
    disciplines: z.array(DisciplineSchema).max(8).optional(),
    qty: z.enum(TEXT_QTY_MODES),
    proximityMm: z.number().finite().min(0).max(5000).optional(),
    nearClasses: z.array(SymbolClassSchema).max(16).optional(),
    consumeNear: z.boolean().optional(),
    lifecycle: z.array(z.enum(LIFECYCLES)).max(3).optional(),
    floors: FloorsFilterSchema.optional(),
    /**
     * Also match text items whose Worker-Text catalog `itemCode` equals the rule's itemCode (default true): the rule's
     * patterns then only ADD matches (e.g. an org's own wording). Items with `corroborates: true` are evidence only.
     */
    matchCatalogCode: z.boolean().optional(),
  })
  .strict();
export type TextItemMatch = z.infer<typeof TextItemMatchSchema>;

/** What a geometry rule measures. Defaults: hatch / room / polyline → area (area_item) or length (length_item); wall_run → wall_area / length; stair → treads. */
export const GEOMETRY_MEASURES = ['area', 'length', 'wall_area', 'count', 'treads'] as const;
/** Height convention of partition measures (`GeometryItemMatch.heightMode`): `storey` = floor to ceiling of the storey,
 * `drawn` = each element's own (drawn, else assumed) height. */
export const GEOMETRY_HEIGHT_MODES = ['storey', 'drawn'] as const;

/**
 * Sprint 6 (`area_item` m² / `length_item` m' / count): features of geometry.json.gz of `source` (shape kind), of one of
 * `categories` (when given) AND whose legend label matches one of `legendPatterns` (when given), filtered by sheet disciplines, floors, room types
 * (any of the feature's rooms), lifecycle; quantity per feature by `measure` (`wall_area` = wallAreaM2, else lengthM ×
 * (`heightM` of the rule, else the feature's) × `sides`; `count` = feature.count ?? 1; `treads` = stair.treads);
 * features below `minQty` are ignored. One evidence per feature (kind `geometry`, or `stair`, with `geometryMm`).
 * Origin of the line: `geometry`.
 */
export const GeometryItemMatchSchema = z
  .object({
    source: GeometrySourceSchema,
    /**
     * Worker-Geometry `measures[].key`s (GEOMETRY_MEASURE_KEYS): when given, the quantity is the project-level measure of
     * those keys (`geometry_units`: one authoritative sheet per floor, stairs de-duplicated) — the preferred selector.
     * v7 (coordinator decision): a `computable: false` measure → a suggested line, `needsInput`, qty 0, red, reasons =
     * the measure's reason + its estimate as a hint ("הערכה: …"), never a yellow quantity; a key no sheet carries →
     * nothing (the code's `suggested_item` fallback takes over).
     */
    keys: z.array(GeometryMeasureKeySchema).max(8).optional(),
    categories: z.array(GeometryCategorySchema).max(16).optional(),
    legendPatterns: z.array(TextPatternSchema).max(8).optional(),
    disciplines: z.array(DisciplineSchema).max(8).optional(),
    floors: FloorsFilterSchema.optional(),
    roomTypes: RoomTypesSchema.optional(),
    lifecycle: z.array(z.enum(LIFECYCLES)).max(3).optional(),
    measure: z.enum(GEOMETRY_MEASURES).optional(),
    heightM: z.number().finite().positive().max(30).optional(),
    sides: z.union([z.literal(1), z.literal(2)]).optional(),
    minQty: z.number().finite().min(0).max(100_000).optional(),
    /**
     * Partition convention of a `keys` selector on wall-run partition measures (`gypsum_partition_area`,
     * `gypsum_double_partition_area`; owner decision 05.11 for 7.06). `faces: 2` counts both faces of a free-standing
     * partition — a lining (one face against an existing / masonry wall, wall run `lining: true`) always counts one;
     * `heightMode: 'storey'` measures storey-high partitions at the storey's floor-to-ceiling height (a low wall /
     * partial-height element keeps its drawn height), `'drawn'` keeps each element's own height (drawn, else assumed
     * and flagged). Both absent = the measure as produced (one face, drawn or assumed height). Each element's m² and
     * reason go on its evidence item (`quantity`, `reason`).
     */
    faces: z.union([z.literal(1), z.literal(2)]).optional(),
    heightMode: z.enum(GEOMETRY_HEIGHT_MODES).optional(),
  })
  .strict()
  .refine((m) => (m.keys?.length ?? 0) > 0 || (m.categories?.length ?? 0) > 0 || (m.legendPatterns?.length ?? 0) > 0 || m.source === 'stair', {
    message: 'keys, categories or legendPatterns are required (except for stairs)',
    path: ['categories'],
  });
export type GeometryItemMatch = z.infer<typeof GeometryItemMatchSchema>;

/** What makes a suggested line appear. */
export const SuggestedTriggerSchema = z.discriminatedUnion('kind', [
  /** The project has a current ready sheet of one of the disciplines. */
  z.object({ kind: z.literal('sheet_discipline'), disciplines: z.array(DisciplineSchema).min(1).max(8) }).strict(),
  /** A text item matches (same matching as `text_item`). */
  z.object({ kind: z.literal('text'), patterns: PatternsSchema, scope: TextRuleScopeSchema.optional(), disciplines: z.array(DisciplineSchema).max(8).optional() }).strict(),
  /** The project has demolition: a `demolition` sheet, or geometry of one of `categories` (default wall_demolished) / detections with lifecycle demolish. */
  z.object({ kind: z.literal('demolition'), categories: z.array(GeometryCategorySchema).max(16).optional() }).strict(),
  z.object({ kind: z.literal('always') }).strict(),
]);
export type SuggestedTrigger = z.infer<typeof SuggestedTriggerSchema>;

/** Simple estimator of a suggested line (null / absent = no estimate → `needsInput`, qty 0, red). */
export const SuggestedEstimateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixed'), quantity: z.number().finite().positive().max(100_000) }).strict(),
  /** Same selection as an area_item / length_item rule, COMPUTABLE measures only (v7); the line stays a suggestion (yellow) when it yields > 0. */
  z.object({ kind: z.literal('geometry'), match: GeometryItemMatchSchema }).strict(),
  /** Σ floor area (m²) of rooms of `roomTypes` (all rooms when absent) on `floors`. */
  z.object({ kind: z.literal('room_area'), roomTypes: RoomTypesSchema.optional(), floors: FloorsFilterSchema.optional() }).strict(),
]);
export type SuggestedEstimate = z.infer<typeof SuggestedEstimateSchema>;

/**
 * Sprint 6: an item the drawings imply but do not quantify. When the trigger fires, ONE line of `itemCode` with
 * `origin: 'suggested'`, the rule's `reason` (+ rule reasons), `quickAction` (default by unit, `defaultQuickActionFor`)
 * and evidence = what fired (text item / sheet / geometry). Quantity = the estimate (level yellow, max) or, without an
 * estimate, `needsInput: true` + qty 0 (level red, "להשלמה ידנית"). Never green until a person confirms / measures it
 * (quick-measure corrections bound to the line replace the estimate). Not produced when another rule produced the code.
 */
export const SuggestedItemMatchSchema = z
  .object({
    trigger: SuggestedTriggerSchema,
    estimate: SuggestedEstimateSchema.nullable().optional(),
    reason: z.string().trim().min(1).max(200),
    quickAction: QuickActionKindSchema.optional(),
    level: z.enum(['yellow', 'red']).optional(),
  })
  .strict();
export type SuggestedItemMatch = z.infer<typeof SuggestedItemMatchSchema>;

/**
 * Sprint 10 (Worker-BOQ): an add-on line counted per HOST detection that carries a marker — a detection of
 * `markerClasses` within `radiusMm` paper mm (default 6), or a label (as in `ClassToItemMatch`) matching one of
 * `markerPatterns` ("מוגן מים", "IP44", "USB"). Hosts are never consumed (the socket is still a socket; the add-on is a
 * second line): "תוספת עבור אביזר מוגן מים" = waterproof sockets AND switches, "תוספת עבור שקע USB".
 */
export const MarkerAddonMatchSchema = z
  .object({
    hostClasses: ClassesSchema,
    markerClasses: z.array(SymbolClassSchema).max(8).optional(),
    markerPatterns: z.array(TextPatternSchema).max(16).optional(),
    radiusMm: z.number().finite().positive().max(100).optional(),
    /** A host inside a room of these types counts without a marker (the designer marks no waterproof symbol). */
    roomTypes: RoomTypesSchema.optional(),
  })
  .strict()
  .refine((m) => (m.markerClasses?.length ?? 0) > 0 || (m.markerPatterns?.length ?? 0) > 0 || (m.roomTypes?.length ?? 0) > 0, {
    message: 'markerClasses, markerPatterns or roomTypes is required',
    path: ['markerClasses'],
  });

/** Wording of the lighting-point lines: one line per switching topology, or "נק' מאור בודדה" + "סט: שירשור N". */
export const LIGHTING_WORDINGS = ['auto', 'topology', 'set'] as const;
/**
 * Sprint 10 (Worker-Lighting, `circuits.json.gz`): the "נק' מאור …" lines from the circuit tags. `wording: auto` takes
 * the org library's wording (per topology vs בודדה + סט שירשור); library items are matched structurally (fixtures,
 * switch positions, timer / stair words). `itemCode` is null (every topology has its own item). Sheets covered by the
 * circuits skip their composite link groups.
 */
export const LightingCircuitMatchSchema = z
  .object({
    wording: z.enum(LIGHTING_WORDINGS),
    includeTimer: z.boolean().optional(),
    includeNoSwitch: z.boolean().optional(),
  })
  .strict();

const ruleBase = {
  id: DocIdSchema,
  /** Target item (TEXT). null for authority rules. */
  itemCode: ItemCodeSchema.nullable(),
  /** Hebrew description hint used when the org library has no item with `itemCode`. */
  itemDescription: z.string().max(2000).nullable().optional(),
  unit: z.string().max(32).nullable().optional(),
  /** Higher wins when several rules match the same evidence. */
  priority: z.number().int().min(-1000).max(1000),
  enabled: z.boolean(),
  /** Rule reasons added to every line it produces (e.g. "שיוך לפריט לפי כלל ברירת מחדל"). */
  reasons: z.array(z.string().min(1).max(200)).max(8).optional(),
  /** `default` = shipped (re-seeded when DEFAULT_BOQ_RULES_VERSION grows); `user` = edited by an admin (never re-seeded); `custom` = created by the org. */
  source: z.enum(['default', 'user', 'custom']),
  /** DEFAULT_BOQ_RULES_VERSION the doc was seeded from (absent on pre-versioning docs = 0). */
  defaultsVersion: z.number().int().nonnegative().optional(),
  /** Sprint 4: material waste of the line (orderQty = qty × (1 + wasteFactor)); room settings override per room. */
  wasteFactor: z.number().min(0).max(0.5).nullable().optional(),
  updatedAt: TimestampSchema.nullable(),
  updatedBy: UidSchema.nullable().optional(),
};

/** orgs/{orgId}/boqRules/{ruleId} — discriminated by `kind`. */
export const BoqRuleSchema = z.discriminatedUnion('kind', [
  z.object({ ...ruleBase, kind: z.literal('class_to_item'), match: ClassToItemMatchSchema }),
  z.object({ ...ruleBase, kind: z.literal('composite_lighting'), match: CompositeLightingMatchSchema }),
  z.object({ ...ruleBase, kind: z.literal('install_count'), match: InstallCountMatchSchema }),
  z.object({ ...ruleBase, kind: z.literal('authority'), match: AuthorityMatchSchema }),
  z.object({ ...ruleBase, kind: z.literal('plumbing_point'), match: PlumbingPointMatchSchema }),
  z.object({ ...ruleBase, kind: z.literal('tiling_floor'), match: TilingFloorMatchSchema }),
  z.object({ ...ruleBase, kind: z.literal('tiling_cladding'), match: TilingCladdingMatchSchema }),
  z.object({ ...ruleBase, kind: z.literal('tiling_corner'), match: TilingCornerMatchSchema }),
  z.object({ ...ruleBase, kind: z.literal('waterproofing'), match: WaterproofingMatchSchema }),
  z.object({ ...ruleBase, kind: z.literal('one_off_suggestion'), match: OneOffSuggestionMatchSchema }),
  z.object({ ...ruleBase, kind: z.literal('template_chapter'), match: TemplateChapterMatchSchema }),
  z.object({ ...ruleBase, kind: z.literal('fixture_combination'), match: FixtureCombinationMatchSchema }),
  z.object({ ...ruleBase, kind: z.literal('text_item'), match: TextItemMatchSchema }),
  z.object({ ...ruleBase, kind: z.literal('area_item'), match: GeometryItemMatchSchema }),
  z.object({ ...ruleBase, kind: z.literal('length_item'), match: GeometryItemMatchSchema }),
  z.object({ ...ruleBase, kind: z.literal('suggested_item'), match: SuggestedItemMatchSchema }),
  z.object({ ...ruleBase, kind: z.literal('marker_addon'), match: MarkerAddonMatchSchema }),
  z.object({ ...ruleBase, kind: z.literal('lighting_circuit'), match: LightingCircuitMatchSchema }),
]);
export type BoqRule = z.infer<typeof BoqRuleSchema>;

export const BoqRuleListSchema = z.object({ items: z.array(BoqRuleSchema) });
export type BoqRuleList = z.infer<typeof BoqRuleListSchema>;

/** PATCH /v1/boq-rules/:id (admin, audited). Marks every project's BOQ stale. */
export const PatchBoqRuleRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    priority: z.number().int().min(-1000).max(1000).optional(),
    itemCode: ItemCodeSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });
export type PatchBoqRuleRequest = z.infer<typeof PatchBoqRuleRequestSchema>;

// ---------------------------------------------------------------------------
// Library imports (past BOQs)
// ---------------------------------------------------------------------------

export const LibraryImportKindSchema = z.enum(LIBRARY_IMPORT_KINDS);
export type LibraryImportKind = z.infer<typeof LibraryImportKindSchema>;

export const MAX_LIBRARY_IMPORT_BYTES = 20 * 1024 * 1024;
/** Content-Type the client must set on the Storage upload (storage.rules). */
export const LIBRARY_IMPORT_CONTENT_TYPE: Readonly<Record<LibraryImportKind, string>> = Object.freeze({
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
});

export const LIBRARY_IMPORT_STATUSES = ['awaiting_upload', 'queued', 'running', 'succeeded', 'failed', 'rejected'] as const;
export const LibraryImportStatusSchema = z.enum(LIBRARY_IMPORT_STATUSES);

export const LibraryImportStatsSchema = z
  .object({
    items: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    templates: z.number().int().nonnegative(),
    /** Codes that were ambiguous in the file (e.g. "4.1" vs "4.10" written as numbers). */
    ambiguousCodes: z.array(z.string().max(64)).max(1000).optional(),
    /** Name of the template created from the file's structure (null when none was created). */
    templateName: z.string().max(200).nullable().optional(),
    /** Sprint 8 (Worker-BOQ): the price report (mode `prices`, or `library` when the file had a price column). */
    prices: PriceImportReportSchema.nullable().optional(),
  })
  .passthrough();

/** orgs/{orgId}/libraryImports/{importId}. API creates/finalizes; the worker may write status/stats/error. */
export const LibraryImportSchema = z.object({
  id: z.string().uuid(),
  orgId: DocIdSchema,
  projectId: DocIdSchema.nullable(),
  sourceKind: LibraryImportKindSchema,
  storagePath: z.string(),
  /** Sanitised original filename (metadata only, never part of a path). */
  originalName: z.string().max(255),
  sizeBytes: z.number().int().positive(),
  status: LibraryImportStatusSchema,
  jobId: DocIdSchema.nullable(),
  createdBy: UidSchema,
  createdAt: TimestampSchema,
  /** Upload slot expiry (10 min). */
  expiresAt: TimestampSchema,
  finalizedAt: TimestampSchema.nullable(),
  stats: LibraryImportStatsSchema.nullable(),
  error: ProcessingErrorSchema.nullable(),
  /** Sprint 8: `library` (absent = library) or `prices` (fill prices of existing items only). */
  mode: LibraryImportModeSchema.optional(),
  /** Sprint 8: an imported price may replace a MANUAL price (default false: such rows are reported as conflicts). */
  overwriteManualPrices: z.boolean().optional(),
  /** Sprint 8 (API): when it appended the `itemLibrary/import_prices` audit event of `stats.prices` (idempotency stamp). */
  pricesAuditedAt: TimestampSchema.nullable().optional(),
  /** Integration: dry-run import (nothing written by the worker) and when / by whom `apply-prices` ran. */
  dryRun: z.boolean().optional(),
  pricesAppliedAt: TimestampSchema.nullable().optional(),
  pricesAppliedBy: UidSchema.nullable().optional(),
});
export type LibraryImport = z.infer<typeof LibraryImportSchema>;

export const LibraryImportFilenameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((s) => /\.(xls|xlsx)$/i.test(s.trim()), { message: 'unsupported file extension (allowed: xls, xlsx)' });

export const CreateLibraryImportRequestSchema = z
  .object({
    orgId: DocIdSchema,
    filename: LibraryImportFilenameSchema,
    sizeBytes: z.number().int().positive().max(MAX_LIBRARY_IMPORT_BYTES),
    /** Optional project the BOQ belongs to (provenance only). */
    projectId: DocIdSchema.optional(),
    /** Sprint 8: `prices` = take only the unit prices of a priced past BOQ (matched by item code). Default `library`. */
    mode: LibraryImportModeSchema.optional(),
    /** Sprint 8: explicit choice to let imported prices replace manual ones (default false). */
    overwriteManualPrices: z.boolean().optional(),
    /**
     * Integration: compute the price report WITHOUT writing (only with `mode: 'prices'`); the user reviews it and calls
     * `POST /library/imports/:id/apply-prices` with the manual prices to replace.
     */
    dryRun: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.dryRun !== true || v.mode === 'prices', { path: ['dryRun'], message: "dryRun needs mode 'prices'" });
export type CreateLibraryImportRequest = z.infer<typeof CreateLibraryImportRequestSchema>;

/** Upload the bytes with the Firebase JS SDK to `storagePath` (contentType as given), then call finalize. */
export const CreateLibraryImportResponseSchema = z.object({
  import: LibraryImportSchema,
  storagePath: z.string(),
  contentType: z.string(),
  maxBytes: z.number().int().positive(),
  expiresAt: TimestampSchema,
});
export type CreateLibraryImportResponse = z.infer<typeof CreateLibraryImportResponseSchema>;

export const FinalizeLibraryImportRequestSchema = z.object({ orgId: DocIdSchema }).strict();
export type FinalizeLibraryImportRequest = z.infer<typeof FinalizeLibraryImportRequestSchema>;

export const LibraryImportViewSchema = LibraryImportSchema.extend({
  job: z.object({ status: JobStatusSchema, progress: JobProgressSchema, error: ProcessingErrorSchema.nullable() }).nullable(),
});
export type LibraryImportView = z.infer<typeof LibraryImportViewSchema>;

// ---------------------------------------------------------------------------
// Defaults (seeded per org; also exported to json-schema/defaults/boq-defaults.json for the worker)
// ---------------------------------------------------------------------------

export const DEFAULT_BOQ_TEMPLATE_ID = 'tpl_default';
export const DEFAULT_BOQ_TEMPLATE_NAME = 'תבנית ברירת מחדל';
/**
 * Version of the shipped default template. 1 = Sprint 3 (structure + notes of the client's sample BOQ, 8 chapters);
 * 2 = Stage 10 (A-LIVE-01): generic trade chapters 01 / 03 / 04 / 05 / 09 matching the default rules and
 * `DEFAULT_ITEM_LIBRARY`, generic notes, no client wording. Seeding is create-if-missing: orgs that already have
 * `tpl_default` keep it (an admin edit or an import is never overwritten).
 * 3 = Sprint 6: + chapters 02 (construction), 06 (gypsum, item codes 7.xx) and 07 (plaster & paint, item codes 8.xx);
 * chapter 09 becomes "תאורה ושונות" (9.01 + 9.03). An UNEDITED v2 seed (`templateNeedsUpgrade`) is replaced.
 */
export const DEFAULT_BOQ_TEMPLATE_VERSION = 3;

/** Stage 10 generic default template (A-LIVE-01): chapters of the default rules, no client / project / price data. */
const defaultTemplate: Omit<BoqTemplate, 'updatedAt' | 'updatedBy'> = {
  id: DEFAULT_BOQ_TEMPLATE_ID,
  name: DEFAULT_BOQ_TEMPLATE_NAME,
  default: true,
  source: 'default',
  sourceRef: `kamutan-defaults/template-v${DEFAULT_BOQ_TEMPLATE_VERSION}`,
  vatRate: 0.18,
  defaultsVersion: DEFAULT_BOQ_TEMPLATE_VERSION,
  titleRows: ['כתב כמויות', 'שם הפרויקט: {projectName}'],
  columns: [
    { key: 'code', title: 'סעיף', width: 8 },
    { key: 'description', title: 'תאור העבודה', width: 60 },
    { key: 'unit', title: 'יחידה', width: 10 },
    { key: 'qty', title: 'כמות', width: 11 },
    { key: 'unitPrice', title: "מחיר יח'", width: 11 },
    { key: 'total', title: 'סה"כ ₪', width: 14 },
  ],
  chapters: [
    {
      code: '01',
      title: 'פרק 01 – עבודות הריסה ופינוי',
      notes: ['1. העבודות כוללות פינוי הפסולת לאתר מורשה.', '2. ההריסות יבוצעו לפי תכנית ההריסה בלבד.'],
      codePrefixes: ['1'],
    },
    {
      code: '02',
      title: 'פרק 02 – עבודות בנייה ובטון',
      notes: ['1. העבודות יבוצעו לפי הנחיות הקונסטרוקטור ותכניות הבנייה המצורפות.', '2. הכמויות לפי מידות התכנית.'],
      codePrefixes: ['2'],
    },
    {
      code: '03',
      title: 'פרק 03 – עבודות אינסטלציה',
      notes: ['1. העבודות כוללות חיבור לצנרת הקיימת ובדיקת לחץ.', '2. הכמויות לפי תכניות האינסטלציה המצורפות.'],
      codePrefixes: ['3'],
    },
    {
      code: '04',
      title: 'פרק 04 – עבודות חשמל',
      notes: ['1. כל העבודות יבוצעו על ידי חשמלאי מוסמך ולפי התקנים המחייבים.', '2. הכמויות לפי תכניות החשמל המצורפות.'],
      codePrefixes: ['4'],
    },
    {
      code: '05',
      title: 'פרק 05 – עבודות ריצוף, חיפוי ואיטום',
      notes: ['1. הכמויות במ"ר / מ"א לפי מידות התכנית; הפחת מפורט בעמודת כמות ההזמנה.', '2. האיטום יבוצע לפני הריצוף והחיפוי.'],
      codePrefixes: ['5'],
    },
    {
      code: '06',
      title: 'פרק 06 – עבודות גבס',
      notes: ['1. העבודות כוללות פרופילים, ברגים, סרט שריון ושפכטל עד לגמר מוכן לצבע.', '2. הכמויות לפי תכנית התקרה ותכנית הבנייה.'],
      codePrefixes: ['7'],
    },
    {
      code: '07',
      title: 'פרק 07 – עבודות טיח, שפכטל וצבע',
      notes: ['1. גוונים לבחירת המזמין.', '2. העבודות כוללות הגנה על האלמנטים הקיימים וניקיון בסיום.'],
      codePrefixes: ['8'],
    },
    {
      code: '09',
      title: 'פרק 09 – תאורה ושונות',
      notes: ['1. התקנת גופי תאורה לפי תכנית התאורה המצורפת.'],
      codePrefixes: ['9'],
    },
  ],
};
export const DEFAULT_BOQ_TEMPLATE: Readonly<Omit<BoqTemplate, 'updatedAt' | 'updatedBy'>> = Object.freeze(defaultTemplate);

/**
 * Sprint 6: a stored `tpl_default` is REPLACED by the shipped one only when it is an unedited generic seed of an older
 * version (`source: 'default'`, `defaultsVersion` ≥ 2 and < DEFAULT_BOQ_TEMPLATE_VERSION, never PATCHed — `updatedBy`
 * null). Sprint-3 sample-format seeds (no `defaultsVersion`), imports and edited templates are never touched; the
 * stored `default` flag is kept.
 */
export const templateNeedsUpgrade = (stored: { source?: unknown; defaultsVersion?: unknown; updatedBy?: unknown } | null | undefined): boolean =>
  !!stored &&
  stored.source === 'default' &&
  typeof stored.defaultsVersion === 'number' &&
  stored.defaultsVersion >= 2 &&
  stored.defaultsVersion < DEFAULT_BOQ_TEMPLATE_VERSION &&
  (stored.updatedBy === null || stored.updatedBy === undefined);

const DEFAULT_RULE_REASON = 'שיוך לפריט לפי כלל ברירת מחדל';
/** Sprint 4: reason of one-off suggestion lines (never green). */
export const ONE_OFF_SUGGESTION_REASON = 'הצעה – לאשר ידנית';

type RuleSeed = Omit<BoqRule, 'updatedAt' | 'updatedBy' | 'source' | 'enabled'> & { enabled?: boolean };
const c2i = (id: string, classes: SymbolClass[], itemCode: string, itemDescription: string, priority = 100, extra: Partial<RuleSeed> = {}): RuleSeed =>
  ({ id, kind: 'class_to_item', match: { classes }, itemCode, itemDescription, unit: 'יחידה', priority, ...extra }) as RuleSeed;
const lighting = (id: string, match: z.infer<typeof CompositeLightingMatchSchema>, itemCode: string, itemDescription: string, priority = 200): RuleSeed =>
  ({ id, kind: 'composite_lighting', match: { pointMergeMm: 600, ...match }, itemCode, itemDescription, unit: 'יחידה', priority }) as RuleSeed;
const plumb = (id: string, match: z.infer<typeof PlumbingPointMatchSchema>, itemCode: string, itemDescription: string, priority = 100): RuleSeed =>
  ({ id, kind: 'plumbing_point', match, itemCode, itemDescription, unit: 'יחידה', priority }) as RuleSeed;
const oneOff = (id: string, match: z.infer<typeof OneOffSuggestionMatchSchema>, itemCode: string, itemDescription: string): RuleSeed =>
  ({ id, kind: 'one_off_suggestion', match, itemCode, itemDescription, unit: 'יחידה', priority: 10, reasons: [ONE_OFF_SUGGESTION_REASON] }) as RuleSeed;
const WET: RoomType[] = ['bathroom', 'wc'];
const PLUMBING_FIXTURES: SymbolClass[] = [
  'fixture_wc_concealed',
  'fixture_wc_monoblock',
  'fixture_basin',
  'fixture_shower',
  'fixture_bath',
  'fixture_kitchen_sink',
  'fixture_washing_machine',
];
/** Waste factor of tiling materials (brief: default 7%). */
const TILING_WASTE = 0.07;

// --- Sprint 6 default rules (generic wording; patterns are matched on `normalizeHebrewText` of pattern and text) ---
const ELEC = ['electrical', 'lighting'];
const BUILD = ['architecture', 'architecture_master', 'construction', 'demolition', 'ceiling'];
const NEEDS_MEASURE = 'לא נמצאה כמות בשרטוט – להשלמה ידנית';
const textItem = (id: string, match: Omit<TextItemMatch, 'scope' | 'qty'> & Partial<Pick<TextItemMatch, 'scope' | 'qty'>>, itemCode: string, itemDescription: string, priority = 120): RuleSeed =>
  ({ id, kind: 'text_item', match: { scope: 'any', qty: 'count', ...match }, itemCode, itemDescription, unit: 'יחידה', priority }) as RuleSeed;
const geoItem = (id: string, kind: 'area_item' | 'length_item', match: GeometryItemMatch, itemCode: string, itemDescription: string, unit: string, priority = 100): RuleSeed =>
  ({ id, kind, match, itemCode, itemDescription, unit, priority }) as RuleSeed;
const suggested = (id: string, match: SuggestedItemMatch, itemCode: string, itemDescription: string, unit: string): RuleSeed =>
  ({ id, kind: 'suggested_item', match, itemCode, itemDescription, unit, priority: 5, reasons: [ONE_OFF_SUGGESTION_REASON] }) as RuleSeed;
const textTrigger = (...patterns: string[]): SuggestedTrigger => ({ kind: 'text', patterns });
const BUILD_SHEETS: SuggestedTrigger = { kind: 'sheet_discipline', disciplines: BUILD };

/**
 * Sprint 6: rules for the items the symbol / room rules cannot produce. Pattern: a computing rule (`text_item` /
 * `area_item` / `length_item`, origin text / geometry) + a `suggested_item` fallback of the same code (a suggested rule
 * is skipped when another rule produced its code), so every implied item is present — computed, estimated, or
 * "להשלמה ידנית" with the right unit and quick action.
 */
const SPRINT6_RULES: readonly RuleSeed[] = [
  // 04 — electrical text / equipment items (no symbol class of their own)
  textItem('r_text_island_conduit', { patterns: ['צינור\\s*(ריק|חופשי)', 'הכנה\\s*ל?שקעי\\s*שירות'], disciplines: ELEC, proximityMm: 300 }, '4.08', 'צינור ריק מהרצפה כהכנה לשקעי שירות באי המטבח'),
  textItem('r_text_ventilator_feed', { patterns: ['(הזנה|נקודה|נק\'?)\\s*ל?(ונטה|מפוח|מאוורר\\s*יניקה)'], disciplines: ELEC, proximityMm: 300 }, '4.19', 'הזנה למפוח אוורור (ונטה) כולל מפסק'),
  textItem('r_text_comms_panel', { patterns: ['לוח\\s*תקשורת', 'ארון\\s*תקשורת'], disciplines: ELEC, nearClasses: ['panel'], consumeNear: true, proximityMm: 40 }, '4.25', 'אספקה והתקנת לוח תקשורת', 130),
  textItem('r_text_boiler_timer', { patterns: ['החלפת\\s*מפסק\\s*(ה)?דוד', 'מפסק\\s*טיימר[^.]{0,30}קיים'], disciplines: ELEC, proximityMm: 300 }, '4.26', 'החלפת מפסק דוד קיים במפסק טיימר'),
  textItem('r_text_projector_conduit', { patterns: ['קוברה[^.]{0,40}מקרן', 'הכנה\\s*ל?מקרן'], disciplines: ELEC, proximityMm: 300 }, '4.27', 'צינור קוברה 50 מ"מ לנקודת מקרן בתקרה'),
  textItem('r_text_panel_36', { patterns: ['לוח[^.]{0,20}36\\s*(מקום|מקומות|מודול)'], disciplines: ELEC, nearClasses: ['panel'], consumeNear: true, proximityMm: 40 }, '4.28', 'אספקה והתקנת לוח חשמל 36 מודולים', 130),
  textItem('r_text_vent_pipe', { patterns: ['צינור\\s*(אוורור|איוורור)', '4"[^.]{0,20}(ונטה|מפוח|אוורור)'], proximityMm: 300 }, '9.03', 'התקנת צינור אוורור 4" למפוח ונטה', 110),
  // 02 — construction
  geoItem('r_geo_retaining_walls', 'area_item', { source: 'wall_run', keys: ['retaining_wall_area'], measure: 'wall_area' }, '2.01', 'יציקת קירות תומכים מבטון מזוין לפי הנחיות הקונסטרוקטור', 'מ"ר'),
  suggested('r_suggest_retaining_walls', { trigger: textTrigger('קיר(ות)?\\s*תומכ', 'חצר\\s*אנגלית'), estimate: null, reason: NEEDS_MEASURE }, '2.01', 'יציקת קירות תומכים מבטון מזוין לפי הנחיות הקונסטרוקטור', 'מ"ר'),
  suggested('r_suggest_slab_stairs', { trigger: textTrigger('יציקת?\\s*(רצפה|ריצפה)', 'מדרגות\\s*(ירידה|ל?מרתף)', 'גרם\\s*מדרגות'), estimate: { kind: 'fixed', quantity: 1 }, reason: 'קומפלט לפי תכנית הקונסטרוקציה – לאשר' }, '2.02', 'יציקת רצפה ומדרגות בטון לפי הנחיות הקונסטרוקטור', 'קומפלט'),
  geoItem('r_geo_opening_closure_block', 'area_item', { source: 'wall_run', keys: ['block_wall_area'], measure: 'wall_area' }, '2.03', 'סגירת פתח קיים בבנייה בבלוקים', 'מ"ר'),
  suggested('r_suggest_opening_closure_block', { trigger: textTrigger('סגירת\\s*פתח', 'סגירה\\s*ב?בלוק'), estimate: null, reason: NEEDS_MEASURE }, '2.03', 'סגירת פתח קיים בבנייה בבלוקים', 'מ"ר'),
  // 05 — tiling / waterproofing additions (5.02 / 5.03 unchanged: GT-D-007 / 008)
  geoItem('r_geo_stair_treads', 'area_item', { source: 'stair', keys: ['stair_treads'], measure: 'treads' }, '5.04', 'ריצוף מדרגות במדרכי אבן (שלח ורום)', 'יחידה'),
  suggested('r_suggest_stair_treads', { trigger: textTrigger('מדרגות'), estimate: null, reason: 'לספור את המדרכים בתכנית – להשלמה ידנית', quickAction: 'count' }, '5.04', 'ריצוף מדרגות במדרכי אבן (שלח ורום)', 'יחידה'),
  geoItem('r_geo_backsplash', 'area_item', { source: 'hatch', keys: ['kitchen_backsplash_area'], measure: 'area' }, '5.06', 'חיפוי קיר מטבח באריחי גרניט פורצלן', 'מ"ר', 110),
  suggested('r_suggest_backsplash', { trigger: { kind: 'sheet_discipline', disciplines: ['architecture', 'architecture_master'] }, estimate: null, reason: NEEDS_MEASURE }, '5.06', 'חיפוי קיר מטבח באריחי גרניט פורצלן', 'מ"ר'),
  geoItem('r_geo_cladding_partial', 'area_item', { source: 'hatch', keys: ['wc_partial_cladding_area'], measure: 'area' }, '5.07', 'חיפוי קיר חלקי באריחי קרמיקה', 'מ"ר', 110),
  suggested('r_suggest_cladding_partial', { trigger: textTrigger('חיפוי\\s*חלקי', 'דמוי\\s*(בריק|לבנים)'), estimate: null, reason: NEEDS_MEASURE }, '5.07', 'חיפוי קיר חלקי באריחי קרמיקה', 'מ"ר'),
  suggested('r_suggest_courtyard_waterproofing', { trigger: textTrigger('חצר\\s*אנגלית'), estimate: { kind: 'geometry', match: { source: 'room', keys: ['courtyard_waterproofing'] } }, reason: 'קומפלט לפי הנחיות יועץ האיטום – לאשר' }, '5.08', 'איטום קירות חצר אנגלית לפי הנחיות יועץ האיטום', 'קומפלט'),
  // 06 — gypsum (codes 7.xx)
  geoItem('r_geo_gypsum_ceiling', 'area_item', { source: 'hatch', keys: ['gypsum_ceiling_area'], measure: 'area' }, '7.01', 'תקרת גבס לפי תכנית התקרה', 'מ"ר'),
  suggested('r_suggest_gypsum_ceiling', { trigger: textTrigger('תקרת?\\s*גבס', 'תקרה\\s*מונמכת'), estimate: null, reason: NEEDS_MEASURE }, '7.01', 'תקרת גבס לפי תכנית התקרה', 'מ"ר'),
  geoItem('r_geo_valance_equipment', 'length_item', { source: 'polyline', keys: ['valance_ventilator_length'], measure: 'length' }, '7.02', 'סינר גבס כמסתור לציוד (מפוח / מזגן)', 'מ"א', 110),
  suggested('r_suggest_valance_equipment', { trigger: textTrigger('סינר[^.]{0,30}(ונטה|מפוח|מזגן|מאייד|מסתור)'), estimate: null, reason: NEEDS_MEASURE }, '7.02', 'סינר גבס כמסתור לציוד (מפוח / מזגן)', 'מ"א'),
  geoItem('r_geo_gypsum_closure', 'area_item', { source: 'polyline', keys: ['window_closure_area'], measure: 'area' }, '7.03', 'סגירה פנימית בגבס של פתח או חלון קיים', 'מ"ר'),
  suggested('r_suggest_gypsum_closure', { trigger: textTrigger('סגירה\\s*(פנימית\\s*)?ב?גבס'), estimate: null, reason: NEEDS_MEASURE }, '7.03', 'סגירה פנימית בגבס של פתח או חלון קיים', 'מ"ר'),
  textItem('r_text_access_panel', { patterns: ['פתח\\s*(שירות|ביקורת|גישה)', 'אורבונד'], proximityMm: 300 }, '7.04', 'אספקה והתקנה של פתח שירות בתקרת גבס', 110),
  suggested('r_suggest_access_panel', { trigger: textTrigger('תקרת?\\s*גבס'), estimate: null, reason: 'לספור פתחי שירות בתקרה – להשלמה ידנית', quickAction: 'count' }, '7.04', 'אספקה והתקנה של פתח שירות בתקרת גבס', 'יחידה'),
  geoItem('r_geo_valance_curtain', 'length_item', { source: 'polyline', keys: ['valance_curtain_length'], measure: 'length' }, '7.05', 'סינר גבס מסתור לווילון', 'מ"א', 110),
  suggested('r_suggest_valance_curtain', { trigger: textTrigger('סינר[^.]{0,30}וילון', 'מסתור\\s*ל?וילון'), estimate: null, reason: NEEDS_MEASURE }, '7.05', 'סינר גבס מסתור לווילון', 'מ"א'),
  // owner decision 05.11: length × full storey height × both faces (a lining against a wall: one face; a low wall: its drawn H)
  geoItem('r_geo_gypsum_partition', 'area_item', { source: 'wall_run', keys: ['gypsum_partition_area'], measure: 'wall_area', faces: 2, heightMode: 'storey' }, '7.06', 'מחיצות גבס עם בידוד צמר סלעים', 'מ"ר'),
  suggested('r_suggest_gypsum_partition', { trigger: textTrigger('מחיצ(ה|ות)\\s*(ה)?גבס'), estimate: null, reason: NEEDS_MEASURE }, '7.06', 'מחיצות גבס עם בידוד צמר סלעים', 'מ"ר'),
  geoItem('r_geo_gypsum_partition_double', 'area_item', { source: 'wall_run', keys: ['gypsum_double_partition_area'], measure: 'wall_area', sides: 1 }, '7.07', 'מחיצות גבס כפולות (דו קרומיות) עם בידוד צמר סלעים', 'מ"ר'),
  suggested('r_suggest_gypsum_partition_double', { trigger: textTrigger('דו[- ]?קרומי', 'מחיצ(ה|ות)\\s*גבס\\s*כפול'), estimate: null, reason: NEEDS_MEASURE }, '7.07', 'מחיצות גבס כפולות (דו קרומיות) עם בידוד צמר סלעים', 'מ"ר'),
  // 07 — plaster, putty & paint (codes 8.xx)
  suggested('r_suggest_repairs_after_demolition', { trigger: { kind: 'demolition' }, estimate: { kind: 'fixed', quantity: 1 }, reason: 'קומפלט – נדרש לאחר הריסות – לאשר' }, '8.01', 'תיקוני טיח ושפכטל לאחר עבודות הריסה ופירוק', 'קומפלט'),
  geoItem('r_geo_plaster_walls', 'area_item', { source: 'wall_run', keys: ['plaster_new_walls_area'], measure: 'wall_area' }, '8.02', 'שתי שכבות טיח על קירות חצר אנגלית וקירות בלוק חדשים', 'מ"ר'),
  suggested('r_suggest_plaster_walls', { trigger: textTrigger('טיח', 'חצר\\s*אנגלית'), estimate: null, reason: NEEDS_MEASURE }, '8.02', 'שתי שכבות טיח על קירות חצר אנגלית וקירות בלוק חדשים', 'מ"ר'),
  suggested('r_suggest_paint_interior', { trigger: BUILD_SHEETS, estimate: { kind: 'fixed', quantity: 1 }, reason: 'קומפלט – צביעת פנים לאחר השיפוץ – לאשר' }, '8.03', 'צביעת פנים הבית בצבע אקרילי', 'קומפלט'),
  suggested('r_suggest_putty', { trigger: BUILD_SHEETS, estimate: { kind: 'fixed', quantity: 1 }, reason: 'קומפלט – לאשר את היקף ההחלקה', level: 'red' }, '8.04', 'החלקת קירות ותקרות בשפכטל בשלוש שכבות', 'קומפלט'),
];

// GENERATED-ONCE from workers/drawing/src/kamutan_drawing/boq/defaults_s10.py (the worker mirror is diffed by test)
const SPRINT10_RULES: readonly RuleSeed[] = [
  {"id": "r_addon_waterproof", "kind": "marker_addon", "match": {"hostClasses": ["socket_single", "socket_double", "socket_triple", "socket_power", "socket_power_double", "socket_3phase", "socket_box_6", "switch_single", "switch_2way", "switch_fan", "switch_cross", "switch_shutter", "tv_point", "data_point", "phone_point", "bezek_point", "speaker", "intercom"], "markerClasses": ["waterproof_marker"], "markerPatterns": ["מוגנ ?מימ", "ip ?(44|55|65)", "(?<![א-ת])מ\\.?מ\\.?(?![א-ת])"], "radiusMm": 6, "roomTypes": ["bathroom", "wc", "balcony", "courtyard"]}, "itemCode": "4.29", "itemDescription": "תוספת עבור אביזר מוגן מים", "unit": "יחידה", "priority": 100} as RuleSeed,
  {"id": "r_addon_usb", "kind": "marker_addon", "match": {"hostClasses": ["socket_single", "socket_double", "socket_triple", "socket_power", "socket_power_double", "socket_3phase", "socket_box_6"], "markerPatterns": ["usb", "type ?c"], "radiusMm": 6}, "itemCode": "4.30", "itemDescription": "תוספת עבור שקע USB + TYPE C בקופסא קיימת", "unit": "יחידה", "priority": 100} as RuleSeed,
  {"id": "r_feed_shutter", "kind": "class_to_item", "match": {"classes": ["heater_feed", "switch_shutter"], "labelPatterns": ["תריס"]}, "itemCode": "4.31", "itemDescription": "הזנה לתריס חשמלי", "unit": "יחידה", "priority": 110} as RuleSeed,
  {"id": "r_feed_smoke", "kind": "class_to_item", "match": {"classes": ["heater_feed"], "labelPatterns": ["גלאי ?עשנ", "גלאי"]}, "itemCode": "4.32", "itemDescription": "הזנה לגלאי עשן", "unit": "יחידה", "priority": 110} as RuleSeed,
  {"id": "r_supply_smoke", "kind": "class_to_item", "match": {"classes": ["heater_feed"], "labelPatterns": ["גלאי ?עשנ", "גלאי"], "countOnly": true}, "itemCode": "4.33", "itemDescription": "אספקה והתקנת גלאי עשן", "unit": "יחידה", "priority": 110} as RuleSeed,
  {"id": "r_feed_awning", "kind": "class_to_item", "match": {"classes": ["heater_feed"], "labelPatterns": ["סוככ", "פרגולה חשמלית"]}, "itemCode": "4.34", "itemDescription": "הזנה לסוכך חשמלי", "unit": "יחידה", "priority": 110} as RuleSeed,
  {"id": "r_feed_solar_boiler", "kind": "class_to_item", "match": {"classes": ["heater_feed", "water_heater_feed"], "labelPatterns": ["דוד ?שמש", "(?:דוד|חימומ).{0,20}(?:גג|גז)"]}, "itemCode": "4.35", "itemDescription": "הזנה משולבת לדוד שמש ולמכשיר חימום מים על הגג כולל פקט ומפסק", "unit": "יחידה", "priority": 112} as RuleSeed,
  {"id": "r_supply_heater", "kind": "class_to_item", "match": {"classes": ["heater_feed"], "labelPatterns": ["תנור"], "countOnly": true}, "itemCode": "4.36", "itemDescription": "התקנת תנור חימום בחדר רחצה", "unit": "יחידה", "priority": 110} as RuleSeed,
  {"id": "r_supply_bell", "kind": "class_to_item", "match": {"classes": ["doorbell"], "labelPatterns": [".*"], "countOnly": true}, "itemCode": "4.37", "itemDescription": "אספקה והתקנת פעמון", "unit": "יחידה", "priority": 110} as RuleSeed,
  {"id": "r_supply_vent", "kind": "text_item", "match": {"patterns": ["(הזנה|נקודה|נק'?)\\s*ל?(ונטה|מפוח|מאוורר\\s*יניקה)"], "scope": "any", "qty": "count", "proximityMm": 300, "disciplines": ["electrical", "lighting"]}, "itemCode": "4.38", "itemDescription": "אספקה והתקנת ונטה", "unit": "יחידה", "priority": 119} as RuleSeed,
  {"id": "r_3ph_ac", "kind": "class_to_item", "match": {"classes": ["socket_3phase", "socket_power"], "labelPatterns": ["מזגנ", "מיזוג", "מעבה"]}, "itemCode": "4.39", "itemDescription": "שקע תלת פאזי למזגן", "unit": "יחידה", "priority": 111} as RuleSeed,
  {"id": "r_3ph_induction", "kind": "class_to_item", "match": {"classes": ["socket_3phase", "socket_power"], "labelPatterns": ["אינדוקציה", "כיריימ"]}, "itemCode": "4.40", "itemDescription": "שקע תלת פאזי לכיריים אינדוקציה", "unit": "יחידה", "priority": 112} as RuleSeed,
  {"id": "r_3ph_jacuzzi", "kind": "class_to_item", "match": {"classes": ["socket_3phase", "socket_power"], "labelPatterns": ["ג'?קוזי"]}, "itemCode": "4.41", "itemDescription": "שקע תלת פאזי לג'קוזי", "unit": "יחידה", "priority": 112} as RuleSeed,
  {"id": "r_3ph_ev", "kind": "class_to_item", "match": {"classes": ["socket_3phase", "socket_power"], "labelPatterns": ["רכב", "טעינה"]}, "itemCode": "4.42", "itemDescription": "הזנה תלת פאזית עבור שקע טעינה לרכב חשמלי", "unit": "יחידה", "priority": 112} as RuleSeed,
  {"id": "r_3ph_hydro", "kind": "class_to_item", "match": {"classes": ["socket_3phase", "socket_power"], "labelPatterns": ["היתרו", "חימומ ?מימ"]}, "itemCode": "4.43", "itemDescription": "שקע תלת פאזי למכשיר חימום מים (היתרו)", "unit": "יחידה", "priority": 112} as RuleSeed,
  {"id": "r_3ph_sauna", "kind": "class_to_item", "match": {"classes": ["socket_3phase", "socket_power"], "labelPatterns": ["סאונה"]}, "itemCode": "4.44", "itemDescription": "שקע תלת פאזי לסאונה", "unit": "יחידה", "priority": 112} as RuleSeed,
  {"id": "r_3ph_pool", "kind": "class_to_item", "match": {"classes": ["socket_3phase", "socket_power"], "labelPatterns": ["בריכה", "חדר ?מכונות"]}, "itemCode": "4.45", "itemDescription": "הזנה תלת פאזית לחדר מכונות בריכה", "unit": "יחידה", "priority": 112} as RuleSeed,
  {"id": "r_cobra_32", "kind": "class_to_item", "match": {"classes": ["conduit_cobra"], "labelPatterns": ["32"], "params": {"length": "label"}}, "itemCode": "4.46", "itemDescription": "צינור קוברה 32 מ\"מ", "unit": "יחידה", "priority": 110} as RuleSeed,
  {"id": "r_text_marichaf_20", "kind": "text_item", "match": {"patterns": ["מריכפ", "מריחב", "צינור\\s*20\\s*מ\"?מ"], "scope": "any", "qty": "count", "proximityMm": 300, "disciplines": ["electrical", "lighting"]}, "itemCode": "4.47", "itemDescription": "צינור מריכף 20 מ\"מ חופשי מהרצפה כהכנה", "unit": "יחידה", "priority": 120} as RuleSeed,
  {"id": "r_text_solar_conduit", "kind": "text_item", "match": {"patterns": ["סולרי", "פאנלימ\\s*סולר", "הכנה\\s*ל?סולר"], "scope": "any", "qty": "one", "proximityMm": 300, "disciplines": ["electrical", "lighting"]}, "itemCode": "4.48", "itemDescription": "צינור הזנה עם חוט משיכה מלוח חשמל ראשי עד הגג – הכנה לפאנלים סולריים", "unit": "יחידה", "priority": 120} as RuleSeed,
  {"id": "r_panel_main", "kind": "class_to_item", "match": {"classes": ["panel"], "labelPatterns": ["ראשי"], "excludeLabelPatterns": ["תקשורת"]}, "itemCode": "4.49", "itemDescription": "אספקה והתקנת לוח חשמל ראשי", "unit": "יחידה", "priority": 112} as RuleSeed,
  {"id": "r_panel_sub", "kind": "class_to_item", "match": {"classes": ["panel"], "labelPatterns": ["משני", "משנה"], "excludeLabelPatterns": ["תקשורת", "מונה"]}, "itemCode": "4.50", "itemDescription": "אספקה והתקנת לוח חשמל משני", "unit": "יחידה", "priority": 112} as RuleSeed,
  {"id": "r_panel_submeter", "kind": "class_to_item", "match": {"classes": ["panel"], "labelPatterns": ["מונה"], "countOnly": true}, "itemCode": "4.51", "itemDescription": "אספקה והתקנת מונה משני בלוח חשמל", "unit": "יחידה", "priority": 110} as RuleSeed,
  {"id": "r_deep_boxes", "kind": "class_to_item", "match": {"classes": ["switch_single", "switch_2way", "switch_fan", "switch_cross", "switch_shutter"], "countOnly": true}, "itemCode": "4.52", "itemDescription": "קופסת עומק למפסקים כוללת קו אפס נוסף", "unit": "יחידה", "priority": 100} as RuleSeed,
  {"id": "r_suggest_smart_home", "kind": "suggested_item", "match": {"trigger": {"kind": "text", "patterns": ["בית ?חכמ", "קופס(?:א|ת|אות) ?עומק"]}, "estimate": {"kind": "fixed", "quantity": 1}, "reason": "קומפלט – לאשר"}, "itemCode": "4.53", "itemDescription": "הכנה לבית חכם: קופסאות עומק וקו אפס נוסף לכל המפסקים", "unit": "קומפלט", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_box_d18", "kind": "class_to_item", "match": {"classes": ["socket_box_6"], "labelPatterns": [".*"]}, "itemCode": "4.71", "itemDescription": "אביזר D18 הכולל 6 שקעים ושלושה צינורות נוספים עם חוט משיכה עד לארון תקשורת", "unit": "יחידה", "priority": 105} as RuleSeed,
  {"id": "r_comms_extra", "kind": "class_to_item", "match": {"classes": ["camera", "thermostat", "alarm_detector", "siren", "keypad"]}, "itemCode": "4.05", "itemDescription": "נק' תקשורת (כבלים/ טלפון/ רשת) הכנה עם חוט משיכה", "unit": "יחידה", "priority": 100} as RuleSeed,
  {"id": "r_shutter_feed", "kind": "class_to_item", "match": {"classes": ["shutter_feed"]}, "itemCode": "4.31", "itemDescription": "הזנה לתריס חשמלי", "unit": "יחידה", "priority": 100} as RuleSeed,
  {"id": "r_smoke_feed", "kind": "class_to_item", "match": {"classes": ["smoke_detector"]}, "itemCode": "4.32", "itemDescription": "הזנה לגלאי עשן", "unit": "יחידה", "priority": 100} as RuleSeed,
  {"id": "r_smoke_supply", "kind": "class_to_item", "match": {"classes": ["smoke_detector"], "countOnly": true}, "itemCode": "4.33", "itemDescription": "אספקה והתקנת גלאי עשן", "unit": "יחידה", "priority": 100} as RuleSeed,
  {"id": "r_vent_feed", "kind": "class_to_item", "match": {"classes": ["ventilator_feed"]}, "itemCode": "4.19", "itemDescription": "הזנה למפוח אוורור (ונטה) כולל מפסק", "unit": "יחידה", "priority": 100} as RuleSeed,
  {"id": "r_vent_supply", "kind": "class_to_item", "match": {"classes": ["ventilator_feed"], "countOnly": true}, "itemCode": "4.38", "itemDescription": "אספקה והתקנת ונטה", "unit": "יחידה", "priority": 100} as RuleSeed,
  {"id": "r_popup_socket", "kind": "class_to_item", "match": {"classes": ["socket_single", "socket_double", "socket_triple", "socket_power", "socket_power_double", "socket_3phase", "socket_box_6"], "labelPatterns": ["קופצ"]}, "itemCode": "4.57", "itemDescription": "אספקה והתקנת שקע קופץ באי מטבח", "unit": "יחידה", "priority": 112} as RuleSeed,
  {"id": "r_install_fans", "kind": "class_to_item", "match": {"classes": ["ceiling_fan"], "countOnly": true}, "itemCode": "4.54", "itemDescription": "התקנת מאוורר תקרה", "unit": "יחידה", "priority": 100} as RuleSeed,
  {"id": "r_suggest_profile_surface", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["lighting"]}, "estimate": null, "reason": "לא נמצאה כמות בשרטוט – להשלמה ידנית", "quickAction": "measure_length"}, "itemCode": "4.55", "itemDescription": "התקנת פרופיל תאורה חיצוני עה\"ט", "unit": "מ\"א", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_profile_recessed", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["lighting"]}, "estimate": null, "reason": "לא נמצאה כמות בשרטוט – להשלמה ידנית", "quickAction": "measure_length"}, "itemCode": "4.56", "itemDescription": "התקנת פרופיל תאורה שקוע בתקרת גבס", "unit": "מ\"א", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_profile_units", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["lighting"]}, "estimate": null, "reason": "לא נמצאה כמות בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.72", "itemDescription": "התקנת פרופיל תאורה חיצוני עה\"ט באורך לפי תכנית", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_text_popup_socket", "kind": "text_item", "match": {"patterns": ["שקע\\s*קופצ"], "scope": "any", "qty": "count", "proximityMm": 300, "disciplines": ["electrical", "lighting"]}, "itemCode": "4.57", "itemDescription": "אספקה והתקנת שקע קופץ באי מטבח", "unit": "יחידה", "priority": 120} as RuleSeed,
  {"id": "r_suggest_pillar_feed", "kind": "suggested_item", "match": {"trigger": {"kind": "text", "patterns": ["פילר"]}, "estimate": {"kind": "fixed", "quantity": 1}, "reason": "לאשר לפי תכנית החשמל"}, "itemCode": "4.58", "itemDescription": "ביצוע הזנה חדשה מהפילר ועד לוח חשמל ראשי", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_fiber_feed", "kind": "suggested_item", "match": {"trigger": {"kind": "text", "patterns": ["סיב ?אופטי"]}, "estimate": {"kind": "fixed", "quantity": 1}, "reason": "לאשר לפי תכנית החשמל"}, "itemCode": "4.59", "itemDescription": "ביצוע הזנה ראשית לסיב אופטי מהפילר ועד לוח תקשורת ראשי", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_iec_inspection", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": {"kind": "fixed", "quantity": 1}, "reason": "קומפלט – לאשר"}, "itemCode": "4.60", "itemDescription": "אחריות להעברת ביקורת חברת חשמל", "unit": "קומפלט", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_text_storage_feed", "kind": "text_item", "match": {"patterns": ["קו\\s*הזנה.{0,30}מחסנ", "הזנה.{0,20}מחסנ"], "scope": "any", "qty": "one", "proximityMm": 300, "disciplines": ["electrical", "lighting"]}, "itemCode": "4.61", "itemDescription": "קו הזנה מלוח חשמל ראשי עד מחסן בגינה", "unit": "יחידה", "priority": 120} as RuleSeed,
  {"id": "r_fb_waterproof", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.29", "itemDescription": "תוספת עבור אביזר מוגן מים", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_usb", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.30", "itemDescription": "תוספת עבור שקע USB + TYPE C בקופסא קיימת", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_shutter", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.31", "itemDescription": "הזנה לתריס חשמלי", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_smoke", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.32", "itemDescription": "הזנה לגלאי עשן", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_smoke_supply", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.33", "itemDescription": "אספקה והתקנת גלאי עשן", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_awning", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.34", "itemDescription": "הזנה לסוכך חשמלי", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_solar_boiler", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.35", "itemDescription": "הזנה משולבת לדוד שמש ולמכשיר חימום מים על הגג כולל פקט ומפסק", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_heater_install", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.36", "itemDescription": "התקנת תנור חימום בחדר רחצה", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_bell_supply", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.37", "itemDescription": "אספקה והתקנת פעמון", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_vent_supply", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.38", "itemDescription": "אספקה והתקנת ונטה", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_3ph_ac", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.39", "itemDescription": "שקע תלת פאזי למזגן", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_3ph_induction", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.40", "itemDescription": "שקע תלת פאזי לכיריים אינדוקציה", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_3ph_jacuzzi", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.41", "itemDescription": "שקע תלת פאזי לג'קוזי", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_3ph_ev", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.42", "itemDescription": "הזנה תלת פאזית עבור שקע טעינה לרכב חשמלי", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_3ph_hydro", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.43", "itemDescription": "שקע תלת פאזי למכשיר חימום מים (היתרו)", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_3ph_sauna", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.44", "itemDescription": "שקע תלת פאזי לסאונה", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_3ph_pool", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.45", "itemDescription": "הזנה תלת פאזית לחדר מכונות בריכה", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_cobra_32", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.46", "itemDescription": "צינור קוברה 32 מ\"מ", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_cobra_50", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.20", "itemDescription": "צינור קוברה 50 מ\"מ", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_marichaf", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.47", "itemDescription": "צינור מריכף 20 מ\"מ חופשי מהרצפה כהכנה", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_solar_conduit", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.48", "itemDescription": "צינור הזנה עם חוט משיכה מלוח חשמל ראשי עד הגג – הכנה לפאנלים סולריים", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_panel_main", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.49", "itemDescription": "אספקה והתקנת לוח חשמל ראשי", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_panel_sub", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.50", "itemDescription": "אספקה והתקנת לוח חשמל משני", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_panel_comms", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.25", "itemDescription": "אספקה והתקנת לוח תקשורת", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_submeter", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.51", "itemDescription": "אספקה והתקנת מונה משני בלוח חשמל", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_deep_boxes", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.52", "itemDescription": "קופסת עומק למפסקים כוללת קו אפס נוסף", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_d18", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.71", "itemDescription": "אביזר D18 הכולל 6 שקעים ושלושה צינורות נוספים עם חוט משיכה עד לארון תקשורת", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_popup", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["electrical", "lighting"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "4.57", "itemDescription": "אספקה והתקנת שקע קופץ באי מטבח", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_irrigation", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["plumbing"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "3.25", "itemDescription": "נק' הזנה למערכת השקיה", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_heater_water", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["plumbing"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "3.35", "itemDescription": "הזנת מים למכשיר חימום מים / היתרו", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_fb_waterproof_room", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["plumbing"]}, "estimate": null, "reason": "לא זוהה בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "5.09", "itemDescription": "איטום חדר רחצה רטוב בשתי שכבות סיכה, כולל רולקות ובדיקת הצפה", "unit": "חדר", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_plumb_kitchen_sink", "kind": "plumbing_point", "match": {"fixtureClasses": ["fixture_kitchen_sink"], "perRoom": false, "excludeLabelPatterns": ["חוצ"]}, "itemCode": "3.16", "itemDescription": "נק' מים חמים קרים וניקוז לכיור מטבח, כולל התקנת ברז וסיפון", "unit": "יחידה", "priority": 115} as RuleSeed,
  {"id": "r_plumb_kitchen_sink_outdoor", "kind": "plumbing_point", "match": {"fixtureClasses": ["fixture_kitchen_sink"], "perRoom": false, "labelPatterns": ["חוצ", "גינה", "מרפסת"]}, "itemCode": "3.17", "itemDescription": "נק' מים קרים וניקוז לכיור מטבח חוץ", "unit": "יחידה", "priority": 125} as RuleSeed,
  {"id": "r_plumb_shower_3x", "kind": "plumbing_point", "match": {"fixtureClasses": ["fixture_shower"], "perRoom": true, "labelPatterns": ["3\\s*x", "x\\s*3", "שלוש", "3 ?יח"]}, "itemCode": "3.18", "itemDescription": "נק' למקלחון הכוללת הזנת חמים וקרים, שלוש יחידות אינטרפוץ 3 דרך, נק' מים ומזלף, ראש גשם ותעלת ניקוז", "unit": "יחידה", "priority": 125} as RuleSeed,
  {"id": "r_plumb_shower_4way", "kind": "plumbing_point", "match": {"fixtureClasses": ["fixture_shower"], "perRoom": true, "labelPatterns": ["4\\s*דרכ"]}, "itemCode": "3.19", "itemDescription": "נק' למקלחון הכוללת הזנת חמים וקרים, אינטרפוץ 4 דרך, נק' מים ומזלף, ראש גשם וקופסת ניקוז", "unit": "יחידה", "priority": 124} as RuleSeed,
  {"id": "r_text_manifold_main", "kind": "text_item", "match": {"patterns": ["מרכזי(?:ה|ית)\\s*(?:מימ\\s*)?ראשית"], "scope": "any", "qty": "one", "proximityMm": 300, "disciplines": ["plumbing"]}, "itemCode": "3.22", "itemDescription": "אספקה והתקנת מרכזיית מים ראשית", "unit": "יחידה", "priority": 125} as RuleSeed,
  {"id": "r_text_manifold_sub", "kind": "text_item", "match": {"patterns": ["מרכזי(?:ה|ית)\\s*(?:מימ\\s*)?משנית"], "scope": "any", "qty": "count", "proximityMm": 300, "disciplines": ["plumbing"]}, "itemCode": "3.23", "itemDescription": "אספקה והתקנת מרכזיית מים משנית", "unit": "יחידה", "priority": 125} as RuleSeed,
  {"id": "r_text_roof_heater_feed", "kind": "text_item", "match": {"patterns": ["הזנת?\\s*מימ.{0,30}(?:גג|דוד\\s*שמש|גז)"], "scope": "any", "qty": "one", "proximityMm": 300, "disciplines": ["plumbing"]}, "itemCode": "3.24", "itemDescription": "הזנת מים בגג משולבת לדוד ולמכשיר חימום בגז", "unit": "יחידה", "priority": 120} as RuleSeed,
  {"id": "r_text_irrigation_point", "kind": "text_item", "match": {"patterns": ["(?:נק'?|הזנה|הזנת\\s*מימ)\\s*ל?השקיה"], "scope": "any", "qty": "count", "proximityMm": 300, "disciplines": ["plumbing"]}, "itemCode": "3.25", "itemDescription": "נק' הזנה למערכת השקיה", "unit": "יחידה", "priority": 120} as RuleSeed,
  {"id": "r_text_fire_hose_point", "kind": "text_item", "match": {"patterns": ["גלגלונ"], "scope": "any", "qty": "one", "proximityMm": 300, "disciplines": ["plumbing"]}, "itemCode": "3.26", "itemDescription": "נק' מים למערכת גלגלון כיבוי אש", "unit": "יחידה", "priority": 120} as RuleSeed,
  {"id": "r_text_fire_hose_supply", "kind": "text_item", "match": {"patterns": ["גלגלונ"], "scope": "any", "qty": "one", "proximityMm": 300, "disciplines": ["plumbing"]}, "itemCode": "3.27", "itemDescription": "אספקה והתקנת מערכת גלגלון כיבוי אש", "unit": "יחידה", "priority": 119} as RuleSeed,
  {"id": "r_text_pool_feed", "kind": "text_item", "match": {"patterns": ["הזנת?\\s*מימ.{0,20}בריכה", "בריכה"], "scope": "any", "qty": "one", "proximityMm": 300, "disciplines": ["plumbing"]}, "itemCode": "3.28", "itemDescription": "הזנת מים לבריכה לפי הנחיות קבלן הבריכות", "unit": "יחידה", "priority": 120} as RuleSeed,
  {"id": "r_text_planter_drain", "kind": "text_item", "match": {"patterns": ["אדנית"], "scope": "any", "qty": "count", "proximityMm": 300, "disciplines": ["plumbing"]}, "itemCode": "3.29", "itemDescription": "ביצוע ניקוז לאדנית", "unit": "יחידה", "priority": 120} as RuleSeed,
  {"id": "r_text_sauna_feed", "kind": "text_item", "match": {"patterns": ["סאונה"], "scope": "any", "qty": "one", "proximityMm": 300, "disciplines": ["plumbing"]}, "itemCode": "3.30", "itemDescription": "הזנת מים וניקוז לסאונה", "unit": "יחידה", "priority": 120} as RuleSeed,
  {"id": "r_text_outdoor_shower", "kind": "text_item", "match": {"patterns": ["טוש"], "scope": "any", "qty": "one", "proximityMm": 300, "disciplines": ["plumbing"]}, "itemCode": "3.31", "itemDescription": "הזנת מים חמים וקרים למערכת טוש רצפתית בחצר, כולל התקנת המערכת", "unit": "יחידה", "priority": 120} as RuleSeed,
  {"id": "r_suggest_sewage", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["plumbing"]}, "estimate": {"kind": "fixed", "quantity": 1}, "reason": "קומפלט – לאשר"}, "itemCode": "3.32", "itemDescription": "ביצוע מערכת ביוב חדשה לפי נספח סניטרי ותכניות האינסטלציה", "unit": "קומפלט", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_pump_pit", "kind": "suggested_item", "match": {"trigger": {"kind": "text", "patterns": ["בור\\s*(?:משאבה|שאיבה)", "משאבה\\s*טבולה"]}, "estimate": {"kind": "fixed", "quantity": 1}, "reason": "קומפלט – לאשר"}, "itemCode": "3.33", "itemDescription": "חפירת ויציקת בור משאבה כולל חיבור הדלוחין ואספקת המשאבה", "unit": "קומפלט", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_main_feed_line", "kind": "suggested_item", "match": {"trigger": {"kind": "text", "patterns": ["קו\\s*הזנה\\s*ראשי", "מהשעונ"]}, "estimate": {"kind": "fixed", "quantity": 1}, "reason": "לאשר לפי תכנית האינסטלציה"}, "itemCode": "3.34", "itemDescription": "ביצוע קו הזנה ראשי חדש מהשעון", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_floor_indoor", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["architecture", "architecture_master", "construction", "demolition", "ceiling"]}, "estimate": null, "reason": "לא נמצאה כמות בשרטוט – להשלמה ידנית", "quickAction": "measure_area"}, "itemCode": "5.10", "itemDescription": "ריצוף פנים באריחי גרניט פורצלן כולל רובה אקרילית", "unit": "מ\"ר", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_floor_outdoor", "kind": "suggested_item", "match": {"trigger": {"kind": "text", "patterns": ["פיתוח", "ריצופ\\s*חוצ", "חניה", "פטיו"]}, "estimate": null, "reason": "לא נמצאה כמות בשרטוט – להשלמה ידנית", "quickAction": "measure_area"}, "itemCode": "5.11", "itemDescription": "ריצוף חוץ באריחי גרניט פורצלן בטיט", "unit": "מ\"ר", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_floor_substrate", "kind": "suggested_item", "match": {"trigger": {"kind": "text", "patterns": ["פרקט", "סוג\\s*ב'?"]}, "estimate": null, "reason": "לא נמצאה כמות בשרטוט – להשלמה ידנית", "quickAction": "measure_area"}, "itemCode": "5.12", "itemDescription": "ריצוף אריחי סוג ב' כתשתית לפרקט", "unit": "מ\"ר", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_stone_cladding", "kind": "suggested_item", "match": {"trigger": {"kind": "text", "patterns": ["חיפוי\\s*אבנ", "אבנ"]}, "estimate": null, "reason": "לא נמצאה כמות בשרטוט – להשלמה ידנית", "quickAction": "measure_area"}, "itemCode": "5.13", "itemDescription": "חיפוי קירות חוץ באבן כולל כוחלה", "unit": "מ\"ר", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_coping", "kind": "suggested_item", "match": {"trigger": {"kind": "text", "patterns": ["קופינג", "ספ\\s*שיש", "חלונ"]}, "estimate": null, "reason": "לא נמצאה כמות בשרטוט – להשלמה ידנית", "quickAction": "measure_length"}, "itemCode": "5.14", "itemDescription": "התקנת סף שיש (קופינג) לחלון כולל מילוי דבק שיש וליטוש", "unit": "מ\"א", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_recessed_skirting", "kind": "suggested_item", "match": {"trigger": {"kind": "text", "patterns": ["פאנל\\s*שקוע", "פנל\\s*שקוע"]}, "estimate": null, "reason": "לא נמצאה כמות בשרטוט – להשלמה ידנית", "quickAction": "measure_length"}, "itemCode": "5.15", "itemDescription": "הדבקת פאנל שקוע לפי פרט כולל פרופיל ניתוק", "unit": "מ\"א", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_terrace_waterproofing", "kind": "suggested_item", "match": {"trigger": {"kind": "text", "patterns": ["מרפסת", "גג"]}, "estimate": null, "reason": "לא נמצאה כמות בשרטוט – להשלמה ידנית", "quickAction": "measure_area"}, "itemCode": "5.16", "itemDescription": "איטום מרפסת / גג ביריעות ביטומניות מולחמות לרבות שיפועים ורולקות", "unit": "מ\"ר", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_ground_waterproofing", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["architecture", "architecture_master", "construction", "demolition", "ceiling"]}, "estimate": {"kind": "fixed", "quantity": 1}, "reason": "קומפלט – לאשר"}, "itemCode": "5.17", "itemDescription": "איטום קירות הבית במפגש עם הקרקע", "unit": "קומפלט", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_openings_waterproofing", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["architecture", "architecture_master", "construction", "demolition", "ceiling"]}, "estimate": {"kind": "fixed", "quantity": 1}, "reason": "קומפלט – לאשר"}, "itemCode": "5.18", "itemDescription": "איטום פתחי מערכות אלומיניום בשתי שכבות סיכה", "unit": "קומפלט", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_laundry_floor", "kind": "suggested_item", "match": {"trigger": {"kind": "text", "patterns": ["חדר\\s*כביסה"]}, "estimate": null, "reason": "לא נמצאה כמות בשרטוט – להשלמה ידנית", "quickAction": "measure_area"}, "itemCode": "5.19", "itemDescription": "ריצוף רצפת חדר כביסה באריחי גרניט פורצלן", "unit": "מ\"ר", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_block_walls", "kind": "suggested_item", "match": {"trigger": {"kind": "text", "patterns": ["קיר(?:ות)?\\s*בלוק", "בלוקימ"]}, "estimate": null, "reason": "לא נמצאה כמות בשרטוט – להשלמה ידנית", "quickAction": "measure_area"}, "itemCode": "2.04", "itemDescription": "בניית קירות בלוק בטון לפי תכניות האדריכלות", "unit": "מ\"ר", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_window_closure", "kind": "suggested_item", "match": {"trigger": {"kind": "text", "patterns": ["סגירת\\s*(?:פתח\\s*)?חלונ"]}, "estimate": null, "reason": "לא נמצאה כמות בשרטוט – להשלמה ידנית", "quickAction": "count"}, "itemCode": "2.05", "itemDescription": "סגירת פתח חלון קיים בבלוק", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_concrete_works", "kind": "suggested_item", "match": {"trigger": {"kind": "text", "patterns": ["יציק", "קונסטרוק"]}, "estimate": {"kind": "fixed", "quantity": 1}, "reason": "קומפלט – לאשר"}, "itemCode": "2.06", "itemDescription": "יציקות בטון לפי תכניות ופרטי הקונסטרוקציה", "unit": "קומפלט", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_white_partitions", "kind": "suggested_item", "match": {"trigger": {"kind": "text", "patterns": ["גבס\\s*לבנ", "מחיצ(?:ה|ות)\\s*גבס"]}, "estimate": null, "reason": "לא נמצאה כמות בשרטוט – להשלמה ידנית", "quickAction": "measure_area"}, "itemCode": "7.08", "itemDescription": "מחיצות גבס לבן בעובי 10 ס\"מ כולל בידוד צמר סלעים", "unit": "מ\"ר", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_blue_partitions", "kind": "suggested_item", "match": {"trigger": {"kind": "text", "patterns": ["גבס\\s*כחול", "נגד\\s*מימ", "גבס\\s*ירוק"]}, "estimate": null, "reason": "לא נמצאה כמות בשרטוט – להשלמה ידנית", "quickAction": "measure_area"}, "itemCode": "7.09", "itemDescription": "בניית מחיצות גבס כחול נגד מים כולל בידוד צמר סלעים", "unit": "מ\"ר", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_text_gypsum_niche", "kind": "text_item", "match": {"patterns": ["נישה"], "scope": "any", "qty": "count", "proximityMm": 300, "disciplines": ["architecture", "architecture_master", "construction", "demolition", "ceiling"]}, "itemCode": "7.10", "itemDescription": "בניית נישה במחיצת גבס לפי תכנית", "unit": "יחידה", "priority": 110} as RuleSeed,
  {"id": "r_suggest_str_profile", "kind": "suggested_item", "match": {"trigger": {"kind": "text", "patterns": ["(?<![a-z])str(?![a-z])", "פרופיל\\s*ניתוק"]}, "estimate": null, "reason": "לא נמצאה כמות בשרטוט – להשלמה ידנית", "quickAction": "measure_length"}, "itemCode": "7.11", "itemDescription": "אספקה והתקנת פרופיל ניתוק STR במפגש תקרת גבס עם קירות", "unit": "מ\"א", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_text_open_art", "kind": "text_item", "match": {"patterns": ["אופנ\\s*ארט", "open\\s*art"], "scope": "any", "qty": "count", "proximityMm": 300, "disciplines": ["architecture", "architecture_master", "construction", "demolition", "ceiling"]}, "itemCode": "7.12", "itemDescription": "אספקה והתקנת פתח אופן ארט בגודל 60/60 ס\"מ", "unit": "יחידה", "priority": 110} as RuleSeed,
  {"id": "r_suggest_valance_kitchen", "kind": "suggested_item", "match": {"trigger": {"kind": "text", "patterns": ["סינר.{0,30}מטבח"]}, "estimate": null, "reason": "לא נמצאה כמות בשרטוט – להשלמה ידנית", "quickAction": "measure_length"}, "itemCode": "7.13", "itemDescription": "בניית סינר גבס בחתך לפי תכנית", "unit": "מ\"א", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_colored_render", "kind": "suggested_item", "match": {"trigger": {"kind": "text", "patterns": ["שליכט"]}, "estimate": {"kind": "fixed", "quantity": 1}, "reason": "קומפלט – לאשר"}, "itemCode": "8.05", "itemDescription": "שליכט צבעוני על קירות חוץ וחומות כולל טיח שחור ופריימר", "unit": "קומפלט", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_shelter_door_paint", "kind": "suggested_item", "match": {"trigger": {"kind": "text", "patterns": ["ממ\"?ד", "מקלט"]}, "estimate": {"kind": "fixed", "quantity": 1}, "reason": "לאשר"}, "itemCode": "8.06", "itemDescription": "צביעת משקוף ודלת ממ\"ד / מקלט בצבע על בסיס שמן", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_wood_reinforcements", "kind": "suggested_item", "match": {"trigger": {"kind": "text", "patterns": ["חיזוק", "מחיצ(?:ה|ות)\\s*גבס"]}, "estimate": {"kind": "fixed", "quantity": 1}, "reason": "קומפלט – לאשר"}, "itemCode": "9.04", "itemDescription": "ביצוע חיזוקי עץ במחיצות גבס לפי תכנית", "unit": "קומפלט", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_bath_accessories", "kind": "suggested_item", "match": {"trigger": {"kind": "sheet_discipline", "disciplines": ["plumbing"]}, "estimate": {"kind": "fixed", "quantity": 1}, "reason": "קומפלט – לאשר"}, "itemCode": "9.05", "itemDescription": "התקנת אביזרי חדרי רחצה", "unit": "קומפלט", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_percolation_pit", "kind": "suggested_item", "match": {"trigger": {"kind": "text", "patterns": ["ח[יל]?לחול"]}, "estimate": {"kind": "fixed", "quantity": 1}, "reason": "לאשר"}, "itemCode": "9.06", "itemDescription": "קידוח בור חלחול כולל שרוול, רשת וצלב הגנה", "unit": "יחידה", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_suggest_pool_channel", "kind": "suggested_item", "match": {"trigger": {"kind": "text", "patterns": ["בריכה"]}, "estimate": null, "reason": "לא נמצאה כמות בשרטוט – להשלמה ידנית", "quickAction": "measure_length"}, "itemCode": "9.07", "itemDescription": "תעלת ניקוז סמויה תחת הריצוף מסביב לבריכה", "unit": "מ\"א", "priority": 5, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_template_needs_input", "kind": "template_chapter", "match": {"chapters": ["02", "03", "04", "05", "06", "07", "08", "09"], "importedOnly": true}, "itemCode": null, "itemDescription": "סעיפי כתב הכמויות של הלקוח שלא חושבו – להשלמה ידנית", "unit": "יחידה", "priority": 1, "reasons": ["הצעה – לאשר ידנית"]} as RuleSeed,
  {"id": "r_lighting_circuit", "kind": "lighting_circuit", "match": {"wording": "auto", "includeTimer": true, "includeNoSwitch": true}, "itemCode": null, "itemDescription": "נק' מאור לפי מעגלי הדלקה", "unit": "יחידה", "priority": 250} as RuleSeed,
];
const SPRINT10_ITEM_SEEDS_TEXT = [
  { code: "4.29", description: "תוספת עבור אביזר מוגן מים", unit: "יח'", since: 3 } as const,
  { code: "4.30", description: "תוספת עבור שקע USB + TYPE C בקופסא קיימת", unit: "יח'", since: 3 } as const,
  { code: "4.31", description: "הזנה לתריס חשמלי", unit: "יח'", since: 3 } as const,
  { code: "4.32", description: "הזנה לגלאי עשן", unit: "יח'", since: 3 } as const,
  { code: "4.33", description: "אספקה והתקנת גלאי עשן", unit: "יח'", since: 3 } as const,
  { code: "4.34", description: "הזנה לסוכך חשמלי", unit: "יח'", since: 3 } as const,
  { code: "4.35", description: "הזנה משולבת לדוד שמש ולמכשיר חימום מים על הגג כולל פקט ומפסק", unit: "יח'", since: 3 } as const,
  { code: "4.36", description: "התקנת תנור חימום בחדר רחצה", unit: "יח'", since: 3 } as const,
  { code: "4.37", description: "אספקה והתקנת פעמון", unit: "יח'", since: 3 } as const,
  { code: "4.38", description: "אספקה והתקנת ונטה", unit: "יח'", since: 3 } as const,
  { code: "4.39", description: "שקע תלת פאזי למזגן", unit: "יח'", since: 3 } as const,
  { code: "4.40", description: "שקע תלת פאזי לכיריים אינדוקציה", unit: "יח'", since: 3 } as const,
  { code: "4.41", description: "שקע תלת פאזי לג'קוזי", unit: "יח'", since: 3 } as const,
  { code: "4.42", description: "הזנה תלת פאזית עבור שקע טעינה לרכב חשמלי", unit: "יח'", since: 3 } as const,
  { code: "4.43", description: "שקע תלת פאזי למכשיר חימום מים (היתרו)", unit: "יח'", since: 3 } as const,
  { code: "4.44", description: "שקע תלת פאזי לסאונה", unit: "יח'", since: 3 } as const,
  { code: "4.45", description: "הזנה תלת פאזית לחדר מכונות בריכה", unit: "יח'", since: 3 } as const,
  { code: "4.46", description: "צינור קוברה 32 מ\"מ", unit: "יח'", since: 3 } as const,
  { code: "4.47", description: "צינור מריכף 20 מ\"מ חופשי מהרצפה כהכנה", unit: "יח'", since: 3 } as const,
  { code: "4.48", description: "צינור הזנה עם חוט משיכה מלוח חשמל ראשי עד הגג – הכנה לפאנלים סולריים", unit: "יח'", since: 3 } as const,
  { code: "4.49", description: "אספקה והתקנת לוח חשמל ראשי", unit: "יח'", since: 3 } as const,
  { code: "4.50", description: "אספקה והתקנת לוח חשמל משני", unit: "יח'", since: 3 } as const,
  { code: "4.51", description: "אספקה והתקנת מונה משני בלוח חשמל", unit: "יח'", since: 3 } as const,
  { code: "4.52", description: "קופסת עומק למפסקים כוללת קו אפס נוסף", unit: "יח'", since: 3 } as const,
  { code: "4.53", description: "הכנה לבית חכם: קופסאות עומק וקו אפס נוסף לכל המפסקים", unit: "קומפלט", since: 3 } as const,
  { code: "4.71", description: "אביזר D18 הכולל 6 שקעים ושלושה צינורות נוספים עם חוט משיכה עד לארון תקשורת", unit: "יח'", since: 3 } as const,
  { code: "4.54", description: "התקנת מאוורר תקרה", unit: "יח'", since: 3 } as const,
  { code: "4.55", description: "התקנת פרופיל תאורה חיצוני עה\"ט", unit: "מ\"א", since: 3 } as const,
  { code: "4.56", description: "התקנת פרופיל תאורה שקוע בתקרת גבס", unit: "מ\"א", since: 3 } as const,
  { code: "4.72", description: "התקנת פרופיל תאורה חיצוני עה\"ט באורך לפי תכנית", unit: "יח'", since: 3 } as const,
  { code: "4.57", description: "אספקה והתקנת שקע קופץ באי מטבח", unit: "יח'", since: 3 } as const,
  { code: "4.58", description: "ביצוע הזנה חדשה מהפילר ועד לוח חשמל ראשי", unit: "יח'", since: 3 } as const,
  { code: "4.59", description: "ביצוע הזנה ראשית לסיב אופטי מהפילר ועד לוח תקשורת ראשי", unit: "יח'", since: 3 } as const,
  { code: "4.60", description: "אחריות להעברת ביקורת חברת חשמל", unit: "קומפלט", since: 3 } as const,
  { code: "4.61", description: "קו הזנה מלוח חשמל ראשי עד מחסן בגינה", unit: "יח'", since: 3 } as const,
  { code: "4.62", description: "נק' מאור בודדה ללא מפסק (אפס קבוע)", unit: "יח'", since: 3 } as const,
  { code: "4.63", description: "נק' מאור בודדה כוללת שלושה מפסקים מצלבים", unit: "יח'", since: 3 } as const,
  { code: "4.64", description: "שתי נק' מאור כוללות שני מפסקים מחליפים", unit: "יח'", since: 3 } as const,
  { code: "4.65", description: "שלוש נק' מאור כוללות מפסק טיימר משותף בלוח חשמל", unit: "יח'", since: 3 } as const,
  { code: "4.66", description: "שלוש נק' מאור כוללות שני מפסקים מחליפים עם אוטומט חדר מדרגות", unit: "יח'", since: 3 } as const,
  { code: "4.67", description: "נק' מאור בודדה", unit: "יח'", since: 3 } as const,
  { code: "4.68", description: "סט: שירשור שתי נק' מאור משותפות במעגל הדלקה אחד", unit: "סט", since: 3 } as const,
  { code: "4.69", description: "סט: שירשור שלוש נק' מאור משותפות במעגל הדלקה אחד", unit: "סט", since: 3 } as const,
  { code: "4.70", description: "סט: שירשור ארבע נק' מאור משותפות במעגל הדלקה אחד", unit: "סט", since: 3 } as const,
  { code: "3.25", description: "נק' הזנה למערכת השקיה", unit: "יח'", since: 3 } as const,
  { code: "3.35", description: "הזנת מים למכשיר חימום מים / היתרו", unit: "יח'", since: 3 } as const,
  { code: "5.09", description: "איטום חדר רחצה רטוב בשתי שכבות סיכה, כולל רולקות ובדיקת הצפה", unit: "חדר", since: 3 } as const,
  { code: "3.16", description: "נק' מים חמים קרים וניקוז לכיור מטבח, כולל התקנת ברז וסיפון", unit: "יח'", since: 3 } as const,
  { code: "3.17", description: "נק' מים קרים וניקוז לכיור מטבח חוץ", unit: "יח'", since: 3 } as const,
  { code: "3.18", description: "נק' למקלחון הכוללת הזנת חמים וקרים, שלוש יחידות אינטרפוץ 3 דרך, נק' מים ומזלף, ראש גשם ותעלת ניקוז", unit: "יח'", since: 3 } as const,
  { code: "3.19", description: "נק' למקלחון הכוללת הזנת חמים וקרים, אינטרפוץ 4 דרך, נק' מים ומזלף, ראש גשם וקופסת ניקוז", unit: "יח'", since: 3 } as const,
  { code: "3.20", description: "נק' למקלחון הכוללת הזנת חמים וקרים, שתי יחידות אינטרפוץ 3 דרך, נק' מים ומזלף, ראש גשם ותעלת ניקוז", unit: "יח'", since: 3 } as const,
  { code: "3.21", description: "נק' לאמבטיה הכוללת הזנות מים חמים קרים וניקוז, שלוש יחידות אינטרפוץ 3 דרך, מזלף, ראש גשם והתקנת האמבטיה", unit: "יח'", since: 3 } as const,
  { code: "3.22", description: "אספקה והתקנת מרכזיית מים ראשית", unit: "יח'", since: 3 } as const,
  { code: "3.23", description: "אספקה והתקנת מרכזיית מים משנית", unit: "יח'", since: 3 } as const,
  { code: "3.24", description: "הזנת מים בגג משולבת לדוד ולמכשיר חימום בגז", unit: "יח'", since: 3 } as const,
  { code: "3.26", description: "נק' מים למערכת גלגלון כיבוי אש", unit: "יח'", since: 3 } as const,
  { code: "3.27", description: "אספקה והתקנת מערכת גלגלון כיבוי אש", unit: "יח'", since: 3 } as const,
  { code: "3.28", description: "הזנת מים לבריכה לפי הנחיות קבלן הבריכות", unit: "יח'", since: 3 } as const,
  { code: "3.29", description: "ביצוע ניקוז לאדנית", unit: "יח'", since: 3 } as const,
  { code: "3.30", description: "הזנת מים וניקוז לסאונה", unit: "יח'", since: 3 } as const,
  { code: "3.31", description: "הזנת מים חמים וקרים למערכת טוש רצפתית בחצר, כולל התקנת המערכת", unit: "יח'", since: 3 } as const,
  { code: "3.32", description: "ביצוע מערכת ביוב חדשה לפי נספח סניטרי ותכניות האינסטלציה", unit: "קומפלט", since: 3 } as const,
  { code: "3.33", description: "חפירת ויציקת בור משאבה כולל חיבור הדלוחין ואספקת המשאבה", unit: "קומפלט", since: 3 } as const,
  { code: "3.34", description: "ביצוע קו הזנה ראשי חדש מהשעון", unit: "יח'", since: 3 } as const,
  { code: "5.10", description: "ריצוף פנים באריחי גרניט פורצלן כולל רובה אקרילית", unit: "מ\"ר", since: 3 } as const,
  { code: "5.11", description: "ריצוף חוץ באריחי גרניט פורצלן בטיט", unit: "מ\"ר", since: 3 } as const,
  { code: "5.12", description: "ריצוף אריחי סוג ב' כתשתית לפרקט", unit: "מ\"ר", since: 3 } as const,
  { code: "5.13", description: "חיפוי קירות חוץ באבן כולל כוחלה", unit: "מ\"ר", since: 3 } as const,
  { code: "5.14", description: "התקנת סף שיש (קופינג) לחלון כולל מילוי דבק שיש וליטוש", unit: "מ\"א", since: 3 } as const,
  { code: "5.15", description: "הדבקת פאנל שקוע לפי פרט כולל פרופיל ניתוק", unit: "מ\"א", since: 3 } as const,
  { code: "5.16", description: "איטום מרפסת / גג ביריעות ביטומניות מולחמות לרבות שיפועים ורולקות", unit: "מ\"ר", since: 3 } as const,
  { code: "5.17", description: "איטום קירות הבית במפגש עם הקרקע", unit: "קומפלט", since: 3 } as const,
  { code: "5.18", description: "איטום פתחי מערכות אלומיניום בשתי שכבות סיכה", unit: "קומפלט", since: 3 } as const,
  { code: "5.19", description: "ריצוף רצפת חדר כביסה באריחי גרניט פורצלן", unit: "מ\"ר", since: 3 } as const,
  { code: "2.04", description: "בניית קירות בלוק בטון לפי תכניות האדריכלות", unit: "מ\"ר", since: 3 } as const,
  { code: "2.05", description: "סגירת פתח חלון קיים בבלוק", unit: "יח'", since: 3 } as const,
  { code: "2.06", description: "יציקות בטון לפי תכניות ופרטי הקונסטרוקציה", unit: "קומפלט", since: 3 } as const,
  { code: "7.08", description: "מחיצות גבס לבן בעובי 10 ס\"מ כולל בידוד צמר סלעים", unit: "מ\"ר", since: 3 } as const,
  { code: "7.09", description: "בניית מחיצות גבס כחול נגד מים כולל בידוד צמר סלעים", unit: "מ\"ר", since: 3 } as const,
  { code: "7.10", description: "בניית נישה במחיצת גבס לפי תכנית", unit: "יח'", since: 3 } as const,
  { code: "7.11", description: "אספקה והתקנת פרופיל ניתוק STR במפגש תקרת גבס עם קירות", unit: "מ\"א", since: 3 } as const,
  { code: "7.12", description: "אספקה והתקנת פתח אופן ארט בגודל 60/60 ס\"מ", unit: "יח'", since: 3 } as const,
  { code: "7.13", description: "בניית סינר גבס בחתך לפי תכנית", unit: "מ\"א", since: 3 } as const,
  { code: "8.05", description: "שליכט צבעוני על קירות חוץ וחומות כולל טיח שחור ופריימר", unit: "קומפלט", since: 3 } as const,
  { code: "8.06", description: "צביעת משקוף ודלת ממ\"ד / מקלט בצבע על בסיס שמן", unit: "יח'", since: 3 } as const,
  { code: "9.04", description: "ביצוע חיזוקי עץ במחיצות גבס לפי תכנית", unit: "קומפלט", since: 3 } as const,
  { code: "9.05", description: "התקנת אביזרי חדרי רחצה", unit: "קומפלט", since: 3 } as const,
  { code: "9.06", description: "קידוח בור חלחול כולל שרוול, רשת וצלב הגנה", unit: "יח'", since: 3 } as const,
  { code: "9.07", description: "תעלת ניקוז סמויה תחת הריצוף מסביב לבריכה", unit: "מ\"א", since: 3 } as const,
];

/**
 * Default rule set (Sprint 3 brief "Domain rules"). Item codes follow the sample BOQ (chapter 04 + 9.01); when an
 * org's library lacks a code the worker may resolve the item by `itemDescription`. Rule ids are stable (seeding is
 * create-if-missing, so admin edits survive).
 */
export const DEFAULT_BOQ_RULES: readonly RuleSeed[] = Object.freeze([
  // --- sockets / comms / feeds (count by class) ---
  c2i('r_socket_single', ['socket_single'], '4.00', 'שקע בודד'),
  c2i('r_socket_double', ['socket_double'], '4.01', 'שקע כפול'),
  c2i('r_socket_triple', ['socket_triple'], '4.02', 'אביזר שלישיית שקעים'),
  c2i('r_socket_power', ['socket_power'], '4.03', 'שקע כח'),
  c2i('r_socket_power_double', ['socket_power_double'], '4.04', 'שקע כח כפול'),
  c2i('r_comms_point', ['tv_point', 'data_point', 'phone_point', 'bezek_point'], '4.05', "נק' תקשורת (כבלים/ טלפון/ רשת) הכנה עם חוט משיכה"),
  c2i('r_socket_box_6', ['socket_box_6'], '4.06', "אביזר עדה פלאסט הכולל 6 שקעים, נק' כבלים, נק' טלפון ונק' רשת"),
  c2i('r_speaker', ['speaker'], '4.07', "נק' קצה לרמקול"),
  c2i('r_heater_feed', ['heater_feed'], '4.17', 'הזנה לתנור חימום+ מפסק'),
  c2i('r_intercom', ['intercom'], '4.18', "נק' אינטרקום"),
  c2i('r_conduit_cobra', ['conduit_cobra'], '4.20', 'צינור קוברה 50 מ"מ באורך 1.5 מ\''),
  c2i('r_socket_3phase', ['socket_3phase'], '4.21', 'שקע תלת פאזי'),
  c2i('r_doorbell', ['doorbell'], '4.22', 'הזנה למפסק ופעמון'),
  c2i('r_water_heater_feed', ['water_heater_feed'], '4.23', 'הזנה לדוד חשמל יחידת דיור כולל התקנת מפסק טיימר של גוויס'),
  c2i('r_panel', ['panel'], '4.24', 'אספקה והתקנת לוח חשמל', 50, { reasons: [DEFAULT_RULE_REASON] }),
  // --- lighting composite lines (switch groups from kamutan.links/1) ---
  lighting('r_light_single', { groupKind: 'single', pointCount: 1 }, '4.09', "נק' מאור כוללת מפסק"),
  lighting('r_light_two_way', { groupKind: 'two_way', pointCount: 1 }, '4.10', "נק' מאור בעלת שני מפסקים מחליפים"),
  lighting('r_light_shared_2', { groupKind: 'shared', pointCount: 2 }, '4.11', "שתי נק' מאור משותפות בעלות מפסק בודד"),
  lighting('r_light_shared_3', { groupKind: 'shared', pointCount: 3 }, '4.16', 'שלוש נקודות מאור בעלות מפסק בודד'),
  lighting('r_light_add_2way', { groupKind: 'add_to_existing', switchClasses: ['switch_2way'] }, '4.12', 'הוספת מפסק מחליף לנקודת מאור קיימת'),
  lighting('r_light_add_fan', { groupKind: 'add_to_existing', switchClasses: ['switch_fan'] }, '4.14', "הוספת מפסק למאוורר עבור נק' מאור קיימת"),
  lighting('r_light_sensor', { groupKind: 'sensor' }, '4.15', "נק' מאור ללא מפסק (חיישן תנועה)"),
  // --- lighting install line ---
  {
    id: 'r_install_luminaires',
    kind: 'install_count',
    match: {
      classes: ['luminaire_ceiling', 'luminaire_wall', 'luminaire_pendant', 'luminaire_strip', 'luminaire_outdoor'],
      excludeClasses: ['ceiling_fan'],
      // Installation is labour even for client-supplied / existing fixture positions (sample: 43 = all positions − fans).
      excludeSupply: [],
      excludeLifecycle: ['demolish'],
    },
    itemCode: '9.01',
    itemDescription: 'התקנת גופי התאורה בבית',
    unit: 'יחידה',
    priority: 100,
  } as RuleSeed,
  // --- Sprint 4: plumbing points (chapter 03 of the sample) ---
  plumb('r_plumb_ac_drain', { fixtureClasses: ['ac_unit'], perRoom: false }, '3.01', 'ניקוז למזגן'),
  plumb('r_plumb_basin_wall_faucet', { fixtureClasses: ['fixture_basin', 'fixture_kitchen_sink'], withFaucetClasses: ['faucet_wall'], faucetRadiusMm: 600, perRoom: false }, '3.02', "נק' מים חמים קרים וניקוז לכיור, לרבות התקנת ברז קיר", 110),
  plumb('r_plumb_basin_flower_faucet', { fixtureClasses: ['fixture_basin', 'fixture_kitchen_sink'], withoutFaucetClasses: ['faucet_wall'], faucetRadiusMm: 600, perRoom: false }, '3.03', "נק' מים חמים קרים וניקוז לכיור, לרבות התקנת ברז פרח"),
  plumb('r_plumb_wc_concealed', { fixtureClasses: ['fixture_wc_concealed'], perRoom: false }, '3.04', "נק' מים וניקוז לניאגרה סמויה, לרבות ביטון הניאגרה, ותליית האסלה"),
  plumb('r_plumb_washing_machine', { fixtureClasses: ['fixture_washing_machine'], perRoom: false }, '3.05', "נק' מים וניקוז למכונת כביסה"),
  plumb('r_plumb_garden_tap', { fixtureClasses: ['garden_tap'], perRoom: false }, '3.06', "נק' מים קרים עבור תמי 4/ ברז גן"),
  plumb('r_plumb_wc_monoblock', { fixtureClasses: ['fixture_wc_monoblock'], perRoom: false }, '3.07', "נק' מים וניקוז עבור ניאגרה מונובלוק. העבודה תכלול התקנת ניאגרה, אסלה ומושב"),
  plumb('r_plumb_shower_basement', { fixtureClasses: ['fixture_shower'], floors: ['basement', '-1'], perRoom: true }, '3.13', "נק' מים חמים קרים וניקוז למקלחון מרתף", 120),
  plumb('r_plumb_shower', { fixtureClasses: ['fixture_shower'], roomTypes: ['bathroom', 'wc', 'other'], perRoom: true }, '3.11', "נק' מים חמים קרים וניקוז עבור מקלחון חדר רחצה"),
  plumb('r_plumb_bath', { fixtureClasses: ['fixture_bath'], perRoom: true }, '3.12', "נק' מים חמים קרים וניקוז לאמבטיה חדר רחצה"),
  // --- Sprint 4: one-off plumbing items: suggestions only (yellow until accepted) ---
  oneOff('r_oneoff_water_feed', { classes: PLUMBING_FIXTURES, textPatterns: ['הזנת מים', 'שעון מים'], quantity: 1 }, '3.08', 'הזנת מים חדשה מהשעון הראשי ועד הבית'),
  oneOff('r_oneoff_manifold', { classes: PLUMBING_FIXTURES, textPatterns: ['מרכזיית מים', 'מרכזיה'], quantity: 1 }, '3.09', 'אספקה והתקנה של מרכזיית מים עם ברזי שליטה נפרדים'),
  oneOff('r_oneoff_heater_feed', { classes: ['water_heater_feed'], textPatterns: ['דוד'], quantity: 1 }, '3.10', 'הזנת מים חדשה עבור דוד'),
  oneOff('r_oneoff_greywater_pump', { textPatterns: ['משאבה', 'דלוחין'], floors: ['basement', '-1'], roomTypes: WET, quantity: 1 }, '3.14', 'אספקה והתקנה של משאבה לניקוז דלוחין קומת מרתף'),
  oneOff('r_oneoff_rain_pump', { roomTypes: ['courtyard'], textPatterns: ['חצר אנגלית'], quantity: 1 }, '3.15', 'אספקה והתקנה של משאבה לניקוז מי גשם בחצר אנגלית'),
  // --- Sprint 4: tiling + waterproofing (chapter 05 of the sample) ---
  {
    id: 'r_tile_cladding_wet',
    kind: 'tiling_cladding',
    match: { roomTypes: WET, mode: 'full', subtractOpenings: true, defaultDoorHeightM: 2.1, defaultWindowSillM: 1.0, defaultWindowHeadM: 2.1, capAtCeiling: true, excludeNiches: true },
    itemCode: '5.01',
    itemDescription: 'חיפוי קירות חדרי רחצה באריחי קרמיקה',
    unit: 'מ"ר',
    priority: 100,
    wasteFactor: TILING_WASTE,
  } as RuleSeed,
  { id: 'r_tile_floor_wet', kind: 'tiling_floor', match: { roomTypes: WET, wetOnly: false, includeNiches: true }, itemCode: '5.02', itemDescription: 'ריצוף ריצפות חדרי רחצה וחצר אנגלית באריחי גרניט פורצלן', unit: 'מ"ר', priority: 100, wasteFactor: TILING_WASTE } as RuleSeed,
  { id: 'r_tile_corners', kind: 'tiling_corner', match: { roomTypes: WET }, itemCode: '5.03', itemDescription: 'חיתוך גרונג במפגש אריחי קרמיקה בפינות חיצוניות', unit: 'מ"א', priority: 100 } as RuleSeed,
  { id: 'r_waterproofing_wet', kind: 'waterproofing', match: { roomTypes: WET, wetOnly: true, requireFixtureClasses: ['fixture_shower', 'fixture_bath'] }, itemCode: '5.05', itemDescription: 'איטום ריצפות חדרי הרחצה בשתי שכבות סיכה', unit: 'קומפלט', priority: 100 } as RuleSeed,
  {
    id: 'r_tile_partial_kitchen',
    kind: 'tiling_cladding',
    match: { roomTypes: ['kitchen'], mode: 'partial', subtractOpenings: false },
    itemCode: '5.06',
    itemDescription: 'חיפוי קיר מטבח באריחי גרניט פורצלן',
    unit: 'מ"ר',
    priority: 100,
    wasteFactor: TILING_WASTE,
  } as RuleSeed,
  {
    id: 'r_tile_partial_other',
    kind: 'tiling_cladding',
    match: { roomTypes: ['wc', 'bathroom', 'living', 'corridor', 'other'], mode: 'partial', subtractOpenings: false },
    itemCode: '5.07',
    itemDescription: 'חיפוי קיר חלקי באריחי קרמיקה',
    unit: 'מ"ר',
    priority: 90,
    wasteFactor: TILING_WASTE,
  } as RuleSeed,
  // --- classes that never become BOQ lines (itemCode null = not counted); configurable: set an itemCode to count them ---
  // Sprint 4: faucets only qualify basin rules; tiling hatches are replaced by room-based tiling rules.
  ...(['waterproof_marker', 'note_point', 'breaker', 'legend_entry', 'legend_box', 'region', 'room', 'faucet_basin', 'faucet_wall', 'floor_tiling', 'wall_cladding'] as SymbolClass[]).map(
    (cls): RuleSeed =>
      ({ id: `r_none_${cls}`, kind: 'class_to_item', match: { classes: [cls] }, itemCode: null, itemDescription: 'לא נכלל בכתב הכמויות', unit: null, priority: 0 }) as RuleSeed,
  ),
  // --- cross-sheet authority (de-duplication) ---
  ...(
    [
      ['r_auth_sockets', 'sockets', ['socket_single', 'socket_double', 'socket_triple', 'socket_power', 'socket_power_double', 'socket_3phase', 'socket_box_6'], 'electrical'],
      ['r_auth_comms', 'comms', ['tv_point', 'data_point', 'phone_point', 'bezek_point', 'speaker', 'intercom', 'doorbell'], 'electrical'],
      ['r_auth_feeds', 'feeds', ['heater_feed', 'water_heater_feed', 'panel', 'conduit_cobra'], 'electrical'],
      ['r_auth_switches', 'switches', ['switch_single', 'switch_2way', 'switch_fan', 'switch_cross', 'switch_shutter'], 'lighting'],
      ['r_auth_luminaires', 'luminaires', ['luminaire_ceiling', 'luminaire_wall', 'luminaire_pendant', 'luminaire_strip', 'luminaire_outdoor', 'ceiling_fan'], 'lighting'],
      // Sprint 4: fixtures appear on architecture AND plumbing sheets → the plumbing sheet wins.
      ['r_auth_fixtures', 'fixtures', [...PLUMBING_FIXTURES, 'faucet_basin', 'faucet_wall', 'garden_tap'], 'plumbing'],
    ] as Array<[string, string, SymbolClass[], string]>
  ).map(
    ([id, family, classes, discipline]): RuleSeed =>
      ({ id, kind: 'authority', match: { family, classes, discipline, radiusMm: 150 }, itemCode: null, itemDescription: null, unit: null, priority: 0 }) as RuleSeed,
  ),
  // v5: AC positions — the plumbing sheet's drain marks are the plan of record; the electrical AC sockets only fill
  // floors without a plumbing sheet; copies matched per room (a drain mark and its socket are 0.3–1 m apart).
  {
    id: 'r_auth_ac',
    kind: 'authority',
    match: { family: 'ac', classes: ['ac_unit'], discipline: 'plumbing', radiusMm: 150, authorityOrder: ['plumbing', 'electrical'], matchRooms: true, roomMatchRadiusMm: 1600 },
    itemCode: null,
    itemDescription: null,
    unit: null,
    priority: 0,
  } as RuleSeed,
  // --- Sprint 6: text / equipment items (chapter 04 + 9.03) from notes, callouts, legend rows, panel schedules ---
  ...SPRINT6_RULES,
  // Stage 10 (A-pipeline-07): chapter 01 (demolition) items of the library offered as 1 קומפלט each when the project has
  // a demolition plan. New id → created by the create-if-missing seeding (no DEFAULT_BOQ_RULES_VERSION bump).
  {
    id: 'r_template_demolition',
    kind: 'template_chapter',
    match: { chapters: ['01'], disciplines: ['demolition'], quantity: 1 },
    itemCode: null,
    itemDescription: 'סעיפי הריסה ופינוי מהתבנית',
    unit: 'קומפלט',
    priority: 10,
    reasons: [ONE_OFF_SUGGESTION_REASON],
  } as RuleSeed,
  // Sprint 10 (Worker-BOQ + Worker-Lighting): every line type of the designer's catalogue (label-qualified feeds,
  // 3-phase, panels, conduits; marker add-ons; count-only installs; plumbing variants; text items; "להשלמה ידנית"
  // fallbacks) + the one lighting_circuit rule. A default Sprint-10 rule whose item the org's library lacks is skipped.
  ...SPRINT10_RULES,
]);

/**
 * Version of the shipped default rule set. Bump whenever DEFAULT_BOQ_RULES changes: seeding then REPLACES every rule doc
 * with `source: 'default'` and an older `defaultsVersion` (never `user` / `custom` docs) and creates missing ones.
 * 2 = Sprint 3 integration (9.01 excludes only demolished; r_none_* rules).
 * 3 = Sprint 4 (plumbing points 3.01–3.07/3.11–3.13, one-off suggestions 3.08–3.10/3.14/3.15, tiling 5.01–5.03/5.05–5.07,
 *     fixture + AC authority).
 * 4 = Sprint 4 integration (Data back-solve): cladding capped at ceiling height, niches not clad, door 2.1 m, window
 *     sill 1.0 / head 2.1, floor tiling = bathrooms + WCs incl. niches, waterproofing only rooms with shower/bath.
 * 5 = Sprint 4 final: AC authority = plumbing sheet per floor (electrical fills floors without one), room-aware matching
 *     (`r_auth_ac` authorityOrder / matchRooms / roomMatchRadiusMm). Floor tiling stays bathrooms + WCs: the English
 *     courtyard is OUT by default (the sample 5.02 text names it, but its quantity matches without it — GT-D-007 open;
 *     a user adds it with a measure correction or a courtyard roomSettings doc + a rule edit).
 * 6 = Sprint 6: text_item / area_item / length_item / suggested_item rules for 2.01–2.03, 4.08, 4.19, 4.25–4.28,
 *     5.04, 5.06–5.08 (geometry + suggested fallbacks), 7.01–7.07, 8.01–8.04, 9.03 (`SPRINT6_RULES`).
 * 7 = Sprint 6 Worker-BOQ requests: 2.02 trigger + `גרם מדרגות`; 8.02 / 9.03 wording closer to trade wording (library
 *     resolution of imported items needs similarity ≥ 0.45); documented `CONSUME_NEAR_MAX_MM` and non-computable →
 *     needsInput. 7.04 unchanged (counts explicit service-opening notes only; open).
 * 8 = owner decision 05.11: 7.06 gypsum partitions = length × full storey height × both faces (`faces: 2`,
 *     `heightMode: 'storey'`; a lining against a wall counts one face, a low wall keeps its drawn height). 7.07 unchanged.
 * 9 = Sprint 10: the designer's full catalogue (`SPRINT10_RULES`: kinds marker_addon / lighting_circuit, class_to_item
 *     label filters / countOnly / params, plumbing label variants; generic items of library v3).
 */
export const DEFAULT_BOQ_RULES_VERSION = 9;

/** A seeded rule doc. */
export const defaultRuleDoc = (r: RuleSeed): Omit<BoqRule, 'updatedAt' | 'updatedBy'> =>
  ({ ...r, enabled: r.enabled ?? true, source: 'default', defaultsVersion: DEFAULT_BOQ_RULES_VERSION }) as Omit<BoqRule, 'updatedAt' | 'updatedBy'>;

/** True when a stored rule must be (re)seeded from the shipped defaults. */
export const ruleNeedsReseed = (stored: { source?: string; defaultsVersion?: number } | null | undefined): boolean =>
  !stored || (stored.source === 'default' && (stored.defaultsVersion ?? 0) < DEFAULT_BOQ_RULES_VERSION);

// ---------------------------------------------------------------------------
// Stage 10 (A-LIVE-01): default item library
// ---------------------------------------------------------------------------

/**
 * Version of the shipped default item library. Seeded per org when its library is EMPTY (org bootstrap, and lazily
 * before a BOQ build / export / library or template read for orgs created before Stage 10); never re-seeded once the
 * org has any item. 1 = Stage 10. 2 = Sprint 6: items of chapters 02, 06 (gypsum, 7.xx), 07 (plaster & paint, 8.xx) and
 * the new 04 / 05 / 09 codes; each item carries the version that introduced it (`defaultsVersion`). Orgs that HAVE the
 * default library (any `source: 'default'` item) get the newer items added (`planDefaultLibrarySeed`): create-if-missing
 * by id, skipping codes the org already has (an import or a manual item of that code wins).
 */
export const DEFAULT_ITEM_LIBRARY_VERSION = 3;

/** Units used by the defaults (Hebrew trade abbreviations). */
export const DEFAULT_UNITS = Object.freeze({
  count: "יח'",
  area: 'מ"ר',
  length: 'מ"א',
  lumpSum: 'קומפלט',
  /** Sprint 10: per wet room (waterproofing "לחדר רחצה רטוב"). */
  room: 'חדר',
  /** Sprint 10: a lighting chain ("סט: שירשור N נק' מאור"). */
  set: 'סט',
});

type DefaultItemSeed = { code: string; description: string; unit: string; since?: number };
const U = DEFAULT_UNITS;

/**
 * Generic trade items (no client names, prices or project data). Codes and units follow `DEFAULT_BOQ_RULES` (every
 * rule with an `itemCode` has exactly one item of that code, with the rule's description or a brand-free wording of
 * it), plus chapter 01 demolition items offered as one lump sum each (A-pipeline-07).
 */
const DEFAULT_ITEM_SEEDS: readonly DefaultItemSeed[] = [
  // 01 — demolition (offered as 1 קומפלט each)
  { code: '1.01', description: 'פירוק ריצוף קיים כולל שכבת המילוי, לרבות פינוי', unit: U.lumpSum },
  { code: '1.02', description: 'פירוק חיפוי קירות קיים בחדרי רחצה ובמטבח, לרבות פינוי', unit: U.lumpSum },
  { code: '1.03', description: 'פירוק כלים סניטריים, ברזים וצנרת גלויה קיימים', unit: U.lumpSum },
  { code: '1.04', description: 'פירוק מטבח קיים, לרבות ארונות ומשטח עבודה', unit: U.lumpSum },
  { code: '1.05', description: 'הריסת קירות ומחיצות לפי תכנית ההריסה', unit: U.lumpSum },
  { code: '1.06', description: 'פירוק דלתות ומשקופים קיימים', unit: U.lumpSum },
  { code: '1.07', description: 'פירוק נקודות חשמל, תאורה ותקשורת קיימות שאינן נשמרות', unit: U.lumpSum },
  { code: '1.08', description: 'חציבות ופתיחת מעברים לצנרת ולתשתיות חדשות', unit: U.lumpSum },
  { code: '1.09', description: 'פינוי פסולת בניין לאתר פסולת מורשה', unit: U.lumpSum },
  { code: '1.10', description: 'ניקיון כללי בסיום עבודות ההריסה', unit: U.lumpSum },
  // 03 — plumbing (rules r_plumb_* / r_oneoff_*)
  { code: '3.01', description: 'ניקוז למזגן', unit: U.count },
  { code: '3.02', description: "נק' מים חמים קרים וניקוז לכיור, לרבות התקנת ברז קיר", unit: U.count },
  { code: '3.03', description: "נק' מים חמים קרים וניקוז לכיור, לרבות התקנת ברז פרח", unit: U.count },
  { code: '3.04', description: "נק' מים וניקוז לניאגרה סמויה, לרבות ביטון הניאגרה, ותליית האסלה", unit: U.count },
  { code: '3.05', description: "נק' מים וניקוז למכונת כביסה", unit: U.count },
  { code: '3.06', description: "נק' מים קרים עבור מתקן מים/ ברז גן", unit: U.count },
  { code: '3.07', description: "נק' מים וניקוז עבור ניאגרה מונובלוק. העבודה תכלול התקנת ניאגרה, אסלה ומושב", unit: U.count },
  { code: '3.08', description: 'הזנת מים חדשה מהשעון הראשי ועד הבית', unit: U.lumpSum },
  { code: '3.09', description: 'אספקה והתקנה של מרכזיית מים עם ברזי שליטה נפרדים', unit: U.lumpSum },
  { code: '3.10', description: 'הזנת מים חדשה עבור דוד', unit: U.lumpSum },
  { code: '3.11', description: "נק' מים חמים קרים וניקוז עבור מקלחון חדר רחצה", unit: U.count },
  { code: '3.12', description: "נק' מים חמים קרים וניקוז לאמבטיה חדר רחצה", unit: U.count },
  { code: '3.13', description: "נק' מים חמים קרים וניקוז למקלחון מרתף", unit: U.count },
  { code: '3.14', description: 'אספקה והתקנה של משאבה לניקוז דלוחין קומת מרתף', unit: U.lumpSum },
  { code: '3.15', description: 'אספקה והתקנה של משאבה לניקוז מי גשם בחצר אנגלית', unit: U.lumpSum },
  // 04 — electrical (rules r_socket_* / r_comms_point / feeds / panel / lighting composites)
  { code: '4.00', description: 'שקע בודד', unit: U.count },
  { code: '4.01', description: 'שקע כפול', unit: U.count },
  { code: '4.02', description: 'אביזר שלישיית שקעים', unit: U.count },
  { code: '4.03', description: 'שקע כח', unit: U.count },
  { code: '4.04', description: 'שקע כח כפול', unit: U.count },
  { code: '4.05', description: "נק' תקשורת (כבלים/ טלפון/ רשת) הכנה עם חוט משיכה", unit: U.count },
  { code: '4.06', description: "אביזר משולב הכולל 6 שקעים, נק' כבלים, נק' טלפון ונק' רשת", unit: U.count },
  { code: '4.07', description: "נק' קצה לרמקול", unit: U.count },
  { code: '4.09', description: "נק' מאור כוללת מפסק", unit: U.count },
  { code: '4.10', description: "נק' מאור בעלת שני מפסקים מחליפים", unit: U.count },
  { code: '4.11', description: "שתי נק' מאור משותפות בעלות מפסק בודד", unit: U.count },
  { code: '4.12', description: 'הוספת מפסק מחליף לנקודת מאור קיימת', unit: U.count },
  { code: '4.14', description: "הוספת מפסק למאוורר עבור נק' מאור קיימת", unit: U.count },
  { code: '4.15', description: "נק' מאור ללא מפסק (חיישן תנועה)", unit: U.count },
  { code: '4.16', description: 'שלוש נקודות מאור בעלות מפסק בודד', unit: U.count },
  { code: '4.17', description: 'הזנה לתנור חימום+ מפסק', unit: U.count },
  { code: '4.18', description: "נק' אינטרקום", unit: U.count },
  { code: '4.20', description: 'צינור קוברה 50 מ"מ באורך 1.5 מ\'', unit: U.count },
  { code: '4.21', description: 'שקע תלת פאזי', unit: U.count },
  { code: '4.22', description: 'הזנה למפסק ופעמון', unit: U.count },
  { code: '4.23', description: 'הזנה לדוד חשמל יחידת דיור כולל התקנת מפסק טיימר', unit: U.count },
  { code: '4.24', description: 'אספקה והתקנת לוח חשמל', unit: U.count },
  // 05 — tiling / cladding / waterproofing (rules r_tile_* / r_waterproofing_wet)
  { code: '5.01', description: 'חיפוי קירות חדרי רחצה באריחי קרמיקה', unit: U.area },
  { code: '5.02', description: 'ריצוף ריצפות חדרי רחצה וחצר אנגלית באריחי גרניט פורצלן', unit: U.area },
  { code: '5.03', description: 'חיתוך גרונג במפגש אריחי קרמיקה בפינות חיצוניות', unit: U.length },
  { code: '5.05', description: 'איטום ריצפות חדרי הרחצה בשתי שכבות סיכה', unit: U.lumpSum },
  { code: '5.06', description: 'חיפוי קיר מטבח באריחי גרניט פורצלן', unit: U.area },
  { code: '5.07', description: 'חיפוי קיר חלקי באריחי קרמיקה', unit: U.area },
  // 09 — lighting installation (rule r_install_luminaires)
  { code: '9.01', description: 'התקנת גופי התאורה בבית', unit: U.count },
  // --- Sprint 6 (library v2) ---
  // 02 — construction
  { code: '2.01', description: 'יציקת קירות תומכים מבטון מזוין לפי הנחיות הקונסטרוקטור', unit: U.area, since: 2 },
  { code: '2.02', description: 'יציקת רצפה ומדרגות בטון לפי הנחיות הקונסטרוקטור', unit: U.lumpSum, since: 2 },
  { code: '2.03', description: 'סגירת פתח קיים בבנייה בבלוקים', unit: U.area, since: 2 },
  // 04 — electrical text / equipment items
  { code: '4.08', description: 'צינור ריק מהרצפה כהכנה לשקעי שירות באי המטבח', unit: U.count, since: 2 },
  { code: '4.19', description: 'הזנה למפוח אוורור (ונטה) כולל מפסק', unit: U.count, since: 2 },
  { code: '4.25', description: 'אספקה והתקנת לוח תקשורת', unit: U.count, since: 2 },
  { code: '4.26', description: 'החלפת מפסק דוד קיים במפסק טיימר', unit: U.count, since: 2 },
  { code: '4.27', description: 'צינור קוברה 50 מ"מ לנקודת מקרן בתקרה', unit: U.count, since: 2 },
  { code: '4.28', description: 'אספקה והתקנת לוח חשמל 36 מודולים', unit: U.count, since: 2 },
  // 05 — tiling / waterproofing
  { code: '5.04', description: 'ריצוף מדרגות במדרכי אבן (שלח ורום)', unit: U.count, since: 2 },
  { code: '5.08', description: 'איטום קירות חצר אנגלית לפי הנחיות יועץ האיטום', unit: U.lumpSum, since: 2 },
  // 06 — gypsum (codes 7.xx, template chapter 06)
  { code: '7.01', description: 'תקרת גבס לפי תכנית התקרה', unit: U.area, since: 2 },
  { code: '7.02', description: 'סינר גבס כמסתור לציוד (מפוח / מזגן)', unit: U.length, since: 2 },
  { code: '7.03', description: 'סגירה פנימית בגבס של פתח או חלון קיים', unit: U.area, since: 2 },
  { code: '7.04', description: 'אספקה והתקנה של פתח שירות בתקרת גבס', unit: U.count, since: 2 },
  { code: '7.05', description: 'סינר גבס מסתור לווילון', unit: U.length, since: 2 },
  { code: '7.06', description: 'מחיצות גבס עם בידוד צמר סלעים', unit: U.area, since: 2 },
  { code: '7.07', description: 'מחיצות גבס כפולות (דו קרומיות) עם בידוד צמר סלעים', unit: U.area, since: 2 },
  // 07 — plaster, putty & paint (codes 8.xx, template chapter 07)
  { code: '8.01', description: 'תיקוני טיח ושפכטל לאחר עבודות הריסה ופירוק', unit: U.lumpSum, since: 2 },
  { code: '8.02', description: 'שתי שכבות טיח על קירות חצר אנגלית וקירות בלוק חדשים', unit: U.area, since: 2 },
  { code: '8.03', description: 'צביעת פנים הבית בצבע אקרילי', unit: U.lumpSum, since: 2 },
  { code: '8.04', description: 'החלקת קירות ותקרות בשפכטל בשלוש שכבות', unit: U.lumpSum, since: 2 },
  // 09 — misc
  { code: '9.03', description: 'התקנת צינור אוורור 4" למפוח ונטה', unit: U.count, since: 2 },
  // --- Sprint 10 (library v3): generic items of every new line type (a client import overrides by description)
  ...SPRINT10_ITEM_SEEDS_TEXT,
];

/** Chapter of a default item: the template chapter whose `codePrefixes` contain the code's major (7.01 → 06), else the major padded. */
const chapterOfCode = (code: string): string => {
  const major = code.split('.')[0] ?? code;
  return defaultTemplate.chapters.find((c) => c.codePrefixes?.includes(major))?.code ?? major.padStart(2, '0');
};
const titleOfChapter = (ch: string): string => defaultTemplate.chapters.find((c) => c.code === ch)?.title ?? `פרק ${ch}`;

/** The shipped default item library (doc ids = `itemIdFor(code, description)`; `source: 'default'`). */
export const DEFAULT_ITEM_LIBRARY: readonly Omit<ItemLibraryItem, 'updatedAt' | 'updatedBy'>[] = Object.freeze(
  DEFAULT_ITEM_SEEDS.map((s) =>
    Object.freeze({
      id: itemIdFor(s.code, s.description),
      code: s.code,
      chapter: chapterOfCode(s.code),
      chapterTitle: titleOfChapter(chapterOfCode(s.code)),
      description: s.description,
      unit: s.unit,
      tags: ['ברירת מחדל'],
      source: 'default' as const,
      sourceRef: `kamutan-defaults/library-v${s.since ?? 1}`,
      active: true,
      defaultsVersion: s.since ?? 1,
    }),
  ),
);

/**
 * Sprint 6: which default items to create for an org (pure; both repository drivers use it).
 *  - empty library → every item;
 *  - the org has the default library (`hasDefault`: ≥ 1 item with `source: 'default'`) → items not stored yet (by id)
 *    whose code the org does not have yet (`takenCodes`: codes of ANY stored item — an import / manual item wins);
 *  - otherwise (library built only from imports / manual items) → nothing.
 * Idempotent: a second call creates nothing; deactivated items stay deactivated (they exist).
 */
export function planDefaultLibrarySeed(state: { empty: boolean; hasDefault: boolean; existingIds: ReadonlySet<string>; takenCodes: ReadonlySet<string> }): Array<Omit<ItemLibraryItem, 'updatedAt' | 'updatedBy'>> {
  if (state.empty) return [...DEFAULT_ITEM_LIBRARY];
  if (!state.hasDefault) return [];
  return DEFAULT_ITEM_LIBRARY.filter((it) => !state.existingIds.has(it.id) && !state.takenCodes.has(it.code));
}

/** Items introduced after library v1 (the ones an org with the v1 default library is topped up with). */
export const DEFAULT_ITEM_LIBRARY_ADDITIONS: readonly Omit<ItemLibraryItem, 'updatedAt' | 'updatedBy'>[] = Object.freeze(
  DEFAULT_ITEM_LIBRARY.filter((it) => (it.defaultsVersion ?? 1) > 1),
);

/** Unit of the default library item / rule for a unit kind (worker fallback when a line has no library item). */
export function defaultUnitFor(ruleUnit: string | null | undefined): string {
  if (!ruleUnit) return U.count;
  const u = ruleUnit.trim();
  if (u === U.room || u === U.set) return u;
  if (['יחידה', "יח'", 'יח', 'unit'].includes(u)) return U.count;
  if (['מ"ר', 'm2', 'מ״ר'].includes(u)) return U.area;
  if (['מ"א', "מ'", 'm', 'מ״א'].includes(u)) return U.length;
  return u;
}
