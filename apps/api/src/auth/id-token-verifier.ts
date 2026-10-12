import { IdTokenClaimsSchema } from '@kamutan/contracts';
import type { App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type { AuthContext } from './auth-context';

export const ID_TOKEN_VERIFIER = Symbol('ID_TOKEN_VERIFIER');

export class InvalidTokenError extends Error {
  constructor(readonly reason: string) {
    super(`invalid token: ${reason}`);
    this.name = 'InvalidTokenError';
  }
}

/** Port: verifies a bearer token and returns the principal. */
export interface IdTokenVerifier {
  verify(token: string): Promise<AuthContext>;
}

/** Shared post-verification policy for any verifier implementation. */
export function principalFromClaims(raw: unknown): AuthContext {
  const parsed = IdTokenClaimsSchema.safeParse(raw);
  if (!parsed.success) throw new InvalidTokenError('claims shape');
  const claims = parsed.data;
  // Anonymous Firebase sessions never act through the API.
  if (claims.firebase.sign_in_provider === 'anonymous') throw new InvalidTokenError('anonymous session');
  return {
    uid: claims.uid,
    email: claims.email,
    mfa: typeof claims.firebase.sign_in_second_factor === 'string' && claims.firebase.sign_in_second_factor.length > 0,
    claims,
  };
}

/**
 * Firebase Auth ID tokens via firebase-admin: signature (Google certs), audience
 * (project id), issuer, expiry, and revocation (`checkRevoked: true` — disabled
 * users and revoked sessions are rejected, SEC-03).
 */
export class FirebaseIdTokenVerifier implements IdTokenVerifier {
  constructor(private readonly app: App) {}

  async verify(token: string): Promise<AuthContext> {
    if (!token || token.length > 8192 || token.split('.').length !== 3) throw new InvalidTokenError('malformed');
    let decoded: unknown;
    try {
      decoded = await getAuth(this.app).verifyIdToken(token, true);
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'unknown';
      throw new InvalidTokenError(code.replace(/^auth\//, ''));
    }
    return principalFromClaims(decoded);
  }
}
