/**
 * Sprint 15 — "סעיפים שלא זוהו" (docs/spec/11_missing_items_worklist.md).
 *
 * The reverse of the review queue: BOQ lines of the org library / template that the pipeline did NOT find (no line, or
 * a line with an effective quantity of 0), so the owner can mark them on the drawing, declare them "לא רלוונטי בפרויקט
 * הזה", or teach the system.
 *
 * Firestore: orgs/{o}/projects/{p}/boqExclusions/{exclusionId} (`exclusionIdFor(code)`) — API-written only (editor+,
 * audited `boqExclusions/exclude|restore`), member-readable. The worker never touches it, so a rebuild cannot overwrite
 * a human decision (UX principle 5: human beats machine). The doc is soft: a restore keeps it with `active: false`
 * (who excluded / who restored, when).
 *
 * Everything below is pure (no I/O): the API, the web mock and the tests share `computeMissingItems` /
 * `isLineExcluded` / `withoutExcludedLines`.
 */
import { z } from 'zod';
import { TimestampSchema } from './common.js';
import { chapterKey, compareItemCodes, effectiveQty, ItemCodeSchema, QuickActionKindSchema, defaultQuickActionFor, type BoqLine, type QuickActionKind } from './boq.js';
import { DocIdSchema, UidSchema } from './org.js';
import { sha256Hex } from './sha256.js';
import { SymbolClassSchema } from './taxonomy.js';

// ---------------------------------------------------------------------------
// Exclusion document
// ---------------------------------------------------------------------------

export const EXCLUSION_REASON_MAX = 200;

/**
 * Deterministic exclusion doc id of an item code: `ex_` + code with every char outside [A-Za-z0-9_-] replaced by "-" +
 * `_` + first 8 hex chars of sha256(code). Codes may contain "." and "/" ("4.10", "A/1"), which are not valid in a
 * document id; the hash keeps "4.1" and "4-1" apart.
 */
export function exclusionIdFor(code: string): string {
  const c = code.trim();
  return `ex_${c.replace(/[^A-Za-z0-9_-]/g, '-')}_${sha256Hex(c).slice(0, 8)}`;
}

/** orgs/{o}/projects/{p}/boqExclusions/{exclusionId} (DTO = doc + id). */
export const BoqExclusionSchema = z.object({
  id: DocIdSchema,
  /** The BOQ item code the decision is about (a project line / library item of that code). */
  code: ItemCodeSchema,
  /** Display snapshot at the time of the decision (the library may change later). */
  description: z.string().max(2000),
  unit: z.string().max(32),
  chapter: z.string().max(32),
  /** true = the item is "לא רלוונטי בפרויקט הזה"; false = restored (kept for the history). */
  active: z.boolean(),
  excludedBy: UidSchema,
  excludedAt: TimestampSchema,
  /** Short free text, never copied into the audit log. */
  reason: z.string().max(EXCLUSION_REASON_MAX).nullable().optional(),
  restoredBy: UidSchema.nullable().optional(),
  restoredAt: TimestampSchema.nullable().optional(),
});
export type BoqExclusion = z.infer<typeof BoqExclusionSchema>;

/** POST /v1/projects/:pid/boq/exclusions (editor+): idempotent set — `excluded: true` excludes, `false` restores. */
export const SetBoqExclusionRequestSchema = z
  .object({
    code: ItemCodeSchema,
    excluded: z.boolean(),
    reason: z.string().trim().max(EXCLUSION_REASON_MAX).optional(),
  })
  .strict();
export type SetBoqExclusionRequest = z.infer<typeof SetBoqExclusionRequestSchema>;

export const SetBoqExclusionResponseSchema = z.object({
  exclusion: BoqExclusionSchema,
  /** false when the item was already in the requested state (no write, no audit event). */
  changed: z.boolean(),
});
export type SetBoqExclusionResponse = z.infer<typeof SetBoqExclusionResponseSchema>;

// ---------------------------------------------------------------------------
// Missing-items list
// ---------------------------------------------------------------------------

