import { Inject, Injectable, Optional } from '@nestjs/common';
import type { CreateProjectRequest, ListProjectsQuery, Project, ProjectPage, UpdateProjectRequest } from '@kamutan/contracts';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth-context';
import { notFound } from '../common/api-exception';
import { REPOSITORY, type Repository } from '../db/repository';
import { ProjectStateService } from '../project-state/project-state.service';

/** All methods authorize via AccessService before touching orgs/{orgId}/projects. */
@Injectable()
export class ProjectsService {
  constructor(
    private readonly access: AccessService,
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Optional() private readonly state?: ProjectStateService,
  ) {}

  async list(user: AuthContext, q: ListProjectsQuery): Promise<ProjectPage> {
    await this.access.requireRole(user, q.orgId, 'viewer');
    const page = await this.repo.listProjects(q.orgId, { limit: q.limit, cursor: q.cursor });
    // A-LIVE-02: card counters (sheets, % verified, open items) — worker counters + the API's reviewOpen.
    const items: Project[] = [];
    for (let i = 0; i < page.items.length; i += 10) items.push(...(await Promise.all(page.items.slice(i, i + 10).map((p) => (this.state ? this.state.withStats(q.orgId, p) : p)))));
    return { ...page, items };
  }

  async create(user: AuthContext, body: CreateProjectRequest): Promise<Project> {
    await this.access.requireRole(user, body.orgId, 'editor');
    return this.repo.createProject(body.orgId, { name: body.name, address: body.address }, user.uid);
  }

  async get(user: AuthContext, projectId: string): Promise<Project> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'viewer');
    await this.state?.reconcileSupersedes(orgId, projectId);
    const project = await this.repo.getProject(orgId, projectId);
    if (!project) throw notFound('project');
    return this.state ? this.state.withStats(orgId, project) : project;
  }

  async update(user: AuthContext, projectId: string, body: UpdateProjectRequest): Promise<Project> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'editor');
    const project = await this.repo.updateProject(orgId, projectId, body, user.uid);
    if (!project) throw notFound('project');
    return project;
  }
}
