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
import { ChapterCodeSchema, ItemCodeSchema, LIFECYCLES, LinkGroupKindSchema, SUPPLY_KINDS } from './boq.js';
import { DocIdSchema, UidSchema } from './org.js';
import { JobProgressSchema, JobStatusSchema, LIBRARY_IMPORT_KINDS } from './jobs.js';
import { sha256Hex } from './sha256.js';
import { DisciplineSchema, ProcessingErrorSchema } from './sheets.js';
import { SymbolClassSchema, type SymbolClass } from './taxonomy.js';
import { RoomTypeSchema, type RoomType } from './understanding.js';

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

export const ITEM_SOURCES = ['import', 'manual'] as const;

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
});
export type ItemLibraryItem = z.infer<typeof ItemLibraryItemSchema>;

const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');

export const ListLibraryItemsQuerySchema = z.object({
  orgId: DocIdSchema,
  chapter: ChapterCodeSchema.optional(),
  active: boolQuery.optional(),
  /** Case-insensitive substring of code or description. */
  q: z.string().trim().min(1).max(100).optional(),
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
] as const;
export const BoqRuleKindSchema = z.enum(BOQ_RULE_KINDS);
export type BoqRuleKind = z.infer<typeof BoqRuleKindSchema>;

const ClassesSchema = z.array(SymbolClassSchema).min(1).max(32);

/** Every detection of one of `classes` counts 1 toward the rule's item. */
export const ClassToItemMatchSchema = z.object({ classes: ClassesSchema }).strict();

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
  })
  .strict();
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
export const DEFAULT_BOQ_TEMPLATE_NAME = 'תבנית ברירת מחדל (לפי כתב הכמויות לדוגמה)';

