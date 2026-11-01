/**
 * Stage 10 — API/Sec: roles matrix (RL-01, SEC-07) on EVERY member endpoint.
 * Routes are enumerated from the running Nest app (Swagger scan of the live router + Express router stack) and from the
 * committed openapi.json; the table in support/routes.ts must cover exactly that set.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildOpenApi } from '../../src/bootstrap';
import { writeEvidence } from './support/evidence';
import { PUBLIC_ROUTES, ROUTES, satisfies, send, type RouteCase } from './support/routes';
import { createWorld, MEMBER_ROLES, type World } from './support/world';

const key = (c: RouteCase) => (c.variant ? `${c.route} [${c.variant}]` : c.route);

describe('Stage 10 API/Sec — roles matrix viewer / reviewer / editor / admin × every member endpoint', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  });
  afterAll(async () => {
    await w.t.app.close();
  });

  it('the route table covers exactly the live router and the committed openapi.json (nothing missed)', () => {
    const live = buildOpenApi(w.t.app);
    const liveRoutes = Object.entries(live.paths).flatMap(([p, ops]) => Object.keys(ops as object).map((m) => `${m.toUpperCase()} ${p}`));
    const committed = JSON.parse(readFileSync(fileURLToPath(new URL('../../openapi.json', import.meta.url)), 'utf8')) as { paths: Record<string, object> };
    const committedRoutes = Object.entries(committed.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`));
    // Express router stack (catches a handler without Swagger metadata)
    const express = w.t.app.getHttpAdapter().getInstance() as { router?: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } };
    const expressRoutes = (express.router?.stack ?? [])
      // Nest's catch-all 404 handlers (`/api{/*splat}`) are not routes
      .filter((l) => l.route && !l.route.path.includes('*'))
      .flatMap((l) => Object.keys(l.route?.methods ?? {}).filter((m) => m !== '_all').map((m) => `${m.toUpperCase()} ${(l.route?.path ?? '').replace(/:([A-Za-z]+)/g, '{$1}')}`));
    const table = new Set([...ROUTES.map((c) => c.route), ...PUBLIC_ROUTES]);
    const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
    writeEvidence('routes-enumerated.json', { live: sorted(liveRoutes), committed: sorted(committedRoutes), express: sorted(expressRoutes), table: sorted(table) });
    expect(sorted(liveRoutes)).toEqual(sorted(table));
    expect(sorted(committedRoutes)).toEqual(sorted(table));
    if (expressRoutes.length > 0) expect(sorted(expressRoutes.filter((r) => !r.startsWith('HEAD ')))).toEqual(sorted(table));
    expect(ROUTES.length).toBeGreaterThanOrEqual(66);
  });

  it('every member endpoint: roles below the minimum → 403, at/above → authorized; unauthenticated → 401; outsider → 404', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const mismatches: string[] = [];
    // lowest role first: denied calls never change state; the first authorized call may (e.g. revert), later ones then
    // get 409/200 — both "authorized".
    for (const c of ROUTES) {
      const row: Record<string, unknown> = { route: key(c), min: c.min, spec: c.spec, specRow: c.specRow };
      for (const role of MEMBER_ROLES) {
        const r = await send(w.http, c.build(w.A, role), w.auth(w.A.uid(role)));
        row[role] = r.status;
        const allowed = satisfies(role, c.min);
        const okStatus = allowed ? r.status !== 401 && r.status !== 403 && r.status !== 404 && r.status < 500 : r.status === 403 && r.body?.error?.code === 'forbidden';
        if (!okStatus) mismatches.push(`${key(c)} as ${role}: ${r.status} ${JSON.stringify(r.body?.error ?? r.body).slice(0, 160)}`);
      }
      const anon = await send(w.http, c.build(w.A, 'admin'), {});
      row.anon = anon.status;
      if (anon.status !== 401) mismatches.push(`${key(c)} anonymous: ${anon.status}`);
      if (c.min !== 'any') {
        const out = await send(w.http, c.build(w.A, 'admin'), w.auth('outsider'));
        row.outsider = out.status;
        if (out.status !== 404) mismatches.push(`${key(c)} outsider: ${out.status}`);
      }
      row.specMatch = c.min === c.spec ? 'yes' : `NO (${c.defect})`;
      rows.push(row);
    }
    const md = [
      '| route | impl min | spec min (SEC-07) | viewer | reviewer | editor | admin | anon | outsider | spec match |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...rows.map((r) => `| \`${r.route}\` | ${r.min} | ${r.spec} | ${r.viewer} | ${r.reviewer} | ${r.editor} | ${r.admin} | ${r.anon} | ${r.outsider ?? '—'} | ${r.specMatch} |`),
    ].join('\n');
    writeEvidence('roles-matrix.md', `# Roles matrix (${ROUTES.length} cases over ${new Set(ROUTES.map((c) => c.route)).size} member routes)\n\n${md}\n\nMismatches vs implementation contract: ${mismatches.length}\n${mismatches.map((m) => `- ${m}`).join('\n')}\n`);
    writeEvidence('roles-matrix.json', { rows, mismatches });
    expect(mismatches).toEqual([]);
  });

  it('documents every implementation-vs-spec role difference with a defect id', () => {
    const diffs = ROUTES.filter((c) => c.min !== c.spec);
    expect(diffs.every((c) => typeof c.defect === 'string')).toBe(true);
    // Stage 10: A-API-03 (reviewer corrections) and A-API-07 (viewer history) fixed → no difference left.
    expect(diffs.map((c) => c.defect).sort()).toEqual([]);
  });

  // ---- spec-vs-implementation defects (see defects.md); fixed in the Stage 10 fix round
  it('A-API-03: SEC-07 / E2E-02 — a reviewer ("הבודק") can add a missed symbol as a correction', async () => {
    const c = ROUTES.find((x) => x.variant === 'add' && x.route.endsWith('/corrections')) as RouteCase;
    const r = await send(w.http, c.build(w.A, 'reviewer'), w.auth(w.A.uid('reviewer')));
    expect(r.status).toBe(201);
  });

  it('A-API-07: SEC-07 "צפייה" — a viewer can read a BOQ line history', async () => {
    const r = await w.http.get(`/api/v1/projects/${w.A.projectId}/boq/lines/${w.A.lines.status}/history`).set(w.auth(w.A.uid('viewer')));
    expect(r.status).toBe(200);
  });

  it('SEC-02: offboarding actions need MFA (admin without a second factor → 403 mfa_required)', async () => {
    const h = w.auth('a_admin_nomfa');
    const exp = await w.http.post(`/api/v1/orgs/${w.A.orgId}/offboarding/export`).set(h).send({});
    expect([exp.status, exp.body.error.code]).toEqual([403, 'mfa_required']);
    const off = await w.http.post(`/api/v1/orgs/${w.A.orgId}/offboarding`).set(h).send({ confirm: w.A.orgName });
    expect([off.status, off.body.error.code]).toEqual([403, 'mfa_required']);
  });

  it('A-API-02: SEC-02 — org settings / LLM switch / BOQ template / rule changes need MFA (aal2)', async () => {
    const h = w.auth('a_admin_nomfa');
    const codes = [
      await w.http.patch(`/api/v1/orgs/${w.A.orgId}/settings`).set(h).send({ llmEnabled: true }),
      await w.http.patch(`/api/v1/boq-templates/tpl_default?orgId=${w.A.orgId}`).set(h).send({ name: 'x' }),
      await w.http.patch(`/api/v1/boq-rules/r_light_two_way?orgId=${w.A.orgId}`).set(h).send({ enabled: false }),
    ].map((r) => [r.status, r.body?.error?.code]);
    writeEvidence('mfa-admin-settings.json', codes);
    expect(codes).toEqual([
      [403, 'mfa_required'],
      [403, 'mfa_required'],
      [403, 'mfa_required'],
    ]);
  });

  it.todo('A-API-01: SEC-07 row "ניהול משתמשים" / UX onboarding step 4 — no member / invite / role-change endpoint exists (04_architecture: GET/POST/PATCH/DELETE /orgs/:orgId/members, POST /orgs/:orgId/invites)');

  it('a role change is effective immediately (membership read from Firestore per request, not from token claims)', async () => {
    const uid = w.A.uid('viewer');
    const url = `/api/v1/projects/${w.A.projectId}/boq/lines/${w.A.lines.plain}`;
    expect((await w.http.patch(url).set(w.auth(uid)).send({ status: 'reviewed' })).status).toBe(403);
    w.t.repo.setMember(w.A.orgId, uid, 'reviewer');
    expect((await w.http.patch(url).set(w.auth(uid)).send({ status: 'reviewed' })).status).toBe(200);
    w.t.repo.setMember(w.A.orgId, uid, 'viewer');
    expect((await w.http.patch(url).set(w.auth(uid)).send({ status: 'draft' })).status).toBe(403);
  });
});
