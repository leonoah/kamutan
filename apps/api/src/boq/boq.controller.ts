import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  BoqLineEvidenceResponseSchema,
  BoqSheetEvidenceQuerySchema,
  BoqSheetEvidenceResponseSchema,
  type BoqSheetEvidenceQuery,
  type BoqSheetEvidenceResponse,
  BoqViewSchema,
  ExportBoqRequestSchema,
  ExportBoqResponseSchema,
  GetBoqQuerySchema,
  PatchBoqLineRequestSchema,
  PatchBoqLineResponseSchema,
  RequestBoqBuildResponseSchema,
  type BoqLineEvidenceResponse,
  type BoqView,
  type ExportBoqRequest,
  type ExportBoqResponse,
  type GetBoqQuery,
  type PatchBoqLineRequest,
  type PatchBoqLineResponse,
  type RequestBoqBuildResponse,
} from '@kamutan/contracts';
import type { Request } from 'express';
import type { AuthContext } from '../auth/auth-context';
import { CurrentUser, RequireRole } from '../auth/decorators';
import { RateLimit, StrictRateLimit } from '../auth/user-throttler.guard';
import { traceparentFrom } from '../common/trace';
import { ApiErrors, ApiZodBody, ApiZodQuery, ApiZodResponse } from '../common/zod-openapi';
import { zodPipe } from '../common/zod-validation.pipe';
import { BoqService } from './boq.service';

const project = { from: 'project-param', key: 'projectId' } as const;

/** Sprint 3: project BOQ (build, lines, review, evidence, Excel export). */
@ApiTags('boq')
@ApiBearerAuth()
@Controller({ path: 'projects/:projectId/boq', version: '1' })
export class BoqController {
  constructor(private readonly svc: BoqService) {}

  /** Creates boqBuilds/{id} + `boq.build` job (deduplicated while one is queued/running). Audited. */
  @Post('build')
  @HttpCode(202)
  @StrictRateLimit()
  @RequireRole('editor', project)
  @ApiZodResponse(202, RequestBoqBuildResponseSchema)
  @ApiErrors(401, 403, 404, 429, 503)
  build(@Param('projectId') projectId: string, @CurrentUser() user: AuthContext, @Req() req: Request): Promise<RequestBoqBuildResponse> {
    return this.svc.requestBuild(user, projectId, traceparentFrom(req.headers.traceparent));
  }

  /** Summary (build, stale, counts, floors) + lines sorted by chapter/code, paged. */
  @Get()
  @RequireRole('viewer', project)
  @ApiZodQuery(GetBoqQuerySchema)
  @ApiZodResponse(200, BoqViewSchema)
  @ApiErrors(400, 401, 404, 429)
  view(@Param('projectId') projectId: string, @Query(zodPipe(GetBoqQuerySchema)) q: GetBoqQuery, @CurrentUser() user: AuthContext): Promise<BoqView> {
    return this.svc.view(user, projectId, q);
  }

  /** status (reviewer+, BOQ_LINE_TRANSITIONS) / qtyOverride (editor+, reason) / note. Audited. */
  @Patch('lines/:lineId')
  @RequireRole('reviewer', project)
  @ApiZodBody(PatchBoqLineRequestSchema)
  @ApiZodResponse(200, PatchBoqLineResponseSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  patchLine(
    @Param('projectId') projectId: string,
    @Param('lineId') lineId: string,
    @Body(zodPipe(PatchBoqLineRequestSchema)) body: PatchBoqLineRequest,
    @CurrentUser() user: AuthContext,
  ): Promise<PatchBoqLineResponse> {
    return this.svc.patchLine(user, projectId, lineId, body);
  }

  /** The detections behind a line (from the build's evidence.json.gz). */
  @Get('lines/:lineId/evidence')
  @RequireRole('viewer', project)
  @ApiZodResponse(200, BoqLineEvidenceResponseSchema)
  @ApiErrors(401, 404, 429)
  evidence(@Param('projectId') projectId: string, @Param('lineId') lineId: string, @CurrentUser() user: AuthContext): Promise<BoqLineEvidenceResponse> {
    return this.svc.evidence(user, projectId, lineId);
  }

  /** detectionId / linkGroupId → line ids for one sheet version (latest build). */
  @Get('evidence')
  @RequireRole('viewer', project)
  @ApiZodQuery(BoqSheetEvidenceQuerySchema)
  @ApiZodResponse(200, BoqSheetEvidenceResponseSchema)
  @ApiErrors(400, 401, 404, 429)
  sheetEvidence(
    @Param('projectId') projectId: string,
    @Query(zodPipe(BoqSheetEvidenceQuerySchema)) q: BoqSheetEvidenceQuery,
    @CurrentUser() user: AuthContext,
  ): Promise<BoqSheetEvidenceResponse> {
    return this.svc.sheetEvidence(user, projectId, q.sheetId, q.versionId);
  }

  /** xlsx in the template's format → 2-minute signed URL. 409 export_blocked under blockExportOnRed. Audited. */
  @Post('export')
  @HttpCode(200)
  @RateLimit('export')
  @RequireRole('editor', project)
  @ApiZodBody(ExportBoqRequestSchema)
  @ApiZodResponse(200, ExportBoqResponseSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  export(@Param('projectId') projectId: string, @Body(zodPipe(ExportBoqRequestSchema)) body: ExportBoqRequest, @CurrentUser() user: AuthContext): Promise<ExportBoqResponse> {
    return this.svc.export(user, projectId, body);
  }
}
