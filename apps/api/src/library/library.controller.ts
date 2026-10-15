import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  BoqRuleListSchema,
  BoqRuleSchema,
  BoqTemplateListSchema,
  BoqTemplateSchema,
  CreateLibraryImportRequestSchema,
  CreateLibraryImportResponseSchema,
  CreateLibraryItemRequestSchema,
  FinalizeLibraryImportRequestSchema,
  ItemLibraryItemSchema,
  LibraryImportViewSchema,
  LibraryItemPageSchema,
  ListLibraryItemsQuerySchema,
  OrgScopeQuerySchema,
  PatchBoqRuleRequestSchema,
  PatchBoqTemplateRequestSchema,
  PatchLibraryItemRequestSchema,
  type BoqRule,
  type BoqRuleList,
  type BoqTemplate,
  type BoqTemplateList,
  type CreateLibraryImportRequest,
  type CreateLibraryImportResponse,
  type CreateLibraryItemRequest,
  type FinalizeLibraryImportRequest,
  type ItemLibraryItem,
  type LibraryImportView,
  type LibraryItemPage,
  type ListLibraryItemsQuery,
  type OrgScopeQuery,
  type PatchBoqRuleRequest,
  type PatchBoqTemplateRequest,
  type PatchLibraryItemRequest,
} from '@kamutan/contracts';
import type { Request } from 'express';
import type { AuthContext } from '../auth/auth-context';
import { CurrentUser, RequireRole } from '../auth/decorators';
import { StrictRateLimit } from '../auth/user-throttler.guard';
import { traceparentFrom } from '../common/trace';
import { ApiErrors, ApiZodBody, ApiZodQuery, ApiZodResponse } from '../common/zod-openapi';
import { zodPipe } from '../common/zod-validation.pipe';
import { LibraryService } from './library.service';

const orgQuery = { from: 'query', key: 'orgId' } as const;
const orgBody = { from: 'body', key: 'orgId' } as const;

/** Sprint 3: org item library + past-BOQ imports. */
@ApiTags('library')
@ApiBearerAuth()
@Controller({ path: 'library', version: '1' })
export class LibraryController {
  constructor(private readonly svc: LibraryService) {}

  @Get('items')
  @RequireRole('viewer', orgQuery)
  @ApiZodQuery(ListLibraryItemsQuerySchema)
  @ApiZodResponse(200, LibraryItemPageSchema)
  @ApiErrors(400, 401, 404, 429)
  listItems(@Query(zodPipe(ListLibraryItemsQuerySchema)) q: ListLibraryItemsQuery, @CurrentUser() user: AuthContext): Promise<LibraryItemPage> {
    return this.svc.listItems(user, q);
  }

