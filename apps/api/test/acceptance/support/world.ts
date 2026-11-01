/**
 * Stage-10 API/Sec acceptance: a "world" of two orgs (A, B) with every kind of member resource, created through the
 * real HTTP stack wherever an endpoint exists (worker outputs are seeded the way the worker writes them).
 */
import request from 'supertest';
import { CreateShareLinkResponseSchema, fsPaths, ROLES, storagePaths, type Role } from '@kamutan/contracts';
import type { Doc } from '../../../src/db/mappers';
import { createTestApp, type TestApp } from '../../support/app';
import { SAMPLE, testConfig } from '../../support/helpers';
import { bathroom, det, seedSheet } from '../../support/review-fixtures';

export type Http = ReturnType<typeof request>;
export const MEMBER_ROLES = ['viewer', 'reviewer', 'editor', 'admin'] as const satisfies readonly Role[];
export const SIG = 'c3'.repeat(20);

export interface OrgWorld {
  key: 'a' | 'b';
  orgId: string;
  orgName: string;
  projectId: string;
  projectName: string;
  /** main sheet (never reprocessed by the suites that share a world) */
  sheet: { sheetId: string; versionId: string };
  /** second sheet: reprocess / unknown-cluster resolve target */
  sheet2: { sheetId: string; versionId: string };
  roomId: string;
  clusterId: string;
  lines: { status: string; override: string; approved: string; plain: string };
  corrections: { accept: string; add: string };
  batches: { accept: string; add: string };
  exportId: string;
  link: { id: string; token: string };
  entryId: string;
  searchId: string;
  itemId: string;
  /** library import ids by uploader role (finalize is uploader-only) */
  imports: Partial<Record<Role, string>>;
  jobId: string;
  templateId: string;
  ruleId: string;
  offboardingExportId: string;
  uid: (r: Role) => string;
}

export interface World {
  t: TestApp;
  http: Http;
  tok: Record<string, string>;
  A: OrgWorld;
  B: OrgWorld;
  auth: (who: string) => { authorization: string };
}

/** Relaxed limits: the suites below test authorization, not throttling (uploads.acceptance has its own app). */
export const RELAXED = {
  THROTTLE_LIMIT: '100000',
  UPLOAD_THROTTLE_LIMIT: '100000',
  EXPORT_THROTTLE_LIMIT: '100000',
  TILES_THROTTLE_LIMIT: '100000',
  SHARE_RATE_LIMIT_PER_MIN: '100000',
  SHARE_TILE_RATE_LIMIT_PER_MIN: '100000',
  SHARE_UNKNOWN_TOKEN_LIMIT: '100000',
  PUBLIC_APP_ORIGIN: 'https://app.example.test',
};

