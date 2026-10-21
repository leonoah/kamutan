/**
 * Storage security-rules tests (emulator, with Firestore for cross-service membership).
 * Skipped unless both FIRESTORE_EMULATOR_HOST and FIREBASE_STORAGE_EMULATOR_HOST are set.
 *
 * Contract (Sprint 1): the ONLY client capability is `create` in the caller's own quarantine slot
 * orgs/{orgId}/uploads/{uid}/{fileId}. Nothing is client-readable — not the quarantine, not the
 * verified sources, not the sheet-version artifacts (tiles / thumbnail / primitives / text);
 * browsers get short-lived signed URLs from the API instead (SEC-13, SEC-19, SEC-20).
 */
import { assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { ROLES, paths } from '../../model';
import { A, B, HAS_FIRESTORE_EMULATOR, HAS_STORAGE_EMULATOR, OUTSIDER, createEnv, seed, type OrgFx } from './env';

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]); // "%PDF-1.7\n"
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const pdfMeta = { contentType: 'application/pdf' };
const webpMeta = { contentType: 'image/webp' };

/** Every server-side object of one org that a client must never read or write. */
function serverObjects(f: OrgFx): string[] {
  const art = paths.artifacts(f.org, f.project, 'set1-p0', 'v1');
  return [
    paths.tile(f.org, f.project, 'set1-p0', 'v1', 0, 0, 0),
    paths.tile(f.org, f.project, 'set1-p0', 'v1', 6, 12, 7),
    `${art}/thumbnail.webp`,
    `${art}/primitives.msgpack.gz`,
    `${art}/text.json.gz`,
    paths.source(f.org, f.project, 'a'.repeat(64), 'pdf'),
    `orgs/${f.org}/projects/${f.project}/uploads/set1/plan.pdf`,
    `orgs/${f.org}/projects/${f.project}/derived/v1/tiles/0_0.png`,
    paths.derived(f.org, 'v1/tiles/0/0/0.webp'),
    // Sprint 3
    paths.linksArtifact(f.org, f.project, 'set1-p0', 'v1'),
    paths.boqEvidence(f.org, f.project, 'b1'),
    paths.boqExportFile(f.org, f.project, 'e1'),
    paths.libraryImportObject(f.org, '1a2b3c4d-0000-4000-8000-000000000001', 'xlsx'),
    // Sprint 4: find_similar candidate crops
    paths.similarThumb(f.org, f.project, 'ss1', 'c_1'),
    // Sprint 5: marked PDF + offboarding ZIP
    paths.markedPdf(f.org, f.project, 'mp1'),
    paths.offboardingZip(f.org, 'ox1'),
    paths.shareBoqSnapshot(f.org, f.project, 'sl1'),
  ];
}

