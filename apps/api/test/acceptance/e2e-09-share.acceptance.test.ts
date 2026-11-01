/**
 * Stage 10 — API/Sec: E2E-09 share link for an external viewer (FR-30, SEC-26–29, SH-01..04).
 * Approved project → editor creates a 7-day link → the public meta / boq / overlay / tiles endpoints work, every write
 * is refused (405 on /public, 403 with the token on the private API), revoke and expiry → 410 with an identical body,
 * hardening headers on every public response, the BOQ snapshot is frozen at creation.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreateShareLinkResponseSchema, fsPaths, PublicShareBoqSchema, PublicShareMetaSchema, PublicShareOverlaySchema, storagePaths } from '@kamutan/contracts';
import type { Doc } from '../../src/db/mappers';
import { writeEvidence } from './support/evidence';
import { ROUTES, send } from './support/routes';
import { createWorld, type World } from './support/world';

/** pixels visibly darker than white paper (the burned-in watermark / hatch) */
async function markedPixels(buf: Buffer): Promise<number> {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let i = 0; i < data.length; i += info.channels) if (Math.min(data[i] as number, data[i + 1] as number, data[i + 2] as number) < 225) n++;
  return n;
}

const PUBLIC_PATHS = (sheetId: string) => ['/meta', '/boq', `/sheets/${sheetId}/overlay`, `/sheets/${sheetId}/tiles/0/0/0`, '/pdf'];

