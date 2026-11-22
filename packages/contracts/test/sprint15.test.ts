import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTION_HE,
  AUDIT_ENTITY_HE,
  auditSummaryHe,
  BOQ_LINE_PRESERVED_FIELDS,
  BoqExclusionSchema,
  classesByItemCode,
  computeMissingItems,
  exclusionIdFor,
  filterMissing,
  fsPaths,
  isLineExcluded,
  jsonSchemaRegistry,
  markKindFor,
  MISSING_ITEM_FILTERS,
  MissingItemsViewSchema,
  missingCounts,
  SetBoqExclusionRequestSchema,
  SetBoqExclusionResponseSchema,
  withoutExcludedLines,
  type BoqExclusion,
  type MissingLibraryItem,
  type MissingLine,
} from '../src/index';

const lib = (code: string, over: Partial<MissingLibraryItem> = {}): MissingLibraryItem => ({
  id: `it_${code.replace(/\./g, '-')}`,
  code,
  chapter: code.split('.')[0]!.padStart(2, '0'),
  chapterTitle: `פרק ${code.split('.')[0]}`,
  description: `סעיף ${code}`,
  unit: "יח'",
  active: true,
  ...over,
});
const line = (code: string, qty: number, over: Partial<MissingLine> = {}): MissingLine => ({
  id: `l_${code.replace(/\./g, '-')}_${qty}`,
  code,
  chapter: code.split('.')[0]!.padStart(2, '0'),
  description: `שורה ${code}`,
  unit: "יח'",
  qty,
  ...over,
});
const excl = (code: string, over: Partial<BoqExclusion> = {}): BoqExclusion => ({
  id: exclusionIdFor(code),
  code,
  description: `סעיף ${code}`,
  unit: "יח'",
  chapter: '04',
  active: true,
  excludedBy: 'u1',
  excludedAt: '2026-11-22T10:00:00.000Z',
  ...over,
});

describe('Sprint 15: exclusionIdFor', () => {
  it('is a valid, deterministic doc id; "4.1" and "4-1" differ', () => {
    expect(exclusionIdFor('4.10')).toBe(exclusionIdFor(' 4.10 '));
    expect(exclusionIdFor('4.10')).toMatch(/^ex_4-10_[0-9a-f]{8}$/);
    expect(exclusionIdFor('4.1')).not.toBe(exclusionIdFor('4-1'));
    expect(exclusionIdFor('A/1')).toMatch(/^ex_A-1_[0-9a-f]{8}$/);
    expect(BoqExclusionSchema.parse(excl('A/1')).id).toBe(exclusionIdFor('A/1'));
  });
});