/** "הכל / בפרויקט / לא רלוונטי". `in_project` = still open (could belong to the project); `not_relevant` = excluded. */
export const MISSING_ITEM_FILTERS = ['all', 'in_project', 'not_relevant'] as const;
export const MissingItemFilterSchema = z.enum(MISSING_ITEM_FILTERS);
export type MissingItemFilter = z.infer<typeof MissingItemFilterSchema>;

export const MISSING_FILTER_HE: Readonly<Record<MissingItemFilter, string>> = Object.freeze({ all: 'הכל', in_project: 'בפרויקט', not_relevant: 'לא רלוונטי' });

/** `no_line` = the item has no line in the project's BOQ; `zero_line` = it has a line whose effective quantity is 0. */
export const MISSING_ITEM_ORIGINS = ['no_line', 'zero_line'] as const;
export const MissingItemOriginSchema = z.enum(MISSING_ITEM_ORIGINS);
export type MissingItemOrigin = z.infer<typeof MissingItemOriginSchema>;

export const MissingItemSchema = z.object({
  /** Stable key of the row = `exclusionIdFor(code)` (= the id of its exclusion doc). */
  id: DocIdSchema,
  code: ItemCodeSchema,
  chapter: z.string().max(32),
  /** Template chapter title when the template knows the chapter, else "פרק {chapter}". */
  chapterTitle: z.string().max(200),
  description: z.string().max(2000),
  unit: z.string().max(32),
  origin: MissingItemOriginSchema,
  /** The zero-quantity line (first by id) when `origin = zero_line`. */
  lineId: DocIdSchema.nullable(),
  /** Library item behind the row (null when only a line exists). */
  itemId: DocIdSchema.nullable(),
  state: z.enum(['open', 'not_relevant']),
  /** The tool "סמן בשרטוט" starts: count / measure_area / measure_length; `confirm` (lump sum) has none → null. */
  markKind: QuickActionKindSchema.nullable(),
  /** Symbol classes a `class_to_item` rule maps to this item (non-empty = symbol-based: "למד" is offered after a count). */
  classes: z.array(SymbolClassSchema).max(32),
  /** Set while `state = not_relevant`. */
  exclusion: BoqExclusionSchema.nullable(),
});
export type MissingItem = z.infer<typeof MissingItemSchema>;

export const MissingItemCountsSchema = z.object({
  all: z.number().int().nonnegative(),
  inProject: z.number().int().nonnegative(),
  notRelevant: z.number().int().nonnegative(),
});
export type MissingItemCounts = z.infer<typeof MissingItemCountsSchema>;

export const MissingItemsQuerySchema = z.object({ filter: MissingItemFilterSchema.default('all') });
export type MissingItemsQuery = z.infer<typeof MissingItemsQuerySchema>;

/** GET /v1/projects/:pid/boq/missing-items (viewer+). Sorted by chapter (template order), then natural code order. */
export const MissingItemsViewSchema = z.object({
  /** false before the first BOQ build: nothing can be "missing" yet (items = []). */
  built: z.boolean(),
  filter: MissingItemFilterSchema,
  /** Counts of the whole list, whatever the filter. */
  counts: MissingItemCountsSchema,
  items: z.array(MissingItemSchema),
});
export type MissingItemsView = z.infer<typeof MissingItemsViewSchema>;

// ---------------------------------------------------------------------------
// Pure computation
// ---------------------------------------------------------------------------

/** Minimal library item the computation needs (an `ItemLibraryItem` satisfies it). */
export interface MissingLibraryItem {
  id: string;
  code: string;
  chapter: string;
  chapterTitle?: string;
  description: string;
  unit: string;
  active: boolean;
  cancelled?: boolean | undefined;
  notForTotal?: boolean | undefined;
  codeAliases?: readonly string[] | undefined;
}
export type MissingLine = Pick<BoqLine, 'id' | 'code' | 'chapter' | 'description' | 'unit' | 'qty' | 'qtyOverride' | 'notForTotal'>;
export interface MissingTemplateChapter {
  code: string;
  title: string;
  codePrefixes?: readonly string[] | undefined;
}
export interface MissingRule {
  kind: string;
  enabled: boolean;
  itemCode: string | null;
  match: unknown;
}

