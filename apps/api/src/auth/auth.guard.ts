import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { unauthorized } from '../common/api-exception';
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
