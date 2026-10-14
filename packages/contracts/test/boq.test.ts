import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyRebuild,
  BOQ_LINE_PRESERVED_FIELDS,
  BoqEvidenceArtifactSchema,
  BoqLineSchema,
  BoqRuleSchema,
  BoqTemplateSchema,
  canTransition,
  chapterKey,
  compareItemCodes,
  CreateLibraryImportRequestSchema,
  DEFAULT_BOQ_RULES,
  DEFAULT_BOQ_TEMPLATE,
  defaultRuleDoc,
  effectiveQty,
  ExportBoqRequestSchema,
  IngestTopicJobSchema,
  itemIdFor,
  LibraryImportJobSchema,
  LinksArtifactSchema,
  normalizeDescription,
  PatchBoqLineRequestSchema,
  PatchBoqRuleRequestSchema,
  ProjectSchema,
  sha256Hex,
  storagePaths,
  BOQ_EXPORT_PATH_RE,
  BOQ_EVIDENCE_PATH_RE,
  LIBRARY_IMPORT_PATH_RE,
  ARTIFACT_PATH_RE,
  JobSchema,
} from '../src/index.js';

const org = 'orgA';
const pid = 'projA';

describe('sha256 + itemIdFor', () => {
  it.each(['', 'abc', 'שקע כפול', 'x'.repeat(1000), 'a'.repeat(55), 'b'.repeat(56), 'c'.repeat(64)])('matches node:crypto for %#', (s) => {
    expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
  });
  it('is deterministic, doc-id safe and whitespace-insensitive', () => {
    const a = itemIdFor('4.10', "נק' מאור בעלת שני מפסקים מחליפים");
    expect(a).toMatch(/^it_4-10_[0-9a-f]{16}$/);
    expect(itemIdFor('4.10', "  נק' מאור  בעלת שני מפסקים מחליפים ")).toBe(a);
    expect(itemIdFor('4.1', "נק' מאור בעלת שני מפסקים מחליפים")).not.toBe(a);
    const expected = createHash('sha256').update(`4.10\n${normalizeDescription("נק' מאור בעלת שני מפסקים מחליפים")}`).digest('hex').slice(0, 16);
    expect(a).toBe(`it_4-10_${expected}`);
    expect(itemIdFor('A/1', 'x')).toMatch(/^it_A-1_/);
  });
});