const codeKey = (c: string): string => c.trim();

/** Symbol classes of the enabled `class_to_item` rules per item code (sorted, unique). */
export function classesByItemCode(rules: readonly MissingRule[]): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const r of rules) {
    if (r.kind !== 'class_to_item' || !r.enabled || !r.itemCode) continue;
    const cl = (r.match as { classes?: unknown } | null)?.classes;
    if (!Array.isArray(cl)) continue;
    const set = out.get(codeKey(r.itemCode)) ?? new Set<string>();
    for (const c of cl) if (typeof c === 'string') set.add(c);
    out.set(codeKey(r.itemCode), set);
  }
  return new Map([...out].map(([k, v]) => [k, [...v].sort()]));
}

/** "מדידה" tool of a unit: `null` for lump sums (no tool: the BOQ line's own confirm covers them). */
export function markKindFor(unit: string): Exclude<QuickActionKind, 'confirm'> | null {
  const k = defaultQuickActionFor(unit);
  return k === 'confirm' ? null : k;
}

export interface MissingItemsInput {
  library: readonly MissingLibraryItem[];
  /** ALL lines of the project (including those a human excluded: an exclusion never hides a quantity > 0). */
  lines: readonly MissingLine[];
  exclusions: readonly BoqExclusion[];
  templateChapters?: readonly MissingTemplateChapter[];
  rules?: readonly MissingRule[];
}

/**
 * The list. An item is *missing* when no line of its code (or of one of its `codeAliases`) has an effective quantity
 * > 0 — either there is no line at all (`no_line`) or the lines it has are 0 (`zero_line`, e.g. a template suggestion
 * "להשלמה ידנית"). Library items that are inactive, cancelled ("בוטל") or "לא לסיכום" lines (unit price only) are never
 * missing. A line whose code has no library item is still listed when its quantity is 0 (the library may lag the
 * worker). An active exclusion turns the row into `not_relevant`; a quantity > 0 (e.g. a manual count made after the
 * exclusion) removes the row altogether — the exclusion stays stored but hides nothing (`isLineExcluded`).
 * Order: template chapter order, then chapter key, then natural code order, then id — deterministic.
 */
