import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AccessService } from '../access/access.service';
import { ApiException } from '../common/api-exception';
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

/** Enforces @RequireRole (SEC-07 matrix) at route level via AccessService. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const reqmt = this.reflector.getAllAndOverride<RoleRequirement | undefined>(ROLE_REQUIREMENT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!reqmt) return true;

    const req = context.switchToHttp().getRequest<Request>();
    if (!req.auth) throw new Error('RolesGuard requires AuthGuard to run first');

    const raw = pick(req, reqmt.org);
    if (typeof raw !== 'string' || raw.length === 0) {
      if (reqmt.org.from === 'body' || reqmt.org.from === 'query') {
        throw new ApiException(HttpStatus.BAD_REQUEST, 'validation_failed', `${reqmt.org.key} is required`, [
          { path: reqmt.org.key, message: 'required' },
        ]);
      }
    }
    const id = typeof raw === 'string' ? raw : '';
    const opts = { requireMfa: reqmt.requireMfa, allowOffboarding: reqmt.allowOffboarding };
    req.orgAccess =
      reqmt.org.from === 'project-param'
        ? await this.access.requireProjectRole(req.auth, id, reqmt.minRole, opts)
        : await this.access.requireRole(req.auth, id, reqmt.minRole, opts);
    return true;
  }
}
