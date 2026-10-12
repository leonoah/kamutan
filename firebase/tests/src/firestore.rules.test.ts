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
      'boqDraft', 'itemLibrary', 'boqTemplate', 'symbolMapping', 'job',
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
      'itemLibrary', 'boqTemplate', 'symbolMapping', 'auditEvent', 'job',
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

    it('shareLinks: admin/editor read, reviewer/viewer cannot; nobody writes or revokes from client', async () => {
      await assertSucceeds(db(A.users.admin).doc(a.shareLink).get());
      await assertSucceeds(db(A.users.editor).doc(a.shareLink).get());
      await assertFails(db(A.users.reviewer).doc(a.shareLink).get());
      await assertFails(db(A.users.viewer).doc(a.shareLink).get());
      await assertFails(db(A.users.editor).doc(a.shareLink).update({ revokedAt: FieldValue.serverTimestamp() }));
    });

    it('jobs: clients cannot create or update job progress', async () => {
      await assertFails(db(A.users.admin).collection('jobs').add({ orgId: A.org, type: 'x', status: 'queued', progress: 0 }));
      await assertFails(db(A.users.admin).doc(a.job).update({ progress: 100 }));
    });
  });

  // -------------------------------------------------------------------------
  describe('corrections: create-only by editor/reviewer/admin', () => {
    const corrPath = (id: string) => `orgs/${A.org}/projects/${A.project}/corrections/${id}`;
    const valid = (uid: string) => ({
      authorId: uid,
      createdAt: FieldValue.serverTimestamp(),
      targetType: 'detection',
      targetId: 'det-42',
      action: 'reclass',
      sheetId: 'sheet1',
      versionId: 'v1',
      payload: { legendEntryId: 'le1' },
      note: 'שקע כפול',
    });

    it.each(['editor', 'reviewer', 'admin'] as const)('%s can create a valid correction', async (role) => {
      const uid = A.users[role];
      await assertSucceeds(db(uid).doc(corrPath(`n-${role}`)).set(valid(uid)));
    });

    it('viewer, outsider and other-org editor cannot', async () => {
      await assertFails(db(A.users.viewer).doc(corrPath('n1')).set(valid(A.users.viewer)));
      await assertFails(db(OUTSIDER).doc(corrPath('n2')).set(valid(OUTSIDER)));
      await assertFails(db(B.users.editor).doc(corrPath('n3')).set(valid(B.users.editor)));
    });

    it('author must be the caller and createdAt the server time', async () => {
      const uid = A.users.editor;
      await assertFails(db(uid).doc(corrPath('x1')).set({ ...valid(uid), authorId: A.users.reviewer }));
      await assertFails(db(uid).doc(corrPath('x2')).set({ ...valid(uid), createdAt: Timestamp.fromDate(new Date('2020-01-01')) }));
    });

    it('rejects unknown fields, bad enums and oversize values', async () => {
      const uid = A.users.editor;
      await assertFails(db(uid).doc(corrPath('y1')).set({ ...valid(uid), extra: 1 }));
      await assertFails(db(uid).doc(corrPath('y2')).set({ ...valid(uid), action: 'drop_table' }));
      await assertFails(db(uid).doc(corrPath('y3')).set({ ...valid(uid), targetType: 'boqLine' }));
      await assertFails(db(uid).doc(corrPath('y4')).set({ ...valid(uid), note: 'x'.repeat(2001) }));
      await assertFails(db(uid).doc(corrPath('y5')).set({ ...valid(uid), targetId: '' }));
      const { targetId: _omit, ...missing } = valid(uid);
      await assertFails(db(uid).doc(corrPath('y6')).set(missing));
    });

    it('existing corrections are immutable, even for their author', async () => {
      await assertFails(db(A.users.editor).doc(a.correction).update({ note: 'edit' }));
      await assertFails(db(A.users.editor).doc(a.correction).delete());
      await assertFails(db(A.users.admin).doc(a.correction).delete());
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
  describe('boqLines: reviewer/admin status transitions', () => {
    const review = (uid: string) => ({ status: 'reviewed', reviewedBy: uid, reviewedAt: FieldValue.serverTimestamp() });
    const approve = (uid: string) => ({ status: 'approved', approvedBy: uid, approvedAt: FieldValue.serverTimestamp() });

    it('viewer and editor cannot change BOQ lines at all', async () => {
      for (const uid of [A.users.viewer, A.users.editor]) {
        await assertFails(db(uid).doc(a.boqDraft).update(review(uid)));
        await assertFails(db(uid).doc(a.boqReviewed).update(approve(uid)));
        await assertFails(db(uid).doc(a.boqDraft).update({ qty: 99 }));
      }
    });

    it('nobody creates or deletes lines from the client', async () => {
      await assertFails(db(A.users.admin).collection(`orgs/${A.org}/projects/${A.project}/boqLines`)
        .add({ code: '1.1', qty: 1, unit: 'm', level: 'green', status: 'draft' }));
      await assertFails(db(A.users.admin).doc(a.boqDraft).delete());
    });

    it('reviewer: draft -> reviewed -> approved, stamped with own uid + server time', async () => {
      const uid = A.users.reviewer;
      await assertSucceeds(db(uid).doc(a.boqDraft).update(review(uid)));
      await assertSucceeds(db(uid).doc(a.boqDraft).update(approve(uid)));
    });

    it('admin can approve too', async () => {
      await assertSucceeds(db(A.users.admin).doc(a.boqReviewed).update(approve(A.users.admin)));
    });

    it('cannot skip draft -> approved', async () => {
      await assertFails(db(A.users.reviewer).doc(a.boqDraft).update(approve(A.users.reviewer)));
    });

    it('approval stamp must be the caller and request.time', async () => {
      const uid = A.users.reviewer;
      await assertFails(db(uid).doc(a.boqReviewed).update({ ...approve(uid), approvedBy: A.users.admin }));
      await assertFails(db(uid).doc(a.boqReviewed).update({ ...approve(uid), approvedAt: Timestamp.fromDate(new Date('2020-01-01')) }));
      await assertFails(db(uid).doc(a.boqReviewed).update({ status: 'approved' }));
    });

    it('status changes cannot smuggle content changes', async () => {
      const uid = A.users.reviewer;
      await assertFails(db(uid).doc(a.boqReviewed).update({ ...approve(uid), qty: 1000 }));
      await assertFails(db(uid).doc(a.boqDraft).update({ ...review(uid), code: '4.1' }));
      await assertFails(db(uid).doc(a.boqDraft).update({ qty: 3 }));
    });

    it('approved lines are immutable except un-approve (approved -> reviewed, stamp cleared)', async () => {
      const uid = A.users.reviewer;
      await assertFails(db(uid).doc(a.boqApproved).update({ qty: 5 }));
      await assertFails(db(uid).doc(a.boqApproved).update({ note: 'הערה' }));
      await assertFails(db(uid).doc(a.boqApproved).update({ approvedBy: uid, approvedAt: FieldValue.serverTimestamp() }));
      await assertFails(db(uid).doc(a.boqApproved).update({ status: 'draft' }));
      await assertFails(db(uid).doc(a.boqApproved).update({ status: 'reviewed' })); // stamp must be cleared
      await assertSucceeds(db(uid).doc(a.boqApproved).update({ status: 'reviewed', approvedBy: null, approvedAt: null, note: 'לבדוק שוב' }));
    });

    it('reviewed -> draft clears the review stamp', async () => {
      const uid = A.users.reviewer;
      await assertFails(db(uid).doc(a.boqReviewed).update({ status: 'draft' }));
      await assertSucceeds(db(uid).doc(a.boqReviewed).update({ status: 'draft', reviewedBy: null, reviewedAt: null }));
    });

    it('org A reviewer cannot approve org B lines', async () => {
      await assertFails(db(A.users.reviewer).doc(b.boqReviewed).update(approve(A.users.reviewer)));
    });
  });
});
