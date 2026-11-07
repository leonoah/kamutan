/**
 * Stage 10 — API/Sec: E2E-10 org isolation via URL / API (SEC-09/10, RL-01..03 API side).
 * A user of org A (admin, MFA) guesses org B's project, sheet, version, line, correction, batch, export, share-link,
 * legend-entry, cluster, search, item, import, job, template/rule and offboarding-export ids on EVERY member endpoint.
 * Expected: 404 with the same body as for an id that never existed, no B data in any response, B unchanged, and no
 * difference in the work the server does (repository calls = the timing-relevant proxy in-memory).
 * The Firestore / Storage rules channel ("Supabase client" in the plan) is the firebase/tests emulator suite: CI only.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@kamutan/contracts';
import { BOQ_REPOSITORY } from '../../src/db/boq-repository';
import { GOVERNANCE_REPOSITORY } from '../../src/db/governance-repository';
import { REVIEW_REPOSITORY } from '../../src/db/review-repository';
import { writeEvidence } from './support/evidence';
import { ROUTES, send, type Req, type RouteCase } from './support/routes';
import { createWorld, snapshotOrg, type OrgWorld, type World } from './support/world';

const rid = (n = 20) => randomBytes(n).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x').slice(0, n);
const key = (c: RouteCase) => (c.variant ? `${c.route} [${c.variant}]` : c.route);

/** Same shapes as `o`, every id replaced by a random one that never existed. */
function phantom(o: OrgWorld): OrgWorld {
  const s = () => ({ sheetId: `${'9'.repeat(64)}${rid(4)}-p0`.slice(-67), versionId: rid() });
  return {
    ...o,
    orgId: rid(),
    projectId: rid(),
    sheet: s(),
    sheet2: s(),
    roomId: 'r_404',
    clusterId: 'u_404',
    lines: { status: `ln_${rid(8)}`, override: `ln_${rid(8)}`, approved: `ln_${rid(8)}`, plain: `ln_${rid(8)}` },
    corrections: { accept: rid(), add: rid() },
    batches: { accept: rid(), add: rid() },
    exportId: rid(),
    link: { id: rid(), token: rid(43) },
    entryId: `le_${rid(8)}`,
    searchId: rid(),
    itemId: `it_${rid(12)}`,
    imports: { editor: '00000000-0000-4000-8000-000000000000', admin: '00000000-0000-4000-8000-000000000001' },
    jobId: rid(),
    templateId: `tpl_${rid(6)}`,
    ruleId: `r_${rid(6)}`,
    offboardingExportId: rid(),
    extraMemberUid: `u_${rid(10)}`,
    invites: { viewer: rid(), reviewer: rid(), editor: rid(), admin: rid() },
    revokeInviteId: rid(),
  };
}

/** A's own project/org, B's (or phantom) sub-resource ids. */
const mixed = (A: OrgWorld, other: OrgWorld): OrgWorld => ({ ...other, key: 'a', orgId: A.orgId, projectId: A.projectId, uid: A.uid });

