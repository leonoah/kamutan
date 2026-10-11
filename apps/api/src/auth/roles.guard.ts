import { CanActivate, ExecutionContext, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { roleSatisfies, UuidSchema } from '@kamutan/contracts';
import type { Request } from 'express';
import { ApiException, forbidden, notFound } from '../common/api-exception';
import { REPOSITORY, type Repository } from '../db/repository';
import { ROLE_REQUIREMENT, type OrgSource, type RoleRequirement } from './decorators';

function pick(req: Request, src: OrgSource): unknown {
  switch (src.from) {
    case 'param':
    case 'project-param':
      return req.params?.[src.key];
    case 'body':
      return (req.body as Record<string, unknown> | undefined)?.[src.key];
    case 'query':
      return (req.query as Record<string, unknown> | undefined)?.[src.key];
  }
}

/**
 * Enforces SEC-07 role matrix per route. Membership is read from the DB through
 * the RLS-scoped repository (the DB, not the token, is authoritative, so role
 * changes apply immediately). Non-members get 404 (no existence leak);
 * members with an insufficient role get 403.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger('RolesGuard');

  constructor(
    private readonly reflector: Reflector,
    @Inject(REPOSITORY) private readonly repo: Repository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const reqmt = this.reflector.getAllAndOverride<RoleRequirement | undefined>(ROLE_REQUIREMENT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!reqmt) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const auth = req.auth;
    if (!auth) throw new Error('RolesGuard requires AuthGuard to run first');

    const raw = pick(req, reqmt.org);
    const id = UuidSchema.safeParse(raw);
    if (!id.success) {
      if (reqmt.org.from === 'param' || reqmt.org.from === 'project-param') throw notFound();
      throw new ApiException(HttpStatus.BAD_REQUEST, 'validation_failed', `${reqmt.org.key} must be a uuid`, [
        { path: reqmt.org.key, message: 'must be a uuid' },
      ]);
    }

    const resolved = await this.repo.run(auth, async (tx) => {
      let orgId = id.data;
      if (reqmt.org.from === 'project-param') {
        const project = await tx.getProject(id.data);
        if (!project) return null;
        orgId = project.orgId;
      }
      const role = await tx.getMyRole(orgId);
      return role ? { orgId, role } : null;
    });

    if (!resolved) throw notFound(reqmt.org.from === 'project-param' ? 'project' : 'org');
    if (!roleSatisfies(resolved.role, reqmt.minRole)) {
      this.logger.warn({ orgId: resolved.orgId, userId: auth.userId, need: reqmt.minRole }, 'role denied');
      throw forbidden();
    }
    if (reqmt.requireMfa && auth.aal !== 'aal2') {
      throw new ApiException(HttpStatus.FORBIDDEN, 'mfa_required', 'this action requires MFA (aal2)');
    }
    req.orgAccess = resolved;
    return true;
  }
}
