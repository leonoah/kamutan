import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
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
  SheetSetStatusResponseSchema,
  type SheetSetStatusResponse,
} from '@kamutan/contracts';
import type { Request } from 'express';
import type { AuthContext } from '../auth/auth-context';
import { CurrentUser, RequireRole } from '../auth/decorators';
import { StrictRateLimit } from '../auth/user-throttler.guard';
import { traceparentFrom } from '../common/trace';
import { ApiErrors, ApiZodBody, ApiZodResponse } from '../common/zod-openapi';
import { zodPipe } from '../common/zod-validation.pipe';
import { UploadsService } from './uploads.service';

@ApiTags('uploads')
@ApiBearerAuth()
@Controller({ path: 'projects/:projectId', version: '1' })
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post('uploads')
  @StrictRateLimit()
  @RequireRole('editor', { from: 'project-param', key: 'projectId' })
  @ApiZodBody(CreateUploadRequestSchema)
  @ApiZodResponse(201, CreateUploadResponseSchema, 'Upload target in Cloud Storage + upload token (valid 10 minutes)')
  @ApiErrors(400, 401, 403, 404, 413, 415, 429)
  create(
    @Param('projectId') projectId: string,
    @Body(zodPipe(CreateUploadRequestSchema)) body: CreateUploadRequest,
    @CurrentUser() user: AuthContext,
  ): Promise<CreateUploadResponse> {
    return this.uploads.createUpload(user, projectId, body);
  }

  @Post('sheet-sets')
  @HttpCode(201)
  @StrictRateLimit()
  @RequireRole('editor', { from: 'project-param', key: 'projectId' })
  @ApiZodBody(FinalizeUploadRequestSchema)
  @ApiZodResponse(201, FinalizeUploadResponseSchema, 'Upload verified; sheet set created (or deduplicated) and ingest published')
  @ApiErrors(400, 401, 403, 404, 409, 410, 413, 415, 429, 503)
  finalize(
    @Param('projectId') projectId: string,
    @Body(zodPipe(FinalizeUploadRequestSchema)) body: FinalizeUploadRequest,
    @CurrentUser() user: AuthContext,
    @Req() req: Request,
  ): Promise<FinalizeUploadResponse> {
    return this.uploads.finalize(user, projectId, body, traceparentFrom(req.headers.traceparent));
  }

  /** Sprint 7: upload status (set + ingest job + error with Hebrew text; `file_infected` = antivirus hit). */
  @Get('sheet-sets/:sheetSetId')
  @RequireRole('viewer', { from: 'project-param', key: 'projectId' })
  @ApiZodResponse(200, SheetSetStatusResponseSchema)
  @ApiErrors(401, 404, 429)
  status(@Param('projectId') projectId: string, @Param('sheetSetId') sheetSetId: string, @CurrentUser() user: AuthContext): Promise<SheetSetStatusResponse> {
    return this.uploads.sheetSetStatus(user, projectId, sheetSetId);
  }
}
