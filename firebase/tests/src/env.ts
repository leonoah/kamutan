import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import 'firebase/compat/storage';
import type { Role } from '../../model';

const here = dirname(fileURLToPath(import.meta.url));
export const FIREBASE_DIR = join(here, '..', '..');
export const FIRESTORE_RULES = readFileSync(join(FIREBASE_DIR, 'firestore.rules'), 'utf8');
export const STORAGE_RULES = readFileSync(join(FIREBASE_DIR, 'storage.rules'), 'utf8');

/** Emulator tests run only when the emulator is reachable (CI: `pnpm test:emulator`). */
export const HAS_FIRESTORE_EMULATOR = !!process.env.FIRESTORE_EMULATOR_HOST;
export const HAS_STORAGE_EMULATOR = !!process.env.FIREBASE_STORAGE_EMULATOR_HOST;

export const PROJECT_ID = 'demo-kamutan';
export const FieldValue = firebase.firestore.FieldValue;
export const Timestamp = firebase.firestore.Timestamp;

export async function createEnv(opts: { storage?: boolean } = {}): Promise<RulesTestEnvironment> {
  return initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: FIRESTORE_RULES },
    ...(opts.storage ? { storage: { rules: STORAGE_RULES } } : {}),
  });
}

// ---------------------------------------------------------------------------
// Fixtures: two orgs, four role users each, one outsider.
// ---------------------------------------------------------------------------
export interface OrgFx {
  org: string;
  users: Record<Role, string>;
  project: string;
}

const mk = (o: 'a' | 'b'): OrgFx => ({
  org: `org-${o}`,
  users: { admin: `${o}-admin`, editor: `${o}-editor`, reviewer: `${o}-reviewer`, viewer: `${o}-viewer` },
  project: `proj-${o}`,
});
export const A = mk('a');
export const B = mk('b');
export const OUTSIDER = 'outsider';

/** Document paths seeded for each org (relative ids are the same in both orgs). */
export function docPaths(f: OrgFx) {
  const p = `orgs/${f.org}/projects/${f.project}`;
  return {
    org: `orgs/${f.org}`,
    member: `orgs/${f.org}/members/${f.users.viewer}`,
    project: p,
    sheetSet: `${p}/sheetSets/set1`,
    sheet: `${p}/sheets/sheet1`,
    version: `${p}/sheets/sheet1/versions/v1`,
    legendEntry: `${p}/legendEntries/le1`,
    reviewItem: `${p}/reviewItems/ri1`,
    correction: `${p}/corrections/c1`,
    boqDraft: `${p}/boqLines/line-draft`,
    boqReviewed: `${p}/boqLines/line-reviewed`,
    boqApproved: `${p}/boqLines/line-approved`,
    shareLink: `${p}/shareLinks/sl1`,
    itemLibrary: `orgs/${f.org}/itemLibrary/item1`,
    boqTemplate: `orgs/${f.org}/boqTemplates/t1`,
    symbolMapping: `orgs/${f.org}/symbolMappings/m1`,
    auditEvent: `orgs/${f.org}/auditLog/e1`,
    job: `jobs/job-${f.org}`,
  };
}

const ts = () => Timestamp.fromDate(new Date('2026-10-01T00:00:00Z'));

const boqBase = {
  chapter: '4',
  code: '4.10',
  description: 'נקודת שקע',
  qty: 2,
  unit: "יח'",
  level: 'green',
  evidenceRef: null,
  note: null,
  reviewedBy: null,
  reviewedAt: null,
  approvedBy: null,
  approvedAt: null,
};

export async function seed(env: RulesTestEnvironment): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const f of [A, B]) {
      const d = docPaths(f);
      await db.doc(d.org).set({ name: `ארגון ${f.org}`, settings: { llmEnabled: false, blockExportOnRed: true, greenThreshold: 0.98 }, createdAt: ts() });
      for (const [role, uid] of Object.entries(f.users)) {
        await db.doc(`orgs/${f.org}/members/${uid}`).set({ uid, role, createdAt: ts() });
      }
      await db.doc(d.project).set({ name: 'פרויקט', floors: [], status: 'active', createdBy: f.users.admin, createdAt: ts() });
      await db.doc(d.sheetSet).set({ fileKind: 'pdf', sha256: 'a'.repeat(64), storagePath: `orgs/${f.org}/uploads/x/y`, status: 'ready', uploadedBy: f.users.editor, createdAt: ts() });
      await db.doc(d.sheet).set({ logicalKey: 'E-01', discipline: ['electrical'], floorRegions: [], scale: 50, currentVersionId: 'v1', sheetSetId: 'set1' });
      await db.doc(d.version).set({ versionNo: 1, status: 'ready', sha256: 'a'.repeat(64), pageIndex: 0, artifacts: {}, createdAt: ts() });
      await db.doc(d.legendEntry).set({ sheetId: 'sheet1', label: 'שקע כוח', templateRef: null, itemCode: '4.10' });
      await db.doc(d.reviewItem).set({ level: 'yellow', reasons: ['LOW_OCR'], clusterId: null, status: 'open', riskScore: 0.6, resolution: null, resolvedBy: null, resolvedAt: null });
      await db.doc(d.correction).set({ authorId: f.users.editor, createdAt: ts(), targetType: 'detection', targetId: 'det-1', action: 'reject' });
      await db.doc(d.boqDraft).set({ ...boqBase, status: 'draft' });
      await db.doc(d.boqReviewed).set({ ...boqBase, status: 'reviewed', reviewedBy: f.users.reviewer, reviewedAt: ts() });
      await db.doc(d.boqApproved).set({ ...boqBase, status: 'approved', reviewedBy: f.users.reviewer, reviewedAt: ts(), approvedBy: f.users.reviewer, approvedAt: ts() });
      await db.doc(d.shareLink).set({ tokenHash: 'c'.repeat(64), versionLock: ['v1'], expiresAt: ts(), revokedAt: null, allowPdfDownload: false, createdBy: f.users.editor, createdAt: ts() });
      await db.doc(d.itemLibrary).set({ code: '4.10', chapter: '4', description: 'נקודת שקע', unit: "יח'" });
      await db.doc(d.boqTemplate).set({ name: 'תבנית', chapters: [], columns: [] });
      await db.doc(d.symbolMapping).set({ keyType: 'template_hash', key: 'h1', itemId: 'item1', acceptCount: 0, rejectCount: 0 });
      await db.doc(d.auditEvent).set({ actorId: null, actorKind: 'system', entity: 'org', entityId: f.org, action: 'create', at: ts(), prevHash: null, hash: 'd'.repeat(64) });
      await db.doc(d.job).set({ orgId: f.org, projectId: f.project, type: 'ingest.sheet_version', status: 'running', progress: 10, createdAt: ts() });
    }
  });
}
