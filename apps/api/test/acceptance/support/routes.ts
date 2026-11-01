/**
 * Every member (authenticated) route of the API, with
 * - `min`: the minimum role the implementation documents (apps/api/NOTES.md endpoint table, Sprint 3/4 decisions),
 * - `spec`: the minimum role the spec's role table implies (docs/spec/06_security.md SEC-07, + E2E-02/E2E-11 personas),
 * - a request builder that targets the resources of a given org world (ids only — so the same builder is used for
 *   the roles matrix, the org-isolation sweep and the offboarding sweep).
 * `roles-matrix.acceptance.test.ts` asserts that this table covers exactly the routes of the running Nest app
 * (Swagger scan of the live router) and of the committed apps/api/openapi.json, so a new route cannot be missed.
 */
import type { Role } from '@kamutan/contracts';
import type { OrgWorld } from './world';

export type MinRole = Role | 'any';
export type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';
export interface Req {
  method: Method;
  url: string;
  body?: unknown;
}
export interface RouteCase {
  /** "METHOD /api/v1/path/{param}" exactly as in openapi.json */
  route: string;
  variant?: string;
  min: MinRole;
  spec: MinRole;
  /** SEC-07 row / reason for `spec` */
  specRow: string;
  /** defect id when min !== spec */
  defect?: string;
  /** allowed while the org is offboarding (SEC-52) */
  offboarding?: boolean;
  build: (o: OrgWorld, role: Role) => Req;
}

const V = '/api/v1';
const P = (o: OrgWorld) => `${V}/projects/${o.projectId}`;
const S = (o: OrgWorld) => `${P(o)}/sheets/${o.sheet.sheetId}`;
const SV = (o: OrgWorld) => `${S(o)}/versions/${o.sheet.versionId}`;
const corrBase = (o: OrgWorld) => ({ sheetId: o.sheet.sheetId, versionId: o.sheet.versionId, anchorMm: { x: 50, y: 50 } });
const accept = (o: OrgWorld) => ({ ...corrBase(o), kind: 'accept', detectionId: 'd_2' });
const add = (o: OrgWorld) => ({ ...corrBase(o), kind: 'add', class: 'socket_double', anchorMm: { x: 80, y: 80 } });

const ROW = {
  view: 'צפייה (viewer ✓)',
  admin: 'ניהול משתמשים והגדרות ארגון ו-LLM (admin only)',
  create: 'יצירת פרויקט והעלאה (admin, editor)',
  fix: 'תיקון פריטים ושינוי סטטוס (admin, editor, reviewer)',
  approve: 'אישור שורה סופי (admin, editor, reviewer)',
  export: 'ייצוא ויצירת קישור שיתוף (admin, editor)',
  offboard: 'מחיקת פרויקט / offboarding (admin + MFA)',
  any: 'any signed-in user',
} as const;

