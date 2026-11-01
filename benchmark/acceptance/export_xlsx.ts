/**
 * Stage 10 acceptance (Pipeline): export a locally built BOQ to Excel with the PRODUCT code path.
 *
 * Mirrors `BoqService.export` (apps/api/src/boq/boq.service.ts): worker docs → `toBoqLine` / `toTemplate`
 * (apps/api/src/db/boq-docs.ts), `compareLines`, the red-line export gate, `groupEvidence`, `buildBoqWorkbook`
 * (apps/api/src/boq/excel.ts). Only the storage / repository plumbing is replaced by reads of a local artifacts root
 * written by workers/drawing/scripts/{ingest_local,boq_local}.py. No customer data is read from or written to git.
 *
 * Bundled the way apps/api/scripts/build.cjs bundles the API (contracts aliased to its built CJS, npm packages external):
 *
 *   cd apps/api && ./node_modules/.bin/esbuild ../../benchmark/acceptance/export_xlsx.ts --bundle --platform=node \
 *     --format=cjs --packages=external --alias:@kamutan/contracts=../../packages/contracts/dist/cjs/index.js \
 *     --tsconfig-raw='{"compilerOptions":{"experimentalDecorators":true}}' --outfile=$TMP/export_xlsx.cjs
 *   NODE_PATH=$PWD/node_modules node $TMP/export_xlsx.cjs ROOT OUT.xlsx [--split byFloor]
 *
 * Prints a JSON summary (template used, line counts, export-gate verdict, schema rejects) on stdout.
 */
import { gunzipSync } from 'node:zlib';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BoqEvidenceItemSchema, DEFAULT_BOQ_TEMPLATE, type BoqLine, type BoqTemplate } from '@kamutan/contracts';
import { countLines, toBoqLine, toTemplate } from '../../apps/api/src/db/boq-docs';
import { compareLines, groupEvidence } from '../../apps/api/src/boq/boq.service';
import { buildBoqWorkbook, type EvidenceGroup } from '../../apps/api/src/boq/excel';

const ORG = 'org-demo';
const PROJECT = 'p-noah';

function listDocs(dir: string): Array<[string, Record<string, unknown>]> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f.slice(0, -5), JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>]);
}

async function main(): Promise<void> {
  const [root, out, ...rest] = process.argv.slice(2);
  if (!root || !out) throw new Error('usage: export_xlsx.ts ROOT OUT.xlsx [--split byFloor|summed]');
  const split = rest.includes('--split') ? (rest[rest.indexOf('--split') + 1] as 'byFloor' | 'summed') : 'summed';
  const fs = join(root, '_firestore');
  const proj = join(fs, 'orgs', ORG, 'projects', PROJECT);

  const lines: BoqLine[] = listDocs(join(proj, 'boqLines')).map(([id, d]) => toBoqLine(id, d)).sort(compareLines);
  const templates = listDocs(join(fs, 'orgs', ORG, 'boqTemplates')).map(([id, d]) => ({ id, t: toTemplate(id, d) }));
  const rejectedTemplates = templates.filter((x) => x.t === null).map((x) => x.id);
  const parsed = templates.map((x) => x.t).filter((t): t is BoqTemplate => t !== null);
  // BoqService.templateFor: the org's default template, else DEFAULT_BOQ_TEMPLATE (after seedDefaults)
  const template: BoqTemplate = parsed.find((t) => t.default) ?? { ...DEFAULT_BOQ_TEMPLATE, updatedAt: null };

  const counts = countLines(lines);
  const openRed = lines.filter((l) => l.level === 'red' && l.status !== 'approved').length;

  const project = (JSON.parse(readFileSync(join(proj + '.json'), 'utf8')) ?? {}) as Record<string, unknown>;
  const latest = ((project.boq as Record<string, unknown> | undefined)?.latestBuildId as string | undefined) ?? null;
  const evidence = new Map<string, EvidenceGroup[]>();
  const evPath = latest ? join(root, 'orgs', ORG, 'projects', PROJECT, 'boq', latest, 'evidence.json.gz') : null;
  let evidenceLines = 0;
  if (evPath && existsSync(evPath)) {
    const ev = JSON.parse(gunzipSync(readFileSync(evPath)).toString('utf8')) as { lines: Record<string, unknown[]> };
    const titles = new Map<string, string>();
    for (const [sid, s] of listDocs(join(proj, 'sheets'))) {
      const cls = s.classification as Record<string, unknown> | undefined;
      titles.set(sid, String(s.title || cls?.sheetTitle || sid));
    }
    for (const l of lines) {
      const items = (ev.lines[l.id] ?? []).map((it) => BoqEvidenceItemSchema.strip().safeParse(it)).filter((r) => r.success).map((r) => r.data);
      if (!items.length) continue;
      evidenceLines++;
      evidence.set(
        l.id,
        groupEvidence(items).map((g) => ({ sheet: titles.get(g.sheetId) ?? g.sheetId, floor: g.floor, count: g.count, detectionIds: g.detectionIds, linkGroups: g.linkGroupIds.map((id) => ({ id, switchIds: [], pointIds: [] })) })),
      );
    }
  }
  const data = await buildBoqWorkbook({
    projectName: String(project.name ?? 'בית משפחת נח'),
    date: new Date(),
    template,
    lines,
    split,
    markDraft: true,
    evidence,
    vatRate: template.vatRate ?? 0.18,
  });
  writeFileSync(out, data);
  process.stdout.write(
    JSON.stringify({
      out,
      template: { id: template.id, name: template.name, default: template.default, source: template.source },
      templatesOnDisk: templates.map((x) => x.id),
      rejectedTemplates,
      latestBuildId: latest,
      counts,
      exportGate: { blockExportOnRedDefault: true, openRed, wouldBlock: openRed > 0 },
      evidenceLines,
      bytes: data.length,
    }) + '\n',
  );
}

main().catch((e: unknown) => {
  process.stderr.write(`${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
