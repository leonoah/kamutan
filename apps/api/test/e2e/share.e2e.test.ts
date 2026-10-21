import { createHash } from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  CreateShareLinkResponseSchema,
  fsPaths,
  MarkedPdfJobSchema,
  PublicShareBoqSchema,
  PublicShareMetaSchema,
  PublicShareOverlaySchema,
  RevokeShareLinkResponseSchema,
  ShareLinkListSchema,
  storagePaths,
} from '@kamutan/contracts';
import type { Doc } from '../../src/db/mappers';
import { createTestApp, type TestApp } from '../support/app';
import { testConfig } from '../support/helpers';
import { det } from '../support/review-fixtures';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function solidTile(w = 256, h = 256, v = 0): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: v, g: v, b: v } } }).webp({ quality: 90 }).toBuffer();
}
async function stats(buf: Buffer) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  let nonBlack = 0;
  let nonWhite = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const l = ((data[i] as number) + (data[i + 1] as number) + (data[i + 2] as number)) / 3;
    sum += l;
    if (l > 30) nonBlack++;
    if (l < 225) nonWhite++;
  }
  return { mean: sum / (data.length / info.channels), nonBlack, nonWhite, width: info.width, height: info.height };
}

describe('Sprint 5 e2e — share links (FR-30, SEC-26–29, E2E-09)', () => {
  let t: TestApp;
  let http: ReturnType<typeof request>;
  const tok: Record<string, string> = {};
  let orgId: string;
  let otherOrg: string;
  let projectId: string;
  let otherProject: string;
  let sheet: { sheetId: string; versionId: string };
  const auth = (who: string) => ({ authorization: `Bearer ${tok[who]}` });
  const P = (p = projectId) => `/api/v1/projects/${p}`;
  const S = (token: string) => `/api/v1/public/share/${token}`;
  let ipN = 10;
  const ip = () => ({ 'x-forwarded-for': `198.51.100.${ipN++}` });
  const audits = (o = orgId) =>
    [...t.repo.docs.entries()]
      .filter(([k]) => k.startsWith(`orgs/${o}/auditLog/`))
      .map(([, v]) => v)
      .sort((a, b) => (a.at as Date).getTime() - (b.at as Date).getTime());
  const create = async (body: Record<string, unknown> = {}, who = 'editor') => {
    const r = await http.post(`${P()}/share-links`).set(auth(who)).send({ label: 'קבלן חשמל', days: 7, ...body });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return CreateShareLinkResponseSchema.parse(r.body);
  };

  beforeAll(async () => {
    t = await createTestApp(testConfig({ THROTTLE_LIMIT: '1000', UPLOAD_THROTTLE_LIMIT: '500', SHARE_RATE_LIMIT_PER_MIN: '1000', SHARE_TILE_RATE_LIMIT_PER_MIN: '1000', PUBLIC_APP_ORIGIN: 'https://app.example.test' }));
    http = request(t.app.getHttpServer());
    for (const who of ['admin', 'editor', 'reviewer', 'viewer', 'outsider']) tok[who] = t.auth.issue(who);
    orgId = t.repo.seedOrg('Org', { admin: 'admin', editor: 'editor', reviewer: 'reviewer', viewer: 'viewer' }).id;
    otherOrg = t.repo.seedOrg('Other', { outsider: 'admin' }).id;
    projectId = (await t.repo.createProject(orgId, { name: 'בית משפחת נח', address: 'רחוב הדקל 5' }, 'editor')).id;
    otherProject = (await t.repo.createProject(otherOrg, { name: 'Q' }, 'outsider')).id;
    // A3 sheet, 300 dpi: 4961 × 3508 px, 6 levels; detections: one in the drawing, one inside the bottom title-block strip
    sheet = t.repo.seedWorkerSheet(orgId, projectId, 'setA', 0, { understanding: true, widthMm: 420, heightMm: 297, widthPx: 4961, heightPx: 3508, levels: 6, title: 'משפחת נח - חשמל' });
    // the worker detected this sheet's title block (bottom strip) → maskable
    const vp0 = fsPaths.version(orgId, projectId, sheet.sheetId, sheet.versionId);
    t.repo.docs.set(vp0, { ...(t.repo.docs.get(vp0) as Doc), titleBlockMm: { x: 0, y: 252, w: 420, h: 45 } });
    t.artifacts.putJson(storagePaths.detections(orgId, projectId, sheet.sheetId, sheet.versionId), {
      schema: 'kamutan.detections/1',
      detections: [det('d_1', 'socket_double', 100, 100, 0.99, 'green'), det('d_tb', 'socket_double', 300, 290, 0.9, 'yellow')],
      unknownClusters: [],
    });
    t.artifacts.putJson(storagePaths.rooms(orgId, projectId, sheet.sheetId, sheet.versionId), { schema: 'kamutan.rooms/1', rooms: [] });
    t.boq.seedLine(orgId, projectId, { id: 'bl_4_01', code: '4.01', description: 'שקע כפול', qty: 2, level: 'green', status: 'approved', note: 'הערה פנימית', qtyOverride: 3, qtyOverrideReason: 'סיבה פנימית', byFloor: { '0': 2 } });
    t.boqStorage.putEvidence(storagePaths.boqEvidence(orgId, projectId, 'b1'), {
      schema: 'kamutan.boq-evidence/1',
      lines: { bl_4_01: [{ sheetId: sheet.sheetId, versionId: sheet.versionId, detectionId: 'd_1', linkGroupId: null, floor: '0' }] },
    });
    const p = t.repo.docs.get(fsPaths.project(orgId, projectId)) as Doc;
    t.repo.docs.set(fsPaths.project(orgId, projectId), { ...p, boq: { latestBuildId: 'b1', builtAt: new Date(), stale: false } });
    for (const [z, x, y] of [
      [5, 0, 0],
      [5, 0, 13],
      [5, 19, 13],
    ] as const) {
      // (0,0): white paper; bottom row: black (inside the title-block strip); edge tiles are smaller
      t.govStorage.putTile(storagePaths.tile(orgId, projectId, sheet.sheetId, sheet.versionId, z, x, y), await solidTile(x === 19 ? 97 : 256, y === 13 ? 180 : 256, y === 0 ? 255 : 0));
    }
  });
  afterAll(async () => {
    await t.app.close();
  });

  // ---------------------------------------------------------------- authenticated management
  describe('create / list / revoke', () => {
    it('editor creates: 256-bit token returned once, only its SHA-256 stored (+ token index), version lock, audit without secrets', async () => {
      const r = await create({ recipient: 'דני קבלן' });
      expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(r.token, 'base64url').length).toBe(32);
      expect(r.url).toBe(`https://app.example.test/s/${r.token}`);
      expect(r.link).not.toHaveProperty('tokenHash');
      expect(r.link).toMatchObject({ label: 'קבלן חשמל', recipient: 'דני קבלן', hideTitleBlock: true, allowPdfDownload: false, state: 'active', viewCount: 0, versionLockBySheet: { [sheet.sheetId]: sheet.versionId }, versionLock: [sheet.versionId], pdfExportId: null, boqLocked: true });
      expect(r.link.sheets).toEqual([{ sheetId: sheet.sheetId, versionId: sheet.versionId, titleBlockMasked: true, included: true }]);
      expect(r.warnings).toEqual([]);
      expect(Date.parse(r.link.expiresAt) - Date.now()).toBeGreaterThan(7 * 86_400_000 - 60_000);
      const doc = t.repo.docs.get(fsPaths.shareLink(orgId, projectId, r.link.id)) as Doc;
      expect(doc.tokenHash).toBe(sha(r.token));
      expect(JSON.stringify([...t.repo.docs.values()])).not.toContain(r.token);
      expect(t.repo.docs.get(fsPaths.shareToken(sha(r.token)))).toMatchObject({ orgId, projectId, linkId: r.link.id });
      const ev = audits().at(-1) as Doc;
      expect(ev).toMatchObject({ entity: 'shareLinks', action: 'create', entityId: r.link.id, actorId: 'editor' });
      expect(JSON.stringify(ev)).not.toContain(r.token);
      expect(JSON.stringify(ev)).not.toContain(sha(r.token));
      expect(JSON.stringify(ev)).not.toContain('דני');
    });

    it('validation: days 1..90 (default 14), label required, strict body', async () => {
      const d = await create({ days: undefined });
      expect(Math.round((Date.parse(d.link.expiresAt) - Date.now()) / 86_400_000)).toBe(14);
      for (const body of [{ label: 'x', days: 0 }, { label: 'x', days: 91 }, { days: 3 }, { label: '' }, { label: 'x', token: 'y' }]) {
        expect((await http.post(`${P()}/share-links`).set(auth('editor')).send(body)).status, JSON.stringify(body)).toBe(400);
      }
    });

    it('roles + isolation: reviewer/viewer 403 on create/list/revoke, outsider and cross-org 404, anon 401', async () => {
      for (const who of ['reviewer', 'viewer']) {
        expect((await http.post(`${P()}/share-links`).set(auth(who)).send({ label: 'x' })).status).toBe(403);
        expect((await http.get(`${P()}/share-links`).set(auth(who))).status).toBe(403);
        expect((await http.delete(`${P()}/share-links/abc`).set(auth(who))).status).toBe(403);
      }
      expect((await http.post(`${P()}/share-links`).set(auth('outsider')).send({ label: 'x' })).status).toBe(404);
      expect((await http.get(`${P()}/share-links`).set(auth('outsider'))).status).toBe(404);
      expect((await http.get(`${P(otherProject)}/share-links`).set(auth('admin'))).status).toBe(404);
      expect((await http.get(`${P()}/share-links`)).status).toBe(401);
    });

    it('list (newest first, no hashes) and immediate, idempotent revoke (one audit event)', async () => {
      const a = await create({ label: 'A' });
      const list = ShareLinkListSchema.parse((await http.get(`${P()}/share-links`).set(auth('editor'))).body);
      expect(list.items[0]?.id).toBe(a.link.id);
      expect(JSON.stringify(list)).not.toContain('tokenHash');
      const n = audits().length;
      const r1 = RevokeShareLinkResponseSchema.parse((await http.delete(`${P()}/share-links/${a.link.id}`).set(auth('editor'))).body);
      expect(r1.link).toMatchObject({ state: 'revoked', revokedBy: 'editor', revokeReason: 'user' });
      const r2 = await http.delete(`${P()}/share-links/${a.link.id}`).set(auth('admin'));
      expect(r2.status).toBe(200);
      expect(audits().length).toBe(n + 1);
      expect(audits().at(-1)).toMatchObject({ entity: 'shareLinks', action: 'revoke', entityId: a.link.id });
      expect((await http.delete(`${P()}/share-links/nope`).set(auth('editor'))).status).toBe(404);
      expect((await http.get(S(a.token) + '/meta').set(ip())).status).toBe(410);
    });
  });

  // ---------------------------------------------------------------- public viewer API
  describe('public read-only API', () => {
    let link: Awaited<ReturnType<typeof create>>;
    beforeAll(async () => {
      link = await create({ recipient: 'דני קבלן' });
    });

    it('every public response: X-Robots-Tag noindex, Referrer-Policy no-referrer, Cache-Control no-store', async () => {
      for (const path of ['/meta', '/boq', '/nope']) {
        const r = await http.get(S(link.token) + path).set(ip());
        expect(r.headers['x-robots-tag']).toBe('noindex, nofollow');
        expect(r.headers['referrer-policy']).toBe('no-referrer');
        expect(r.headers['cache-control']).toBe('no-store');
      }
      const unknown = await http.get(S('A'.repeat(43)) + '/meta').set(ip());
      expect(unknown.headers['x-robots-tag']).toBe('noindex, nofollow');
    });

    it('meta: project name, label, expiry, locked sheets, watermark; NO address when hideTitleBlock; counts views + audits with IP prefix', async () => {
      const r = await http.get(S(link.token) + '/meta').set({ 'x-forwarded-for': '203.0.113.77', 'user-agent': 'ContractorBrowser/1.0' });
      expect(r.status).toBe(200);
      const m = PublicShareMetaSchema.parse(r.body);
      // F-3: hideTitleBlock → neither the project name nor the title-block sheet title (they name the client)
      expect(m.project).toEqual({ name: 'קבלן חשמל', address: null });
      expect(m.sheets[0]).toMatchObject({ title: 'גיליון 1', titleBlockMasked: true });
      expect(JSON.stringify(m)).not.toMatch(/משפחת נח/);
      expect(m.link).toMatchObject({ label: 'קבלן חשמל', recipient: 'דני קבלן', hideTitleBlock: true, allowPdfDownload: false, shortId: link.link.id.slice(0, 6) });
      expect(m.link.watermark).toMatch(new RegExp(`^שותף עם דני קבלן • \\d{2}\\.\\d{2}\\.\\d{4} • ${link.link.id.slice(0, 6)}$`));
      expect(m.sheets).toEqual([expect.objectContaining({ sheetId: sheet.sheetId, versionId: sheet.versionId, tiles: expect.objectContaining({ levels: 6, widthPx: 4961 }) })]);
      expect(m.pdf).toBeNull();
      expect(JSON.stringify(m)).not.toContain('רחוב הדקל');
      const doc = t.repo.docs.get(fsPaths.shareLink(orgId, projectId, link.link.id)) as Doc;
      expect(doc.viewCount).toBe(2); // the headers test above opened /meta once
      expect(doc.lastViewedAt).toBeInstanceOf(Date);
      const ev = audits().at(-1) as Doc;
      expect(ev).toMatchObject({ entity: 'shareLinks', action: 'view', actorKind: 'share_link', actorId: link.link.id });
      expect(ev.after).toMatchObject({ linkId: link.link.id, endpoint: 'meta', ipPrefix: '203.0.113.0/24', userAgent: 'ContractorBrowser/1.0' });
      expect(JSON.stringify(ev)).not.toContain('203.0.113.77');
      // address shown when the title block is NOT hidden
      const open = await create({ hideTitleBlock: false });
      const om = PublicShareMetaSchema.parse((await http.get(S(open.token) + '/meta').set(ip())).body);
      expect(om.project).toEqual({ name: 'בית משפחת נח', address: 'רחוב הדקל 5' });
      expect(om.sheets[0]).toMatchObject({ title: 'משפחת נח - חשמל', titleBlockMasked: false });
    });

    it('boq: lines with effective qty, levels, statuses, byFloor — never notes, override reasons or user ids', async () => {
      const r = await http.get(S(link.token) + '/boq').set(ip());
      expect(r.status).toBe(200);
      const b = PublicShareBoqSchema.parse(r.body);
      expect(b.lines).toEqual([{ id: 'bl_4_01', chapter: '04', code: '4.01', description: 'שקע כפול', unit: 'יחידה', qty: 3, level: 'green', status: 'approved', floor: null, byFloor: { '0': 2 } }]);
      expect(b.snapshotAt).toBe(link.link.createdAt);
      // F-4: no reasons / override marker for external viewers
      expect(r.body.lines[0]).not.toHaveProperty('reasons');
      expect(r.body.lines[0]).not.toHaveProperty('overridden');
      expect(b.counts).toMatchObject({ lines: 1, green: 1, approved: 1 });
      const s = JSON.stringify(b);
      expect(s).not.toContain('הערה פנימית');
      expect(s).not.toContain('סיבה פנימית');
      expect(s).not.toContain('editor');
    });

    it('overlay of the LOCKED version: line ids from the build evidence, title-block items dropped, mask reported', async () => {
      const o = PublicShareOverlaySchema.parse((await http.get(S(link.token) + `/sheets/${sheet.sheetId}/overlay`).set(ip())).body);
      expect(o.versionId).toBe(sheet.versionId);
      expect(o.detections.map((d) => [d.id, d.lineIds])).toEqual([['d_1', ['bl_4_01']]]);
      expect(o.maskMm).toEqual({ x: 0, y: 252, w: 420, h: 45 });
      expect((await http.get(S(link.token) + '/sheets/nope/overlay').set(ip())).status).toBe(404);
    });

    it('tiles: proxied WebP with the watermark burned in and the title block masked; outside the grid 404', async () => {
      const orig = await stats(await solidTile(256, 256, 255));
      expect(orig.nonWhite).toBe(0);
      const r = await http.get(S(link.token) + `/sheets/${sheet.sheetId}/tiles/5/0/0`).set(ip()).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe('image/webp');
      expect(r.headers['cache-control']).toBe('no-store');
      const top = await stats(r.body as Buffer);
      expect(top.width).toBe(256);
      expect(top.nonWhite).toBeGreaterThan(200); // watermark pixels burned into white paper
      expect(top.mean).toBeGreaterThan(200); // …but it is still the (white) drawing
      const bottom = await http.get(S(link.token) + `/sheets/${sheet.sheetId}/tiles/5/0/13`).set(ip()).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      const masked = await stats(bottom.body as Buffer);
      expect(masked.height).toBe(180);
      expect(masked.mean).toBeGreaterThan(200); // the title-block strip is painted over
      for (const p of ['/tiles/6/0/0', '/tiles/5/20/0', '/tiles/5/0/14', '/tiles/a/0/0', '/tiles/5/1/1']) {
        expect((await http.get(S(link.token) + `/sheets/${sheet.sheetId}${p}`).set(ip())).status, p).toBe(404);
      }
    });

    it('version lock: a reprocessed sheet keeps serving the locked version; a sheet added later is not visible', async () => {
      const sp = fsPaths.sheet(orgId, projectId, sheet.sheetId);
      const newV = 'vNEW000000000000000';
      t.repo.docs.set(fsPaths.version(orgId, projectId, sheet.sheetId, newV), { ...(t.repo.docs.get(fsPaths.version(orgId, projectId, sheet.sheetId, sheet.versionId)) as Doc) });
      t.repo.docs.set(sp, { ...(t.repo.docs.get(sp) as Doc), currentVersionId: newV });
      const later = t.repo.seedWorkerSheet(orgId, projectId, 'setB', 0, { understanding: true });
      const m = PublicShareMetaSchema.parse((await http.get(S(link.token) + '/meta').set(ip())).body);
      expect(m.sheets.map((s) => [s.sheetId, s.versionId])).toEqual([[sheet.sheetId, sheet.versionId]]);
      expect((await http.get(S(link.token) + `/sheets/${later.sheetId}/overlay`).set(ip())).status).toBe(404);
      expect((await http.get(S(link.token) + `/sheets/${later.sheetId}/tiles/0/0/0`).set(ip())).status).toBe(404);
      t.repo.docs.set(sp, { ...(t.repo.docs.get(sp) as Doc), currentVersionId: sheet.versionId });
      t.repo.docs.delete(fsPaths.sheet(orgId, projectId, later.sheetId));
    });

    it('unknown → 404, expired / revoked → 410 with the SAME body (only status + x-share-state differ)', async () => {
      const unknown = await http.get(S('B'.repeat(43)) + '/meta').set(ip());
      const malformed = await http.get(S('short') + '/meta').set(ip());
      const exp = await create({ label: 'old' });
      const lp = fsPaths.shareLink(orgId, projectId, exp.link.id);
      t.repo.docs.set(lp, { ...(t.repo.docs.get(lp) as Doc), expiresAt: new Date(Date.now() - 1000) });
      const expired = await http.get(S(exp.token) + '/boq').set(ip());
      const rev = await create({ label: 'rev' });
      await http.delete(`${P()}/share-links/${rev.link.id}`).set(auth('editor'));
      const revoked = await http.get(S(rev.token) + '/meta').set(ip());
      expect([unknown.status, malformed.status, expired.status, revoked.status]).toEqual([404, 404, 410, 410]);
      expect(ApiErrorSchema.parse(unknown.body)).toEqual({ error: { code: 'share_unavailable', message: 'share link not available', requestId: null } });
      for (const r of [malformed, expired, revoked]) expect(r.body).toEqual(unknown.body);
      expect(expired.headers['x-share-state']).toBe('expired');
      expect(revoked.headers['x-share-state']).toBe('revoked');
      expect(unknown.headers['x-share-state']).toBeUndefined();
    });

    it('405 for every non-GET under /public; a write carrying a share token on the private API → 403 (E2E-09)', async () => {
      for (const m of ['post', 'put', 'patch', 'delete'] as const) {
        const r = await http[m](S(link.token) + '/boq').set(ip()).send({});
        expect(r.status, m).toBe(405);
        expect(r.headers.allow).toBe('GET, HEAD');
        expect(r.body.error.code).toBe('method_not_allowed');
      }
      expect((await http.post(S(link.token) + '/sheets/x/tiles/0/0/0').set(ip())).status).toBe(405);
      const edit = await http.patch(`${P()}/boq/lines/bl_4_01`).set({ authorization: `Bearer ${link.token}` }).send({ status: 'reviewed' });
      expect(edit.status).toBe(403);
      expect((await http.post(`${P()}/share-links`).set({ 'x-share-token': link.token }).send({ label: 'x' })).status).toBe(403);
      // reading the private API with a share token is simply unauthenticated
      expect((await http.get(`${P()}/boq`).set({ authorization: `Bearer ${link.token}` })).status).toBe(401);
      expect((t.repo.docs.get(fsPaths.boqLine(orgId, projectId, 'bl_4_01')) as Doc).status).toBe('approved');
    });

    it('pdf: 404 when not allowed; per-link watermarked job on create; 409 while pending; 302 to a short signed URL when ready', async () => {
      expect((await http.get(S(link.token) + '/pdf').set(ip())).status).toBe(404);
      const before = t.queue.messages.length;
      const withPdf = await create({ allowPdfDownload: true, hideTitleBlock: true, recipient: 'קבלן' });
      expect(withPdf.link.pdfExportId).toBeTruthy();
      expect(t.queue.messages.length).toBe(before + 1);
      const job = MarkedPdfJobSchema.parse(t.queue.messages.at(-1)?.data);
      expect(job).toMatchObject({ exportId: withPdf.link.pdfExportId, versionIds: { [sheet.sheetId]: sheet.versionId }, sheetIds: [sheet.sheetId], options: { hideTitleBlock: true, watermark: expect.stringContaining('שותף עם קבלן') } });
      expect(t.repo.docs.get(fsPaths.boqExport(orgId, projectId, withPdf.link.pdfExportId as string))).toMatchObject({ shareLinkId: withPdf.link.id, kind: 'marked_pdf' });
      expect(PublicShareMetaSchema.parse((await http.get(S(withPdf.token) + '/meta').set(ip())).body).pdf).toEqual({ status: 'queued', errorCode: null });
      expect((await http.get(S(withPdf.token) + '/pdf').set(ip())).status).toBe(409);
      const ep = fsPaths.boqExport(orgId, projectId, withPdf.link.pdfExportId as string);
      // worker finished but could not confirm the mask → still refused (fail closed, F-3)
      t.repo.docs.set(ep, { ...(t.repo.docs.get(ep) as Doc), status: 'ready', titleBlockMasked: false, titleBlockBySheet: { [sheet.sheetId]: false } });
      expect((await http.get(S(withPdf.token) + '/pdf').set(ip()).redirects(0)).status).toBe(404);
      t.repo.docs.set(ep, { ...(t.repo.docs.get(ep) as Doc), status: 'ready', titleBlockMasked: true, titleBlockBySheet: { [sheet.sheetId]: true } });
      const r = await http.get(S(withPdf.token) + '/pdf').set(ip()).redirects(0);
      expect(r.status).toBe(302);
      expect(r.headers.location).toContain(encodeURI(storagePaths.markedPdf(orgId, projectId, withPdf.link.pdfExportId as string)));
      expect(r.headers.location).toContain('X-Goog-Expires=120');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
    });
  });

  // ---------------------------------------------------------------- rate limits (own app: small limits)
  describe('rate limits', () => {
    let t2: TestApp;
    let h2: ReturnType<typeof request>;
    let token: string;
    beforeAll(async () => {
      t2 = await createTestApp(testConfig({ THROTTLE_LIMIT: '1000', UPLOAD_THROTTLE_LIMIT: '500', SHARE_RATE_LIMIT_PER_MIN: '12', SHARE_TILE_RATE_LIMIT_PER_MIN: '20', SHARE_UNKNOWN_TOKEN_LIMIT: '10' }));
      h2 = request(t2.app.getHttpServer());
      const editor = t2.auth.issue('editor');
      const o = t2.repo.seedOrg('O', { editor: 'editor' }).id;
      const p = (await t2.repo.createProject(o, { name: 'p' }, 'editor')).id;
      const r = await h2.post(`/api/v1/projects/${p}/share-links`).set({ authorization: `Bearer ${editor}` }).send({ label: 'x' });
      token = CreateShareLinkResponseSchema.parse(r.body).token;
    });
    afterAll(async () => {
      await t2.app.close();
    });

    it('per IP and per token: the (N+1)th request in a minute → 429 with Retry-After', async () => {
      const a = { 'x-forwarded-for': '192.0.2.1' };
      for (let i = 0; i < 12; i++) expect((await h2.get(S(token) + '/boq').set(a)).status).toBe(200);
      const r = await h2.get(S(token) + '/boq').set(a);
      expect(r.status).toBe(429);
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      expect(r.headers['x-robots-tag']).toBe('noindex, nofollow');
      // per token: other IPs share the token's budget (already spent → the token is exhausted)
      expect((await h2.get(S(token) + '/boq').set({ 'x-forwarded-for': '192.0.2.2' })).status).toBe(429);
    });

    it('10 unknown tokens from one IP → that IP gets 429 for every share request (even with a valid token)', async () => {
      const bad = { 'x-forwarded-for': '192.0.2.50' };
      for (let i = 0; i < 10; i++) {
        const r = await h2.get(S(`${'C'.repeat(40)}${String(i).padStart(3, '0')}`) + '/meta').set(bad);
        expect(r.status).toBe(404);
      }
      const locked = await h2.get(S(token) + '/meta').set(bad);
      expect(locked.status).toBe(429);
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(14 * 60 - 5);
      // another IP is unaffected by the lockout (fresh IP budget; the token budget is a separate bucket for tiles)
      expect((await h2.get(S('D'.repeat(43)) + '/meta').set({ 'x-forwarded-for': '192.0.2.60' })).status).toBe(404);
    });
  });
});