export const ROUTES: RouteCase[] = [
  // ------------------------------------------------------------------ me / orgs
  { route: `GET ${V}/me`, min: 'any', spec: 'any', specRow: ROW.any, offboarding: true, build: () => ({ method: 'get', url: `${V}/me` }) },
  { route: `GET ${V}/orgs`, min: 'any', spec: 'any', specRow: ROW.any, offboarding: true, build: () => ({ method: 'get', url: `${V}/orgs` }) },
  { route: `POST ${V}/orgs`, min: 'any', spec: 'any', specRow: ROW.any, offboarding: true, build: (_o, r) => ({ method: 'post', url: `${V}/orgs`, body: { name: `ארגון חדש ${r}` } }) },
  { route: `GET ${V}/orgs/{orgId}`, min: 'viewer', spec: 'viewer', specRow: ROW.view, offboarding: true, build: (o) => ({ method: 'get', url: `${V}/orgs/${o.orgId}` }) },
  { route: `GET ${V}/orgs/{orgId}/audit`, min: 'admin', spec: 'admin', specRow: 'SEC-35: admin רואה את היומן', build: (o) => ({ method: 'get', url: `${V}/orgs/${o.orgId}/audit` }) },
  { route: `GET ${V}/orgs/{orgId}/audit/verify`, min: 'admin', spec: 'admin', specRow: 'SEC-35', build: (o) => ({ method: 'get', url: `${V}/orgs/${o.orgId}/audit/verify` }) },
  { route: `PATCH ${V}/orgs/{orgId}/settings`, min: 'admin', spec: 'admin', specRow: `${ROW.admin} (+MFA, SEC-02)`, build: (o) => ({ method: 'patch', url: `${V}/orgs/${o.orgId}/settings`, body: { llmEnabled: false } }) },
  { route: `POST ${V}/orgs/{orgId}/offboarding/export`, min: 'admin', spec: 'admin', specRow: ROW.offboard, offboarding: true, build: (o) => ({ method: 'post', url: `${V}/orgs/${o.orgId}/offboarding/export`, body: {} }) },
  { route: `GET ${V}/orgs/{orgId}/offboarding/export/{exportId}`, min: 'admin', spec: 'admin', specRow: ROW.offboard, offboarding: true, build: (o) => ({ method: 'get', url: `${V}/orgs/${o.orgId}/offboarding/export/${o.offboardingExportId}` }) },
  // Stage 10 (A-API-01): members + invitations (admin; mutations + MFA + recent sign-in)
  { route: `GET ${V}/orgs/{orgId}/members`, min: 'admin', spec: 'admin', specRow: ROW.admin, build: (o) => ({ method: 'get', url: `${V}/orgs/${o.orgId}/members` }) },
  // same role as today → a no-op change (200) that never alters the world
  { route: `PATCH ${V}/orgs/{orgId}/members/{uid}`, min: 'admin', spec: 'admin', specRow: `${ROW.admin} (+MFA)`, build: (o) => ({ method: 'patch', url: `${V}/orgs/${o.orgId}/members/${o.uid('viewer')}`, body: { role: 'viewer' } }) },
  { route: `DELETE ${V}/orgs/{orgId}/members/{uid}`, min: 'admin', spec: 'admin', specRow: `${ROW.admin} (+MFA)`, build: (o) => ({ method: 'delete', url: `${V}/orgs/${o.orgId}/members/${o.extraMemberUid}` }) },
  { route: `POST ${V}/orgs/{orgId}/invites`, min: 'admin', spec: 'admin', specRow: `${ROW.admin} (+MFA); UX onboarding "הזמנת צוות"`, build: (o, r) => ({ method: 'post', url: `${V}/orgs/${o.orgId}/invites`, body: { email: `new-${r}@${o.key}.example.test`, role: 'viewer' } }) },
  { route: `GET ${V}/orgs/{orgId}/invites`, min: 'admin', spec: 'admin', specRow: ROW.admin, build: (o) => ({ method: 'get', url: `${V}/orgs/${o.orgId}/invites` }) },
  { route: `DELETE ${V}/orgs/{orgId}/invites/{inviteId}`, min: 'admin', spec: 'admin', specRow: `${ROW.admin} (+MFA)`, build: (o) => ({ method: 'delete', url: `${V}/orgs/${o.orgId}/invites/${o.revokeInviteId}` }) },
  // the invite link: any signed-in user whose verified email is the invite's (each role has its own invite)
  { route: `POST ${V}/invites/{inviteId}/accept`, min: 'any', spec: 'any', specRow: `${ROW.any} with the invited (verified) email`, offboarding: true, build: (o, r) => ({ method: 'post', url: `${V}/invites/${o.invites[r]}/accept`, body: {} }) },
  // body without `confirm` → 400 for an admin: the matrix never offboards the org
  { route: `POST ${V}/orgs/{orgId}/offboarding`, min: 'admin', spec: 'admin', specRow: ROW.offboard, offboarding: true, build: (o) => ({ method: 'post', url: `${V}/orgs/${o.orgId}/offboarding`, body: {} }) },

  // ------------------------------------------------------------------ projects / uploads / sheets
  { route: `GET ${V}/projects`, min: 'viewer', spec: 'viewer', specRow: ROW.view, build: (o) => ({ method: 'get', url: `${V}/projects?orgId=${o.orgId}` }) },
  { route: `POST ${V}/projects`, min: 'editor', spec: 'editor', specRow: ROW.create, build: (o, r) => ({ method: 'post', url: `${V}/projects`, body: { orgId: o.orgId, name: `פרויקט ${r}` } }) },
  { route: `GET ${V}/projects/{projectId}`, min: 'viewer', spec: 'viewer', specRow: ROW.view, build: (o) => ({ method: 'get', url: P(o) }) },
  { route: `PATCH ${V}/projects/{projectId}`, min: 'editor', spec: 'editor', specRow: ROW.create, build: (o) => ({ method: 'patch', url: P(o), body: { address: 'רחוב חדש 2' } }) },
  { route: `POST ${V}/projects/{projectId}/uploads`, min: 'editor', spec: 'editor', specRow: ROW.create, build: (o) => ({ method: 'post', url: `${P(o)}/uploads`, body: { filename: 'חשמל.pdf', sizeBytes: 1000 } }) },
  { route: `POST ${V}/projects/{projectId}/sheet-sets`, min: 'editor', spec: 'editor', specRow: ROW.create, build: (o) => ({ method: 'post', url: `${P(o)}/sheet-sets`, body: { uploadToken: 'x'.repeat(40) } }) },
  { route: `GET ${V}/projects/{projectId}/sheets`, min: 'viewer', spec: 'viewer', specRow: ROW.view, build: (o) => ({ method: 'get', url: `${P(o)}/sheets` }) },
  { route: `GET ${V}/projects/{projectId}/sheets/{sheetId}/versions/{versionId}`, min: 'viewer', spec: 'viewer', specRow: ROW.view, build: (o) => ({ method: 'get', url: SV(o) }) },
  { route: `GET ${V}/projects/{projectId}/sheets/{sheetId}/versions/{versionId}/tiles-manifest`, min: 'viewer', spec: 'viewer', specRow: ROW.view, build: (o) => ({ method: 'get', url: `${SV(o)}/tiles-manifest` }) },
  { route: `GET ${V}/projects/{projectId}/sheets/{sheetId}/versions/{versionId}/overlay`, min: 'viewer', spec: 'viewer', specRow: ROW.view, build: (o) => ({ method: 'get', url: `${SV(o)}/overlay` }) },
  { route: `POST ${V}/projects/{projectId}/sheets/{sheetId}/confirm`, min: 'editor', spec: 'editor', specRow: ROW.create, build: (o) => ({ method: 'post', url: `${S(o)}/confirm`, body: { discipline: 'electrical', floors: ['ground'], scaleDenominator: 50 } }) },
  { route: `PUT ${V}/projects/{projectId}/sheets/{sheetId}/regions`, min: 'editor', spec: 'editor', specRow: ROW.create, build: (o) => ({ method: 'put', url: `${S(o)}/regions`, body: { regions: [] } }) },
  { route: `POST ${V}/projects/{projectId}/sheets/{sheetId}/reprocess`, min: 'editor', spec: 'editor', specRow: ROW.create, build: (o) => ({ method: 'post', url: `${P(o)}/sheets/${o.sheet2.sheetId}/reprocess`, body: {} }) },

  // ------------------------------------------------------------------ understanding
  { route: `GET ${V}/projects/{projectId}/legend-entries`, min: 'viewer', spec: 'viewer', specRow: ROW.view, build: (o) => ({ method: 'get', url: `${P(o)}/legend-entries` }) },
  { route: `PATCH ${V}/projects/{projectId}/legend-entries/{entryId}`, min: 'editor', spec: 'editor', specRow: `${ROW.create} (legend set-up; interpretation)`, build: (o) => ({ method: 'patch', url: `${P(o)}/legend-entries/${o.entryId}`, body: { action: 'confirm' } }) },
  {
    route: `POST ${V}/projects/{projectId}/unknown-clusters/{clusterId}/resolve`,
    min: 'editor',
    spec: 'editor',
    specRow: `${ROW.create} (symbol mapping set-up; interpretation)`,
    build: (o) => ({ method: 'post', url: `${P(o)}/unknown-clusters/${o.clusterId}/resolve`, body: { sheetId: o.sheet2.sheetId, versionId: o.sheet2.versionId, class: 'socket_double', createLegendEntry: false } }),
  },

  // ------------------------------------------------------------------ BOQ
  { route: `GET ${V}/projects/{projectId}/boq`, min: 'viewer', spec: 'viewer', specRow: ROW.view, build: (o) => ({ method: 'get', url: `${P(o)}/boq` }) },
  { route: `POST ${V}/projects/{projectId}/boq/build`, min: 'editor', spec: 'editor', specRow: ROW.create, build: (o) => ({ method: 'post', url: `${P(o)}/boq/build`, body: {} }) },
  { route: `GET ${V}/projects/{projectId}/boq/evidence`, min: 'viewer', spec: 'viewer', specRow: ROW.view, build: (o) => ({ method: 'get', url: `${P(o)}/boq/evidence?sheetId=${o.sheet.sheetId}&versionId=${o.sheet.versionId}` }) },
  { route: `POST ${V}/projects/{projectId}/boq/export`, min: 'editor', spec: 'editor', specRow: ROW.export, build: (o) => ({ method: 'post', url: `${P(o)}/boq/export`, body: {} }) },
  { route: `POST ${V}/projects/{projectId}/boq/export/marked-pdf`, min: 'editor', spec: 'editor', specRow: ROW.export, build: (o) => ({ method: 'post', url: `${P(o)}/boq/export/marked-pdf`, body: {} }) },
  { route: `PATCH ${V}/projects/{projectId}/boq/lines/{lineId}`, variant: 'status', min: 'reviewer', spec: 'reviewer', specRow: ROW.approve, build: (o) => ({ method: 'patch', url: `${P(o)}/boq/lines/${o.lines.status}`, body: { status: 'reviewed' } }) },
  { route: `PATCH ${V}/projects/{projectId}/boq/lines/{lineId}`, variant: 'qtyOverride', min: 'editor', spec: 'editor', specRow: 'E2E-11: "עורך משנה את הכמות"', build: (o, r) => ({ method: 'patch', url: `${P(o)}/boq/lines/${o.lines.override}`, body: { qtyOverride: 5, reason: `override by ${r}` } }) },
  { route: `GET ${V}/projects/{projectId}/boq/lines/{lineId}/evidence`, min: 'viewer', spec: 'viewer', specRow: ROW.view, build: (o) => ({ method: 'get', url: `${P(o)}/boq/lines/${o.lines.status}/evidence` }) },
  { route: `GET ${V}/projects/{projectId}/boq/lines/{lineId}/history`, min: 'viewer', spec: 'viewer', specRow: `${ROW.view} (A-API-07 fixed)`, build: (o) => ({ method: 'get', url: `${P(o)}/boq/lines/${o.lines.status}/history` }) },

  // ------------------------------------------------------------------ review (Sprint 4)
  { route: `POST ${V}/projects/{projectId}/corrections`, variant: 'accept', min: 'reviewer', spec: 'reviewer', specRow: ROW.fix, build: (o) => ({ method: 'post', url: `${P(o)}/corrections`, body: accept(o) }) },
  { route: `POST ${V}/projects/{projectId}/corrections`, variant: 'add', min: 'reviewer', spec: 'reviewer', specRow: `${ROW.fix}; E2E-02 "הבודק … משייך אותו" (A-API-03 fixed)`, build: (o) => ({ method: 'post', url: `${P(o)}/corrections`, body: add(o) }) },
  { route: `POST ${V}/projects/{projectId}/corrections/batch`, variant: 'accept', min: 'reviewer', spec: 'reviewer', specRow: ROW.fix, build: (o) => ({ method: 'post', url: `${P(o)}/corrections/batch`, body: { items: [accept(o)] } }) },
  { route: `POST ${V}/projects/{projectId}/corrections/batch`, variant: 'add', min: 'reviewer', spec: 'reviewer', specRow: `${ROW.fix}; E2E-03 group approval (A-API-03 fixed)`, build: (o) => ({ method: 'post', url: `${P(o)}/corrections/batch`, body: { items: [add(o)] } }) },
  { route: `POST ${V}/projects/{projectId}/corrections/{correctionId}/revert`, variant: 'accept', min: 'reviewer', spec: 'reviewer', specRow: ROW.fix, build: (o) => ({ method: 'post', url: `${P(o)}/corrections/${o.corrections.accept}/revert`, body: {} }) },
  { route: `POST ${V}/projects/{projectId}/corrections/{correctionId}/revert`, variant: 'add', min: 'reviewer', spec: 'reviewer', specRow: `${ROW.fix} (A-API-03 fixed)`, build: (o) => ({ method: 'post', url: `${P(o)}/corrections/${o.corrections.add}/revert`, body: {} }) },
  { route: `POST ${V}/projects/{projectId}/correction-batches/{batchId}/revert`, variant: 'accept', min: 'reviewer', spec: 'reviewer', specRow: ROW.fix, build: (o) => ({ method: 'post', url: `${P(o)}/correction-batches/${o.batches.accept}/revert`, body: {} }) },
  { route: `POST ${V}/projects/{projectId}/correction-batches/{batchId}/revert`, variant: 'add', min: 'reviewer', spec: 'reviewer', specRow: `${ROW.fix} (A-API-03 fixed)`, build: (o) => ({ method: 'post', url: `${P(o)}/correction-batches/${o.batches.add}/revert`, body: {} }) },
  { route: `GET ${V}/projects/{projectId}/corrections`, min: 'viewer', spec: 'viewer', specRow: ROW.view, build: (o) => ({ method: 'get', url: `${P(o)}/corrections` }) },
  { route: `GET ${V}/projects/{projectId}/review-queue`, min: 'viewer', spec: 'viewer', specRow: ROW.view, build: (o) => ({ method: 'get', url: `${P(o)}/review-queue` }) },
  { route: `GET ${V}/projects/{projectId}/rooms/{sheetId}/{roomId}/settings`, min: 'viewer', spec: 'viewer', specRow: ROW.view, build: (o) => ({ method: 'get', url: `${P(o)}/rooms/${o.sheet.sheetId}/${o.roomId}/settings` }) },
  { route: `PUT ${V}/projects/{projectId}/rooms/{sheetId}/{roomId}/settings`, min: 'editor', spec: 'editor', specRow: `${ROW.create} (measurement inputs; interpretation)`, build: (o) => ({ method: 'put', url: `${P(o)}/rooms/${o.sheet.sheetId}/${o.roomId}/settings`, body: {} }) },
  {
    route: `POST ${V}/projects/{projectId}/similar-searches`,
    min: 'reviewer',
    spec: 'reviewer',
    specRow: ROW.fix,
    build: (o) => ({ method: 'post', url: `${P(o)}/similar-searches`, body: { exemplar: { sheetId: o.sheet.sheetId, versionId: o.sheet.versionId, bboxMm: { x: 48, y: 48, w: 4, h: 4 }, class: 'socket_double' }, scope: 'sheet' } }),
  },
  { route: `GET ${V}/projects/{projectId}/similar-searches/{searchId}`, min: 'viewer', spec: 'viewer', specRow: ROW.view, build: (o) => ({ method: 'get', url: `${P(o)}/similar-searches/${o.searchId}` }) },

  // ------------------------------------------------------------------ governance (Sprint 5)
  { route: `GET ${V}/projects/{projectId}/exports/{exportId}`, min: 'viewer', spec: 'viewer', specRow: `${ROW.view} (download of an existing export)`, build: (o) => ({ method: 'get', url: `${P(o)}/exports/${o.exportId}` }) },
  { route: `POST ${V}/projects/{projectId}/share-links`, min: 'editor', spec: 'editor', specRow: ROW.export, build: (o) => ({ method: 'post', url: `${P(o)}/share-links`, body: { label: 'קישור' } }) },
  { route: `GET ${V}/projects/{projectId}/share-links`, min: 'editor', spec: 'editor', specRow: ROW.export, build: (o) => ({ method: 'get', url: `${P(o)}/share-links` }) },
  { route: `DELETE ${V}/projects/{projectId}/share-links/{linkId}`, min: 'editor', spec: 'editor', specRow: `${ROW.export} (SEC-27 revoke by editor/admin)`, build: (o) => ({ method: 'delete', url: `${P(o)}/share-links/${o.link.id}` }) },
  { route: `GET ${V}/jobs/{jobId}`, min: 'viewer', spec: 'viewer', specRow: ROW.view, build: (o) => ({ method: 'get', url: `${V}/jobs/${o.jobId}` }) },

  // ------------------------------------------------------------------ library / templates / rules (org scope)
  { route: `GET ${V}/library/items`, min: 'viewer', spec: 'viewer', specRow: ROW.view, build: (o) => ({ method: 'get', url: `${V}/library/items?orgId=${o.orgId}` }) },
  { route: `POST ${V}/library/items`, min: 'editor', spec: 'editor', specRow: ROW.create, build: (o, r) => ({ method: 'post', url: `${V}/library/items`, body: { orgId: o.orgId, code: '9.02', chapter: '09', description: `פריט ${r}`, unit: 'יח' } }) },
  { route: `PATCH ${V}/library/items/{itemId}`, min: 'editor', spec: 'editor', specRow: ROW.create, build: (o) => ({ method: 'patch', url: `${V}/library/items/${o.itemId}?orgId=${o.orgId}`, body: { unit: 'מ"א' } }) },
  { route: `POST ${V}/library/imports`, min: 'editor', spec: 'editor', specRow: ROW.create, build: (o) => ({ method: 'post', url: `${V}/library/imports`, body: { orgId: o.orgId, filename: 'past.xlsx', sizeBytes: 1000 } }) },
  { route: `GET ${V}/library/imports/{importId}`, min: 'viewer', spec: 'viewer', specRow: ROW.view, build: (o) => ({ method: 'get', url: `${V}/library/imports/${o.imports.editor}?orgId=${o.orgId}` }) },
  // uploader-only: each editor/admin finalizes its own import (no object uploaded → 409 upload_missing = authorized)
  { route: `POST ${V}/library/imports/{importId}/finalize`, min: 'editor', spec: 'editor', specRow: ROW.create, build: (o, r) => ({ method: 'post', url: `${V}/library/imports/${o.imports[r] ?? o.imports.editor}/finalize`, body: { orgId: o.orgId } }) },
  { route: `GET ${V}/boq-templates`, min: 'viewer', spec: 'viewer', specRow: ROW.view, build: (o) => ({ method: 'get', url: `${V}/boq-templates?orgId=${o.orgId}` }) },
  { route: `PATCH ${V}/boq-templates/{templateId}`, min: 'admin', spec: 'admin', specRow: `${ROW.admin} (+MFA, SEC-02)`, build: (o) => ({ method: 'patch', url: `${V}/boq-templates/${o.templateId}?orgId=${o.orgId}`, body: { name: 'תבנית המשרד' } }) },
  { route: `GET ${V}/boq-rules`, min: 'viewer', spec: 'viewer', specRow: ROW.view, build: (o) => ({ method: 'get', url: `${V}/boq-rules?orgId=${o.orgId}` }) },
  { route: `PATCH ${V}/boq-rules/{ruleId}`, min: 'admin', spec: 'admin', specRow: `${ROW.admin} (+MFA, SEC-02)`, build: (o) => ({ method: 'patch', url: `${V}/boq-rules/${o.ruleId}?orgId=${o.orgId}`, body: { enabled: true } }) },
];

/** Public / unauthenticated routes (not member endpoints). */
export const PUBLIC_ROUTES = [
  `GET ${V}/health`,
  `GET ${V}/health/ready`,
  `GET ${V}/public/share/{token}/meta`,
  `GET ${V}/public/share/{token}/boq`,
  `GET ${V}/public/share/{token}/pdf`,
  `GET ${V}/public/share/{token}/sheets/{sheetId}/overlay`,
  `GET ${V}/public/share/{token}/sheets/{sheetId}/tiles/{z}/{x}/{y}`,
];

const RANK: Record<Role, number> = { viewer: 10, reviewer: 20, editor: 30, admin: 40 };
export const satisfies = (role: Role, min: MinRole): boolean => min === 'any' || RANK[role] >= RANK[min];

export async function send(http: import('./world').Http, req: Req, headers: Record<string, string>) {
  const r = http[req.method](req.url).set(headers);
  return req.body === undefined ? r : r.send(req.body as object);
}
