import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  AcceptInviteResponseSchema,
  CreateInviteRequestSchema,
  CreateInviteResponseSchema,
  InviteListSchema,
  MemberListSchema,
  MemberResponseSchema,
  PatchMemberRequestSchema,
  RemoveMemberResponseSchema,
  RevokeInviteResponseSchema,
  type AcceptInviteResponse,
  type CreateInviteRequest,
  type CreateInviteResponse,
  type InviteList,
  type MemberList,
  type MemberResponse,
  type PatchMemberRequest,
  type RemoveMemberResponse,
  type RevokeInviteResponse,
} from '@kamutan/contracts';
import type { AuthContext } from '../auth/auth-context';
import { CurrentUser, RequireRole } from '../auth/decorators';
import { StrictRateLimit } from '../auth/user-throttler.guard';
import { ApiErrors, ApiZodBody, ApiZodResponse } from '../common/zod-openapi';
import { zodPipe } from '../common/zod-validation.pipe';
import { MembersService } from './members.service';

const org = { from: 'param', key: 'orgId' } as const;

/** Stage 10 (A-API-01): org members + invitations. Admin only; mutations need MFA + a sign-in ≤ 10 min. Audited. */
@ApiTags('members')
@ApiBearerAuth()
@Controller({ path: 'orgs/:orgId', version: '1' })
export class OrgMembersController {
  constructor(private readonly svc: MembersService) {}

  @Get('members')
  @RequireRole('admin', org)
  @ApiZodResponse(200, MemberListSchema)
  @ApiErrors(401, 403, 404, 429)
  list(@Param('orgId') orgId: string, @CurrentUser() user: AuthContext): Promise<MemberList> {
    return this.svc.list(user, orgId);
  }

  @Patch('members/:uid')
  @RequireRole('admin', org)
  @ApiZodBody(PatchMemberRequestSchema)
  @ApiZodResponse(200, MemberResponseSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  setRole(@Param('orgId') orgId: string, @Param('uid') uid: string, @Body(zodPipe(PatchMemberRequestSchema)) body: PatchMemberRequest, @CurrentUser() user: AuthContext): Promise<MemberResponse> {
    return this.svc.setRole(user, orgId, uid, body);
  }

  @Delete('members/:uid')
  @RequireRole('admin', org)
  @ApiZodResponse(200, RemoveMemberResponseSchema)
  @ApiErrors(401, 403, 404, 409, 429)
  remove(@Param('orgId') orgId: string, @Param('uid') uid: string, @CurrentUser() user: AuthContext): Promise<RemoveMemberResponse> {
    return this.svc.remove(user, orgId, uid);
  }

  /** Pending membership for an email + the link to copy (no email is sent). */
  @Post('invites')
  @RequireRole('admin', org)
  @ApiZodBody(CreateInviteRequestSchema)
  @ApiZodResponse(201, CreateInviteResponseSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  invite(@Param('orgId') orgId: string, @Body(zodPipe(CreateInviteRequestSchema)) body: CreateInviteRequest, @CurrentUser() user: AuthContext): Promise<CreateInviteResponse> {
    return this.svc.invite(user, orgId, body);
  }

  @Get('invites')
  @RequireRole('admin', org)
  @ApiZodResponse(200, InviteListSchema)
  @ApiErrors(401, 403, 404, 429)
  listInvites(@Param('orgId') orgId: string, @CurrentUser() user: AuthContext): Promise<InviteList> {
    return this.svc.listInvites(user, orgId);
  }

  @Delete('invites/:inviteId')
  @RequireRole('admin', org)
  @ApiZodResponse(200, RevokeInviteResponseSchema)
  @ApiErrors(401, 403, 404, 429)
  revokeInvite(@Param('orgId') orgId: string, @Param('inviteId') inviteId: string, @CurrentUser() user: AuthContext): Promise<RevokeInviteResponse> {
    return this.svc.revokeInvite(user, orgId, inviteId);
  }
}

/** The invite link: any signed-in user whose VERIFIED email matches the invite joins with its role. */
@ApiTags('members')
@ApiBearerAuth()
@Controller({ path: 'invites', version: '1' })
export class InvitesController {
  constructor(private readonly svc: MembersService) {}

  @Post(':inviteId/accept')
  @HttpCode(200)
  @StrictRateLimit()
  @ApiZodResponse(200, AcceptInviteResponseSchema)
  @ApiErrors(401, 404, 429)
  accept(@Param('inviteId') inviteId: string, @CurrentUser() user: AuthContext): Promise<AcceptInviteResponse> {
    return this.svc.accept(user, inviteId);
  }
}
