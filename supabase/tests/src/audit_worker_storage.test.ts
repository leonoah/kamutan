import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, asWorker, affected, createTestDb, failure, rows } from './db';
import { A, B, loadFixtures } from './fixtures';

let db: PGlite;

beforeAll(async () => {
  db = await createTestDb();
  await loadFixtures(db);
});
afterAll(async () => {
  await db?.close();
});

describe('audit_log: append-only', () => {
  it('records membership changes and BOQ status changes automatically', async () => {
    await asUser(db, A.users.reviewer, (tx) =>
      tx.query(`update public.boq_lines set status = 'approved' where id = $1`, [A.boqLine]));
    const r = await rows<{ actor_id: string; action: string; after: { status: string } }>(db,
      `select actor_id, action, after from public.audit_log where entity = 'boq_lines' and entity_id = $1`, [A.boqLine]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ actor_id: A.users.reviewer, action: 'status_change', after: { status: 'approved' } });
    const m = await rows(db, `select 1 from public.audit_log where entity = 'memberships' and org_id = $1`, [A.org]);
    expect(m.length).toBe(4); // fixture inserts
  });

  it('never copies share-link token hashes into the log', async () => {
    const r = await rows<{ after: Record<string, unknown> }>(db,
      `select after from public.audit_log where entity = 'share_links' and org_id = $1`, [A.org]);
    expect(r.length).toBeGreaterThan(0);
    for (const x of r) expect(x.after).not.toHaveProperty('token_hash');
  });

  it('only admins read the org audit log', async () => {
    await asUser(db, A.users.admin, async (tx) => {
      expect((await rows(tx, `select 1 from public.audit_log`)).length).toBeGreaterThan(0);
    });
    for (const uid of [A.users.editor, A.users.reviewer, A.users.viewer]) {
      await asUser(db, uid, async (tx) => {
        expect(await rows(tx, `select 1 from public.audit_log`)).toHaveLength(0);
      });
    }
  });

  it('API users cannot insert, update, delete or truncate audit rows directly', async () => {
    for (const sql of [
      `insert into public.audit_log (org_id, actor_kind, entity, action, hash) values ('${A.org}', 'user', 'x', 'forged', 'x')`,
      `update public.audit_log set action = 'tampered'`,
      `delete from public.audit_log`,
      `truncate public.audit_log`,
    ]) {
      expect(await failure(asUser(db, A.users.admin, (tx) => tx.query(sql))), sql).toMatch(/permission denied/);
    }
  });

  it('even the table owner / superuser cannot update, delete or truncate (trigger)', async () => {
    expect(await failure(db.query(`update public.audit_log set action = 'tampered'`))).toMatch(/append-only/);
    expect(await failure(db.query(`delete from public.audit_log`))).toMatch(/append-only/);
    expect(await failure(db.query(`truncate public.audit_log`))).toMatch(/append-only/);
  });

  it('members write explicit entries via app.write_audit with themselves as actor; non-members cannot', async () => {
    await asUser(db, A.users.viewer, (tx) =>
      tx.query(`select app.write_audit($1, 'sheet_versions', $2, 'download_source')`, [A.org, A.sheetVersion]));
    const r = await rows(db, `select actor_id, actor_kind from public.audit_log where action = 'download_source'`);
    expect(r).toEqual([{ actor_id: A.users.viewer, actor_kind: 'user' }]);
    expect(await failure(asUser(db, A.users.viewer, (tx) =>
      tx.query(`select app.write_audit($1, 'projects', $2, 'view')`, [B.org, B.project])))).toMatch(/not a member/);
    // authenticated role without a JWT subject cannot write "system" entries
    expect(await failure(db.transaction(async (tx) => {
      await tx.exec('set local role authenticated');
      await tx.query(`select app.write_audit($1, 'projects', $2, 'view')`, [A.org, A.project]);
    }))).toMatch(/not a member/);
  });

  it('forms a valid per-org SHA-256 hash chain', async () => {
    const bad = await rows(db, `
      with x as (
        select a.*, lag(hash) over (partition by org_id order by id) as expected_prev
        from public.audit_log a
      )
      select id from x
      where prev_hash is distinct from expected_prev
         or hash <> encode(extensions.digest(concat_ws('|',
              coalesce(prev_hash, ''), org_id::text, coalesce(actor_id::text, ''), actor_kind::text, entity,
              coalesce(entity_id::text, ''), action, coalesce(before::text, ''), coalesce(after::text, ''),
              to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')), 'sha256'), 'hex')`);
    expect(bad).toEqual([]);
    expect((await rows(db, `select count(distinct org_id)::int n from public.audit_log`))[0]).toEqual({ n: 2 });
  });
});

