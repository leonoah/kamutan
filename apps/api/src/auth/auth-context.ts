import type { IdTokenClaims, Role } from '@kamutan/contracts';

/** Authenticated principal attached to the request by AuthGuard. */
export interface AuthContext {
  uid: string;
  email?: string;
  /** ID token issued after a second-factor sign-in (firebase.sign_in_second_factor). */
  mfa: boolean;
  claims: IdTokenClaims;
}

/** Org access resolved by AccessService for the current request. */
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
