import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CorrectionPageSchema,
  CreateCorrectionBatchRequestSchema,
  CreateCorrectionBatchResponseSchema,
  CreateCorrectionRequestSchema,
  CreateCorrectionResponseSchema,
  CreateSimilarSearchRequestSchema,
  CreateSimilarSearchResponseSchema,
  ListCorrectionsQuerySchema,
  PutRoomSettingsRequestSchema,
  ReviewQueuePageSchema,
  ReviewQueueQuerySchema,
  RevertCorrectionBatchResponseSchema,
  RevertCorrectionResponseSchema,
  RoomSettingsResponseSchema,
  SimilarSearchViewSchema,
  type CorrectionPage,
  type CreateCorrectionBatchRequest,
  type CreateCorrectionBatchResponse,
  type CreateCorrectionRequest,
  type CreateCorrectionResponse,
  type CreateSimilarSearchRequest,
  type CreateSimilarSearchResponse,
  type ListCorrectionsQuery,
  type PutRoomSettingsRequest,
  type ReviewQueuePage,
  type ReviewQueueQuery,
  type RevertCorrectionBatchResponse,
  type RevertCorrectionResponse,
  type RoomSettingsResponse,
  type SimilarSearchView,
} from '@kamutan/contracts';
import type { Request } from 'express';
import type { AuthContext } from '../auth/auth-context';
import { CurrentUser, RequireRole } from '../auth/decorators';
import { StrictRateLimit } from '../auth/user-throttler.guard';
import { traceparentFrom } from '../common/trace';
import { ApiErrors, ApiZodBody, ApiZodQuery, ApiZodResponse } from '../common/zod-openapi';
import { zodPipe } from '../common/zod-validation.pipe';
import { CorrectionsService } from './corrections.service';
import { ReviewQueueService } from './review-queue.service';
import { RoomSettingsService } from './room-settings.service';
import { SimilarService } from './similar.service';

const project = { from: 'project-param', key: 'projectId' } as const;

/**
 * Sprint 4: corrections (+ batch, revert, list), review queue, room settings, find-similar.
 * Route-level role = the minimum of the endpoint; the services re-check per correction kind
 * (accept/reject reviewer+, other kinds editor+).
 */
@ApiTags('review')
@ApiBearerAuth()
@Controller({ path: 'projects/:projectId', version: '1' })
export class ReviewController {
  constructor(
    private readonly corrections: CorrectionsService,
    private readonly queueSvc: ReviewQueueService,
    private readonly rooms: RoomSettingsService,
    private readonly similar: SimilarService,
  ) {}

