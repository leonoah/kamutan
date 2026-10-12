import { Inject, Injectable } from '@nestjs/common';
import type { CreateProjectRequest, ListProjectsQuery, Project, ProjectPage, UpdateProjectRequest } from '@kamutan/contracts';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth-context';
import { notFound } from '../common/api-exception';
import { REPOSITORY, type Repository } from '../db/repository';

/** All methods authorize via AccessService before touching orgs/{orgId}/projects. */
@Injectable()
export class ProjectsService {
  constructor(
    private readonly access: AccessService,
    @Inject(REPOSITORY) private readonly repo: Repository,
  ) {}

  async list(user: AuthContext, q: ListProjectsQuery): Promise<ProjectPage> {
    await this.access.requireRole(user, q.orgId, 'viewer');
    return this.repo.listProjects(q.orgId, { limit: q.limit, cursor: q.cursor });
  }

  async create(user: AuthContext, body: CreateProjectRequest): Promise<Project> {
    await this.access.requireRole(user, body.orgId, 'editor');
    return this.repo.createProject(body.orgId, { name: body.name, address: body.address }, user.uid);
  }

  async get(user: AuthContext, projectId: string): Promise<Project> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'viewer');
    const project = await this.repo.getProject(orgId, projectId);
    if (!project) throw notFound('project');
    return project;
  }

  async update(user: AuthContext, projectId: string, body: UpdateProjectRequest): Promise<Project> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'editor');
    const project = await this.repo.updateProject(orgId, projectId, body, user.uid);
    if (!project) throw notFound('project');
    return project;
  }
}
