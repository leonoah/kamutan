import type { PGlite } from '@electric-sql/pglite';

/** Deterministic uuid: org letter + kind number + index. */
const u = (org: 'a' | 'b' | 'x', kind: number, i = 1) =>
  `${org === 'a' ? 'aaaaaaaa' : org === 'b' ? 'bbbbbbbb' : 'cccccccc'}-0000-4000-8000-${String(kind).padStart(4, '0')}${String(i).padStart(8, '0')}`;

export const SHA = 'a'.repeat(64);
export const SHA2 = 'b'.repeat(64);

export interface OrgFixture {
  org: string;
  users: { admin: string; editor: string; reviewer: string; viewer: string };
  project: string;
  sheetSet: string;
  sheet: string;
  sheetVersion: string;
  region: string;
  legend: string;
  legendEntry: string;
  template: string;
  room: string;
  detection1: string;
  detection2: string;
  link: string;
  item: string;
  boqTemplate: string;
  mapping: string;
  boqLine: string;
  evidence: string;
  shareLink: string;
  job: string;
}

function ids(o: 'a' | 'b'): OrgFixture {
  return {
    org: u(o, 1),
    users: { admin: u(o, 2, 1), editor: u(o, 2, 2), reviewer: u(o, 2, 3), viewer: u(o, 2, 4) },
    project: u(o, 3),
    sheetSet: u(o, 4),
    sheet: u(o, 5),
    sheetVersion: u(o, 6),
    region: u(o, 7),
    legend: u(o, 8),
    legendEntry: u(o, 9),
    template: u(o, 10),
    room: u(o, 11),
    detection1: u(o, 12, 1),
    detection2: u(o, 12, 2),
    link: u(o, 13),
    item: u(o, 14),
    boqTemplate: u(o, 15),
    mapping: u(o, 16),
    boqLine: u(o, 17),
    evidence: u(o, 18),
    shareLink: u(o, 19),
    job: u(o, 20),
  };
}

export const A = ids('a');
export const B = ids('b');
/** Authenticated user with no membership anywhere. */
export const OUTSIDER = u('x', 2, 9);