describe('kamutan_worker role', () => {
  it('is NOLOGIN, not superuser, does not bypass RLS', async () => {
    const r = await rows(db, `select rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname = 'kamutan_worker'`);
    expect(r).toEqual([{ rolcanlogin: false, rolsuper: false, rolbypassrls: false }]);
  });

  it.each(['share_links', 'memberships', 'audit_log', 'orgs', 'profiles', 'boq_lines', 'item_library', 'projects'])(
    'has no access to %s',
    async (table) => {
      expect(await failure(asWorker(db, A.org, (tx) => tx.query(`select 1 from public.${table}`))))
        .toMatch(/permission denied/);
    },
  );

  it('cannot call admin/audit helper functions', async () => {
    expect(await failure(asWorker(db, A.org, (tx) =>
      tx.query(`select app.write_audit($1, 'x', null, 'forged')`, [A.org])))).toMatch(/permission denied/);
  });

  it('sees only the rows of the job org it is scoped to', async () => {
    await asWorker(db, A.org, async (tx) => {
      const d = await rows<{ org_id: string }>(tx, `select distinct org_id from public.detections`);
      expect(d).toEqual([{ org_id: A.org }]);
      expect(await rows(tx, `select 1 from public.jobs where id = $1`, [B.job])).toHaveLength(0);
    });
    await asWorker(db, null, async (tx) => {
      expect(await rows(tx, `select 1 from public.detections`)).toHaveLength(0);
    });
  });

  it('writes pipeline outputs for its org only', async () => {
    const ins = `insert into public.detections (org_id, sheet_version_id, geom, class, confidence, level, reasons)
                 values ($1, $2, extensions.st_point(5, 5, 0), 'socket', 0.42, 'red', '{LOW_OCR}')`;
    await asWorker(db, A.org, (tx) => tx.query(ins, [A.org, A.sheetVersion]));
    expect(await failure(asWorker(db, A.org, (tx) => tx.query(ins, [B.org, B.sheetVersion]))))
      .toMatch(/row-level security/);
    await asWorker(db, A.org, async (tx) => {
      expect(await affected(tx, `update public.detections set status = 'auto' where id = $1`, [B.detection1])).toBe(0);
    });
  });

  it('updates job progress and sheet-version status, but not other columns', async () => {
    await asWorker(db, A.org, async (tx) => {
      expect(await affected(tx, `update public.jobs set status = 'running', progress = 40, stage = 'detect' where id = $1`, [A.job])).toBe(1);
      expect(await affected(tx, `update public.sheet_versions set status = 'processing' where id = $1`, [A.sheetVersion])).toBe(1);
    });
    expect(await failure(asWorker(db, A.org, (tx) =>
      tx.query(`update public.sheet_versions set storage_path = 'x' where id = $1`, [A.sheetVersion])))).toMatch(/permission denied/);
    expect(await failure(asWorker(db, A.org, (tx) =>
      tx.query(`update public.jobs set org_id = $2 where id = $1`, [A.job, B.org])))).toMatch(/permission denied/);
    expect(await failure(asWorker(db, A.org, (tx) =>
      tx.query(`delete from public.detections where id = $1`, [A.detection1])))).toMatch(/permission denied/);
  });
});

describe('storage.objects policies (bucket drawings)', () => {
  const objA = `${A.org}/${A.project}/plan.pdf`;
  const objB = `${B.org}/${B.project}/plan.pdf`;
  const put = (name: string, bucket = 'drawings') =>
    [`insert into storage.objects (bucket_id, name) values ($1, $2)`, [bucket, name]] as [string, unknown[]];

  beforeAll(async () => {
    await db.query(...put(objB));
  });

  it('editor uploads under own org prefix only', async () => {
    await asUser(db, A.users.editor, (tx) => tx.query(...put(objA)));
    expect(await failure(asUser(db, A.users.editor, (tx) => tx.query(...put(`${B.org}/evil.pdf`)))))
      .toMatch(/row-level security/);
    expect(await failure(asUser(db, A.users.editor, (tx) => tx.query(...put(`not-a-uuid/x.pdf`)))))
      .toMatch(/row-level security/);
    expect(await failure(asUser(db, A.users.editor, (tx) => tx.query(...put(`x.pdf`)))))
      .toMatch(/row-level security/);
  });

  it('viewer can read own org objects but not upload', async () => {
    await asUser(db, A.users.viewer, async (tx) => {
      expect(await rows(tx, `select name from storage.objects`)).toEqual([{ name: objA }]);
    });
    expect(await failure(asUser(db, A.users.viewer, (tx) => tx.query(...put(`${A.org}/v.pdf`)))))
      .toMatch(/row-level security/);
  });

  it('org B cannot see, overwrite or delete org A objects', async () => {
    await asUser(db, B.users.admin, async (tx) => {
      expect(await rows(tx, `select name from storage.objects`)).toEqual([{ name: objB }]);
      expect(await affected(tx, `update storage.objects set name = name || '.x' where name = $1`, [objA])).toBe(0);
      expect(await affected(tx, `delete from storage.objects where name = $1`, [objA])).toBe(0);
    });
  });

  it('only admin deletes objects', async () => {
    await asUser(db, A.users.editor, async (tx) => {
      expect(await affected(tx, `delete from storage.objects where name = $1`, [objA])).toBe(0);
    });
    await asUser(db, A.users.admin, async (tx) => {
      expect(await affected(tx, `delete from storage.objects where name = $1`, [objA])).toBe(1);
    });
  });
});
