import { Inject, Injectable, Optional } from '@nestjs/common';
import { MAX_SHEETS_PER_PROJECT, projectQuotaOf, type CreateProjectRequest, type ListProjectsQuery, type Org, type Project, type ProjectPage, type UpdateProjectRequest } from '@kamutan/contracts';
import { Logger } from '@nestjs/common';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth-context';
import { notFound } from '../common/api-exception';
import { REPOSITORY, type Repository } from '../db/repository';
import { ProjectStateService } from '../project-state/project-state.service';

/** All methods authorize via AccessService before touching orgs/{orgId}/projects. */
@Injectable()
export class ProjectsService {
  private readonly logger = new Logger('ProjectsService');

  constructor(
    private readonly access: AccessService,
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Optional() private readonly state?: ProjectStateService,
  ) {}

  async list(user: AuthContext, q: ListProjectsQuery): Promise<ProjectPage> {
    await this.access.requireRole(user, q.orgId, 'viewer');
    const [page, org] = await Promise.all([this.repo.listProjects(q.orgId, { limit: q.limit, cursor: q.cursor }), this.repo.getOrg(q.orgId)]);
    // A-LIVE-02: card counters (sheets, % verified, open items) — worker counters + the API's reviewOpen.
    const items: Project[] = [];
    for (let i = 0; i < page.items.length; i += 10) items.push(...(await Promise.all(page.items.slice(i, i + 10).map((p) => (this.state ? this.state.withStats(q.orgId, p) : p)))));
    return { ...page, items: items.map((p) => ({ ...withStorage(p, org), ...(p.stats ? { sheetCount: p.stats.sheets } : {}), sheetLimit: MAX_SHEETS_PER_PROJECT })) };
  }

  async create(user: AuthContext, body: CreateProjectRequest): Promise<Project> {
    await this.access.requireRole(user, body.orgId, 'editor');
    return this.repo.createProject(body.orgId, { name: body.name, address: body.address }, user.uid);
  }

  async get(user: AuthContext, projectId: string): Promise<Project> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'viewer');
    await this.state?.reconcileSupersedes(orgId, projectId);
    // Sprint 7 (quota): legacy projects get their usage counted once; infected uploads (quarantined) are released.
    await Promise.all([this.repo.ensureStorageCounted(orgId, projectId), this.repo.releaseInfectedStorage(orgId, projectId)]).catch((err: unknown) =>
      this.logger.warn({ err: (err as Error).message, orgId, projectId }, 'storage accounting failed'),
    );
    const [project, org, sheetCount] = await Promise.all([this.repo.getProject(orgId, projectId), this.repo.getOrg(orgId), this.repo.countCurrentSheets(orgId, projectId)]);
    if (!project) throw notFound('project');
    // Sprint 8 integration: the hub banner "N מתוך 100" (live count here; the list uses the card counter).
    return { ...withStorage(this.state ? await this.state.withStats(orgId, project) : project, org), sheetCount, sheetLimit: MAX_SHEETS_PER_PROJECT };
  }

  async update(user: AuthContext, projectId: string, body: UpdateProjectRequest): Promise<Project> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'editor');
    const project = await this.repo.updateProject(orgId, projectId, body, user.uid);
    if (!project) throw notFound('project');
    return project;
  }
}

/** Sprint 7: storage usage (absent on a never-counted legacy doc = 0 until its first read / upload) + the org quota. */
export function withStorage<P extends Project>(p: P, org: Pick<Org, 'settings'> | null): P {
  return { ...p, storageBytes: p.storageBytes ?? 0, storageQuotaBytes: projectQuotaOf(org?.settings) };
}
