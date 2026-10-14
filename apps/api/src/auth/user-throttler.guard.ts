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

export const RATE_LIMIT_TIER = 'kamutan:rateLimitTier';
export type RateLimitTier = 'strict' | 'tiles' | 'export';
/** Per-route limit tier (per user, per route, per THROTTLE_TTL_MS window). */
export const RateLimit = (tier: RateLimitTier) => SetMetadata(RATE_LIMIT_TIER, tier);
/** Applies the stricter UPLOAD_THROTTLE_LIMIT to a route (uploads, reprocess, later exports/share links/LLM). */
export const StrictRateLimit = () => RateLimit('strict');

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
    const tier = this.reflector.getAllAndOverride<RateLimitTier | undefined>(RATE_LIMIT_TIER, [
      props.context.getHandler(),
      props.context.getClass(),
    ]);
    if (tier === 'strict') return super.handleRequest({ ...props, limit: this.cfg.UPLOAD_THROTTLE_LIMIT });
    if (tier === 'tiles') return super.handleRequest({ ...props, limit: this.cfg.TILES_THROTTLE_LIMIT });
    if (tier === 'export') return super.handleRequest({ ...props, limit: this.cfg.EXPORT_THROTTLE_LIMIT });
    return super.handleRequest(props);
  }

  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const auth = req.auth as { uid?: string } | undefined;
    if (auth?.uid) return `u:${auth.uid}`;
    const ip = typeof req.ip === 'string' ? req.ip : 'unknown';
    // Hash so raw IPs never land in the throttler store.
    return `ip:${createHash('sha256').update(ip).digest('hex').slice(0, 32)}`;
  }
}
