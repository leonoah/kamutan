// Sprint 10 (Worker-Lighting): circuits.json.gz, version artifact / stats keys, BoqLine.circuit.
import { describe, expect, it } from 'vitest';
import {
  BoqLineCircuitSchema,
  CIRCUIT_KINDS,
  CIRCUITS_SCHEMA,
  CircuitsArtifactSchema,
  VersionArtifactsSchema,
  VersionStatsSchema,
} from '../src/index.js';

const bbox = { x: 1, y: 2, w: 3, h: 2 };
const doc = {
  schema: CIRCUITS_SCHEMA,
  sheetId: 's1-p0',
  circuits: [
    {
      id: 'c_A1',
      tag: 'A1',
      kind: 'two_way',
      fixtureIds: ['d_1', 'd_2'],
      switchIds: ['d_3', 'd_4'],
      positionIds: ['sp_1', 'sp_2'],
      positions: 2,
      fixtures: 2,
      floor: 'ground',
      timer: false,
      stairAutomat: false,
      level: 'green',
      reasons: [],
      evidence: [
        { kind: 'tag', text: 'A1', bboxMm: bbox, detectionId: 'd_1' },
        { kind: 'switch_list', text: 'A1-A4', bboxMm: bbox, positionId: 'sp_1', detectionIds: ['d_3'] },
      ],
    },
    {
      id: 'c_G1*',
      tag: 'G1*',
      kind: 'single',
      fixtureIds: ['d_9'],
      switchIds: ['d_10'],
      positionIds: ['sp_2'],
      positions: 1,
      fixtures: 1,
      floor: null,
      timer: false,
      stairAutomat: false,
      level: 'yellow',
      reasons: ["גוף תאורה ללא תג ליד מפסק — נק' עם מפסק מובנה"],
      evidence: [{ kind: 'builtin_switch', detectionId: 'd_9', positionId: 'sp_2', detectionIds: ['d_10'] }],
    },
  ],
  positions: [
    { id: 'sp_1', tags: ['A1', 'A2'], switchIds: ['d_3'], bboxMm: bbox, boxMm: null, texts: ['A1-A4'], reasons: [] },
    { id: 'sp_2', tags: ['A1'], switchIds: [], bboxMm: bbox, boxMm: bbox, texts: ['A1, פנוי'], reasons: ['מיקום מפסק ללא סמל מפסק'] },
  ],
  unmatched: {
    fixtureIds: ['d_7'],
    tags: [{ tag: 'T1', positionIds: ['sp_1'], reason: 'תג מפסק ללא גוף תאורה בגיליון', bboxMm: bbox }],
    texts: [{ text: 'Q7', bboxMm: bbox, tags: ['Q7'] }],
  },
  stats: { circuits: 2, byKind: { two_way: 1, single: 1 } },
};

describe('Sprint 10 — lighting circuits', () => {
  it('accepts a worker circuits.json.gz and rejects a yellow circuit without reasons / an unknown kind', () => {
    expect(CircuitsArtifactSchema.safeParse(doc).success).toBe(true);
    const bad = structuredClone(doc);
    bad.circuits[1]!.reasons = [];
    expect(CircuitsArtifactSchema.safeParse(bad).success).toBe(false);
    const bad2 = structuredClone(doc) as { circuits: { kind: string }[] };
    bad2.circuits[0]!.kind = 'sensor';
    expect(CircuitsArtifactSchema.safeParse(bad2).success).toBe(false);
  });

  it('kinds match the BoqLine circuit field', () => {
    expect([...CIRCUIT_KINDS]).toEqual(['single', 'shared', 'two_way', 'cross', 'timer', 'no_switch']);
    expect(BoqLineCircuitSchema.safeParse({ id: 'c_A1,c_A2', kind: 'shared', fixtures: 2 }).success).toBe(true);
  });

  it('version artifacts and stats carry the circuits keys', () => {
    expect(VersionArtifactsSchema.parse({ circuits: 'orgs/o/projects/p/sheets/s/versions/v1/circuits.json.gz' }).circuits).toContain(
      'circuits.json.gz',
    );
    const st = VersionStatsSchema.parse({ paths: 1, segments: 1, textLines: 1, glyphs: 1, circuits: { circuits: 3, untaggedFixtures: 1 } });
    expect(st.circuits?.circuits).toBe(3);
    expect(VersionStatsSchema.safeParse({ paths: 1, segments: 1, textLines: 1, glyphs: 1, circuits: { other: 1 } }).success).toBe(false);
  });
});