  /** Manual item (source `manual`); id = itemIdFor(code, description). Audited. */
  @Post('items')
  @RequireRole('editor', orgBody)
  @ApiZodBody(CreateLibraryItemRequestSchema)
  @ApiZodResponse(201, ItemLibraryItemSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  createItem(@Body(zodPipe(CreateLibraryItemRequestSchema)) body: CreateLibraryItemRequest, @CurrentUser() user: AuthContext): Promise<ItemLibraryItem> {
    return this.svc.createItem(user, body);
  }

  /** unit / chapterTitle / tags / active. Audited. */
  @Patch('items/:itemId')
  @RequireRole('editor', orgQuery)
  @ApiZodQuery(OrgScopeQuerySchema)
  @ApiZodBody(PatchLibraryItemRequestSchema)
  @ApiZodResponse(200, ItemLibraryItemSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  patchItem(
    @Param('itemId') itemId: string,
    @Query(zodPipe(OrgScopeQuerySchema)) q: OrgScopeQuery,
    @Body(zodPipe(PatchLibraryItemRequestSchema)) body: PatchLibraryItemRequest,
    @CurrentUser() user: AuthContext,
  ): Promise<ItemLibraryItem> {
    return this.svc.patchItem(user, q.orgId, itemId, body);
  }

  /** Reserve orgs/{orgId}/imports/{uuid}.{xls|xlsx}; upload there, then finalize. */
  @Post('imports')
  @StrictRateLimit()
  @RequireRole('editor', orgBody)
  @ApiZodBody(CreateLibraryImportRequestSchema)
  @ApiZodResponse(201, CreateLibraryImportResponseSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  createImport(@Body(zodPipe(CreateLibraryImportRequestSchema)) body: CreateLibraryImportRequest, @CurrentUser() user: AuthContext): Promise<CreateLibraryImportResponse> {
    return this.svc.createImport(user, body);
  }

  /** Magic-bytes check of the uploaded object → `library.import` job (audited). */
  @Post('imports/:importId/finalize')
  @HttpCode(202)
  @StrictRateLimit()
  @RequireRole('editor', orgBody)
  @ApiZodBody(FinalizeLibraryImportRequestSchema)
  @ApiZodResponse(202, LibraryImportViewSchema)
  @ApiErrors(400, 401, 403, 404, 409, 410, 413, 415, 429, 503)
  finalizeImport(
    @Param('importId') importId: string,
    @Body(zodPipe(FinalizeLibraryImportRequestSchema)) body: FinalizeLibraryImportRequest,
    @CurrentUser() user: AuthContext,
    @Req() req: Request,
  ): Promise<LibraryImportView> {
    return this.svc.finalizeImport(user, body.orgId, importId, traceparentFrom(req.headers.traceparent));
  }

  @Get('imports/:importId')
  @RequireRole('viewer', orgQuery)
  @ApiZodQuery(OrgScopeQuerySchema)
  @ApiZodResponse(200, LibraryImportViewSchema)
  @ApiErrors(400, 401, 404, 429)
  getImport(@Param('importId') importId: string, @Query(zodPipe(OrgScopeQuerySchema)) q: OrgScopeQuery, @CurrentUser() user: AuthContext): Promise<LibraryImportView> {
    return this.svc.getImport(user, q.orgId, importId);
  }
}

/** Sprint 3: BOQ templates (read: members; edit: admin). */
@ApiTags('library')
@ApiBearerAuth()
@Controller({ path: 'boq-templates', version: '1' })
export class TemplatesController {
  constructor(private readonly svc: LibraryService) {}

  /** Seeds the default template (from the sample BOQ) when the org has none. */
  @Get()
  @RequireRole('viewer', orgQuery)
  @ApiZodQuery(OrgScopeQuerySchema)
  @ApiZodResponse(200, BoqTemplateListSchema)
  @ApiErrors(400, 401, 404, 429)
  list(@Query(zodPipe(OrgScopeQuerySchema)) q: OrgScopeQuery, @CurrentUser() user: AuthContext): Promise<BoqTemplateList> {
    return this.svc.listTemplates(user, q.orgId);
  }

  @Patch(':templateId')
  @RequireRole('admin', orgQuery)
  @ApiZodQuery(OrgScopeQuerySchema)
  @ApiZodBody(PatchBoqTemplateRequestSchema)
  @ApiZodResponse(200, BoqTemplateSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  patch(
    @Param('templateId') templateId: string,
    @Query(zodPipe(OrgScopeQuerySchema)) q: OrgScopeQuery,
    @Body(zodPipe(PatchBoqTemplateRequestSchema)) body: PatchBoqTemplateRequest,
    @CurrentUser() user: AuthContext,
  ): Promise<BoqTemplate> {
    return this.svc.patchTemplate(user, q.orgId, templateId, body);
  }
}

/** Sprint 3: BOQ rules (read: members; toggle / priority / item: admin, audited, marks BOQs stale). */
@ApiTags('library')
@ApiBearerAuth()
@Controller({ path: 'boq-rules', version: '1' })
export class RulesController {
  constructor(private readonly svc: LibraryService) {}

  /** Seeds the default rule set when the org has none. */
  @Get()
  @RequireRole('viewer', orgQuery)
  @ApiZodQuery(OrgScopeQuerySchema)
  @ApiZodResponse(200, BoqRuleListSchema)
  @ApiErrors(400, 401, 404, 429)
  list(@Query(zodPipe(OrgScopeQuerySchema)) q: OrgScopeQuery, @CurrentUser() user: AuthContext): Promise<BoqRuleList> {
    return this.svc.listRules(user, q.orgId);
  }

  @Patch(':ruleId')
  @RequireRole('admin', orgQuery)
  @ApiZodQuery(OrgScopeQuerySchema)
  @ApiZodBody(PatchBoqRuleRequestSchema)
  @ApiZodResponse(200, BoqRuleSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  patch(
    @Param('ruleId') ruleId: string,
    @Query(zodPipe(OrgScopeQuerySchema)) q: OrgScopeQuery,
    @Body(zodPipe(PatchBoqRuleRequestSchema)) body: PatchBoqRuleRequest,
    @CurrentUser() user: AuthContext,
  ): Promise<BoqRule> {
    return this.svc.patchRule(user, q.orgId, ruleId, body);
  }
}
