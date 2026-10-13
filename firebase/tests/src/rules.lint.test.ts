/**
 * Static checks that run WITHOUT the emulator (local + every CI job).
 * They guard structural invariants of the rules; behaviour is covered by the
 * emulator suites (firestore.rules.test.ts / storage.rules.test.ts).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BOQ_LINE_CLIENT_FIELDS, BOQ_LINE_TRANSITIONS, CLIENT_READABLE_STORAGE_PREFIXES, COLLECTIONS, INGEST_STAGES, JOB_TYPES,
  REVIEW_ITEM_CLIENT_FIELDS, paths,
} from '../../model';
import { FIREBASE_DIR, FIRESTORE_RULES, STORAGE_RULES } from './env';
import { WRITE_METHODS, isDenyAll, parseRules, stripComments } from './rules-lint';

const fs = parseRules(FIRESTORE_RULES);
const st = parseRules(STORAGE_RULES);
const DOCS = '/databases/{database}/documents';
const QUARANTINE = '/b/{bucket}/o/orgs/{orgId}/quarantine/{fileId}';
const LEGACY_UPLOAD = '/b/{bucket}/o/orgs/{orgId}/uploads/{rest=**}';
const PROJ = '/b/{bucket}/o/orgs/{orgId}/projects/{projectId}';

/** The ONLY places a client may write (ADR 0008 §authz-2). */
const CLIENT_WRITABLE: Record<string, string[]> = {
  [`${DOCS}/orgs/{orgId}/projects/{projectId}/corrections/{correctionId}`]: ['create'],
  [`${DOCS}/orgs/{orgId}/projects/{projectId}/reviewItems/{itemId}`]: ['update'],
  [`${DOCS}/orgs/{orgId}/projects/{projectId}/boqLines/{lineId}`]: ['update'],
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
      expect(a.condition, `line ${a.line}`).toMatch(/signedIn\(\)|isMember|roleIn|isAdmin|canEditShare|canCorrect|canApprove/);
    }
  });

  it('client writes exist ONLY on corrections(create), reviewItems(update), boqLines(update)', () => {
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

  it('jobs are read by membership of resource.data.orgId', () => {
    const r = fs.allows.find((a) => a.path === `${DOCS}/jobs/{jobId}` && a.methods.includes('get'));
    expect(r?.condition).toContain('isMember(resource.data.orgId)');
  });

  it('every model collection has a match block', () => {
    for (const c of COLLECTIONS) {
      expect(fs.matchPaths.some((p) => p.includes(`/${c}/{`)), c).toBe(true);
    }
  });

  it('model client-writable field lists match the rules', () => {
    const boq = blockOf(FIRESTORE_RULES, 'boqLines');
    for (const f of BOQ_LINE_CLIENT_FIELDS) expect(boq, f).toContain(`'${f}'`);
    for (const [from, tos] of Object.entries(BOQ_LINE_TRANSITIONS)) {
      for (const to of tos) expect(boq).toContain(`from == '${from}' && to == '${to}'`);
    }
    expect((boq.match(/from == '/g) ?? []).length).toBe(Object.values(BOQ_LINE_TRANSITIONS).flat().length);
    const ri = blockOf(FIRESTORE_RULES, 'reviewItems');
    expect(ri).toContain(`hasOnly([${REVIEW_ITEM_CLIENT_FIELDS.map((f) => `'${f}'`).join(', ')}])`);
    const corr = blockOf(FIRESTORE_RULES, 'corrections');
    expect(corr).toContain('d.authorId == request.auth.uid');
    expect(corr).toContain('d.createdAt == request.time');
    expect(corr).toMatch(/allow update, delete: if false;/);
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

  it('only `create` on the quarantine slot is client-writable, with role + id + size + type checks', () => {
    const writes = st.allows.filter((a) => a.methods.some((m) => WRITE_METHODS.has(m)) && !isDenyAll(a.condition));
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
    ]) {
      expect(st.matchPaths, p).toContain(p);
      const allows = st.allows.filter((a) => a.path === p);
      expect(allows.some((a) => a.methods.includes('read') && isDenyAll(a.condition)), `${p} read`).toBe(true);
      const writes = allows.filter((a) => a.methods.some((m) => WRITE_METHODS.has(m)));
      expect(writes.length, `${p} write policy`).toBeGreaterThan(0);
      if (p !== QUARANTINE) for (const w of writes) expect(isDenyAll(w.condition), p).toBe(true);
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

  it('model has the Sprint 1 ingest stages and job type', () => {
    expect(INGEST_STAGES).toEqual(['ingest', 'render', 'ocr', 'classify', 'scale', 'done']);
    expect(JOB_TYPES).toContain('ingest.sheet_version');
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
