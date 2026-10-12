import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
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
import type { AuthContext } from '../auth/auth-context';
import { CurrentUser, RequireRole } from '../auth/decorators';
import { ApiErrors, ApiZodBody, ApiZodQuery, ApiZodResponse } from '../common/zod-openapi';
import { zodPipe } from '../common/zod-validation.pipe';
import { ProjectsService } from './projects.service';

@ApiTags('projects')
@ApiBearerAuth()
@Controller({ path: 'projects', version: '1' })
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  /** Projects of one org (?orgId=), newest first, cursor-paginated. */
  @Get()
  @RequireRole('viewer', { from: 'query', key: 'orgId' })
  @ApiZodQuery(ListProjectsQuerySchema)
  @ApiZodResponse(200, ProjectPageSchema)
  @ApiErrors(400, 401, 404)
  list(@CurrentUser() user: AuthContext, @Query(zodPipe(ListProjectsQuerySchema)) query: ListProjectsQuery): Promise<ProjectPage> {
    return this.projects.list(user, query);
  }

  @Post()
  @RequireRole('editor', { from: 'body', key: 'orgId' })
  @ApiZodBody(CreateProjectRequestSchema)
  @ApiZodResponse(201, ProjectSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  create(@CurrentUser() user: AuthContext, @Body(zodPipe(CreateProjectRequestSchema)) body: CreateProjectRequest): Promise<Project> {
    return this.projects.create(user, body);
  }

  @Get(':projectId')
  @RequireRole('viewer', { from: 'project-param', key: 'projectId' })
  @ApiZodResponse(200, ProjectSchema)
  @ApiErrors(401, 404)
  get(@Param('projectId') projectId: string, @CurrentUser() user: AuthContext): Promise<Project> {
    return this.projects.get(user, projectId);
  }

  @Patch(':projectId')
  @RequireRole('editor', { from: 'project-param', key: 'projectId' })
  @ApiZodBody(UpdateProjectRequestSchema)
  @ApiZodResponse(200, ProjectSchema)
  @ApiErrors(400, 401, 403, 404)
  update(
    @Param('projectId') projectId: string,
    @Body(zodPipe(UpdateProjectRequestSchema)) body: UpdateProjectRequest,
    @CurrentUser() user: AuthContext,
  ): Promise<Project> {
    return this.projects.update(user, projectId, body);
  }
}
