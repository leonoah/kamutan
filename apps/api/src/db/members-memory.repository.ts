import { fsPaths, type Invite, type Member, type Role } from '@kamutan/contracts';
import { autoId, type InMemoryRepository } from './in-memory.repository';
import { toMember, type Doc } from './mappers';
import { isPendingValid, LastAdminError, MAX_INVITES, MAX_MEMBERS, toInvite, TooManyInvitesError, type ClaimResult, type MembersRepository } from './members-repository';

const idOf = (path: string) => path.split('/').at(-1) as string;

/** In-memory members / invites (shares the core store + audit chain). */
export class InMemoryMembersRepository implements MembersRepository {
  constructor(private readonly core: InMemoryRepository) {}

  private get docs() {
    return this.core.docs;
  }

  async listMembers(orgId: string): Promise<Member[]> {
    return this.core
      .children(fsPaths.members(orgId))
      .slice(0, MAX_MEMBERS)
      .map(([, d]) => toMember(d));
  }

  createInvite(orgId: string, input: { email: string; role: Role; expiresAt: Date; maxPending: number }, actorUid: string): Promise<Invite> {
    return this.core.tx(() => {
      const now = this.core.now();
      const all = this.core.children(fsPaths.invites(orgId));
      const same = all.find(([, d]) => d.email === input.email && isPendingValid(d, now));
      if (!same && all.filter(([, d]) => isPendingValid(d, now)).length >= input.maxPending) throw new TooManyInvitesError();
      const id = same ? idOf(same[0]) : autoId();
      const doc: Doc = same
        ? { ...same[1], role: input.role, expiresAt: input.expiresAt, invitedBy: actorUid }
        : { email: input.email, role: input.role, status: 'pending', invitedBy: actorUid, createdAt: now, expiresAt: input.expiresAt, acceptedBy: null, acceptedAt: null, revokedBy: null, revokedAt: null };
      this.docs.set(fsPaths.invite(orgId, id), doc);
      this.core.appendAuditSync(orgId, { actorId: actorUid, entity: 'members', entityId: id, action: 'invite', after: { inviteId: id, email: input.email, role: input.role, renewed: !!same } });
      return toInvite(orgId, id, doc, now);
    });
  }

  async listInvites(orgId: string): Promise<Invite[]> {
    const now = new Date();
    return this.core
      .children(fsPaths.invites(orgId))
      .slice(0, MAX_INVITES)
      .map(([k, d]) => toInvite(orgId, idOf(k), d, now))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  async getInvite(orgId: string, inviteId: string): Promise<Invite | null> {
    const d = this.docs.get(fsPaths.invite(orgId, inviteId));
    return d ? toInvite(orgId, inviteId, d) : null;
  }

  revokeInvite(orgId: string, inviteId: string, actorUid: string): Promise<Invite | null> {
    return this.core.tx(() => {
      const p = fsPaths.invite(orgId, inviteId);
      const d = this.docs.get(p);
      if (!d) return null;
      if (d.status !== 'pending') return toInvite(orgId, inviteId, d);
      const next = { ...d, status: 'revoked', revokedBy: actorUid, revokedAt: this.core.now() };
      this.docs.set(p, next);
      this.core.appendAuditSync(orgId, { actorId: actorUid, entity: 'invites', entityId: inviteId, action: 'revoke', after: { email: d.email, role: d.role } });
      return toInvite(orgId, inviteId, next);
    });
  }

  async findInvites(email: string) {
    return [...this.docs.entries()]
      .filter(([k, d]) => k.split('/').at(-2) === 'invites' && d.email === email)
      .slice(0, 50)
      .map(([k, d]) => ({ orgId: k.split('/')[1] as string, inviteId: idOf(k), status: String(d.status), acceptedBy: typeof d.acceptedBy === 'string' ? d.acceptedBy : null }));
  }

  claimInvite(orgId: string, inviteId: string, user: { uid: string; email: string; displayName?: string }, now: Date): Promise<ClaimResult | null> {
    return this.core.tx(() => {
      const p = fsPaths.invite(orgId, inviteId);
      const d = this.docs.get(p);
      const org = this.docs.get(fsPaths.org(orgId));
      if (!isPendingValid(d, now) || d?.email !== user.email || !org || org.status === 'offboarding') return null;
      const memberPath = fsPaths.member(orgId, user.uid);
      const existing = this.docs.get(memberPath);
      const role = (existing?.role ?? d.role) as Role;
      if (!existing) {
        this.docs.set(memberPath, { uid: user.uid, role: d.role, email: user.email, ...(user.displayName ? { displayName: user.displayName.slice(0, 200) } : {}), addedBy: d.invitedBy, createdAt: this.core.now() });
      }
      this.docs.set(p, { ...d, status: 'accepted', acceptedBy: user.uid, acceptedAt: this.core.now() });
      this.core.appendAuditSync(orgId, { actorId: user.uid, entity: 'invites', entityId: inviteId, action: 'accept', after: { email: user.email, role, alreadyMember: !!existing } });
      return { orgId, inviteId, role, alreadyMember: !!existing };
    });
  }

  private admins(orgId: string): number {
    return this.core.children(fsPaths.members(orgId)).filter(([, d]) => d.role === 'admin').length;
  }

  setMemberRole(orgId: string, uid: string, role: Role, actorUid: string): Promise<{ member: Member; changed: boolean } | null> {
    return this.core.tx(() => {
      const p = fsPaths.member(orgId, uid);
      const d = this.docs.get(p);
      if (!d) return null;
      if (d.role === role) return { member: toMember(d), changed: false };
      if (d.role === 'admin' && this.admins(orgId) <= 1) throw new LastAdminError();
      const next = { ...d, role, updatedAt: this.core.now(), updatedBy: actorUid };
      this.docs.set(p, next);
      this.core.appendAuditSync(orgId, { actorId: actorUid, entity: 'members', entityId: uid, action: 'update_role', after: { uid, from: d.role, to: role } });
      return { member: toMember(next), changed: true };
    });
  }

  removeMember(orgId: string, uid: string, actorUid: string): Promise<boolean> {
    return this.core.tx(() => {
      const p = fsPaths.member(orgId, uid);
      const d = this.docs.get(p);
      if (!d) return false;
      if (d.role === 'admin' && this.admins(orgId) <= 1) throw new LastAdminError();
      this.docs.delete(p);
      this.core.appendAuditSync(orgId, { actorId: actorUid, entity: 'members', entityId: uid, action: 'remove', after: { uid, role: d.role } });
      return true;
    });
  }
}