describe('Stage 10 API/Sec — E2E-10 org isolation (URL / API)', () => {
  let w: World;
  let calls: string[] = [];
  const results: Array<Record<string, unknown>> = [];
  const B_SECRETS = () => [w.B.orgName, w.B.projectName, 'בית סודי', 'פריט ספרייה b', w.B.link.token, 'b_admin@b.example.test', 'רחוב b 1'];
  const as = (who: Role = 'admin') => w.auth(w.A.uid(who));
  const strip = (b: { error?: { code?: string; message?: string } }) => ({ code: b?.error?.code, message: b?.error?.message });
  const traced = async (req: Req, who: Role = 'admin') => {
    calls = [];
    const r = await send(w.http, req, as(who));
    return { r, calls: [...calls] };
  };

  beforeAll(async () => {
    w = await createWorld();
    // count repository calls (the server-side work an attacker could time)
    const repos: Array<[string, object]> = [
      ['core', w.t.repo],
      ['boq', w.t.app.get(BOQ_REPOSITORY)],
      ['gov', w.t.app.get(GOVERNANCE_REPOSITORY)],
      ['review', w.t.app.get(REVIEW_REPOSITORY)],
    ];
    for (const [name, repo] of repos) {
      const proto = Object.getPrototypeOf(repo) as object;
      for (const m of Object.getOwnPropertyNames(proto)) {
        const fn = Object.getOwnPropertyDescriptor(proto, m)?.value as unknown;
        if (m === 'constructor' || typeof fn !== 'function' || ['now', 'tx', 'children'].includes(m)) continue;
        (repo as Record<string, unknown>)[m] = function (this: unknown, ...args: unknown[]) {
          calls.push(`${name}.${m}`);
          return (fn as (...a: unknown[]) => unknown).apply(repo, args);
        };
      }
    }
  });
  afterAll(async () => {
    writeEvidence('isolation-results.json', results);
    await w.t.app.close();
  });

  it("A's admin on every member endpoint with B's org / project ids → 404, body identical to a never-existing id, no B data, B unchanged", async () => {
    const before = snapshotOrg(w.t, w.B.orgId);
    const ghost = phantom(w.B);
    const failures: string[] = [];
    for (const c of ROUTES.filter((x) => x.min !== 'any')) {
      const real = await traced(c.build(w.B, 'admin'));
      const fake = await traced(c.build(ghost, 'admin'));
      const text = JSON.stringify(real.r.body);
      const leaked = B_SECRETS().filter((s) => text.includes(s));
      results.push({ case: key(c), target: 'B ids', status: real.r.status, body: strip(real.r.body), phantomStatus: fake.r.status, phantomBody: strip(fake.r.body), repoCalls: real.calls, phantomRepoCalls: fake.calls });
      if (real.r.status !== 404) failures.push(`${key(c)}: ${real.r.status} ${text.slice(0, 160)}`);
      if (real.r.status !== fake.r.status || JSON.stringify(strip(real.r.body)) !== JSON.stringify(strip(fake.r.body))) failures.push(`${key(c)}: differs from phantom (${fake.r.status} ${JSON.stringify(strip(fake.r.body))})`);
      if (leaked.length) failures.push(`${key(c)}: leaks ${leaked.join(', ')}`);
    }
    expect(failures).toEqual([]);
    expect(snapshotOrg(w.t, w.B.orgId)).toBe(before);
    // B's share link still works (A could not revoke it)
    expect((await w.http.get(`/api/v1/public/share/${w.B.link.token}/meta`)).status).toBe(200);
  });

  it("A's own project with B's sub-resource ids (sheet, version, line, correction, batch, export, link, entry, search, import …) → same answer as a phantom id, never 2xx, no B data", async () => {
    const before = snapshotOrg(w.t, w.B.orgId);
    const failures: string[] = [];
    let checked = 0;
    for (const c of ROUTES.filter((x) => x.min !== 'any')) {
      const own = c.build(w.A, 'admin');
      const withB = c.build(mixed(w.A, w.B), 'admin');
      if (JSON.stringify(own) === JSON.stringify(withB)) continue; // route has no sub-resource id
      checked++;
      const withGhost = c.build(mixed(w.A, phantom(w.B)), 'admin');
      const real = await traced(withB);
      const fake = await traced(withGhost);
      const text = JSON.stringify(real.r.body);
      const leaked = B_SECRETS().filter((s) => text.includes(s));
      results.push({ case: key(c), target: 'A project + B sub-ids', status: real.r.status, body: strip(real.r.body), phantomStatus: fake.r.status, phantomBody: strip(fake.r.body) });
      if (real.r.status >= 500) failures.push(`${key(c)}: ${real.r.status} ${text.slice(0, 160)}`);
      // a 2xx is acceptable only for a filter that simply matches nothing (e.g. GET boq/evidence?sheetId=<B's>): then
      // the body must equal the phantom's once the echoed ids are masked
      // Sprint 6: batch-status answers 200 with every unknown id `skipped: not_found` and a fresh random batchId.
      const mask = (s: string, ids: string[]) => ids.reduce((acc, id) => acc.split(id).join('<id>'), s).replace(/b[sp]_[0-9a-f]{32}/g, '<batch>'); // Sprint 8: + bulk prices `bp_…`
      const idsOf = (req: Req): string[] => [...(req.url.match(/[A-Za-z0-9_-]{8,}/g) ?? []), ...(JSON.stringify(req.body ?? {}).match(/[A-Za-z0-9_-]{8,}/g) ?? [])];
      const same =
        real.r.status === fake.r.status &&
        (real.r.status >= 400 ? JSON.stringify(strip(real.r.body)) === JSON.stringify(strip(fake.r.body)) : mask(text, idsOf(withB)) === mask(JSON.stringify(fake.r.body), idsOf(withGhost)));
      if (!same) failures.push(`${key(c)}: ${real.r.status} ${JSON.stringify(strip(real.r.body))} vs phantom ${fake.r.status} ${JSON.stringify(strip(fake.r.body))}`);
      if (leaked.length) failures.push(`${key(c)}: leaks ${leaked.join(', ')}`);
    }
    expect(checked).toBeGreaterThan(25);
    expect(failures).toEqual([]);
    expect(snapshotOrg(w.t, w.B.orgId)).toBe(before);
  });

  it("same org, other project: P1's sub-resource ids through P2's URL (sheet, line, correction, export, share link …) → same answer as a phantom id, P1 unchanged", async () => {
    const p2 = (await w.http.post('/api/v1/projects').set(as('editor')).send({ orgId: w.A.orgId, name: 'פרויקט שני' })).body.id as string;
    const ghost = { ...phantom(w.A), orgId: w.A.orgId, projectId: p2 };
    const failures: string[] = [];
    let checked = 0;
    for (const c of ROUTES.filter((x) => x.route.includes('{projectId}/'))) {
      const viaP2 = c.build({ ...w.A, projectId: p2 }, 'admin');
      const viaGhost = c.build(ghost, 'admin');
      const real = await send(w.http, viaP2, as());
      const fake = await send(w.http, viaGhost, as());
      checked++;
      results.push({ case: key(c), target: 'P2 + P1 sub-ids', status: real.status, body: strip(real.body), phantomStatus: fake.status });
      if (real.status >= 500) failures.push(`${key(c)}: ${real.status}`);
      const sameErr = real.status >= 400 && real.status === fake.status && JSON.stringify(strip(real.body)) === JSON.stringify(strip(fake.body));
      const sameOk = real.status < 400 && real.status === fake.status;
      if (!sameErr && !sameOk) failures.push(`${key(c)}: ${real.status} ${JSON.stringify(strip(real.body))} vs phantom ${fake.status} ${JSON.stringify(strip(fake.body))}`);
      if (real.status < 300 && JSON.stringify(real.body).includes(w.A.projectName)) failures.push(`${key(c)}: P1 data via P2`);
    }
    expect(checked).toBeGreaterThan(30);
    expect(failures).toEqual([]);
    // P1's share link was not revoked through P2
    expect((await w.http.get(`/api/v1/public/share/${w.A.link.token}/meta`)).status).toBe(200);
  });

  it("every role of A (viewer … admin) gets the same 404 for B's project — the role in A never changes the answer", async () => {
    for (const who of ['viewer', 'reviewer', 'editor', 'admin'] as const) {
      const r = await w.http.get(`/api/v1/projects/${w.B.projectId}/boq`).set(as(who));
      expect([r.status, strip(r.body)]).toEqual([404, { code: 'not_found', message: 'project not found' }]);
    }
  });

  it('list / search endpoints never return B rows (projects, library, audit filtered by a B entity id, corrections, legend)', async () => {
    const checks = [
      `/api/v1/projects?orgId=${w.A.orgId}`,
      `/api/v1/library/items?orgId=${w.A.orgId}&q=${encodeURIComponent('ספרייה b')}`,
      `/api/v1/orgs/${w.A.orgId}/audit?entityId=${w.B.projectId}`,
      `/api/v1/orgs/${w.A.orgId}/audit?entityId=${w.B.link.id}`,
      `/api/v1/projects/${w.A.projectId}/corrections?sheetId=${w.B.sheet.sheetId}`,
      `/api/v1/projects/${w.A.projectId}/legend-entries?sheetId=${w.B.sheet.sheetId}`,
      `/api/v1/projects/${w.A.projectId}/review-queue?sheetId=${w.B.sheet.sheetId}`,
      '/api/v1/me',
      '/api/v1/orgs',
    ];
    for (const url of checks) {
      const r = await w.http.get(url).set(as());
      expect(r.status, url).toBe(200);
      const text = JSON.stringify(r.body);
      for (const s of [...B_SECRETS(), w.B.orgId, w.B.projectId]) expect(text.includes(s), `${url} contains ${s}`).toBe(false);
    }
  });

  it("signed URLs handed to A only ever point under orgs/{A}/ (never B's prefix)", async () => {
    const urls: string[] = [];
    for (const u of [
      `/api/v1/projects/${w.A.projectId}/sheets/${w.A.sheet.sheetId}/versions/${w.A.sheet.versionId}/overlay`,
      `/api/v1/projects/${w.A.projectId}/sheets/${w.A.sheet.sheetId}/versions/${w.A.sheet.versionId}/tiles-manifest?z=0`,
      `/api/v1/projects/${w.A.projectId}/exports/${w.A.exportId}`,
      `/api/v1/projects/${w.A.projectId}/similar-searches/${w.A.searchId}`,
    ]) {
      const r = await w.http.get(u).set(as());
      expect(r.status, u).toBe(200);
      urls.push(...(JSON.stringify(r.body).match(/https?:\/\/[^"]+/g) ?? []));
    }
    expect(urls.length).toBeGreaterThan(3);
    for (const u of urls) {
      const d = decodeURIComponent(u);
      if (d.includes('/orgs/')) expect(d).toContain(`/orgs/${w.A.orgId}/`);
      expect(d).not.toContain(w.B.orgId);
    }
  });

  it('A-API-10: no timing oracle — the server does the same repository work for B\'s real project / job id as for a never-existing id', () => {
    const differing = results
      .filter((r) => r.target === 'B ids' && JSON.stringify(r.repoCalls) !== JSON.stringify(r.phantomRepoCalls))
      .map((r) => ({ case: r.case, real: r.repoCalls, phantom: r.phantomRepoCalls }));
    writeEvidence('isolation-timing-oracle.json', differing);
    expect(differing).toEqual([]);
  });

  it.todo('E2E-10 "Supabase client" channel = Firestore / Storage Security Rules with a member token of A on B paths: firebase/tests emulator suite (F-1 block), not runnable here (emulator JARs unreachable) — CI only');
});
