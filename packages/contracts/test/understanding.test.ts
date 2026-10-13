import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_PATH_RE,
  DetectionsArtifactSchema,
  jsonSchemaRegistry,
  LegendArtifactSchema,
  LegendEntrySchema,
  levelForScore,
  OverlayManifestSchema,
  PatchLegendEntryRequestSchema,
  ResolveUnknownClusterRequestSchema,
  RoomsArtifactSchema,
  SheetVersionSchema,
  storagePaths,
  SymbolMappingSchema,
  UNDERSTANDING_ARTIFACT_PATH_RE,
  VERSION_STAGES,
} from '../src/index.js';

const SHEET = `${'b'.repeat(64)}-p0`;
const SIG = 'f'.repeat(40);
const box = { x: 10, y: 20, w: 5, h: 5 };

const legend = () => ({
  schema: 'kamutan.legend/1',
  legends: [{ id: 'lg0', bboxMm: { x: 700, y: 20, w: 120, h: 200 }, title: 'מקרא', confidence: 0.9 }],
  entries: [
    {
      id: `le_${SHEET}_0`,
      legendId: 'lg0',
      symbolBboxMm: box,
      labelBboxMm: { x: 720, y: 30, w: 60, h: 6 },
      label: 'שקע כפול',
      labelConfidence: 0.93,
      suggestedClass: 'socket_double',
      classConfidence: 0.8,
      signature: SIG,
      thumb: `legend/le_${SHEET}_0.webp`,
    },
  ],
});

const detections = () => ({
  schema: 'kamutan.detections/1',
  detections: [
    {
      id: 'd_0',
      class: 'socket_double',
      legendEntryId: `le_${SHEET}_0`,
      centerMm: { x: 100, y: 120 },
      bboxMm: { x: 97, y: 117, w: 6, h: 6 },
      angleDeg: 0,
      score: 0.9,
      level: 'green',
      reasons: [],
      roomId: 'r_0',
      floor: 'ground',
      lifecycle: 'new',
      supply: null,
      annotations: ['2X'],
      clusterId: null,
    },
    {
      id: 'd_1',
      class: 'unknown',
      legendEntryId: null,
      centerMm: { x: 200, y: 120 },
      bboxMm: { x: 197, y: 117, w: 6, h: 6 },
      angleDeg: 90,
      score: 0.3,
      level: 'red',
      reasons: ['סמל לא במקרא'],
      roomId: null,
      floor: null,
      lifecycle: 'unknown',
      supply: null,
      annotations: [],
      clusterId: 'u_0',
    },
  ],
  unknownClusters: [{ id: 'u_0', signature: 'a'.repeat(40), count: 7, exemplarBboxMm: box, thumb: 'unknown/u_0.webp' }],
});

const rooms = () => ({
  schema: 'kamutan.rooms/1',
  rooms: [
    {
      id: 'r_0',
      name: 'סלון',
      nameConfidence: 0.9,
      floor: 'ground',
      polygonMm: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 80 },
      ],
      areaM2: 22.5,
      perimeterM: 19.2,
      confidence: 0.7,
      level: 'yellow',
      reasons: ['שם חדר חלקי'],
    },
  ],
});

