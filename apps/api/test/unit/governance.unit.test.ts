import { fsPaths } from '@kamutan/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessService } from '../../src/access/access.service';
import { auditHash } from '../../src/db/audit-chain';
import { auditBody, ipPrefix, settingsDiff, toAuditEvent } from '../../src/db/governance-docs';
import type { StoredAuditEvent } from '../../src/db/governance-repository';
import { InMemoryRepository } from '../../src/db/in-memory.repository';
import type { Doc } from '../../src/db/mappers';
import { AuditService, historyItemsOf, verifyChain } from '../../src/governance/audit.service';
import { ExportsService } from '../../src/governance/exports.service';
import { OffboardingService } from '../../src/governance/offboarding.service';
import { PublicShareService } from '../../src/share/public-share.service';
import { linkState, ShareLinksService } from '../../src/share/share-links.service';
import { ShareRateLimiter } from '../../src/share/share-rate-limit';
import { cleanWatermarkText, maskToTile, TileWatermarker, watermarkText } from '../../src/share/watermark';
import { createTestApp, type TestApp } from '../support/app';
import { user } from '../support/fake-verifier';
import { testConfig } from '../support/helpers';

function chainOf(n: number): { repo: InMemoryRepository; orgId: string; stored: () => StoredAuditEvent[] } {
  const repo = new InMemoryRepository();
  const orgId = repo.seedOrg('O').id;
  for (let i = 0; i < n; i++) repo.appendAuditSync(orgId, { actorId: 'u', entity: 'boqLines', entityId: `l${i}`, action: 'update', after: { i, nested: { a: [1, 2] } } });
  const stored = () => repo.children(`orgs/${orgId}/auditLog`).map(([k, d]) => ({ event: toAuditEvent(k.split('/').at(-1) as string, d), body: auditBody(d) }));
  return { repo, orgId, stored };
}

describe('audit chain verification (follows prevHash links)', () => {
  it('ok for an intact chain in any storage order; empty log ok', () => {
    const { stored } = chainOf(6);
    const shuffled = [...stored()].reverse();
    expect(verifyChain(shuffled)).toMatchObject({ ok: true, checked: 6, brokenAt: null });
    expect(verifyChain([])).toEqual({ ok: true, checked: 0, brokenAt: null, headHash: null });
  });

  it('tamper → brokenAt = that event; deletion → the orphaned successor; fork / second genesis detected', () => {
    const { repo, orgId, stored } = chainOf(5);
    const s = stored().sort((a, b) => a.event.at.localeCompare(b.event.at));
    const victim = s[2] as StoredAuditEvent;
    const path = fsPaths.auditEvent(orgId, victim.event.id);
    const orig = repo.docs.get(path) as Doc;
    repo.docs.set(path, { ...orig, entityId: 'other' });
    expect(verifyChain(stored())).toMatchObject({ ok: false, brokenAt: victim.event.id });
    repo.docs.delete(path);
    expect(verifyChain(stored())).toMatchObject({ ok: false, brokenAt: (s[3] as StoredAuditEvent).event.id });
    repo.docs.set(path, orig);
    // re-hashed forgery that claims an existing predecessor (a fork)
    const body = { actorId: 'x', actorKind: 'user', entity: 'orgs', entityId: null, action: 'forge', after: null, at: new Date(Date.parse(victim.event.at) + 1).toISOString() };
    repo.docs.set(fsPaths.auditEvent(orgId, 'forgedXXXXXXXXXXXXXX'), { ...body, at: new Date(body.at), prevHash: victim.event.prevHash, hash: auditHash(victim.event.prevHash, body) });
    expect(verifyChain(stored()).ok).toBe(false);
    repo.docs.delete(fsPaths.auditEvent(orgId, 'forgedXXXXXXXXXXXXXX'));
    // a second genesis
    const g = { ...body, action: 'genesis' };
    repo.docs.set(fsPaths.auditEvent(orgId, 'genesisXXXXXXXXXXXXX'), { ...g, at: new Date(g.at), prevHash: null, hash: auditHash(null, g) });
    expect(verifyChain(stored()).ok).toBe(false);
  });

  it('Firestore Timestamps in a stored payload hash exactly like the Dates that were written', () => {
    const d = new Date('2026-10-15T10:00:00.123Z');
    const written = { actorId: 'u', actorKind: 'user', entity: 'e', entityId: null, action: 'a', after: { when: d }, at: d.toISOString() };
    const hash = auditHash(null, written);
    const ts = { toDate: () => new Date(d) };
    const stored = { ...written, after: { when: ts }, at: ts, prevHash: null, hash };
    expect(auditHash(null, auditBody(stored))).toBe(hash);
  });

  it('in-memory head doc tracks the newest hash + count', () => {
    const { repo, orgId, stored } = chainOf(3);
    const head = repo.docs.get(fsPaths.auditHead(orgId)) as Doc;
    expect(head.count).toBe(3);
    expect(head.hash).toBe(verifyChain(stored()).headHash);
  });
});

