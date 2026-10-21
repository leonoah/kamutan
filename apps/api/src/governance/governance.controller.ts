import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  AuditPageSchema,
  AuditQuerySchema,
  AuditVerifyResponseSchema,
  CreateMarkedPdfRequestSchema,
  CreateMarkedPdfResponseSchema,
  CreateOffboardingExportRequestSchema,
  CreateOffboardingExportResponseSchema,
  CreateShareLinkRequestSchema,
  CreateShareLinkResponseSchema,
  ExportStatusResponseSchema,
  LineHistoryResponseSchema,
  OffboardingExportViewSchema,
  OffboardOrgRequestSchema,
  OffboardOrgResponseSchema,
  PatchOrgSettingsRequestSchema,
  PatchOrgSettingsResponseSchema,
  RevokeShareLinkResponseSchema,
  ShareLinkListSchema,
  type AuditPage,
  type AuditQuery,
  type AuditVerifyResponse,
  type CreateMarkedPdfRequest,
  type CreateMarkedPdfResponse,
  type CreateOffboardingExportRequest,
  type CreateOffboardingExportResponse,
  type CreateShareLinkRequest,
  type CreateShareLinkResponse,
  type ExportStatusResponse,
  type LineHistoryResponse,
  type OffboardingExportView,
  type OffboardOrgRequest,
  type OffboardOrgResponse,
  type PatchOrgSettingsRequest,
  type PatchOrgSettingsResponse,
  type RevokeShareLinkResponse,
  type ShareLinkList,
} from '@kamutan/contracts';
import type { Request } from 'express';
import type { AuthContext } from '../auth/auth-context';
import { CurrentUser, RequireRole } from '../auth/decorators';
import { RateLimit, StrictRateLimit } from '../auth/user-throttler.guard';
import { traceparentFrom } from '../common/trace';
import { ApiErrors, ApiZodBody, ApiZodQuery, ApiZodResponse } from '../common/zod-openapi';
import { zodPipe } from '../common/zod-validation.pipe';
import { ShareLinksService } from '../share/share-links.service';
import { AuditService } from './audit.service';
import { ExportsService } from './exports.service';
import { OffboardingService } from './offboarding.service';

const org = { from: 'param', key: 'orgId' } as const;
const project = { from: 'project-param', key: 'projectId' } as const;

/** Sprint 5: org audit log + chain verification, org settings, offboarding (SEC-35, FR-31, SEC-52). Admin only. */
@ApiTags('governance')
@ApiBearerAuth()
@Controller({ path: 'orgs/:orgId', version: '1' })
export class OrgGovernanceController {
  constructor(
    private readonly audit: AuditService,
    private readonly offboarding: OffboardingService,
  ) {}

