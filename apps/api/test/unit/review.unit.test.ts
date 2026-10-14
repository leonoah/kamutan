import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOQ_BUILD_STUCK_MS, BOQ_REBUILD_MAX_WAIT_MS, CreateCorrectionRequestSchema, type Correction } from '@kamutan/contracts';
import { planAutoBuild, toSimilarSearch } from '../../src/db/review-repository';
import { CorrectionsService, roleForKinds } from '../../src/review/corrections.service';
import { applyOverlay, computeQueueBase, ROOM_SETTINGS_MISSING_REASON } from '../../src/review/queue';
import { ReviewQueueService } from '../../src/review/review-queue.service';
import { RoomSettingsService, validateAgainstRoom } from '../../src/review/room-settings.service';
import { SimilarService } from '../../src/review/similar.service';
import { detectionsView, roomsView } from '../../src/review/artifact-views';
import { qtyFormat } from '../../src/boq/excel';
import { createTestApp, type TestApp } from '../support/app';
import { user } from '../support/fake-verifier';
import { testConfig } from '../support/helpers';
import { bathroom, det, seedSheet } from '../support/review-fixtures';

describe('planAutoBuild (debounce decision table)', () => {
  const now = 1_000_000_000;
  it('off / create / debounce / follow-up / stuck builds ignored / cap', () => {
    expect(planAutoBuild(false, [], now, 5000)).toEqual({ kind: 'off' });
    expect(planAutoBuild(true, [null], now, 5000)).toEqual({ kind: 'create', afterBuildId: null, untilMs: now + 5000 });
    expect(planAutoBuild(true, [{ id: 'q', status: 'queued', createdAtMs: now - 1000 }], now, 5000)).toEqual({ kind: 'debounce', buildId: 'q', untilMs: now + 5000 });
    expect(planAutoBuild(true, [{ id: 'r', status: 'running', createdAtMs: now - 1000 }], now, 5000)).toEqual({ kind: 'create', afterBuildId: 'r', untilMs: now + 5000 });
    // queued wins over running (the follow-up already exists)
    expect(planAutoBuild(true, [{ id: 'r', status: 'running', createdAtMs: now }, { id: 'q', status: 'queued', createdAtMs: now }], now, 5000)).toMatchObject({ kind: 'debounce', buildId: 'q' });
    expect(planAutoBuild(true, [{ id: 's', status: 'queued', createdAtMs: now - BOQ_BUILD_STUCK_MS - 1 }], now, 5000)).toMatchObject({ kind: 'create', afterBuildId: null });
    expect(planAutoBuild(true, [{ id: 'd', status: 'succeeded', createdAtMs: now }], now, 5000)).toMatchObject({ kind: 'create' });
    // continuous editing: never pushed beyond createdAt + max wait
    const created = now - BOQ_REBUILD_MAX_WAIT_MS + 1000;
    expect(planAutoBuild(true, [{ id: 'q', status: 'queued', createdAtMs: created }], now, 5000)).toEqual({ kind: 'debounce', buildId: 'q', untilMs: created + BOQ_REBUILD_MAX_WAIT_MS });
  });
  it('roleForKinds: reviewer only for accept/reject sets', () => {
    expect(roleForKinds(['accept', 'reject'])).toBe('reviewer');
    expect(roleForKinds(['accept', 'move'])).toBe('editor');
  });
});

describe('export quantity display (2 decimals for area / length, value kept exact)', () => {
  it('qtyFormat', () => {
    for (const u of ['מ"ר', 'מ"א', 'מ״ר', 'm2', "מ'"]) expect(qtyFormat(u), u).toBe('0.00');
    for (const u of ['יחידה', 'קומפלט', '', null]) expect(qtyFormat(u)).toBe('General');
  });
});