describe('line history mapping', () => {
  const by = (uid: string | null) => (uid ? { uid, displayName: null } : null);
  const ev = (after: Record<string, unknown>, action = 'update', actorKind = 'user') => ({ id: 'e', actorId: 'u1', actorKind, entity: 'boqLines', entityId: 'l', action, after, at: '2026-10-15T10:00:00.000Z', prevHash: null, hash: 'a'.repeat(64) });
  it('status / override (+ reason) / note from one PATCH event; rebuild events; system actor → by null', () => {
    const items = historyItemsOf(ev({ from: 'approved', to: 'reviewed', qty: 2, prevQtyOverride: null, qtyOverride: 3, reason: 'מדידה', noteChanged: true }), by);
    expect(items.map((i) => [i.action, i.before, i.after, i.reason])).toEqual([
      ['status', 'approved', 'reviewed', null],
      ['qtyOverride', null, 3, 'מדידה'],
      ['note', null, null, null],
    ]);
    expect(historyItemsOf(ev({ from: 4, to: 5 }, 'rebuild', 'system'), by)).toEqual([{ at: '2026-10-15T10:00:00.000Z', by: null, action: 'rebuild', before: 4, after: 5, reason: null }]);
    expect(historyItemsOf(ev({}, 'create'), by)).toEqual([]);
  });
});

describe('share helpers', () => {
  it('ipPrefix: /24 for IPv4 (incl. mapped), /48 for IPv6', () => {
    expect(ipPrefix('203.0.113.77')).toBe('203.0.113.0/24');
    expect(ipPrefix('::ffff:10.1.2.3')).toBe('10.1.2.0/24');
    expect(ipPrefix('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48');
    expect(ipPrefix('2001:db8::1')).toBe('2001:db8:0::/48');
    expect(ipPrefix(undefined)).toBe('unknown');
    expect(ipPrefix('garbage')).toBe('unknown');
  });

  it('linkState: revoked > expired > active', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(linkState({ revokedAt: null, expiresAt: future })).toBe('active');
    expect(linkState({ revokedAt: null, expiresAt: new Date(Date.now() - 1).toISOString() })).toBe('expired');
    expect(linkState({ revokedAt: new Date().toISOString(), expiresAt: future })).toBe('revoked');
  });

  it('watermark text: brief format; control / bidi-override characters stripped', () => {
    expect(watermarkText('דני', new Date('2026-10-05T09:00:00Z'), 'Ab12Cd')).toBe('שותף עם דני • 05.10.2026 • Ab12Cd');
    expect(cleanWatermarkText('a‮b\u0007c\n d')).toBe('a b c d');
    expect(watermarkText('x'.repeat(500), new Date(), 'id').length).toBeLessThanOrEqual(160);
  });

  it('maskToTile: paper mm → tile-local px for a level', () => {
    expect(maskToTile({ x: 0, y: 252, w: 420, h: 45 }, 0.5, 1, 2, 256)).toEqual({ x: -256, y: -8, w: 840, h: 90 });
  });

  it('TileWatermarker survives markup characters in user text and returns a WebP of the same size', async () => {
    const sharp = (await import('sharp')).default;
    const tile = await sharp({ create: { width: 200, height: 120, channels: 3, background: '#ffffff' } }).webp().toBuffer();
    const out = await new TileWatermarker(null).apply(tile, { text: '<b>&"\' קבלן', origin: { x: 1000, y: 3000 }, masks: [{ x: -5, y: 100, w: 500, h: 50 }] });
    const meta = await sharp(out).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 200, 120]);
  });

  it('ShareRateLimiter: fixed windows per key, unknown-token lockout for lockoutMs', () => {
    let now = 0;
    const l = new ShareRateLimiter({ perMinute: 3, tilePerMinute: 5, unknownPerMinute: 3, lockoutMs: 900_000 }, () => now);
    expect([1, 2, 3, 4].map(() => l.ip('a', false).ok)).toEqual([true, true, true, false]);
    expect(l.ip('a', true).ok).toBe(true); // separate tile bucket
    expect(l.ip('b', false).ok).toBe(true);
    now = 60_000;
    expect(l.ip('a', false).ok).toBe(true);
    l.unknown('x');
    l.unknown('x');
    expect(l.locked('x').ok).toBe(true);
    l.unknown('x');
    const locked = l.locked('x');
    expect(locked).toEqual({ ok: false, retryAfterSec: 900 });
    now += 900_001;
    expect(l.locked('x').ok).toBe(true);
  });

  it('settingsDiff only lists real changes', () => {
    expect(settingsDiff({ llmEnabled: false, greenThreshold: 0.98 }, { llmEnabled: false, greenThreshold: 0.99 })).toEqual({ greenThreshold: { from: 0.98, to: 0.99 } });
  });
});

