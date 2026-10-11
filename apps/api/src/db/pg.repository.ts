import {
  fileKindFromDb,
  DB_FILE_KIND,
  type MyOrg,
  type Org,
  type OrgSettings,
  type PipelineState,
  type Project,
  type ProjectStatus,
  type Role,
  type SheetSet,
  type SheetVersion,
  type SheetVersionStatus,
} from '@kamutan/contracts';
import type { AuthContext } from '../auth/auth-context';
import { conflict } from '../common/api-exception';
import {
  decodeCursor,
  encodeCursor,
  type AuditEntry,
  type NewJob,
  type NewProject,
  type NewSheetSetUpload,
  type ProjectListOptions,
  type ProjectPatch,
  type Repository,
  type RepositoryTx,
  type SheetSetWithVersion,
} from './repository';
import { pgErrorCode, type SqlDatabase, type SqlExecutor } from './sql';

type Row = Record<string, unknown>;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

const ORG_COLS = 'o.id, o.name, o.slug, o.settings, o.created_at, o.updated_at';
const PROJECT_COLS =
  'p.id, p.org_id, p.name, p.address, p.status, p.created_by, p.created_at, p.updated_at, p.created_at::text as cursor_ts';
const SHEET_SET_COLS =
  'ss.id, ss.org_id, ss.project_id, ss.name, ss.uploaded_by, ss.source_file_path, ss.source_sha256, ss.file_kind, ss.created_at';
const SHEET_VERSION_COLS =
  'sv.id as sv_id, sv.org_id as sv_org_id, sv.sheet_id as sv_sheet_id, sv.version_no as sv_version_no, ' +
  'sv.source_sha256 as sv_source_sha256, sv.storage_path as sv_storage_path, sv.page_index as sv_page_index, ' +
  'sv.status as sv_status, sv.width_mm as sv_width_mm, sv.height_mm as sv_height_mm, sv.scale as sv_scale, ' +
  'sv.is_raster as sv_is_raster, sv.pipeline_state as sv_pipeline_state, sv.created_at as sv_created_at';

