import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RLS_GUARD_SQL, createTestDb, failure, migrationFiles, rows } from './db';

let db: PGlite;

beforeAll(async () => {
  db = await createTestDb({ seed: true, fresh: true }); // really apply every migration
});
afterAll(async () => {
  await db?.close();
});

describe('migrations', () => {
  it('are numbered sequentially with the 20261011 prefix', () => {
    const files = migrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(9);
    files.forEach((f, i) => expect(f.startsWith(`202610110000${String(i + 1).padStart(2, '0')}_`)).toBe(true));
  });

  it('create every MVP core table in public', async () => {
    const expected = [
      'orgs', 'profiles', 'memberships', 'projects', 'project_floors', 'sheet_sets', 'sheets', 'sheet_versions',
      'sheet_regions', 'legends', 'legend_entries', 'symbol_templates', 'detections', 'rooms', 'links',
      'item_library', 'boq_templates', 'symbol_item_mappings', 'boq_lines', 'boq_line_evidence',
      'share_links', 'audit_log', 'jobs',
    ];
    const got = (await rows<{ t: string }>(db, `select tablename t from pg_tables where schemaname = 'public'`)).map((r) => r.t);
    expect(got.sort()).toEqual(expected.sort());
  });

  it('keeps PostGIS out of public (spatial_ref_sys lives in extensions)', async () => {
    const r = await rows<{ s: string }>(db, `select relnamespace::regnamespace::text s from pg_class where relname = 'spatial_ref_sys'`);
    expect(r[0].s).toBe('extensions');
  });

  it('stores item codes as text and keeps "4.10" distinct from "4.1"', async () => {
    const r = await rows<{ t: string }>(db,
      `select data_type t from information_schema.columns where table_name in ('boq_lines','item_library') and column_name = 'code'`);
    expect(r.map((x) => x.t)).toEqual(['text', 'text']);
  });

  it('uses SRID 0 PostGIS geometry for detections and computes areas in paper mm', async () => {
    const r = await rows<{ srid: number; typ: string }>(db,
      `select srid, type typ from extensions.geometry_columns where f_table_name = 'detections' and f_geometry_column = 'geom'`);
    expect(r[0]).toEqual({ srid: 0, typ: 'GEOMETRY' });
    const a = await rows<{ a: number }>(db,
      `select extensions.st_area(extensions.st_geomfromtext('POLYGON((0 0,420 0,420 297,0 297,0 0))', 0)) a`);
    expect(Number(a[0].a)).toBe(124740);
  });

  it('seed: demo org, project and three floors', async () => {
    const org = await rows<{ name: string }>(db, `select name from public.orgs`);
    expect(org).toEqual([{ name: 'משרד הדגמה' }]);
    const proj = await rows<{ name: string }>(db, `select name from public.projects`);
    expect(proj).toEqual([{ name: 'בית משפחת נח' }]);
    const floors = await rows(db, `select code from public.project_floors order by sort_order`);
    expect(floors).toHaveLength(3);
  });

  it('creates a private `drawings` bucket', async () => {
    const r = await rows(db, `select id, public from storage.buckets`);
    expect(r).toEqual([{ id: 'drawings', public: false }]);
  });
});

describe('RLS coverage guard (CI)', () => {
  it('reports no problems on the current schema', async () => {
    expect(await rows(db, `select * from app.rls_coverage_report()`)).toEqual([]);
    await db.exec(readFileSync(RLS_GUARD_SQL, 'utf8')); // raises on failure
  });

  it('every public table has RLS enabled + forced and at least one policy', async () => {
    const r = await rows<{ t: string; rls: boolean; force: boolean; n: number }>(db, `
      select c.relname t, c.relrowsecurity rls, c.relforcerowsecurity force,
             (select count(*)::int from pg_policy p where p.polrelid = c.oid) n
      from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'`);
    expect(r.length).toBeGreaterThan(20);
    for (const t of r) {
      expect(t, t.t).toMatchObject({ rls: true, force: true });
      expect(t.n, t.t).toBeGreaterThan(0);
    }
  });

  it('detects a table without RLS / policy / org_id and fails the guard', async () => {
    await db.exec('begin');
    try {
      await db.exec('create table public.oops (id int)');
      const r = await rows<{ table_name: string; problem: string }>(db,
        `select * from app.rls_coverage_report() where table_name = 'oops'`);
      expect(r.map((x) => x.problem).sort()).toEqual(['missing_org_id', 'no_policy', 'rls_disabled', 'rls_not_forced']);
      const msg = await failure(db.exec(readFileSync(RLS_GUARD_SQL, 'utf8')));
      expect(msg).toMatch(/RLS coverage guard failed/);
    } finally {
      await db.exec('rollback');
    }
  });
});