describe('AccessService.requireRecentAuth', () => {
  const svc = new AccessService(new InMemoryRepository());
  it('accepts auth_time within the window, rejects stale / missing / future', () => {
    const now = 1_800_000_000_000;
    expect(() => svc.requireRecentAuth(user('u', { authTime: now / 1000 - 599 }), 600, now)).not.toThrow();
    expect(() => svc.requireRecentAuth(user('u', { authTime: now / 1000 - 601 }), 600, now)).toThrow(/sign in again/);
    expect(() => svc.requireRecentAuth(user('u', { authTime: now / 1000 + 3600 }), 600, now)).toThrow();
    const noClaim = user('u');
    delete (noClaim.claims as Record<string, unknown>).auth_time;
    expect(() => svc.requireRecentAuth(noClaim, 600, now)).toThrow();
  });
});

/** Every Sprint 5 service, called directly (no guards): another org's admin gets 404, never data (SEC-09). */
describe('service-level isolation (no guards)', () => {
  let t: TestApp;
  let orgA: string;
  let projectA: string;
  const bAdmin = user('bAdmin', { mfa: true });
  const aEditor = user('aEditor', { mfa: true });
  const aReviewer = user('aReviewer');
  beforeAll(async () => {
    t = await createTestApp(testConfig());
    orgA = t.repo.seedOrg('A', { aAdmin: 'admin', aEditor: 'editor', aReviewer: 'reviewer' }).id;
    t.repo.seedOrg('B', { bAdmin: 'admin' });
    projectA = (await t.repo.createProject(orgA, { name: 'pa' }, 'aEditor')).id;
    t.boq.seedLine(orgA, projectA, { id: 'l1', code: '4.01' });
  });
  afterAll(async () => {
    await t.app.close();
  });

  const expect404 = async (p: Promise<unknown>) => {
    await expect(p).rejects.toMatchObject({ code: 'not_found' });
  };

  it('B admin → 404 on every A resource; A roles enforced inside the org', async () => {
    const audit = t.app.get(AuditService);
    const exportsSvc = t.app.get(ExportsService);
    const shares = t.app.get(ShareLinksService);
    const off = t.app.get(OffboardingService);
    await expect404(audit.list(bAdmin, orgA, { limit: 10 }));
    await expect404(audit.verify(bAdmin, orgA));
    await expect404(audit.lineHistory(bAdmin, projectA, 'l1'));
    await expect404(exportsSvc.createMarkedPdf(bAdmin, projectA, { sheetIds: null, options: {} }, 'tp'));
    await expect404(exportsSvc.get(bAdmin, projectA, 'x'));
    await expect404(shares.create(bAdmin, projectA, { days: 1, label: 'x', hideTitleBlock: true, allowPdfDownload: false, includeUnmaskedSheets: false }, 'tp'));
    await expect404(shares.list(bAdmin, projectA));
    await expect404(shares.revoke(bAdmin, projectA, 'x'));
    await expect404(off.patchSettings(bAdmin, orgA, { llmEnabled: true }));
    await expect404(off.requestExport(bAdmin, orgA, { includeSources: true }, 'tp'));
    await expect404(off.getExport(bAdmin, orgA, 'x'));
    await expect404(off.offboard(bAdmin, orgA, { confirm: 'A' }));
    // inside A: editor is not admin, reviewer cannot share or export
    await expect(audit.list(aEditor, orgA, { limit: 10 })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(off.patchSettings(aEditor, orgA, { llmEnabled: true })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(shares.create(aReviewer, projectA, { days: 1, label: 'x', hideTitleBlock: true, allowPdfDownload: false, includeUnmaskedSheets: false }, 'tp')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(exportsSvc.createMarkedPdf(aReviewer, projectA, { sheetIds: null, options: {} }, 'tp')).rejects.toMatchObject({ code: 'forbidden' });
    expect((await audit.lineHistory(aReviewer, projectA, 'l1')).items).toEqual([]);
    expect(t.app.get(PublicShareService)).toBeDefined();
  });
});

describe('R-A1: share tokens never reach the request log', () => {
  it('logPath redacts the token segment and drops the query', async () => {
    const { logPath } = await import('../../src/common/logging');
    expect(logPath('/api/v1/public/share/abcDEF_-123/sheets/s/tiles/1/2/3?x=1')).toBe('/api/v1/public/share/<redacted>/sheets/s/tiles/1/2/3');
    expect(logPath('/api/v1/projects/p1/boq?cursor=a')).toBe('/api/v1/projects/p1/boq');
    expect(logPath(undefined)).toBeUndefined();
  });

  it('pino-http with the app config writes no token (real request through express)', async () => {
    const { Writable } = await import('node:stream');
    const express = (await import('express')).default;
    const pinoHttp = (await import('pino-http')).default;
    const pino = (await import('pino')).default;
    const supertest = (await import('supertest')).default;
    const { loggerParams } = await import('../../src/common/logging');
    let out = '';
    const sink = new Writable({ write: (c, _e, cb) => ((out += String(c)), cb()) });
    const params = loggerParams(testConfig({ LOG_LEVEL: 'info' })).pinoHttp as Record<string, unknown>;
    const app = express();
    app.use(pinoHttp({ ...params, logger: pino({ level: 'info' }, sink) } as never));
    app.get('/{*splat}', (_req, res) => void res.status(404).json({}));
    const token = 'T0kenT0kenT0kenT0kenT0kenT0kenT0kenT0ken123';
    await supertest(app).get(`/api/v1/public/share/${token}/meta?x=${token}`);
    expect(out).toContain('/api/v1/public/share/<redacted>/meta');
    expect(out).not.toContain(token);
  });
});

describe('R-A7: offboarding MFA cannot be disabled in production', () => {
  it('config refuses OFFBOARDING_REQUIRE_MFA=false in production only', async () => {
    const { loadConfig } = await import('../../src/config/config');
    const base = { UPLOAD_TOKEN_SECRET: 'x'.repeat(48), NODE_ENV: 'production' };
    expect(() => loadConfig({ ...base, OFFBOARDING_REQUIRE_MFA: 'false' })).toThrow(/OFFBOARDING_REQUIRE_MFA/);
    expect(loadConfig(base).OFFBOARDING_REQUIRE_MFA).toBe(true);
    expect(loadConfig({ ...base, NODE_ENV: 'test', OFFBOARDING_REQUIRE_MFA: 'false', DATA_DRIVER: 'memory', STORAGE_DRIVER: 'memory', QUEUE_DRIVER: 'memory' }).OFFBOARDING_REQUIRE_MFA).toBe(false);
  });
});

describe('worker-written fields (Worker-Export / ingest)', () => {
  it('version titleBlock {bboxMm:[x0,y0,x1,y1]} → titleBlockMm; export startedAt + "succeeded" → ready', async () => {
    const { toVersion } = await import('../../src/db/mappers');
    const { toExportRecord } = await import('../../src/db/governance-docs');
    const v = toVersion('s', 'v', { status: 'ready', titleBlock: { bboxMm: [300, 260, 420, 297] }, artifacts: {}, regions: [] });
    expect(v.titleBlockMm).toEqual({ x: 300, y: 260, w: 120, h: 37 });
    expect(toVersion('s', 'v', { status: 'ready', titleBlock: { bboxMm: [1, 2] } }).titleBlockMm).toBeNull();
    const at = new Date('2026-10-20T10:00:00Z');
    expect(toExportRecord('e', { kind: 'marked_pdf', status: 'succeeded', startedAt: at, sizeBytes: 9, versionIds: { s1: 'v1' }, createdBy: 'u', createdAt: at })).toMatchObject({ status: 'ready', startedAt: at.toISOString(), sizeBytes: 9, versionIds: { s1: 'v1' } });
  });
});
