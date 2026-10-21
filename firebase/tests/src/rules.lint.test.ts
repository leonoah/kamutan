/**
 * Static checks that run WITHOUT the emulator (local + every CI job).
 * They guard structural invariants of the rules; behaviour is covered by the
 * emulator suites (firestore.rules.test.ts / storage.rules.test.ts).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BOQ_LINE_API_FIELDS, BOQ_LINE_TRANSITIONS, CLIENT_READABLE_STORAGE_PREFIXES, COLLECTIONS, CORRECTION_KINDS, INGEST_STAGES, JOB_TYPES,
  REVIEW_ITEM_CLIENT_FIELDS, paths,
} from '../../model';
import { FIREBASE_DIR, FIRESTORE_RULES, STORAGE_RULES } from './env';
import { WRITE_METHODS, isDenyAll, parseRules, stripComments } from './rules-lint';

const fs = parseRules(FIRESTORE_RULES);
const st = parseRules(STORAGE_RULES);
const DOCS = '/databases/{database}/documents';
const QUARANTINE = '/b/{bucket}/o/orgs/{orgId}/quarantine/{fileId}';
const IMPORTS = '/b/{bucket}/o/orgs/{orgId}/imports/{fileName}';
const LEGACY_UPLOAD = '/b/{bucket}/o/orgs/{orgId}/uploads/{rest=**}';
const PROJ = '/b/{bucket}/o/orgs/{orgId}/projects/{projectId}';

/**
 * The ONLY place a client may write (ADR 0008 §authz-2). Sprint 3: boqLines moved to the API; Sprint 4: corrections
 * moved to the API (role per kind + audit + rebuild scheduling).
 */
const CLIENT_WRITABLE: Record<string, string[]> = {
  [`${DOCS}/orgs/{orgId}/projects/{projectId}/reviewItems/{itemId}`]: ['update'],
};

