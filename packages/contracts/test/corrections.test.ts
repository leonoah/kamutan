import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BoqEvidenceArtifactSchema,
  BoqLineSchema,
  BoqRuleSchema,
  CORRECTION_BATCH_MAX,
  CORRECTION_KIND_MIN_ROLE,
  CORRECTION_KINDS,
  CorrectionSchema,
  CreateCorrectionBatchRequestSchema,
  CreateCorrectionRequestSchema,
  CreateSimilarSearchRequestSchema,
  DEFAULT_BOQ_RULES,
  DEFAULT_BOQ_RULES_VERSION,
  DEFAULT_ORG_SETTINGS,
  defaultRoomSettings,
  defaultRuleDoc,
  FindSimilarJobSchema,
  fsPaths,
  IngestTopicJobSchema,
  ListCorrectionsQuerySchema,
  OrgSettingsSchema,
  PutRoomSettingsRequestSchema,
  ReviewQueueQuerySchema,
  RoomsArtifactSchema,
  ruleNeedsReseed,
  SIMILAR_THUMB_PATH_RE,
  SimilarSearchSchema,
  storagePaths,
  SYMBOL_CLASSES,
  jsonSchemaRegistry,
  ONE_OFF_SUGGESTION_REASON,
} from '../src/index.js';

const base = { sheetId: 's1-p0', versionId: 'v1', anchorMm: { x: 10, y: 20 } };

describe('CreateCorrectionRequest (per-kind rules)', () => {
  const ok = (b: Record<string, unknown>) => CreateCorrectionRequestSchema.safeParse({ ...base, ...b }).success;

  it('fills defaults (radius 3 mm, nulls)', () => {
    const c = CreateCorrectionRequestSchema.parse({ ...base, kind: 'accept', detectionId: 'd_1' });
    expect(c.radiusMm).toBe(3);
    expect(c.class).toBeNull();
    expect(c.geometry).toBeNull();
    expect(c.reason).toBeNull();
  });
  it('add needs class or itemCode, no detectionId', () => {
    expect(ok({ kind: 'add', class: 'socket_double' })).toBe(true);
    expect(ok({ kind: 'add', itemCode: '4.01', geometry: { type: 'point', mm: [{ x: 1, y: 1 }] } })).toBe(true);
    expect(ok({ kind: 'add' })).toBe(false);
    expect(ok({ kind: 'add', class: 'socket_double', detectionId: 'd_1' })).toBe(false);
    expect(ok({ kind: 'add', class: 'unknown' })).toBe(false);
  });
  it('remove / accept / reject need a target', () => {
    expect(ok({ kind: 'remove', detectionId: 'd_1' })).toBe(true);
    expect(ok({ kind: 'remove', linkGroupId: 'lk_1' })).toBe(true);
    expect(ok({ kind: 'remove' })).toBe(false);
    expect(ok({ kind: 'accept', roomId: 'r_1' })).toBe(true);
    expect(ok({ kind: 'reject' })).toBe(false);
  });
  it('reclassify / move', () => {
    expect(ok({ kind: 'reclassify', detectionId: 'd_1', class: 'socket_power' })).toBe(true);
    expect(ok({ kind: 'reclassify', detectionId: 'd_1' })).toBe(false);
    expect(ok({ kind: 'move', detectionId: 'd_1', geometry: { type: 'point', mm: [{ x: 5, y: 5 }] } })).toBe(true);
    expect(ok({ kind: 'move', detectionId: 'd_1' })).toBe(false);
  });
  it('link / unlink', () => {
    expect(ok({ kind: 'link', switchIds: ['d_s'], pointIds: ['d_l'] })).toBe(true);
    expect(ok({ kind: 'link', linkGroupId: 'lk_2', pointIds: ['d_l'] })).toBe(true);
    expect(ok({ kind: 'link', switchIds: ['d_s'] })).toBe(false);
    expect(ok({ kind: 'unlink', linkGroupId: 'lk_2' })).toBe(true);
    expect(ok({ kind: 'unlink' })).toBe(false);
  });
  it('measure: polygon m2 / polyline m, itemCode required', () => {
    const poly = { type: 'polygon', mm: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] };
    expect(ok({ kind: 'measure', itemCode: '5.06', geometry: poly, unit: 'm2', quantity: 2 })).toBe(true);
    expect(ok({ kind: 'measure', itemCode: '5.06', geometry: poly, unit: 'm' })).toBe(false);
    expect(ok({ kind: 'measure', geometry: poly, unit: 'm2' })).toBe(false);
    expect(ok({ kind: 'measure', itemCode: '5.03', geometry: { type: 'polyline', mm: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }, unit: 'm' })).toBe(true);
    expect(ok({ kind: 'measure', itemCode: '5.03', geometry: { type: 'polygon', mm: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }, unit: 'm2' })).toBe(false);
  });
  it('count: quantity equals clicks', () => {
    const g = { type: 'point', mm: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
    expect(ok({ kind: 'count', itemCode: '3.06', geometry: g })).toBe(true);
    expect(ok({ kind: 'count', itemCode: '3.06', geometry: g, quantity: 2, unit: 'unit' })).toBe(true);
    expect(ok({ kind: 'count', itemCode: '3.06', geometry: g, quantity: 3 })).toBe(false);
    expect(ok({ kind: 'count', itemCode: '3.06', geometry: g, unit: 'm2' })).toBe(false);
  });
  it('unit only for measure / count; radius bounds; strict', () => {
    expect(ok({ kind: 'accept', detectionId: 'd_1', unit: 'm2' })).toBe(false);
    expect(ok({ kind: 'accept', detectionId: 'd_1', radiusMm: 0 })).toBe(false);
    expect(ok({ kind: 'accept', detectionId: 'd_1', radiusMm: 51 })).toBe(false);
    expect(ok({ kind: 'accept', detectionId: 'd_1', by: 'x' })).toBe(false);
  });
  it('role per kind: accept/reject reviewer, everything else editor', () => {
    for (const k of CORRECTION_KINDS) expect(CORRECTION_KIND_MIN_ROLE[k]).toBe(k === 'accept' || k === 'reject' ? 'reviewer' : 'editor');
  });
  it('stored doc carries by/at/batchId/revertedAt', () => {
    const doc = { id: 'c1', ...CreateCorrectionRequestSchema.parse({ ...base, kind: 'accept', detectionId: 'd_1' }), batchId: null, by: 'u1', at: '2026-10-14T10:00:00.000Z', revertedAt: null };
    expect(CorrectionSchema.parse(doc).kind).toBe('accept');
    expect(CorrectionSchema.safeParse({ ...doc, by: undefined }).success).toBe(false);
  });
});

