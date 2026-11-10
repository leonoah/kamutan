import { describe, expect, it } from 'vitest';
import {
  BoqLineSchema,
  BoqRuleSchema,
  DEFAULT_BOQ_RULES,
  DEFAULT_BOQ_RULES_VERSION,
  DEFAULT_ITEM_LIBRARY,
  DEFAULT_ITEM_LIBRARY_VERSION,
  DEFAULT_UNITS,
  ItemLibraryItemSchema,
  countsInTotal,
  defaultRuleDoc,
  defaultUnitFor,
} from '../src/index.js';

const base = { id: 'r_x', itemCode: '4.29', itemDescription: 'x', unit: 'יחידה', priority: 100, enabled: true, source: 'custom', updatedAt: null };

describe('Sprint 10 — rule kinds, item / line fields, defaults v9 / library v3', () => {
  it('class_to_item label filters, countOnly, params; marker_addon; lighting_circuit; plumbing label variants', () => {
    expect(BoqRuleSchema.safeParse({ ...base, kind: 'class_to_item', match: { classes: ['heater_feed'], labelPatterns: ['תריס'], labelRadiusMm: 10 } }).success).toBe(true);
    expect(BoqRuleSchema.safeParse({ ...base, kind: 'class_to_item', match: { classes: ['switch_single'], countOnly: true } }).success).toBe(true);
    expect(BoqRuleSchema.safeParse({ ...base, kind: 'class_to_item', match: { classes: ['conduit_cobra'], params: { length: 'label' } } }).success).toBe(true);
    expect(BoqRuleSchema.safeParse({ ...base, kind: 'class_to_item', match: { classes: ['panel'], labelPatterns: ['(?<x>a)'] } }).success).toBe(false);
    expect(BoqRuleSchema.safeParse({ ...base, kind: 'marker_addon', match: { hostClasses: ['socket_single'], markerClasses: ['waterproof_marker'] } }).success).toBe(true);
    expect(BoqRuleSchema.safeParse({ ...base, kind: 'marker_addon', match: { hostClasses: ['socket_single'] } }).success).toBe(false);
    expect(BoqRuleSchema.safeParse({ ...base, itemCode: null, kind: 'lighting_circuit', match: { wording: 'auto', includeTimer: true } }).success).toBe(true);
    expect(BoqRuleSchema.safeParse({ ...base, itemCode: null, kind: 'lighting_circuit', match: { wording: 'chain' } }).success).toBe(false);
    expect(BoqRuleSchema.safeParse({ ...base, kind: 'marker_addon', match: { hostClasses: ['socket_single'], roomTypes: ['bathroom'] } }).success).toBe(true);
    expect(BoqRuleSchema.safeParse({ ...base, itemCode: null, kind: 'template_chapter', match: { chapters: ['05'], importedOnly: true } }).success).toBe(true);
    expect(BoqRuleSchema.safeParse({ ...base, kind: 'class_to_item', match: { classes: ['shutter_feed', 'smoke_detector', 'camera'] } }).success).toBe(true);
    expect(
      BoqRuleSchema.safeParse({ ...base, kind: 'plumbing_point', match: { fixtureClasses: ['fixture_shower'], perRoom: true, labelPatterns: ['4\\s*דרכ'] } }).success,
    ).toBe(true);
  });

  it('item cancelled / notForTotal / codeAliases; line notForTotal + circuit; units חדר / סט', () => {
    const item = { id: 'it_x', code: '4.50', chapter: '04', chapterTitle: '', description: 'x', unit: 'סט', tags: [], source: 'import', active: true, updatedAt: null };
    expect(ItemLibraryItemSchema.safeParse({ ...item, cancelled: true, notForTotal: false, codeAliases: ['4.38'], descKey: 'k' }).success).toBe(true);
    expect(ItemLibraryItemSchema.safeParse({ ...item, codeAliases: ['bad code'] }).success).toBe(false);
    const line = { id: 'ln_4_50', chapter: '04', code: '4.50', description: 'x', qty: 1, unit: 'חדר', level: 'yellow', status: 'draft' };
    expect(BoqLineSchema.safeParse({ ...line, notForTotal: true, circuit: { id: 'c_A1,c_A2', kind: 'shared', fixtures: 2 } }).success).toBe(true);
    expect(BoqLineSchema.safeParse({ ...line, circuit: { id: 'c_A1', kind: 'chain', fixtures: 2 } }).success).toBe(false);
    expect(countsInTotal({ notForTotal: true })).toBe(false);
    expect(countsInTotal({})).toBe(true);
    expect(DEFAULT_UNITS.room).toBe('חדר');
    expect(defaultUnitFor('סט')).toBe('סט');
  });

  it('defaults: v9 rules parse, unique ids, every Sprint-10 rule code has a default item; library v3 codes unique', () => {
    expect(DEFAULT_BOQ_RULES_VERSION).toBe(9);
    expect(DEFAULT_ITEM_LIBRARY_VERSION).toBe(3);
    for (const r of DEFAULT_BOQ_RULES) expect(BoqRuleSchema.safeParse({ ...defaultRuleDoc(r), updatedAt: null }).success, r.id).toBe(true);
    const ids = DEFAULT_BOQ_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const kinds = new Set(DEFAULT_BOQ_RULES.map((r) => r.kind));
    expect(kinds.has('marker_addon') && kinds.has('lighting_circuit')).toBe(true);
    const codes = new Set(DEFAULT_ITEM_LIBRARY.map((i) => i.code));
    expect(codes.size).toBe(DEFAULT_ITEM_LIBRARY.length);
    for (const r of DEFAULT_BOQ_RULES) if (r.itemCode) expect(codes.has(r.itemCode), `${r.id} ${r.itemCode}`).toBe(true);
    expect(DEFAULT_ITEM_LIBRARY.filter((i) => i.defaultsVersion === 3).length).toBeGreaterThan(50);
  });
});
