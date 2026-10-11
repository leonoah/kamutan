import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CreateProjectRequestSchema,
  ListProjectsQuerySchema,
  ProjectPageSchema,
  ProjectSchema,
  UpdateProjectRequestSchema,
  type CreateProjectRequest,
  type ListProjectsQuery,
  type Project,
  type ProjectPage,
  type UpdateProjectRequest,
} from '@kamutan/contracts';
import type { AuthContext, OrgAccess } from '../auth/auth-context';
import { CurrentOrgAccess, CurrentUser, RequireRole } from '../auth/decorators';
import { forbidden, notFound } from '../common/api-exception';
import { ApiErrors, ApiZodBody, ApiZodQuery, ApiZodResponse } from '../common/zod-openapi';
import { zodPipe } from '../common/zod-validation.pipe';
import { REPOSITORY, type Repository } from '../db/repository';

@ApiTags('projects')
@ApiBearerAuth()
@Controller({ path: 'projects', version: '1' })
export class ProjectsController {
  constructor(@Inject(REPOSITORY) private readonly repo: Repository) {}

  /** Projects of all my orgs (or one org with ?orgId=), newest first, cursor-paginated. */
  @Get()
  @ApiZodQuery(ListProjectsQuerySchema)
  @ApiZodResponse(200, ProjectPageSchema)
  @ApiErrors(400, 401)
  list(
    @CurrentUser() user: AuthContext,
    @Query(zodPipe(ListProjectsQuerySchema)) query: ListProjectsQuery,
  ): Promise<ProjectPage> {
    return this.repo.run(user, (tx) => tx.listProjects(query));
  }

  @Post()
  @RequireRole('editor', { from: 'body', key: 'orgId' })
  @ApiZodBody(CreateProjectRequestSchema)
  @ApiZodResponse(201, ProjectSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  create(
    @CurrentUser() user: AuthContext,
    @Body(zodPipe(CreateProjectRequestSchema)) body: CreateProjectRequest,
  ): Promise<Project> {
    return this.repo.run(user, async (tx) => {
      const project = await tx.createProject({ orgId: body.orgId, name: body.name, address: body.address ?? null });
      await tx.writeAudit({ orgId: project.orgId, entity: 'projects', entityId: project.id, action: 'create' });
      return project;
    });
  }

  @Get(':projectId')
  @RequireRole('viewer', { from: 'project-param', key: 'projectId' })
  @ApiZodResponse(200, ProjectSchema)
  @ApiErrors(401, 404)
  async get(
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @CurrentUser() user: AuthContext,
  ): Promise<Project> {
    const project = await this.repo.run(user, (tx) => tx.getProject(projectId));
    if (!project) throw notFound('project');
    return project;
  }

  @Patch(':projectId')
  @RequireRole('editor', { from: 'project-param', key: 'projectId' })
  @ApiZodBody(UpdateProjectRequestSchema)
  @ApiZodResponse(200, ProjectSchema)
  @ApiErrors(400, 401, 403, 404)
  async update(
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body(zodPipe(UpdateProjectRequestSchema)) body: UpdateProjectRequest,
    @CurrentUser() user: AuthContext,
    @CurrentOrgAccess() access: OrgAccess,
  ): Promise<Project> {
    // Archiving/unarchiving is an editor action; deletion is admin+MFA and not exposed in Sprint 0.
    if (body.status !== undefined && !['active', 'archived'].includes(body.status)) throw forbidden();
    const project = await this.repo.run(user, (tx) => tx.updateProject(projectId, body));
    if (!project || project.orgId !== access.orgId) throw notFound('project');
    return project;
  }
}
