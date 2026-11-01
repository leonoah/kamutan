/**
 * Stage 10 — API/Sec: offboarding end to end (SEC-52), in memory.
 * export ZIP → offboard (typed org name) → every member route answers 403 org_offboarding except the allowed ones
 * (org read, offboarding export status/download, offboard itself; /me, /orgs) → share links 410, sessions revoked →
 * purge after deleteAfter → deletion certificate; the other org is untouched throughout.
 */
import { createHash } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreateOffboardingExportResponseSchema, DeletionCertificateSchema, fsPaths, MeResponseSchema, OffboardingExportJobSchema, OffboardingExportViewSchema, OffboardOrgResponseSchema, ROLES, storagePaths } from '@kamutan/contracts';
import { canonicalJson } from '../../src/db/audit-chain';
import type { Doc } from '../../src/db/mappers';
import { OffboardingService } from '../../src/governance/offboarding.service';
import { runPurge } from '../../src/scripts/offboard-purge';
import { SAMPLE } from '../support/helpers';
import { writeEvidence } from './support/evidence';
import { ROUTES, send, type RouteCase } from './support/routes';
import { createWorld, snapshotOrg, type World } from './support/world';

const key = (c: RouteCase) => (c.variant ? `${c.route} [${c.variant}]` : c.route);

