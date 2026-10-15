import { storagePaths } from '@kamutan/contracts';
import type { TestApp } from './app';

/** A detection as the worker writes it (kamutan.detections/1). */
export function det(id: string, cls: string, x: number, y: number, score: number, level: 'green' | 'yellow' | 'red', extra: Record<string, unknown> = {}) {
  return {
    id,
    class: cls,
    legendEntryId: null,
    centerMm: { x, y },
    bboxMm: { x: x - 2, y: y - 2, w: 4, h: 4 },
    angleDeg: 0,
    score,
    level,
    reasons: level === 'green' ? [] : ['התאמה חלקית לסמל המקרא'],
    roomId: null,
    floor: '0',
    lifecycle: 'new',
    supply: null,
    annotations: [],
    clusterId: null,
    ...extra,
  };
}

export function bathroom(id = 'r_1', extra: Record<string, unknown> = {}) {
  return {
    id,
    name: 'רחצה',
    nameConfidence: 0.9,
    floor: '0',
    polygonMm: [
      { x: 100, y: 100 },
      { x: 140, y: 100 },
      { x: 140, y: 150 },
      { x: 100, y: 150 },
    ],
    areaM2: 5,
    perimeterM: 9,
    confidence: 0.9,
    level: 'green',
    reasons: [],
    type: 'bathroom',
    wet: true,
    walls: [
      { id: 'w_1', aMm: { x: 100, y: 100 }, bMm: { x: 140, y: 100 }, lengthM: 2, exterior: false },
      { id: 'w_2', aMm: { x: 140, y: 100 }, bMm: { x: 140, y: 150 }, lengthM: 2.5, exterior: true },
    ],
    openings: [{ id: 'o_1', kind: 'door', wallId: 'w_1', widthM: 0.8, heightM: null, centerMm: { x: 120, y: 100 } }],
    externalCorners: 1,
    ...extra,
  };
}

/** Seeds a ready worker sheet with understanding artifacts; returns ids. */
export function seedSheet(
  t: TestApp,
  orgId: string,
  projectId: string,
  setId: string,
  artifacts: { detections?: unknown[]; unknownClusters?: unknown[]; rooms?: unknown[]; groups?: unknown[] } = {},
  opts: { status?: 'ready' | 'processing' } = {},
): { sheetId: string; versionId: string } {
  const ids = t.repo.seedWorkerSheet(orgId, projectId, setId, 0, { understanding: true, ...(opts.status ? { status: opts.status } : {}) });
  const { sheetId, versionId } = ids;
  t.artifacts.putJson(storagePaths.detections(orgId, projectId, sheetId, versionId), { schema: 'kamutan.detections/1', detections: artifacts.detections ?? [], unknownClusters: artifacts.unknownClusters ?? [] });
  t.artifacts.putJson(storagePaths.rooms(orgId, projectId, sheetId, versionId), { schema: 'kamutan.rooms/1', rooms: artifacts.rooms ?? [] });
  if (artifacts.groups) t.artifacts.putJson(storagePaths.links(orgId, projectId, sheetId, versionId), { schema: 'kamutan.links/1', groups: artifacts.groups });
  return ids;
}
