import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  LegendEntryPageSchema,
  ListLegendEntriesQuerySchema,
  OverlayManifestSchema,
  PatchLegendEntryRequestSchema,
  PatchLegendEntryResponseSchema,
  ResolveUnknownClusterRequestSchema,
  ResolveUnknownClusterResponseSchema,
  type LegendEntryPage,
  type ListLegendEntriesQuery,
  type OverlayManifest,
  type PatchLegendEntryRequest,
  type PatchLegendEntryResponse,
  type ResolveUnknownClusterRequest,
  type ResolveUnknownClusterResponse,
} from '@kamutan/contracts';
import type { Request } from 'express';
import type { AuthContext } from '../auth/auth-context';
import { CurrentUser, RequireRole } from '../auth/decorators';
import { RateLimit, StrictRateLimit } from '../auth/user-throttler.guard';
import { traceparentFrom } from '../common/trace';
import { ApiErrors, ApiZodBody, ApiZodQuery, ApiZodResponse } from '../common/zod-openapi';
import { zodPipe } from '../common/zod-validation.pipe';
import { UnderstandingService } from './understanding.service';

const project = { from: 'project-param', key: 'projectId' } as const;

/** Sprint 2: overlay artifacts, legend confirmation, unknown-symbol resolution. */
@ApiTags('understanding')
@ApiBearerAuth()
@Controller({ path: 'projects/:projectId', version: '1' })
export class UnderstandingController {
  constructor(private readonly svc: UnderstandingService) {}

  /** Signed URLs of legend/detections/rooms artifacts + legend/unknown crops of a ready version. */
  @Get('sheets/:sheetId/versions/:versionId/overlay')
  @RateLimit('tiles')
  @RequireRole('viewer', project)
  @ApiZodResponse(200, OverlayManifestSchema)
  @ApiErrors(401, 404, 409, 429)
  overlay(
    @Param('projectId') projectId: string,
    @Param('sheetId') sheetId: string,
    @Param('versionId') versionId: string,
    @CurrentUser() user: AuthContext,
  ): Promise<OverlayManifest> {
    return this.svc.overlay(user, projectId, sheetId, versionId);
  }

  /** Project legend entries (all sheets), filter by status / sheet, with signed crop URLs. */
  @Get('legend-entries')
  @RequireRole('viewer', project)
  @ApiZodQuery(ListLegendEntriesQuerySchema)
  @ApiZodResponse(200, LegendEntryPageSchema)
  @ApiErrors(400, 401, 404, 429)
  listLegendEntries(
    @Param('projectId') projectId: string,
    @Query(zodPipe(ListLegendEntriesQuerySchema)) query: ListLegendEntriesQuery,
    @CurrentUser() user: AuthContext,
  ): Promise<LegendEntryPage> {
    return this.svc.listLegendEntries(user, projectId, query);
  }

  /** confirm | reassign (→ org symbol mapping, uses++) | ignore. Audited. */
  @Patch('legend-entries/:entryId')
  @RequireRole('editor', project)
  @ApiZodBody(PatchLegendEntryRequestSchema)
  @ApiZodResponse(200, PatchLegendEntryResponseSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  patchLegendEntry(
    @Param('projectId') projectId: string,
    @Param('entryId') entryId: string,
    @Body(zodPipe(PatchLegendEntryRequestSchema)) body: PatchLegendEntryRequest,
    @CurrentUser() user: AuthContext,
  ): Promise<PatchLegendEntryResponse> {
    return this.svc.patchLegendEntry(user, projectId, entryId, body);
  }

  /** "What is this?" answered once for a cluster: org mapping (+ optional confirmed legend entry) + reprocess. Audited. */
  @Post('unknown-clusters/:clusterId/resolve')
  @HttpCode(200)
  @StrictRateLimit()
  @RequireRole('editor', project)
  @ApiZodBody(ResolveUnknownClusterRequestSchema)
  @ApiZodResponse(200, ResolveUnknownClusterResponseSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  resolveUnknownCluster(
    @Param('projectId') projectId: string,
    @Param('clusterId') clusterId: string,
    @Body(zodPipe(ResolveUnknownClusterRequestSchema)) body: ResolveUnknownClusterRequest,
    @CurrentUser() user: AuthContext,
    @Req() req: Request,
  ): Promise<ResolveUnknownClusterResponse> {
    return this.svc.resolveUnknownCluster(user, projectId, clusterId, body, traceparentFrom(req.headers.traceparent));
  }
}