describe('queue (pure)', () => {
  const views = { ...detectionsView({ detections: [det('d_1', 'socket_double', 10, 10, 0.5, 'yellow'), det('d_2', 'unknown', 20, 10, 0.2, 'red', { clusterId: 'u_1' }), det('d_3', 'unknown', 30, 10, 0.2, 'red', { clusterId: 'u_1' })], unknownClusters: [{ id: 'u_1', signature: 'sig12345', count: 2, exemplarBboxMm: { x: 0, y: 0, w: 1, h: 1 }, thumb: null }] }), rooms: roomsView({ rooms: [bathroom()] }), links: [] };
  const base = computeQueueBase({ buildId: 'b', lines: [], evidence: new Map(), unmatched: [], versions: [{ sheetId: 's', versionId: 'v2', artifacts: views }] });
  const corr = (over: Partial<Correction>): Correction =>
    ({ ...CreateCorrectionRequestSchema.parse({ kind: 'accept', sheetId: 's', versionId: 'v2', anchorMm: { x: 0, y: 0 }, detectionId: 'x' }), id: 'c', batchId: null, by: 'u', at: '2026-10-14T00:00:00.000Z', revertedAt: null, ...over }) as Correction;

  it('anchor re-match on an older version (within radius only)', () => {
    const near = applyOverlay(base, [corr({ versionId: 'v1', detectionId: 'd_old', anchorMm: { x: 12, y: 10 }, radiusMm: 3 })], new Set());
    expect(near.some((i) => i.ref.detectionId === 'd_1')).toBe(false);
    const far = applyOverlay(base, [corr({ versionId: 'v1', detectionId: 'd_old', anchorMm: { x: 20, y: 10 }, radiusMm: 3 })], new Set());
    expect(far.some((i) => i.ref.detectionId === 'd_1')).toBe(true);
    // same version needs the same id (anchor alone does not match)
    const sameV = applyOverlay(base, [corr({ detectionId: 'd_other', anchorMm: { x: 10, y: 10 } })], new Set());
    expect(sameV.some((i) => i.ref.detectionId === 'd_1')).toBe(true);
  });
  it('unknown cluster shrinks; room settings remove the settings reason', () => {
    const out = applyOverlay(base, [corr({ kind: 'reject', detectionId: 'd_2' })], new Set());
    expect(out.find((i) => i.kind === 'unknown_cluster')).toMatchObject({ count: 1, detectionIds: ['d_3'], risk: 3 });
    expect(out.find((i) => i.kind === 'room')?.reasons).toEqual([ROOM_SETTINGS_MISSING_REASON]);
    expect(applyOverlay(base, [], new Set(['s__r_1'])).some((i) => i.kind === 'room')).toBe(false);
    expect(applyOverlay(base, [corr({ kind: 'accept', detectionId: null, roomId: 'r_1' })], new Set()).some((i) => i.kind === 'room')).toBe(false);
  });
  it('worker output is untrusted: malformed detections / rooms are skipped', () => {
    expect(detectionsView({ detections: [{ id: 'd_1' }, null, 7, det('d_2', 'socket_double', 1, 1, 2, 'yellow')] }).detections.map((d) => [d.id, d.score])).toEqual([['d_2', 1]]);
    expect(roomsView({ rooms: [{ id: 'x_1', level: 'green' }, { id: 'r_1', level: 'purple' }, { ...bathroom(), walls: [{ id: 'w_1' }] }] }).map((r) => [r.id, r.walls.length])).toEqual([['r_1', 0]]);
    expect(detectionsView('nope')).toEqual({ detections: [], clusters: [] });
  });
  it('room validation helper', () => {
    const room = roomsView({ rooms: [bathroom()] })[0]!;
    const ok = { claddingHeightM: 2, floorTiled: true, floorMaterialItemCode: null, wallMaterialItemCode: null, partialCladding: [], wasteFactor: 0.07, includeInWaterproofing: true };
    expect(validateAgainstRoom(ok, room)).toEqual([]);
    expect(validateAgainstRoom({ ...ok, keepOpenings: ['o_1', 'o_1'] }, room).map((i) => i.path)).toEqual(['keepOpenings']);
  });
  it('similar result doc mapper drops bad candidates and requires a valid exemplar', () => {
    const ex = { sheetId: 's', versionId: 'v', bboxMm: { x: 0, y: 0, w: 1, h: 1 }, class: null };
    expect(toSimilarSearch('x', { status: 'queued', exemplar: { ...ex, bboxMm: { x: 0, y: 0, w: 0, h: 1 } } })).toBeNull();
    expect(toSimilarSearch('x', { status: 'weird', exemplar: ex })).toBeNull();
    const s = toSimilarSearch('x', { status: 'succeeded', exemplar: ex, candidates: [{ id: 'c_1' }], requestedBy: 'u', createdAt: new Date() });
    expect(s).toMatchObject({ candidates: [], thumbs: 0, scope: 'project' });
  });
});