describe('batch / list / queue queries', () => {
  const item = { ...base, kind: 'reject', detectionId: 'd_1' };
  it('1..500 items', () => {
    expect(CreateCorrectionBatchRequestSchema.safeParse({ items: [] }).success).toBe(false);
    expect(CreateCorrectionBatchRequestSchema.parse({ items: [item] }).source).toBe('other');
    expect(CreateCorrectionBatchRequestSchema.safeParse({ items: Array(CORRECTION_BATCH_MAX).fill(item) }).success).toBe(true);
    expect(CreateCorrectionBatchRequestSchema.safeParse({ items: Array(CORRECTION_BATCH_MAX + 1).fill(item) }).success).toBe(false);
    expect(CreateCorrectionBatchRequestSchema.safeParse({ items: [{ ...item, detectionId: null }] }).success).toBe(false);
  });
  it('list query coerces includeReverted', () => {
    expect(ListCorrectionsQuerySchema.parse({}).includeReverted).toBe(false);
    expect(ListCorrectionsQuerySchema.parse({ includeReverted: 'true', limit: '10' })).toMatchObject({ includeReverted: true, limit: 10 });
  });
  it('queue query', () => {
    expect(ReviewQueueQuerySchema.parse({}).limit).toBe(50);
    expect(ReviewQueueQuerySchema.safeParse({ level: 'green' }).success).toBe(false);
    expect(ReviewQueueQuerySchema.safeParse({ cursor: 'abc' }).success).toBe(false);
    expect(ReviewQueueQuerySchema.safeParse({ kind: 'cluster', cursor: '50' }).success).toBe(true);
  });
});

