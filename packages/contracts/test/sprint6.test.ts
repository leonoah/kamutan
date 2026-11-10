import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_PATH_RE,
  CONSUME_NEAR_MAX_MM,
  BatchLineStatusRequestSchema,
  BoqBuildStatsSchema,
  BoqEvidenceItemSchema,
  BoqLineSchema,
  BoqRuleSchema,
  CorrectionSchema,
  DEFAULT_BOQ_RULES,
  DEFAULT_BOQ_TEMPLATE,
  DEFAULT_ITEM_LIBRARY,
  DEFAULT_ITEM_LIBRARY_ADDITIONS,
  defaultQuickActionFor,
  defaultRuleDoc,
  GeometryArtifactSchema,
  GEOMETRY_MEASURE_KEYS,
  isPortableRegex,
  jsonSchemaRegistry,
  LINE_ORIGIN_HE,
  LINE_ORIGINS,
  normalizeHebrewText,
  planDefaultLibrarySeed,
  QuickMeasureRequestSchema,
  storagePaths,
  templateNeedsUpgrade,
  TextItemsArtifactSchema,
  UNDERSTANDING_ARTIFACT_PATH_RE,
  VersionArtifactsSchema,
} from '../src/index.js';

describe('Sprint 6 — Hebrew-normalised matching', () => {
  it('normalizeHebrewText: finals, geresh / gershayim, niqqud, maqaf, spacing, case', () => {
    expect(normalizeHebrewText('נק׳  מאור')).toBe("נק' מאור");
    expect(normalizeHebrewText('מ״ר')).toBe('מ"ר');
    expect(normalizeHebrewText("מ''ר")).toBe('מ"ר');
    expect(normalizeHebrewText('לוח תקשורת קיים')).toBe('לוח תקשורת קיימ');
    expect(normalizeHebrewText('חימום +‏מפסק')).toBe('חימומ + מפסק');
    expect(normalizeHebrewText('דו־קרומי')).toBe('דו-קרומי');
    expect(normalizeHebrewText('שָׁלוֹם PANEL')).toBe('שלומ panel');
  });
  it('isPortableRegex rejects JS/Python-divergent syntax', () => {
    expect(isPortableRegex('לוח\\s*תקשורת')).toBe(true);
    expect(isPortableRegex('(?<=קיר )גבס')).toBe(true);
    expect(isPortableRegex('(?<n>x)')).toBe(false);
    expect(isPortableRegex('\\p{L}+')).toBe(false);
    expect(isPortableRegex('(?i)abc')).toBe(false);
    expect(isPortableRegex('a++')).toBe(false);
    expect(isPortableRegex('(')).toBe(false);
    expect(isPortableRegex('x'.repeat(201))).toBe(false);
  });
});