describe('service-level isolation (no guards): org B admin gets 404 on org A; roles re-checked in services', () => {
  let t: TestApp;
  let orgA: string;
  let projectA: string;
  let s: { sheetId: string; versionId: string };
  const outsider = user('outsider');
  beforeAll(async () => {
    t = await createTestApp(testConfig());
    orgA = t.repo.seedOrg('A', { editor: 'editor', reviewer: 'reviewer', viewer: 'viewer' }).id;
    t.repo.seedOrg('B', { outsider: 'admin' });
    projectA = (await t.repo.createProject(orgA, { name: 'A' }, 'editor')).id;
    s = seedSheet(t, orgA, projectA, 'setI', { detections: [det('d_1', 'socket_double', 10, 10, 0.5, 'yellow')], rooms: [bathroom()] });
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('every Sprint 4 service method', async () => {
    const corr = t.app.get(CorrectionsService);
    const rooms = t.app.get(RoomSettingsService);
    const sim = t.app.get(SimilarService);
    const queue = t.app.get(ReviewQueueService);
    const req = CreateCorrectionRequestSchema.parse({ kind: 'accept', ...s, anchorMm: { x: 10, y: 10 }, detectionId: 'd_1' });
    const created = await corr.create(user('reviewer'), projectA, req, '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01');
    const settings = { claddingHeightM: 2, floorTiled: true, floorMaterialItemCode: null, wallMaterialItemCode: null, partialCladding: [], wasteFactor: 0.07, includeInWaterproofing: true };
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['create', () => corr.create(outsider, projectA, req, 'tp')],
      ['batch', () => corr.createBatch(outsider, projectA, { items: [req], source: 'other', similarSearchId: null }, 'tp')],
      ['revert', () => corr.revert(outsider, projectA, created.correction.id, 'tp')],
      ['list', () => corr.list(outsider, projectA, { includeReverted: false, limit: 10 })],
      ['queue', () => queue.queue(outsider, projectA, { limit: 10 })],
      ['room get', () => rooms.get(outsider, projectA, s.sheetId, 'r_1')],
      ['room put', () => rooms.put(outsider, projectA, s.sheetId, 'r_1', settings, 'tp')],
      ['similar', () => sim.create(outsider, projectA, { exemplar: { ...s, bboxMm: { x: 1, y: 1, w: 2, h: 2 }, class: null }, scope: 'sheet', correctionId: null }, 'tp')],
      ['similar get', () => sim.get(outsider, projectA, 'any')],
    ];
    for (const [name, fn] of calls) await expect(fn(), name).rejects.toMatchObject({ code: 'not_found' });
    await expect(corr.create(user('viewer'), projectA, req, 'tp')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(corr.create(user('reviewer'), projectA, { ...req, kind: 'remove' }, 'tp')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(rooms.put(user('reviewer'), projectA, s.sheetId, 'r_1', settings, 'tp')).rejects.toMatchObject({ code: 'forbidden' });
  });
});