/** `/a/{x}/b/{rest=**}` -> /^\/a\/[^/]+\/b\/.+$/ */
function matchPathToRegExp(matchPath: string): RegExp {
  const parts = matchPath.split(/(\{[A-Za-z]+(?:=\*\*)?\})/);
  const body = parts
    .map((part) => {
      if (/^\{[A-Za-z]+=\*\*\}$/.test(part)) return '.+';
      if (/^\{[A-Za-z]+\}$/.test(part)) return '[^/]+';
      return part.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${body}$`);
}

const blockOf = (src: string, name: string) => {
  const s = stripComments(src);
  const start = s.indexOf(`match /${name}/`);
  expect(start, name).toBeGreaterThan(-1);
  const nextMatch = s.indexOf('match /', start + 1);
  return s.slice(start, nextMatch === -1 ? undefined : nextMatch);
};

describe('firestore.rules (static)', () => {
  it('is rules_version 2, cloud.firestore, braces balanced', () => {
    expect(fs.version).toBe('2');
    expect(fs.service).toBe('cloud.firestore');
    expect(fs.balanced).toBe(true);
  });

  it('has a default-deny catch-all', () => {
    const catchAll = fs.allows.filter((a) => a.path === `${DOCS}/{document=**}`);
    expect(catchAll).toHaveLength(1);
    expect(catchAll[0].methods.sort()).toEqual(['read', 'write']);
    expect(isDenyAll(catchAll[0].condition)).toBe(true);
  });

  it('never uses `if true` and every allow requires auth or is `false`', () => {
    expect(stripComments(FIRESTORE_RULES)).not.toMatch(/if\s+true\b/);
    for (const a of fs.allows) {
      if (isDenyAll(a.condition)) continue;
      expect(a.condition, `line ${a.line}`).toMatch(/signedIn\(\)|isMember|roleIn|isAdmin|canCorrect/);
    }
  });

  it('client writes exist ONLY on reviewItems(update)', () => {
    const found: Record<string, string[]> = {};
    for (const a of fs.allows) {
      const writes = a.methods.filter((m) => WRITE_METHODS.has(m));
      if (writes.length === 0 || isDenyAll(a.condition)) continue;
      (found[a.path] ??= []).push(...writes);
    }
    expect(found).toEqual(CLIENT_WRITABLE);
  });

  it('every `match` under orgs explicitly denies writes or is in the allow-list', () => {
    const orgMatches = fs.matchPaths.filter((p) => p.startsWith(`${DOCS}/orgs/`));
    expect(orgMatches.length).toBeGreaterThan(10);
    for (const p of orgMatches) {
      const allows = fs.allows.filter((a) => a.path === p);
      const writeAllows = allows.filter((a) => a.methods.some((m) => WRITE_METHODS.has(m)));
      expect(writeAllows.length, `${p} must state its write policy`).toBeGreaterThan(0);
      if (!(p in CLIENT_WRITABLE)) {
        for (const w of writeAllows) expect(isDenyAll(w.condition), `${p} line ${w.line}`).toBe(true);
      }
    }
  });

  it('audit log, share links, members and jobs are never client-writable', () => {
    for (const seg of ['auditLog/{eventId}', 'shareLinks/{linkId}', 'members/{uid}', 'jobs/{jobId}']) {
      const allows = fs.allows.filter((a) => a.path.endsWith(seg));
      expect(allows.length, seg).toBeGreaterThan(0);
      for (const a of allows.filter((x) => x.methods.some((m) => WRITE_METHODS.has(m)))) {
        expect(isDenyAll(a.condition), seg).toBe(true);
      }
    }
    expect(fs.allows.find((a) => a.path.endsWith('auditLog/{eventId}') && a.methods.includes('read'))?.condition)
      .toBe('isAdmin(orgId)');
  });

  it('Sprint 5: shareLinks / shareTokens / offboardingCertificates / auditMeta / reprocessRequests are deny-all; exports member-read; offboardingExports admin-read', () => {
    for (const seg of ['shareLinks/{linkId}', 'shareTokens/{tokenHash}', 'offboardingCertificates/{orgId}', 'auditMeta/{docId}', 'reprocessRequests/{sheetId}']) {
      const allows = fs.allows.filter((a) => a.path.endsWith(seg));
      expect(allows.length, seg).toBeGreaterThan(0);
      for (const a of allows) expect(isDenyAll(a.condition), seg).toBe(true);
    }
    expect(fs.allows.find((a) => a.path.endsWith('/exports/{exportId}') && a.methods.includes('read'))?.condition).toBe('isMember(orgId)');
    expect(fs.allows.find((a) => a.path.endsWith('offboardingExports/{exportId}') && a.methods.includes('read'))?.condition).toBe('isAdmin(orgId)');
    expect(stripComments(FIRESTORE_RULES)).not.toContain('canEditShare');
  });

  it('jobs are read by membership of resource.data.orgId', () => {
    const r = fs.allows.find((a) => a.path === `${DOCS}/jobs/{jobId}` && a.methods.includes('get'));
    expect(r?.condition).toContain('isMember(resource.data.orgId)');
  });

  it('every model collection has a match block', () => {
    for (const c of COLLECTIONS) {
      expect(fs.matchPaths.some((p) => p.includes(`/${c}/{`)), c).toBe(true);
    }
  });

  it('model client-writable field lists match the rules (boqLines: API-only since Sprint 3)', () => {
    const boq = blockOf(FIRESTORE_RULES, 'boqLines');
    expect(boq).toContain('allow read: if isMember(orgId);');
    expect(boq).toContain('allow write: if false;');
    expect(boq).not.toMatch(/allow (update|create)/);
    expect(BOQ_LINE_API_FIELDS).toEqual(expect.arrayContaining(['status', 'note', 'qtyOverride', 'qtyOverrideReason']));
    expect(Object.values(BOQ_LINE_TRANSITIONS).flat()).toHaveLength(4);
    const ri = blockOf(FIRESTORE_RULES, 'reviewItems');
    expect(ri).toContain(`hasOnly([${REVIEW_ITEM_CLIENT_FIELDS.map((f) => `'${f}'`).join(', ')}])`);
    const corr = blockOf(FIRESTORE_RULES, 'corrections');
    expect(corr).toContain('allow read: if isMember(orgId);');
    expect(corr).toContain('allow write: if false;');
    expect(corr).not.toMatch(/allow (create|update)/);
  });
});

describe('storage.rules (static)', () => {
  it('is rules_version 2, firebase.storage, balanced, default deny, no `if true`', () => {
    expect(st.version).toBe('2');
    expect(st.service).toBe('firebase.storage');
    expect(st.balanced).toBe(true);
    const catchAll = st.allows.find((a) => a.path === '/b/{bucket}/o/{allPaths=**}');
    expect(catchAll?.condition).toBe('false');
    expect(stripComments(STORAGE_RULES)).not.toMatch(/if\s+true\b/);
  });

  it('only `create` on the quarantine + import slots is client-writable, with role + id + size + type checks', () => {
    const all = st.allows.filter((a) => a.methods.some((m) => WRITE_METHODS.has(m)) && !isDenyAll(a.condition));
    expect(all.map((a) => a.path).sort()).toEqual([IMPORTS, QUARANTINE].sort());
    const imp = all.find((a) => a.path === IMPORTS);
    expect(imp?.methods).toEqual(['create']);
    for (const frag of ['signedIn()', 'canUpload(orgId)', 'opaqueId(orgId)', 'isImportName(fileName)', 'validImport()']) expect(imp?.condition).toContain(frag);
    const vi = stripComments(STORAGE_RULES).slice(stripComments(STORAGE_RULES).indexOf('function validImport()'));
    const viBody = vi.slice(0, vi.indexOf('}'));
    for (const frag of ['resource == null', 'request.resource.size > 0', '20 * 1024 * 1024', 'ms-excel', 'spreadsheetml']) expect(viBody, frag).toContain(frag);
    for (const bad of ['html', 'svg', 'javascript', 'text/', 'application/zip']) expect(viBody).not.toContain(bad);
    const writes = all.filter((a) => a.path === QUARANTINE);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(QUARANTINE);
    expect(writes[0].methods).toEqual(['create']);
    for (const frag of ['signedIn()', 'canUpload(orgId)', 'opaqueId(orgId)', 'isUuid(fileId)', 'validUpload()']) {
      expect(writes[0].condition).toContain(frag);
    }
    const vu = stripComments(STORAGE_RULES).slice(stripComments(STORAGE_RULES).indexOf('function validUpload()'));
    for (const frag of ['resource == null', 'request.resource.size > 0', '100 * 1024 * 1024', 'allowedType()']) {
      expect(vu.slice(0, vu.indexOf('}')), frag).toContain(frag);
    }
    expect(STORAGE_RULES).toContain('firestore.exists(');
    expect(STORAGE_RULES).toContain('firestore.get(');
  });

  it('allowed content types never include html, svg, javascript or xml', () => {
    const at = stripComments(STORAGE_RULES).slice(stripComments(STORAGE_RULES).indexOf('function allowedType()'));
    const body = at.slice(0, at.indexOf('}'));
    for (const bad of ['html', 'svg', 'javascript', 'xml', 'text/', 'zip']) expect(body).not.toContain(bad);
  });

  it('nothing in the bucket is client-readable (signed URLs only, SEC-20)', () => {
    const reads = st.allows.filter((a) => a.methods.some((m) => m === 'read' || m === 'get' || m === 'list'));
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(isDenyAll(r.condition), `${r.path} line ${r.line}`).toBe(true);
    expect(CLIENT_READABLE_STORAGE_PREFIXES).toEqual([]);
  });

  it('quarantine, sources, project uploads, sheet-version artifacts and derived each state an explicit deny', () => {
    for (const p of [
      QUARANTINE,
      LEGACY_UPLOAD,
      `${PROJ}/sources/{rest=**}`,
      `${PROJ}/uploads/{rest=**}`,
      `${PROJ}/sheets/{sheetId}/versions/{versionId}/{rest=**}`,
      `${PROJ}/derived/{rest=**}`,
      '/b/{bucket}/o/orgs/{orgId}/derived/{rest=**}',
      IMPORTS,
      `${PROJ}/exports/{rest=**}`,
      `${PROJ}/boq/{rest=**}`,
      `${PROJ}/similar/{rest=**}`,
    ]) {
      expect(st.matchPaths, p).toContain(p);
      const allows = st.allows.filter((a) => a.path === p);
      expect(allows.some((a) => a.methods.includes('read') && isDenyAll(a.condition)), `${p} read`).toBe(true);
      const writes = allows.filter((a) => a.methods.some((m) => WRITE_METHODS.has(m)));
      expect(writes.length, `${p} write policy`).toBeGreaterThan(0);
      if (p !== QUARANTINE && p !== IMPORTS) for (const w of writes) expect(isDenyAll(w.condition), p).toBe(true);
    }
  });

  it('id checks use the same patterns as packages/contracts (ID / QUARANTINE_PATH_RE)', () => {
    const src = stripComments(STORAGE_RULES);
    expect(src).toContain("id.matches('^[A-Za-z0-9_-]{1,128}$')");
    expect(src).toContain("id.matches('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')");
  });

  it('model storage paths match the rule paths', () => {
    expect(paths.upload('o', 'u', 'f')).toBe('orgs/o/uploads/u/f');
    expect(paths.quarantine('o', 'f')).toBe('orgs/o/quarantine/f');
    expect(paths.projectUpload('o', 'p', 's', 'pdf')).toBe('orgs/o/projects/p/uploads/s/source.pdf');
    expect(paths.derived('o', 'v1/tiles/0.webp')).toBe('orgs/o/derived/v1/tiles/0.webp');
    expect(paths.source('o', 'p', 'a'.repeat(64), 'pdf')).toBe(`orgs/o/projects/p/sources/${'a'.repeat(64)}.pdf`);
    expect(paths.artifacts('o', 'p', 's', 'v')).toBe('orgs/o/projects/p/sheets/s/versions/v');
    expect(paths.tile('o', 'p', 's', 'v', 3, 1, 2)).toBe('orgs/o/projects/p/sheets/s/versions/v/tiles/3/1_2.webp');
    // every model storage path lands in a match block of storage.rules
    const asRule = (objPath: string) => `/b/{bucket}/o/${objPath}`;
    const covered = (objPath: string) =>
      st.matchPaths.some((m) => m !== '/b/{bucket}/o/{allPaths=**}' && matchPathToRegExp(m).test(asRule(objPath)));
    for (const objPath of [
      paths.upload('o', 'u', 'f'), paths.quarantine('o', 'f'), paths.projectUpload('o', 'p', 's', 'pdf'), paths.source('o', 'p', 'a'.repeat(64), 'pdf'), paths.tile('o', 'p', 's', 'v', 0, 0, 0),
      `${paths.artifacts('o', 'p', 's', 'v')}/thumbnail.webp`, paths.derived('o', 'x/y'),
    ]) {
      expect(covered(objPath), objPath).toBe(true);
    }
    expect(covered('orgs/o/other/x')).toBe(false);
    expect(covered('orgs/o/quarantine/a/b')).toBe(false);
  });
});

describe('firestore.rules (static) — Sprint 1 ingest collections', () => {
  const SHEETS = `${DOCS}/orgs/{orgId}/projects/{projectId}/sheets/{sheetId}`;
  const VERSIONS = `${SHEETS}/versions/{versionId}`;
  const JOBS = `${DOCS}/jobs/{jobId}`;

  it.each([SHEETS, VERSIONS, JOBS])('%s: read requires membership, every write is denied', (p) => {
    const allows = fs.allows.filter((a) => a.path === p);
    const read = allows.find((a) => a.methods.some((m) => m === 'read' || m === 'get'));
    expect(read?.condition).toMatch(/isMember\(/);
    const writes = allows.filter((a) => a.methods.some((m) => WRITE_METHODS.has(m)));
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(isDenyAll(w.condition), `${p} line ${w.line}`).toBe(true);
  });

  it('jobs read requires a string orgId and membership of that org', () => {
    const r = fs.allows.find((a) => a.path === JOBS && a.methods.includes('list'));
    expect(r?.condition).toContain('resource.data.orgId is string');
    expect(r?.condition).toContain('isMember(resource.data.orgId)');
  });

  it('no collection-group match exposes sheets, versions or jobs', () => {
    for (const p of fs.matchPaths.filter((m) => m.includes('{path=**}'))) {
      expect(p).not.toMatch(/\/(sheets|versions|jobs)\//);
    }
  });

  it('model has the Sprint 1 + 2 ingest stages and job type', () => {
    expect(INGEST_STAGES).toEqual(['ingest', 'render', 'ocr', 'classify', 'scale', 'legend', 'detect', 'rooms', 'done']);
    expect(JOB_TYPES).toContain('ingest.sheet_version');
  });
});

describe('Sprint 2 — legend entries, symbol mappings, understanding artifacts, llm-cache (static)', () => {
  const LEGEND = `${DOCS}/orgs/{orgId}/projects/{projectId}/legendEntries/{entryId}`;
  const MAPPINGS = `${DOCS}/orgs/{orgId}/symbolMappings/{mappingId}`;
  const LLM_CACHE = '/b/{bucket}/o/orgs/{orgId}/llm-cache/{rest=**}';
  const VERSION_ARTIFACTS = `${PROJ}/sheets/{sheetId}/versions/{versionId}/{rest=**}`;

  it.each([LEGEND, MAPPINGS])('%s: members read, every client write denied', (p) => {
    const allows = fs.allows.filter((a) => a.path === p);
    const read = allows.find((a) => a.methods.includes('read'));
    expect(read?.condition).toBe('isMember(orgId)');
    const writes = allows.filter((a) => a.methods.some((m) => WRITE_METHODS.has(m)));
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(isDenyAll(w.condition), `${p} line ${w.line}`).toBe(true);
  });

  it('no collection-group match exposes legendEntries or symbolMappings', () => {
    for (const p of fs.matchPaths.filter((m) => m.includes('{path=**}'))) expect(p).not.toMatch(/legendEntries|symbolMappings/);
  });

  it('llm-cache has an explicit read+write deny in storage.rules', () => {
    expect(st.matchPaths).toContain(LLM_CACHE);
    const allows = st.allows.filter((a) => a.path === LLM_CACHE);
    expect(allows.map((a) => [a.methods.sort().join(','), a.condition])).toEqual([['read,write', 'false']]);
  });

  it('every Sprint-2 model object path lands in a deny-all storage match (never the quarantine slot)', () => {
    const objects = [
      paths.legendArtifact('o', 'p', 's', 'v'),
      paths.detectionsArtifact('o', 'p', 's', 'v'),
      paths.roomsArtifact('o', 'p', 's', 'v'),
      paths.legendThumb('o', 'p', 's', 'v', 'le_s_0'),
      paths.unknownThumb('o', 'p', 's', 'v', 'u_0'),
      paths.llmCache('o', 'legend_label/abc.json'),
    ];
    for (const obj of objects) {
      const target = `/b/{bucket}/o/${obj}`;
      const hits = st.matchPaths.filter((m) => m !== '/b/{bucket}/o/{allPaths=**}' && matchPathToRegExp(m).test(target));
      expect(hits, obj).toHaveLength(1);
      expect([VERSION_ARTIFACTS, LLM_CACHE]).toContain(hits[0]);
      for (const a of st.allows.filter((x) => x.path === hits[0])) expect(isDenyAll(a.condition), obj).toBe(true);
    }
  });

  it('model doc shapes follow the brief (no Sprint-0 symbolMapping keys)', () => {
    const model = readFileSync(join(FIREBASE_DIR, 'model.ts'), 'utf8');
    const iface = (name: string) => model.slice(model.indexOf(`export interface ${name} {`), model.indexOf('}', model.indexOf(`export interface ${name} {`)));
    for (const f of ['class', 'ignored', 'itemCode', 'label', 'confirmedBy', 'confirmedAt', 'uses']) expect(iface('SymbolMapping')).toContain(`${f}:`);
    expect(iface('SymbolMapping')).not.toContain('keyType');
    for (const f of ['sheetId', 'versionId', 'label', 'labelConfidence', 'suggestedClass', 'class', 'itemCode', 'signature', 'thumbPath', 'status', 'updatedAt']) {
      expect(iface('LegendEntry'), f).toContain(`${f}:`);
    }
    expect(paths.symbolMapping('o', 'sig')).toBe('orgs/o/symbolMappings/sig');
    expect(paths.legendEntry('o', 'p', 'le_1')).toBe('orgs/o/projects/p/legendEntries/le_1');
  });
});

describe('Sprint 3 — BOQ, library, rules, imports, exports (static)', () => {
  const ORG = `${DOCS}/orgs/{orgId}`;
  const PRJ = `${ORG}/projects/{projectId}`;
  const DOCS3 = [`${ORG}/boqRules/{ruleId}`, `${ORG}/libraryImports/{importId}`, `${ORG}/itemLibrary/{itemId}`, `${ORG}/boqTemplates/{templateId}`, `${PRJ}/boqBuilds/{buildId}`, `${PRJ}/exports/{exportId}`, `${PRJ}/boqLines/{lineId}`];

  it.each(DOCS3)('%s: members read, every client write denied', (p) => {
    const allows = fs.allows.filter((a) => a.path === p);
    expect(allows.find((a) => a.methods.includes('read'))?.condition).toBe('isMember(orgId)');
    const writes = allows.filter((a) => a.methods.some((m) => WRITE_METHODS.has(m)));
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(isDenyAll(w.condition), `${p} line ${w.line}`).toBe(true);
  });

  it('job types include boq.build, library.import and (Sprint 4) symbols.find_similar', () => {
    expect(JOB_TYPES).toEqual(['ingest.sheet_version', 'boq.build', 'library.import', 'symbols.find_similar', 'export.marked_pdf', 'offboarding.export']);
  });

  it('import slot name check mirrors LIBRARY_IMPORT_PATH_RE; export/evidence/links objects land in deny-all matches', () => {
    expect(stripComments(STORAGE_RULES)).toContain("name.matches('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](xls|xlsx)$')");
    for (const obj of [paths.boqExportFile('o', 'p', 'e1'), paths.boqEvidence('o', 'p', 'b1'), paths.linksArtifact('o', 'p', 's', 'v')]) {
      const target = `/b/{bucket}/o/${obj}`;
      const hits = st.matchPaths.filter((m) => m !== '/b/{bucket}/o/{allPaths=**}' && matchPathToRegExp(m).test(target));
      expect(hits, obj).toHaveLength(1);
      for (const a of st.allows.filter((x) => x.path === hits[0])) expect(isDenyAll(a.condition), obj).toBe(true);
    }
    const imp = `/b/{bucket}/o/${paths.libraryImportObject('o', '0b6f1c2e-6a7d-4f53-9b1e-2f0c8d3a4e51', 'xlsx')}`;
    expect(st.matchPaths.filter((m) => m !== '/b/{bucket}/o/{allPaths=**}' && matchPathToRegExp(m).test(imp))).toEqual([IMPORTS]);
  });
});

describe('Sprint 4 — corrections, batches, room settings, similar searches (static)', () => {
  const PRJ = `${DOCS}/orgs/{orgId}/projects/{projectId}`;
  const DOCS4 = [`${PRJ}/corrections/{correctionId}`, `${PRJ}/correctionBatches/{batchId}`, `${PRJ}/roomSettings/{settingsId}`, `${PRJ}/similarSearches/{searchId}`];

  it.each(DOCS4)('%s: members read, every client write denied', (p) => {
    const allows = fs.allows.filter((a) => a.path === p);
    expect(allows.find((a) => a.methods.includes('read'))?.condition).toBe('isMember(orgId)');
    const writes = allows.filter((a) => a.methods.some((m) => WRITE_METHODS.has(m)));
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(isDenyAll(w.condition), `${p} line ${w.line}`).toBe(true);
  });

  it('no collection-group match exposes the Sprint 4 collections', () => {
    for (const p of fs.matchPaths.filter((m) => m.includes('{path=**}'))) expect(p).not.toMatch(/corrections|correctionBatches|roomSettings|similarSearches/);
  });

  it('similar/ crops land in exactly one deny-all storage match; model paths + kinds follow the brief', () => {
    const target = `/b/{bucket}/o/${paths.similarThumb('o', 'p', 'ss1', 'c_1')}`;
    const hits = st.matchPaths.filter((m) => m !== '/b/{bucket}/o/{allPaths=**}' && matchPathToRegExp(m).test(target));
    expect(hits).toEqual([`${PROJ}/similar/{rest=**}`]);
    expect(st.allows.filter((a) => a.path === hits[0]).map((a) => [a.methods.sort().join(','), a.condition])).toEqual([['read,write', 'false']]);
    expect(paths.roomSettings('o', 'p', 's1-p0', 'r_1')).toBe('orgs/o/projects/p/roomSettings/s1-p0__r_1');
    expect(paths.correctionBatch('o', 'p', 'b')).toBe('orgs/o/projects/p/correctionBatches/b');
    expect(paths.similarSearch('o', 'p', 's')).toBe('orgs/o/projects/p/similarSearches/s');
    expect(CORRECTION_KINDS).toEqual(['add', 'remove', 'reclassify', 'move', 'link', 'unlink', 'measure', 'count', 'accept', 'reject']);
    const model = readFileSync(join(FIREBASE_DIR, 'model.ts'), 'utf8');
    const iface = model.slice(model.indexOf('export interface Correction {'), model.indexOf('}\n', model.indexOf('export interface Correction {')));
    for (const f of ['kind', 'sheetId', 'versionId', 'anchorMm', 'radiusMm', 'detectionId', 'signature', 'class', 'itemCode', 'linkGroupId', 'geometry', 'quantity', 'unit', 'roomId', 'floor', 'reason', 'batchId', 'by', 'at', 'revertedAt']) {
      expect(iface, f).toContain(`  ${f}`);
    }
    expect(iface).not.toContain('authorId');
  });
});

describe('firestore.indexes.json', () => {
  const idx = JSON.parse(readFileSync(join(FIREBASE_DIR, 'firestore.indexes.json'), 'utf8')) as {
    indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string }> }>;
  };
  const has = (cg: string, fields: string[]) =>
    idx.indexes.some((i) => i.collectionGroup === cg && fields.every((f, n) => i.fields[n]?.fieldPath === f));

  it('covers the UI queries', () => {
    expect(has('reviewItems', ['level', 'status'])).toBe(true);
    expect(has('boqLines', ['chapter', 'code'])).toBe(true);
    expect(has('jobs', ['orgId', 'createdAt'])).toBe(true);
  });

  it('only indexes known collections', () => {
    for (const i of idx.indexes) expect(COLLECTIONS as readonly string[]).toContain(i.collectionGroup);
  });
});
