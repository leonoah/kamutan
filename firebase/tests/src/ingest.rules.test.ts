/**
 * Sprint 1 (ingest) Firestore rules: sheets, sheets/{id}/versions, top-level jobs — with the exact
 * document shapes of docs/agents/SPRINT1_BRIEF.md. Emulator only (skips without FIRESTORE_EMULATOR_HOST).
 *
 * Contract under test:
 *  - every member role of the org reads sheets / versions / jobs (get, list, listeners);
 *  - other orgs, outsiders and anonymous callers read nothing (get, list, collection group);
 *  - NO client writes on any of them, for any role — sheet confirm / region edits are API calls;
 *  - jobs list queries must filter by the caller's orgId; a job without a string orgId is unreadable.
 */
import { assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { ROLES } from '../../model';
import { A, B, FieldValue, HAS_FIRESTORE_EMULATOR, OUTSIDER, Timestamp, createEnv, seed, type OrgFx } from './env';

const SET = 'set-abc';
const SHEET = `${SET}-p0`;
const VERSION = 'v1';
const ts = () => Timestamp.fromDate(new Date('2026-10-12T00:00:00Z'));

function ingestPaths(f: OrgFx) {
  const p = `orgs/${f.org}/projects/${f.project}`;
  const prefix = `${p}/sheets/${SHEET}/versions/${VERSION}`;
  return {
    sheets: `${p}/sheets`,
    sheet: `${p}/sheets/${SHEET}`,
    versions: `${p}/sheets/${SHEET}/versions`,
    version: prefix,
    job: `jobs/ingest-${f.org}`,
    artifactPrefix: prefix,
  };
}

function sheetDoc() {
  return {
    sheetSetId: SET,
    pageIndex: 0,
    title: 'תוכנית חשמל קומה א',
    discipline: 'electrical',
    floors: ['1'],
    scaleDenominator: 50,
    classification: {
      discipline: 'electrical', floors: ['1'], sheetTitle: 'תוכנית חשמל קומה א', scaleText: '1:50',
      confidence: 0.91, level: 'yellow', reasons: ['FLOOR_FROM_TITLE'],
    },
    confirmed: false,
    currentVersionId: VERSION,
    updatedAt: ts(),
  };
}

function versionDoc(f: OrgFx) {
  const prefix = ingestPaths(f).artifactPrefix;
  return {
    status: 'ready',
    progress: { stage: 'done', pct: 100 },
    page: { widthMm: 420, heightMm: 297, rotation: 0 },
    artifacts: {
      tiles: { prefix: `${prefix}/tiles`, format: 'webp', tileSize: 256, dpi: 300, levels: 7, widthPx: 4961, heightPx: 3508 },
      primitives: `${prefix}/primitives.msgpack.gz`,
      text: `${prefix}/text.json.gz`,
      thumbnail: `${prefix}/thumbnail.webp`,
    },
    regions: [{ id: 'r1', floor: '1', polygonMm: [[0, 0], [420, 0], [420, 297], [0, 297]], scaleDenominator: 50 }],
    stats: { paths: 1200, segments: 5400, textLines: 80, glyphs: 900 },
    workerVersion: '0.1.0',
    updatedAt: ts(),
  };
}

function jobDoc(f: OrgFx) {
  return {
    orgId: f.org, projectId: f.project, sheetSetId: SET, type: 'ingest.sheet_version',
    status: 'running', progress: 40, attempts: 1, updatedAt: ts(), createdAt: ts(),
  };
}

describe.skipIf(!HAS_FIRESTORE_EMULATOR)('firestore.rules — Sprint 1 ingest collections', () => {
  let env: RulesTestEnvironment;
  const db = (uid: string | null) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();
  const a = ingestPaths(A);
  const b = ingestPaths(B);

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
      const fs = ctx.firestore();
      for (const f of [A, B]) {
        const p = ingestPaths(f);
        await fs.doc(p.sheet).set(sheetDoc());
        await fs.doc(p.version).set(versionDoc(f));
        await fs.doc(p.job).set(jobDoc(f));
      }
      await fs.doc('jobs/orphan').set({ projectId: A.project, type: 'ingest.sheet_version', status: 'queued', progress: 0 });
      await fs.doc('jobs/numeric-org').set({ orgId: 42, type: 'ingest.sheet_version', status: 'queued', progress: 0 });
    });
  });

  // ---------------------------------------------------------------- reads
  describe('reads', () => {
    it.each(ROLES)('A %s reads sheet, version and job of org A (get + list)', async (role) => {
      const c = db(A.users[role]);
      await assertSucceeds(c.doc(a.sheet).get());
      await assertSucceeds(c.collection(a.sheets).get());
      await assertSucceeds(c.doc(a.version).get());
      await assertSucceeds(c.collection(a.versions).get());
      await assertSucceeds(c.doc(a.job).get());
      await assertSucceeds(c.collection('jobs').where('orgId', '==', A.org).get());
      await assertSucceeds(c.collection('jobs').where('orgId', '==', A.org).where('projectId', '==', A.project).get());
    });

    it.each(ROLES)('B %s cannot read any org A ingest document (cross-org)', async (role) => {
      const c = db(B.users[role]);
      await assertFails(c.doc(a.sheet).get());
      await assertFails(c.collection(a.sheets).get());
      await assertFails(c.doc(a.version).get());
      await assertFails(c.collection(a.versions).get());
      await assertFails(c.doc(a.job).get());
      await assertFails(c.collection('jobs').where('orgId', '==', A.org).get());
    });

    it('outsider and anonymous read nothing', async () => {
      for (const c of [db(OUTSIDER), db(null)]) {
        await assertFails(c.doc(a.sheet).get());
        await assertFails(c.collection(a.sheets).get());
        await assertFails(c.doc(a.version).get());
        await assertFails(c.doc(a.job).get());
        await assertFails(c.collection('jobs').where('orgId', '==', A.org).get());
      }
    });

    it('jobs: an unfiltered or wrongly filtered list is denied', async () => {
      const c = db(A.users.admin);
      await assertFails(c.collection('jobs').get());
      await assertFails(c.collection('jobs').where('projectId', '==', A.project).get());
      await assertFails(c.collection('jobs').where('orgId', 'in', [A.org, B.org]).get());
      await assertFails(c.collection('jobs').where('orgId', '==', B.org).get());
    });

    it('jobs: a job without a string orgId is unreadable, even for admins', async () => {
      await assertFails(db(A.users.admin).doc('jobs/orphan').get());
      await assertFails(db(A.users.admin).doc('jobs/numeric-org').get());
    });

    it('collection-group queries on sheets / versions are denied (no cross-org enumeration)', async () => {
      await assertFails(db(A.users.admin).collectionGroup('sheets').get());
      await assertFails(db(A.users.admin).collectionGroup('versions').get());
      await assertFails(db(A.users.admin).collectionGroup('sheets').where('sheetSetId', '==', SET).get());
    });

    it('a user in two orgs reads both orgs ingest docs', async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc(`orgs/${B.org}/members/${A.users.viewer}`).set({ uid: A.users.viewer, role: 'viewer', createdAt: ts() });
      });
      await assertSucceeds(db(A.users.viewer).doc(b.sheet).get());
      await assertSucceeds(db(A.users.viewer).collection('jobs').where('orgId', '==', B.org).get());
    });
  });

  // ---------------------------------------------------------------- writes
  describe('no client writes (worker / API only)', () => {
    it.each(ROLES)('A %s cannot confirm or edit a sheet', async (role) => {
      const uid = A.users[role];
      const c = db(uid);
      await assertFails(c.doc(a.sheet).update({ confirmed: true, confirmedBy: uid, confirmedAt: FieldValue.serverTimestamp() }));
      await assertFails(c.doc(a.sheet).update({ floors: ['2'], discipline: 'plumbing', scaleDenominator: 100 }));
      await assertFails(c.doc(a.sheet).update({ 'classification.level': 'green', 'classification.confidence': 1 }));
      await assertFails(c.doc(a.sheet).update({ currentVersionId: 'v-evil' }));
      await assertFails(c.doc(a.sheet).set(sheetDoc()));
      await assertFails(c.doc(a.sheet).delete());
      await assertFails(c.doc(`${a.sheets}/${SET}-p9`).set(sheetDoc()));
    });

    it.each(ROLES)('A %s cannot write sheet versions (status, regions, artifacts)', async (role) => {
      const c = db(A.users[role]);
      await assertFails(c.doc(a.version).update({ regions: [] }));
      await assertFails(c.doc(a.version).update({ status: 'failed' }));
      await assertFails(c.doc(a.version).update({ 'artifacts.tiles.prefix': `orgs/${B.org}/projects/${B.project}/sheets/x/versions/y/tiles` }));
      await assertFails(c.doc(a.version).delete());
      await assertFails(c.doc(`${a.versions}/v2`).set(versionDoc(A)));
    });

    it.each(ROLES)('A %s cannot create, update or delete jobs', async (role) => {
      const c = db(A.users[role]);
      await assertFails(c.doc('jobs/new').set(jobDoc(A)));
      await assertFails(c.doc(a.job).update({ status: 'succeeded', progress: 100 }));
      await assertFails(c.doc(a.job).update({ orgId: B.org }));
      await assertFails(c.doc(a.job).delete());
    });

    it('other-org, outsider and anonymous writes are denied', async () => {
      for (const c of [db(B.users.admin), db(OUTSIDER), db(null)]) {
        await assertFails(c.doc(a.sheet).update({ confirmed: true }));
        await assertFails(c.doc(a.version).update({ regions: [] }));
        await assertFails(c.doc(a.job).update({ status: 'failed' }));
        await assertFails(c.doc(`${a.sheets}/injected`).set(sheetDoc()));
      }
    });
  });
});
