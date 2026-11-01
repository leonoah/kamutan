import type { Invite, Member, Role } from '@kamutan/contracts';
import { anyIso, type Doc } from './mappers';

export const MEMBERS_REPOSITORY = Symbol('MEMBERS_REPOSITORY');

/** Hard cap of members read per org. */
export const MAX_MEMBERS = 1000;
/** Hard cap of invites read per org. */
export const MAX_INVITES = 1000;

/** Thrown when a change would leave the org without an admin (→ 409). */
export class LastAdminError extends Error {
  constructor() {
    super('last_admin');
  }
}

/** Thrown when an org already has the maximum number of pending invitations (→ 409). */
export class TooManyInvitesError extends Error {
  constructor() {
    super('too_many_invites');
  }
}

export interface ClaimResult {
  orgId: string;
  inviteId: string;
  role: Role;
  alreadyMember: boolean;
}

/**
 * Stage 10 (A-API-01) data access for org members + invitations. Same contract as the other repositories: NO
 * authorization here (the service authorized the org first, or — for claims — matched the verified email); every
 * path is under orgs/{orgId}/…; every mutation appends to the org's audit chain in the same transaction.
 */
export interface MembersRepository {
  listMembers(orgId: string): Promise<Member[]>;
  /**
   * Transaction: a pending, unexpired invite for the same email is re-used (role / expiry refreshed); otherwise a new
   * invite. TooManyInvitesError above `maxPending`. Audit `members/invite {email, role, inviteId}`.
   */
  createInvite(orgId: string, input: { email: string; role: Role; expiresAt: Date; maxPending: number }, actorUid: string): Promise<Invite>;
  listInvites(orgId: string): Promise<Invite[]>;
  getInvite(orgId: string, inviteId: string): Promise<Invite | null>;
  /** Transaction: pending → revoked (no-op when not pending). Audit `invites/revoke`. null when absent. */
  revokeInvite(orgId: string, inviteId: string, actorUid: string): Promise<Invite | null>;
  /** Collection-group lookup (`email ==`, ≤ 50): invites addressed to this (lower-case) email, any org, any status. */
  findInvites(email: string): Promise<Array<{ orgId: string; inviteId: string; status: string; acceptedBy: string | null }>>;
  /**
   * Transaction: re-reads the invite; when still pending, unexpired and addressed to `email` → creates the member doc
   * (unless the user already is a member: role unchanged) + marks it accepted + audit `invites/accept`. null otherwise.
   */
  claimInvite(orgId: string, inviteId: string, user: { uid: string; email: string; displayName?: string }, now: Date): Promise<ClaimResult | null>;
  /** Transaction: role change (LastAdminError when demoting the last admin). Audit `members/update_role`. null when absent. */
  setMemberRole(orgId: string, uid: string, role: Role, actorUid: string): Promise<{ member: Member; changed: boolean } | null>;
  /** Transaction: delete the member doc (LastAdminError for the last admin). Audit `members/remove`. false when absent. */
  removeMember(orgId: string, uid: string, actorUid: string): Promise<boolean>;
}

/** Stored invite doc → DTO (`state` derives `expired`). */
export function toInvite(orgId: string, id: string, d: Doc, now = new Date()): Invite {
  const status = d.status === 'accepted' || d.status === 'revoked' ? d.status : 'pending';
  const expiresAt = anyIso(d.expiresAt) ?? new Date(0).toISOString();
  const state = status === 'pending' && Date.parse(expiresAt) <= now.getTime() ? 'expired' : status;
  const s = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    id,
    orgId,
    email: String(d.email ?? ''),
    role: (['admin', 'editor', 'reviewer', 'viewer'].includes(String(d.role)) ? d.role : 'viewer') as Role,
    status,
    state,
    invitedBy: String(d.invitedBy ?? ''),
    createdAt: anyIso(d.createdAt) ?? new Date(0).toISOString(),
    expiresAt,
    acceptedBy: s(d.acceptedBy),
    acceptedAt: anyIso(d.acceptedAt),
    revokedBy: s(d.revokedBy),
    revokedAt: anyIso(d.revokedAt),
  };
}

export const isPendingValid = (d: Doc | undefined, now: Date): boolean => {
  if (!d || d.status !== 'pending') return false;
  const exp = anyIso(d.expiresAt);
  return !!exp && Date.parse(exp) > now.getTime();
};
