/**
 * Stage 10 — API/Sec: upload input validation and limits (SEC-13/14/15/16, SEC-42).
 * Drawing uploads (POST uploads → client PUT to quarantine → POST sheet-sets) and past-BOQ library imports:
 * size, type (extension + magic bytes), filename sanitising, upload-token binding, rate limits, body-size limit.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiErrorSchema, CreateLibraryImportResponseSchema, CreateUploadResponseSchema, FinalizeUploadResponseSchema, fsPaths, MAX_UPLOAD_BYTES, SheetSetStatusResponseSchema, storagePaths } from '@kamutan/contracts';
import { UploadTokenSigner } from '../../src/uploads/upload-token';
import { SAMPLE, UPLOAD_SECRET } from '../support/helpers';
import { xlsxBytes } from '../support/spreadsheets';
import { writeEvidence } from './support/evidence';
import { createWorld, type World } from './support/world';

describe('Stage 10 API/Sec — uploads: size, type, magic bytes, filename, token, limits', () => {
  let w: World;
  const P = () => `/api/v1/projects/${w.A.projectId}`;
  const ed = () => w.auth(w.A.uid('editor'));
  const ev: Record<string, unknown> = {};
  const reserve = async (filename: string, sizeBytes = 1000, who = ed()) => {
    const r = await w.http.post(`${P()}/uploads`).set(who).send({ filename, sizeBytes });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return CreateUploadResponseSchema.parse(r.body);
  };
  /** reserve → "client upload" of `bytes` into quarantine → finalize */
  const upload = async (filename: string, bytes: Buffer) => {
    const up = await reserve(filename, Math.min(MAX_UPLOAD_BYTES, Math.max(1, bytes.length)));
    w.t.storage.objects.set(up.storagePath, { data: bytes, contentType: up.contentType });
    const r = await w.http.post(`${P()}/sheet-sets`).set(ed()).send({ uploadToken: up.uploadToken });
    return { up, r, quarantined: w.t.storage.objects.has(up.storagePath) };
  };

  beforeAll(async () => {
    w = await createWorld();
  });
  afterAll(async () => {
    writeEvidence('uploads.json', ev);
    await w.t.app.close();
  });

  it('reserve: only pdf / dwg / dxf / png by extension (case-insensitive); everything else 400', async () => {
    for (const f of ['a.pdf', 'B.PDF', 'c.dwg', 'd.DXF', 'e.png', 'שרטוט חשמל קומה א.pdf', 'x.exe.pdf']) expect((await w.http.post(`${P()}/uploads`).set(ed()).send({ filename: f, sizeBytes: 10 })).status, f).toBe(201);
    const bad = ['a.exe', 'a.pdf.exe', 'a.svg', 'a.html', 'a.zip', 'a', '.pdf.', 'a.pdf\u0000.exe', '', 'x'.repeat(252) + '.pdfx', 'y'.repeat(260) + '.pdf'];
    const codes = [];
    for (const f of bad) codes.push([f.slice(0, 20), (await w.http.post(`${P()}/uploads`).set(ed()).send({ filename: f, sizeBytes: 10 })).status]);
    ev.badNames = codes;
    expect(codes.every(([, s]) => s === 400)).toBe(true);
  });

  it('reserve: declared size 1 B … 100 MB (integer); 0 / negative / fractional / > 100 MB / missing → 400; strict body', async () => {
    expect((await w.http.post(`${P()}/uploads`).set(ed()).send({ filename: 'a.pdf', sizeBytes: MAX_UPLOAD_BYTES })).status).toBe(201);
    for (const sizeBytes of [0, -1, 1.5, MAX_UPLOAD_BYTES + 1, '100', null, undefined]) expect((await w.http.post(`${P()}/uploads`).set(ed()).send({ filename: 'a.pdf', sizeBytes })).status, String(sizeBytes)).toBe(400);
    expect((await w.http.post(`${P()}/uploads`).set(ed()).send({ filename: 'a.pdf', sizeBytes: 10, storagePath: 'orgs/x' })).status).toBe(400);
  });

  it('quarantine target: orgs/{org}/quarantine/{uuid} — never the user filename, never another org', async () => {
    const up = await reserve('../../orgs/other/projects/x/../../evil.pdf');
    expect(up.storagePath).toMatch(new RegExp(`^orgs/${w.A.orgId}/quarantine/[0-9a-f-]{36}$`));
    expect(up.storagePath).not.toMatch(/evil|\.\./);
    expect(up).toMatchObject({ contentType: 'application/pdf', fileKind: 'pdf', maxBytes: MAX_UPLOAD_BYTES });
  });

  it('finalize: magic bytes decide — every allowed kind passes; content that does not match its extension → 415 and the object is deleted', async () => {
    for (const [f, b] of [
      ['ok.pdf', SAMPLE.pdf],
      ['ok.png', SAMPLE.png],
      ['ok.dxf', SAMPLE.dxf],
      ['ok.dwg', SAMPLE.dwg],
    ] as const) {
      const { r } = await upload(f, b);
      expect(r.status, f).toBe(201);
    }
    const cases: Array<[string, Buffer]> = [
      ['png-as.pdf', SAMPLE.png],
      ['pdf-as.png', SAMPLE.pdf],
      ['html.png', Buffer.from('<html><script>alert(1)</script></html>'.padEnd(64))],
      ['exe.dwg', Buffer.concat([Buffer.from('MZ\x90\x00'), Buffer.alloc(200)])],
      ['junk-then.pdf', Buffer.concat([Buffer.from('JUNK'), SAMPLE.pdf])],
      ['svg.png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'.padEnd(64))],
      ['zip.dxf', Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(200)])],
      ['empty.pdf', Buffer.alloc(0)],
      ['truncated.pdf', Buffer.from('%PDF')],
      ['nul.dxf', Buffer.concat([Buffer.from('  0\r\nSECTION\r\n  2\r\nHEADER\r\n'), Buffer.from([0, 0, 0, 0])])],
    ];
    const out: Array<[string, number, string, boolean]> = [];
    for (const [f, b] of cases) {
      const { r, quarantined } = await upload(f, b);
      out.push([f, r.status, r.body?.error?.code, quarantined]);
    }
    ev.magic = out;
    expect(out.map(([f, s, c, q]) => [f, s, c, q])).toEqual(cases.map(([f]) => [f, 415, 'unsupported_file_type', false]));
  });

  it('finalize: actual bytes > 100 MB → 413 and the object is deleted (the declared size is not trusted)', async () => {
    const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
    SAMPLE.pdf.copy(big);
    const { r, quarantined } = await upload('big.pdf', big);
    expect([r.status, ApiErrorSchema.parse(r.body).error.code, quarantined]).toEqual([413, 'payload_too_large', false]);
  });

  it('filename: path parts, bidi overrides, control and reserved characters are stripped from the stored display name', async () => {
    const name = '..\\..\\x/‮evil<script>|"\u0007.pdf';
    const { r } = await upload(name, Buffer.concat([SAMPLE.pdf, Buffer.from(randomUUID())]));
    expect(r.status).toBe(201);
    const set = FinalizeUploadResponseSchema.parse(r.body).sheetSet;
    ev.sanitizedName = set.name;
    expect(set.name).not.toMatch(/[\\/‮<>|"\u0007]/);
    expect((set.name ?? '').endsWith('.pdf')).toBe(true);
    expect(set.storagePath).toBe(storagePaths.projectUpload(w.A.orgId, w.A.projectId, set.sha256, 'pdf'));
  });

  it('upload token: bound to org + project + user, HMAC-signed, 10 min; replay is idempotent (no second set / job)', async () => {
    const up = await reserve('t.pdf');
    w.t.storage.objects.set(up.storagePath, { data: Buffer.concat([SAMPLE.pdf, Buffer.from('replay')]), contentType: 'application/pdf' });
    const tampered = up.uploadToken.slice(0, -2) + (up.uploadToken.endsWith('A') ? 'BB' : 'AA');
    expect((await w.http.post(`${P()}/sheet-sets`).set(ed()).send({ uploadToken: tampered })).status).toBe(400);
    // another editor of the same org
    expect((await w.http.post(`${P()}/sheet-sets`).set(w.auth(w.A.uid('admin'))).send({ uploadToken: up.uploadToken })).status).toBe(400);
    // another project of the same org
    const other = (await w.http.post('/api/v1/projects').set(ed()).send({ orgId: w.A.orgId, name: 'אחר' })).body.id as string;
    expect((await w.http.post(`/api/v1/projects/${other}/sheet-sets`).set(ed()).send({ uploadToken: up.uploadToken })).status).toBe(400);
    // B's editor cannot use A's token on B's project, nor on A's project
    expect((await w.http.post(`/api/v1/projects/${w.B.projectId}/sheet-sets`).set(w.auth(w.B.uid('editor'))).send({ uploadToken: up.uploadToken })).status).toBe(400);
    expect((await w.http.post(`${P()}/sheet-sets`).set(w.auth(w.B.uid('editor'))).send({ uploadToken: up.uploadToken })).status).toBe(404);
    // expired (signed with the real secret, exp in the past) → 410
    const signer = new UploadTokenSigner(UPLOAD_SECRET);
    const fid = randomUUID();
    const old = signer.sign({ v: 3, fid, org: w.A.orgId, prj: w.A.projectId, usr: w.A.uid('editor'), path: storagePaths.quarantine(w.A.orgId, fid), name: 'x.pdf', kind: 'pdf', size: 10, exp: Math.floor(Date.now() / 1000) - 1 });
    const exp = await w.http.post(`${P()}/sheet-sets`).set(ed()).send({ uploadToken: old });
    expect([exp.status, exp.body.error.code]).toEqual([410, 'upload_expired']);
    // success, then replay
    const r1 = FinalizeUploadResponseSchema.parse((await w.http.post(`${P()}/sheet-sets`).set(ed()).send({ uploadToken: up.uploadToken })).body);
    const n = w.t.queue.messages.length;
    const r2 = await w.http.post(`${P()}/sheet-sets`).set(ed()).send({ uploadToken: up.uploadToken });
    expect(r2.status).toBe(201);
    expect(FinalizeUploadResponseSchema.parse(r2.body)).toMatchObject({ jobId: r1.jobId, sheetSet: { id: r1.sheetSet.id } });
    expect(w.t.queue.messages.length).toBe(n);
  });

  it('JSON body > 2 MB → 413 in the ApiError shape (no stack, no 500)', async () => {
    const r = await w.http.post(`${P()}/corrections/batch`).set(ed()).set('content-type', 'application/json').send(`{"items":[],"pad":"${'x'.repeat(2 * 1024 * 1024 + 10)}"}`);
    expect(r.status).toBe(413);
    expect(ApiErrorSchema.parse(r.body).error).toMatchObject({ code: 'payload_too_large', message: 'payload too large' });
    const bad = await w.http.post(`${P()}/uploads`).set(ed()).set('content-type', 'application/json').send('{"filename":');
    expect(bad.status).toBe(400);
    expect(ApiErrorSchema.parse(bad.body).error.code).toBe('bad_request');
    expect(JSON.stringify(bad.body)).not.toMatch(/at .*\.js|node_modules/);
  });

  it('library import (past BOQ): .xls / .xlsx ≤ 20 MB only; wrong magic → 415, import rejected, object deleted; real xlsx → 202', async () => {
    const lib = (body: Record<string, unknown>) => w.http.post('/api/v1/library/imports').set(ed()).send({ orgId: w.A.orgId, ...body });
    for (const filename of ['x.csv', 'x.xlsm', 'x.pdf', 'x.xlsx.exe']) expect((await lib({ filename, sizeBytes: 10 })).status, filename).toBe(400);
    expect((await lib({ filename: 'x.xlsx', sizeBytes: 20 * 1024 * 1024 + 1 })).status).toBe(400);
    const fin = async (bytes: Buffer, filename = 'past.xlsx') => {
      const c = CreateLibraryImportResponseSchema.parse((await lib({ filename, sizeBytes: Math.max(1, bytes.length) })).body);
      w.t.boqStorage.putImport(c.storagePath, bytes);
      const r = await w.http.post(`/api/v1/library/imports/${c.import.id}/finalize`).set(ed()).send({ orgId: w.A.orgId });
      return { r, kept: w.t.boqStorage.objects.has(c.storagePath), id: c.import.id };
    };
    const pdf = await fin(SAMPLE.pdf);
    expect([pdf.r.status, pdf.r.body.error.code, pdf.kept]).toEqual([415, 'unsupported_file_type', false]);
    const zipNoWb = await fin(Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(300)]));
    expect([zipNoWb.r.status, zipNoWb.kept]).toEqual([415, false]);
    const xlsAsXlsx = await fin(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]));
    expect(xlsAsXlsx.r.status).toBe(415);
    const good = await fin(await xlsxBytes());
    expect(good.r.status).toBe(202);
  });

  it('A-API-12 (Sprint 7): SEC-15 — the worker scans every upload (ClamAV) before parsing; `file_infected` is surfaced by the upload status in Hebrew and the bytes leave the quota', async () => {
    const { r } = await upload('נגוע.pdf', Buffer.concat([SAMPLE.pdf, Buffer.from('%infected\n')]));
    expect(r.status).toBe(201);
    const fin = FinalizeUploadResponseSchema.parse(r.body);
    const proj = () => (w.t.repo.docs.get(fsPaths.project(w.A.orgId, w.A.projectId)) as Record<string, unknown>).storageBytes as number;
    const before = proj();
    // what Worker-BOQ writes on a ClamAV hit (workers/drawing NOTES "Sprint 7 … ClamAV")
    const sp = fsPaths.sheetSet(w.A.orgId, w.A.projectId, fin.sheetSet.id);
    w.t.repo.docs.set(sp, { ...(w.t.repo.docs.get(sp) as Record<string, unknown>), status: 'failed', error: { code: 'file_infected', message: 'Win.Test.EICAR_HDB-1' } });
    const st = SheetSetStatusResponseSchema.parse((await w.http.get(`${P()}/sheet-sets/${fin.sheetSet.id}`).set(ed())).body);
    ev.infected = st;
    expect(st).toMatchObject({ infected: true, error: { code: 'file_infected', message: 'Win.Test.EICAR_HDB-1' } });
    expect(st.error?.messageHe).toMatch(/נוזקה/);
    expect(proj()).toBe(before - (fin.sheetSet.sizeBytes ?? 0));
  });
  it('A-API-13 (Sprint 7): SEC-14 — per-project storage quota (default 2 GB, org `projectQuotaBytes`) → 413 quota_exceeded with a Hebrew message', async () => {
    const op = fsPaths.org(w.A.orgId);
    const org = w.t.repo.docs.get(op) as { settings: Record<string, unknown> };
    w.t.repo.docs.set(op, { ...org, settings: { ...org.settings, projectQuotaBytes: 1 } });
    const r = await w.http.post(`${P()}/uploads`).set(ed()).send({ filename: 'a.pdf', sizeBytes: 1000 });
    ev.quota = r.body;
    expect(r.status).toBe(413);
    expect(ApiErrorSchema.parse(r.body).error).toMatchObject({ code: 'quota_exceeded' });
    expect(r.body.error.message).toMatch(/אין מספיק מקום בפרויקט/);
    w.t.repo.docs.set(op, org);
  });
  it.todo('A-API-13b: SEC-14 — ≤ 100 sheets per project is not enforced (the page count is known only after the worker splits the file)');

  describe('rate limits (SEC-42) with small production-like limits', () => {
    let w2: World;
    beforeAll(async () => {
      w2 = await createWorld({ UPLOAD_THROTTLE_LIMIT: '3' });
    });
    afterAll(async () => {
      await w2.t.app.close();
    });
    it('POST uploads / sheet-sets: the (N+1)th call per user per minute → 429 rate_limited; another user is unaffected', async () => {
      const send = (who: string) => w2.http.post(`/api/v1/projects/${w2.A.projectId}/uploads`).set(w2.auth(who)).send({ filename: 'a.pdf', sizeBytes: 10 });
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await send(w2.A.uid('editor'))).status);
      expect(codes).toEqual([201, 201, 201, 429]);
      const r = await send(w2.A.uid('editor'));
      expect(ApiErrorSchema.parse(r.body).error.code).toBe('rate_limited');
      ev.uploadRateLimitHeaders = Object.fromEntries(Object.entries(r.headers).filter(([k]) => /retry|ratelimit/i.test(k)));
      expect((await send(w2.A.uid('admin'))).status).toBe(201);
      const fin: number[] = [];
      for (let i = 0; i < 4; i++) fin.push((await w2.http.post(`/api/v1/projects/${w2.A.projectId}/sheet-sets`).set(w2.auth(w2.A.uid('editor'))).send({ uploadToken: 'x'.repeat(40) })).status);
      expect(fin).toEqual([400, 400, 400, 429]);
    });
  });
});