/** Structure of the client's sample BOQ (sheet "כמויות"), notes as in the file (whitespace normalised). */
const defaultTemplate: Omit<BoqTemplate, 'updatedAt' | 'updatedBy'> = {
  id: DEFAULT_BOQ_TEMPLATE_ID,
  name: DEFAULT_BOQ_TEMPLATE_NAME,
  default: true,
  source: 'default',
  sourceRef: 'boq_sample.xls#כמויות',
  vatRate: 0.18,
  titleRows: ['כתב כמויות ומחירים', 'שם הפרויקט: {projectName}'],
  columns: [
    { key: 'code', title: 'סעיף', width: 8 },
    { key: 'description', title: 'תאור העבודה', width: 60 },
    { key: 'unit', title: 'יחידה', width: 10 },
    { key: 'qty', title: 'כמות סה"כ', width: 11 },
    { key: 'unitPrice', title: "מחיר יח'", width: 11 },
    { key: 'total', title: 'סה"כ ₪', width: 14 },
  ],
  chapters: [
    { code: '01', title: 'פרק 01 - עבודות הריסה ופינוי', notes: ['1. כלל הפינויים יהיו לשפך העירייה.'], codePrefixes: ['1'] },
    {
      code: '02',
      title: 'פרק 02 - עבודות בנייה',
      notes: [
        '1. כל הבלוקים בטון שחור.',
        '2. העבודה כוללת שטרבות, עמודונים, קורות וחגורות בטון ע"פ תקן ומסביב לפתחים.',
        '3. הקבלן יספק את הבלוקים והחומר השחור.',
        '4. כלל העבודות ההנדסיות ייעשו בהתאם להוראות המהנדס בלבד (!) לרבות כמות וסוג הזיון, וסוג הבטון.',
      ],
      codePrefixes: ['2'],
    },
    {
      code: '03',
      title: 'פרק 03 – עבודות אינסטלציה',
      notes: [
        '1. כלל צנרות המים יהיו מתוצרת SP ובעלי מחברי לחיצה (לא הברגה!)',
        '2. ברזי ניל יסופקו ע"י הקבלן',
        "3. העבודה כוללת התקנת כלל כיורים, ברזים תעלות ניקוז, אינטרפוצים, אסלות וכד'",
        '4. העבודה תכלול ביטון כלל הצנרות',
      ],
      codePrefixes: ['3'],
    },
    {
      code: '04',
      title: 'פרק 04 – עבודות חשמל',
      notes: [
        '1. כל העבודות יבוצעו בהתאם למפרט הסטנדרטי הבין משרדי לעבודות חשמל ע"י חשמלאי מוסמך.',
        '2. תמחור כלל עבודות יתבצע על בסיס תכניות החשמל.',
        '3. לכמויות ופרוט ראה תכניות חשמל מצורפות.',
        '4. יש לקרוא פירוט זה בקפידה וביחד עם תכנית חשמל ותאורה',
        '7. התכנית אינה כוללת התייחסות למערכת אזעקה.',
      ],
      codePrefixes: ['4'],
    },
    {
      code: '05',
      title: 'פרק 05 - עבודות ריצוף, חיפוי ואיטום',
      notes: [
        '1. האריחים בלבד יסופקו ע"י המזמין.',
        '2. חיבורי הפינות יהיו בגרונג בלבד ולא עם פינות מתכת!',
        '3. ריצוף וחיפוי יבוצע על פי תכנית פריסות חדרי רחצה.',
        '4. יש למלא רובה אקרילית בגווני האריח תוצרת מפאי, אלא אם התבקש אחרת.',
        '5. יש להקפיד על שיפועים במקלחון, במדפים, ספסלים ונישות בתוך המקלחון .',
        "7. כל החומר השחור - חול, מלט לבן, רובה וכ'ו יסופקו ע\"י הקבלן כולל אביזרי עזר כגון שומרי מרחק.",
        '8. העבודה כוללת כיסוי הרצפות החדשות בקרטון גלי או חומר אחר עד גמר העבודה.',
        '9. העבודה כוללת שינוע כלל החומר הלבן מהמדרכה אל תוך הבית',
      ],
      codePrefixes: ['5'],
    },
    {
      code: '06',
      title: 'פרק 06 - עבודות גבס',
      notes: [
        '1. יש לעבוד עם פינות מתכת ולא פינות נייר.',
        '2. יש לשתול מסגרות מעץ לחיזוק סביב המקומות המיועדים למשקופי הדלתות.',
        "3. יש להתקין בקירות הגבס חיזוקים לתלית אביזרים כגון טלויזיה, מדפים, מתלה מגבות וכ'ו",
        '4. כלל הקירות יהיו מלוחות גבס ירוק נגד מים.',
        '5. בכלל מחיצות הגבס יותקנו מזרוני צמר סלעים עטוף בניילון 80 ק"ג למ"ק עם מקדם בליעה אקוסטי.',
      ],
      codePrefixes: ['7'],
    },
    {
      code: '07',
      title: 'פרק 07 - עבודות שפכטל, טיח וצבע',
      notes: [
        '1. העבודה כוללת את כל ההכנות הנדרשות לביצוע עבודות הצבע לפי הוראות היצרן, כולל מספר שכבות הצבע הנדרשות.',
        '3. לפני תחילת העבודה יש לשים מסקנטייפ על כל הפנלים ועל כל הסרגלים בצורה מוקפדת.',
      ],
      codePrefixes: ['8'],
    },
    { code: '08', title: 'פרק 08- שונות', notes: [], codePrefixes: ['9'] },
  ],
};
export const DEFAULT_BOQ_TEMPLATE: Readonly<Omit<BoqTemplate, 'updatedAt' | 'updatedBy'>> = Object.freeze(defaultTemplate);

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
 */
export const DEFAULT_BOQ_RULES_VERSION = 5;

/** A seeded rule doc. */
export const defaultRuleDoc = (r: RuleSeed): Omit<BoqRule, 'updatedAt' | 'updatedBy'> =>
  ({ ...r, enabled: r.enabled ?? true, source: 'default', defaultsVersion: DEFAULT_BOQ_RULES_VERSION }) as Omit<BoqRule, 'updatedAt' | 'updatedBy'>;

/** True when a stored rule must be (re)seeded from the shipped defaults. */
export const ruleNeedsReseed = (stored: { source?: string; defaultsVersion?: number } | null | undefined): boolean =>
  !stored || (stored.source === 'default' && (stored.defaultsVersion ?? 0) < DEFAULT_BOQ_RULES_VERSION);