  /** One correction. Audited; marks the BOQ stale and schedules a debounced rebuild. */
  @Post('corrections')
  @HttpCode(201)
  @RequireRole('reviewer', project)
  @ApiZodBody(CreateCorrectionRequestSchema)
  @ApiZodResponse(201, CreateCorrectionResponseSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  create(
    @Param('projectId') projectId: string,
    @Body(zodPipe(CreateCorrectionRequestSchema)) body: CreateCorrectionRequest,
    @CurrentUser() user: AuthContext,
    @Req() req: Request,
  ): Promise<CreateCorrectionResponse> {
    return this.corrections.create(user, projectId, body, traceparentFrom(req.headers.traceparent));
  }

  /** 1..500 corrections, all-or-nothing, one batchId (cluster accept, lasso, learn-from-correction). */
  @Post('corrections/batch')
  @HttpCode(201)
  @StrictRateLimit()
  @RequireRole('reviewer', project)
  @ApiZodBody(CreateCorrectionBatchRequestSchema)
  @ApiZodResponse(201, CreateCorrectionBatchResponseSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  createBatch(
    @Param('projectId') projectId: string,
    @Body(zodPipe(CreateCorrectionBatchRequestSchema)) body: CreateCorrectionBatchRequest,
    @CurrentUser() user: AuthContext,
    @Req() req: Request,
  ): Promise<CreateCorrectionBatchResponse> {
    return this.corrections.createBatch(user, projectId, body, traceparentFrom(req.headers.traceparent));
  }

  /** Undo one correction (sets revertedAt). 409 when already reverted. */
  @Post('corrections/:correctionId/revert')
  @HttpCode(200)
  @RequireRole('reviewer', project)
  @ApiZodResponse(200, RevertCorrectionResponseSchema)
  @ApiErrors(401, 403, 404, 409, 429)
  revert(@Param('projectId') projectId: string, @Param('correctionId') correctionId: string, @CurrentUser() user: AuthContext, @Req() req: Request): Promise<RevertCorrectionResponse> {
    return this.corrections.revert(user, projectId, correctionId, traceparentFrom(req.headers.traceparent));
  }

  /** Undo a whole batch (one undo step, UX). */
  @Post('correction-batches/:batchId/revert')
  @HttpCode(200)
  @RequireRole('reviewer', project)
  @ApiZodResponse(200, RevertCorrectionBatchResponseSchema)
  @ApiErrors(401, 403, 404, 409, 429)
  revertBatch(@Param('projectId') projectId: string, @Param('batchId') batchId: string, @CurrentUser() user: AuthContext, @Req() req: Request): Promise<RevertCorrectionBatchResponse> {
    return this.corrections.revertBatch(user, projectId, batchId, traceparentFrom(req.headers.traceparent));
  }

  /** Newest first; `includeReverted=true` for the history panel. */
  @Get('corrections')
  @RequireRole('viewer', project)
  @ApiZodQuery(ListCorrectionsQuerySchema)
  @ApiZodResponse(200, CorrectionPageSchema)
  @ApiErrors(400, 401, 404, 429)
  list(@Param('projectId') projectId: string, @Query(zodPipe(ListCorrectionsQuerySchema)) q: ListCorrectionsQuery, @CurrentUser() user: AuthContext): Promise<CorrectionPage> {
    return this.corrections.list(user, projectId, q);
  }

  /** Risk-ranked review queue of the latest build + live corrections. */
  @Get('review-queue')
  @RequireRole('viewer', project)
  @ApiZodQuery(ReviewQueueQuerySchema)
  @ApiZodResponse(200, ReviewQueuePageSchema)
  @ApiErrors(400, 401, 404, 429)
  queue(@Param('projectId') projectId: string, @Query(zodPipe(ReviewQueueQuerySchema)) q: ReviewQueueQuery, @CurrentUser() user: AuthContext): Promise<ReviewQueuePage> {
    return this.queueSvc.queue(user, projectId, q);
  }

  @Get('rooms/:sheetId/:roomId/settings')
  @RequireRole('viewer', project)
  @ApiZodResponse(200, RoomSettingsResponseSchema)
  @ApiErrors(401, 404, 429)
  getRoom(@Param('projectId') projectId: string, @Param('sheetId') sheetId: string, @Param('roomId') roomId: string, @CurrentUser() user: AuthContext): Promise<RoomSettingsResponse> {
    return this.rooms.get(user, projectId, sheetId, roomId);
  }

  /** Whole settings doc (strict). Validated against the room's walls/openings; audited; BOQ stale + debounced rebuild. */
  @Put('rooms/:sheetId/:roomId/settings')
  @RequireRole('editor', project)
  @ApiZodBody(PutRoomSettingsRequestSchema)
  @ApiZodResponse(200, RoomSettingsResponseSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  putRoom(
    @Param('projectId') projectId: string,
    @Param('sheetId') sheetId: string,
    @Param('roomId') roomId: string,
    @Body(zodPipe(PutRoomSettingsRequestSchema)) body: PutRoomSettingsRequest,
    @CurrentUser() user: AuthContext,
    @Req() req: Request,
  ): Promise<RoomSettingsResponse> {
    return this.rooms.put(user, projectId, sheetId, roomId, body, traceparentFrom(req.headers.traceparent));
  }

  /** Enqueue `symbols.find_similar` for an exemplar box. Strict rate limit. */
  @Post('similar-searches')
  @HttpCode(202)
  @StrictRateLimit()
  @RequireRole('reviewer', project)
  @ApiZodBody(CreateSimilarSearchRequestSchema)
  @ApiZodResponse(202, CreateSimilarSearchResponseSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429, 503)
  createSimilar(
    @Param('projectId') projectId: string,
    @Body(zodPipe(CreateSimilarSearchRequestSchema)) body: CreateSimilarSearchRequest,
    @CurrentUser() user: AuthContext,
    @Req() req: Request,
  ): Promise<CreateSimilarSearchResponse> {
    return this.similar.create(user, projectId, body, traceparentFrom(req.headers.traceparent));
  }

  /** Status + candidates + signed crop URLs (≤ 256). */
  @Get('similar-searches/:searchId')
  @RequireRole('viewer', project)
  @ApiZodResponse(200, SimilarSearchViewSchema)
  @ApiErrors(401, 404, 429)
  getSimilar(@Param('projectId') projectId: string, @Param('searchId') searchId: string, @CurrentUser() user: AuthContext): Promise<SimilarSearchView> {
    return this.similar.get(user, projectId, searchId);
  }
}
