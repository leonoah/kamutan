import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { unauthorized } from '../common/api-exception';
import { IS_PUBLIC } from './decorators';
import { InvalidTokenError, JwtVerifier } from './jwt-verifier';

/** Global guard: every route requires a valid Firebase ID token (Bearer) unless @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger('AuthGuard');

  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: JwtVerifier,
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
        this.logger.warn({ reason: err.reason }, 'rejected access token');
        throw unauthorized('invalid or expired token');
      }
      throw err;
    }
  }
}
