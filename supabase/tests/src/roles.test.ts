import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, affected, createTestDb, failure, rows } from './db';
import { A, B, OUTSIDER, loadFixtures } from './fixtures';

let db: PGlite;

beforeAll(async () => {
  db = await createTestDb();
  await loadFixtures(db);
});
afterAll(async () => {
  await db?.close();
});

const insertLine = (orgId: string, projectId: string) => [
  `insert into public.boq_lines (org_id, project_id, code, description, unit, quantity)
   values ($1, $2, '4.20', 'נקודת מאור', 'יח''', 5) returning id, status`,
  [orgId, projectId],
] as [string, unknown[]];

describe('boq_lines role rules', () => {
  it('viewer can read but not write BOQ lines', async () => {
    await asUser(db, A.users.viewer, async (tx) => {
      expect(await rows(tx, `select id from public.boq_lines`)).toHaveLength(1);
      expect(await affected(tx, `update public.boq_lines set quantity = 99 where id = $1`, [A.boqLine])).toBe(0);
      expect(await affected(tx, `update public.boq_lines set status = 'approved' where id = $1`, [A.boqLine])).toBe(0);
      expect(await affected(tx, `delete from public.boq_lines where id = $1`, [A.boqLine])).toBe(0);
    });
    const msg = await failure(asUser(db, A.users.viewer, (tx) => tx.query(...insertLine(A.org, A.project))));
    expect(msg).toMatch(/row-level security/);
    expect((await rows<{ quantity: string }>(db, `select quantity from public.boq_lines where id = $1`, [A.boqLine]))[0].quantity)
      .toBe('2.0000');
  });

  it('editor creates draft lines and edits content, but cannot approve', async () => {
    const id = await asUser(db, A.users.editor, async (tx) => {
      const r = await rows<{ id: string; status: string }>(tx, ...insertLine(A.org, A.project));
      expect(r[0].status).toBe('draft');
      expect(await affected(tx, `update public.boq_lines set quantity = 6, status = 'reviewed' where id = $1`, [r[0].id])).toBe(1);
      return r[0].id;
    });
    const msg = await failure(asUser(db, A.users.editor, (tx) =>
      tx.query(`update public.boq_lines set status = 'approved' where id = $1`, [id])));
    expect(msg).toMatch(/only reviewer\/admin may approve/);

    const msg2 = await failure(asUser(db, A.users.editor, (tx) =>
      tx.query(`insert into public.boq_lines (org_id, project_id, code, description, unit, status)
                values ($1, $2, '1.1', 'x', 'm', 'approved')`, [A.org, A.project])));
    expect(msg2).toMatch(/must be draft/);
  });

  it('reviewer approves; approval is stamped by the DB, not the client', async () => {
    await asUser(db, A.users.reviewer, async (tx) => {
      const n = await affected(tx,
        `update public.boq_lines set status = 'approved', approved_by = $2, approved_at = '2000-01-01' where id = $1`,
        [A.boqLine, A.users.viewer]);
      expect(n).toBe(1);
    });
    const r = await rows<{ status: string; approved_by: string; approved_at: Date }>(db,
      `select status, approved_by, approved_at from public.boq_lines where id = $1`, [A.boqLine]);
    expect(r[0].status).toBe('approved');
    expect(r[0].approved_by).toBe(A.users.reviewer);
    expect(new Date(r[0].approved_at).getFullYear()).toBeGreaterThan(2020);
  });

  it('approved lines are locked for content edits (editor and reviewer)', async () => {
    const msg = await failure(asUser(db, A.users.editor, (tx) =>
      tx.query(`update public.boq_lines set quantity = 100 where id = $1`, [A.boqLine])));
    expect(msg).toMatch(/approved\/locked/);
    const msg2 = await failure(asUser(db, A.users.reviewer, (tx) =>
      tx.query(`update public.boq_lines set quantity = 100 where id = $1`, [A.boqLine])));
    expect(msg2).toMatch(/only editor\/admin may change BOQ line content/);
  });

  it('editor cannot un-approve; reviewer can, which clears the stamp', async () => {
    const msg = await failure(asUser(db, A.users.editor, (tx) =>
      tx.query(`update public.boq_lines set status = 'draft' where id = $1`, [A.boqLine])));
    expect(msg).toMatch(/only reviewer\/admin/);
    await asUser(db, A.users.reviewer, (tx) =>
      tx.query(`update public.boq_lines set status = 'reviewed', note = 'לבדוק שוב' where id = $1`, [A.boqLine]));
    const r = await rows(db, `select status, approved_by, approved_at from public.boq_lines where id = $1`, [A.boqLine]);
    expect(r[0]).toEqual({ status: 'reviewed', approved_by: null, approved_at: null });
  });

  it('admin can approve too; reviewer of org A cannot approve org B lines', async () => {
    await asUser(db, A.users.admin, (tx) =>
      tx.query(`update public.boq_lines set status = 'approved' where id = $1`, [A.boqLine]));
    expect((await rows(db, `select approved_by from public.boq_lines where id = $1`, [A.boqLine]))[0])
      .toEqual({ approved_by: A.users.admin });
    await asUser(db, A.users.reviewer, async (tx) => {
      expect(await affected(tx, `update public.boq_lines set status = 'approved' where id = $1`, [B.boqLine])).toBe(0);
    });
  });

  it('only draft lines can be deleted', async () => {
    await asUser(db, A.users.editor, async (tx) => {
      expect(await affected(tx, `delete from public.boq_lines where id = $1`, [A.boqLine])).toBe(0); // approved
    });
  });
});