describe('boq lines', () => {
  const base = { id: 'l1', chapter: '04', code: '4.10', description: 'x', qty: 3, unit: 'יחידה', level: 'yellow', status: 'draft' };
  it('accepts the Sprint 3 fields and keeps code as text', () => {
    const l = BoqLineSchema.parse({
      ...base,
      byFloor: { 'קומת קרקע': 2, 'קומה א': 1 },
      evidenceCount: 6,
      ruleId: 'r_light_two_way',
      sourceVersions: [{ sheetId: 's-p0', versionId: 'v1' }],
      computedAt: '2026-10-14T10:00:00.000Z',
      evidenceRef: storagePaths.boqEvidence(org, pid, 'b1'),
    });
    expect(l.code).toBe('4.10');
    expect(BoqLineSchema.safeParse({ ...base, byFloor: { '': 1 } }).success).toBe(false);
  });
  it('effective qty, transitions, natural code order, chapter keys', () => {
    expect(effectiveQty({ qty: 3, qtyOverride: 5 })).toBe(5);
    expect(effectiveQty({ qty: 3, qtyOverride: null })).toBe(3);
    expect(canTransition('draft', 'approved')).toBe(false);
    expect(canTransition('approved', 'reviewed')).toBe(true);
    expect(['4.10', '4.9', '4.1', '4.00', '9.01', '4.01'].sort(compareItemCodes)).toEqual(['4.00', '4.1', '4.01', '4.9', '4.10', '9.01']);
    expect(chapterKey('04')).toBe(chapterKey('4'));
    expect(chapterKey('0')).toBe('0');
  });
  it('applyRebuild preserves human fields', () => {
    const existing = { qty: 2, qtyOverride: 7, qtyOverrideReason: 'ספירה ידנית', status: 'approved', approvedBy: 'u1', note: 'n' };
    const next = applyRebuild(existing, { qty: 4, level: 'green' });
    expect(next).toMatchObject({ qty: 4, qtyOverride: 7, status: 'approved', approvedBy: 'u1', note: 'n', level: 'green' });
    expect(applyRebuild(null, { qty: 1 }).status).toBe('draft');
    expect(BOQ_LINE_PRESERVED_FIELDS).toContain('qtyOverride');
  });
  it('PATCH request rules', () => {
    expect(PatchBoqLineRequestSchema.safeParse({}).success).toBe(false);
    expect(PatchBoqLineRequestSchema.safeParse({ qtyOverride: 3 }).success).toBe(false);
    expect(PatchBoqLineRequestSchema.safeParse({ qtyOverride: 3, reason: 'ספירה' }).success).toBe(true);
    expect(PatchBoqLineRequestSchema.safeParse({ qtyOverride: null }).success).toBe(true);
    expect(PatchBoqLineRequestSchema.safeParse({ reason: 'x' }).success).toBe(false);
    expect(PatchBoqLineRequestSchema.safeParse({ status: 'approved', qty: 1 }).success).toBe(false);
    expect(PatchBoqLineRequestSchema.safeParse({ qtyOverride: -1, reason: 'x' }).success).toBe(false);
  });
  it('export request defaults', () => {
    expect(ExportBoqRequestSchema.parse({})).toEqual({ split: 'summed', markDraft: false });
    expect(ExportBoqRequestSchema.safeParse({ split: 'perRoom' }).success).toBe(false);
  });
  it('project carries the boq summary', () => {
    const p = { id: pid, orgId: org, name: 'x', floors: [], status: 'active', createdBy: 'u', createdAt: '2026-10-14T10:00:00.000Z' };
    expect(ProjectSchema.parse({ ...p, boq: { latestBuildId: null, builtAt: null, stale: true } }).boq?.stale).toBe(true);
  });
});