export function computeMissingItems(input: MissingItemsInput): MissingItem[] {
  const exclusionByCode = new Map<string, BoqExclusion>();
  for (const e of input.exclusions) if (e.active) exclusionByCode.set(codeKey(e.code), e);
  const classes = classesByItemCode(input.rules ?? []);

  // quantity per code (effective, summed over floors) + zero line per code
  const qtyOf = new Map<string, number>();
  const zeroLine = new Map<string, MissingLine>();
  const lineOf = new Map<string, MissingLine>();
  const sortedLines = [...input.lines].sort((a, b) => a.id.localeCompare(b.id));
  for (const l of sortedLines) {
    if (l.notForTotal === true) continue;
    const k = codeKey(l.code);
    qtyOf.set(k, (qtyOf.get(k) ?? 0) + Math.max(0, effectiveQty(l)));
    if (!lineOf.has(k)) lineOf.set(k, l);
    if (effectiveQty(l) <= 0 && !zeroLine.has(k)) zeroLine.set(k, l);
  }
  const covered = (code: string, aliases: readonly string[] = []) => [code, ...aliases].some((c) => (qtyOf.get(codeKey(c)) ?? 0) > 0);

  const chapterTitles = new Map<string, string>();
  const chapterOrder = new Map<string, number>();
  const prefixOf = new Map<string, string>();
  (input.templateChapters ?? []).forEach((c, i) => {
    chapterTitles.set(chapterKey(c.code), c.title);
    chapterOrder.set(chapterKey(c.code), i);
    for (const p of c.codePrefixes ?? []) if (!prefixOf.has(p)) prefixOf.set(p, chapterKey(c.code));
  });
  const chapterKeyOf = (chapter: string, code: string): string => {
    const k = chapterKey(chapter);
    if (chapterOrder.has(k)) return k;
    const major = code.split(/[.\-/]/)[0] ?? '';
    return prefixOf.get(major) ?? prefixOf.get(major.replace(/^0+(?=\d)/, '')) ?? k;
  };

  const rows = new Map<string, MissingItem & { _ck: string }>();
  const push = (code: string, chapter: string, chapterTitle: string | undefined, description: string, unit: string, itemId: string | null, line: MissingLine | undefined) => {
    const k = codeKey(code);
    if (rows.has(k)) return;
    const ck = chapterKeyOf(chapter, code);
    const ex = exclusionByCode.get(k) ?? null;
    rows.set(k, {
      id: exclusionIdFor(k),
      code: k,
      chapter,
      chapterTitle: chapterTitles.get(ck) ?? chapterTitle?.trim() ?? `פרק ${chapter || code.split(/[.\-/]/)[0] || '?'}`,
      description,
      unit,
      origin: line ? 'zero_line' : 'no_line',
      lineId: line?.id ?? null,
      itemId,
      state: ex ? 'not_relevant' : 'open',
      markKind: markKindFor(unit),
      classes: (classes.get(k) ?? []) as MissingItem['classes'],
      exclusion: ex,
      _ck: ck,
    });
  };

  // library items first (active, not cancelled, counted in the total), best-described first per code
  const lib = [...input.library].filter((i) => i.active && i.cancelled !== true && i.notForTotal !== true).sort((a, b) => compareItemCodes(a.code, b.code) || a.id.localeCompare(b.id));
  for (const i of lib) if (!covered(i.code, i.codeAliases)) push(i.code, i.chapter, i.chapterTitle, i.description, i.unit, i.id, zeroLine.get(codeKey(i.code)));
  // zero lines whose code the library does not know
  for (const [k, l] of zeroLine) if (!rows.has(k) && !covered(k)) push(l.code, l.chapter, undefined, l.description, l.unit, null, l);

  const order = (r: { _ck: string; code: string; id: string }) => chapterOrder.get(r._ck) ?? Number.MAX_SAFE_INTEGER;
  return [...rows.values()]
    .sort((a, b) => order(a) - order(b) || compareItemCodes(a._ck, b._ck) || compareItemCodes(a.code, b.code) || a.id.localeCompare(b.id))
    .map(({ _ck: _omit, ...r }) => r);
}

export function missingCounts(items: readonly Pick<MissingItem, 'state'>[]): MissingItemCounts {
  const notRelevant = items.filter((i) => i.state === 'not_relevant').length;
  return { all: items.length, inProject: items.length - notRelevant, notRelevant };
}

export function filterMissing<T extends Pick<MissingItem, 'state'>>(items: readonly T[], filter: MissingItemFilter): T[] {
  return filter === 'all' ? [...items] : items.filter((i) => (filter === 'not_relevant' ? i.state === 'not_relevant' : i.state === 'open'));
}

/**
 * True when a line must be left out of the BOQ view / Excel / preview / share: an ACTIVE exclusion of its code AND an
 * effective quantity of 0. A line a human (or a later build) gave a quantity is shown again — hiding a counted
 * quantity behind an old "לא רלוונטי" would be a silent money error; the owner sees the item come back.
 */
export function isLineExcluded(line: Pick<BoqLine, 'code' | 'qty' | 'qtyOverride'>, activeCodes: ReadonlySet<string>): boolean {
  return activeCodes.has(codeKey(line.code)) && effectiveQty(line) <= 0;
}

/** Codes of the active exclusions. */
export const activeExclusionCodes = (exclusions: readonly Pick<BoqExclusion, 'code' | 'active'>[]): Set<string> =>
  new Set(exclusions.filter((e) => e.active).map((e) => codeKey(e.code)));

/** The lines minus the excluded ones (order kept). */
export function withoutExcludedLines<T extends Pick<BoqLine, 'code' | 'qty' | 'qtyOverride'>>(lines: readonly T[], exclusions: readonly Pick<BoqExclusion, 'code' | 'active'>[]): T[] {
  if (!exclusions.some((e) => e.active)) return [...lines];
  const codes = activeExclusionCodes(exclusions);
  return lines.filter((l) => !isLineExcluded(l, codes));
}