describe('Stage 10 API/Sec — offboarding end to end: export → offboard → blocked → purge → certificate', () => {
  let w: World;
  let exportId = '';
  let zipSha = '';
  let bBefore = '';
  const O = () => `/api/v1/orgs/${w.A.orgId}`;
  const ev: Record<string, unknown> = {};
  const fresh = (role: (typeof ROLES)[number]) => {
    const t = w.t.auth.issue(w.A.uid(role), { mfa: true, authTime: Math.floor(Date.now() / 1000) });
    return { authorization: `Bearer ${t}` };
  };

  beforeAll(async () => {
    w = await createWorld();
    w.t.authAdmin.onRevoke = (uid) => w.t.auth.revokeUser(uid);
  });
  afterAll(async () => {
    writeEvidence('offboarding.json', ev);
    await w.t.app.close();
  });

  it('1. export: admin + MFA + recent sign-in → 202 → runner builds the ZIP (sources, xlsx, JSON, manifest) → 24 h URL', async () => {
    const r = await w.http.post(`${O()}/offboarding/export`).set(w.auth(w.A.uid('admin'))).send({});
    expect(r.status).toBe(202);
    const { export: exp, jobId } = CreateOffboardingExportResponseSchema.parse(r.body);
    exportId = exp.id;
    const msg = OffboardingExportJobSchema.parse(w.t.apiJobs.messages.at(-1));
    expect(msg).toMatchObject({ orgId: w.A.orgId, exportId, jobId });
    await w.t.app.get(OffboardingService).runExport(msg);
    const v = OffboardingExportViewSchema.parse((await w.http.get(`${O()}/offboarding/export/${exportId}`).set(w.auth(w.A.uid('admin')))).body);
    expect(v.export.status).toBe('ready');
    expect(v.url).toContain('X-Goog-Expires=86400');
    const zip = w.t.govStorage.objects.get(storagePaths.offboardingZip(w.A.orgId, exportId)) as Buffer;
    zipSha = createHash('sha256').update(zip).digest('hex');
    expect(v.export.sha256).toBe(zipSha);
    const files = unzipSync(new Uint8Array(zip));
    const names = Object.keys(files).sort();
    ev.zipFiles = names;
    const base = `projects/${w.A.projectId}`;
    expect(names).toEqual(expect.arrayContaining(['manifest.json', `${base}/boq.xlsx`, `${base}/boq-lines.json`, `${base}/corrections.json`, `${base}/sheets.json`, `${base}/project.json`]));
    expect(names.filter((n) => n.startsWith(`${base}/sources/`))).toHaveLength(2);
    expect(Buffer.from(files[`${base}/sources/${'a'.repeat(64)}.pdf`] as Uint8Array).equals(SAMPLE.pdf)).toBe(true);
    expect(JSON.parse(strFromU8(files[`${base}/boq-lines.json`] as Uint8Array)).map((l: Doc) => l.id).sort()).toEqual(Object.values(w.A.lines).sort());
    expect(JSON.stringify(names)).not.toContain(w.B.projectId);
    expect(new TextDecoder().decode(zip.subarray(0, 400000))).not.toContain(w.B.orgName);
  });

  it('2. offboard: wrong name → 400, editor → 403, outsider → 404, admin → offboarding, deleteAfter +30 d, links + sessions revoked', async () => {
    expect((await w.http.post(`${O()}/offboarding`).set(w.auth(w.A.uid('admin'))).send({ confirm: 'משרד' })).status).toBe(400);
    expect((await w.http.post(`${O()}/offboarding`).set(w.auth(w.A.uid('editor'))).send({ confirm: w.A.orgName })).status).toBe(403);
    expect((await w.http.post(`${O()}/offboarding`).set(w.auth('outsider')).send({ confirm: w.A.orgName })).status).toBe(404);
    const r = await w.http.post(`${O()}/offboarding`).set(w.auth(w.A.uid('admin'))).send({ confirm: w.A.orgName, reason: 'סיום התקשרות' });
    expect(r.status).toBe(200);
    const body = OffboardOrgResponseSchema.parse(r.body);
    // Stage 10: the world has a 5th member (a_extra, target of DELETE /members)
    expect(body).toMatchObject({ status: 'offboarding', revokedShareLinks: 1, revokedSessions: 5 });
    expect((Date.parse(body.deleteAfter) - Date.now()) / 86_400_000).toBeCloseTo(30, 0);
    for (const p of ['/meta', '/boq', `/sheets/${w.A.sheet.sheetId}/overlay`]) expect((await w.http.get(`/api/v1/public/share/${w.A.link.token}${p}`)).status).toBe(410);
    // old sessions are dead (revokeRefreshTokens → checkRevoked)
    for (const r0 of ROLES) expect((await w.http.get(`/api/v1/projects/${w.A.projectId}`).set(w.auth(w.A.uid(r0)))).status).toBe(401);
    ev.offboard = body;
  });

  it('3. while offboarding: EVERY member route → 403 org_offboarding for every role, except the allowed ones; outsiders still 404', async () => {
    const results: Array<Record<string, unknown>> = [];
    const bad: string[] = [];
    for (const c of ROUTES) {
      for (const role of ['admin', 'viewer'] as const) {
        const r = await send(w.http, c.build(w.A, role), fresh(role));
        results.push({ case: key(c), role, status: r.status, code: r.body?.error?.code ?? null });
        const blocked = r.status === 403 && r.body?.error?.code === 'org_offboarding';
        if (c.offboarding) {
          if (blocked) bad.push(`${key(c)} as ${role}: blocked but should stay available`);
        } else if (!blocked) bad.push(`${key(c)} as ${role}: ${r.status} ${r.body?.error?.code ?? ''}`);
      }
    }
    ev.blockedSweep = results;
    expect(bad).toEqual([]);
    expect(results.filter((r) => r.code === 'org_offboarding').length).toBe(2 * ROUTES.filter((c) => !c.offboarding).length);
    // the org read tells members why
    const org = await w.http.get(O()).set(fresh('viewer'));
    expect(org.body).toMatchObject({ status: 'offboarding' });
    // the ZIP stays downloadable for the admin (MFA + recent sign-in)
    expect(OffboardingExportViewSchema.parse((await w.http.get(`${O()}/offboarding/export/${exportId}`).set(fresh('admin'))).body).url).toBeTruthy();
    expect((await w.http.get(`/api/v1/projects/${w.A.projectId}`).set(w.auth('outsider'))).status).toBe(404);
    // org B is untouched and fully usable
    expect((await w.http.get(`/api/v1/projects/${w.B.projectId}/boq`).set(w.auth(w.B.uid('viewer')))).status).toBe(200);
    expect((await w.http.get(`/api/v1/public/share/${w.B.link.token}/meta`)).status).toBe(200);
    bBefore = snapshotOrg(w.t, w.B.orgId); // B as it stands before the purge (the share view above is B's own write)
  });

  it('4. purge: nothing before deleteAfter; after → org subtree, jobs, token index and every storage object gone; certificate valid and content-free', async () => {
    expect((await runPurge(w.t.gov, w.t.govStorage, { now: new Date() })).due).toEqual([]);
    const auditHead = (w.t.repo.docs.get(fsPaths.auditHead(w.A.orgId)) as Doc).hash;
    const res = await runPurge(w.t.gov, w.t.govStorage, { now: new Date(Date.now() + 31 * 86_400_000) });
    expect(res.due).toEqual([w.A.orgId]);
    const cert = DeletionCertificateSchema.parse(res.certificates[0]);
    ev.certificate = cert;
    const { certificateSha256, ...rest } = cert;
    expect(certificateSha256).toBe(createHash('sha256').update(canonicalJson(rest)).digest('hex'));
    expect(cert).toMatchObject({ orgId: w.A.orgId, counts: { members: 5, projects: 1 }, hashes: { auditHead } });
    expect([...w.t.repo.docs.keys()].filter((k) => k.startsWith(`orgs/${w.A.orgId}`))).toEqual([]);
    expect(w.t.repo.docs.has(fsPaths.job(w.A.jobId))).toBe(false);
    expect([...w.t.repo.docs.entries()].filter(([k, v]) => k.startsWith('shareTokens/') && v.orgId === w.A.orgId)).toEqual([]);
    for (const m of [w.t.storage.objects, w.t.boqStorage.objects, w.t.artifacts.objects, w.t.govStorage.objects]) expect([...m.keys()].filter((k) => k.includes(w.A.orgId))).toEqual([]);
    const tomb = w.t.repo.docs.get(fsPaths.offboardingCertificate(w.A.orgId)) as Doc;
    expect(tomb).toMatchObject({ orgId: w.A.orgId });
    expect(JSON.stringify(tomb)).not.toMatch(/משרד|פרויקט|שקע|@a\.example/);
    expect(JSON.stringify(tomb)).not.toContain(w.A.projectName);
  });

  it('5. after the purge: former members see nothing (404 / no org in /me); org B is byte-identical', async () => {
    const admin = fresh('admin');
    expect((await w.http.get(O()).set(admin)).status).toBe(404);
    expect((await w.http.get(`/api/v1/projects/${w.A.projectId}`).set(admin)).status).toBe(404);
    expect((await w.http.get(`${O()}/offboarding/export/${exportId}`).set(admin)).status).toBe(404);
    const me = MeResponseSchema.parse((await w.http.get('/api/v1/me').set(admin)).body);
    expect(me.orgs.map((o) => o.id)).not.toContain(w.A.orgId);
    expect((await w.http.get(`/api/v1/public/share/${w.A.link.token}/meta`)).status).toBe(404);
    expect(snapshotOrg(w.t, w.B.orgId)).toBe(bBefore);
    expect(w.t.repo.docs.has(fsPaths.job(w.B.jobId))).toBe(true);
  });
});
