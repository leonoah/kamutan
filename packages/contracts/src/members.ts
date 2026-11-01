/**
 * Stage 10 (A-API-01, SEC-07 "ניהול משתמשים", UX onboarding step 4 "הזמנת צוות"): minimal member management.
 *
 * Firestore (API-only writes; firestore.rules: members readable by members (own membership lookups), invites admin-only):
 *  - orgs/{orgId}/members/{uid}    Member (existing shape)
 *  - orgs/{orgId}/invites/{id}     Invite — a PENDING membership for an email address. It is claimed on the first
 *    sign-in of a user whose VERIFIED email equals `email` (GET /v1/me, GET /v1/orgs, or POST /v1/invites/:id/accept
 *    from the link the admin copies). No email is sent (no mail service yet): the admin copies `url`.
 * Every change is audited (`members/invite|update_role|remove`, `invites/revoke|accept`). Mutations need admin + MFA +
 * sign-in ≤ 10 min (same as org settings, SEC-02). The last admin cannot be demoted or removed.
 */
import { z } from 'zod';
import { TimestampSchema } from './common.js';
import { DocIdSchema, MemberSchema, UidSchema } from './org.js';
import { RoleSchema } from './roles.js';

/** Invitations expire after this many days (pending only). */
export const INVITE_TTL_DAYS = 14;
/** Max pending invitations per org (abuse cap). */
export const MAX_PENDING_INVITES = 100;

/** Lower-cased, trimmed email (the claim compares this with the token's verified email, lower-cased). */
export const InviteEmailSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .email()
  .transform((e) => e.toLowerCase());

export const INVITE_STATUSES = ['pending', 'accepted', 'revoked'] as const;
export const InviteStatusSchema = z.enum(INVITE_STATUSES);
export type InviteStatus = z.infer<typeof InviteStatusSchema>;

/** orgs/{orgId}/invites/{inviteId} (DTO: + id, orgId; `state` derives `expired` from expiresAt). */
export const InviteSchema = z.object({
  id: DocIdSchema,
  orgId: DocIdSchema,
  email: z.string().max(320),
  role: RoleSchema,
  status: InviteStatusSchema,
  /** pending + expiresAt in the past → `expired`; otherwise = status. */
  state: z.enum(['pending', 'accepted', 'revoked', 'expired']),
  invitedBy: UidSchema,
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  acceptedBy: UidSchema.nullable().optional(),
  acceptedAt: TimestampSchema.nullable().optional(),
  revokedBy: UidSchema.nullable().optional(),
  revokedAt: TimestampSchema.nullable().optional(),
});
export type Invite = z.infer<typeof InviteSchema>;

/** POST /v1/orgs/:orgId/invites (admin + MFA + recent sign-in). */
export const CreateInviteRequestSchema = z.object({ email: InviteEmailSchema, role: RoleSchema }).strict();
export type CreateInviteRequest = z.infer<typeof CreateInviteRequestSchema>;

/** `url` = `${PUBLIC_APP_ORIGIN}/invite/{inviteId}` — the admin copies it (no email service yet). */
export const CreateInviteResponseSchema = z.object({ invite: InviteSchema, url: z.string().max(2048) });
export type CreateInviteResponse = z.infer<typeof CreateInviteResponseSchema>;

/** GET /v1/orgs/:orgId/invites (admin): newest first, every state. */
export const InviteListSchema = z.object({ items: z.array(InviteSchema) });
export type InviteList = z.infer<typeof InviteListSchema>;

export const RevokeInviteResponseSchema = z.object({ invite: InviteSchema });
export type RevokeInviteResponse = z.infer<typeof RevokeInviteResponseSchema>;

/** POST /v1/invites/:inviteId/accept (any signed-in user whose verified email matches) → the new membership. */
export const AcceptInviteResponseSchema = z.object({ orgId: DocIdSchema, role: RoleSchema, alreadyMember: z.boolean() });
export type AcceptInviteResponse = z.infer<typeof AcceptInviteResponseSchema>;

/** A member as listed to the org admin. */
export const MemberViewSchema = MemberSchema.extend({ isSelf: z.boolean() });
export type MemberView = z.infer<typeof MemberViewSchema>;

/** GET /v1/orgs/:orgId/members (admin): sorted by role (admin first), then name/email. */
export const MemberListSchema = z.object({ items: z.array(MemberViewSchema) });
export type MemberList = z.infer<typeof MemberListSchema>;

/** PATCH /v1/orgs/:orgId/members/:uid (admin + MFA + recent sign-in). */
export const PatchMemberRequestSchema = z.object({ role: RoleSchema }).strict();
export type PatchMemberRequest = z.infer<typeof PatchMemberRequestSchema>;

export const MemberResponseSchema = z.object({ member: MemberViewSchema });
export type MemberResponse = z.infer<typeof MemberResponseSchema>;

/** DELETE /v1/orgs/:orgId/members/:uid (admin + MFA + recent sign-in). */
export const RemoveMemberResponseSchema = z.object({ uid: UidSchema, removed: z.literal(true) });
export type RemoveMemberResponse = z.infer<typeof RemoveMemberResponseSchema>;

/** Seconds since the last sign-in allowed for admin settings / member / template / rule changes (SEC-02, A-API-02). */
export const ADMIN_RECENT_AUTH_SECONDS = 600;
