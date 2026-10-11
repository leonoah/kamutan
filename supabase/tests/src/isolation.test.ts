import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, affected, createTestDb, failure, rows } from './db';
import { A, B, OUTSIDER, TENANT_TABLES, loadFixtures } from './fixtures';

let db: PGlite;

beforeAll(async () => {
  db = await createTestDb();
  await loadFixtures(db);
});
afterAll(async () => {
  await db?.close();
});

describe('tenant isolation', () => {
  it.each(TENANT_TABLES)('%s: org A admin sees own row, never org B row', async (table, key) => {
    await asUser(db, A.users.admin, async (tx) => {
      const own = await rows(tx, `select id from public.${table} where id = $1`, [A[key]]);
      expect(own).toHaveLength(1);
      const other = await rows(tx, `select id from public.${table} where id = $1`, [B[key]]);
      expect(other).toHaveLength(0);
      const leaked = await rows(tx, `select id from public.${table} where org_id = $1`, [B.org]);
      expect(leaked).toHaveLength(0);
    });
  });

  it.each(TENANT_TABLES)('%s: org A admin cannot update or delete org B rows', async (table, key) => {
    await asUser(db, A.users.admin, async (tx) => {
      expect(await affected(tx, `update public.${table} set updated_at = now() where id = $1`, [B[key]])).toBe(0);
    });
    if (table === 'share_links') {
      // no DELETE privilege at all on share_links (revoke instead)
      expect(await failure(asUser(db, A.users.admin, (tx) =>
        tx.query(`delete from public.${table} where id = $1`, [B[key]])))).toMatch(/permission denied/);
    } else {
      await asUser(db, A.users.admin, async (tx) => {
        expect(await affected(tx, `delete from public.${table} where id = $1`, [B[key]])).toBe(0);
      });
    }
    // and the row is still there
    expect(await rows(db, `select 1 from public.${table} where id = $1`, [B[key]])).toHaveLength(1);
  });

  it('org A editor cannot insert rows with org B org_id', async () => {
    const msg = await failure(asUser(db, A.users.editor, (tx) =>
      tx.query(`insert into public.projects (org_id, name) values ($1, 'hijack')`, [B.org])));
    expect(msg).toMatch(/row-level security/);

    const msg2 = await failure(asUser(db, A.users.editor, (tx) =>
      tx.query(`insert into public.item_library (org_id, code, description, unit) values ($1, '1.1', 'x', 'm')`, [B.org])));
    expect(msg2).toMatch(/row-level security/);
  });

  it('org A editor cannot attach own-org rows to org B parents (composite FK)', async () => {
    // detection claims org A but points at org B's sheet version
    const msg = await failure(asUser(db, A.users.editor, (tx) =>
      tx.query(
        `insert into public.detections (org_id, sheet_version_id, geom, class, confidence, level)
         values ($1, $2, extensions.st_point(1, 1, 0), 'socket', 0.5, 'yellow')`,
        [A.org, B.sheetVersion])));
    expect(msg).toMatch(/foreign key/);

    const msg2 = await failure(asUser(db, A.users.editor, (tx) =>
      tx.query(`insert into public.boq_line_evidence (org_id, boq_line_id, detection_id) values ($1, $2, $3)`,
        [A.org, A.boqLine, B.detection1])));
    expect(msg2).toMatch(/foreign key/);
  });

  it('org_id cannot be changed to move a row into another tenant', async () => {
    const msg = await failure(asUser(db, A.users.admin, (tx) =>
      tx.query(`update public.projects set org_id = $1 where id = $2`, [B.org, A.project])));
    expect(msg).toMatch(/immutable|row-level security/);
  });

  it('memberships, profiles, orgs and audit_log are isolated', async () => {
    await asUser(db, A.users.admin, async (tx) => {
      expect(await rows(tx, `select 1 from public.memberships where org_id = $1`, [B.org])).toHaveLength(0);
      expect(await rows(tx, `select 1 from public.memberships where org_id = $1`, [A.org])).toHaveLength(4);
      expect(await rows(tx, `select 1 from public.profiles where id = $1`, [B.users.admin])).toHaveLength(0);
      expect(await rows(tx, `select 1 from public.profiles where id = $1`, [A.users.viewer])).toHaveLength(1);
      expect(await rows(tx, `select id from public.orgs`)).toEqual([{ id: A.org }]);
      expect(await rows(tx, `select 1 from public.audit_log where org_id = $1`, [B.org])).toHaveLength(0);
      expect(await affected(tx, `update public.orgs set name = 'x' where id = $1`, [B.org])).toBe(0);
    });
  });

  it('a user without memberships sees nothing', async () => {
    await asUser(db, OUTSIDER, async (tx) => {
      for (const [table] of TENANT_TABLES) {
        expect(await rows(tx, `select 1 from public.${table}`), table).toHaveLength(0);
      }
      expect(await rows(tx, `select 1 from public.orgs`)).toHaveLength(0);
      expect(await rows(tx, `select 1 from public.memberships`)).toHaveLength(0);
    });
  });

  it('anon has no table privileges at all', async () => {
    const msg = await failure(asUser(db, null, (tx) => tx.query(`select 1 from public.projects`)));
    expect(msg).toMatch(/permission denied/);
    const msg2 = await failure(asUser(db, null, (tx) => tx.query(`select 1 from public.share_links`)));
    expect(msg2).toMatch(/permission denied/);
  });

  it('a user in two orgs sees both, with per-org roles', async () => {
    await db.query(`insert into public.memberships (org_id, user_id, role) values ($1, $2, 'viewer')`, [B.org, A.users.editor]);
    try {
      await asUser(db, A.users.editor, async (tx) => {
        expect((await rows(tx, `select id from public.projects order by id`)).length).toBe(2);
        // editor in A, viewer in B: cannot write B
        expect(await affected(tx, `update public.projects set name = 'x' where id = $1`, [B.project])).toBe(0);
        expect(await affected(tx, `update public.projects set name = 'y' where id = $1`, [A.project])).toBe(1);
      });
    } finally {
      await db.query(`delete from public.memberships where org_id = $1 and user_id = $2`, [B.org, A.users.editor]);
    }
  });
});