describe('Stage 10 API/Sec — E2E-09 external share link', () => {
  let w: World;
  let link: ReturnType<typeof CreateShareLinkResponseSchema.parse>;
  const S = (token: string) => `/api/v1/public/share/${token}`;
  const P = () => `/api/v1/projects/${w.A.projectId}`;
  let ipN = 1;
  const ip = () => ({ 'x-forwarded-for': `203.0.113.${ipN++ % 250}, 198.51.100.${ipN % 250}, 10.0.0.9` });
  const create = async (body: Record<string, unknown> = {}) => {
    const r = await w.http.post(`${P()}/share-links`).set(w.auth(w.A.uid('editor'))).send({ label: 'קבלן חשמל', days: 7, recipient: 'דני קבלן', ...body });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return CreateShareLinkResponseSchema.parse(r.body);
  };
  const evidence: Record<string, unknown> = {};

  beforeAll(async () => {
    w = await createWorld();
    // Given an APPROVED project: every line draft → reviewed → approved by the reviewer
    for (const id of [w.A.lines.status, w.A.lines.override, w.A.lines.plain]) {
      const url = `${P()}/boq/lines/${id}`;
      expect((await w.http.patch(url).set(w.auth(w.A.uid('reviewer'))).send({ status: 'reviewed' })).status).toBe(200);
      expect((await w.http.patch(url).set(w.auth(w.A.uid('reviewer'))).send({ status: 'approved' })).status).toBe(200);
    }
    // white paper tiles: the overview level (z=0, whole A1 sheet = 155×110 px) and a zoomed tile (z=3, 256×256)
    const white = (wd: number, ht: number) => sharp({ create: { width: wd, height: ht, channels: 3, background: { r: 255, g: 255, b: 255 } } }).webp().toBuffer();
    w.t.govStorage.putTile(storagePaths.tile(w.A.orgId, w.A.projectId, w.A.sheet.sheetId, w.A.sheet.versionId, 0, 0, 0), await white(155, 110));
    w.t.govStorage.putTile(storagePaths.tile(w.A.orgId, w.A.projectId, w.A.sheet.sheetId, w.A.sheet.versionId, 3, 1, 1), await white(256, 256));
    link = await create();
  });
  afterAll(async () => {
    writeEvidence('e2e-09-share.json', evidence);
    await w.t.app.close();
  });

  it('the editor creates a 7-day link: 256-bit token shown once, only its SHA-256 stored, version locked', async () => {
    expect(Buffer.from(link.token, 'base64url')).toHaveLength(32);
    expect(Math.round((Date.parse(link.link.expiresAt) - Date.now()) / 86_400_000)).toBe(7);
    expect(link.link.versionLockBySheet).toEqual({ [w.A.sheet.sheetId]: w.A.sheet.versionId, [w.A.sheet2.sheetId]: w.A.sheet2.versionId });
    const stored = w.t.repo.docs.get(fsPaths.shareLink(w.A.orgId, w.A.projectId, link.link.id)) as Doc;
    expect(stored.tokenHash).toBe(createHash('sha256').update(link.token).digest('hex'));
    expect(JSON.stringify([...w.t.repo.docs.values()])).not.toContain(link.token);
    const list = await w.http.get(`${P()}/share-links`).set(w.auth(w.A.uid('editor')));
    expect(JSON.stringify(list.body)).not.toMatch(/tokenHash|"token"/);
  });

  it('the contractor sees meta, BOQ (approved, effective quantities), overlay with evidence line ids and watermarked tiles — no internal data', async () => {
    const meta = await w.http.get(S(link.token) + '/meta').set(ip());
    expect(meta.status).toBe(200);
    const m = PublicShareMetaSchema.parse(meta.body);
    expect(m.link.watermark).toMatch(/^שותף עם דני קבלן • \d{2}\.\d{2}\.\d{4} • /);
    expect(m.project.address).toBeNull(); // hideTitleBlock (default) hides client details
    const boq = PublicShareBoqSchema.parse((await w.http.get(S(link.token) + '/boq').set(ip())).body);
    expect(boq.lines.length).toBe(4);
    expect(boq.lines.every((l) => l.status === 'approved')).toBe(true);
    expect(JSON.stringify(boq)).not.toMatch(/a_editor|a_reviewer|reasons|overridden|note/);
    const ov = PublicShareOverlaySchema.parse((await w.http.get(S(link.token) + `/sheets/${w.A.sheet.sheetId}/overlay`).set(ip())).body);
    expect(ov.detections.find((d) => d.id === 'd_1')?.lineIds).toEqual([w.A.lines.status]);
    const tile = await w.http.get(S(link.token) + `/sheets/${w.A.sheet.sheetId}/tiles/3/1/1`).set(ip()).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(tile.status).toBe(200);
    expect(tile.headers['content-type']).toBe('image/webp');
    expect(await markedPixels(tile.body as Buffer)).toBeGreaterThan(200); // watermark burned into the white paper
    expect((await w.http.get(S(link.token) + '/pdf').set(ip())).status).toBe(404); // allowPdfDownload=false
    evidence.meta = m;
    evidence.boqCounts = boq.counts;
  });

  it('every write is refused: 405 on every /public path and method, 403 for every member write route carrying the share token', async () => {
    const pub: string[] = [];
    for (const p of PUBLIC_PATHS(w.A.sheet.sheetId)) {
      for (const m of ['post', 'put', 'patch', 'delete'] as const) {
        const r = await w.http[m](S(link.token) + p).set(ip()).send({ status: 'approved' });
        if (r.status !== 405 || r.headers.allow !== 'GET, HEAD' || r.body.error.code !== 'method_not_allowed') pub.push(`${m} ${p}: ${r.status}`);
      }
    }
    expect(pub).toEqual([]);
    const priv: string[] = [];
    const writes = ROUTES.filter((c) => !c.route.startsWith('GET '));
    for (const c of writes) {
      const variants: Array<Record<string, string>> = [{ authorization: `Bearer ${link.token}` }, { 'x-share-token': link.token }];
      for (const h of variants) {
        const r = await send(w.http, c.build(w.A, 'admin'), h);
        if (r.status !== 403) priv.push(`${c.route}${c.variant ? ` [${c.variant}]` : ''} ${Object.keys(h)[0]}: ${r.status}`);
      }
    }
    expect(writes.length).toBeGreaterThan(30);
    expect(priv).toEqual([]);
    // reads of the private API with a share token are simply unauthenticated
    expect((await w.http.get(`${P()}/boq`).set({ authorization: `Bearer ${link.token}` })).status).toBe(401);
    // nothing changed
    expect((w.t.repo.docs.get(fsPaths.boqLine(w.A.orgId, w.A.projectId, w.A.lines.status)) as Doc).status).toBe('approved');
    evidence.writeSweep = { publicChecked: PUBLIC_PATHS('x').length * 4, privateRoutes: writes.length };
  });

  it('hardening headers on every public response (200, 404, 405, 410) and HEAD', async () => {
    const urls = [...PUBLIC_PATHS(w.A.sheet.sheetId).map((p) => S(link.token) + p), S('Z'.repeat(43)) + '/meta', S(link.token) + '/nope'];
    const bad: string[] = [];
    for (const u of urls) {
      for (const r of [await w.http.get(u).set(ip()), await w.http.head(u).set(ip()), await w.http.post(u).set(ip())]) {
        const h = r.headers;
        if (h['x-robots-tag'] !== 'noindex, nofollow' || h['referrer-policy'] !== 'no-referrer' || h['cache-control'] !== 'no-store') bad.push(`${u} ${r.status}: ${JSON.stringify([h['x-robots-tag'], h['referrer-policy'], h['cache-control']])}`);
        if (h['x-content-type-options'] !== 'nosniff' || h['x-frame-options'] !== 'DENY') bad.push(`${u} ${r.status}: nosniff/frame ${h['x-content-type-options']}/${h['x-frame-options']}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('revoke → 410 on every public endpoint immediately (also right after a cached read), with ONE identical body; expiry → the same body', async () => {
    const rev = await create({ label: 'יבוטל' });
    expect((await w.http.get(S(rev.token) + '/meta').set(ip())).status).toBe(200); // warm any cache
    expect((await w.http.delete(`${P()}/share-links/${rev.link.id}`).set(w.auth(w.A.uid('editor')))).status).toBe(200);
    const exp = await create({ label: 'יפוג' });
    const lp = fsPaths.shareLink(w.A.orgId, w.A.projectId, exp.link.id);
    w.t.repo.docs.set(lp, { ...(w.t.repo.docs.get(lp) as Doc), expiresAt: new Date(Date.now() - 1000) });
    const bodies = new Set<string>();
    const statuses: Record<string, number[]> = { revoked: [], expired: [], unknown: [] };
    for (const p of PUBLIC_PATHS(w.A.sheet.sheetId)) {
      for (const [state, token] of [
        ['revoked', rev.token],
        ['expired', exp.token],
        ['unknown', 'Q'.repeat(43)],
      ] as const) {
        const r = await w.http.get(S(token) + p).set(ip());
        statuses[state]?.push(r.status);
        bodies.add(JSON.stringify(r.body));
        if (state !== 'unknown') expect(r.headers['x-share-state'], `${state} ${p}`).toBe(state);
      }
    }
    evidence.revokeExpiry = { statuses, bodies: [...bodies] };
    expect(statuses.revoked).toEqual([410, 410, 410, 410, 410]);
    expect(statuses.expired).toEqual([410, 410, 410, 410, 410]);
    expect(statuses.unknown).toEqual([404, 404, 404, 404, 404]);
    expect([...bodies]).toEqual([JSON.stringify({ error: { code: 'share_unavailable', message: 'share link not available', requestId: null } })]);
  });

  it('the BOQ snapshot is frozen at creation: later overrides, status changes, new and deleted lines are never served', async () => {
    const snap = await create({ label: 'snapshot' });
    const before = (await w.http.get(S(snap.token) + '/boq').set(ip())).body;
    // the office keeps working after sharing
    const url = `${P()}/boq/lines/${w.A.lines.override}`;
    expect((await w.http.patch(url).set(w.auth(w.A.uid('editor'))).send({ qtyOverride: 40, reason: 'סיבה פנימית' })).status).toBe(200);
    w.t.boq.seedLine(w.A.orgId, w.A.projectId, { id: 'ln_a_9_99', code: '9.99', description: 'שורה חדשה', qty: 9, level: 'red', status: 'draft' });
    w.t.repo.docs.delete(fsPaths.boqLine(w.A.orgId, w.A.projectId, w.A.lines.plain));
    const after = (await w.http.get(S(snap.token) + '/boq').set(ip())).body;
    expect(after).toEqual(before);
    const b = PublicShareBoqSchema.parse(after);
    expect(b.snapshotAt).toBe(snap.link.createdAt);
    expect(b.lines.find((l) => l.id === w.A.lines.override)?.qty).toBe(4);
    expect(JSON.stringify(after)).not.toMatch(/9\.99|סיבה פנימית/);
  });

  it.fails('A-API-11: SEC-28 — the overview tile (lowest zoom level, the "fit sheet" view) also carries the watermark', async () => {
    const r = await w.http.get(S(link.token) + `/sheets/${w.A.sheet.sheetId}/tiles/0/0/0`).set(ip()).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(r.status).toBe(200);
    const n = await markedPixels(r.body as Buffer);
    evidence.overviewTileMarkedPixels = n;
    if (process.env.ACCEPTANCE_EVIDENCE_DIR) writeFileSync(`${process.env.ACCEPTANCE_EVIDENCE_DIR}/share-tile-z0.webp`, r.body as Buffer);
    expect(n).toBeGreaterThan(0);
  });

  it.fails('A-API-09: the overlay is frozen with the BOQ — every overlay lineId exists in the link\'s BOQ snapshot after a rebuild', async () => {
    const snap = await create({ label: 'overlay-lock' });
    const lines = PublicShareBoqSchema.parse((await w.http.get(S(snap.token) + '/boq').set(ip())).body).lines.map((l) => l.id);
    // a later build maps the same detection to a new line id (e.g. after a rule change)
    w.t.boqStorage.putEvidence(storagePaths.boqEvidence(w.A.orgId, w.A.projectId, 'b2'), {
      schema: 'kamutan.boq-evidence/1',
      lines: { ln_a_new_rule: [{ sheetId: w.A.sheet.sheetId, versionId: w.A.sheet.versionId, detectionId: 'd_1', linkGroupId: null, floor: '0' }] },
    });
    const pp = fsPaths.project(w.A.orgId, w.A.projectId);
    w.t.repo.docs.set(pp, { ...(w.t.repo.docs.get(pp) as Doc), boq: { latestBuildId: 'b2', builtAt: new Date(), stale: false } });
    try {
      const ov = PublicShareOverlaySchema.parse((await w.http.get(S(snap.token) + `/sheets/${w.A.sheet.sheetId}/overlay`).set(ip())).body);
      const ids = ov.detections.flatMap((d) => d.lineIds);
      evidence.overlayAfterRebuild = { snapshotLines: lines, overlayLineIds: ids };
      expect(ids.every((id) => lines.includes(id))).toBe(true);
    } finally {
      w.t.repo.docs.set(pp, { ...(w.t.repo.docs.get(pp) as Doc), boq: { latestBuildId: 'b1', builtAt: new Date(), stale: false } });
    }
  });

  describe('rate limits (SEC-29) with production-like small limits', () => {
    let w2: World;
    beforeAll(async () => {
      w2 = await createWorld({ SHARE_RATE_LIMIT_PER_MIN: '5', SHARE_UNKNOWN_TOKEN_LIMIT: '3' });
    });
    afterAll(async () => {
      await w2.t.app.close();
    });
    it('per IP + per token → 429 with Retry-After and the public headers; unknown-token guessing → IP lockout', async () => {
      const a = { 'x-forwarded-for': '192.0.2.1, 198.51.100.200, 10.0.0.9' };
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) codes.push((await w2.http.get(S(w2.A.link.token) + '/boq').set(a)).status);
      expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
      const r = await w2.http.get(S(w2.A.link.token) + '/boq').set(a);
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      expect(r.headers['x-robots-tag']).toBe('noindex, nofollow');
      const g = { 'x-forwarded-for': '192.0.2.9, 198.51.100.201, 10.0.0.9' };
      for (let i = 0; i < 3; i++) expect((await w2.http.get(S(`${'G'.repeat(42)}${i}`) + '/meta').set(g)).status).toBe(404);
      const locked = await w2.http.get(S(w2.B.link.token) + '/meta').set(g);
      expect(locked.status).toBe(429);
    });
  });
});
