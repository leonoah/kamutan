import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  CreateOffboardingExportResponseSchema,
  CreateShareLinkResponseSchema,
  DeletionCertificateSchema,
  fsPaths,
  MyOrgSchema,
  OffboardingExportJobSchema,
  OffboardingExportViewSchema,
  OffboardOrgResponseSchema,
  storagePaths,
} from '@kamutan/contracts';
import { canonicalJson } from '../../src/db/audit-chain';
import type { Doc } from '../../src/db/mappers';
import { OffboardingService } from '../../src/governance/offboarding.service';
import { certificateLine, runPurge } from '../../src/scripts/offboard-purge';
import { createTestApp, type TestApp } from '../support/app';
import { SAMPLE, testConfig } from '../support/helpers';
import { bathroom, seedSheet } from '../support/review-fixtures';

describe('Sprint 5 e2e — offboarding (SEC-52): export ZIP, offboard, blocked access, purge + certificate', () => {
  let t: TestApp;
  let http: ReturnType<typeof request>;
  const tok: Record<string, string> = {};
  let orgId: string;
  let otherOrg: string;
  let projectId: string;
  let otherProject: string;
  let shareToken: string;
  const auth = (who: string) => ({ authorization: `Bearer ${tok[who]}` });
  const O = (o = orgId) => `/api/v1/orgs/${o}`;
  const audits = (o = orgId) =>
    [...t.repo.docs.entries()]
      .filter(([k]) => k.startsWith(`orgs/${o}/auditLog/`))
      .map(([, v]) => v)
      .sort((a, b) => (a.at as Date).getTime() - (b.at as Date).getTime());
  const sourcePath = (o: string, p: string) => storagePaths.projectUpload(o, p, 'a'.repeat(64), 'pdf');

  beforeAll(async () => {
    t = await createTestApp(testConfig({ THROTTLE_LIMIT: '1000', UPLOAD_THROTTLE_LIMIT: '500', SHARE_RATE_LIMIT_PER_MIN: '1000' }));
    http = request(t.app.getHttpServer());
    t.authAdmin.onRevoke = (uid) => t.auth.revokeUser(uid);
    const now = Math.floor(Date.now() / 1000);
    tok.admin = t.auth.issue('admin', { mfa: true, authTime: now });
    tok.adminNoMfa = t.auth.issue('admin', { authTime: now });
    tok.adminStale = t.auth.issue('admin', { mfa: true, authTime: now - 11 * 60 });
    tok.editor = t.auth.issue('editor', { mfa: true });
    tok.viewer = t.auth.issue('viewer');
    tok.outsider = t.auth.issue('outsider', { mfa: true });
    orgId = t.repo.seedOrg('משרד נח', { admin: 'admin', editor: 'editor', viewer: 'viewer' }).id;
    otherOrg = t.repo.seedOrg('Other', { outsider: 'admin' }).id;
    projectId = (await t.repo.createProject(orgId, { name: 'בית משפחת נח' }, 'editor')).id;
    otherProject = (await t.repo.createProject(otherOrg, { name: 'Q' }, 'outsider')).id;
    for (const [o, p] of [
      [orgId, projectId],
      [otherOrg, otherProject],
    ] as const) {
      const s = seedSheet(t, o, p, 'a'.repeat(64), { rooms: [bathroom()] });
      t.repo.docs.set(fsPaths.sheetSet(o, p, 'a'.repeat(64)), { fileKind: 'pdf', sha256: 'a'.repeat(64), storagePath: sourcePath(o, p), status: 'ready', name: 'חשמל.pdf', createdAt: new Date() });
      t.storage.objects.set(sourcePath(o, p), { data: SAMPLE.pdf, contentType: 'application/pdf' });
      t.boq.seedLine(o, p, { id: 'bl_4_01', code: '4.01', description: 'שקע כפול', qty: 2, byFloor: { '0': 2 } });
      t.repo.docs.set(fsPaths.correction(o, p, 'c1'), { kind: 'add', sheetId: s.sheetId, versionId: s.versionId, anchorMm: { x: 1, y: 1 }, radiusMm: 3, class: 'socket_double', by: 'editor', at: new Date(), revertedAt: null });
      t.repo.docs.set(fsPaths.job(`job_${o}`), { orgId: o, projectId: p, type: 'boq.build', status: 'succeeded', progress: { stage: 'done', pct: 100 }, attempts: 1, createdAt: new Date(), updatedAt: new Date() });
    }
    const link = await http.post(`/api/v1/projects/${projectId}/share-links`).set(auth('editor')).send({ label: 'קבלן' });
    shareToken = CreateShareLinkResponseSchema.parse(link.body).token;
    expect((await http.get(`/api/v1/public/share/${shareToken}/meta`)).status).toBe(200);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('export: admin + MFA + sign-in ≤ 10 min (mfa_required / recent_auth_required / editor 403 / outsider 404)', async () => {
    const no = await http.post(`${O()}/offboarding/export`).set(auth('adminNoMfa')).send({});
    expect(no.status).toBe(403);
    expect(ApiErrorSchema.parse(no.body).error.code).toBe('mfa_required');
    const stale = await http.post(`${O()}/offboarding/export`).set(auth('adminStale')).send({});
    expect(stale.status).toBe(403);
    expect(ApiErrorSchema.parse(stale.body).error.code).toBe('recent_auth_required');
    expect((await http.post(`${O()}/offboarding/export`).set(auth('editor')).send({})).status).toBe(403);
    expect((await http.post(`${O()}/offboarding/export`).set(auth('outsider')).send({})).status).toBe(404);
    expect((await http.post(`${O()}/offboarding/export`).set(auth('admin')).send({ x: 1 })).status).toBe(400);
  });

  it('export: 202 → api-jobs message → runner streams a ZIP (sources, xlsx, JSON, rooms, manifest) → 24 h URL', async () => {
    const r = await http.post(`${O()}/offboarding/export`).set(auth('admin')).send({});
    expect(r.status).toBe(202);
    const { export: exp, jobId } = CreateOffboardingExportResponseSchema.parse(r.body);
    expect(exp).toMatchObject({ status: 'queued', storagePath: storagePaths.offboardingZip(orgId, exp.id), createdBy: 'admin' });
    const msg = OffboardingExportJobSchema.parse(t.apiJobs.messages.at(-1));
    expect(msg).toMatchObject({ orgId, exportId: exp.id, jobId, includeSources: true });
    expect(audits().at(-1)).toMatchObject({ entity: 'offboardingExports', action: 'create', entityId: exp.id });
    expect(OffboardingExportViewSchema.parse((await http.get(`${O()}/offboarding/export/${exp.id}`).set(auth('admin'))).body)).toMatchObject({ url: null });

    await t.app.get(OffboardingService).runExport(msg);
    await t.app.get(OffboardingService).runExport(msg); // redelivery: idempotent (ready is never rebuilt)
    const v = OffboardingExportViewSchema.parse((await http.get(`${O()}/offboarding/export/${exp.id}`).set(auth('admin'))).body);
    expect(v.export).toMatchObject({ status: 'ready', counts: { projects: 1, sources: 1 } });
    expect(v.url).toContain('X-Goog-Expires=86400');
    expect((t.repo.docs.get(fsPaths.job(jobId)) as Doc).status).toBe('succeeded');
    const zip = t.govStorage.objects.get(storagePaths.offboardingZip(orgId, exp.id)) as Buffer;
    expect(v.export.sha256).toBe(createHash('sha256').update(zip).digest('hex'));
    expect(v.export.sizeBytes).toBe(zip.length);
    const files = unzipSync(new Uint8Array(zip));
    const base = `projects/${projectId}`;
    expect(Object.keys(files).sort()).toEqual(
      ['manifest.json', `${base}/boq-lines.json`, `${base}/boq.xlsx`, `${base}/corrections.json`, `${base}/project.json`, `${base}/room-settings.json`, `${base}/rooms/${'a'.repeat(64)}-p0.json`, `${base}/sheets.json`, `${base}/sources/${'a'.repeat(64)}.pdf`].sort(),
    );
    expect(Buffer.from(files[`${base}/sources/${'a'.repeat(64)}.pdf`] as Uint8Array).equals(SAMPLE.pdf)).toBe(true);
    expect(JSON.parse(strFromU8(files[`${base}/boq-lines.json`] as Uint8Array))[0]).toMatchObject({ id: 'bl_4_01', code: '4.01' });
    expect(JSON.parse(strFromU8(files['manifest.json'] as Uint8Array))).toMatchObject({ orgId, projects: [{ id: projectId, name: 'בית משפחת נח', lines: 1, corrections: 1 }] });
    expect(Buffer.from(files[`${base}/boq.xlsx`] as Uint8Array).subarray(0, 2).toString()).toBe('PK');
    // nothing of the other org
    expect(Object.keys(files).some((f) => f.includes(otherProject))).toBe(false);
    expect(audits().filter((e) => e.entity === 'offboardingExports').map((e) => e.action)).toEqual(['create', 'ready', 'download']);
    expect((await http.get(`${O()}/offboarding/export/${exp.id}`).set(auth('editor'))).status).toBe(403);
    expect((await http.get(`${O(otherOrg)}/offboarding/export/${exp.id}`).set(auth('outsider'))).status).toBe(404);
  });

  it('offboard: typed org name required; → offboarding, deleteAfter +30 d, share links + sessions revoked, audited', async () => {
    const wrong = await http.post(`${O()}/offboarding`).set(auth('admin')).send({ confirm: 'משרד' });
    expect(wrong.status).toBe(400);
    expect((await http.post(`${O()}/offboarding`).set(auth('adminStale')).send({ confirm: 'משרד נח' })).status).toBe(403);
    expect((await http.post(`${O()}/offboarding`).set(auth('editor')).send({ confirm: 'משרד נח' })).status).toBe(403);
    expect((await http.post(`${O()}/offboarding`).set(auth('outsider')).send({ confirm: 'משרד נח' })).status).toBe(404);
    const r = await http.post(`${O()}/offboarding`).set(auth('admin')).send({ confirm: '  משרד נח ', reason: 'סיום התקשרות' });
    expect(r.status).toBe(200);
    const body = OffboardOrgResponseSchema.parse(r.body);
    expect(body).toMatchObject({ orgId, status: 'offboarding', revokedShareLinks: 1, revokedSessions: 3 });
    const days = (Date.parse(body.deleteAfter) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    expect(t.authAdmin.revoked.sort()).toEqual(['admin', 'editor', 'viewer']);
    expect(t.repo.docs.get(fsPaths.org(orgId))).toMatchObject({ status: 'offboarding', offboardingRequestedBy: 'admin' });
    const kinds = audits().slice(-3).map((e) => `${e.entity}/${e.action}`);
    expect(kinds).toEqual(['orgs/offboard', 'shareLinks/revoke_all', 'orgs/revoke_sessions']);
    expect(JSON.stringify(audits().slice(-3))).not.toContain('סיום');
    // share link now 410
    expect((await http.get(`/api/v1/public/share/${shareToken}/meta`)).status).toBe(410);
    // old sessions are dead (revokeRefreshTokens → checkRevoked)
    expect((await http.get(`/api/v1/projects/${projectId}`).set(auth('editor'))).status).toBe(401);
  });

  it('while offboarding: every org access is blocked (org_offboarding) except the org read and the export download', async () => {
    const now = Math.floor(Date.now() / 1000);
    tok.admin2 = t.auth.issue('admin', { mfa: true, authTime: now });
    tok.viewer2 = t.auth.issue('viewer');
    const blocked = await http.get(`/api/v1/projects/${projectId}`).set(auth('viewer2'));
    expect(blocked.status).toBe(403);
    expect(ApiErrorSchema.parse(blocked.body).error.code).toBe('org_offboarding');
    expect((await http.get(`/api/v1/projects/${projectId}/boq`).set(auth('admin2'))).status).toBe(403);
    expect((await http.get(`/api/v1/projects?orgId=${orgId}`).set(auth('admin2'))).status).toBe(403);
    expect((await http.patch(`${O()}/settings`).set(auth('admin2')).send({ llmEnabled: true })).status).toBe(403);
    expect((await http.post(`/api/v1/projects/${projectId}/share-links`).set(auth('admin2')).send({ label: 'x' })).status).toBe(403);
    const org = MyOrgSchema.parse((await http.get(O()).set(auth('viewer2'))).body);
    expect(org).toMatchObject({ status: 'offboarding' });
    const exportId = OffboardingExportJobSchema.parse(t.apiJobs.messages.at(-1)).exportId;
    expect((await http.get(`${O()}/offboarding/export/${exportId}`).set(auth('admin2'))).status).toBe(200);
    // outsiders still learn nothing
    expect((await http.get(`/api/v1/projects/${projectId}`).set(auth('outsider'))).status).toBe(404);
    // second offboard call is idempotent (deleteAfter kept)
    const before = (t.repo.docs.get(fsPaths.org(orgId)) as Doc).deleteAfter as Date;
    const again = OffboardOrgResponseSchema.parse((await http.post(`${O()}/offboarding`).set(auth('admin2')).send({ confirm: 'משרד נח' })).body);
    expect(Date.parse(again.deleteAfter)).toBe(before.getTime());
    // other org untouched
    expect((await http.get(`/api/v1/projects/${otherProject}`).set(auth('outsider'))).status).toBe(200);
  });

  it('purge: nothing before deleteAfter; after → Firestore subtree + jobs + token index + Storage prefix gone, certificate + tombstone', async () => {
    const early = await runPurge(t.gov, t.govStorage, { now: new Date() });
    expect(early).toEqual({ due: [], certificates: [] });
    const dry = await runPurge(t.gov, t.govStorage, { now: new Date(Date.now() + 31 * 86_400_000), dryRun: true });
    expect(dry.due).toEqual([orgId]);
    expect(t.repo.docs.has(fsPaths.org(orgId))).toBe(true);

    const auditHead = (t.repo.docs.get(fsPaths.auditHead(orgId)) as Doc).hash;
    const docsBefore = [...t.repo.docs.keys()].filter((k) => k.startsWith(`orgs/${orgId}/`) || k === fsPaths.org(orgId)).length;
    const res = await runPurge(t.gov, t.govStorage, { now: new Date(Date.now() + 31 * 86_400_000) });
    expect(res.due).toEqual([orgId]);
    const cert = DeletionCertificateSchema.parse(res.certificates[0]);
    expect([...t.repo.docs.keys()].filter((k) => k.startsWith(`orgs/${orgId}`))).toEqual([]);
    expect(t.repo.docs.has(fsPaths.job(`job_${orgId}`))).toBe(false);
    expect([...t.repo.docs.entries()].filter(([k, v]) => k.startsWith('shareTokens/') && v.orgId === orgId)).toEqual([]);
    for (const m of [t.storage.objects, t.boqStorage.objects, t.artifacts.objects, t.govStorage.objects]) expect([...m.keys()].filter((k) => k.startsWith(`orgs/${orgId}/`))).toEqual([]);
    expect(cert).toMatchObject({ orgId, requestedBy: 'admin', counts: { members: 3, projects: 1 }, hashes: { auditHead } });
    expect(cert.counts.firestoreDocs).toBeGreaterThanOrEqual(docsBefore);
    expect(cert.counts.storageObjects).toBeGreaterThanOrEqual(3); // source + rooms/detections artifacts + zip
    expect(cert.counts.jobs).toBeGreaterThanOrEqual(2);
    const line = certificateLine(cert); // R-A9: one log line
    expect(line).not.toContain('\n');
    expect(DeletionCertificateSchema.parse(JSON.parse(line))).toEqual(cert);
    const { certificateSha256, ...rest } = cert;
    expect(certificateSha256).toBe(createHash('sha256').update(canonicalJson(rest)).digest('hex'));
    // the tombstone holds no names / content
    const stored = t.repo.docs.get(fsPaths.offboardingCertificate(orgId)) as Doc;
    expect(stored).toMatchObject({ orgId, schema: 'kamutan.deletion-certificate/1' });
    expect(JSON.stringify(stored)).not.toMatch(/משרד|נח|שקע|חשמל/);
    // other org intact, re-run is a no-op
    expect(t.repo.docs.has(fsPaths.org(otherOrg))).toBe(true);
    expect(t.storage.objects.has(sourcePath(otherOrg, otherProject))).toBe(true);
    expect(t.repo.docs.has(fsPaths.job(`job_${otherOrg}`))).toBe(true);
    expect((await runPurge(t.gov, t.govStorage, { now: new Date(Date.now() + 31 * 86_400_000) })).due).toEqual([]);
  });
});
