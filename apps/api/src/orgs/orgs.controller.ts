import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CreateOrgRequestSchema,
  MeResponseSchema,
  MyOrgSchema,
  OrgSchema,
  type CreateOrgRequest,
  type MeResponse,
  type MyOrg,
  type Org,
} from '@kamutan/contracts';
import { z } from 'zod';
import type { AuthContext, OrgAccess } from '../auth/auth-context';
import { CurrentOrgAccess, CurrentUser, RequireRole } from '../auth/decorators';
import { notFound } from '../common/api-exception';
import { ApiErrors, ApiZodBody, ApiZodResponse } from '../common/zod-openapi';
import { zodPipe } from '../common/zod-validation.pipe';
import { REPOSITORY, type Repository } from '../db/repository';

@ApiTags('orgs')
@ApiBearerAuth()
@Controller({ version: '1' })
export class OrgsController {
  constructor(@Inject(REPOSITORY) private readonly repo: Repository) {}

  @Get('me')
  @ApiZodResponse(200, MeResponseSchema)
  @ApiErrors(401)
  async me(@CurrentUser() user: AuthContext): Promise<MeResponse> {
    const orgs = await this.repo.run(user, (tx) => tx.listMyOrgs());
    return { userId: user.userId, aal: user.aal, orgs };
  }

  @Get('orgs')
  @ApiZodResponse(200, z.object({ items: z.array(MyOrgSchema) }))
  @ApiErrors(401)
  async list(@CurrentUser() user: AuthContext): Promise<{ items: MyOrg[] }> {
    return { items: await this.repo.run(user, (tx) => tx.listMyOrgs()) };
  }

  /** Any authenticated user may create an org and becomes its admin. */
  @Post('orgs')
  @ApiZodBody(CreateOrgRequestSchema)
  @ApiZodResponse(201, OrgSchema)
  @ApiErrors(400, 401, 409, 429)
  create(
    @CurrentUser() user: AuthContext,
    @Body(zodPipe(CreateOrgRequestSchema)) body: CreateOrgRequest,
  ): Promise<Org> {
    return this.repo.run(user, (tx) => tx.createOrg(body.name, body.slug));
  }

  @Get('orgs/:orgId')
  @RequireRole('viewer', { from: 'param', key: 'orgId' })
  @ApiZodResponse(200, MyOrgSchema)
  @ApiErrors(401, 404)
  async get(
    @Param('orgId', new ParseUUIDPipe()) orgId: string,
    @CurrentUser() user: AuthContext,
    @CurrentOrgAccess() access: OrgAccess,
  ): Promise<MyOrg> {
    const org = await this.repo.run(user, (tx) => tx.getOrg(orgId));
    if (!org) throw notFound('org');
    return { ...org, role: access.role };
  }
}
