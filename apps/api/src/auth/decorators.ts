import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role } from '@kamutan/contracts';
import type { Request } from 'express';
import type { AuthContext, OrgAccess } from './auth-context';

export const IS_PUBLIC = 'kamutan:isPublic';
/** Skips authentication (health checks, token-authenticated local uploads). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Where RolesGuard finds the org that the route operates on. */
export type OrgSource =
  | { from: 'param'; key: string }
  | { from: 'body'; key: string }
  | { from: 'query'; key: string }
  /** Look up the project's org_id (via RLS-scoped repository). */
  | { from: 'project-param'; key: string };

export interface RoleRequirement {
  minRole: Role;
  org: OrgSource;
  /** Require MFA (aal2) — admin-level operations (SEC-02). */
  requireMfa?: boolean;
}

export const ROLE_REQUIREMENT = 'kamutan:roleRequirement';

/** Requires membership of at least `minRole` in the org resolved from `org`. */
export const RequireRole = (minRole: Role, org: OrgSource, opts: { requireMfa?: boolean } = {}) =>
  SetMetadata(ROLE_REQUIREMENT, { minRole, org, requireMfa: opts.requireMfa } satisfies RoleRequirement);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.auth) throw new Error('CurrentUser used on a public route');
  return req.auth;
});

export const CurrentOrgAccess = createParamDecorator((_: unknown, ctx: ExecutionContext): OrgAccess => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.orgAccess) throw new Error('CurrentOrgAccess used without @RequireRole');
  return req.orgAccess;
});