function mapOrg(r: Row): Org {
  return {
    id: String(r.id),
    name: String(r.name),
    slug: String(r.slug),
    settings: (r.settings ?? {}) as OrgSettings,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function mapProject(r: Row): Project {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    name: String(r.name),
    address: str(r.address),
    status: String(r.status) as ProjectStatus,
    createdBy: str(r.created_by),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function mapSheetSet(r: Row): SheetSet {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    projectId: String(r.project_id),
    name: String(r.name),
    uploadedBy: str(r.uploaded_by),
    sourceFilePath: str(r.source_file_path),
    sourceSha256: str(r.source_sha256),
    fileKind: fileKindFromDb(String(r.file_kind)),
    createdAt: iso(r.created_at),
  };
}

function mapSheetVersion(r: Row): SheetVersion {
  return {
    id: String(r.sv_id),
    orgId: String(r.sv_org_id),
    sheetId: String(r.sv_sheet_id),
    versionNo: Number(r.sv_version_no),
    sourceSha256: String(r.sv_source_sha256),
    storagePath: String(r.sv_storage_path),
    pageIndex: Number(r.sv_page_index),
    status: String(r.sv_status) as SheetVersionStatus,
    widthMm: num(r.sv_width_mm),
    heightMm: num(r.sv_height_mm),
    scale: num(r.sv_scale),
    isRaster: Boolean(r.sv_is_raster),
    pipelineState: (r.sv_pipeline_state ?? {}) as PipelineState,
    createdAt: iso(r.sv_created_at),
  };
}

class PgRepositoryTx implements RepositoryTx {
  constructor(private readonly q: SqlExecutor) {}

  private async rows(text: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.q.query<Row>(text, params)).rows;
  }

  private async one(text: string, params: unknown[] = []): Promise<Row | null> {
    return (await this.rows(text, params))[0] ?? null;
  }

  async listMyOrgs(): Promise<MyOrg[]> {
    const rows = await this.rows(
      `select ${ORG_COLS}, m.role from public.orgs o
         join public.memberships m on m.org_id = o.id
        where m.user_id = auth.uid()
        order by o.name, o.id`,
    );
    return rows.map((r) => ({ ...mapOrg(r), role: String(r.role) as Role }));
  }

  async getOrg(orgId: string): Promise<Org | null> {
    const r = await this.one(`select ${ORG_COLS} from public.orgs o where o.id = $1`, [orgId]);
    return r ? mapOrg(r) : null;
  }

  async createOrg(name: string, slug: string): Promise<Org> {
    let id: string;
    try {
      const r = await this.one(`select app.create_org($1, $2) as id`, [name, slug]);
      id = String(r?.id);
    } catch (err) {
      if (pgErrorCode(err) === '23505') throw conflict('org slug already taken');
      throw err;
    }
    const org = await this.getOrg(id);
    if (!org) throw new Error('created org not visible');
    return org;
  }

  async getMyRole(orgId: string): Promise<Role | null> {
    const r = await this.one(
      `select m.role from public.memberships m where m.org_id = $1 and m.user_id = auth.uid()`,
      [orgId],
    );
    return r ? (String(r.role) as Role) : null;
  }

  async listProjects(opts: ProjectListOptions): Promise<{ items: Project[]; nextCursor: string | null }> {
    const params: unknown[] = [];
    const where: string[] = [`p.status <> 'deleted'`];
    if (opts.orgId) {
      params.push(opts.orgId);
      where.push(`p.org_id = $${params.length}`);
    }
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
    if (cur) {
      params.push(cur.createdAt, cur.id);
      where.push(`(p.created_at, p.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(opts.limit + 1);
    const rows = await this.rows(
      `select ${PROJECT_COLS} from public.projects p
        where ${where.join(' and ')}
        order by p.created_at desc, p.id desc
        limit $${params.length}`,
      params,
    );
    const page = rows.slice(0, opts.limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > opts.limit && last ? encodeCursor(String(last.cursor_ts), String(last.id)) : null;
    return { items: page.map(mapProject), nextCursor };
  }

  async getProject(projectId: string): Promise<Project | null> {
    const r = await this.one(
      `select ${PROJECT_COLS} from public.projects p where p.id = $1 and p.status <> 'deleted'`,
      [projectId],
    );
    return r ? mapProject(r) : null;
  }

  async createProject(input: NewProject): Promise<Project> {
    const r = await this.one(
      `insert into public.projects as p (org_id, name, address, created_by)
       values ($1, $2, $3, auth.uid())
       returning ${PROJECT_COLS}`,
      [input.orgId, input.name, input.address],
    );
    if (!r) throw new Error('insert returned no row');
    return mapProject(r);
  }

  async updateProject(projectId: string, patch: ProjectPatch): Promise<Project | null> {
    const sets: string[] = [];
    const params: unknown[] = [projectId];
    const add = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.name !== undefined) add('name', patch.name);
    if (patch.address !== undefined) add('address', patch.address);
    if (patch.status !== undefined) add('status', patch.status);
    if (sets.length === 0) return this.getProject(projectId);
    const r = await this.one(
      `update public.projects as p set ${sets.join(', ')}
        where p.id = $1 and p.status <> 'deleted'
        returning ${PROJECT_COLS}`,
      params,
    );
    return r ? mapProject(r) : null;
  }

  async lockProjectFile(projectId: string, sha256: string): Promise<void> {
    await this.q.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${projectId}:${sha256}`]);
  }

  async findSheetSetBySha(projectId: string, sha256: string): Promise<SheetSetWithVersion | null> {
    const r = await this.one(
      `select ${SHEET_SET_COLS}, ${SHEET_VERSION_COLS}
         from public.sheet_sets ss
         join public.sheets s on s.sheet_set_id = ss.id
         join public.sheet_versions sv on sv.sheet_id = s.id and sv.source_sha256 = ss.source_sha256
        where ss.project_id = $1 and ss.source_sha256 = $2
        order by ss.created_at, sv.page_index, sv.version_no
        limit 1`,
      [projectId, sha256],
    );
    return r ? { sheetSet: mapSheetSet(r), sheetVersion: mapSheetVersion(r) } : null;
  }

  async createSheetSetWithVersion(input: NewSheetSetUpload): Promise<SheetSetWithVersion> {
    const ss = await this.one(
      `insert into public.sheet_sets as ss (org_id, project_id, name, uploaded_by, source_file_path, source_sha256, file_kind)
       values ($1, $2, $3, auth.uid(), $4, $5, $6)
       returning ${SHEET_SET_COLS}`,
      [input.orgId, input.projectId, input.name, input.storagePath, input.sha256, DB_FILE_KIND[input.fileKind]],
    );
    if (!ss) throw new Error('insert sheet_set returned no row');
    const sheetSetId = String(ss.id);
    // Placeholder sheet until ingest splits the set into real sheets (logical_key = sheet number).
    const sheet = await this.one(
      `insert into public.sheets (org_id, project_id, sheet_set_id, logical_key)
       values ($1, $2, $3, $4) returning id`,
      [input.orgId, input.projectId, sheetSetId, `upload:${sheetSetId}`],
    );
    if (!sheet) throw new Error('insert sheet returned no row');
    const sv = await this.one(
      `insert into public.sheet_versions as sv (org_id, sheet_id, version_no, source_sha256, storage_path, page_index, status)
       values ($1, $2, 1, $3, $4, 0, 'uploaded')
       returning ${SHEET_VERSION_COLS}`,
      [input.orgId, String(sheet.id), input.sha256, input.storagePath],
    );
    if (!sv) throw new Error('insert sheet_version returned no row');
    return { sheetSet: mapSheetSet(ss), sheetVersion: mapSheetVersion(sv) };
  }

  async setSheetVersionStatus(sheetVersionId: string, status: SheetVersionStatus): Promise<void> {
    await this.q.query(`update public.sheet_versions set status = $2 where id = $1`, [sheetVersionId, status]);
  }

  async createJob(input: NewJob): Promise<string> {
    const r = await this.one(
      `insert into public.jobs (org_id, project_id, sheet_version_id, type, status, input_hash, created_by)
       values ($1, $2, $3, $4, 'queued', $5, auth.uid())
       returning id`,
      [input.orgId, input.projectId, input.sheetVersionId, input.type, input.inputHash],
    );
    if (!r) throw new Error('insert job returned no row');
    return String(r.id);
  }

  async findJobId(sheetVersionId: string, type: string): Promise<string | null> {
    const r = await this.one(
      `select id from public.jobs where sheet_version_id = $1 and type = $2 order by created_at desc limit 1`,
      [sheetVersionId, type],
    );
    return r ? String(r.id) : null;
  }

  async writeAudit(entry: AuditEntry): Promise<void> {
    await this.q.query(`select app.write_audit($1, $2, $3, $4, null, $5::jsonb)`, [
      entry.orgId,
      entry.entity,
      entry.entityId,
      entry.action,
      entry.after ? JSON.stringify(entry.after) : null,
    ]);
  }
}

/**
 * Repository over Postgres that runs every unit of work as the end user:
 * `request.jwt.claims` is set from the verified JWT and the transaction
 * switches to role `authenticated`, so Supabase RLS policies apply (SEC-08).
 * The connecting DB role must be allowed to `SET ROLE authenticated`.
 */
export class PgRepository implements Repository {
  constructor(private readonly db: SqlDatabase) {}

  run<T>(user: AuthContext, fn: (tx: RepositoryTx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (q) => {
      await q.query(
        `select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`,
        [JSON.stringify(user.claims), user.userId],
      );
      await q.query('set local role authenticated');
      return fn(new PgRepositoryTx(q));
    });
  }

  ping(): Promise<void> {
    return this.db.ping();
  }

  close(): Promise<void> {
    return this.db.close();
  }
}