describe('detections / links role rules', () => {
  it('viewer cannot correct detections; reviewer can accept/reject', async () => {
    await asUser(db, A.users.viewer, async (tx) => {
      expect(await affected(tx, `update public.detections set status = 'rejected' where id = $1`, [A.detection2])).toBe(0);
    });
    await asUser(db, A.users.reviewer, async (tx) => {
      expect(await affected(tx, `update public.detections set status = 'rejected' where id = $1`, [A.detection2])).toBe(1);
      expect(await affected(tx, `update public.links set status = 'accepted' where id = $1`, [A.link])).toBe(1);
    });
  });

  it('nobody deletes detections (they are rejected/superseded instead)', async () => {
    await asUser(db, A.users.admin, async (tx) => {
      expect(await affected(tx, `delete from public.detections where id = $1`, [A.detection2])).toBe(0);
    });
  });

  it('reviewer can add a manual detection, viewer cannot', async () => {
    const sql = `insert into public.detections (org_id, sheet_version_id, geom, class, confidence, level, source, status, supply, lifecycle)
                 values ($1, $2, extensions.st_point(200, 100, 0), 'light', 1, 'green', 'manual', 'accepted', 'client', 'existing')`;
    await asUser(db, A.users.reviewer, (tx) => tx.query(sql, [A.org, A.sheetVersion]));
    expect(await failure(asUser(db, A.users.viewer, (tx) => tx.query(sql, [A.org, A.sheetVersion]))))
      .toMatch(/row-level security/);
  });
});

describe('memberships: only admin manages', () => {
  const newUser = 'aaaaaaaa-0000-4000-8000-000200000077';

  beforeAll(async () => {
    await db.query(`insert into auth.users (id, email) values ($1, 'new@org-a.test')`, [newUser]);
  });

  it('editor / reviewer / viewer cannot add, change or remove members', async () => {
    for (const uid of [A.users.editor, A.users.reviewer, A.users.viewer]) {
      const msg = await failure(asUser(db, uid, (tx) =>
        tx.query(`insert into public.memberships (org_id, user_id, role) values ($1, $2, 'admin')`, [A.org, newUser])));
      expect(msg).toMatch(/row-level security/);
      await asUser(db, uid, async (tx) => {
        expect(await affected(tx, `update public.memberships set role = 'admin' where user_id = $1 and org_id = $2`, [uid, A.org])).toBe(0);
        expect(await affected(tx, `delete from public.memberships where user_id = $1`, [A.users.viewer])).toBe(0);
      });
    }
  });

  it('admin adds, promotes and removes members', async () => {
    await asUser(db, A.users.admin, async (tx) => {
      await tx.query(`insert into public.memberships (org_id, user_id, role) values ($1, $2, 'viewer')`, [A.org, newUser]);
      expect(await affected(tx, `update public.memberships set role = 'editor' where user_id = $1`, [newUser])).toBe(1);
      expect(await affected(tx, `delete from public.memberships where user_id = $1`, [newUser])).toBe(1);
    });
  });

  it('admin of org A cannot add members to org B', async () => {
    const msg = await failure(asUser(db, A.users.admin, (tx) =>
      tx.query(`insert into public.memberships (org_id, user_id, role) values ($1, $2, 'admin')`, [B.org, A.users.admin])));
    expect(msg).toMatch(/row-level security/);
  });

  it('the last admin cannot be demoted or removed', async () => {
    const msg = await failure(asUser(db, A.users.admin, (tx) =>
      tx.query(`update public.memberships set role = 'viewer' where user_id = $1 and org_id = $2`, [A.users.admin, A.org])));
    expect(msg).toMatch(/at least one admin/);
  });

  it('only admin changes org settings', async () => {
    await asUser(db, A.users.editor, async (tx) => {
      expect(await affected(tx, `update public.orgs set settings = settings || '{"llm_enabled": true}' where id = $1`, [A.org])).toBe(0);
    });
    await asUser(db, A.users.admin, async (tx) => {
      expect(await affected(tx, `update public.orgs set settings = settings || '{"llm_enabled": true}' where id = $1`, [A.org])).toBe(1);
    });
  });

  it('any authenticated user can create an org and becomes its admin', async () => {
    const org = await asUser(db, OUTSIDER, async (tx) => {
      const r = await rows<{ id: string }>(tx, `select app.create_org('משרד חדש', 'new-office') id`);
      expect(await rows(tx, `select role from public.memberships where org_id = $1`, [r[0].id])).toEqual([{ role: 'admin' }]);
      return r[0].id;
    });
    expect(org).toBeTruthy();
  });
});