async function insertOrg(db: PGlite, f: OrgFixture, name: string, slug: string, tokenChar: string) {
  const o = f.org;
  await db.query(`insert into public.orgs (id, name, slug) values ($1, $2, $3)`, [o, name, slug]);
  for (const [role, uid] of Object.entries(f.users)) {
    await db.query(`insert into auth.users (id, email) values ($1, $2)`, [uid, `${role}@${slug}.test`]);
    await db.query(`insert into public.memberships (org_id, user_id, role) values ($1, $2, $3)`, [o, uid, role]);
    await db.query(`insert into public.profiles (id, full_name) values ($1, $2)`, [uid, `${role} ${slug}`]);
  }
  await db.query(`insert into public.boq_templates (id, org_id, name) values ($1, $2, 'תבנית')`, [f.boqTemplate, o]);
  await db.query(
    `insert into public.projects (id, org_id, name, boq_template_id) values ($1, $2, 'פרויקט', $3)`,
    [f.project, o, f.boqTemplate],
  );
  await db.query(
    `insert into public.sheet_sets (id, org_id, project_id, name, source_sha256) values ($1, $2, $3, 'סט', $4)`,
    [f.sheetSet, o, f.project, SHA],
  );
  await db.query(
    `insert into public.sheets (id, org_id, project_id, sheet_set_id, logical_key, floor) values ($1, $2, $3, $4, 'E-01', '0')`,
    [f.sheet, o, f.project, f.sheetSet],
  );
  await db.query(
    `insert into public.sheet_versions (id, org_id, sheet_id, version_no, source_sha256, storage_path, width_mm, height_mm, scale)
     values ($1, $2, $3, 1, $4, $5, 420, 297, 50)`,
    [f.sheetVersion, o, f.sheet, SHA, `${o}/${f.project}/${SHA}.pdf`],
  );
  await db.query(
    `insert into public.sheet_regions (id, org_id, sheet_version_id, floor, scale, polygon)
     values ($1, $2, $3, '0', 50, extensions.st_geomfromtext('POLYGON((0 0,420 0,420 297,0 297,0 0))', 0))`,
    [f.region, o, f.sheetVersion],
  );
  await db.query(
    `insert into public.legends (id, org_id, sheet_version_id, kind) values ($1, $2, $3, 'electrical')`,
    [f.legend, o, f.sheetVersion],
  );
  await db.query(
    `insert into public.legend_entries (id, org_id, legend_id, row_index, description) values ($1, $2, $3, 1, 'שקע כוח')`,
    [f.legendEntry, o, f.legend],
  );
  await db.query(
    `insert into public.symbol_templates (id, org_id, source, name) values ($1, $2, 'legend', 'socket')`,
    [f.template, o],
  );
  await db.query(
    `insert into public.rooms (id, org_id, sheet_version_id, floor, name, geom)
     values ($1, $2, $3, '0', 'סלון', extensions.st_geomfromtext('POLYGON((10 10,110 10,110 90,10 90,10 10))', 0))`,
    [f.room, o, f.sheetVersion],
  );
  for (const [i, d] of [f.detection1, f.detection2].entries()) {
    await db.query(
      `insert into public.detections (id, org_id, sheet_version_id, geom, class, template_id, legend_entry_id, room_id,
                                      confidence, level, reasons)
       values ($1, $2, $3, extensions.st_point($4, 50, 0), 'socket', $5, $6, $7, 0.97, 'green', '{}')`,
      [d, o, f.sheetVersion, 20 + i * 30, f.template, f.legendEntry, f.room],
    );
  }
  await db.query(
    `insert into public.links (id, org_id, sheet_version_id, from_detection_id, to_detection_id, conf)
     values ($1, $2, $3, $4, $5, 0.8)`,
    [f.link, o, f.sheetVersion, f.detection1, f.detection2],
  );
  await db.query(
    `insert into public.item_library (id, org_id, code, chapter, description, unit)
     values ($1, $2, '4.10', '4', 'נקודת שקע', 'יח''')`,
    [f.item, o],
  );
  await db.query(
    `insert into public.symbol_item_mappings (id, org_id, key_type, key, item_id) values ($1, $2, 'template_hash', 'h1', $3)`,
    [f.mapping, o, f.item],
  );
  await db.query(
    `insert into public.boq_lines (id, org_id, project_id, item_id, chapter, code, description, unit, quantity, floor, level)
     values ($1, $2, $3, $4, '4', '4.10', 'נקודת שקע', 'יח''', 2, '0', 'green')`,
    [f.boqLine, o, f.project, f.item],
  );
  await db.query(
    `insert into public.boq_line_evidence (id, org_id, boq_line_id, detection_id) values ($1, $2, $3, $4)`,
    [f.evidence, o, f.boqLine, f.detection1],
  );
  await db.query(
    `insert into public.share_links (id, org_id, project_id, token_hash, sheet_version_ids)
     values ($1, $2, $3, $4, array[$5]::uuid[])`,
    [f.shareLink, o, f.project, tokenChar.repeat(64), f.sheetVersion],
  );
  await db.query(
    `insert into public.jobs (id, org_id, project_id, sheet_version_id, type) values ($1, $2, $3, $4, 'analyze')`,
    [f.job, o, f.project, f.sheetVersion],
  );
}

/** Two fully-populated orgs (A, B), 4 role users each, plus an outsider user. */
export async function loadFixtures(db: PGlite): Promise<void> {
  await insertOrg(db, A, 'ארגון א', 'org-a', 'c');
  await insertOrg(db, B, 'ארגון ב', 'org-b', 'd');
  await db.query(`insert into auth.users (id, email) values ($1, 'outsider@x.test')`, [OUTSIDER]);
}

/** Every tenant table with the fixture row id of each org, for cross-tenant sweeps. */
export const TENANT_TABLES: Array<[table: string, key: keyof OrgFixture]> = [
  ['projects', 'project'],
  ['sheet_sets', 'sheetSet'],
  ['sheets', 'sheet'],
  ['sheet_versions', 'sheetVersion'],
  ['sheet_regions', 'region'],
  ['legends', 'legend'],
  ['legend_entries', 'legendEntry'],
  ['symbol_templates', 'template'],
  ['rooms', 'room'],
  ['detections', 'detection1'],
  ['links', 'link'],
  ['item_library', 'item'],
  ['boq_templates', 'boqTemplate'],
  ['symbol_item_mappings', 'mapping'],
  ['boq_lines', 'boqLine'],
  ['boq_line_evidence', 'evidence'],
  ['share_links', 'shareLink'],
  ['jobs', 'job'],
];
