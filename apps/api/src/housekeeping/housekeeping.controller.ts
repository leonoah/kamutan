import { Body, Controller, Delete, HttpCode, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  DeleteProjectRequestSchema,
  DeleteProjectResponseSchema,
  DeleteSheetSetResponseSchema,
  type DeleteProjectRequest,
  type DeleteProjectResponse,
  type DeleteSheetSetResponse,
} from '@kamutan/contracts';
import type { AuthContext } from '../auth/auth-context';
import { CurrentUser, RequireRole } from '../auth/decorators';
import { StrictRateLimit } from '../auth/user-throttler.guard';
import { ApiErrors, ApiZodBody, ApiZodResponse } from '../common/zod-openapi';
import { zodPipe } from '../common/zod-validation.pipe';
import { HousekeepingService } from './housekeeping.service';

const project = { from: 'project-param', key: 'projectId' } as const;

/** Sprint 8: deletes (sheet set: editor+; project: admin + MFA + typed confirmation). Audited. */
@ApiTags('projects')
@ApiBearerAuth()
@Controller({ path: 'projects/:projectId', version: '1' })
export class HousekeepingController {
  constructor(private readonly svc: HousekeepingService) {}

  /** The set, its sheets / versions / artifacts and source; quota released, share links of its sheets revoked. */
  @Delete('sheet-sets/:sheetSetId')
  @HttpCode(200)
  @StrictRateLimit()
  @RequireRole('editor', project)
  @ApiZodResponse(200, DeleteSheetSetResponseSchema)
  @ApiErrors(401, 403, 404, 409, 429)
  deleteSheetSet(@Param('projectId') projectId: string, @Param('sheetSetId') sheetSetId: string, @CurrentUser() user: AuthContext): Promise<DeleteSheetSetResponse> {
    return this.svc.deleteSheetSet(user, projectId, sheetSetId);
  }

  /** Permanently deletes the project (body `{confirmName}` = the project's name). */
  @Delete()
  @HttpCode(200)
  @StrictRateLimit()
  @RequireRole('admin', project)
  @ApiZodBody(DeleteProjectRequestSchema)
  @ApiZodResponse(200, DeleteProjectResponseSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  deleteProject(@Param('projectId') projectId: string, @Body(zodPipe(DeleteProjectRequestSchema)) body: DeleteProjectRequest, @CurrentUser() user: AuthContext): Promise<DeleteProjectResponse> {
    return this.svc.deleteProject(user, projectId, body);
  }
}
