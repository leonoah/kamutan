import { AccessTokenClaimsSchema } from '@kamutan/contracts';
import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTVerifyOptions,
} from 'jose';
import { type AppConfig, jwksUrl, jwtAudience, jwtIssuer } from '../config/config';
import type { AuthContext } from './auth-context';

export class InvalidTokenError extends Error {
  constructor(readonly reason: string) {
    super(`invalid token: ${reason}`);
    this.name = 'InvalidTokenError';
  }
}

const ASYMMETRIC_ALGS = ['RS256', 'ES256', 'EdDSA'];

export interface JwtVerifierOptions {
  hs256Secret?: string;
  jwks?: JWTVerifyGetKey;
  audience: string;
  issuer?: string;
  clockToleranceSec?: number;
}

/**
 * Verifies Firebase ID tokens (RS256, Google's public keys, iss/aud pinned to the
 * project). An HS256 shared secret is supported for local dev and tests only.
 * Tokens that declare a non-end-user `role` (e.g. service keys) are rejected.
 */
export class JwtVerifier {
  private readonly secret?: Uint8Array;
  private readonly jwks?: JWTVerifyGetKey;
  private readonly baseOptions: JWTVerifyOptions;

  constructor(opts: JwtVerifierOptions) {
    if (!opts.hs256Secret && !opts.jwks) throw new Error('JwtVerifier needs an HS256 secret and/or a JWKS');
    this.secret = opts.hs256Secret ? new TextEncoder().encode(opts.hs256Secret) : undefined;
    this.jwks = opts.jwks;
    this.baseOptions = {
      audience: opts.audience,
      issuer: opts.issuer,
      clockTolerance: opts.clockToleranceSec ?? 30,
      requiredClaims: ['sub', 'exp'],
    };
  }

  static fromConfig(cfg: AppConfig): JwtVerifier {
    const url = jwksUrl(cfg);
    return new JwtVerifier({
      hs256Secret: cfg.DEV_JWT_SECRET,
      jwks: url
        ? createRemoteJWKSet(new URL(url), { cacheMaxAge: 10 * 60_000, cooldownDuration: 30_000 })
        : undefined,
      audience: jwtAudience(cfg),
      issuer: jwtIssuer(cfg),
    });
  }

  async verify(token: string): Promise<AuthContext> {
    if (!token || token.length > 8192 || token.split('.').length !== 3) {
      throw new InvalidTokenError('malformed');
    }
    let alg: string | undefined;
    try {
      alg = decodeProtectedHeader(token).alg;
    } catch {
      throw new InvalidTokenError('malformed header');
    }

    let payload: unknown;
    try {
      if (alg === 'HS256' && this.secret) {
        ({ payload } = await jwtVerify(token, this.secret, { ...this.baseOptions, algorithms: ['HS256'] }));
      } else if (alg && ASYMMETRIC_ALGS.includes(alg) && this.jwks) {
        ({ payload } = await jwtVerify(token, this.jwks, { ...this.baseOptions, algorithms: ASYMMETRIC_ALGS }));
      } else {
        throw new InvalidTokenError('unsupported algorithm');
      }
    } catch (err) {
      if (err instanceof InvalidTokenError) throw err;
      if (err instanceof joseErrors.JWTExpired) throw new InvalidTokenError('expired');
      if (err instanceof joseErrors.JWTClaimValidationFailed) throw new InvalidTokenError(`claim ${err.claim}`);
      throw new InvalidTokenError('signature');
    }

    const claims = AccessTokenClaimsSchema.safeParse(payload);
    if (!claims.success) throw new InvalidTokenError('claims shape');
    if (claims.data.role !== undefined && claims.data.role !== 'authenticated') {
      throw new InvalidTokenError('not an end-user token');
    }
    // Firebase marks MFA sign-ins with `firebase.sign_in_second_factor`.
    const fb = (payload as { firebase?: { sign_in_second_factor?: string } }).firebase;
    const aal = claims.data.aal ?? (fb?.sign_in_second_factor ? 'aal2' : 'aal1');
    return { userId: claims.data.sub, aal, claims: claims.data };
  }
}
