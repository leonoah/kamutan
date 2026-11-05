/**
 * Sprint 7 (API): BOQ preview document (GET …/boq/document = the export's layout, gate warnings, options, roles),
 * line rename (PATCH `description` / restore / approved lines / roles / audit + history before → after / library
 * update / share snapshot / Excel / BOQ read path), per-project storage quota (413 quota_exceeded in Hebrew, accounting
 * on finalize, dedupe, org setting, legacy recount) and `file_infected` surfacing (upload status + storage release).
 */
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  BoqDocumentModelSchema,
  BoqViewSchema,
  CreateShareLinkResponseSchema,
  CreateUploadResponseSchema,
  DEFAULT_PROJECT_QUOTA_BYTES,
  ExportBoqResponseSchema,
  FinalizeUploadResponseSchema,
  fsPaths,
  itemIdFor,
  LineHistoryResponseSchema,
  PatchBoqLineResponseSchema,
  ProjectSchema,
  SheetSetStatusResponseSchema,
} from '@kamutan/contracts';
import type { Doc } from '../../src/db/mappers';
import { MAIN_SHEET } from '../../src/boq/excel';
import { SAMPLE } from '../support/helpers';
import { auditsOf, createWorld, type World } from '../acceptance/support/world';

describe('Sprint 7 e2e (API)', () => {
  let w: World;
  const P = () => `/api/v1/projects/${w.A.projectId}`;
  const as = (r: 'viewer' | 'reviewer' | 'editor' | 'admin') => w.auth(w.A.uid(r));
  const lineDoc = (id: string) => w.t.repo.docs.get(fsPaths.boqLine(w.A.orgId, w.A.projectId, id)) as Doc;
  const patch = (id: string, body: object, who = as('editor')) => w.http.patch(`${P()}/boq/lines/${id}`).set(who).send(body);

  beforeAll(async () => {
    w = await createWorld();
  });
  afterAll(async () => {
    await w.t.app.close();
  });

  // ------------------------------------------------------------------ rename
  describe('PATCH …/boq/lines/:id `description` (rename)', () => {
    it('editor renames; stored with by / at / reason; the read path carries it; original kept', async () => {
      const r = await patch(w.A.lines.plain, { description: '  מפסק   תאורה כפול ', reason: 'לפי המפרט' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const { line } = PatchBoqLineResponseSchema.parse(r.body);
      expect(line).toMatchObject({ description: 'מפסק', descriptionOverride: 'מפסק תאורה כפול', descriptionOverrideBy: w.A.uid('editor'), descriptionOverrideReason: 'לפי המפרט' });
      expect(line.descriptionOverrideAt).toBeTruthy();
      expect(lineDoc(w.A.lines.plain)).toMatchObject({ description: 'מפסק', descriptionOverride: 'מפסק תאורה כפול' });
      const view = BoqViewSchema.parse((await w.http.get(`${P()}/boq`).set(as('viewer'))).body);
      expect(view.items.find((l) => l.id === w.A.lines.plain)?.descriptionOverride).toBe('מפסק תאורה כפול');
    });

    it('roles: reviewer / viewer 403, outsider 404; validation 400 (empty, > 500, alsoUpdateLibrary without text)', async () => {
      expect((await patch(w.A.lines.plain, { description: 'x' }, as('reviewer'))).status).toBe(403);
      expect((await patch(w.A.lines.plain, { description: 'x' }, as('viewer'))).status).toBe(403);
      expect((await patch(w.A.lines.plain, { description: 'x' }, w.auth(w.B.uid('admin')))).status).toBe(404);
      for (const body of [{ description: '   ' }, { description: 'א'.repeat(501) }, { description: null, alsoUpdateLibrary: true }, { description: 'x', extra: 1 }]) {
        expect((await patch(w.A.lines.plain, body)).status, JSON.stringify(body).slice(0, 40)).toBe(400);
      }
      expect((await patch(w.A.lines.plain, { description: 'א'.repeat(500) })).status).toBe(200);
    });

    it('audit + history show before → after; restore (null) and "same as the original" clear it', async () => {
      await patch(w.A.lines.plain, { description: 'שם א' });
      await patch(w.A.lines.plain, { description: 'שם ב' });
      const evs = auditsOf(w.t, w.A.orgId).filter((e) => e.entity === 'boqLines' && e.entityId === w.A.lines.plain && (e.after as Doc).description);
      expect((evs.at(-1)?.after as Doc).description).toEqual({ from: 'שם א', to: 'שם ב', original: 'מפסק' });
      const r1 = PatchBoqLineResponseSchema.parse((await patch(w.A.lines.plain, { description: null })).body);
      expect(r1.line).toMatchObject({ descriptionOverride: null, descriptionOverrideBy: null, descriptionOverrideReason: null });
      await patch(w.A.lines.plain, { description: 'שם ג' });
      const r2 = PatchBoqLineResponseSchema.parse((await patch(w.A.lines.plain, { description: 'מפסק' })).body);
      expect(r2.line.descriptionOverride).toBeNull();
      const hist = LineHistoryResponseSchema.parse((await w.http.get(`${P()}/boq/lines/${w.A.lines.plain}/history`).set(as('viewer'))).body);
      const items = hist.items.filter((i) => i.action === 'description');
      expect(items.length).toBeGreaterThanOrEqual(5);
      expect(items.some((i) => i.before === 'שם א' && i.after === 'שם ב' && i.summary?.includes('«שם א» → «שם ב»'))).toBe(true);
      expect(items.some((i) => i.before === 'שם ב' && i.after === 'מפסק' && i.summary?.startsWith('שחזור לנוסח המקורי'))).toBe(true);
      const first = items.find((i) => i.reason === 'לפי המפרט');
      expect(first?.after).toBe('מפסק תאורה כפול');
    });

    it('an approved line can be renamed (status / approval kept); a note on it is still 409', async () => {
      const r = await patch(w.A.lines.approved, { description: 'נקודת מאור תקרה' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(PatchBoqLineResponseSchema.parse(r.body).line).toMatchObject({ status: 'approved', descriptionOverride: 'נקודת מאור תקרה' });
      expect((await patch(w.A.lines.approved, { description: 'y', note: 'n' })).status).toBe(409);
    });

    it('a rebuild that rewrites the computed fields keeps the rename (contract applyRebuild) and the API reads it', async () => {
      const id = w.A.lines.approved;
      const cur = lineDoc(id);
      const { applyRebuild } = await import('@kamutan/contracts');
      w.t.repo.docs.set(fsPaths.boqLine(w.A.orgId, w.A.projectId, id), applyRebuild(cur, { chapter: '04', code: '4.03', description: 'נקודת מאור (חדש)', qty: 6, unit: "יח'", level: 'green', buildId: 'b1' }));
      const view = BoqViewSchema.parse((await w.http.get(`${P()}/boq`).set(as('viewer'))).body);
      expect(view.items.find((l) => l.id === id)).toMatchObject({ description: 'נקודת מאור (חדש)', descriptionOverride: 'נקודת מאור תקרה' });
    });

    it('alsoUpdateLibrary: new manual item with the wording, the code\'s old active items deactivated', async () => {
      const orgId = w.A.orgId;
      const old = await w.http.post('/api/v1/library/items').set(as('editor')).send({ orgId, code: '4.02', chapter: '04', chapterTitle: 'חשמל', description: 'שקע מוגן מים', unit: "יח'", tags: ['x'] });
      expect(old.status, JSON.stringify(old.body)).toBe(201);
      const r = await patch(w.A.lines.override, { description: 'שקע מוגן מים IP44', alsoUpdateLibrary: true });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const body = PatchBoqLineResponseSchema.parse(r.body);
      const newId = itemIdFor('4.02', 'שקע מוגן מים IP44');
      // every previously active item of the code (the org's default item + the one created above) is deactivated
      expect(body.library).toMatchObject({ itemId: newId, created: true });
      expect(body.library?.deactivatedItemIds).toContain(old.body.id);
      const items = (await w.http.get(`/api/v1/library/items?orgId=${orgId}&q=4.02&limit=500`).set(as('viewer'))).body.items as Doc[];
      const ofCode = items.filter((i) => i.code === '4.02');
      expect(ofCode.filter((i) => i.active).map((i) => i.id)).toEqual([newId]);
      expect(ofCode.find((i) => i.id === newId)).toMatchObject({ source: 'manual', chapter: '04', unit: "יח'", description: 'שקע מוגן מים IP44' });
      expect(body.library?.deactivatedItemIds.sort()).toEqual(ofCode.filter((i) => i.id !== newId).map((i) => i.id as string).sort());
      const ev = auditsOf(w.t, orgId).filter((e) => e.entity === 'boqLines' && e.entityId === w.A.lines.override).at(-1);
      expect(ev?.after).toMatchObject({ alsoUpdateLibrary: true, libraryItemId: newId });
      // idempotent: the same wording again creates nothing new
      const again = PatchBoqLineResponseSchema.parse((await patch(w.A.lines.override, { description: 'שקע מוגן מים IP44', alsoUpdateLibrary: true })).body);
      expect(again.library).toEqual({ itemId: newId, created: false, deactivatedItemIds: [] });
      // reviewer may not touch the library through the line either
      expect((await patch(w.A.lines.override, { description: 'z', alsoUpdateLibrary: true }, as('reviewer'))).status).toBe(403);
    });

    it('Excel and the share snapshot use the rename (escaped against formula injection in the xlsx)', async () => {
      await patch(w.A.lines.status, { description: '=1+1 שקע' });
      const exp = ExportBoqResponseSchema.parse((await w.http.post(`${P()}/boq/export`).set(as('editor')).send({})).body);
      const path = [...w.t.boqStorage.objects.keys()].find((k) => k.endsWith(`${exp.exportId}.xlsx`)) as string;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(w.t.boqStorage.objects.get(path) as unknown as ArrayBuffer);
      const texts: unknown[] = [];
      (wb.getWorksheet(MAIN_SHEET) as ExcelJS.Worksheet).eachRow((r) => texts.push(r.getCell(2).value));
      expect(texts).toContain("'=1+1 שקע");
      expect(texts).toContain('נקודת מאור תקרה');
      const link = CreateShareLinkResponseSchema.parse((await w.http.post(`${P()}/share-links`).set(as('editor')).send({ label: 'קבלן', days: 7 })).body);
      const pub = await w.http.get(`/api/v1/public/share/${link.token}/boq`);
      expect(pub.status).toBe(200);
      const descs = (pub.body.lines as Doc[]).map((l) => l.description);
      expect(descs).toContain('=1+1 שקע');
      expect(descs).toContain('נקודת מאור תקרה');
      // Owner decision 05.11: renamed lines carry only a boolean marker — never the original wording or who renamed it.
      const renamed = (pub.body.lines as Doc[]).find((l) => l.description === '=1+1 שקע')!;
      expect(renamed.descriptionManual).toBe(true);
      expect(Object.keys(renamed)).not.toEqual(expect.arrayContaining(['descriptionOverride', 'descriptionOverrideBy']));
      expect((pub.body.lines as Doc[]).some((l) => l.descriptionManual === undefined)).toBe(true); // untouched lines carry no marker
    });
  });

  // ------------------------------------------------------------------ document
  describe('GET …/boq/document (preview)', () => {
    it('viewer gets the model = the export layout; options split / confidence / chapters / markDraft', async () => {
      const r = await w.http.get(`${P()}/boq/document`).set(as('viewer'));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const doc = BoqDocumentModelSchema.parse(r.body);
      expect(doc).toMatchObject({ projectId: w.A.projectId, buildId: 'b1', options: { split: 'summed', includeConfidence: true, chapters: null, markDraft: false } });
      expect(doc.columns.map((c) => c.key)).toEqual(expect.arrayContaining(['code', 'description', 'unit', 'qty', 'confidence', 'status']));
      const rows = doc.chapters.flatMap((c) => c.rows.filter((x) => x.kind === 'line'));
      expect(rows.find((x) => x.lineId === w.A.lines.approved)).toMatchObject({ description: 'נקודת מאור תקרה', descriptionOverridden: true, status: 'approved', level: 'green' });
      expect(doc.chapters.every((c) => c.rows.at(-1)?.kind === 'subtotal')).toBe(true);
      expect(doc.titleRows.some((t) => t.kind === 'title' && t.text.includes('פרויקט אלף'))).toBe(true);

      const lean = BoqDocumentModelSchema.parse((await w.http.get(`${P()}/boq/document?confidence=0&split=floor&markDraft=1`).set(as('viewer'))).body);
      expect(lean.columns.map((c) => c.key)).not.toContain('confidence');
      expect(lean.options).toMatchObject({ split: 'byFloor', includeConfidence: false, markDraft: true });
      expect(lean.titleRows.at(-1)?.kind).toBe('draft');
      expect(lean.chapters.flatMap((c) => c.rows).every((x) => x.level === undefined)).toBe(true);
      const none = BoqDocumentModelSchema.parse((await w.http.get(`${P()}/boq/document?chapters=09`).set(as('viewer'))).body);
      expect(none.chapters).toHaveLength(0);
      expect(none.counts.lines).toBe(0);
    });

    it('gate warnings + exportBlocked (never 409); 400 on bad options; outsider 404; unknown template 404', async () => {
      w.t.boq.seedLine(w.A.orgId, w.A.projectId, { id: 'ln_s7_red', code: '4.20', description: 'לבדיקה', qty: 3, level: 'red', status: 'draft', buildId: 'b1' } as never);
      w.t.boq.seedLine(w.A.orgId, w.A.projectId, { id: 'ln_s7_need', code: '4.21', description: 'להשלמה', qty: 0, needsInput: true, level: 'red', status: 'draft', buildId: 'b1' } as never);
      const doc = BoqDocumentModelSchema.parse((await w.http.get(`${P()}/boq/document`).set(as('viewer'))).body);
      expect(doc.exportBlocked).toBe(true);
      const k = Object.fromEntries(doc.warnings.map((x) => [x.kind, x.count]));
      expect(k).toMatchObject({ red: 2, needsInput: 1 });
      expect(k.unapproved).toBeGreaterThanOrEqual(2);
      expect(doc.titleRows[0]?.kind).toBe('warning');
      expect(doc.chapters.flatMap((c) => c.rows).find((x) => x.lineId === 'ln_s7_need')).toMatchObject({ qty: null, cellNote: 'להשלמה ידנית' });
      expect((await w.http.post(`${P()}/boq/export`).set(as('editor')).send({})).body.error.code).toBe('export_blocked');
      for (const q of ['split=room', 'confidence=yes', 'foo=1', `chapters=${Array.from({ length: 70 }, (_, i) => i + 1).join(',')}`]) expect((await w.http.get(`${P()}/boq/document?${q}`).set(as('viewer'))).status, q).toBe(400);
      expect((await w.http.get(`${P()}/boq/document`).set(w.auth(w.B.uid('admin')))).status).toBe(404);
      expect((await w.http.get(`${P()}/boq/document?templateId=tpl_nope`).set(as('viewer'))).status).toBe(404);
    });

    it('export takes the same options (chapters / includeConfidence) and writes the same rows', async () => {
      for (const id of ['ln_s7_red', 'ln_s7_need']) w.t.repo.docs.delete(fsPaths.boqLine(w.A.orgId, w.A.projectId, id));
      const doc = BoqDocumentModelSchema.parse((await w.http.get(`${P()}/boq/document?confidence=0`).set(as('viewer'))).body);
      const exp = ExportBoqResponseSchema.parse((await w.http.post(`${P()}/boq/export`).set(as('editor')).send({ includeConfidence: false })).body);
      const path = [...w.t.boqStorage.objects.keys()].find((k) => k.endsWith(`${exp.exportId}.xlsx`)) as string;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(w.t.boqStorage.objects.get(path) as unknown as ArrayBuffer);
      const ws = wb.getWorksheet(MAIN_SHEET) as ExcelJS.Worksheet;
      expect(ws.columnCount).toBe(doc.columns.length);
      const codes: unknown[] = [];
      ws.eachRow((r) => typeof r.getCell(1).value === 'string' && /^\d/.test(r.getCell(1).value as string) && codes.push(r.getCell(1).value));
      expect(codes).toEqual(doc.chapters.flatMap((c) => c.rows.filter((x) => x.kind === 'line').map((x) => x.code)));
    });
  });

  // ------------------------------------------------------------------ quota + infected
  describe('storage quota + file_infected', () => {
    const ed = () => as('editor');
    const reserve = (sizeBytes: number, filename = 'q.pdf') => w.http.post(`${P()}/uploads`).set(ed()).send({ filename, sizeBytes });
    const upload = async (bytes: Buffer) => {
      const up = CreateUploadResponseSchema.parse((await reserve(bytes.length)).body);
      w.t.storage.objects.set(up.storagePath, { data: bytes, contentType: up.contentType });
      const r = await w.http.post(`${P()}/sheet-sets`).set(ed()).send({ uploadToken: up.uploadToken });
      return { up, r, kept: w.t.storage.objects.has(up.storagePath) };
    };
    const projectDoc = () => w.t.repo.docs.get(fsPaths.project(w.A.orgId, w.A.projectId)) as Doc;
    const setQuota = (q: number | undefined) => {
      const p = fsPaths.org(w.A.orgId);
      const d = w.t.repo.docs.get(p) as Doc;
      const settings = { ...(d.settings as Doc) };
      if (q === undefined) delete settings.projectQuotaBytes;
      else settings.projectQuotaBytes = q;
      w.t.repo.docs.set(p, { ...d, settings });
    };
    const pdf = (n: number) => Buffer.concat([SAMPLE.pdf, Buffer.from(`%${'x'.repeat(n)}\n`)]);

    it('GET project: legacy usage recounted from the sheet sets; quota = org default 2 GB', async () => {
      const sets = [...w.t.repo.docs.entries()].filter(([k]) => k.startsWith(`orgs/${w.A.orgId}/projects/${w.A.projectId}/sheetSets/`));
      for (const [k, d] of sets) w.t.repo.docs.set(k, { ...d, sizeBytes: 1000 });
      const pr = ProjectSchema.parse((await w.http.get(P()).set(as('viewer'))).body);
      expect(pr.storageBytes).toBe(1000 * sets.length);
      expect(pr.storageQuotaBytes).toBe(DEFAULT_PROJECT_QUOTA_BYTES);
    });

    it('finalize counts the new file; identical bytes (dedupe) count nothing', async () => {
      const before = projectDoc().storageBytes as number;
      const bytes = pdf(10);
      const a = await upload(bytes);
      expect(a.r.status, JSON.stringify(a.r.body)).toBe(201);
      expect(projectDoc().storageBytes).toBe(before + bytes.length);
      const b = await upload(bytes);
      expect(FinalizeUploadResponseSchema.parse(b.r.body).deduplicated).toBe(true);
      expect(projectDoc().storageBytes).toBe(before + bytes.length);
      const list = ProjectSchema.parse(((await w.http.get(`/api/v1/projects?orgId=${w.A.orgId}`).set(as('viewer'))).body.items as Doc[]).find((p) => p.id === w.A.projectId));
      expect(list.storageBytes).toBe(before + bytes.length);
    });

    it('413 quota_exceeded (Hebrew message, numbers) at reserve and atomically at finalize; quarantine object deleted', async () => {
      const used = projectDoc().storageBytes as number;
      setQuota(used + 50);
      const early = await reserve(100);
      expect(early.status).toBe(413);
      const e = ApiErrorSchema.parse(early.body).error;
      expect(e.code).toBe('quota_exceeded');
      expect(e.message).toMatch(/אין מספיק מקום בפרויקט/);
      expect(Object.fromEntries((e.issues ?? []).map((i) => [i.path, i.message]))).toEqual({ usedBytes: String(used), quotaBytes: String(used + 50), requestedBytes: '100' });
      // reserve with a small declared size passes, the real file is bigger → finalize refuses
      const up = CreateUploadResponseSchema.parse((await reserve(10)).body);
      w.t.storage.objects.set(up.storagePath, { data: pdf(200), contentType: up.contentType });
      const fin = await w.http.post(`${P()}/sheet-sets`).set(ed()).send({ uploadToken: up.uploadToken });
      expect(fin.status).toBe(413);
      expect(fin.body.error.code).toBe('quota_exceeded');
      expect(w.t.storage.objects.has(up.storagePath)).toBe(false);
      expect(projectDoc().storageBytes).toBe(used);
      // the admin raises the quota (settings PATCH, admin + MFA) → uploads work again
      const ps = await w.http.patch(`/api/v1/orgs/${w.A.orgId}/settings`).set(as('admin')).send({ projectQuotaBytes: 5 * 1024 ** 3 });
      expect(ps.status, JSON.stringify(ps.body)).toBe(200);
      expect(ps.body.settings.projectQuotaBytes).toBe(5 * 1024 ** 3);
      expect((await w.http.patch(`/api/v1/orgs/${w.A.orgId}/settings`).set(as('editor')).send({ projectQuotaBytes: 5 * 1024 ** 3 })).status).toBe(403);
      expect((await w.http.patch(`/api/v1/orgs/${w.A.orgId}/settings`).set(as('admin')).send({ projectQuotaBytes: 10 })).status).toBe(400);
      expect((await upload(pdf(300))).r.status).toBe(201);
      expect(ProjectSchema.parse((await w.http.get(P()).set(as('viewer'))).body).storageQuotaBytes).toBe(5 * 1024 ** 3);
      setQuota(undefined);
    });

    it('file_infected: upload status shows it (Hebrew), the infected set\'s bytes are released once', async () => {
      const bytes = pdf(400);
      const { r } = await upload(bytes);
      const fin = FinalizeUploadResponseSchema.parse(r.body);
      const before = projectDoc().storageBytes as number;
      const sp = fsPaths.sheetSet(w.A.orgId, w.A.projectId, fin.sheetSet.id);
      w.t.repo.docs.set(sp, { ...(w.t.repo.docs.get(sp) as Doc), status: 'failed', error: { code: 'file_infected', message: 'Eicar-Signature' } });
      const jp = fsPaths.job(fin.jobId);
      w.t.repo.docs.set(jp, { ...(w.t.repo.docs.get(jp) as Doc), status: 'failed', error: { code: 'file_infected', message: 'Eicar-Signature' } });
      const st = await w.http.get(`${P()}/sheet-sets/${fin.sheetSet.id}`).set(as('viewer'));
      expect(st.status, JSON.stringify(st.body)).toBe(200);
      const s = SheetSetStatusResponseSchema.parse(st.body);
      expect(s).toMatchObject({ infected: true, job: { id: fin.jobId, status: 'failed' }, error: { code: 'file_infected', message: 'Eicar-Signature' } });
      expect(s.error?.messageHe).toMatch(/נוזקה/);
      expect(s.sheetSet.error?.code).toBe('file_infected');
      expect(projectDoc().storageBytes).toBe(before - bytes.length);
      await w.http.get(`${P()}/sheet-sets/${fin.sheetSet.id}`).set(as('viewer'));
      await w.http.get(P()).set(as('viewer'));
      expect(projectDoc().storageBytes).toBe(before - bytes.length);
      const job = await w.http.get(`/api/v1/jobs/${fin.jobId}`).set(as('viewer'));
      expect(job.body.error).toEqual({ code: 'file_infected', message: 'Eicar-Signature' });
      // a clean set: no error, not infected; foreign / unknown ids 404
      const clean = SheetSetStatusResponseSchema.parse((await w.http.get(`${P()}/sheet-sets/${w.A.sheet.sheetId.replace(/-p0$/, '')}`).set(as('viewer'))).body);
      expect(clean).toMatchObject({ infected: false, error: null });
      expect((await w.http.get(`${P()}/sheet-sets/${'f'.repeat(64)}`).set(as('viewer'))).status).toBe(404);
      expect((await w.http.get(`${P()}/sheet-sets/${fin.sheetSet.id}`).set(w.auth(w.B.uid('admin')))).status).toBe(404);
    });
  });
});
