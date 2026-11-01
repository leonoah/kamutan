import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditSummaryHe,
  BoqLineSchema,
  BoqBuildSchema,
  BoqRuleSchema,
  BoqTemplateSchema,
  CreateInviteRequestSchema,
  DEFAULT_BOQ_RULES,
  DEFAULT_BOQ_TEMPLATE,
  DEFAULT_ITEM_LIBRARY,
  DEFAULT_UNITS,
  defaultRuleDoc,
  defaultUnitFor,
  FinalizeUploadRequestSchema,
  InviteSchema,
  itemIdFor,
  ItemLibraryItemSchema,
  ListSheetsQuerySchema,
  PatchMemberRequestSchema,
  SheetSchema,
  TEXT_ARTIFACT_PATH_RE,
  UNDERSTANDING_ARTIFACT_PATH_RE,
} from '../src/index.js';

/** Same trigram Dice similarity as the worker's `boq/rules.py` (`norm_text` + `similarity`). */
const norm = (s: string) => s.replace(/ /g, ' ').replace(/["'״׳”“’`()[\],.:;/\\+\-–—!?]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const grams = (s: string) => {
  const t = `  ${norm(s)} `;
  const g = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) g.add(t.slice(i, i + 3));
  return g;
};
const similarity = (a: string, b: string) => {
  const ga = grams(a);
  const gb = grams(b);
  let n = 0;
  for (const x of ga) if (gb.has(x)) n++;
  return (2 * n) / (ga.size + gb.size);
};

