import { fsPaths, type Invite, type Member, type Role } from '@kamutan/contracts';
import { Timestamp, type DocumentData } from 'firebase-admin/firestore';
import type { FirestoreRepository } from './firestore.repository';
import { mappers, type Doc } from './mappers';
import { isPendingValid, LastAdminError, MAX_INVITES, MAX_MEMBERS, toInvite, TooManyInvitesError, type ClaimResult, type MembersRepository } from './members-repository';

function plain(d: DocumentData | undefined): Doc | null {
  if (!d) return null;
  const out: Doc = {};
  for (const [k, v] of Object.entries(d)) out[k] = v instanceof Timestamp ? v.toDate() : v;
  return out;
}

/**
 * Firestore members / invites (Stage 10, A-API-01). Queries: members `role == admin` (single-field index), invites of
 * an org (whole collection, ≤ MAX_INVITES), collection group `invites` where `email ==` (collection-group field
 * override in firebase/firestore.indexes.json).
 */
export class FirestoreMembersRepository implements MembersRepository {
  constructor(private readonly core: FirestoreRepository) {}

  private get db() {
    return this.core.db;
  }

  async listMembers(orgId: string): Promise<Member[]> {
    const snap = await this.db.collection(fsPaths.members(orgId)).limit(MAX_MEMBERS).get();
    return snap.docs.map((d) => mappers.toMember(plain(d.data()) as Doc));
  }

