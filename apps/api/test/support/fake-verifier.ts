import { randomBytes } from 'node:crypto';
import type { AuthContext } from '../../src/auth/auth-context';
import { InvalidTokenError, principalFromClaims, type IdTokenVerifier } from '../../src/auth/id-token-verifier';

interface FakeOpts {
  mfa?: boolean;
  provider?: string;
  email?: string;
  /** Sprint 5: `auth_time` (seconds since epoch); default = now (a fresh sign-in). */
  authTime?: number;
}

/**
 * Test double for FirebaseIdTokenVerifier. Only tokens it issued are valid
 * (stands in for the signature check); `revoke()` emulates checkRevoked.
 */
export class FakeIdTokenVerifier implements IdTokenVerifier {
  private readonly issued = new Map<string, Record<string, unknown>>();

  issue(uid: string, opts: FakeOpts = {}): string {
    const token = `fake.${randomBytes(12).toString('base64url')}.${uid.replace(/[^A-Za-z0-9_-]/g, '')}`;
    this.issued.set(token, {
      uid,
      auth_time: opts.authTime ?? Math.floor(Date.now() / 1000),
      email: opts.email ?? `${uid}@example.test`,
      firebase: {
        sign_in_provider: opts.provider ?? 'password',
        ...(opts.mfa ? { sign_in_second_factor: 'totp' } : {}),
      },
    });
    return token;
  }

  revoke(token: string): void {
    this.issued.delete(token);
  }

  /** Emulates revokeRefreshTokens: every token of `uid` stops verifying. */
  revokeUser(uid: string): void {
    for (const [t, c] of [...this.issued.entries()]) if (c.uid === uid) this.issued.delete(t);
  }

  async verify(token: string): Promise<AuthContext> {
    const claims = this.issued.get(token);
    if (!claims) throw new InvalidTokenError('id-token-revoked-or-invalid');
    return principalFromClaims(claims);
  }
}

export function user(uid: string, opts: FakeOpts = {}): AuthContext {
  return principalFromClaims({
    uid,
    auth_time: opts.authTime ?? Math.floor(Date.now() / 1000),
    email: `${uid}@example.test`,
    firebase: { sign_in_provider: opts.provider ?? 'password', ...(opts.mfa ? { sign_in_second_factor: 'totp' } : {}) },
  });
}
