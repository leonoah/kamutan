import { Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/config';

export const STRICT_RATE_LIMIT = 'kamutan:strictRateLimit';
/** Applies the stricter UPLOAD_THROTTLE_LIMIT to a route (uploads, later exports/share links/LLM). */
export const StrictRateLimit = () => SetMetadata(STRICT_RATE_LIMIT, true);

/**
 * Rate limit per authenticated user (falls back to a hashed client IP on public
 * routes). Runs after AuthGuard so `req.auth` is available (SEC-42).
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {
    super(options, storage, reflector);
  }

  protected override async handleRequest(props: ThrottlerRequest): Promise<boolean> {
    const strict = this.reflector.getAllAndOverride<boolean>(STRICT_RATE_LIMIT, [
      props.context.getHandler(),
      props.context.getClass(),
    ]);
    return super.handleRequest(strict ? { ...props, limit: this.cfg.UPLOAD_THROTTLE_LIMIT } : props);
  }

  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const auth = req.auth as { uid?: string } | undefined;
    if (auth?.uid) return `u:${auth.uid}`;
    const ip = typeof req.ip === 'string' ? req.ip : 'unknown';
    // Hash so raw IPs never land in the throttler store.
    return `ip:${createHash('sha256').update(ip).digest('hex').slice(0, 32)}`;
  }
}