describe('room settings', () => {
  const s = defaultRoomSettings('bathroom');
  it('defaults by type', () => {
    expect(s).toMatchObject({ claddingHeightM: 2.6, floorTiled: true, includeInWaterproofing: true, wasteFactor: 0.07 });
    expect(defaultRoomSettings('wc').claddingHeightM).toBe(2.6);
    expect(defaultRoomSettings('kitchen')).toMatchObject({ claddingHeightM: 0, floorTiled: false, partialCladding: [] });
    expect(defaultRoomSettings('courtyard').floorTiled).toBe(true);
    expect(defaultRoomSettings(null, true).includeInWaterproofing).toBe(true);
    expect(defaultRoomSettings('bedroom').floorTiled).toBe(false);
  });
  it('v4 defaults: ceiling cap, niches, waterproofing only with shower/bath', () => {
    expect(defaultRoomSettings('bathroom', true, { ceilingHeightM: 2.4 })).toMatchObject({ claddingHeightM: 2.4, ceilingHeightM: 2.4 });
    expect(defaultRoomSettings('bathroom', true, { ceilingHeightM: 2.8 }).claddingHeightM).toBe(2.6);
    expect(defaultRoomSettings('bathroom', true, { niche: true })).toMatchObject({ claddingHeightM: 0, floorTiled: true, includeInWaterproofing: false });
    expect(defaultRoomSettings('wc').includeInWaterproofing).toBe(false);
    expect(defaultRoomSettings('wc', true, { hasShowerOrBath: true }).includeInWaterproofing).toBe(true);
    expect(defaultRoomSettings('bathroom', true, { hasShowerOrBath: false }).includeInWaterproofing).toBe(false);
    expect(defaultRoomSettings('bathroom').includeInWaterproofing).toBe(true);
  });
  it('validates bounds and partial cladding', () => {
    expect(PutRoomSettingsRequestSchema.safeParse(s).success).toBe(true);
    expect(PutRoomSettingsRequestSchema.safeParse({ ...s, claddingHeightM: 7 }).success).toBe(false);
    expect(PutRoomSettingsRequestSchema.safeParse({ ...s, wasteFactor: 0.6 }).success).toBe(false);
    expect(PutRoomSettingsRequestSchema.safeParse({ ...s, partialCladding: [{ wallId: 'w_1', fromM: 1, toM: 0.5, heightM: 0.6 }] }).success).toBe(false);
    expect(PutRoomSettingsRequestSchema.safeParse({ ...s, partialCladding: [{ wallId: 'w_1', fromM: 0, toM: 2, heightM: 0.6 }] }).success).toBe(true);
    expect(PutRoomSettingsRequestSchema.safeParse({ ...s, partialCladding: [{ wallId: 'x', fromM: 0, toM: 2, heightM: 0.6 }] }).success).toBe(false);
    expect(PutRoomSettingsRequestSchema.safeParse({ ...s, extra: 1 }).success).toBe(false);
  });
  it('doc path', () => {
    expect(fsPaths.roomSettings('o', 'p', 's1-p0', 'r_3')).toBe('orgs/o/projects/p/roomSettings/s1-p0__r_3');
  });
});

