/**
 * Firestore security-rules tests (emulator). Mirrors the former Postgres RLS suite:
 * tenant isolation, role rules, BOQ approval, append-only audit, server-only collections.
 * Skipped unless FIRESTORE_EMULATOR_HOST is set — run with `pnpm test:emulator`.
 */
import { assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { A, B, FieldValue, HAS_FIRESTORE_EMULATOR, OUTSIDER, Timestamp, createEnv, docPaths, seed } from './env';

const a = docPaths(A);
const b = docPaths(B);

describe.skipIf(!HAS_FIRESTORE_EMULATOR)('firestore.rules', () => {
  let env: RulesTestEnvironment;
  const db = (uid: string | null) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();

  beforeAll(async () => {
    env = await createEnv();
  });
  afterAll(async () => {
    await env?.cleanup();
  });
  beforeEach(async () => {
    await env.clearFirestore();
    await seed(env);
  });

  // -------------------------------------------------------------------------
  describe('tenant isolation', () => {
    const memberReadable = [
      'org', 'member', 'project', 'sheetSet', 'sheet', 'version', 'legendEntry', 'reviewItem', 'correction',
      'boqDraft', 'itemLibrary', 'boqTemplate', 'symbolMapping', 'job', 'boqRule', 'libraryImport', 'boqBuild', 'boqExport',
      'correctionBatch', 'roomSettings', 'similarSearch',
    ] as const;

    it.each(memberReadable)('%s: org A viewer reads A, never B', async (k) => {
      await assertSucceeds(db(A.users.viewer).doc(a[k]).get());
      await assertFails(db(A.users.viewer).doc(b[k]).get());
    });

    it.each(memberReadable)('%s: outsider and unauthenticated read nothing', async (k) => {
      await assertFails(db(OUTSIDER).doc(a[k]).get());
      await assertFails(db(null).doc(a[k]).get());
    });

    it('org A admin cannot read org B audit log, share links or members', async () => {
      await assertFails(db(A.users.admin).doc(b.auditEvent).get());
      await assertFails(db(A.users.admin).doc(b.shareLink).get());
      await assertFails(db(A.users.admin).collection(`orgs/${B.org}/members`).get());
    });

    it('org A cannot list org B collections', async () => {
      await assertFails(db(A.users.admin).collection(`orgs/${B.org}/projects/${B.project}/boqLines`).get());
      await assertSucceeds(db(A.users.admin).collection(`orgs/${A.org}/projects/${A.project}/boqLines`).get());
    });

    it('jobs: members list their org jobs by orgId only', async () => {
      await assertSucceeds(db(A.users.viewer).collection('jobs').where('orgId', '==', A.org).get());
      await assertFails(db(A.users.viewer).collection('jobs').where('orgId', '==', B.org).get());
      await assertFails(db(A.users.viewer).collection('jobs').get());
      await assertFails(db(OUTSIDER).collection('jobs').where('orgId', '==', A.org).get());
    });

    it('a user finds their own memberships via collection group, not others', async () => {
      await assertSucceeds(db(A.users.editor).collectionGroup('members').where('uid', '==', A.users.editor).get());
      await assertFails(db(A.users.editor).collectionGroup('members').where('uid', '==', B.users.editor).get());
    });

    it('a user in two orgs reads both', async () => {
      await env.withSecurityRulesDisabled((ctx) =>
        ctx.firestore().doc(`orgs/${B.org}/members/${A.users.editor}`).set({ uid: A.users.editor, role: 'viewer' }));
      await assertSucceeds(db(A.users.editor).doc(b.project).get());
      await assertSucceeds(db(A.users.editor).doc(a.project).get());
    });
  });

  // -------------------------------------------------------------------------
  describe('server-only collections: client writes denied (even admin)', () => {
    const serverOnly = [
      'org', 'member', 'project', 'sheetSet', 'sheet', 'version', 'legendEntry', 'shareLink',
      'itemLibrary', 'boqTemplate', 'symbolMapping', 'auditEvent', 'job', 'boqRule', 'libraryImport', 'boqBuild', 'boqExport',
    ] as const;

    it.each(serverOnly)('%s: admin cannot create/update/delete', async (k) => {
      const admin = db(A.users.admin);
      await assertFails(admin.doc(`${a[k]}-new`).set({ name: 'x' }));
      await assertFails(admin.doc(a[k]).update({ touched: true }));
      await assertFails(admin.doc(a[k]).delete());
    });

    it('members: only the API manages memberships (no self-promotion)', async () => {
      await assertFails(db(A.users.viewer).doc(`orgs/${A.org}/members/${A.users.viewer}`).update({ role: 'admin' }));
      await assertFails(db(OUTSIDER).doc(`orgs/${A.org}/members/${OUTSIDER}`).set({ uid: OUTSIDER, role: 'admin' }));
      await assertFails(db(A.users.admin).doc(`orgs/${A.org}/members/${OUTSIDER}`).set({ uid: OUTSIDER, role: 'viewer' }));
    });

    it('projects: clients cannot create projects', async () => {
      await assertFails(db(A.users.admin).collection(`orgs/${A.org}/projects`).add({ name: 'x' }));
    });

    it('auditLog: append-only and admin-read only', async () => {
      await assertSucceeds(db(A.users.admin).doc(a.auditEvent).get());
      for (const uid of [A.users.editor, A.users.reviewer, A.users.viewer]) {
        await assertFails(db(uid).doc(a.auditEvent).get());
      }
      await assertFails(db(A.users.admin).collection(`orgs/${A.org}/auditLog`).add({ action: 'forged' }));
      await assertFails(db(A.users.admin).doc(a.auditEvent).update({ action: 'tampered' }));
      await assertFails(db(A.users.admin).doc(a.auditEvent).delete());
    });

    it('shareLinks (Sprint 5): never client-readable (tokenHash), not even by admin; nobody writes or revokes from client', async () => {
      for (const role of ['admin', 'editor', 'reviewer', 'viewer'] as const) {
        await assertFails(db(A.users[role]).doc(a.shareLink).get());
        await assertFails(db(A.users[role]).collection(`orgs/${A.org}/projects/${A.project}/shareLinks`).get());
      }
      await assertFails(db(A.users.editor).doc(a.shareLink).update({ revokedAt: FieldValue.serverTimestamp() }));
      await assertFails(db(A.users.admin).collectionGroup('shareLinks').get());
    });

    it('jobs: clients cannot create or update job progress', async () => {
      await assertFails(db(A.users.admin).collection('jobs').add({ orgId: A.org, type: 'x', status: 'queued', progress: 0 }));
      await assertFails(db(A.users.admin).doc(a.job).update({ progress: 100 }));
    });
  });

  // -------------------------------------------------------------------------
  describe('Sprint 4: corrections, correctionBatches, roomSettings, similarSearches are API-only', () => {
    const corrPath = (id: string) => `orgs/${A.org}/projects/${A.project}/corrections/${id}`;
    const brief = (uid: string) => ({
      kind: 'accept', sheetId: 'sheet1', versionId: 'v1', anchorMm: { x: 1, y: 2 }, radiusMm: 3, detectionId: 'd_1', signature: null, class: null, itemCode: null,
      linkGroupId: null, geometry: null, quantity: null, unit: null, roomId: null, floor: null, reason: null, batchId: null, by: uid, at: FieldValue.serverTimestamp(), revertedAt: null,
    });
    // the Sprint-0 client shape that used to be allowed
    const legacy = (uid: string) => ({ authorId: uid, createdAt: FieldValue.serverTimestamp(), targetType: 'detection', targetId: 'det-42', action: 'reclass' });

    it.each(['admin', 'editor', 'reviewer', 'viewer'] as const)('%s cannot create corrections (brief or legacy shape)', async (role) => {
      const uid = A.users[role];
      await assertFails(db(uid).doc(corrPath(`n-${role}`)).set(brief(uid)));
      await assertFails(db(uid).doc(corrPath(`l-${role}`)).set(legacy(uid)));
    });

    it.each(['admin', 'editor', 'reviewer'] as const)('%s cannot revert / edit / delete a correction (undo goes through the API)', async (role) => {
      const uid = A.users[role];
      await assertFails(db(uid).doc(a.correction).update({ revertedAt: FieldValue.serverTimestamp() }));
      await assertFails(db(uid).doc(a.correction).update({ kind: 'reject' }));
      await assertFails(db(uid).doc(a.correction).delete());
    });

    it.each(['correctionBatch', 'roomSettings', 'similarSearch'] as const)('%s: members read; no role writes; other org / outsider read nothing', async (k) => {
      for (const role of ['admin', 'editor', 'reviewer', 'viewer'] as const) {
        await assertSucceeds(db(A.users[role]).doc(a[k]).get());
        await assertFails(db(A.users[role]).doc(a[k]).set({ x: 1 }, { merge: true }));
        await assertFails(db(A.users[role]).doc(a[k]).delete());
        await assertFails(db(A.users[role]).doc(`${a[k]}-new`).set({ x: 1 }));
      }
      await assertFails(db(B.users.admin).doc(a[k]).get());
      await assertFails(db(OUTSIDER).doc(a[k]).get());
      await assertFails(db(null).doc(a[k]).get());
    });

    it('members list corrections of their project (history panel), never another org', async () => {
      await assertSucceeds(db(A.users.viewer).collection(`orgs/${A.org}/projects/${A.project}/corrections`).where('sheetId', '==', 'sheet1').get());
      await assertFails(db(A.users.viewer).collection(`orgs/${B.org}/projects/${B.project}/corrections`).get());
      await assertFails(db(A.users.admin).collectionGroup('corrections').get());
    });

    it('a worker-looking similar result cannot be forged by a client', async () => {
      await assertFails(db(A.users.reviewer).doc(a.similarSearch).update({ status: 'succeeded', candidates: [{ id: 'c_1' }] }));
    });
  });

  // -------------------------------------------------------------------------
  describe('Sprint 5: exports, offboarding exports, token index, certificates, audit head, reprocess requests', () => {
    it('exports (xlsx + marked PDF records): project members read, nobody writes; other org / outsider / anon nothing', async () => {
      for (const role of ['admin', 'editor', 'reviewer', 'viewer'] as const) {
        await assertSucceeds(db(A.users[role]).doc(a.markedPdfExport).get());
        await assertFails(db(A.users[role]).doc(a.markedPdfExport).update({ status: 'ready' }));
        await assertFails(db(A.users[role]).doc(`${a.markedPdfExport}-new`).set({ kind: 'marked_pdf' }));
      }
      await assertFails(db(B.users.admin).doc(a.markedPdfExport).get());
      await assertFails(db(OUTSIDER).doc(a.markedPdfExport).get());
      await assertFails(db(null).doc(a.markedPdfExport).get());
    });

    it('offboardingExports: admin read only; no client writes', async () => {
      await assertSucceeds(db(A.users.admin).doc(a.offboardingExport).get());
      for (const role of ['editor', 'reviewer', 'viewer'] as const) await assertFails(db(A.users[role]).doc(a.offboardingExport).get());
      await assertFails(db(B.users.admin).doc(a.offboardingExport).get());
      await assertFails(db(A.users.admin).doc(a.offboardingExport).update({ status: 'ready' }));
    });

    it.each(['shareToken', 'certificate', 'auditHead', 'reprocessRequest'] as const)('%s: no client access at all', async (k) => {
      for (const uid of [A.users.admin, A.users.editor, A.users.viewer, B.users.admin, OUTSIDER, null]) {
        await assertFails(db(uid).doc(a[k]).get());
        await assertFails(db(uid).doc(a[k]).set({ x: 1 }));
      }
    });
  });

  // -------------------------------------------------------------------------
  // Security gate F-1 (SEC-52): an org being offboarded is closed to its members (adapted from the gate PoC).
  describe('F-1: offboarding org — every member read / write denied except the org doc + offboarding exports', () => {
    const offboard = (org: string) => env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`orgs/${org}`).update({ status: 'offboarding', deleteAfter: Timestamp.fromDate(new Date(Date.now() + 30 * 864e5)) });
    });
    // `member` (= the viewer's OWN membership doc) is not in this list: the self-read rule for the
    // "which orgs am I in" collection-group query stays open on purpose (own uid/role only, no org content);
    // other members' docs are closed — see the explicit test below.
    const closed = [
      'project', 'sheetSet', 'sheet', 'version', 'legendEntry', 'reviewItem', 'correction', 'boqDraft', 'itemLibrary',
      'boqTemplate', 'symbolMapping', 'job', 'boqRule', 'libraryImport', 'boqBuild', 'boqExport', 'correctionBatch', 'roomSettings',
      'similarSearch', 'markedPdfExport', 'auditEvent',
    ] as const;

    it.each(closed)('%s: readable while active, denied for every role once offboarding', async (k) => {
      await assertSucceeds(db(A.users.admin).doc(a[k]).get());
      await offboard(A.org);
      for (const role of ['admin', 'editor', 'reviewer', 'viewer'] as const) await assertFails(db(A.users[role]).doc(a[k]).get());
      // the other org is unaffected
      await assertSucceeds(db(B.users.viewer).doc(b.project).get());
    });

    it('PoC: viewer cannot read project (address), BOQ lines or list sheets; reviewer cannot resolve a review item', async () => {
      await offboard(A.org);
      await assertFails(db(A.users.viewer).doc(a.project).get());
      await assertFails(db(A.users.viewer).doc(a.boqDraft).get());
      await assertFails(db(A.users.viewer).collection(`orgs/${A.org}/projects/${A.project}/sheets`).get());
      await assertFails(db(A.users.viewer).collection('jobs').where('orgId', '==', A.org).get());
      await assertFails(
        db(A.users.reviewer).doc(a.reviewItem).update({ status: 'resolved', resolution: 'x', resolvedBy: A.users.reviewer, resolvedAt: FieldValue.serverTimestamp() }),
      );
    });

    it("members: own membership stays readable (org discovery → blocked screen), other members' docs are denied", async () => {
      await offboard(A.org);
      await assertSucceeds(db(A.users.viewer).doc(a.member).get());
      for (const role of ['admin', 'editor', 'reviewer'] as const) await assertFails(db(A.users[role]).doc(a.member).get());
      await assertFails(db(A.users.admin).collection(`orgs/${A.org}/members`).get());
    });

    it('still visible: the org doc (status for the blocked screen) to members, offboarding exports to the admin', async () => {
      await offboard(A.org);
      for (const role of ['admin', 'editor', 'reviewer', 'viewer'] as const) await assertSucceeds(db(A.users[role]).doc(a.org).get());
      await assertSucceeds(db(A.users.admin).doc(a.offboardingExport).get());
      await assertFails(db(A.users.editor).doc(a.offboardingExport).get());
      await assertFails(db(B.users.admin).doc(a.org).get());
    });
  });

  // -------------------------------------------------------------------------
  describe('reviewItems: status/resolution only', () => {
    const resolve = (uid: string) => ({
      status: 'resolved',
      resolution: 'אומת מול המקרא',
      resolvedBy: uid,
      resolvedAt: FieldValue.serverTimestamp(),
    });

    it('editor and reviewer resolve; viewer cannot', async () => {
      await assertSucceeds(db(A.users.editor).doc(a.reviewItem).update(resolve(A.users.editor)));
      await env.clearFirestore();
      await seed(env);
      await assertSucceeds(db(A.users.reviewer).doc(a.reviewItem).update(resolve(A.users.reviewer)));
      await assertFails(db(A.users.viewer).doc(a.reviewItem).update(resolve(A.users.viewer)));
      await assertFails(db(B.users.editor).doc(a.reviewItem).update(resolve(B.users.editor)));
    });

    it('cannot touch other fields or forge resolver/time', async () => {
      const uid = A.users.editor;
      await assertFails(db(uid).doc(a.reviewItem).update({ ...resolve(uid), level: 'green' }));
      await assertFails(db(uid).doc(a.reviewItem).update({ level: 'green' }));
      await assertFails(db(uid).doc(a.reviewItem).update({ ...resolve(uid), resolvedBy: A.users.reviewer }));
      await assertFails(db(uid).doc(a.reviewItem).update({ ...resolve(uid), resolvedAt: Timestamp.now() }));
      await assertFails(db(uid).doc(a.reviewItem).update({ ...resolve(uid), status: 'closed' }));
      await assertFails(db(uid).doc(a.reviewItem).update({ ...resolve(uid), resolution: 'x'.repeat(2001) }));
    });

    it('can be re-opened (resolver cleared); cannot be created or deleted', async () => {
      const uid = A.users.reviewer;
      await assertSucceeds(db(uid).doc(a.reviewItem).update(resolve(uid)));
      await assertSucceeds(db(uid).doc(a.reviewItem).update({ status: 'open', resolvedBy: null, resolvedAt: null }));
      await assertFails(db(uid).doc(`${a.reviewItem}-new`).set({ level: 'red', reasons: [], clusterId: null, status: 'open' }));
      await assertFails(db(A.users.admin).doc(a.reviewItem).delete());
    });
  });

  // -------------------------------------------------------------------------
  describe('boqLines: API-only since Sprint 3 (no client write for any role)', () => {
    const review = (uid: string) => ({ status: 'reviewed', reviewedBy: uid, reviewedAt: FieldValue.serverTimestamp() });
    const approve = (uid: string) => ({ status: 'approved', approvedBy: uid, approvedAt: FieldValue.serverTimestamp() });
    const roles = () => [A.users.admin, A.users.editor, A.users.reviewer, A.users.viewer];

    it('members read lines; outsiders and other orgs do not', async () => {
      for (const uid of roles()) await assertSucceeds(db(uid).doc(a.boqDraft).get());
      await assertFails(db(A.users.admin).doc(b.boqDraft).get());
      await assertFails(db(OUTSIDER).doc(a.boqDraft).get());
    });

    it('former client transitions are denied for every role (status goes through PATCH /boq/lines/:id)', async () => {
      for (const uid of roles()) {
        await assertFails(db(uid).doc(a.boqDraft).update(review(uid)));
        await assertFails(db(uid).doc(a.boqReviewed).update(approve(uid)));
        await assertFails(db(uid).doc(a.boqApproved).update({ status: 'reviewed', approvedBy: null, approvedAt: null }));
        await assertFails(db(uid).doc(a.boqReviewed).update({ status: 'draft', reviewedBy: null, reviewedAt: null }));
        await assertFails(db(uid).doc(a.boqDraft).update({ note: 'x' }));
        await assertFails(db(uid).doc(a.boqDraft).update({ qtyOverride: 3, qtyOverrideReason: 'x' }));
      }
    });

    it('nobody creates or deletes lines from the client', async () => {
      await assertFails(db(A.users.admin).collection(`orgs/${A.org}/projects/${A.project}/boqLines`)
        .add({ code: '1.1', qty: 1, unit: 'm', level: 'green', status: 'draft' }));
      await assertFails(db(A.users.admin).doc(a.boqDraft).delete());
    });
  });

  describe('Sprint 3 collections: members read, nobody writes', () => {
    it.each(['boqRule', 'libraryImport', 'boqBuild', 'boqExport'] as const)('%s', async (k) => {
      for (const uid of [A.users.admin, A.users.editor, A.users.reviewer, A.users.viewer]) {
        await assertSucceeds(db(uid).doc(a[k]).get());
        await assertFails(db(uid).doc(a[k]).set({ x: 1 }, { merge: true }));
        await assertFails(db(uid).doc(`${a[k]}x`).set({ x: 1 }));
        await assertFails(db(uid).doc(a[k]).delete());
      }
      await assertFails(db(A.users.admin).doc(b[k]).get());
      await assertFails(db(OUTSIDER).doc(a[k]).get());
      await assertFails(db(null).doc(a[k]).get());
    });

    it('project boq summary on the project doc is not client-writable (stale flag cannot be forged)', async () => {
      await assertFails(db(A.users.admin).doc(a.project).update({ 'boq.stale': false }));
    });
  });
});
