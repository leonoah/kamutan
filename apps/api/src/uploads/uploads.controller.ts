import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CreateUploadRequestSchema,
  CreateUploadResponseSchema,
  FinalizeUploadRequestSchema,
  FinalizeUploadResponseSchema,
  type CreateUploadRequest,
  type CreateUploadResponse,
  type FinalizeUploadRequest,
  type FinalizeUploadResponse,
  SheetSetSchema,
  type SheetSet,
} from '@kamutan/contracts';
import type { Request } from 'express';
import type { AuthContext, OrgAccess } from '../auth/auth-context';
import { CurrentOrgAccess, CurrentUser, RequireRole } from '../auth/decorators';
import { StrictRateLimit } from '../auth/user-throttler.guard';
import { traceparentFrom } from '../common/trace';
import { ApiErrors, ApiZodBody, ApiZodResponse } from '../common/zod-openapi';
import { zodPipe } from '../common/zod-validation.pipe';
import { REPOSITORY, type Repository } from '../db/repository';
import { z } from 'zod';
import { UploadsService } from './uploads.service';

@ApiTags('uploads')
@ApiBearerAuth()
@Controller({ path: 'projects/:projectId', version: '1' })
export class UploadsController {
  constructor(
    private readonly uploads: UploadsService,
    @Inject(REPOSITORY) private readonly repo: Repository,
  ) {}

  @Get('sheet-sets')
  @RequireRole('viewer', { from: 'project-param', key: 'projectId' })
  @ApiZodResponse(200, z.object({ items: z.array(SheetSetSchema) }))
  @ApiErrors(401, 404)
  async list(
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @CurrentUser() user: AuthContext,
  ): Promise<{ items: SheetSet[] }> {
    return { items: await this.repo.run(user, (tx) => tx.listSheetSets(projectId)) };
  }

  @Post('uploads')
  @StrictRateLimit()
  @RequireRole('editor', { from: 'project-param', key: 'projectId' })
  @ApiZodBody(CreateUploadRequestSchema)
  @ApiZodResponse(201, CreateUploadResponseSchema, 'Signed upload target (valid 10 minutes)')
  @ApiErrors(400, 401, 403, 404, 415, 429)
  create(
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body(zodPipe(CreateUploadRequestSchema)) body: CreateUploadRequest,
    @CurrentUser() user: AuthContext,
    @CurrentOrgAccess() access: OrgAccess,
  ): Promise<CreateUploadResponse> {
    return this.uploads.createUpload(user, access, projectId, body);
  }

  @Post('sheet-sets')
  @HttpCode(201)
  @StrictRateLimit()
  @RequireRole('editor', { from: 'project-param', key: 'projectId' })
  @ApiZodBody(FinalizeUploadRequestSchema)
  @ApiZodResponse(201, FinalizeUploadResponseSchema, 'Upload verified; sheet set created (or deduplicated) and ingest queued')
  @ApiErrors(400, 401, 403, 404, 409, 410, 413, 415, 429, 503)
  finalize(
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body(zodPipe(FinalizeUploadRequestSchema)) body: FinalizeUploadRequest,
    @CurrentUser() user: AuthContext,
    @CurrentOrgAccess() access: OrgAccess,
    @Req() req: Request,
  ): Promise<FinalizeUploadResponse> {
    return this.uploads.finalize(user, access, projectId, body, traceparentFrom(req.headers.traceparent));
  }
}