  async createInvite(orgId: string, input: { email: string; role: Role; expiresAt: Date; maxPending: number }, actorUid: string): Promise<Invite> {
    return this.db.runTransaction(async (tx) => {
      const head = await this.core.auditHead(tx, orgId);
      const pending = await tx.get(this.db.collection(fsPaths.invites(orgId)).where('status', '==', 'pending').limit(MAX_INVITES));
      const now = new Date();
      const valid = pending.docs.filter((d) => isPendingValid(plain(d.data()) ?? undefined, now));
      const same = valid.find((d) => d.get('email') === input.email);
      if (!same && valid.length >= input.maxPending) throw new TooManyInvitesError();
      const ref = same ? same.ref : this.db.collection(fsPaths.invites(orgId)).doc();
      const doc: Doc = same
        ? { ...(plain(same.data()) as Doc), role: input.role, expiresAt: Timestamp.fromDate(input.expiresAt), invitedBy: actorUid }
        : { email: input.email, role: input.role, status: 'pending', invitedBy: actorUid, createdAt: Timestamp.now(), expiresAt: Timestamp.fromDate(input.expiresAt), acceptedBy: null, acceptedAt: null, revokedBy: null, revokedAt: null };
      if (same) tx.update(ref, { role: input.role, expiresAt: Timestamp.fromDate(input.expiresAt), invitedBy: actorUid });
      else tx.create(ref, doc);
      this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'members', entityId: ref.id, action: 'invite', after: { inviteId: ref.id, email: input.email, role: input.role, renewed: !!same } });
      return toInvite(orgId, ref.id, plain(doc) as Doc, now);
    });
  }

  async listInvites(orgId: string): Promise<Invite[]> {
    const snap = await this.db.collection(fsPaths.invites(orgId)).limit(MAX_INVITES).get();
    const now = new Date();
    return snap.docs.map((d) => toInvite(orgId, d.id, plain(d.data()) as Doc, now)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  async getInvite(orgId: string, inviteId: string): Promise<Invite | null> {
    const d = plain((await this.db.doc(fsPaths.invite(orgId, inviteId)).get()).data());
    return d ? toInvite(orgId, inviteId, d) : null;
  }

  async revokeInvite(orgId: string, inviteId: string, actorUid: string): Promise<Invite | null> {
    const ref = this.db.doc(fsPaths.invite(orgId, inviteId));
    return this.db.runTransaction(async (tx) => {
      const head = await this.core.auditHead(tx, orgId);
      const snap = await tx.get(ref);
      const d = plain(snap.data());
      if (!d) return null;
      if (d.status !== 'pending') return toInvite(orgId, inviteId, d);
      const patch = { status: 'revoked', revokedBy: actorUid, revokedAt: Timestamp.now() };
      tx.update(ref, patch);
      this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'invites', entityId: inviteId, action: 'revoke', after: { email: d.email, role: d.role } });
      return toInvite(orgId, inviteId, { ...d, ...patch, revokedAt: patch.revokedAt.toDate() });
    });
  }

  async findInvites(email: string) {
    const snap = await this.db.collectionGroup('invites').where('email', '==', email).limit(50).get();
    return snap.docs
      .map((d) => ({ orgId: d.ref.parent.parent?.id as string, inviteId: d.id, status: String(d.get('status')), acceptedBy: typeof d.get('acceptedBy') === 'string' ? (d.get('acceptedBy') as string) : null }))
      .filter((x) => !!x.orgId);
  }

  async claimInvite(orgId: string, inviteId: string, user: { uid: string; email: string; displayName?: string }, now: Date): Promise<ClaimResult | null> {
    const ref = this.db.doc(fsPaths.invite(orgId, inviteId));
    const memberRef = this.db.doc(fsPaths.member(orgId, user.uid));
    const orgRef = this.db.doc(fsPaths.org(orgId));
    return this.db.runTransaction(async (tx) => {
      const head = await this.core.auditHead(tx, orgId);
      const [inv, mem, org] = await tx.getAll(ref, memberRef, orgRef);
      const d = plain(inv?.data());
      if (!d || !isPendingValid(d, now) || d.email !== user.email || !org?.exists || org.get('status') === 'offboarding') return null;
      const existing = plain(mem?.data());
      const role = (existing?.role ?? d.role) as Role;
      if (!existing) {
        tx.create(memberRef, { uid: user.uid, role: d.role, email: user.email, ...(user.displayName ? { displayName: user.displayName.slice(0, 200) } : {}), addedBy: d.invitedBy, createdAt: Timestamp.now() });
      }
      tx.update(ref, { status: 'accepted', acceptedBy: user.uid, acceptedAt: Timestamp.now() });
      this.core.writeAudit(tx, orgId, head, { actorId: user.uid, entity: 'invites', entityId: inviteId, action: 'accept', after: { email: user.email, role, alreadyMember: !!existing } });
      return { orgId, inviteId, role, alreadyMember: !!existing };
    });
  }

  async setMemberRole(orgId: string, uid: string, role: Role, actorUid: string): Promise<{ member: Member; changed: boolean } | null> {
    const ref = this.db.doc(fsPaths.member(orgId, uid));
    return this.db.runTransaction(async (tx) => {
      const head = await this.core.auditHead(tx, orgId);
      const snap = await tx.get(ref);
      const d = plain(snap.data());
      if (!d) return null;
      if (d.role === role) return { member: mappers.toMember(d), changed: false };
      if (d.role === 'admin') {
        const admins = await tx.get(this.db.collection(fsPaths.members(orgId)).where('role', '==', 'admin').limit(2));
        if (admins.size <= 1) throw new LastAdminError();
      }
      tx.update(ref, { role, updatedAt: Timestamp.now(), updatedBy: actorUid });
      this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'members', entityId: uid, action: 'update_role', after: { uid, from: d.role, to: role } });
      return { member: mappers.toMember({ ...d, role }), changed: true };
    });
  }

  async removeMember(orgId: string, uid: string, actorUid: string): Promise<boolean> {
    const ref = this.db.doc(fsPaths.member(orgId, uid));
    return this.db.runTransaction(async (tx) => {
      const head = await this.core.auditHead(tx, orgId);
      const snap = await tx.get(ref);
      const d = plain(snap.data());
      if (!d) return false;
      if (d.role === 'admin') {
        const admins = await tx.get(this.db.collection(fsPaths.members(orgId)).where('role', '==', 'admin').limit(2));
        if (admins.size <= 1) throw new LastAdminError();
      }
      tx.delete(ref);
      this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'members', entityId: uid, action: 'remove', after: { uid, role: d.role } });
      return true;
    });
  }
}
