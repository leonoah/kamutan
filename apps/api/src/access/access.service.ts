import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { DocIdSchema, roleSatisfies, type Role } from '@kamutan/contracts';
import type { AuthContext, OrgAccess } from '../auth/auth-context';
import { ApiException, forbidden, notFound } from '../common/api-exception';
import { REPOSITORY, type Repository } from '../db/repository';

/** Per-principal cache of memberships for the lifetime of one request. */
const roleCache = new WeakMap<AuthContext, Map<string, Role | null>>();
/** Per-principal cache of "org is offboarding" for the lifetime of one request. */
const offboardingCache = new WeakMap<AuthContext, Map<string, boolean>>();

export interface AccessOpts {
  requireMfa?: boolean;
  /** Sprint 5 (SEC-52): allow the call while the org is offboarding (org read, offboarding export status/download). */
  allowOffboarding?: boolean;
}

/**
 * Tenant authorization for the service layer. firebase-admin bypasses
 * Security Rules, so **every** service method that touches org data calls
 * this first (SEC-08/09/10). Membership comes from orgs/{orgId}/members/{uid}
 * (Firestore, authoritative), never from token claims.
 * - not a member (or invalid id) → 404 (no existence leak)
 * - role too low → 403
 * - MFA required but session without second factor → 403 mfa_required
 */
@Injectable()
export class AccessService {
  private readonly logger = new Logger('AccessService');

  constructor(@Inject(REPOSITORY) private readonly repo: Repository) {}

  async roleIn(user: AuthContext, orgId: string): Promise<Role | null> {
    let cache = roleCache.get(user);
    if (!cache) {
      cache = new Map();
      roleCache.set(user, cache);
    }
    if (cache.has(orgId)) return cache.get(orgId) ?? null;
    const member = DocIdSchema.safeParse(orgId).success ? await this.repo.getMember(orgId, user.uid) : null;
    const role = member?.role ?? null;
    cache.set(orgId, role);
    return role;
  }

  /** Sprint 5: true while orgs/{orgId}.status == 'offboarding' (cached per request). */
  async isOffboarding(user: AuthContext, orgId: string): Promise<boolean> {
    let cache = offboardingCache.get(user);
    if (!cache) {
      cache = new Map();
      offboardingCache.set(user, cache);
    }
    const hit = cache.get(orgId);
    if (hit !== undefined) return hit;
    const org = await this.repo.getOrg(orgId);
    const v = org?.status === 'offboarding';
    cache.set(orgId, v);
    return v;
  }

  async requireRole(user: AuthContext, orgId: string, minRole: Role, opts: AccessOpts = {}): Promise<OrgAccess> {
    const role = await this.roleIn(user, orgId);
    if (!role) throw notFound('org');
    // Members only learn that the org is being offboarded (outsiders still get 404).
    if (!opts.allowOffboarding && (await this.isOffboarding(user, orgId))) {
      throw new ApiException(HttpStatus.FORBIDDEN, 'org_offboarding', 'the organization is being offboarded; only the offboarding export is available');
    }
    if (!roleSatisfies(role, minRole)) {
      this.logger.warn({ orgId, uid: user.uid, need: minRole }, 'role denied');
      throw forbidden();
    }
    if (opts.requireMfa && !user.mfa) {
      throw new ApiException(HttpStatus.FORBIDDEN, 'mfa_required', 'this action requires MFA');
    }
    return { orgId, role };
  }

  /**
   * Sprint 5 (SEC-52): the ID token must come from a sign-in within `maxAgeSeconds` (`auth_time` claim, seconds since
   * epoch). Firebase keeps `auth_time` across token refreshes, so this proves a recent password/MFA entry.
   */
  requireRecentAuth(user: AuthContext, maxAgeSeconds: number, nowMs = Date.now()): void {
    const authTime = (user.claims as Record<string, unknown>).auth_time;
    const ok = typeof authTime === 'number' && Number.isFinite(authTime) && nowMs / 1000 - authTime <= maxAgeSeconds && authTime <= nowMs / 1000 + 300;
    if (!ok) throw new ApiException(HttpStatus.FORBIDDEN, 'recent_auth_required', `sign in again (within the last ${Math.round(maxAgeSeconds / 60)} minutes) to do this`);
  }

  /** Resolves a bare project id to its org and checks the caller's role there. */
  async requireProjectRole(user: AuthContext, projectId: string, minRole: Role, opts: AccessOpts = {}): Promise<OrgAccess> {
    const orgId = DocIdSchema.safeParse(projectId).success ? await this.repo.findProjectOrgId(projectId) : null;
    if (!orgId) throw notFound('project');
    try {
      return await this.requireRole(user, orgId, minRole, opts);
    } catch (err) {
      if (err instanceof ApiException && err.code === 'not_found') throw notFound('project');
      throw err;
    }
  }
}
