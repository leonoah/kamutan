import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CreateShareLinkResponseSchema,
  FinalizeUploadResponseSchema,
  fsPaths,
  PublicShareMetaSchema,
  SheetPageSchema,
  SheetVersionSchema,
} from '@kamutan/contracts';
import { inputQualityOf } from '../../src/db/mappers';
import { createTestApp, type TestApp } from '../support/app';
import { SAMPLE, testConfig } from '../support/helpers';

/** Sprint 9: `quality` (worker-written input-quality gate) on version DTOs + sheet summaries; never in share DTOs. */
describe('Sprint 9 e2e — input quality', () => {
  let t: TestApp;
  let http: ReturnType<typeof request>;
  const tok: Record<string, string> = {};
  let orgId: string;
  let projectId: string;
  const ids: Record<'ok' | 'warn' | 'reject' | 'vector', { sheetId: string; versionId: string }> = {} as never;
  const auth = (who: string) => ({ authorization: `Bearer ${tok[who]}` });
  const base = () => `/api/v1/projects/${projectId}/sheets`;
  const warnQ = { status: 'warn', effectiveDpi: 96, issues: [{ kind: 'low_resolution', detail: 'x-height 3px' }] };
  const rejectQ = { status: 'reject', effectiveDpi: 30, issues: [{ kind: 'low_resolution' }, { kind: 'mirrored', severity: 'reject' }] };

  beforeAll(async () => {
    t = await createTestApp(testConfig({ THROTTLE_LIMIT: '1000', UPLOAD_THROTTLE_LIMIT: '100' }));
    http = request(t.app.getHttpServer());
    for (const who of ['editor', 'viewer']) tok[who] = t.auth.issue(who);
    orgId = t.repo.seedOrg('Org', { editor: 'editor', viewer: 'viewer' }).id;
    projectId = (await t.repo.createProject(orgId, { name: 'P' }, 'editor')).id;
    const up = await http.post(`/api/v1/projects/${projectId}/uploads`).set(auth('editor')).send({ filename: 'a.pdf', sizeBytes: SAMPLE.pdf.length }).expect(201);
    t.storage.put(up.body.storagePath, SAMPLE.pdf);
    const fin = FinalizeUploadResponseSchema.parse(
      (await http.post(`/api/v1/projects/${projectId}/sheet-sets`).set(auth('editor')).send({ uploadToken: up.body.uploadToken }).expect(201)).body,
    );
    const quality: Record<string, unknown> = { ok: { status: 'ok', effectiveDpi: 300, issues: [] }, warn: warnQ, reject: rejectQ };
    (['ok', 'warn', 'reject', 'vector'] as const).forEach((k, i) => {
      ids[k] = t.repo.seedWorkerSheet(orgId, projectId, fin.sheetSet.id, i, { versionId: fin.versionId });
      if (k !== 'vector') {
        const path = fsPaths.version(orgId, projectId, ids[k].sheetId, ids[k].versionId);
        const doc = t.repo.docs.get(path) as Record<string, unknown>;
        t.repo.docs.set(path, {
          ...doc,
          quality: quality[k],
          ...(k === 'reject' ? { error: { code: 'input_quality_rejected', message: 'quality gate' } } : {}),
        });
      }
    });
  });
  afterAll(async () => {
    await t?.app.close();
  });

  it('GET sheets: currentVersion.quality per sheet (absent for vector input)', async () => {
    const page = SheetPageSchema.parse((await http.get(base()).set(auth('viewer')).expect(200)).body);
    const by = new Map(page.items.map((s) => [s.id, s.currentVersion]));
    expect(by.get(ids.ok.sheetId)?.quality?.status).toBe('ok');
    expect(by.get(ids.warn.sheetId)?.quality).toEqual(warnQ);
    expect(by.get(ids.reject.sheetId)?.quality).toEqual(rejectQ);
    expect(by.get(ids.reject.sheetId)?.error?.code).toBe('input_quality_rejected');
    expect(by.get(ids.vector.sheetId)?.quality).toBeUndefined();
  });

  it('GET version: quality on the full DTO, version still ready (viewable)', async () => {
    const v = SheetVersionSchema.parse((await http.get(`${base()}/${ids.reject.sheetId}/versions/${ids.reject.versionId}`).set(auth('viewer')).expect(200)).body);
    expect(v.status).toBe('ready');
    expect(v.quality).toEqual(rejectQ);
    expect(v.artifacts.tiles).toBeTruthy();
  });

  it('POST reprocess: response version has no stale quality', async () => {
    const r = await http.post(`${base()}/${ids.warn.sheetId}/reprocess`).set(auth('editor')).send({});
    expect([202, 409]).toContain(r.status);
    if (r.status === 202) expect(r.body.sheetVersion.quality ?? null).toBeNull();
  });

  it('share meta / overlay never carry quality', async () => {
    const link = CreateShareLinkResponseSchema.parse((await http.post(`/api/v1/projects/${projectId}/share-links`).set(auth('editor')).send({ label: 'x', days: 3, includeUnmaskedSheets: true }).expect(201)).body);
    const raw = (await http.get(`/api/v1/public/share/${link.token}/meta`).expect(200)).body;
    const meta = PublicShareMetaSchema.parse(raw);
    expect(meta.sheets.length).toBeGreaterThan(0);
    expect(JSON.stringify(raw)).not.toMatch(/quality|effectiveDpi|input_quality/);
    const ov = await http.get(`/api/v1/public/share/${link.token}/sheets/${ids.reject.sheetId}/overlay`);
    if (ov.status === 200) expect(JSON.stringify(ov.body)).not.toMatch(/quality|effectiveDpi/);
  });

  it('mapper is tolerant of worker drift', () => {
    expect(inputQualityOf(undefined)).toBeUndefined();
    expect(inputQualityOf(null)).toBeNull();
    expect(inputQualityOf({ status: 'nope', issues: [] })).toBeUndefined();
    expect(inputQualityOf({ status: 'warn', effectiveDpi: -3, issues: [{ kind: 'mirrored', detail: 'x'.repeat(999) }, { kind: 'alien' }, null] })).toEqual({
      status: 'warn',
      effectiveDpi: null,
      issues: [{ kind: 'mirrored' }],
    });
    expect(inputQualityOf({ status: 'reject' })).toEqual({ status: 'reject', issues: [] });
  });
});