describe('artifacts (brief shapes)', () => {
  it('accepts the brief examples', () => {
    expect(LegendArtifactSchema.parse(legend()).entries).toHaveLength(1);
    expect(DetectionsArtifactSchema.parse(detections()).detections).toHaveLength(2);
    expect(RoomsArtifactSchema.parse(rooms()).rooms[0]?.name).toBe('סלון');
  });

  it('rejects a wrong schema tag and tuple points', () => {
    expect(LegendArtifactSchema.safeParse({ ...legend(), schema: 'kamutan.legend/2' }).success).toBe(false);
    const r = rooms();
    (r.rooms[0] as Record<string, unknown>).polygonMm = [[0, 0], [1, 0], [1, 1]];
    expect(RoomsArtifactSchema.safeParse(r).success).toBe(false);
  });

  it('legend: unknown legendId, foreign thumb, duplicate ids and bad signatures are rejected', () => {
    const a = legend();
    a.entries[0]!.legendId = 'lg9';
    expect(LegendArtifactSchema.safeParse(a).success).toBe(false);
    const b = legend();
    b.entries[0]!.thumb = 'legend/le_other.webp';
    expect(LegendArtifactSchema.safeParse(b).success).toBe(false);
    const c = legend();
    c.entries.push({ ...c.entries[0]! });
    expect(LegendArtifactSchema.safeParse(c).success).toBe(false);
    const d = legend();
    d.entries[0]!.signature = 'has/slash-and-is-long';
    expect(LegendArtifactSchema.safeParse(d).success).toBe(false);
    const e = legend();
    e.entries[0]!.thumb = '../../../other-org/x.webp';
    expect(LegendArtifactSchema.safeParse(e).success).toBe(false);
  });

  it('detections: non-green needs a reason; unknown needs a known clusterId; class is a taxonomy id', () => {
    const a = detections();
    a.detections[1]!.reasons = [];
    expect(DetectionsArtifactSchema.safeParse(a).success).toBe(false);
    const b = detections();
    b.detections[1]!.clusterId = null;
    expect(DetectionsArtifactSchema.safeParse(b).success).toBe(false);
    const c = detections();
    c.detections[1]!.clusterId = 'u_9';
    expect(DetectionsArtifactSchema.safeParse(c).success).toBe(false);
    const d = detections();
    d.detections[0]!.class = 'socket_quadruple';
    expect(DetectionsArtifactSchema.safeParse(d).success).toBe(false);
    const e = detections();
    (e.detections[0] as Record<string, unknown>).lifecycle = 'removed';
    expect(DetectionsArtifactSchema.safeParse(e).success).toBe(false);
  });

  it('rooms: non-green needs a reason', () => {
    const a = rooms();
    a.rooms[0]!.reasons = [];
    expect(RoomsArtifactSchema.safeParse(a).success).toBe(false);
  });

  it('levelForScore follows the brief thresholds', () => {
    expect(levelForScore(0.9)).toBe('green');
    expect(levelForScore(0.85)).toBe('green');
    expect(levelForScore(0.9, { warning: true })).toBe('yellow');
    expect(levelForScore(0.95, { raster: true })).toBe('yellow');
    expect(levelForScore(0.5)).toBe('yellow');
    expect(levelForScore(0.49)).toBe('red');
  });
});

describe('version doc additions', () => {
  it('stages are in brief order', () => {
    expect(VERSION_STAGES).toEqual(['ingest', 'render', 'ocr', 'classify', 'scale', 'legend', 'detect', 'rooms', 'done']);
  });

  it('artifacts + stats extensions parse; Sprint-1 docs still parse', () => {
    const base = {
      id: 'v1',
      sheetId: SHEET,
      status: 'ready',
      progress: { stage: 'rooms', pct: 90 },
      page: { widthMm: 841, heightMm: 594, rotation: 0 },
      artifacts: {
        legend: storagePaths.legend('o', 'p', SHEET, 'v1'),
        detections: storagePaths.detections('o', 'p', SHEET, 'v1'),
        rooms: storagePaths.rooms('o', 'p', SHEET, 'v1'),
      },
      regions: [],
      stats: {
        paths: 1,
        segments: 2,
        textLines: 3,
        glyphs: 4,
        detections: { total: 2, green: 1, yellow: 0, red: 1, unknown: 1, byClass: { socket_double: 1, unknown: 1 } },
        rooms: 1,
        legendEntries: 1,
      },
      workerVersion: '0.2.0',
      updatedAt: null,
    };
    expect(SheetVersionSchema.parse(base).stats?.detections?.total).toBe(2);
    expect(SheetVersionSchema.parse({ ...base, stats: { paths: 1, segments: 2, textLines: 3, glyphs: 4 } }).stats?.rooms).toBeUndefined();
  });
});