  /** Newest first, `cursor` = last event id, filters entity / action / entityId. */
  @Get('audit')
  @RequireRole('admin', org)
  @ApiZodQuery(AuditQuerySchema)
  @ApiZodResponse(200, AuditPageSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  list(@Param('orgId') orgId: string, @Query(zodPipe(AuditQuerySchema)) q: AuditQuery, @CurrentUser() user: AuthContext): Promise<AuditPage> {
    return this.audit.list(user, orgId, q);
  }

  /** Recomputes every hash and link of the org's chain → `{ok, checked, brokenAt}`. */
  @Get('audit/verify')
  @StrictRateLimit()
  @RequireRole('admin', org)
  @ApiZodResponse(200, AuditVerifyResponseSchema)
  @ApiErrors(401, 403, 404, 429)
  verify(@Param('orgId') orgId: string, @CurrentUser() user: AuthContext): Promise<AuditVerifyResponse> {
    return this.audit.verify(user, orgId);
  }

  /** greenThreshold (0.9–0.995), blockExportOnRed, llmEnabled, trainingOptIn. Audited `{field: {from, to}}`. */
  @Patch('settings')
  @RequireRole('admin', org)
  @ApiZodBody(PatchOrgSettingsRequestSchema)
  @ApiZodResponse(200, PatchOrgSettingsResponseSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  settings(@Param('orgId') orgId: string, @Body(zodPipe(PatchOrgSettingsRequestSchema)) body: PatchOrgSettingsRequest, @CurrentUser() user: AuthContext): Promise<PatchOrgSettingsResponse> {
    return this.offboarding.patchSettings(user, orgId, body);
  }

  /** ZIP of sources + BOQ xlsx + JSON (job on topic api-jobs). Admin + MFA + sign-in ≤ 10 min. */
  @Post('offboarding/export')
  @HttpCode(202)
  @StrictRateLimit()
  @RequireRole('admin', org, { allowOffboarding: true })
  @ApiZodBody(CreateOffboardingExportRequestSchema)
  @ApiZodResponse(202, CreateOffboardingExportResponseSchema)
  @ApiErrors(400, 401, 403, 404, 429, 503)
  requestExport(
    @Param('orgId') orgId: string,
    @Body(zodPipe(CreateOffboardingExportRequestSchema)) body: CreateOffboardingExportRequest,
    @CurrentUser() user: AuthContext,
    @Req() req: Request,
  ): Promise<CreateOffboardingExportResponse> {
    return this.offboarding.requestExport(user, orgId, body, traceparentFrom(req.headers.traceparent));
  }

  /** Status + 24 h signed URL when ready. Works while the org is offboarding. */
  @Get('offboarding/export/:exportId')
  @RequireRole('admin', org, { allowOffboarding: true })
  @ApiZodResponse(200, OffboardingExportViewSchema)
  @ApiErrors(401, 403, 404, 429)
  getExport(@Param('orgId') orgId: string, @Param('exportId') exportId: string, @CurrentUser() user: AuthContext): Promise<OffboardingExportView> {
    return this.offboarding.getExport(user, orgId, exportId);
  }

  /** Admin + MFA + sign-in ≤ 10 min + typed org name → status offboarding, links + sessions revoked, delete at +30 d. */
  @Post('offboarding')
  @HttpCode(200)
  @StrictRateLimit()
  @RequireRole('admin', org, { allowOffboarding: true })
  @ApiZodBody(OffboardOrgRequestSchema)
  @ApiZodResponse(200, OffboardOrgResponseSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  offboard(@Param('orgId') orgId: string, @Body(zodPipe(OffboardOrgRequestSchema)) body: OffboardOrgRequest, @CurrentUser() user: AuthContext): Promise<OffboardOrgResponse> {
    return this.offboarding.offboard(user, orgId, body);
  }
}

/** Sprint 5: line history, marked-PDF export + export status, share links (project scope). */
@ApiTags('governance')
@ApiBearerAuth()
@Controller({ path: 'projects/:projectId', version: '1' })
export class ProjectGovernanceController {
  constructor(
    private readonly audit: AuditService,
    private readonly exports: ExportsService,
    private readonly shares: ShareLinksService,
  ) {}

  /** status / qtyOverride / note changes + corrections affecting the line, newest first (reviewer+). */
  @Get('boq/lines/:lineId/history')
  @RequireRole('reviewer', project)
  @ApiZodResponse(200, LineHistoryResponseSchema)
  @ApiErrors(401, 403, 404, 429)
  history(@Param('projectId') projectId: string, @Param('lineId') lineId: string, @CurrentUser() user: AuthContext): Promise<LineHistoryResponse> {
    return this.audit.lineHistory(user, projectId, lineId);
  }

  /** exports/{id} (marked_pdf, queued) + `export.marked_pdf` job. Audited. */
  @Post('boq/export/marked-pdf')
  @HttpCode(202)
  @RateLimit('export')
  @RequireRole('editor', project)
  @ApiZodBody(CreateMarkedPdfRequestSchema)
  @ApiZodResponse(202, CreateMarkedPdfResponseSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429, 503)
  markedPdf(
    @Param('projectId') projectId: string,
    @Body(zodPipe(CreateMarkedPdfRequestSchema)) body: CreateMarkedPdfRequest,
    @CurrentUser() user: AuthContext,
    @Req() req: Request,
  ): Promise<CreateMarkedPdfResponse> {
    return this.exports.createMarkedPdf(user, projectId, body, traceparentFrom(req.headers.traceparent));
  }

  /** Status of an export (xlsx or marked_pdf) + signed URL when ready (marked PDF 15 min). Download audited. */
  @Get('exports/:exportId')
  @RequireRole('viewer', project)
  @ApiZodResponse(200, ExportStatusResponseSchema)
  @ApiErrors(401, 404, 429)
  getExport(@Param('projectId') projectId: string, @Param('exportId') exportId: string, @CurrentUser() user: AuthContext): Promise<ExportStatusResponse> {
    return this.exports.get(user, projectId, exportId);
  }

  /** Raw 256-bit token returned ONCE (only its SHA-256 is stored). editor+. */
  @Post('share-links')
  @StrictRateLimit()
  @RequireRole('editor', project)
  @ApiZodBody(CreateShareLinkRequestSchema)
  @ApiZodResponse(201, CreateShareLinkResponseSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  createLink(
    @Param('projectId') projectId: string,
    @Body(zodPipe(CreateShareLinkRequestSchema)) body: CreateShareLinkRequest,
    @CurrentUser() user: AuthContext,
    @Req() req: Request,
  ): Promise<CreateShareLinkResponse> {
    return this.shares.create(user, projectId, body, traceparentFrom(req.headers.traceparent));
  }

  /** Active + expired + revoked links of the project, newest first (no token hashes). */
  @Get('share-links')
  @RequireRole('editor', project)
  @ApiZodResponse(200, ShareLinkListSchema)
  @ApiErrors(401, 403, 404, 429)
  listLinks(@Param('projectId') projectId: string, @CurrentUser() user: AuthContext): Promise<ShareLinkList> {
    return this.shares.list(user, projectId);
  }

  /** Immediate revoke (idempotent). Audited. */
  @Delete('share-links/:linkId')
  @RequireRole('editor', project)
  @ApiZodResponse(200, RevokeShareLinkResponseSchema)
  @ApiErrors(401, 403, 404, 429)
  revokeLink(@Param('projectId') projectId: string, @Param('linkId') linkId: string, @CurrentUser() user: AuthContext): Promise<RevokeShareLinkResponse> {
    return this.shares.revoke(user, projectId, linkId);
  }
}
