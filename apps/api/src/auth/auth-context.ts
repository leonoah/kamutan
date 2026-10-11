import type { AccessTokenClaims, Role } from '@kamutan/contracts';

/** Authenticated principal attached to the request by AuthGuard. */
export interface AuthContext {
  userId: string;
  aal: 'aal1' | 'aal2' | null;
  /** Verified claims; forwarded to Postgres as `request.jwt.claims` for RLS. */
  claims: AccessTokenClaims;
}

/** Org access resolved by RolesGuard for the current route. */
export interface OrgAccess {
  orgId: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      orgAccess?: OrgAccess;
    }
  }
}
