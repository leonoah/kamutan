import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { BoqEvidenceArtifactSchema, LinksArtifactSchema, DEFAULT_BOQ_TEMPLATE, effectiveQty, type BoqTemplate } from '@kamutan/contracts';
import { groupEvidence } from '../../src/boq/boq.service';
import { buildBoqWorkbook, EVIDENCE_SHEET, MAIN_SHEET, type EvidenceGroup } from '../../src/boq/excel';
import { toBoqLine } from '../../src/db/boq-docs';

/**
 * Export from Worker-BOQ's REAL local build (data outside git; skipped when absent):
 * dev-index.json → `boqLines` pointer → boq-lines.json (+ its evidence.json.gz). Writes the sample for the Data
 * agent's fidelity check: EXPORT_SAMPLE_PATH=/home/claude/kamutan-data/debug/export_sample.xlsx npx vitest run test/unit/export-real-sample.test.ts
 */
const ART = process.env.KAMUTAN_ARTIFACTS ?? '/home/claude/kamutan-data/artifacts';
const readable = (p: string) => {
  try {
    return existsSync(p) && readFileSync(p).length > 0;
  } catch {
    return false;
  }
};

describe.skipIf(!readable(join(ART, 'dev-index.json')))('export from the real local build (Noah)', () => {
  it('quantities match the build lines; "ראיות" lists sheet title + floor per evidence group', async () => {
    const index = JSON.parse(readFileSync(join(ART, 'dev-index.json'), 'utf8')) as Array<{ sheetId: string; title?: string; boqLines?: string }>;
    const pointer = index.find((e) => e.boqLines)?.boqLines as string;
    const dev = JSON.parse(readFileSync(join(ART, pointer), 'utf8')) as { buildId: string; evidence: string; lines: Array<Record<string, unknown> & { id: string }> };
    const lines = dev.lines.map((l) => toBoqLine(l.id, l));
    const ev = BoqEvidenceArtifactSchema.parse(JSON.parse(gunzipSync(readFileSync(join(ART, dev.evidence))).toString('utf8')));
    const titles = new Map(index.map((e) => [e.sheetId, e.title ?? e.sheetId]));
    const linksOf = (sheetId: string, versionId: string): Map<string, { switchIds: string[]; pointIds: string[] }> => {
      const p = join(ART, `orgs/org-demo/projects/p-noah/sheets/${sheetId}/versions/${versionId}/links.json.gz`);
      if (!readable(p)) return new Map();
      const doc = LinksArtifactSchema.parse(JSON.parse(gunzipSync(readFileSync(p)).toString('utf8')));
      return new Map(doc.groups.map((g) => [g.id, { switchIds: g.switchIds, pointIds: g.pointIds }]));
    };
    const evidence = new Map<string, EvidenceGroup[]>();
    for (const l of lines) {
      const items = ev.lines[l.id] ?? [];
      if (!items.length) continue;
      const groups = groupEvidence(items);
      // the "ראיות" counts add up to the line quantity (composite lines: one per switch group)
      expect(groups.reduce((a, g) => a + g.count, 0), l.code).toBeCloseTo(l.qty, 2);
      evidence.set(
        l.id,
        groups.map((g) => {
          const info = linksOf(g.sheetId, g.versionId);
          return {
            sheet: titles.get(g.sheetId) ?? g.sheetId,
            floor: g.floor,
            count: g.count,
            detectionIds: g.detectionIds,
            linkGroups: g.linkGroupIds.map((id) => ({ id, switchIds: info.get(id)?.switchIds ?? [], pointIds: info.get(id)?.pointIds ?? [] })),
          };
        }),
      );
    }
    const template = { ...structuredClone(DEFAULT_BOQ_TEMPLATE), updatedAt: null } as BoqTemplate;
    const buf = await buildBoqWorkbook({ projectName: 'בית משפחת נח, גני תקווה', date: new Date(), template, lines, split: 'summed', markDraft: false, evidence, vatRate: 0.18 });
    const out = process.env.EXPORT_SAMPLE_PATH ?? join(tmpdir(), 'kamutan-export-real.xlsx');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, buf);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet(MAIN_SHEET) as ExcelJS.Worksheet;
    const qtyByCode = new Map<string, unknown>();
    ws.eachRow((r) => {
      const c = r.getCell(1).value;
      if (typeof c === 'string' && /^\d+\.\d+$/.test(c)) qtyByCode.set(c, r.getCell(4).value);
    });
    for (const l of lines) expect(qtyByCode.get(l.code) as number, l.code).toBeCloseTo(effectiveQty(l), 2);
    const evWs = wb.getWorksheet(EVIDENCE_SHEET) as ExcelJS.Worksheet;
    const sheets = new Set<unknown>();
    const floors = new Set<unknown>();
    evWs.eachRow((r, n) => {
      if (n > 1) {
        sheets.add(r.getCell(3).value);
        floors.add(r.getCell(4).value);
      }
    });
    expect([...sheets].some((s) => typeof s === 'string' && s.startsWith('ת.'))).toBe(true);
    expect([...floors]).toEqual(expect.arrayContaining(['קומת קרקע']));
    let groupsListed = 0;
    evWs.eachRow((r) => {
      if (typeof r.getCell(8).value === 'string' && String(r.getCell(8).value).startsWith('lk_')) groupsListed++;
    });
    expect(groupsListed).toBeGreaterThan(0);
  });
});
