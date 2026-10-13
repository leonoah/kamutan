import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_PATH_RE,
  ConfirmSheetRequestSchema,
  JobSchema,
  jsonSchemaRegistry,
  levelsFor,
  polygonSelfIntersects,
  polygonSignedArea,
  PROJECT_UPLOAD_PATH_RE,
  PutRegionsRequestSchema,
  QUARANTINE_PATH_RE,
  SheetSchema,
  SheetVersionSchema,
  sheetIdFor,
  storagePaths,
  TilesManifestQuerySchema,
  tileLevels,
} from '../src/index.js';

const sha = 'b'.repeat(64);
const P = (pts: Array<[number, number]>) => pts.map(([x, y]) => ({ x, y }));
const square = P([
  [10, 10],
  [100, 10],
  [100, 100],
  [10, 100],
]);

describe('sheet', () => {
  const sheet = {
    id: sheetIdFor(sha, 0),
    sheetSetId: sha,
    pageIndex: 0,
    title: 'תוכנית חשמל קומת קרקע',
    discipline: 'electrical',
    floors: ['ground'],
    scaleDenominator: 50,
    classification: {
      discipline: 'electrical',
      floors: ['ground'],
      sheetTitle: 'תוכנית חשמל',
      scaleText: '1:50',
      confidence: 0.91,
      level: 'yellow',
      reasons: ['scale from title block'],
    },
    confirmed: false,
    currentVersionId: 'v1',
    updatedAt: '2026-10-12T10:00:00.000Z',
  };
  it('parses the brief shape; sheet id = {sheetSetId}-p{i}', () => {
    expect(SheetSchema.parse(sheet).id).toBe(`${sha}-p0`);
    expect(SheetSchema.safeParse({ ...sheet, classification: null, discipline: null, scaleDenominator: null }).success).toBe(true);
  });
  it('rejects bad discipline codes, confidence > 1, unknown levels', () => {
    expect(SheetSchema.safeParse({ ...sheet, discipline: 'Electrical!' }).success).toBe(false);
    expect(SheetSchema.safeParse({ ...sheet, classification: { ...sheet.classification, confidence: 1.2 } }).success).toBe(false);
    expect(SheetSchema.safeParse({ ...sheet, classification: { ...sheet.classification, level: 'blue' } }).success).toBe(false);
  });
});

describe('sheet version', () => {
  const v = {
    id: 'v1',
    sheetId: 's1',
    status: 'ready',
    progress: { stage: 'done', pct: 100 },
    page: { widthMm: 1189, heightMm: 841, rotation: 0 },
    artifacts: {
      tiles: { prefix: 'orgs/o/projects/p/sheets/s1/versions/v1/tiles/', format: 'webp', tileSize: 256, dpi: 300, levels: 8, widthPx: 14043, heightPx: 9933 },
      thumbnail: 'orgs/o/projects/p/sheets/s1/versions/v1/thumbnail.webp',
    },
    regions: [],
    stats: { paths: 1, segments: 2, textLines: 3, glyphs: 4 },
    workerVersion: '0.2.0',
    updatedAt: '2026-10-12T10:00:00.000Z',
  };
  it('parses; rejects unknown stage and non-256 tiles', () => {
    expect(SheetVersionSchema.parse(v).status).toBe('ready');
    expect(SheetVersionSchema.safeParse({ ...v, progress: { stage: 'fetch', pct: 1 } }).success).toBe(false);
    expect(SheetVersionSchema.safeParse({ ...v, artifacts: { tiles: { ...v.artifacts.tiles, tileSize: 512 } } }).success).toBe(false);
  });
});

describe('regions / confirm', () => {
  const region = { id: 'r1', floor: 'ground', polygonMm: square, scaleDenominator: 50 };
  it('caps at 8 regions and rejects duplicate ids and < 3 points', () => {
    expect(PutRegionsRequestSchema.safeParse({ regions: [region] }).success).toBe(true);
    expect(PutRegionsRequestSchema.safeParse({ regions: [{ ...region, polygonMm: [[10, 10], [100, 10], [100, 100]] }] }).success).toBe(false);
    const nine = Array.from({ length: 9 }, (_, i) => ({ ...region, id: `r${i}` }));
    expect(PutRegionsRequestSchema.safeParse({ regions: nine }).success).toBe(false);
    expect(PutRegionsRequestSchema.safeParse({ regions: [region, region] }).success).toBe(false);
    expect(PutRegionsRequestSchema.safeParse({ regions: [{ ...region, polygonMm: square.slice(0, 2) }] }).success).toBe(false);
    expect(PutRegionsRequestSchema.safeParse({ regions: [{ ...region, polygonMm: [{ x: 0, y: NaN }, ...square] }] }).success).toBe(false);
  });
  it('confirm request is strict', () => {
    expect(ConfirmSheetRequestSchema.safeParse({ discipline: 'electrical', floors: ['first'], scaleDenominator: 100 }).success).toBe(true);
    expect(ConfirmSheetRequestSchema.safeParse({ discipline: 'electrical', floors: [], scaleDenominator: null, regions: [region] }).success).toBe(true);
    expect(ConfirmSheetRequestSchema.safeParse({ discipline: 'electrical', floors: [], scaleDenominator: 0 }).success).toBe(false);
    expect(ConfirmSheetRequestSchema.safeParse({ discipline: 'electrical', floors: [], scaleDenominator: 50, confirmed: true }).success).toBe(false);
  });
});

