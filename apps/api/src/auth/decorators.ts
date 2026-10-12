import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role } from '@kamutan/contracts';
import type { Request } from 'express';
import type { AuthContext, OrgAccess } from './auth-context';

export const IS_PUBLIC = 'kamutan:isPublic';
/** Skips authentication (health checks). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Where RolesGuard finds the org that the route operates on. */
export type OrgSource =
  | { from: 'param'; key: string }
  | { from: 'body'; key: string }
  | { from: 'query'; key: string }
  /** Resolve the project's org (collection-group lookup), then check membership. */
  | { from: 'project-param'; key: string };

export interface RoleRequirement {
  minRole: Role;
  org: OrgSource;
  /** Require an MFA session (firebase.sign_in_second_factor) — admin-level actions (SEC-02). */
  requireMfa?: boolean;
}

export const ROLE_REQUIREMENT = 'kamutan:roleRequirement';

/**
 * Route-level role check (early 403/404). Services re-check through
 * AccessService, so a missing decorator can never expose another org's data.
 */
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
