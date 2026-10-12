/**
 * Storage security-rules tests (emulator, with Firestore for cross-service membership).
 * Skipped unless both FIRESTORE_EMULATOR_HOST and FIREBASE_STORAGE_EMULATOR_HOST are set.
 */
import { assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { A, B, HAS_FIRESTORE_EMULATOR, HAS_STORAGE_EMULATOR, OUTSIDER, createEnv, seed } from './env';

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]); // "%PDF-1.7\n"
const pdfMeta = { contentType: 'application/pdf' };

describe.skipIf(!HAS_FIRESTORE_EMULATOR || !HAS_STORAGE_EMULATOR)('storage.rules', () => {
  let env: RulesTestEnvironment;
  const st = (uid: string | null) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).storage();
  const upload = (o: string, uid: string, file: string) => `orgs/${o}/uploads/${uid}/${file}`;

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
      await ctx.storage().ref(upload(A.org, A.users.editor, 'existing.pdf')).put(PDF, pdfMeta);
      await ctx.storage().ref(`orgs/${A.org}/derived/v1/tiles/0/0/0.webp`).put(PDF, { contentType: 'image/webp' });
    });
  });

  it('editor and admin upload into their own uid folder', async () => {
    await assertSucceeds(Promise.resolve(st(A.users.editor).ref(upload(A.org, A.users.editor, 'f1.pdf')).put(PDF, pdfMeta)));
    await assertSucceeds(Promise.resolve(st(A.users.admin).ref(upload(A.org, A.users.admin, 'f2.dxf')).put(PDF, { contentType: 'application/octet-stream' })));
    await assertSucceeds(Promise.resolve(st(A.users.editor).ref(upload(A.org, A.users.editor, 'f3.png')).put(PDF, { contentType: 'image/png' })));
  });

  it('cannot upload into another user\'s folder', async () => {
    await assertFails(Promise.resolve(st(A.users.editor).ref(upload(A.org, A.users.admin, 'f.pdf')).put(PDF, pdfMeta)));
  });

  it('viewer, reviewer, outsider, other-org editor and anonymous cannot upload', async () => {
    for (const uid of [A.users.viewer, A.users.reviewer, OUTSIDER, B.users.editor]) {
      await assertFails(Promise.resolve(st(uid).ref(upload(A.org, uid, 'f.pdf')).put(PDF, pdfMeta)));
    }
    await assertFails(Promise.resolve(st(null).ref(upload(A.org, 'anon', 'f.pdf')).put(PDF, pdfMeta)));
  });

  it('rejects disallowed content types and empty files', async () => {
    const ed = st(A.users.editor);
    await assertFails(Promise.resolve(ed.ref(upload(A.org, A.users.editor, 'x.html')).put(PDF, { contentType: 'text/html' })));
    await assertFails(Promise.resolve(ed.ref(upload(A.org, A.users.editor, 'x.svg')).put(PDF, { contentType: 'image/svg+xml' })));
    await assertFails(Promise.resolve(ed.ref(upload(A.org, A.users.editor, 'empty.pdf')).put(new Uint8Array(0), pdfMeta)));
  });

  it('rejects files over 100 MB', async () => {
    const big = new Uint8Array(100 * 1024 * 1024 + 1);
    await assertFails(Promise.resolve(st(A.users.editor).ref(upload(A.org, A.users.editor, 'big.pdf')).put(big, pdfMeta)));
  }, 120_000);

  it('no overwrite and no delete from the client', async () => {
    const ref = st(A.users.editor).ref(upload(A.org, A.users.editor, 'existing.pdf'));
    await assertFails(Promise.resolve(ref.put(PDF, pdfMeta)));
    await assertFails(ref.delete());
    await assertFails(st(A.users.admin).ref(upload(A.org, A.users.editor, 'existing.pdf')).delete());
  });

  it('uploads are readable by org members only', async () => {
    await assertSucceeds(st(A.users.viewer).ref(upload(A.org, A.users.editor, 'existing.pdf')).getMetadata());
    await assertFails(st(B.users.admin).ref(upload(A.org, A.users.editor, 'existing.pdf')).getMetadata());
    await assertFails(st(null).ref(upload(A.org, A.users.editor, 'existing.pdf')).getMetadata());
  });

  it('derived artifacts: member read, never client write', async () => {
    const path = `orgs/${A.org}/derived/v1/tiles/0/0/0.webp`;
    await assertSucceeds(st(A.users.viewer).ref(path).getMetadata());
    await assertFails(st(B.users.viewer).ref(path).getMetadata());
    await assertFails(Promise.resolve(st(A.users.admin).ref(`orgs/${A.org}/derived/v1/evil.webp`).put(PDF, { contentType: 'image/webp' })));
    await assertFails(st(A.users.admin).ref(path).delete());
  });

  it('everything outside orgs/{orgId}/uploads|derived is denied', async () => {
    await assertFails(Promise.resolve(st(A.users.admin).ref(`orgs/${A.org}/other/f.pdf`).put(PDF, pdfMeta)));
    await assertFails(Promise.resolve(st(A.users.admin).ref(`public/f.pdf`).put(PDF, pdfMeta)));
    await assertFails(Promise.resolve(st(A.users.admin).ref(`orgs/${A.org}/f.pdf`).put(PDF, pdfMeta)));
  });
});