describe('geometry', () => {
  it('detects self-intersection (bow tie), duplicate vertices and fold-backs', () => {
    expect(polygonSelfIntersects(square)).toBe(false);
    expect(polygonSelfIntersects(P([[0, 0], [10, 10], [10, 0], [0, 10]]))).toBe(true);
    expect(polygonSelfIntersects(P([[0, 0], [10, 0], [10, 10], [10, 0]]))).toBe(true);
    expect(polygonSelfIntersects(P([[0, 0], [10, 0], [5, 0]]))).toBe(true);
    expect(polygonSelfIntersects(P([[0, 0], [10, 0], [10, 10], [5, 0], [0, 10]]))).toBe(true); // vertex touches an edge
    expect(polygonSelfIntersects(P([[0, 0], [20, 0], [20, 20], [10, 5], [0, 20]]))).toBe(false); // concave is fine
    expect(Math.abs(polygonSignedArea(square))).toBe(8100);
  });
  it('tile pyramid: level 0 fits one tile, top level = full size', () => {
    const levels = levelsFor(14043, 9933, 256);
    expect(levels).toBe(7);
    const grid = tileLevels({ widthPx: 14043, heightPx: 9933, tileSize: 256, levels, dpi: 300 });
    expect(grid[0]).toMatchObject({ z: 0, cols: 1, rows: 1 });
    expect(grid.at(-1)).toMatchObject({ z: 6, widthPx: 14043, heightPx: 9933, cols: 55, rows: 39 });
    expect(levelsFor(200, 100, 256)).toBe(1);
  });
});

describe('tiles manifest query', () => {
  it('needs all four range bounds plus z, ordered', () => {
    expect(TilesManifestQuerySchema.safeParse({}).success).toBe(true);
    expect(TilesManifestQuerySchema.safeParse({ z: '3' }).success).toBe(true);
    expect(TilesManifestQuerySchema.parse({ z: '3', x0: '0', x1: '4', y0: '1', y1: '2' })).toEqual({ z: 3, x0: 0, x1: 4, y0: 1, y1: 2 });
    expect(TilesManifestQuerySchema.safeParse({ z: '3', x0: '0' }).success).toBe(false);
    expect(TilesManifestQuerySchema.safeParse({ x0: '0', x1: '1', y0: '0', y1: '1' }).success).toBe(false);
    expect(TilesManifestQuerySchema.safeParse({ z: '3', x0: '5', x1: '1', y0: '0', y1: '1' }).success).toBe(false);
    expect(TilesManifestQuerySchema.safeParse({ z: '-1' }).success).toBe(false);
    expect(TilesManifestQuerySchema.safeParse({ foo: '1' }).success).toBe(false);
  });
});

describe('storage paths', () => {
  it('quarantine/upload/artifact regexes accept only server-shaped paths', () => {
    expect(QUARANTINE_PATH_RE.test(storagePaths.quarantine('o1', '0b6f3d4e-1c2a-4b5d-9e8f-0123456789ab'))).toBe(true);
    expect(QUARANTINE_PATH_RE.test('orgs/o1/quarantine/../x')).toBe(false);
    expect(PROJECT_UPLOAD_PATH_RE.test(storagePaths.projectUpload('o', 'p', sha, 'dxf'))).toBe(true);
    expect(PROJECT_UPLOAD_PATH_RE.test('orgs/o/projects/p/uploads/s/evil name.pdf')).toBe(false);
    expect(ARTIFACT_PATH_RE.test(storagePaths.tile('o', 'p', 's', 'v', 0, 0, 0))).toBe(true);
    expect(ARTIFACT_PATH_RE.test(storagePaths.thumbnail('o', 'p', 's', 'v'))).toBe(true);
    expect(ARTIFACT_PATH_RE.test(storagePaths.projectUpload('o', 'p', sha, 'pdf'))).toBe(false);
  });
});

describe('job doc', () => {
  it('has progress {stage, pct} and attempts', () => {
    const job = {
      id: 'j1', orgId: 'o', projectId: 'p', sheetSetId: sha, sheetId: null, versionId: 'v1', type: 'ingest.sheet_version',
      status: 'running', progress: { stage: 'render', pct: 40 }, attempts: 1, error: null, updatedAt: '2026-10-12T10:00:00.000Z',
    };
    expect(JobSchema.parse(job).progress.pct).toBe(40);
    expect(JobSchema.safeParse({ ...job, progress: 40 }).success).toBe(false);
  });
});

describe('json schema registry', () => {
  it('exports the Sprint 1 schemas for the worker', () => {
    for (const n of ['Sheet', 'SheetVersion', 'SheetClassification', 'Region', 'TilesArtifact', 'TilesManifest', 'Job', 'ConfirmSheetRequest', 'IngestSheetVersionJob']) {
      expect(jsonSchemaRegistry[n], n).toBeDefined();
    }
  });
});