describe('storage paths', () => {
  it('new artifacts and crops are signable; llm-cache and traversal are not', () => {
    for (const p of [
      storagePaths.legend('o', 'p', SHEET, 'v'),
      storagePaths.detections('o', 'p', SHEET, 'v'),
      storagePaths.rooms('o', 'p', SHEET, 'v'),
      storagePaths.legendThumb('o', 'p', SHEET, 'v', `le_${SHEET}_3`),
      storagePaths.unknownThumb('o', 'p', SHEET, 'v', 'u_7'),
    ]) {
      expect(ARTIFACT_PATH_RE.test(p), p).toBe(true);
    }
    expect(UNDERSTANDING_ARTIFACT_PATH_RE.test(storagePaths.rooms('o', 'p', SHEET, 'v'))).toBe(true);
    expect(UNDERSTANDING_ARTIFACT_PATH_RE.test(storagePaths.thumbnail('o', 'p', SHEET, 'v'))).toBe(false);
    expect(ARTIFACT_PATH_RE.test(`${storagePaths.llmCachePrefix('o')}abc`)).toBe(false);
    expect(ARTIFACT_PATH_RE.test(storagePaths.legendThumb('o', 'p', SHEET, 'v', 'u_1'))).toBe(false);
    expect(ARTIFACT_PATH_RE.test(storagePaths.legendThumb('o', 'p', SHEET, 'v', 'le_../x'))).toBe(false);
  });
});

