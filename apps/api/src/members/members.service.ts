import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  DocIdSchema,
  INVITE_TTL_DAYS,
  MAX_PENDING_INVITES,
  ROLE_RANK,
  UidSchema,
  type AcceptInviteResponse,
  type CreateInviteRequest,
  type CreateInviteResponse,
  type InviteList,
  type Member,
  type MemberList,
  type MemberResponse,
  type MemberView,
  type PatchMemberRequest,
  type RemoveMemberResponse,
  type RevokeInviteResponse,
} from '@kamutan/contracts';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth-context';
import { ApiException, notFound } from '../common/api-exception';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { LastAdminError, MEMBERS_REPOSITORY, TooManyInvitesError, type MembersRepository } from '../db/members-repository';

const DAY_MS = 86_400_000;
const validId = (s: string) => DocIdSchema.safeParse(s).success;

/** Verified, lower-cased email of the caller (claims of the verified ID token), or null. */
export function verifiedEmailOf(user: AuthContext): string | null {
  const c = user.claims as { email?: unknown; email_verified?: unknown };
  return typeof c.email === 'string' && c.email_verified === true ? c.email.trim().toLowerCase() : null;
}

/**
 * Stage 10 (A-API-01, SEC-07 "ניהול משתמשים" = admin only): list members, invite by email (pending membership
 * claimed on the first sign-in with that VERIFIED email — no mail is sent, the admin copies the link), change a role,
 * remove a member. Mutations: admin + MFA + sign-in ≤ 10 min (SEC-02, like org settings). The last admin stays.
 */
@Injectable()
export class MembersService {
  private readonly logger = new Logger('MembersService');

  constructor(
    private readonly access: AccessService,
    @Inject(MEMBERS_REPOSITORY) private readonly members: MembersRepository,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private sensitive(user: AuthContext, orgId: string) {
    return this.access.requireSensitiveAdmin(user, orgId, this.cfg.OFFBOARDING_REQUIRE_MFA);
  }

  private view(user: AuthContext, m: Member): MemberView {
    return { ...m, isSelf: m.uid === user.uid };
  }

  async list(user: AuthContext, orgId: string): Promise<MemberList> {
    await this.access.requireRole(user, orgId, 'admin');
    const items = (await this.members.listMembers(orgId))
      .map((m) => this.view(user, m))
      .sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role] || (a.displayName ?? a.email ?? a.uid).localeCompare(b.displayName ?? b.email ?? b.uid));
    return { items };
  }

  async invite(user: AuthContext, orgId: string, req: CreateInviteRequest): Promise<CreateInviteResponse> {
    await this.sensitive(user, orgId);
    try {
      const invite = await this.members.createInvite(orgId, { email: req.email, role: req.role, expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * DAY_MS), maxPending: MAX_PENDING_INVITES }, user.uid);
      return { invite, url: `${this.cfg.PUBLIC_APP_ORIGIN.replace(/\/+$/, '')}/invite/${invite.id}` };
    } catch (err) {
      if (err instanceof TooManyInvitesError) throw new ApiException(HttpStatus.CONFLICT, 'conflict', `at most ${MAX_PENDING_INVITES} pending invitations per organization`);
      throw err;
    }
  }

  async listInvites(user: AuthContext, orgId: string): Promise<InviteList> {
    await this.access.requireRole(user, orgId, 'admin');
    return { items: await this.members.listInvites(orgId) };
  }

  async revokeInvite(user: AuthContext, orgId: string, inviteId: string): Promise<RevokeInviteResponse> {
    await this.sensitive(user, orgId);
    if (!validId(inviteId)) throw notFound('invite');
    const invite = await this.members.revokeInvite(orgId, inviteId, user.uid);
    if (!invite) throw notFound('invite');
    return { invite };
  }

  async setRole(user: AuthContext, orgId: string, uid: string, req: PatchMemberRequest): Promise<MemberResponse> {
    await this.sensitive(user, orgId);
    if (!UidSchema.safeParse(uid).success) throw notFound('member');
    try {
      const r = await this.members.setMemberRole(orgId, uid, req.role, user.uid);
      if (!r) throw notFound('member');
      return { member: this.view(user, r.member) };
    } catch (err) {
      throw this.mapLastAdmin(err);
    }
  }

  async remove(user: AuthContext, orgId: string, uid: string): Promise<RemoveMemberResponse> {
    await this.sensitive(user, orgId);
    if (!UidSchema.safeParse(uid).success) throw notFound('member');
    try {
      if (!(await this.members.removeMember(orgId, uid, user.uid))) throw notFound('member');
      return { uid, removed: true };
    } catch (err) {
      throw this.mapLastAdmin(err);
    }
  }

  private mapLastAdmin(err: unknown): unknown {
    return err instanceof LastAdminError ? new ApiException(HttpStatus.CONFLICT, 'conflict', 'the organization must keep at least one admin', [{ path: 'role', message: 'last_admin' }]) : err;
  }

  /**
   * POST /invites/:id/accept — the link the admin copied. The invite id alone grants nothing: the caller's VERIFIED
   * email must equal the invite's. Unknown / foreign / used / expired / revoked → the same 404 (no oracle).
   */
  async accept(user: AuthContext, inviteId: string): Promise<AcceptInviteResponse> {
    const email = verifiedEmailOf(user);
    if (!email || !validId(inviteId)) throw notFound('invite');
    const hit = (await this.members.findInvites(email)).find((p) => p.inviteId === inviteId);
    if (!hit) throw notFound('invite');
    if (hit.status === 'pending') {
      const r = await this.members.claimInvite(hit.orgId, hit.inviteId, { uid: user.uid, email, ...(typeof user.claims.name === 'string' ? { displayName: user.claims.name } : {}) }, new Date());
      if (r) return { orgId: r.orgId, role: r.role, alreadyMember: r.alreadyMember };
    } else if (hit.status === 'accepted' && hit.acceptedBy === user.uid) {
      // The link opened after the sign-in already claimed it (GET /me): idempotent answer, while still a member.
      const role = await this.access.roleIn(user, hit.orgId);
      if (role && !(await this.access.isOffboarding(user, hit.orgId))) return { orgId: hit.orgId, role, alreadyMember: true };
    }
    throw notFound('invite');
  }

  /** First sign-in claim (GET /me, GET /orgs): every pending invite for the caller's verified email. Best effort. */
  async claimPending(user: AuthContext): Promise<number> {
    const email = verifiedEmailOf(user);
    if (!email) return 0;
    let n = 0;
    try {
      for (const p of (await this.members.findInvites(email)).filter((x) => x.status === 'pending')) {
        const r = await this.members.claimInvite(p.orgId, p.inviteId, { uid: user.uid, email, ...(typeof user.claims.name === 'string' ? { displayName: user.claims.name } : {}) }, new Date());
        if (r && !r.alreadyMember) n++;
      }
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, uid: user.uid }, 'invite claim failed');
    }
    return n;
  }
}