describe('artifacts', () => {
  it('evidence (kamutan.boq-evidence/1)', () => {
    const ev = { schema: 'kamutan.boq-evidence/1', lines: { l1: [{ sheetId: 's-p0', versionId: 'v1', detectionId: 'd_1', linkGroupId: 'lk_3', floor: 'קומת קרקע' }] } };
    expect(BoqEvidenceArtifactSchema.safeParse(ev).success).toBe(true);
    expect(BoqEvidenceArtifactSchema.safeParse({ ...ev, schema: 'kamutan.boq-evidence/2' }).success).toBe(false);
    expect(BoqEvidenceArtifactSchema.safeParse({ ...ev, lines: { l1: [{ ...ev.lines.l1[0], linkGroupId: 'x' }] } }).success).toBe(false);
  });
  it('links (kamutan.links/1)', () => {
    const g = { id: 'lk_1', switchIds: ['d_1', 'd_2'], pointIds: ['pt_1'], luminaireIds: ['d_9'], kind: 'two_way', confidence: 0.9, level: 'green', reasons: [] };
    expect(LinksArtifactSchema.safeParse({ schema: 'kamutan.links/1', groups: [g] }).success).toBe(true);
    expect(LinksArtifactSchema.safeParse({ schema: 'kamutan.links/1', groups: [g, g] }).success).toBe(false);
    expect(LinksArtifactSchema.safeParse({ schema: 'kamutan.links/1', groups: [{ ...g, level: 'yellow' }] }).success).toBe(false);
  });
  it('links with Worker-A optional fields (points, arcs, floor, fan, inferredSwitches, arcIds)', () => {
    const doc = {
      schema: 'kamutan.links/1',
      groups: [{ id: 'lk_1', switchIds: ['d_1'], pointIds: ['pt_1'], luminaireIds: ['d_0'], kind: 'single', confidence: 0.9, level: 'green', reasons: [], floor: 'ground', fan: false, inferredSwitches: 0, arcIds: ['a_1'] }],
      points: [{ id: 'pt_1', luminaireIds: ['d_0'], centerMm: { x: 1, y: 2 }, lifecycle: 'new' }],
      arcs: [{ id: 'a_1', polylineMm: [{ x: 1, y: 2 }, { x: 3, y: 4 }], ends: ['d_0', null], ambiguous: [false, true], inferredSwitch: [false, false] }],
      unlinkedLuminaireIds: ['d_9'],
    };
    expect(LinksArtifactSchema.safeParse(doc).success).toBe(true);
    expect(LinksArtifactSchema.safeParse({ ...doc, arcs: [{ ...doc.arcs[0], ends: ['d_0'] }] }).success).toBe(false);
    expect(LinksArtifactSchema.safeParse({ ...doc, points: [{ ...doc.points[0], lifecycle: 'demolish' }] }).success).toBe(false);
  });

  // Test-time check of the worker's real output (data lives outside git; skipped when absent).
  const ART = '/home/claude/kamutan-data/artifacts';
  const realLinks: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n === 'links.json.gz') realLinks.push(p);
    }
  };
  try {
    if (existsSync(ART)) walk(ART);
  } catch {
    /* unreadable here */
  }
  it.skipIf(realLinks.length === 0)('real links.json.gz files validate against LinksArtifactSchema', () => {
    for (const p of realLinks) {
      const r = LinksArtifactSchema.safeParse(JSON.parse(gunzipSync(readFileSync(p)).toString('utf8')));
      expect(r.success, `${p}: ${r.success ? '' : r.error.message.slice(0, 500)}`).toBe(true);
    }
  });

  it('paths', () => {
    expect(BOQ_EVIDENCE_PATH_RE.test(storagePaths.boqEvidence(org, pid, 'b1'))).toBe(true);
    expect(BOQ_EXPORT_PATH_RE.test(storagePaths.boqExportFile(org, pid, 'e1'))).toBe(true);
    const uuid = '0b0f6a4e-2d1c-4b8a-9f3e-123456789abc';
    expect(LIBRARY_IMPORT_PATH_RE.test(storagePaths.libraryImport(org, uuid, 'xls'))).toBe(true);
    expect(LIBRARY_IMPORT_PATH_RE.test(`orgs/${org}/imports/${uuid}.pdf`)).toBe(false);
    expect(ARTIFACT_PATH_RE.test(storagePaths.links(org, pid, 's', 'v'))).toBe(true);
    // exports / evidence are never signable as sheet artifacts
    expect(ARTIFACT_PATH_RE.test(storagePaths.boqExportFile(org, pid, 'e1'))).toBe(false);
  });
});

describe('jobs union', () => {
  const uuid = '0b0f6a4e-2d1c-4b8a-9f3e-123456789abc';
  it('boq.build and library.import validate; ingest still does', () => {
    expect(IngestTopicJobSchema.safeParse({ schemaVersion: 1, type: 'boq.build', jobId: 'j', orgId: org, projectId: pid, buildId: 'b', traceparent: null }).success).toBe(true);
    const imp = {
      schemaVersion: 1, type: 'library.import', jobId: 'j', orgId: org, projectId: null, importId: uuid,
      storagePath: storagePaths.libraryImport(org, uuid, 'xlsx'), sourceKind: 'xlsx', traceparent: null,
    };
    expect(LibraryImportJobSchema.safeParse(imp).success).toBe(true);
    expect(IngestTopicJobSchema.safeParse(imp).success).toBe(true);
    expect(LibraryImportJobSchema.safeParse({ ...imp, sourceKind: 'xls' }).success).toBe(false);
    expect(LibraryImportJobSchema.safeParse({ ...imp, storagePath: storagePaths.libraryImport('orgB', uuid, 'xlsx') }).success).toBe(false);
    expect(IngestTopicJobSchema.safeParse({ schemaVersion: 1, type: 'boq.build', jobId: 'j', orgId: org, projectId: pid, traceparent: null }).success).toBe(false);
  });
  it('job docs without a sheet set', () => {
    const j = { id: 'j', orgId: org, projectId: null, type: 'library.import', importId: uuid, status: 'queued', progress: { stage: 'import', pct: 0 }, attempts: 0, updatedAt: null };
    expect(JobSchema.safeParse(j).success).toBe(true);
  });
});