describe('Firestore docs + DTOs', () => {
  const entry = {
    id: `le_${SHEET}_0`,
    sheetId: SHEET,
    versionId: 'v1',
    label: 'שקע כפול',
    labelConfidence: 0.93,
    suggestedClass: 'socket_double',
    class: null,
    itemCode: null,
    signature: SIG,
    thumbPath: storagePaths.legendThumb('o', 'p', SHEET, 'v1', `le_${SHEET}_0`),
    status: 'suggested',
    updatedAt: '2026-10-13T10:00:00.000Z',
  };

  it('legend entry + symbol mapping', () => {
    expect(LegendEntrySchema.parse(entry).status).toBe('suggested');
    expect(LegendEntrySchema.safeParse({ ...entry, class: 'unknown' }).success).toBe(false);
    expect(LegendEntrySchema.safeParse({ ...entry, itemCode: 4.1 }).success).toBe(false);
    expect(
      SymbolMappingSchema.parse({ signature: SIG, class: 'socket_double', ignored: false, itemCode: '4.10', label: 'שקע כפול', confirmedBy: 'u1', confirmedAt: '2026-10-13T10:00:00.000Z', uses: 2 }).itemCode,
    ).toBe('4.10');
    expect(
      SymbolMappingSchema.parse({ signature: SIG, class: null, ignored: true, itemCode: null, label: '', confirmedBy: 'u1', confirmedAt: '2026-10-13T10:00:00.000Z', uses: 1 }).ignored,
    ).toBe(true);
  });

  it('PATCH request: confirm (class optional), reassign (class required), ignore (no extra keys), taxonomy enforced', () => {
    expect(PatchLegendEntryRequestSchema.parse({ action: 'confirm' })).toEqual({ action: 'confirm' });
    expect(PatchLegendEntryRequestSchema.parse({ action: 'confirm', class: 'socket_power', itemCode: '08.010' }).action).toBe('confirm');
    expect(PatchLegendEntryRequestSchema.safeParse({ action: 'reassign' }).success).toBe(false);
    expect(PatchLegendEntryRequestSchema.safeParse({ action: 'reassign', class: 'unknown' }).success).toBe(false);
    expect(PatchLegendEntryRequestSchema.safeParse({ action: 'confirm', class: 'bogus' }).success).toBe(false);
    expect(PatchLegendEntryRequestSchema.safeParse({ action: 'ignore', class: 'socket_power' }).success).toBe(false);
    expect(PatchLegendEntryRequestSchema.safeParse({ action: 'delete' }).success).toBe(false);
    expect(PatchLegendEntryRequestSchema.parse({ action: 'reassign', class: 'socket_power', label: 'שקע כח מוגן' })).toMatchObject({ label: 'שקע כח מוגן' });
    expect(PatchLegendEntryRequestSchema.safeParse({ action: 'confirm', label: 'x'.repeat(301) }).success).toBe(false);
    expect(PatchLegendEntryRequestSchema.safeParse({ action: 'ignore', label: 'x' }).success).toBe(false);
  });

  it('resolve request', () => {
    expect(ResolveUnknownClusterRequestSchema.parse({ sheetId: SHEET, versionId: 'v1', class: 'switch_2way', createLegendEntry: true }).class).toBe('switch_2way');
    expect(ResolveUnknownClusterRequestSchema.safeParse({ sheetId: SHEET, versionId: 'v1', class: 'switch_2way' }).success).toBe(false);
    const base = { sheetId: SHEET, versionId: 'v1', createLegendEntry: false };
    expect(ResolveUnknownClusterRequestSchema.parse({ ...base, ignore: true }).ignore).toBe(true);
    expect(ResolveUnknownClusterRequestSchema.parse({ ...base, class: 'switch_2way', ignore: false }).class).toBe('switch_2way');
    for (const bad of [{}, { ignore: false }, { ignore: true, class: 'switch_2way' }, { ignore: true, itemCode: '1.1' }]) {
      expect(ResolveUnknownClusterRequestSchema.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('overlay manifest', () => {
    const m = {
      sheetId: SHEET,
      versionId: 'v1',
      legend: { url: 'https://storage.invalid/x' },
      detections: null,
      rooms: null,
      thumbs: { le_a_0: 'https://storage.invalid/a', u_0: 'https://storage.invalid/b' },
      stats: null,
      expiresAt: '2026-10-13T10:15:00.000Z',
    };
    expect(OverlayManifestSchema.parse(m).thumbs.u_0).toBeDefined();
    expect(OverlayManifestSchema.safeParse({ ...m, thumbs: { 'x/../y': 'https://a.b' } }).success).toBe(false);
  });
});

describe('JSON Schema export', () => {
  const dir = join(__dirname, '..', 'json-schema');
  it.each(['LegendArtifact', 'DetectionsArtifact', 'RoomsArtifact', 'LegendEntry', 'SymbolMapping', 'Detection', 'Room', 'UnknownCluster', 'SymbolClass', 'DetectionClass', 'VersionStage'])(
    '%s is registered and generated (run `pnpm --filter @kamutan/contracts gen`)',
    (name) => {
      expect(jsonSchemaRegistry[name]).toBeDefined();
      const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { schemas: string[] };
      expect(index.schemas).toContain(`${name}.json`);
      const js = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as Record<string, unknown>;
      expect(js.$id).toBe(`https://kamutan.app/schemas/${name}.json`);
    },
  );

  it('generated json-schema/ matches the registry (no stale or missing files)', () => {
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { schemas: string[] };
    expect(index.schemas).toEqual(Object.keys(jsonSchemaRegistry).sort().map((n) => `${n}.json`));
  });

  it('DetectionsArtifact JSON Schema pins the tag and the class enum', () => {
    const js = JSON.parse(readFileSync(join(dir, 'DetectionsArtifact.json'), 'utf8')) as {
      definitions: { DetectionsArtifact: { properties: { schema: { const?: string; enum?: string[] }; detections: { items: { properties: { class: { enum: string[] } } } } } } };
    };
    const def = js.definitions.DetectionsArtifact;
    expect(def.properties.schema.const ?? def.properties.schema.enum?.[0]).toBe('kamutan.detections/1');
    expect(def.properties.detections.items.properties.class.enum).toContain('unknown');
    expect(def.properties.detections.items.properties.class.enum).toContain('socket_double');
  });
});