describe('share_links', () => {
  it('viewer and reviewer cannot see share links; editor can', async () => {
    for (const uid of [A.users.viewer, A.users.reviewer]) {
      await asUser(db, uid, async (tx) => {
        expect(await rows(tx, `select 1 from public.share_links`)).toHaveLength(0);
      });
    }
    await asUser(db, A.users.editor, async (tx) => {
      expect(await rows(tx, `select 1 from public.share_links`)).toHaveLength(1);
    });
  });

  it('editor creates a version-locked link; expiry is capped at 90 days', async () => {
    await asUser(db, A.users.editor, async (tx) => {
      const r = await rows<{ created_by: string; days: number }>(tx,
        `insert into public.share_links (org_id, project_id, token_hash, sheet_version_ids)
         values ($1, $2, $3, array[$4]::uuid[])
         returning created_by, extract(day from expires_at - created_at)::int days`,
        [A.org, A.project, 'e'.repeat(64), A.sheetVersion]);
      expect(r[0]).toEqual({ created_by: A.users.editor, days: 14 });
    });
    const msg = await failure(asUser(db, A.users.editor, (tx) =>
      tx.query(`insert into public.share_links (org_id, project_id, token_hash, sheet_version_ids, expires_at)
                values ($1, $2, $3, array[$4]::uuid[], now() + interval '91 days')`,
        [A.org, A.project, 'f'.repeat(64), A.sheetVersion])));
    expect(msg).toMatch(/check constraint/);
  });

  it('cannot lock a share link to another org\'s sheet version', async () => {
    const msg = await failure(asUser(db, A.users.editor, (tx) =>
      tx.query(`insert into public.share_links (org_id, project_id, token_hash, sheet_version_ids)
                values ($1, $2, $3, array[$4]::uuid[])`,
        [A.org, A.project, '1'.repeat(64), B.sheetVersion])));
    expect(msg).toMatch(/outside its project/);
  });

  it('revocation is the only allowed change, and it is final', async () => {
    const msg = await failure(asUser(db, A.users.admin, (tx) =>
      tx.query(`update public.share_links set expires_at = expires_at + interval '1 day' where id = $1`, [A.shareLink])));
    expect(msg).toMatch(/immutable/);
    await asUser(db, A.users.editor, async (tx) => {
      expect(await affected(tx, `update public.share_links set revoked_at = now() where id = $1`, [A.shareLink])).toBe(1);
    });
    const msg2 = await failure(asUser(db, A.users.admin, (tx) =>
      tx.query(`update public.share_links set revoked_at = null where id = $1`, [A.shareLink])));
    expect(msg2).toMatch(/final/);
  });

  it('share links cannot be deleted by anyone', async () => {
    const msg = await failure(asUser(db, A.users.admin, (tx) =>
      tx.query(`delete from public.share_links where id = $1`, [A.shareLink])));
    expect(msg).toMatch(/permission denied/);
  });
});
