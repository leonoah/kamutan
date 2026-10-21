import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { forbidden, unauthorized } from '../common/api-exception';

/** Raw share token: 43 base64url chars, no dots (Firebase ID tokens are JWTs: three dot-separated parts). */
const SHARE_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
import { IS_PUBLIC } from './decorators';
import { ID_TOKEN_VERIFIER, InvalidTokenError, type IdTokenVerifier } from './id-token-verifier';

/** Global guard: every route requires a valid Firebase ID token unless @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger('AuthGuard');

  constructor(
    private readonly reflector: Reflector,
    @Inject(ID_TOKEN_VERIFIER) private readonly verifier: IdTokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header) : null;
    // Sprint 5 (E2E-09): a share-link token never authenticates and never grants a write — an attempt to WRITE with one
    // (as bearer or X-Share-Token) is a 403, not a 401, so the external viewer's "edit" probe gets a clear refusal.
    const shareToken = typeof req.headers['x-share-token'] === 'string' || (!!match?.[1] && SHARE_TOKEN_SHAPE.test(match[1]));
    if (shareToken && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) throw forbidden('share links are read-only');
    if (!match?.[1]) throw unauthorized();

    try {
      req.auth = await this.verifier.verify(match[1]);
      return true;
    } catch (err) {
      if (err instanceof InvalidTokenError) {
        // Reason only (never the token) — feeds SEC-43 alerting.
        this.logger.warn({ reason: err.reason }, 'rejected id token');
        throw unauthorized('invalid or expired token');
      }
      throw err;
    }
  }
}
