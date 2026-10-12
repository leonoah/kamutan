/**
 * Static checks that run WITHOUT the emulator (local + every CI job).
 * They guard structural invariants of the rules; behaviour is covered by the
 * emulator suites (firestore.rules.test.ts / storage.rules.test.ts).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BOQ_LINE_CLIENT_FIELDS, BOQ_LINE_TRANSITIONS, COLLECTIONS, REVIEW_ITEM_CLIENT_FIELDS, paths,
} from '../../model';
import { FIREBASE_DIR, FIRESTORE_RULES, STORAGE_RULES } from './env';
import { WRITE_METHODS, isDenyAll, parseRules, stripComments } from './rules-lint';

const fs = parseRules(FIRESTORE_RULES);
const st = parseRules(STORAGE_RULES);
const DOCS = '/databases/{database}/documents';

/** The ONLY places a client may write (ADR 0008 §authz-2). */
const CLIENT_WRITABLE: Record<string, string[]> = {
  [`${DOCS}/orgs/{orgId}/projects/{projectId}/corrections/{correctionId}`]: ['create'],
  [`${DOCS}/orgs/{orgId}/projects/{projectId}/reviewItems/{itemId}`]: ['update'],
  [`${DOCS}/orgs/{orgId}/projects/{projectId}/boqLines/{lineId}`]: ['update'],
};

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

  it('only `create` on orgs/{orgId}/uploads/{uid}/{fileId} is client-writable, with uid + size + type checks', () => {
    const writes = st.allows.filter((a) => a.methods.some((m) => WRITE_METHODS.has(m)) && !isDenyAll(a.condition));
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('/b/{bucket}/o/orgs/{orgId}/uploads/{uid}/{fileId}');
    expect(writes[0].methods).toEqual(['create']);
    for (const frag of ['request.auth.uid == uid', 'canUpload(orgId)', 'resource == null', '100 * 1024 * 1024', 'allowedType()']) {
      expect(writes[0].condition).toContain(frag);
    }
    expect(STORAGE_RULES).toContain('firestore.exists(');
    expect(STORAGE_RULES).toContain('firestore.get(');
  });

  it('model storage paths match the rule paths', () => {
    expect(paths.upload('o', 'u', 'f')).toBe('orgs/o/uploads/u/f');
    expect(paths.derived('o', 'v1/tiles/0.webp')).toBe('orgs/o/derived/v1/tiles/0.webp');
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
