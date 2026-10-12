import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { DocIdSchema, roleSatisfies, type Role } from '@kamutan/contracts';
import type { AuthContext, OrgAccess } from '../auth/auth-context';
import { ApiException, forbidden, notFound } from '../common/api-exception';
import { REPOSITORY, type Repository } from '../db/repository';

/** Per-principal cache of memberships for the lifetime of one request. */
const roleCache = new WeakMap<AuthContext, Map<string, Role | null>>();

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

  async requireRole(user: AuthContext, orgId: string, minRole: Role, opts: { requireMfa?: boolean } = {}): Promise<OrgAccess> {
    const role = await this.roleIn(user, orgId);
    if (!role) throw notFound('org');
    if (!roleSatisfies(role, minRole)) {
      this.logger.warn({ orgId, uid: user.uid, need: minRole }, 'role denied');
      throw forbidden();
    }
    if (opts.requireMfa && !user.mfa) {
      throw new ApiException(HttpStatus.FORBIDDEN, 'mfa_required', 'this action requires MFA');
    }
    return { orgId, role };
  }

  /** Resolves a bare project id to its org and checks the caller's role there. */
  async requireProjectRole(user: AuthContext, projectId: string, minRole: Role, opts: { requireMfa?: boolean } = {}): Promise<OrgAccess> {
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
