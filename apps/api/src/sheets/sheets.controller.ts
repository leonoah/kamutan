import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ConfirmSheetRequestSchema,
  ListSheetsQuerySchema,
  PutRegionsRequestSchema,
  PutRegionsResponseSchema,
  ReprocessSheetResponseSchema,
  SheetPageSchema,
  SheetSchema,
  SheetVersionSchema,
  TilesManifestQuerySchema,
  TilesManifestSchema,
  type ConfirmSheetRequest,
  type ListSheetsQuery,
  type PutRegionsRequest,
  type PutRegionsResponse,
  type ReprocessSheetResponse,
  type Sheet,
  type SheetPage,
  type SheetVersion,
  type TilesManifest,
  type TilesManifestQuery,
} from '@kamutan/contracts';
import type { Request } from 'express';
import type { AuthContext } from '../auth/auth-context';
import { CurrentUser, RequireRole } from '../auth/decorators';
import { RateLimit, StrictRateLimit } from '../auth/user-throttler.guard';
import { traceparentFrom } from '../common/trace';
import { ApiErrors, ApiZodBody, ApiZodQuery, ApiZodResponse } from '../common/zod-openapi';
import { zodPipe } from '../common/zod-validation.pipe';
import { SheetsService } from './sheets.service';

const project = { from: 'project-param', key: 'projectId' } as const;

@ApiTags('sheets')
@ApiBearerAuth()
@Controller({ path: 'projects/:projectId/sheets', version: '1' })
export class SheetsController {
  constructor(private readonly sheets: SheetsService) {}

  /** Sheets of a project with classification, confirmation and current version status/progress. */
  @Get()
  @RequireRole('viewer', project)
  @ApiZodQuery(ListSheetsQuerySchema)
  @ApiZodResponse(200, SheetPageSchema)
  @ApiErrors(400, 401, 404)
  list(
    @Param('projectId') projectId: string,
    @Query(zodPipe(ListSheetsQuerySchema)) query: ListSheetsQuery,
    @CurrentUser() user: AuthContext,
  ): Promise<SheetPage> {
    return this.sheets.list(user, projectId, query);
  }

  @Get(':sheetId/versions/:versionId')
  @RequireRole('viewer', project)
  @ApiZodResponse(200, SheetVersionSchema)
  @ApiErrors(401, 404)
  version(
    @Param('projectId') projectId: string,
    @Param('sheetId') sheetId: string,
    @Param('versionId') versionId: string,
    @CurrentUser() user: AuthContext,
  ): Promise<SheetVersion> {
    return this.sheets.getVersion(user, projectId, sheetId, versionId);
  }

  /** Tile meta + short-lived signed URLs (≤ 256 per call) and the thumbnail URL. */
  @Get(':sheetId/versions/:versionId/tiles-manifest')
  @RateLimit('tiles')
  @RequireRole('viewer', project)
  @ApiZodQuery(TilesManifestQuerySchema)
  @ApiZodResponse(200, TilesManifestSchema)
  @ApiErrors(400, 401, 404, 409, 429)
  tilesManifest(
    @Param('projectId') projectId: string,
    @Param('sheetId') sheetId: string,
    @Param('versionId') versionId: string,
    @Query(zodPipe(TilesManifestQuerySchema)) query: TilesManifestQuery,
    @CurrentUser() user: AuthContext,
  ): Promise<TilesManifest> {
    return this.sheets.tilesManifest(user, projectId, sheetId, versionId, query);
  }

  /** Confirms discipline / floors / scale (and optionally regions of the current version). Audited. */
  @Post(':sheetId/confirm')
  @HttpCode(200)
  @RequireRole('editor', project)
  @ApiZodBody(ConfirmSheetRequestSchema)
  @ApiZodResponse(200, SheetSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  confirm(
    @Param('projectId') projectId: string,
    @Param('sheetId') sheetId: string,
    @Body(zodPipe(ConfirmSheetRequestSchema)) body: ConfirmSheetRequest,
    @CurrentUser() user: AuthContext,
  ): Promise<Sheet> {
    return this.sheets.confirm(user, projectId, sheetId, body);
  }

  /** Replaces the floor/scale regions of the current version (≤ 8, inside the page, simple polygons). Audited. */
  @Put(':sheetId/regions')
  @RequireRole('editor', project)
  @ApiZodBody(PutRegionsRequestSchema)
  @ApiZodResponse(200, PutRegionsResponseSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  putRegions(
    @Param('projectId') projectId: string,
    @Param('sheetId') sheetId: string,
    @Body(zodPipe(PutRegionsRequestSchema)) body: PutRegionsRequest,
    @CurrentUser() user: AuthContext,
  ): Promise<PutRegionsResponse> {
    return this.sheets.putRegions(user, projectId, sheetId, body.regions);
  }

  /** Creates a new version of the sheet and publishes an ingest job for its page. Audited. */
  @Post(':sheetId/reprocess')
  @HttpCode(202)
  @StrictRateLimit()
  @RequireRole('editor', project)
  @ApiZodResponse(202, ReprocessSheetResponseSchema)
  @ApiErrors(401, 403, 404, 409, 429, 503)
  reprocess(
    @Param('projectId') projectId: string,
    @Param('sheetId') sheetId: string,
    @CurrentUser() user: AuthContext,
    @Req() req: Request,
  ): Promise<ReprocessSheetResponse> {
    return this.sheets.reprocess(user, projectId, sheetId, traceparentFrom(req.headers.traceparent));
  }
}