describe('Stage 10 — default item library + generic template (A-LIVE-01)', () => {
  it('every item is a valid ItemLibraryItem with a deterministic id; codes unique; generic (no client / price data)', () => {
    const codes = new Set<string>();
    for (const it of DEFAULT_ITEM_LIBRARY) {
      expect(ItemLibraryItemSchema.safeParse({ ...it, updatedAt: null }).success, it.code).toBe(true);
      expect(it.id).toBe(itemIdFor(it.code, it.description));
      expect(it).toMatchObject({ source: 'default', active: true });
      expect([1, 2]).toContain(it.defaultsVersion);
      expect(codes.has(it.code)).toBe(false);
      codes.add(it.code);
      expect(it.description).not.toMatch(/(^|[\s(])נח($|[\s),.])|₪|\d+\s*ש"ח|עדה פלאסט|גוויס|תמי 4|נירוקריל|אורבונד/);
    }
    expect([...new Set(DEFAULT_ITEM_LIBRARY.map((i) => i.chapter))].sort()).toEqual(['01', '02', '03', '04', '05', '06', '07', '09']);
    expect(DEFAULT_ITEM_LIBRARY.filter((i) => i.chapter === '01').every((i) => i.unit === DEFAULT_UNITS.lumpSum)).toBe(true);
  });

  it('aligned with the default rules: every rule itemCode has one item of that code, matching description (worker similarity) and unit kind', () => {
    for (const r of DEFAULT_BOQ_RULES) {
      if (!r.itemCode) continue;
      const it = DEFAULT_ITEM_LIBRARY.find((i) => i.code === r.itemCode);
      expect(it, r.itemCode).toBeTruthy();
      expect(similarity(r.itemDescription ?? '', it?.description ?? ''), r.itemCode).toBeGreaterThanOrEqual(0.6);
      if (r.unit === 'מ"ר' || r.unit === 'מ"א' || r.unit === 'קומפלט') expect(it?.unit, r.itemCode).toBe(r.unit);
      else expect([DEFAULT_UNITS.count, DEFAULT_UNITS.lumpSum], r.itemCode).toContain(it?.unit);
    }
    expect(defaultUnitFor('יחידה')).toBe("יח'");
    expect(defaultUnitFor('מ"ר')).toBe('מ"ר');
    expect(defaultUnitFor(null)).toBe("יח'");
  });

  it('generic template v3 (Sprint 6): chapters 01/02/03/04/05/06/07/09, one per item chapter, valid', () => {
    expect(BoqTemplateSchema.safeParse({ ...DEFAULT_BOQ_TEMPLATE, updatedAt: null }).success).toBe(true);
    expect(DEFAULT_BOQ_TEMPLATE.chapters.map((c) => c.code)).toEqual(['01', '02', '03', '04', '05', '06', '07', '09']);
    expect(DEFAULT_BOQ_TEMPLATE).toMatchObject({ id: 'tpl_default', defaultsVersion: 3, source: 'default' });
    for (const it of DEFAULT_ITEM_LIBRARY) expect(DEFAULT_BOQ_TEMPLATE.chapters.find((c) => c.code === it.chapter)?.title).toBe(it.chapterTitle);
  });

  it('json-schema/defaults/library-defaults.json is up to date', () => {
    const f = JSON.parse(readFileSync(join(__dirname, '..', 'json-schema', 'defaults', 'library-defaults.json'), 'utf8')) as { version: number; items: unknown[]; template: unknown };
    expect(f.version).toBe(2);
    expect(f.items).toEqual(JSON.parse(JSON.stringify(DEFAULT_ITEM_LIBRARY)));
    expect(f.template).toEqual(JSON.parse(JSON.stringify(DEFAULT_BOQ_TEMPLATE)));
  });
});

describe('Stage 10 — Worker-BOQ contract requests', () => {
  it('rule kinds template_chapter + fixture_combination; r_template_demolition is a default rule', () => {
    const demo = DEFAULT_BOQ_RULES.find((r) => r.id === 'r_template_demolition');
    expect(demo).toMatchObject({ kind: 'template_chapter', itemCode: null, unit: 'קומפלט', priority: 10, match: { chapters: ['01'], disciplines: ['demolition'], quantity: 1 } });
    expect(BoqRuleSchema.safeParse({ ...defaultRuleDoc(demo as (typeof DEFAULT_BOQ_RULES)[number]), updatedAt: null }).success).toBe(true);
    const combo = { id: 'r_wc', kind: 'fixture_combination', match: { classes: ['fixture_wc_concealed', 'fixture_basin'], sameRoom: true }, itemCode: '3.04', unit: 'יחידה', priority: 150, enabled: true, source: 'custom', updatedAt: null };
    expect(BoqRuleSchema.safeParse(combo).success).toBe(true);
    expect(BoqRuleSchema.safeParse({ ...combo, match: { classes: ['fixture_basin', 'fixture_basin'], sameRoom: true } }).success).toBe(false);
    expect(BoqRuleSchema.safeParse({ ...combo, match: { classes: ['fixture_basin'], sameRoom: true } }).success).toBe(false);
  });

  it('BoqLine byRoom / approvalInvalidated / approvedQty; BoqBuild approvalsInvalidated', () => {
    const line = { id: 'ln_3_04', chapter: '03', code: '3.04', description: 'x', qty: 3, unit: "יח'", level: 'green', status: 'reviewed', approvedQty: null, approvalInvalidated: { fromQty: 2, toQty: 3, buildId: 'b1' }, byRoom: [{ sheetId: 's1', roomId: 'r_1', name: 'שירותים', type: 'wc', floor: '0', qty: 3 }] };
    expect(BoqLineSchema.parse(line)).toMatchObject({ byRoom: [{ qty: 3 }], approvalInvalidated: { fromQty: 2 } });
    expect(BoqBuildSchema.safeParse({ id: 'b1', status: 'succeeded', jobId: null, requestedBy: null, createdAt: null, startedAt: null, finishedAt: null, stats: null, error: null, approvalsInvalidated: [{ lineId: 'ln_4_01', code: '4.01', fromQty: 15, toQty: 16 }] }).success).toBe(true);
  });
});

describe('Stage 10 — members, uploads, sheets, audit', () => {
  it('invite / member DTOs', () => {
    expect(CreateInviteRequestSchema.parse({ email: ' A.B@Example.COM ', role: 'editor' })).toEqual({ email: 'a.b@example.com', role: 'editor' });
    expect(CreateInviteRequestSchema.safeParse({ email: 'x', role: 'editor' }).success).toBe(false);
    expect(CreateInviteRequestSchema.safeParse({ email: 'a@b.co', role: 'owner' }).success).toBe(false);
    expect(PatchMemberRequestSchema.safeParse({ role: 'viewer', extra: 1 }).success).toBe(false);
    expect(InviteSchema.safeParse({ id: 'i1', orgId: 'o1', email: 'a@b.co', role: 'viewer', status: 'pending', state: 'expired', invitedBy: 'u1', createdAt: '2026-11-01T00:00:00.000Z', expiresAt: '2026-11-02T00:00:00.000Z' }).success).toBe(true);
  });

  it('revised upload + superseded sheets', () => {
    expect(FinalizeUploadRequestSchema.safeParse({ uploadToken: 'x'.repeat(20), replacesSheetSetId: 'a'.repeat(64) }).success).toBe(true);
    expect(FinalizeUploadRequestSchema.safeParse({ uploadToken: 'x'.repeat(20), replacesSheetSetId: '../x' }).success).toBe(false);
    expect(ListSheetsQuerySchema.parse({ includeSuperseded: 'true' }).includeSuperseded).toBe(true);
    expect(SheetSchema.partial().parse({ superseded: true, supersededBy: null, supersededMatch: 'page_order', supersedes: null })).toMatchObject({ superseded: true });
  });

  it('text.json.gz is server-readable (evidence boxes) but not an understanding artifact', () => {
    const p = 'orgs/o1/projects/p1/sheets/s1/versions/v1/text.json.gz';
    expect(TEXT_ARTIFACT_PATH_RE.test(p)).toBe(true);
    expect(UNDERSTANDING_ARTIFACT_PATH_RE.test(p)).toBe(false);
    expect(TEXT_ARTIFACT_PATH_RE.test('orgs/o1/projects/p1/sheets/s1/versions/v1/../x/text.json.gz')).toBe(false);
  });

  it('auditSummaryHe: readable Hebrew, no raw ids (A-UI-13)', () => {
    expect(auditSummaryHe({ entity: 'corrections', action: 'create', entityId: 'c1', after: { kind: 'add', class: 'socket_double', itemCode: null } })).toBe('תיקון על השרטוט · הוספת פריט ידני · שקע כפול');
    expect(auditSummaryHe({ entity: 'boqLines', action: 'update', entityId: 'l', after: { code: '4.01', from: 'approved', to: 'reviewed', qty: 2, prevQtyOverride: null, qtyOverride: 3, reason: 'ספירה' } })).toBe('שורה 4.01 · סטטוס אושר → נבדק · כמות ידנית 2 → 3 · סיבה: ספירה');
    expect(auditSummaryHe({ entity: 'orgs', action: 'update_settings', entityId: 'o', after: { changes: { blockExportOnRed: { from: true, to: false } } } })).toBe('שינוי הגדרות ארגון · חסימת ייצוא עם פריטים לבדיקה: כן → לא');
    expect(auditSummaryHe({ entity: 'members', action: 'update_role', entityId: 'u', after: { uid: 'u', from: 'viewer', to: 'editor' } })).toBe('חברי צוות · שינוי תפקיד · צופה → עורך');
    expect(auditSummaryHe({ entity: 'boqLines', action: 'approval_invalidated', entityId: 'l', after: { code: '4.01', fromQty: 15, toQty: 16 } })).toContain('הכמות השתנתה 15 → 16');
    expect(auditSummaryHe({ entity: 'zzz', action: 'yyy', entityId: null, after: null })).toBe('zzz · yyy');
  });
});