describe('Sprint 15: computeMissingItems', () => {
  const template = [
    { code: '04', title: 'פרק 04 – חשמל' },
    { code: '03', title: 'פרק 03 – אינסטלציה' },
  ];
  it('lists library items with no line or a 0 line; skips covered, inactive, cancelled and not-for-total items', () => {
    const items = computeMissingItems({
      library: [lib('4.01'), lib('4.02'), lib('4.03', { active: false }), lib('4.04', { cancelled: true }), lib('4.05', { notForTotal: true }), lib('4.06'), lib('4.07', { codeAliases: ['9.99'] })],
      lines: [line('4.01', 3), line('4.02', 0, { id: 'zero_1' }), line('9.99', 2)],
      exclusions: [],
    });
    expect(items.map((i) => [i.code, i.origin, i.lineId])).toEqual([
      ['4.02', 'zero_line', 'zero_1'],
      ['4.06', 'no_line', null],
    ]);
  });

  it('an override counts as the effective quantity (override 0 on a counted line is missing; override > 0 on a 0 line is not)', () => {
    const items = computeMissingItems({
      library: [lib('4.01'), lib('4.02')],
      lines: [line('4.01', 5, { qtyOverride: 0, id: 'a' }), line('4.02', 0, { qtyOverride: 2, id: 'b' })],
      exclusions: [],
    });
    expect(items.map((i) => i.code)).toEqual(['4.01']);
  });

  it('sums floors: one floor line with a quantity covers the code', () => {
    const items = computeMissingItems({ library: [lib('4.01')], lines: [line('4.01', 0, { id: 'f0' }), line('4.01', 4, { id: 'f1' })], exclusions: [] });
    expect(items).toEqual([]);
  });

  it('a 0 line whose code the library does not know is listed; its unit / description come from the line', () => {
    const items = computeMissingItems({ library: [], lines: [line('7.77', 0, { unit: 'מ"ר' })], exclusions: [] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ code: '7.77', itemId: null, origin: 'zero_line', markKind: 'measure_area', description: 'שורה 7.77' });
  });

  it('is sorted by template chapter order, then natural code order (4.9 before 4.10), deterministic across input order', () => {
    const library = [lib('3.02'), lib('4.10'), lib('4.9'), lib('3.01'), lib('8.01')];
    const a = computeMissingItems({ library, lines: [], exclusions: [], templateChapters: template });
    const b = computeMissingItems({ library: [...library].reverse(), lines: [], exclusions: [], templateChapters: template });
    expect(a.map((i) => i.code)).toEqual(['4.9', '4.10', '3.01', '3.02', '8.01']);
    expect(b).toEqual(a);
    expect(a[0]!.chapterTitle).toBe('פרק 04 – חשמל');
    expect(a.at(-1)!.chapterTitle).toBe('פרק 8');
  });

  it('chapter title falls back to the library chapter title, then "פרק N"; codePrefixes route a code to the template chapter', () => {
    const items = computeMissingItems({
      library: [lib('9.01', { chapter: '08', chapterTitle: '' })],
      lines: [],
      exclusions: [],
      templateChapters: [{ code: '08', title: 'פרק 08- שונות', codePrefixes: ['9'] }],
    });
    expect(items[0]!.chapterTitle).toBe('פרק 08- שונות');
  });

  it('an active exclusion makes the row not_relevant; a restored (inactive) one does not; counts + filters', () => {
    const items = computeMissingItems({
      library: [lib('4.01'), lib('4.02'), lib('4.03')],
      lines: [],
      exclusions: [excl('4.01'), excl('4.02', { active: false, restoredBy: 'u2', restoredAt: '2026-11-22T11:00:00.000Z' })],
    });
    expect(items.map((i) => [i.code, i.state])).toEqual([
      ['4.01', 'not_relevant'],
      ['4.02', 'open'],
      ['4.03', 'open'],
    ]);
    expect(items[0]!.exclusion?.excludedBy).toBe('u1');
    expect(missingCounts(items)).toEqual({ all: 3, inProject: 2, notRelevant: 1 });
    expect(filterMissing(items, 'all')).toHaveLength(3);
    expect(filterMissing(items, 'in_project').map((i) => i.code)).toEqual(['4.02', '4.03']);
    expect(filterMissing(items, 'not_relevant').map((i) => i.code)).toEqual(['4.01']);
    expect(MISSING_ITEM_FILTERS).toEqual(['all', 'in_project', 'not_relevant']);
  });

  it('an excluded item that later got a quantity (manual count) is no longer listed at all', () => {
    const items = computeMissingItems({ library: [lib('4.01')], lines: [line('4.01', 2)], exclusions: [excl('4.01')] });
    expect(items).toEqual([]);
  });

  it('symbol classes come from enabled class_to_item rules; markKind from the unit', () => {
    const rules = [
      { kind: 'class_to_item', enabled: true, itemCode: '4.01', match: { classes: ['socket_double', 'socket_single'] } },
      { kind: 'class_to_item', enabled: false, itemCode: '4.02', match: { classes: ['switch_single'] } },
      { kind: 'install_count', enabled: true, itemCode: '4.03', match: { classes: ['luminaire_led'] } },
    ];
    expect(classesByItemCode(rules)).toEqual(new Map([['4.01', ['socket_double', 'socket_single']]]));
    const items = computeMissingItems({ library: [lib('4.01'), lib('4.02', { unit: 'מ"א' }), lib('4.03', { unit: 'קומפלט' })], lines: [], exclusions: [], rules });
    expect(items.map((i) => [i.code, i.markKind, i.classes])).toEqual([
      ['4.01', 'count', ['socket_double', 'socket_single']],
      ['4.02', 'measure_length', []],
      ['4.03', null, []],
    ]);
    expect(markKindFor('מ"ר')).toBe('measure_area');
  });

  it('every row parses with MissingItemsViewSchema', () => {
    const items = computeMissingItems({ library: [lib('4.01')], lines: [line('4.02', 0)], exclusions: [excl('4.02')] });
    const v = MissingItemsViewSchema.parse({ built: true, filter: 'all', counts: missingCounts(items), items });
    expect(v.items).toHaveLength(2);
  });
});