describe('library / templates / rules', () => {
  it('default template and rules are valid', () => {
    expect(BoqTemplateSchema.safeParse({ ...DEFAULT_BOQ_TEMPLATE, updatedAt: null }).success).toBe(true);
    const ids = new Set<string>();
    for (const r of DEFAULT_BOQ_RULES) {
      const res = BoqRuleSchema.safeParse({ ...defaultRuleDoc(r), updatedAt: null });
      expect(res.success, `${r.id}: ${res.success ? '' : res.error.message}`).toBe(true);
      expect(ids.has(r.id)).toBe(false);
      ids.add(r.id);
    }
    const codes = DEFAULT_BOQ_RULES.filter((r) => r.kind === 'composite_lighting').map((r) => r.itemCode);
    expect(codes).toEqual(expect.arrayContaining(['4.09', '4.10', '4.11', '4.12', '4.14', '4.15', '4.16']));
    const install = DEFAULT_BOQ_RULES.find((r) => r.kind === 'install_count');
    expect(install?.itemCode).toBe('9.01');
    expect(install?.match).toMatchObject({ excludeSupply: [], excludeLifecycle: ['demolish'], excludeClasses: ['ceiling_fan'] });
    const none = DEFAULT_BOQ_RULES.filter((r) => r.id.startsWith('r_none_'));
    expect(none.map((r) => r.itemCode)).toEqual(Array(11).fill(null));
    expect(none.every((r) => r.kind === 'class_to_item')).toBe(true);
  });
  it('template rejects duplicate chapters / missing qty column', () => {
    const t = { ...DEFAULT_BOQ_TEMPLATE, updatedAt: null };
    expect(BoqTemplateSchema.safeParse({ ...t, chapters: [t.chapters[0], { ...t.chapters[0], code: '1' }] }).success).toBe(false);
    expect(BoqTemplateSchema.safeParse({ ...t, columns: t.columns.filter((c) => c.key !== 'qty') }).success).toBe(false);
  });
  it('rule patch / import request', () => {
    expect(PatchBoqRuleRequestSchema.safeParse({}).success).toBe(false);
    expect(PatchBoqRuleRequestSchema.safeParse({ enabled: false, priority: 5, itemCode: '4.10' }).success).toBe(true);
    expect(PatchBoqRuleRequestSchema.safeParse({ match: {} }).success).toBe(false);
    expect(CreateLibraryImportRequestSchema.safeParse({ orgId: org, filename: 'boq.xls', sizeBytes: 10 }).success).toBe(true);
    expect(CreateLibraryImportRequestSchema.safeParse({ orgId: org, filename: 'boq.pdf', sizeBytes: 10 }).success).toBe(false);
    expect(CreateLibraryImportRequestSchema.safeParse({ orgId: org, filename: 'boq.xlsx', sizeBytes: 21 * 1024 * 1024 }).success).toBe(false);
  });
  it('generated defaults file matches the contracts', () => {
    const f = JSON.parse(readFileSync(join(__dirname, '..', 'json-schema', 'defaults', 'boq-defaults.json'), 'utf8')) as { template: unknown; rules: unknown[] };
    expect(f.template).toEqual(JSON.parse(JSON.stringify(DEFAULT_BOQ_TEMPLATE)));
    expect(f.rules).toEqual(JSON.parse(JSON.stringify(DEFAULT_BOQ_RULES.map(defaultRuleDoc))));
  });
});