describe('Sprint 6 — rule kinds', () => {
  const base = { id: 'r_x', itemCode: '4.25', priority: 100, enabled: true, source: 'custom', updatedAt: null };
  it('text_item / area_item / length_item / suggested_item parse; malformed rejected', () => {
    expect(BoqRuleSchema.safeParse({ ...base, kind: 'text_item', match: { patterns: ['לוח\\s*תקשורת'], scope: 'note', qty: 'count' } }).success).toBe(true);
    expect(BoqRuleSchema.safeParse({ ...base, kind: 'text_item', match: { patterns: ['(?<x>a)'], scope: 'note', qty: 'count' } }).success).toBe(false);
    expect(BoqRuleSchema.safeParse({ ...base, kind: 'text_item', match: { patterns: [], scope: 'note', qty: 'count' } }).success).toBe(false);
    expect(BoqRuleSchema.safeParse({ ...base, kind: 'text_item', match: { patterns: ['x'], scope: 'title', qty: 'count' } }).success).toBe(false);
    expect(BoqRuleSchema.safeParse({ ...base, kind: 'area_item', match: { source: 'hatch', categories: ['gypsum_ceiling'] } }).success).toBe(true);
    expect(BoqRuleSchema.safeParse({ ...base, kind: 'area_item', match: { source: 'hatch' } }).success).toBe(false);
    expect(BoqRuleSchema.safeParse({ ...base, kind: 'length_item', match: { source: 'stair', measure: 'treads' } }).success).toBe(true);
    expect(BoqRuleSchema.safeParse({ ...base, kind: 'length_item', match: { source: 'polyline', categories: ['Bad-Cat'] } }).success).toBe(false);
    expect(BoqRuleSchema.safeParse({ ...base, kind: 'area_item', match: { source: 'hatch', keys: ['gypsum_ceiling_area'] } }).success).toBe(true);
    const sug = { trigger: { kind: 'text', patterns: ['חצר\\s*אנגלית'] }, estimate: null, reason: 'להשלמה ידנית' };
    expect(BoqRuleSchema.safeParse({ ...base, kind: 'suggested_item', match: sug }).success).toBe(true);
    expect(BoqRuleSchema.safeParse({ ...base, kind: 'suggested_item', match: { ...sug, estimate: { kind: 'fixed', quantity: 1 }, quickAction: 'confirm' } }).success).toBe(true);
    expect(BoqRuleSchema.safeParse({ ...base, kind: 'suggested_item', match: { ...sug, trigger: { kind: 'sheet_discipline', disciplines: [] } } }).success).toBe(false);
    expect(BoqRuleSchema.safeParse({ ...base, kind: 'suggested_item', match: { ...sug, reason: '' } }).success).toBe(false);
  });

  it('default rules v6: every rule parses; the Sprint 6 codes are covered, each with a library item of the same unit kind', () => {
    for (const r of DEFAULT_BOQ_RULES) expect(BoqRuleSchema.safeParse({ ...defaultRuleDoc(r), updatedAt: null }).success, r.id).toBe(true);
    const codes = new Set(DEFAULT_BOQ_RULES.map((r) => r.itemCode));
    const want = ['2.01', '2.02', '2.03', '4.08', '4.19', '4.25', '4.26', '4.27', '4.28', '5.04', '5.06', '5.07', '5.08', '7.01', '7.02', '7.03', '7.04', '7.05', '7.06', '7.07', '8.01', '8.02', '8.03', '8.04', '9.03'];
    for (const c of want) expect(codes.has(c), c).toBe(true);
    // every geometry-measured line has a suggested fallback of the same code
    for (const r of DEFAULT_BOQ_RULES.filter((x) => x.kind === 'area_item' || x.kind === 'length_item')) {
      expect(DEFAULT_BOQ_RULES.some((x) => x.kind === 'suggested_item' && x.itemCode === r.itemCode), r.id).toBe(true);
    }
    for (const r of DEFAULT_BOQ_RULES.filter((x) => x.kind === 'suggested_item')) expect(r.priority, r.id).toBeLessThan(10);
    // v7 (Worker-BOQ requests): 2.02 triggers on a stair flight; consumeNear cap documented
    const slab = DEFAULT_BOQ_RULES.find((r) => r.id === 'r_suggest_slab_stairs');
    const pats = (slab?.match as { trigger: { patterns: string[] } }).trigger.patterns.map((p) => new RegExp(normalizeHebrewText(p), 'iu'));
    expect(pats.some((re) => re.test(normalizeHebrewText('קונטור גרם מדרגות')))).toBe(true);
    expect(CONSUME_NEAR_MAX_MM).toBe(8);
    expect(DEFAULT_BOQ_RULES.find((r) => r.id === 'r_geo_plaster_walls')?.itemDescription).toBe(DEFAULT_ITEM_LIBRARY.find((i) => i.code === '8.02')?.description);
    const ids = DEFAULT_BOQ_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('Sprint 6 — default library v2 + template v3', () => {
  it('additions: chapters 02 / 06 (7.xx) / 07 (8.xx), defaultsVersion 2, titles from the template', () => {
    const add = DEFAULT_ITEM_LIBRARY_ADDITIONS.filter((i) => i.defaultsVersion === 2); // v3 = Sprint 10 (sprint10.test.ts)
    expect(add.length).toBe(23);
    expect(add.every((i) => i.defaultsVersion === 2)).toBe(true);
    expect(DEFAULT_ITEM_LIBRARY.find((i) => i.code === '7.01')?.chapter).toBe('06');
    expect(DEFAULT_ITEM_LIBRARY.find((i) => i.code === '8.03')?.chapter).toBe('07');
    expect(DEFAULT_ITEM_LIBRARY.find((i) => i.code === '2.02')?.chapter).toBe('02');
    expect(DEFAULT_ITEM_LIBRARY.find((i) => i.code === '9.03')?.chapter).toBe('09');
    expect(DEFAULT_ITEM_LIBRARY.find((i) => i.code === '4.01')?.defaultsVersion).toBe(1);
    expect(DEFAULT_BOQ_TEMPLATE.chapters.find((c) => c.code === '06')?.codePrefixes).toEqual(['7']);
  });
  it('planDefaultLibrarySeed: empty → all; with defaults → missing ids minus taken codes; import-only → nothing; idempotent', () => {
    const none = new Set<string>();
    expect(planDefaultLibrarySeed({ empty: true, hasDefault: false, existingIds: none, takenCodes: none })).toHaveLength(DEFAULT_ITEM_LIBRARY.length);
    const v1 = DEFAULT_ITEM_LIBRARY.filter((i) => i.defaultsVersion === 1);
    const ids = new Set(v1.map((i) => i.id));
    const taken = new Set([...v1.map((i) => i.code), '7.01']);
    const plan = planDefaultLibrarySeed({ empty: false, hasDefault: true, existingIds: ids, takenCodes: taken });
    expect(plan.filter((i) => i.defaultsVersion === 2)).toHaveLength(22);
    expect(plan.some((i) => i.code === '7.01')).toBe(false);
    expect(planDefaultLibrarySeed({ empty: false, hasDefault: false, existingIds: none, takenCodes: none })).toEqual([]);
    const all = new Set(DEFAULT_ITEM_LIBRARY.map((i) => i.id));
    expect(planDefaultLibrarySeed({ empty: false, hasDefault: true, existingIds: all, takenCodes: new Set(DEFAULT_ITEM_LIBRARY.map((i) => i.code)) })).toEqual([]);
  });
  it('templateNeedsUpgrade only for unedited generic v2 seeds', () => {
    expect(templateNeedsUpgrade({ source: 'default', defaultsVersion: 2, updatedBy: null })).toBe(true);
    expect(templateNeedsUpgrade({ source: 'default', defaultsVersion: 2, updatedBy: 'u1' })).toBe(false);
    expect(templateNeedsUpgrade({ source: 'default' })).toBe(false); // Sprint-3 sample-format seed
    expect(templateNeedsUpgrade({ source: 'import', defaultsVersion: 2 })).toBe(false);
    expect(templateNeedsUpgrade({ source: 'default', defaultsVersion: 3, updatedBy: null })).toBe(false);
    expect(templateNeedsUpgrade(null)).toBe(false);
  });
});

describe('Sprint 6 — BOQ line / evidence / stats / corrections', () => {
  const line = { id: 'ln_7_01', chapter: '06', code: '7.01', description: 'x', qty: 0, unit: 'מ"ר', level: 'red', status: 'draft' };
  it('line origin / needsInput / quickAction (additive)', () => {
    expect(BoqLineSchema.safeParse(line).success).toBe(true);
    expect(BoqLineSchema.safeParse({ ...line, origin: 'suggested', needsInput: true, quickAction: { kind: 'measure_area', sheetId: 's1-p0' } }).success).toBe(true);
    expect(BoqLineSchema.safeParse({ ...line, quickAction: null }).success).toBe(true);
    expect(BoqLineSchema.safeParse({ ...line, origin: 'guess' }).success).toBe(false);
    expect(BoqLineSchema.safeParse({ ...line, quickAction: { kind: 'draw', sheetId: null } }).success).toBe(false);
    for (const o of LINE_ORIGINS) expect(LINE_ORIGIN_HE[o]).toBeTruthy();
    expect(defaultQuickActionFor('מ"ר')).toBe('measure_area');
    expect(defaultQuickActionFor('מ"א')).toBe('measure_length');
    expect(defaultQuickActionFor('קומפלט')).toBe('confirm');
    expect(defaultQuickActionFor("יח'")).toBe('count');
  });
  it('evidence kinds geometry / stair / text with boxes and shapes', () => {
    const it0 = { sheetId: 's1-p0', versionId: 'v1', detectionId: 'g_1', linkGroupId: null, floor: '0' };
    expect(BoqEvidenceItemSchema.safeParse({ ...it0, kind: 'geometry', quantity: 4.2, geometryMm: { type: 'polygon', mm: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] } }).success).toBe(true);
    expect(BoqEvidenceItemSchema.safeParse({ ...it0, kind: 'geometry', geometryMm: { type: 'polygon', mm: [{ x: 0, y: 0 }, { x: 1, y: 0 }] } }).success).toBe(false);
    expect(BoqEvidenceItemSchema.safeParse({ ...it0, kind: 'stair', stair: { treads: 11 }, quantity: 11 }).success).toBe(true);
    expect(BoqEvidenceItemSchema.safeParse({ ...it0, detectionId: 'ti_3', kind: 'text', bboxMm: { x: 1, y: 2, w: 3, h: 4 } }).success).toBe(true);
    expect(BoqEvidenceItemSchema.safeParse({ ...it0, kind: 'blob' }).success).toBe(false);
  });
  it('build stats coverage', () => {
    const stats = { lines: 1, green: 0, yellow: 1, red: 0, sheets: 1, evidence: 1, coverage: { libraryCodes: 83, produced: 50, suggested: 27, missing: ['1.10'], byChapter: { '4': { libraryCodes: 28, produced: 20, suggested: 6, missing: 2 } } } };
    expect(BoqBuildStatsSchema.safeParse(stats).success).toBe(true);
    expect(BoqBuildStatsSchema.safeParse({ ...stats, coverage: { ...stats.coverage, missing: ['bad code!'] } }).success).toBe(false);
  });
  it('quick-measure request per kind', () => {
    const poly = { type: 'polygon', mm: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] };
    const ok = (b: unknown) => QuickMeasureRequestSchema.safeParse(b).success;
    expect(ok({ kind: 'measure_area', sheetId: 's1', geometry: poly })).toBe(true);
    expect(ok({ kind: 'measure_area', sheetId: 's1', geometry: { type: 'polyline', mm: poly.mm } })).toBe(false);
    expect(ok({ kind: 'measure_area', sheetId: 's1', geometry: poly, quantity: 3 })).toBe(false);
    expect(ok({ kind: 'measure_length', sheetId: 's1', geometry: { type: 'polyline', mm: poly.mm } })).toBe(true);
    expect(ok({ kind: 'count', sheetId: 's1', geometry: { type: 'point', mm: poly.mm }, quantity: 3 })).toBe(true);
    expect(ok({ kind: 'count', sheetId: 's1', geometry: { type: 'point', mm: poly.mm }, quantity: 2 })).toBe(false);
    expect(ok({ kind: 'confirm', sheetId: 's1', quantity: 1 })).toBe(true);
    expect(ok({ kind: 'confirm', sheetId: 's1', geometry: poly })).toBe(false);
    expect(ok({ kind: 'confirm', sheetId: 's1', extra: 1 })).toBe(false);
  });
  it('a stored correction may be bound to a line; accept + lineId is valid', () => {
    const c = {
      id: 'c1', kind: 'accept', sheetId: 's1', versionId: 'v1', anchorMm: { x: 0, y: 0 }, radiusMm: 3, detectionId: null, signature: null, class: null, itemCode: '8.03',
      linkGroupId: null, geometry: null, quantity: 1, unit: null, roomId: null, floor: null, reason: null, batchId: null, by: 'u1', at: '2026-11-01T00:00:00.000Z', revertedAt: null,
    };
    expect(CorrectionSchema.safeParse(c).success).toBe(false);
    expect(CorrectionSchema.safeParse({ ...c, lineId: 'ln_8_03', quickAction: 'confirm' }).success).toBe(true);
  });
  it('batch-status request', () => {
    expect(BatchLineStatusRequestSchema.parse({ lineIds: ['a'], to: 'approved' }).includeRed).toBe(false);
    expect(BatchLineStatusRequestSchema.safeParse({ lineIds: ['a', 'a'], to: 'approved' }).success).toBe(false);
    expect(BatchLineStatusRequestSchema.safeParse({ lineIds: [], to: 'approved' }).success).toBe(false);
    expect(BatchLineStatusRequestSchema.safeParse({ lineIds: ['a'], to: 'draft' }).success).toBe(false);
    expect(BatchLineStatusRequestSchema.safeParse({ lineIds: Array.from({ length: 501 }, (_, i) => `l${i}`), to: 'reviewed' }).success).toBe(false);
  });
});

describe('Sprint 6 — artifacts', () => {
  it('text_items + geometry artifacts; paths; registry', () => {
    const ti = { id: 't_1', kind: 'callout', text: 'לוח תקשורת', normalized: 'לוח תקשורת', bboxMm: { x: 1, y: 1, w: 10, h: 3 }, anchorMm: null, lineIdx: [3], floor: '0', roomId: null, lifecycle: 'new', qty: 1, unit: 'יחידה', lengthM: null, matchedPattern: 'comms_panel', itemCode: '4.25', role: 'item', pairedWith: null, corroborates: false, suggested: false, confidence: 0.6, scoreRaw: 0.6, level: 'yellow', reasons: ['טקסט'] };
    expect(TextItemsArtifactSchema.safeParse({ schema: 'kamutan.textItems/1', sheetId: 's1-p0', discipline: 'electrical', catalogVersion: 1, items: [ti], stats: {} }).success).toBe(true);
    expect(TextItemsArtifactSchema.safeParse({ schema: 'kamutan.textItems/1', items: [{ ...ti, reasons: [] }] }).success).toBe(false);
    expect(TextItemsArtifactSchema.safeParse({ schema: 'kamutan.textItems/1', items: [ti, ti] }).success).toBe(false);
    expect(TextItemsArtifactSchema.safeParse({ schema: 'kamutan.textItems/1', items: [{ ...ti, kind: 'title' }] }).success).toBe(false);
    const base = { floor: '-1', confidence: 0.7, level: 'yellow', reasons: ['מדידה מהשרטוט'], polygonMm: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], bboxMm: { x: 0, y: 0, w: 1, h: 1 }, label: null };
    const geo = {
      schema: 'kamutan.geometry/1', sheetId: 's1-p0', discipline: 'construction', scaleDenominator: 50, heights: [], levels: [],
      stairs: [{ ...base, id: 'st_1', regionId: null, lifecycle: 'new', treads: 11, risers: 12, lines: 12, numbered: true, numbers: null, descending: true, widthM: 1, goingM: 0.28, runLengthM: 3, roomId: null, key: 'k' }],
      regions: [{ ...base, id: 'hr_1', category: 'gypsum', pattern: 'lines', color: '#ff0000', lifecycle: 'new', areaM2: 4, perimeterM: 8, roomId: null, roomName: null, labelBboxMm: null, labelSource: null }],
      wallRuns: [{ ...base, id: 'wr_1', kind: 'block_new', closure: true, lifecycle: 'new', lengthM: 1, thicknessM: 0.2, heightM: 2.1, heightSource: 'default', areaM2: 2.1, roomIds: [], regionId: null }],
      lines: [{ ...base, id: 'ln_1', kind: 'valance_curtain', lengthM: 7, heightM: null, polylineMm: [{ x: 0, y: 0 }, { x: 1, y: 0 }], roomId: null }],
      ceilings: [], courtyards: [],
      measures: [{ key: 'stair_treads', unit: 'יחידה', qty: 11, computable: true, reason: null, estimate: null, floor: '-1', refs: ['st_1'], level: 'yellow', reasons: ['x'] }],
      stats: {},
    };
    expect(GeometryArtifactSchema.safeParse(geo).success).toBe(true);
    // follow-up (Worker-Geometry request): new keys + additive fields they already write
    expect(GEOMETRY_MEASURE_KEYS).toEqual(expect.arrayContaining(['demolished_wall_length', 'valance_length', 'demolished_wall_area']));
    const extra = {
      ...geo,
      regions: [{ ...geo.regions[0], roomType: 'kitchen' }],
      lines: [{ ...geo.lines[0], roomType: 'wc' }],
      courtyards: [{ ...base, id: 'cy_1', floorAreaM2: 9, stairId: 'st_1', wallRunIds: ['wr_1'], wallLengthM: 11, wallHeightM: 2.1, wallAreaM2: 23, waterproofing: true, faces: [{ kind: 'building', lengthM: 3, aMm: { x: 0, y: 0 }, bMm: { x: 1, y: 0 }, opening: true }] }],
      measures: [{ ...geo.measures[0], key: 'plaster_new_walls_area', unit: 'מ"ר', qty: null, computable: false, reason: 'גובה לא ידוע', estimate: { qty: 22.4, method: 'קירות החצר האנגלית + שני צדי קירות בלוק חדשים (הערכה לפי גובה קומה מונח)', courtyardM2: 18.2, blockM2: 4.2, widthM: null } }],
    };
    expect(GeometryArtifactSchema.safeParse(extra).success).toBe(true);
    expect(GeometryArtifactSchema.safeParse({ ...extra, courtyards: [{ ...extra.courtyards[0], waterproofing: 'yes' }] }).success).toBe(false);
    expect(GeometryArtifactSchema.safeParse({ ...geo, lines: [{ ...geo.lines[0], id: 'wr_1' }] }).success).toBe(false);
    expect(GeometryArtifactSchema.safeParse({ ...geo, measures: [{ ...geo.measures[0], computable: undefined }] }).success).toBe(false);
    const gp = storagePaths.geometry('o', 'p', 's', 'v');
    const tp = storagePaths.textItems('o', 'p', 's', 'v');
    expect(ARTIFACT_PATH_RE.test(gp)).toBe(true);
    expect(ARTIFACT_PATH_RE.test(tp)).toBe(false);
    expect(UNDERSTANDING_ARTIFACT_PATH_RE.test(gp) && UNDERSTANDING_ARTIFACT_PATH_RE.test(tp)).toBe(true);
    expect(VersionArtifactsSchema.safeParse({ geometry: gp, textItems: tp }).success).toBe(true);
    for (const n of ['TextItemsArtifact', 'GeometryArtifact', 'QuickMeasureRequest', 'QuickMeasureResponse', 'BatchLineStatusRequest', 'BatchLineStatusResponse', 'BoqCoverage']) {
      expect(Object.keys(jsonSchemaRegistry)).toContain(n);
      expect(() => readFileSync(join(__dirname, '..', 'json-schema', `${n}.json`), 'utf8')).not.toThrow();
    }
  });
});

describe('Owner decision 05.11 — 7.06 partition convention (faces / heightMode)', () => {
  const rule7 = (id: string) => DEFAULT_BOQ_RULES.find((r) => r.id === id);
  it('7.06 counts both faces at storey height; 7.07 unchanged', () => {
    expect(rule7('r_geo_gypsum_partition')?.match).toMatchObject({ keys: ['gypsum_partition_area'], faces: 2, heightMode: 'storey' });
    const m707 = rule7('r_geo_gypsum_partition_double')?.match as Record<string, unknown>;
    expect(m707.faces).toBeUndefined();
    expect(m707.heightMode).toBeUndefined();
  });
  it('faces 1|2 and heightMode storey|drawn only', () => {
    const base = { ...defaultRuleDoc(rule7('r_geo_gypsum_partition')!), updatedAt: null } as Record<string, unknown>;
    const withMatch = (m: Record<string, unknown>) => BoqRuleSchema.safeParse({ ...base, match: { ...(base.match as object), ...m } }).success;
    expect(withMatch({ faces: 1, heightMode: 'drawn' })).toBe(true);
    expect(withMatch({ faces: 3 })).toBe(false);
    expect(withMatch({ heightMode: 'ceiling' })).toBe(false);
  });
  it('evidence reason and wall-run lining are additive', () => {
    const ev = { sheetId: 's1', versionId: 'v1', detectionId: 'wr_1', linkGroupId: null, floor: 'ground', kind: 'geometry', quantity: 11.66, reason: 'חיפוי חד-צדדי' };
    expect(BoqEvidenceItemSchema.safeParse(ev).success).toBe(true);
    expect(BoqEvidenceItemSchema.safeParse({ ...ev, reason: 'x'.repeat(201) }).success).toBe(false);
    const wr = { id: 'wr_1', kind: 'gypsum_single', lifecycle: 'new', lengthM: 4.4, thicknessM: 0.07, heightM: 2.65, heightSource: 'section', areaM2: 11.66, regionId: null, floor: 'ground', confidence: 0.6, level: 'yellow', reasons: ['x'], polygonMm: null, bboxMm: null, label: null, lining: true, wallContactM: 4.28 };
    expect(GeometryArtifactSchema.safeParse({ schema: 'kamutan.geometry/1', discipline: 'construction', scaleDenominator: 50, wallRuns: [wr] }).success).toBe(true);
  });
});
