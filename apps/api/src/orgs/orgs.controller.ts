import { Body, Controller, Get, Param, Post } from '@nestjs/common';
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
import type { AuthContext } from '../auth/auth-context';
import { CurrentUser, RequireRole } from '../auth/decorators';
import { ApiErrors, ApiZodBody, ApiZodResponse } from '../common/zod-openapi';
import { zodPipe } from '../common/zod-validation.pipe';
import { OrgsService } from './orgs.service';

@ApiTags('orgs')
@ApiBearerAuth()
@Controller({ version: '1' })
export class OrgsController {
  constructor(private readonly orgs: OrgsService) {}

  @Get('me')
  @ApiZodResponse(200, MeResponseSchema)
  @ApiErrors(401)
  me(@CurrentUser() user: AuthContext): Promise<MeResponse> {
    return this.orgs.me(user);
  }

  @Get('orgs')
  @ApiZodResponse(200, z.object({ items: z.array(MyOrgSchema) }))
  @ApiErrors(401)
  async list(@CurrentUser() user: AuthContext): Promise<{ items: MyOrg[] }> {
    return { items: await this.orgs.myOrgs(user) };
  }

  @Post('orgs')
  @ApiZodBody(CreateOrgRequestSchema)
  @ApiZodResponse(201, OrgSchema)
  @ApiErrors(400, 401, 429)
  create(@CurrentUser() user: AuthContext, @Body(zodPipe(CreateOrgRequestSchema)) body: CreateOrgRequest): Promise<Org> {
    return this.orgs.create(user, body.name);
  }

  @Get('orgs/:orgId')
  @RequireRole('viewer', { from: 'param', key: 'orgId' })
  @ApiZodResponse(200, MyOrgSchema)
  @ApiErrors(401, 404)
  get(@Param('orgId') orgId: string, @CurrentUser() user: AuthContext): Promise<MyOrg> {
    return this.orgs.get(user, orgId);
  }
}