describe('Sprint 15: exclusions hide only zero-quantity lines (survive rebuilds, never a counted quantity)', () => {
  const exclusions = [excl('4.01'), excl('4.02', { active: false })];
  it('isLineExcluded / withoutExcludedLines', () => {
    const lines = [line('4.01', 0), line('4.01', 3, { id: 'x' }), line('4.02', 0), line('4.03', 0), line('4.01', 5, { qtyOverride: 0, id: 'y' })];
    expect(withoutExcludedLines(lines, exclusions).map((l) => l.id)).toEqual(['x', 'l_4-02_0', 'l_4-03_0']);
    expect(isLineExcluded(line('4.01', 0), new Set(['4.01']))).toBe(true);
    expect(isLineExcluded(line('4.01', 0, { qtyOverride: 1 }), new Set(['4.01']))).toBe(false);
  });
  it('undo (restore) brings the line back; a rebuild that rewrites the lines changes nothing because the decision is stored apart', () => {
    const rebuilt = [line('4.01', 0, { id: 'new_id_after_rebuild' })];
    expect(withoutExcludedLines(rebuilt, exclusions)).toEqual([]);
    expect(withoutExcludedLines(rebuilt, [excl('4.01', { active: false })])).toHaveLength(1);
  });
  it('the exclusion is not a boqLine field, so a rebuild cannot overwrite it (BOQ_LINE_PRESERVED_FIELDS untouched)', () => {
    expect(BOQ_LINE_PRESERVED_FIELDS).not.toContain('excluded' as never);
    expect(fsPaths.boqExclusion('o', 'p', exclusionIdFor('4.01'))).toBe(`orgs/o/projects/p/boqExclusions/${exclusionIdFor('4.01')}`);
  });
});

describe('Sprint 15: request / response schemas, audit labels, json-schema', () => {
  it('SetBoqExclusionRequest is strict and trims the reason', () => {
    expect(SetBoqExclusionRequestSchema.parse({ code: '4.10', excluded: true, reason: '  בלי מזגן  ' }).reason).toBe('בלי מזגן');
    expect(SetBoqExclusionRequestSchema.safeParse({ code: '4.10' }).success).toBe(false);
    expect(SetBoqExclusionRequestSchema.safeParse({ code: 'bad code!', excluded: true }).success).toBe(false);
    expect(SetBoqExclusionRequestSchema.safeParse({ code: '4.10', excluded: true, x: 1 }).success).toBe(false);
    expect(SetBoqExclusionRequestSchema.safeParse({ code: '4.10', excluded: true, reason: 'x'.repeat(201) }).success).toBe(false);
    expect(SetBoqExclusionResponseSchema.parse({ exclusion: excl('4.10'), changed: true }).changed).toBe(true);
  });
  it('audit summary (Hebrew; the reason is never in the line)', () => {
    expect(AUDIT_ENTITY_HE.boqExclusions).toBe('סעיף שלא זוהה');
    expect(AUDIT_ACTION_HE.exclude).toBeTruthy();
    expect(auditSummaryHe({ entity: 'boqExclusions', action: 'exclude', entityId: 'ex_4-10_x', after: { code: '4.10', reason: 'סוד' } })).toBe('סעיף 4.10 · סומן כלא רלוונטי בפרויקט הזה');
    expect(auditSummaryHe({ entity: 'boqExclusions', action: 'restore', entityId: 'ex_4-10_x', after: { code: '4.10' } })).toBe('סעיף 4.10 · הוחזר לכתב הכמויות');
  });
  it('json-schema exported', () => {
    const dir = join(__dirname, '..', 'json-schema');
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { schemas: string[] };
    for (const n of ['BoqExclusion', 'MissingItem', 'MissingItemsQuery', 'MissingItemsView', 'SetBoqExclusionRequest', 'SetBoqExclusionResponse']) {
      expect(Object.keys(jsonSchemaRegistry)).toContain(n);
      expect(index.schemas).toContain(`${n}.json`);
    }
  });
});