describe('rooms artifact (Sprint 4 upgrades)', () => {
  const room = {
    id: 'r_1',
    name: 'רחצה',
    nameConfidence: 0.9,
    floor: '0',
    polygonMm: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
    areaM2: 5,
    perimeterM: 9,
    confidence: 0.9,
    level: 'green',
    reasons: [],
  };
  const walls = [{ id: 'w_1', aMm: { x: 0, y: 0 }, bMm: { x: 10, y: 0 }, lengthM: 2.5, exterior: false }];
  it('old rooms stay valid; new fields validated', () => {
    expect(RoomsArtifactSchema.safeParse({ schema: 'kamutan.rooms/1', rooms: [room] }).success).toBe(true);
    const up = { ...room, type: 'bathroom', wet: true, walls, openings: [{ id: 'o_1', kind: 'door', wallId: 'w_1', widthM: 0.8, heightM: null, centerMm: { x: 5, y: 0 } }], externalCorners: 2 };
    expect(RoomsArtifactSchema.safeParse({ schema: 'kamutan.rooms/1', rooms: [up] }).success).toBe(true);
    expect(RoomsArtifactSchema.safeParse({ schema: 'kamutan.rooms/1', rooms: [{ ...up, type: 'garage' }] }).success).toBe(false);
    const bad = { ...up, openings: [{ ...up.openings[0], wallId: 'w_9' }] };
    expect(RoomsArtifactSchema.safeParse({ schema: 'kamutan.rooms/1', rooms: [bad] }).success).toBe(false);
    expect(RoomsArtifactSchema.safeParse({ schema: 'kamutan.rooms/1', rooms: [{ ...up, walls: [...walls, walls[0]] }] }).success).toBe(false);
  });
});

describe('rules v3 (plumbing + tiling)', () => {
  it('version 3, every default parses, reseed of v2 defaults', () => {
    expect(DEFAULT_BOQ_RULES_VERSION).toBe(5);
    expect(ruleNeedsReseed({ source: 'default', defaultsVersion: 3 })).toBe(true);
    for (const r of DEFAULT_BOQ_RULES) expect(BoqRuleSchema.safeParse({ ...defaultRuleDoc(r), updatedAt: null }).success, r.id).toBe(true);
    expect(ruleNeedsReseed({ source: 'default', defaultsVersion: 2 })).toBe(true);
    expect(ruleNeedsReseed({ source: 'user', defaultsVersion: 2 })).toBe(false);
  });
  it('covers the sample codes of chapters 03 and 05', () => {
    const codes = new Set(DEFAULT_BOQ_RULES.map((r) => r.itemCode));
    for (const c of ['3.01', '3.02', '3.03', '3.04', '3.05', '3.06', '3.07', '3.08', '3.09', '3.10', '3.11', '3.12', '3.13', '3.14', '3.15', '5.01', '5.02', '5.03', '5.05', '5.06', '5.07']) {
      expect(codes.has(c), c).toBe(true);
    }
    const byId = Object.fromEntries(DEFAULT_BOQ_RULES.map((r) => [r.id, r]));
    expect(byId.r_plumb_basin_wall_faucet?.priority).toBeGreaterThan(byId.r_plumb_basin_flower_faucet?.priority ?? 0);
    expect(byId.r_oneoff_manifold?.reasons).toEqual([ONE_OFF_SUGGESTION_REASON]);
    expect(byId.r_tile_cladding_wet?.wasteFactor).toBe(0.07);
    expect(byId.r_tile_corners?.unit).toBe('מ"א');
    // v4 (Data back-solve)
    expect(byId.r_tile_cladding_wet?.match).toMatchObject({ defaultDoorHeightM: 2.1, defaultWindowSillM: 1.0, defaultWindowHeadM: 2.1, capAtCeiling: true, excludeNiches: true });
    expect(byId.r_tile_floor_wet?.match).toMatchObject({ roomTypes: ['bathroom', 'wc'], includeNiches: true });
    expect(byId.r_waterproofing_wet?.match).toMatchObject({ requireFixtureClasses: ['fixture_shower', 'fixture_bath'] });
  });
  it('rejects malformed Sprint 4 matches', () => {
    const r = { id: 'x', itemCode: '3.01', priority: 1, enabled: true, source: 'custom', updatedAt: null };
    expect(BoqRuleSchema.safeParse({ ...r, kind: 'plumbing_point', match: { fixtureClasses: ['ac_unit'], perRoom: false } }).success).toBe(true);
    expect(BoqRuleSchema.safeParse({ ...r, kind: 'plumbing_point', match: { fixtureClasses: ['ac_unit'] } }).success).toBe(false);
    expect(BoqRuleSchema.safeParse({ ...r, kind: 'tiling_cladding', match: { mode: 'diagonal', subtractOpenings: true } }).success).toBe(false);
    expect(BoqRuleSchema.safeParse({ ...r, kind: 'one_off_suggestion', match: { quantity: 0 } }).success).toBe(false);
    expect(BoqRuleSchema.safeParse({ ...r, kind: 'waterproofing', match: { wetOnly: true, roomTypes: ['bathroom'] } }).success).toBe(true);
  });
  it('plumbing classes exist in the taxonomy', () => {
    for (const c of ['fixture_shower', 'fixture_bath', 'fixture_kitchen_sink', 'fixture_washing_machine', 'garden_tap', 'ac_unit']) {
      expect((SYMBOL_CLASSES as readonly string[]).includes(c), c).toBe(true);
    }
  });
});

