/**
 * Sprint 2 (understanding) rules — emulator only (skips without FIRESTORE_EMULATOR_HOST; Storage part also needs
 * FIREBASE_STORAGE_EMULATOR_HOST).
 *
 * Contract under test (docs/agents/SPRINT2_BRIEF.md, 06_security):
 *  - orgs/{o}/projects/{p}/legendEntries/* and orgs/{o}/symbolMappings/* are readable by every member role of the
 *    org and by nobody else; NO client writes for any role (confirm/ignore/reassign/resolve are API calls, audited);
 *  - Storage: legend.json.gz / detections.json.gz / rooms.json.gz, legend/{entryId}.webp, unknown/{clusterId}.webp and
 *    the per-org llm-cache/** are neither readable nor writable by any client (signed URLs from the API only;
 *    llm-cache never leaves the worker).
 */
import { assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { ROLES, paths } from '../../model';
import { A, B, FieldValue, HAS_FIRESTORE_EMULATOR, HAS_STORAGE_EMULATOR, OUTSIDER, Timestamp, createEnv, seed, type OrgFx } from './env';

const SHEET = 'set1-p0';
const VERSION = 'v1';
const SIG = 'ab'.repeat(20);
const ENTRY = `le_${SHEET}_0`;
const ts = () => Timestamp.fromDate(new Date('2026-10-13T00:00:00Z'));

function legendDoc(f: OrgFx) {
  return {
    sheetId: SHEET, versionId: VERSION, label: 'שקע כפול', labelConfidence: 0.93, suggestedClass: 'socket_double', class: null,
    itemCode: null, signature: SIG, thumbPath: paths.legendThumb(f.org, f.project, SHEET, VERSION, ENTRY), status: 'suggested', updatedAt: ts(),
  };
}
const mappingDoc = (f: OrgFx) => ({ class: 'socket_double', ignored: false, itemCode: '08.010', label: 'שקע כפול', confirmedBy: f.users.editor, confirmedAt: ts(), uses: 1 });

const fsp = (f: OrgFx) => ({
  entries: `orgs/${f.org}/projects/${f.project}/legendEntries`,
  entry: paths.legendEntry(f.org, f.project, ENTRY),
  mappings: `orgs/${f.org}/symbolMappings`,
  mapping: paths.symbolMapping(f.org, SIG),
});

describe.skipIf(!HAS_FIRESTORE_EMULATOR)('firestore.rules — Sprint 2 legendEntries + symbolMappings', () => {
  let env: RulesTestEnvironment;
  const db = (uid: string | null) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();
  const a = fsp(A);

  beforeAll(async () => {
    env = await createEnv();
  });
  afterAll(async () => {
    await env?.cleanup();
  });
  beforeEach(async () => {
    await env.clearFirestore();
    await seed(env);
    await env.withSecurityRulesDisabled(async (ctx) => {
      for (const f of [A, B]) {
        await ctx.firestore().doc(fsp(f).entry).set(legendDoc(f));
        await ctx.firestore().doc(fsp(f).mapping).set(mappingDoc(f));
      }
    });
  });

  it.each(ROLES)('A %s reads legend entries and org symbol mappings (get + list + status query)', async (role) => {
    const c = db(A.users[role]);
    await assertSucceeds(c.doc(a.entry).get());
    await assertSucceeds(c.collection(a.entries).get());
    await assertSucceeds(c.collection(a.entries).where('status', '==', 'suggested').get());
    await assertSucceeds(c.doc(a.mapping).get());
    await assertSucceeds(c.collection(a.mappings).get());
  });

  it.each(ROLES)('B %s cannot read org A legend entries or mappings', async (role) => {
    const c = db(B.users[role]);
    await assertFails(c.doc(a.entry).get());
    await assertFails(c.collection(a.entries).get());
    await assertFails(c.doc(a.mapping).get());
    await assertFails(c.collection(a.mappings).get());
  });

  it('outsider / anonymous read nothing; collection-group enumeration is denied', async () => {
    for (const c of [db(OUTSIDER), db(null)]) {
      await assertFails(c.doc(a.entry).get());
      await assertFails(c.doc(a.mapping).get());
    }
    await assertFails(db(A.users.admin).collectionGroup('legendEntries').get());
    await assertFails(db(A.users.admin).collectionGroup('symbolMappings').get());
  });

  it.each(ROLES)('A %s cannot confirm, ignore, create or delete legend entries', async (role) => {
    const uid = A.users[role];
    const c = db(uid);
    await assertFails(c.doc(a.entry).update({ status: 'confirmed', class: 'socket_double', confirmedBy: uid, confirmedAt: FieldValue.serverTimestamp() }));
    await assertFails(c.doc(a.entry).update({ status: 'ignored' }));
    await assertFails(c.doc(a.entry).update({ itemCode: '1.1' }));
    await assertFails(c.doc(a.entry).set(legendDoc(A)));
    await assertFails(c.doc(`${a.entries}/le_injected_0`).set({ ...legendDoc(A), status: 'confirmed' }));
    await assertFails(c.doc(a.entry).delete());
  });

  it.each(ROLES)('A %s cannot write org symbol mappings (no forged "learned" mappings)', async (role) => {
    const c = db(A.users[role]);
    await assertFails(c.doc(a.mapping).update({ class: 'socket_power', uses: 99 }));
    await assertFails(c.doc(a.mapping).update({ ignored: true, class: null }));
    await assertFails(c.doc(`${a.mappings}/${'cd'.repeat(20)}`).set(mappingDoc(A)));
    await assertFails(c.doc(a.mapping).delete());
  });

  it('other-org, outsider and anonymous writes are denied', async () => {
    for (const c of [db(B.users.admin), db(OUTSIDER), db(null)]) {
      await assertFails(c.doc(a.entry).update({ status: 'confirmed' }));
      await assertFails(c.doc(a.mapping).set(mappingDoc(A)));
    }
  });
});

describe.skipIf(!HAS_FIRESTORE_EMULATOR || !HAS_STORAGE_EMULATOR)('storage.rules — Sprint 2 artifacts, crops, llm-cache', () => {
  let env: RulesTestEnvironment;
  const st = (uid: string | null) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).storage();
  const GZ = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]);
  const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  const objects = (f: OrgFx) => [
    paths.legendArtifact(f.org, f.project, SHEET, VERSION),
    paths.detectionsArtifact(f.org, f.project, SHEET, VERSION),
    paths.roomsArtifact(f.org, f.project, SHEET, VERSION),
    paths.legendThumb(f.org, f.project, SHEET, VERSION, ENTRY),
    paths.unknownThumb(f.org, f.project, SHEET, VERSION, 'u_0'),
    paths.llmCache(f.org, 'legend_label/3f2a.json'),
  ];

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
      for (const f of [A, B]) {
        for (const p of objects(f)) {
          const webp = p.endsWith('.webp');
          await ctx.storage().ref(p).put(webp ? WEBP : GZ, { contentType: webp ? 'image/webp' : 'application/gzip' });
        }
      }
    });
  });

  it.each(ROLES)('A %s can neither read nor write any Sprint-2 object of its own org', async (role) => {
    const s = st(A.users[role]);
    for (const p of objects(A)) {
      await assertFails(s.ref(p).getDownloadURL());
      await assertFails(s.ref(p).getMetadata());
      await assertFails(Promise.resolve(s.ref(p).put(WEBP, { contentType: 'image/webp' })));
      await assertFails(s.ref(p).delete());
    }
    await assertFails(s.ref(`orgs/${A.org}/llm-cache`).listAll());
  });

  it('other org, outsider and anonymous get nothing either', async () => {
    for (const uid of [B.users.admin, OUTSIDER, null]) {
      for (const p of objects(A)) {
        await assertFails(st(uid).ref(p).getDownloadURL());
        await assertFails(Promise.resolve(st(uid).ref(p).put(GZ, { contentType: 'application/gzip' })));
      }
    }
  });
});
