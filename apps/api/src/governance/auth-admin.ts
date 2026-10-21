import type { App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

export const AUTH_ADMIN = Symbol('AUTH_ADMIN');

/** Firebase Auth admin operations the API needs (SEC-52: end every member's sessions on offboarding). */
export interface AuthAdmin {
  /** Invalidates the user's refresh tokens; ID tokens are then rejected by verifyIdToken(checkRevoked=true). */
  revokeRefreshTokens(uid: string): Promise<void>;
}

export class FirebaseAuthAdmin implements AuthAdmin {
  constructor(private readonly app: App) {}

  async revokeRefreshTokens(uid: string): Promise<void> {
    await getAuth(this.app).revokeRefreshTokens(uid);
  }
}

/** Tests / offline dev: records the revoked uids. */
export class InMemoryAuthAdmin implements AuthAdmin {
  readonly revoked: string[] = [];
  /** Optional hook (tests: also revoke the fake verifier's tokens). */
  onRevoke?: (uid: string) => void;

  async revokeRefreshTokens(uid: string): Promise<void> {
    this.revoked.push(uid);
    this.onRevoke?.(uid);
  }
}