describe('BOQ additions', () => {
  it('orderQty / evidence source / unmatched corrections', () => {
    const line = { id: 'l1', chapter: '05', code: '5.01', description: 'x', qty: 10, unit: 'מ"ר', level: 'yellow', status: 'draft', orderQty: 10.7, wasteFactor: 0.07 };
    expect(BoqLineSchema.parse(line).orderQty).toBe(10.7);
    const ev = {
      schema: 'kamutan.boq-evidence/1',
      lines: { l1: [{ sheetId: 's', versionId: 'v', detectionId: 'm_c1', linkGroupId: null, floor: '0', source: 'manual', correctionId: 'c1', quantity: 2.5, roomId: 'r_1' }] },
      corrections: { applied: ['c1'], unmatched: [{ correctionId: 'c2', sheetId: 's', versionId: 'v2', reason: 'no detection near anchor' }] },
    };
    expect(BoqEvidenceArtifactSchema.safeParse(ev).success).toBe(true);
    expect(BoqEvidenceArtifactSchema.safeParse({ ...ev, lines: { l1: [{ ...ev.lines.l1[0], source: 'robot' }] } }).success).toBe(false);
  });
  it('org autoRebuild default true', () => {
    expect(DEFAULT_ORG_SETTINGS.autoRebuild).toBe(true);
    expect(OrgSettingsSchema.safeParse({ ...DEFAULT_ORG_SETTINGS, autoRebuild: false }).success).toBe(true);
  });
});

describe('find_similar', () => {
  const exemplar = { sheetId: 's1-p0', versionId: 'v1', bboxMm: { x: 1, y: 2, w: 4, h: 4 }, class: 'socket_double' };
  it('request + job in the ingest union', () => {
    expect(CreateSimilarSearchRequestSchema.parse({ exemplar }).scope).toBe('project');
    expect(CreateSimilarSearchRequestSchema.safeParse({ exemplar: { ...exemplar, bboxMm: { x: 0, y: 0, w: 0, h: 3 } } }).success).toBe(false);
    const job = { schemaVersion: 1, type: 'symbols.find_similar', jobId: 'j1', orgId: 'o1', projectId: 'p1', searchId: 'ss1', exemplar, scope: 'sheet', maxCandidates: 200, traceparent: null };
    expect(FindSimilarJobSchema.safeParse(job).success).toBe(true);
    expect(IngestTopicJobSchema.safeParse(job).success).toBe(true);
    expect(IngestTopicJobSchema.safeParse({ ...job, maxCandidates: 501 }).success).toBe(false);
  });
  it('result doc: thumb = {id}.webp, unique ids; crop path regex', () => {
    const cand = { id: 'c_1', sheetId: 's1-p0', versionId: 'v1', centerMm: { x: 1, y: 1 }, bboxMm: { x: 0, y: 0, w: 2, h: 2 }, score: 0.9, alreadyDetected: null, currentClass: null, thumb: 'c_1.webp' };
    const doc = { id: 'ss1', status: 'succeeded', exemplar, scope: 'sheet', correctionId: null, jobId: 'j1', requestedBy: 'u1', createdAt: '2026-10-14T10:00:00.000Z', finishedAt: null, candidates: [cand], thumbs: 1, error: null };
    expect(SimilarSearchSchema.safeParse(doc).success).toBe(true);
    expect(SimilarSearchSchema.safeParse({ ...doc, candidates: [{ ...cand, thumb: 'c_2.webp' }] }).success).toBe(false);
    expect(SimilarSearchSchema.safeParse({ ...doc, candidates: [cand, cand] }).success).toBe(false);
    const path = storagePaths.similarThumb('o1', 'p1', 'ss1', 'c_1');
    expect(SIMILAR_THUMB_PATH_RE.test(path)).toBe(true);
    expect(SIMILAR_THUMB_PATH_RE.test('orgs/o1/projects/p1/similar/ss1/../x.webp')).toBe(false);
  });
});