describe.skipIf(!HAS_FIRESTORE_EMULATOR || !HAS_STORAGE_EMULATOR)('storage.rules', () => {
  let env: RulesTestEnvironment;
  const st = (uid: string | null) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).storage();
  const upload = (o: string, uid: string, file: string) => paths.upload(o, uid, file);
  const put = (uid: string | null, path: string, data = PDF, meta: { contentType: string } = pdfMeta) =>
    Promise.resolve(st(uid).ref(path).put(data, meta));

  beforeAll(async () => {
    env = await createEnv({ storage: true });
  });
  afterAll(async () => {
    await env?.cleanup();
  });
  beforeEach(async () => {
    await env.clearFirestore();
    await env.clearStorage();
    await seed(env);
    await env.withSecurityRulesDisabled(async (ctx) => {
      const s = ctx.storage();
      for (const f of [A, B]) {
        await s.ref(upload(f.org, f.users.editor, 'existing')).put(PDF, pdfMeta);
        for (const p of serverObjects(f)) await s.ref(p).put(p.endsWith('.webp') ? WEBP : PDF, p.endsWith('.webp') ? webpMeta : pdfMeta);
      }
    });
  });

  // ---------------------------------------------------------------- quarantine (Sprint 1): create only
  describe('quarantine orgs/{orgId}/quarantine/{uuid}', () => {
    const q = (o: string, id: string) => paths.quarantine(o, id);
    const U1 = '0b6f1c2e-6a7d-4f53-9b1e-2f0c8d3a4e51';
    const U2 = '7d4c2b1a-0e9f-4a8b-8c7d-6e5f4a3b2c1d';

    it('F-1: no quarantine or import upload into an org that is being offboarded', async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc(`orgs/${A.org}`).update({ status: 'offboarding' });
      });
      await assertFails(put(A.users.editor, q(A.org, U1)));
      await assertFails(put(A.users.admin, q(A.org, U2)));
      await assertFails(put(A.users.editor, paths.libraryImportObject(A.org, U1, 'xlsx'), PDF, { contentType: 'application/octet-stream' }));
      await assertSucceeds(put(B.users.editor, q(B.org, U1)));
    });

    it('editor and admin of the org upload (pdf, octet-stream, png, dxf)', async () => {
      await assertSucceeds(put(A.users.editor, q(A.org, U1)));
      await assertSucceeds(put(A.users.admin, q(A.org, U2), PDF, { contentType: 'application/octet-stream' }));
      await assertSucceeds(put(A.users.editor, q(A.org, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'), PDF, { contentType: 'image/png' }));
      await assertSucceeds(put(A.users.editor, q(A.org, 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee'), PDF, { contentType: 'image/vnd.dxf' }));
    });

    it('viewer, reviewer, outsider, other-org editor/admin and anonymous cannot upload', async () => {
      for (const uid of [A.users.viewer, A.users.reviewer, OUTSIDER, B.users.editor, B.users.admin]) {
        await assertFails(put(uid, q(A.org, U1)));
      }
      await assertFails(put(null, q(A.org, U1)));
    });

    it('object name must be a lowercase UUID — no user filename (SEC-13)', async () => {
      const ed = A.users.editor;
      for (const bad of ['plan.pdf', 'f1', U1.toUpperCase(), `${U1}.pdf`, `${U1}x`, '..']) {
        await assertFails(put(ed, q(A.org, bad)));
      }
      await assertFails(put(ed, `${q(A.org, U1)}/nested`));
    });

    it('rejects bad content types, empty and > 100 MB files', async () => {
      const ed = A.users.editor;
      await assertFails(put(ed, q(A.org, U1), PDF, { contentType: 'text/html' }));
      await assertFails(put(ed, q(A.org, U1), PDF, { contentType: 'image/svg+xml' }));
      await assertFails(put(ed, q(A.org, U1), new Uint8Array(0)));
      await assertFails(put(ed, q(A.org, U2), new Uint8Array(100 * 1024 * 1024 + 1)));
    }, 120_000);

    it('no overwrite, no delete, no read — for every role, including the uploader', async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await ctx.storage().ref(q(A.org, U1)).put(PDF, pdfMeta);
      });
      await assertFails(put(A.users.editor, q(A.org, U1)));
      for (const role of ROLES) {
        const ref = st(A.users[role]).ref(q(A.org, U1));
        await assertFails(ref.getMetadata());
        await assertFails(ref.getDownloadURL());
        await assertFails(ref.delete());
      }
      await assertFails(st(A.users.admin).ref(`orgs/${A.org}/quarantine`).listAll());
      await assertFails(st(B.users.admin).ref(q(A.org, U1)).getMetadata());
      await assertFails(st(null).ref(q(A.org, U1)).getMetadata());
    });
  });

  // ---------------------------------------------------------------- Sprint 3: past-BOQ import slot (create only)
  describe('imports orgs/{orgId}/imports/{uuid}.{xls|xlsx}', () => {
    const XLSX_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const XLS_CT = 'application/vnd.ms-excel';
    const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    const imp = (o: string, id: string, ext: 'xls' | 'xlsx') => paths.libraryImportObject(o, id, ext);
    const U1 = '0b6f1c2e-6a7d-4f53-9b1e-2f0c8d3a4e51';
    const U2 = '7d4c2b1a-0e9f-4a8b-8c7d-6e5f4a3b2c1d';

    it('editor and admin create xls/xlsx (spreadsheet or octet-stream type)', async () => {
      await assertSucceeds(put(A.users.editor, imp(A.org, U1, 'xlsx'), ZIP, { contentType: XLSX_CT }));
      await assertSucceeds(put(A.users.admin, imp(A.org, U2, 'xls'), ZIP, { contentType: XLS_CT }));
      await assertSucceeds(put(A.users.editor, imp(A.org, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'xls'), ZIP, { contentType: 'application/octet-stream' }));
    });

    it('viewer, reviewer, other org, outsider and anonymous cannot create', async () => {
      for (const uid of [A.users.viewer, A.users.reviewer, B.users.admin, OUTSIDER]) {
        await assertFails(put(uid, imp(A.org, U1, 'xlsx'), ZIP, { contentType: XLSX_CT }));
      }
      await assertFails(put(null, imp(A.org, U1, 'xlsx'), ZIP, { contentType: XLSX_CT }));
    });

    it('name must be UUID + .xls/.xlsx; types other than spreadsheets rejected; size 0 < n <= 20 MB', async () => {
      const ed = A.users.editor;
      for (const bad of ['boq.xlsx', `${U1}.pdf`, `${U1}.XLSX`, U1, `${U1.toUpperCase()}.xls`, `${U1}.xlsx.html`]) {
        await assertFails(put(ed, `orgs/${A.org}/imports/${bad}`, ZIP, { contentType: XLSX_CT }));
      }
      await assertFails(put(ed, `orgs/${A.org}/imports/${U1}.xlsx/x`, ZIP, { contentType: XLSX_CT }));
      for (const ct of ['text/html', 'image/svg+xml', 'application/pdf', 'application/zip', 'text/csv']) {
        await assertFails(put(ed, imp(A.org, U1, 'xlsx'), ZIP, { contentType: ct }));
      }
      await assertFails(put(ed, imp(A.org, U1, 'xlsx'), new Uint8Array(0), { contentType: XLSX_CT }));
      await assertFails(put(ed, imp(A.org, U2, 'xlsx'), new Uint8Array(20 * 1024 * 1024 + 1), { contentType: XLSX_CT }));
    }, 120_000);

    it('no overwrite, read, list or delete — for every role, including the uploader', async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await ctx.storage().ref(imp(A.org, U1, 'xlsx')).put(ZIP, { contentType: XLSX_CT });
      });
      await assertFails(put(A.users.editor, imp(A.org, U1, 'xlsx'), ZIP, { contentType: XLSX_CT }));
      for (const role of ROLES) {
        const ref = st(A.users[role]).ref(imp(A.org, U1, 'xlsx'));
        await assertFails(ref.getMetadata());
        await assertFails(ref.getDownloadURL());
        await assertFails(ref.delete());
      }
      await assertFails(st(A.users.admin).ref(`orgs/${A.org}/imports`).listAll());
    });
  });

  // ---------------------------------------------------------------- legacy Sprint-0 slot: closed
  it.each(ROLES)('legacy orgs/{orgId}/uploads/{uid}/{fileId} is closed for A %s (no create, read, delete)', async (role) => {
    const uid = A.users[role];
    await assertFails(put(uid, upload(A.org, uid, 'f1')));
    const existing = st(uid).ref(upload(A.org, A.users.editor, 'existing'));
    await assertFails(existing.getMetadata());
    await assertFails(existing.delete());
  });

  // ---------------------------------------------------------------- artifacts / sources: no client access
  describe('artifacts, sources and derived objects: signed URLs only', () => {
    it.each(ROLES)('A %s cannot read or list its own org artifacts / sources directly', async (role) => {
      const c = st(A.users[role]);
      for (const p of serverObjects(A)) {
        await assertFails(c.ref(p).getMetadata());
        await assertFails(c.ref(p).getDownloadURL());
      }
      await assertFails(c.ref(`${paths.artifacts(A.org, A.project, 'set1-p0', 'v1')}/tiles`).listAll());
    });

    it.each(ROLES)('A %s cannot write, overwrite or delete artifacts / sources', async (role) => {
      const c = st(A.users[role]);
      for (const p of serverObjects(A)) {
        await assertFails(Promise.resolve(c.ref(p).put(WEBP, webpMeta)));
        await assertFails(c.ref(p).delete());
      }
      const art = paths.artifacts(A.org, A.project, 'set1-p0', 'v2');
      await assertFails(Promise.resolve(c.ref(`${art}/tiles/0/0_0.webp`).put(WEBP, webpMeta)));
      await assertFails(Promise.resolve(c.ref(`${art}/thumbnail.webp`).put(WEBP, webpMeta)));
    });

    it('cross-org: B members, outsider and anonymous cannot touch org A artifacts', async () => {
      for (const c of [st(B.users.admin), st(B.users.viewer), st(OUTSIDER), st(null)]) {
        for (const p of serverObjects(A)) {
          await assertFails(c.ref(p).getMetadata());
          await assertFails(Promise.resolve(c.ref(p).put(WEBP, webpMeta)));
          await assertFails(c.ref(p).delete());
        }
      }
    });
  });

  it('everything outside the quarantine slot is denied', async () => {
    await assertFails(put(A.users.admin, `orgs/${A.org}/other/f`));
    await assertFails(put(A.users.admin, 'public/f'));
    await assertFails(put(A.users.admin, `orgs/${A.org}/f`));
    await assertFails(put(A.users.admin, `orgs/${A.org}/projects/${A.project}/uploads/set1/f`));
    await assertFails(put(A.users.admin, `orgs/${A.org}/projects/${A.project}/f`));
    await assertFails(put(A.users.admin, `orgs/${A.org}/projects/${A.project}/exports/e2.xlsx`));
    await assertFails(put(A.users.admin, `orgs/${A.org}/projects/${A.project}/boq/b2/evidence.json.gz`));
    await assertFails(st(A.users.admin).ref(`orgs/${A.org}/projects/${A.project}/exports`).listAll());
    await assertFails(st(A.users.admin).ref(`orgs/${A.org}`).listAll());
  });
});