const ok = (r: { status: number; body: unknown }, ...expected: number[]) => {
  if (!expected.includes(r.status)) throw new Error(`setup request failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as Doc;
};

async function seedOrgWorld(t: TestApp, http: Http, tok: Record<string, string>, key: 'a' | 'b'): Promise<OrgWorld> {
  const uid = (r: Role) => `${key}_${r}`;
  const now = Math.floor(Date.now() / 1000);
  for (const r of ROLES) tok[uid(r)] = t.auth.issue(uid(r), { mfa: true, authTime: now, email: `${uid(r)}@${key}.example.test` });
  tok[`${key}_admin_nomfa`] = t.auth.issue(uid('admin'), { authTime: now });
  const auth = (who: string) => ({ authorization: `Bearer ${tok[who]}` });

  const orgName = key === 'a' ? 'משרד אלף' : 'משרד בית סודי';
  const projectName = key === 'a' ? 'פרויקט אלף' : 'פרויקט בית סודי';
  const orgId = t.repo.seedOrg(orgName, Object.fromEntries(ROLES.map((r) => [uid(r), r]))).id;
  for (const r of ROLES) {
    t.repo.docs.set(fsPaths.member(orgId, uid(r)), { uid: uid(r), role: r, email: `${uid(r)}@${key}.example.test`, displayName: `${r} ${key.toUpperCase()}`, createdAt: new Date() });
  }
  const created = ok(await http.post('/api/v1/projects').set(auth(uid('editor'))).send({ orgId, name: projectName, address: `רחוב ${key} 1` }), 201);
  const projectId = created.id as string;

  const dets = [det('d_1', 'socket_double', 50, 50, 0.7, 'yellow'), det('d_2', 'socket_double', 60, 50, 0.99, 'green')];
  const cluster = { id: 'u_0', signature: SIG, count: 7, exemplarBboxMm: { x: 1, y: 2, w: 3, h: 4 }, thumb: 'unknown/u_0.webp' };
  const sheet = seedSheet(t, orgId, projectId, key.repeat(64), { detections: dets, rooms: [bathroom()], unknownClusters: [cluster] });
  const sheet2 = seedSheet(t, orgId, projectId, (key === 'a' ? 'e' : 'f').repeat(64), { detections: dets, rooms: [bathroom()], unknownClusters: [cluster] });
  for (const s of [sheet, sheet2]) {
    const vp = fsPaths.version(orgId, projectId, s.sheetId, s.versionId);
    t.repo.docs.set(vp, { ...(t.repo.docs.get(vp) as Doc), titleBlockMm: { x: 700, y: 500, w: 141, h: 94 } });
    // the sheet set (what finalize writes) + its source object (what the offboarding ZIP passes through)
    const setId = s.sheetId.replace(/-p0$/, '');
    const src = storagePaths.projectUpload(orgId, projectId, setId, 'pdf');
    t.repo.docs.set(fsPaths.sheetSet(orgId, projectId, setId), { fileKind: 'pdf', sha256: setId, storagePath: src, status: 'ready', name: `חשמל-${key}.pdf`, ingestJobId: `ing_${setId.slice(0, 8)}`, versionId: s.versionId, createdAt: new Date() });
    t.storage.objects.set(src, { data: SAMPLE.pdf, contentType: 'application/pdf' });
  }

  const ln = (n: string) => `ln_${key}_${n}`;
  const lines = { status: ln('4_01'), override: ln('4_02'), approved: ln('4_03'), plain: ln('4_04') };
  t.boq.seedLine(orgId, projectId, { id: lines.status, code: '4.01', description: 'שקע כפול', qty: 2, level: 'green', status: 'draft', byFloor: { '0': 2 }, buildId: 'b1' });
  t.boq.seedLine(orgId, projectId, { id: lines.override, code: '4.02', description: 'שקע מוגן מים', qty: 4, level: 'green', status: 'draft', byFloor: { '0': 4 }, buildId: 'b1' });
  t.boq.seedLine(orgId, projectId, { id: lines.approved, code: '4.03', description: 'נקודת מאור', qty: 6, level: 'green', status: 'approved', approvedBy: uid('reviewer'), byFloor: { '0': 6 }, buildId: 'b1' });
  t.boq.seedLine(orgId, projectId, { id: lines.plain, code: '4.04', description: 'מפסק', qty: 1, level: 'green', status: 'draft', byFloor: { '0': 1 }, buildId: 'b1' });
  t.boqStorage.putEvidence(storagePaths.boqEvidence(orgId, projectId, 'b1'), {
    schema: 'kamutan.boq-evidence/1',
    lines: { [lines.status]: [{ sheetId: sheet.sheetId, versionId: sheet.versionId, detectionId: 'd_1', linkGroupId: null, floor: '0' }] },
  });
  const pp = fsPaths.project(orgId, projectId);
  t.repo.docs.set(pp, { ...(t.repo.docs.get(pp) as Doc), boq: { latestBuildId: 'b1', builtAt: new Date(), stale: false } });

  const P = `/api/v1/projects/${projectId}`;
  const base = { sheetId: sheet.sheetId, versionId: sheet.versionId, anchorMm: { x: 50, y: 50 } };
  const accept = { ...base, kind: 'accept', detectionId: 'd_1' };
  const add = { ...base, kind: 'add', class: 'socket_double', anchorMm: { x: 70, y: 70 } };
  const cAcc = ok(await http.post(`${P}/corrections`).set(auth(uid('reviewer'))).send(accept), 201);
  const cAdd = ok(await http.post(`${P}/corrections`).set(auth(uid('editor'))).send(add), 201);
  const bAcc = ok(await http.post(`${P}/corrections/batch`).set(auth(uid('reviewer'))).send({ items: [accept] }), 201);
  const bAdd = ok(await http.post(`${P}/corrections/batch`).set(auth(uid('editor'))).send({ items: [add] }), 201);
  // the auto rebuilds above are queued; mark them done so build/export requests behave like a settled project
  const settle = () => {
    const boq = ((t.repo.docs.get(pp) as Doc).boq ?? {}) as Doc;
    for (const id of [boq.pendingBuildId, boq.autoBuildId]) {
      if (typeof id !== 'string') continue;
      const bp = fsPaths.boqBuild(orgId, projectId, id);
      t.repo.docs.set(bp, { ...(t.repo.docs.get(bp) as Doc), status: 'succeeded' });
    }
    t.repo.docs.set(pp, { ...(t.repo.docs.get(pp) as Doc), boq: { latestBuildId: 'b1', builtAt: new Date(), stale: false, pendingBuildId: null, autoBuildId: null } });
  };
  settle();

  const exp = ok(await http.post(`${P}/boq/export`).set(auth(uid('editor'))).send({}), 200);
  const link = CreateShareLinkResponseSchema.parse(ok(await http.post(`${P}/share-links`).set(auth(uid('editor'))).send({ label: `קבלן ${key}`, days: 7 }), 201));
  const entryId = `le_${key}_1`;
  t.repo.seedLegendEntry(orgId, projectId, entryId, { sheetId: sheet.sheetId, versionId: sheet.versionId, signature: 'a1'.repeat(20), suggestedClass: 'socket_double', status: 'suggested', label: 'שקע' });
  const search = ok(
    await http.post(`${P}/similar-searches`).set(auth(uid('reviewer'))).send({ exemplar: { sheetId: sheet.sheetId, versionId: sheet.versionId, bboxMm: { x: 48, y: 48, w: 4, h: 4 }, class: 'socket_double' }, scope: 'sheet' }),
    202,
  );
  const item = ok(await http.post('/api/v1/library/items').set(auth(uid('admin'))).send({ orgId, code: '9.01', chapter: '09', description: `פריט ספרייה ${key}`, unit: 'יח' }), 201);
  const imports: Partial<Record<Role, string>> = {};
  for (const r of ['editor', 'admin'] as const) {
    const imp = ok(await http.post('/api/v1/library/imports').set(auth(uid(r))).send({ orgId, filename: `past-${key}.xlsx`, sizeBytes: 1000 }), 201);
    imports[r] = (imp.import as Doc).id as string;
  }
  ok(await http.get(`/api/v1/boq-rules?orgId=${orgId}`).set(auth(uid('viewer'))), 200);
  ok(await http.get(`/api/v1/boq-templates?orgId=${orgId}`).set(auth(uid('viewer'))), 200);
  const jobId = `job_${key}_1`;
  t.repo.docs.set(fsPaths.job(jobId), { orgId, projectId, type: 'boq.build', status: 'succeeded', progress: { stage: 'done', pct: 100 }, attempts: 1, error: null, createdBy: uid('editor'), createdAt: new Date(), updatedAt: new Date() });
  const off = ok(await http.post(`/api/v1/orgs/${orgId}/offboarding/export`).set(auth(uid('admin'))).send({}), 202);
  settle();
  return {
    key,
    orgId,
    orgName,
    projectId,
    projectName,
    sheet,
    sheet2,
    roomId: 'r_1',
    clusterId: 'u_0',
    lines,
    corrections: { accept: (cAcc.correction as Doc).id as string, add: (cAdd.correction as Doc).id as string },
    batches: { accept: (bAcc.batch as Doc).id as string, add: (bAdd.batch as Doc).id as string },
    exportId: exp.exportId as string,
    link: { id: link.link.id, token: link.token },
    entryId,
    searchId: (search.search as Doc).id as string,
    itemId: item.id as string,
    imports,
    jobId,
    templateId: 'tpl_default',
    ruleId: 'r_light_two_way',
    offboardingExportId: (off.export as Doc).id as string,
    uid,
  };
}

export async function createWorld(overrides: Record<string, string> = {}): Promise<World> {
  const t = await createTestApp(testConfig({ ...RELAXED, ...overrides }));
  const http = request(t.app.getHttpServer());
  const tok: Record<string, string> = {};
  const A = await seedOrgWorld(t, http, tok, 'a');
  const B = await seedOrgWorld(t, http, tok, 'b');
  tok.outsider = t.auth.issue('outsider', { mfa: true });
  return { t, http, tok, A, B, auth: (who: string) => ({ authorization: `Bearer ${tok[who]}` }) };
}

/** Every doc / object of an org, for "nothing changed" assertions. */
export function snapshotOrg(t: TestApp, orgId: string): string {
  const docs = [...t.repo.docs.entries()].filter(([k]) => k === fsPaths.org(orgId) || k.startsWith(`orgs/${orgId}/`)).sort(([a], [b]) => a.localeCompare(b));
  const objs = [t.storage.objects, t.boqStorage.objects, t.artifacts.objects, t.govStorage.objects].flatMap((m) => [...m.keys()].filter((k) => k.startsWith(`orgs/${orgId}/`))).sort();
  return JSON.stringify({ docs, objs });
}

/** Audit events of an org in chain order. */
export function auditsOf(t: TestApp, orgId: string): Array<Doc & { id: string }> {
  return [...t.repo.docs.entries()]
    .filter(([k]) => k.startsWith(`orgs/${orgId}/auditLog/`))
    .map(([k, v]) => ({ ...v, id: k.split('/').at(-1) as string }) as Doc & { id: string })
    .sort((a, b) => (a.at as Date).getTime() - (b.at as Date).getTime());
}