describe('json-schema export (Sprint 4 names)', () => {
  const dir = join(__dirname, '..', 'json-schema');
  it('every Sprint 4 schema is registered and generated', () => {
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { schemas: string[] };
    for (const n of ['CreateCorrectionRequest', 'CorrectionBatch', 'RoomSettings', 'ReviewQueueItem', 'FindSimilarJob', 'SimilarSearch', 'RoomWall', 'RoomOpening', 'UnmatchedCorrection', 'FixturesArtifact', 'WallsArtifact']) {
      expect(n in jsonSchemaRegistry, n).toBe(true);
      expect(index.schemas).toContain(`${n}.json`);
    }
    const defaults = JSON.parse(readFileSync(join(dir, 'defaults', 'boq-defaults.json'), 'utf8')) as { rules: Array<{ id: string; defaultsVersion: number }> };
    expect(defaults.rules.find((r) => r.id === 'r_plumb_ac_drain')?.defaultsVersion).toBe(5);
  });
});

describe('fixtures / walls artifacts (Sprint 4 integration)', () => {
  it('fixtures: Detection + extended optional fields, id without d_ prefix, extras passthrough; walls: drawings', async () => {
    const { FixturesArtifactSchema, WallsArtifactSchema, ARTIFACT_PATH_RE, UNDERSTANDING_ARTIFACT_PATH_RE, VersionArtifactsSchema, OverlayManifestSchema } = await import('../src/index.js');
    const rec = {
      id: 'fx_1', class: 'fixture_basin', legendEntryId: null, centerMm: { x: 1, y: 1 }, bboxMm: { x: 0, y: 0, w: 2, h: 2 }, angleDeg: 0, score: 0.9, level: 'green',
      reasons: [], roomId: null, floor: '0', lifecycle: 'unknown', supply: null, annotations: [], clusterId: null,
      source: 'shape+text', attachedTo: null, label: 'כיור', leaderMm: [{ x: 1, y: 1 }], sheetId: 's1-p0', duplicates: ['s2-p0/d_3'], futureField: 1,
    };
    const ok = FixturesArtifactSchema.safeParse({ schema: 'kamutan.fixtures/1', fixtures: [rec, { ...rec, id: 'd_2', source: undefined, leaderMm: undefined }] });
    expect(ok.success).toBe(true);
    expect(FixturesArtifactSchema.safeParse({ schema: 'kamutan.fixtures/1', fixtures: [rec, rec] }).success).toBe(false);
    expect(FixturesArtifactSchema.safeParse({ schema: 'kamutan.fixtures/1', fixtures: [{ ...rec, class: 'not_a_class' }] }).success).toBe(false);
    const ring = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
    expect(WallsArtifactSchema.safeParse({ schema: 'kamutan.walls/1', drawings: [{ floor: '0', scaleDenominator: 50, sheetId: 's1-p0', regionId: null, polygonsMm: [{ exterior: ring, holes: [ring] }], closuresMm: [] }] }).success).toBe(true);
    for (const f of ['fixtures', 'walls'] as const) {
      const p = storagePaths[f]('o', 'p', 's', 'v');
      expect(ARTIFACT_PATH_RE.test(p) && UNDERSTANDING_ARTIFACT_PATH_RE.test(p), f).toBe(true);
    }
    expect(VersionArtifactsSchema.parse({ fixtures: 'a', walls: 'b' })).toEqual({ fixtures: 'a', walls: 'b' });
    expect(OverlayManifestSchema.shape.fixtures).toBeDefined();
  });
});
