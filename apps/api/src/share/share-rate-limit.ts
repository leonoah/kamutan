/**
 * Per-instance limiter for the public share API (SEC-29): fixed one-minute windows per IP and per token, plus a
 * lockout of IPs that hit unknown tokens repeatedly (token guessing). Keys are hashed before they get here.
 * Like the other throttlers it is in memory per function instance (NOTES.md: a shared store is a follow-up).
 */
export interface ShareLimits {
  perMinute: number;
  tilePerMinute: number;
  unknownPerMinute: number;
  lockoutMs: number;
}

export type LimitDecision = { ok: true } | { ok: false; retryAfterSec: number };

const WINDOW_MS = 60_000;
const MAX_KEYS = 50_000;

export class ShareRateLimiter {
  private readonly windows = new Map<string, { start: number; n: number }>();
  private readonly lockedUntil = new Map<string, number>();

  constructor(
    private readonly limits: ShareLimits,
    private readonly now: () => number = Date.now,
  ) {}

  private hit(key: string, limit: number): LimitDecision {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= WINDOW_MS) {
      w = { start: t, n: 0 };
      this.windows.delete(key);
      this.windows.set(key, w);
      if (this.windows.size > MAX_KEYS) this.windows.delete(this.windows.keys().next().value as string);
    }
    w.n++;
    if (w.n > limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((w.start + WINDOW_MS - t) / 1000)) };
    return { ok: true };
  }

  /** IP locked out after too many unknown tokens? */
  locked(ipKey: string): LimitDecision {
    const until = this.lockedUntil.get(ipKey);
    const t = this.now();
    if (until && until > t) return { ok: false, retryAfterSec: Math.ceil((until - t) / 1000) };
    if (until) this.lockedUntil.delete(ipKey);
    return { ok: true };
  }

  /** Counts a request against the IP bucket (before the token is looked up). */
  ip(ipKey: string, tile: boolean): LimitDecision {
    return this.hit(`${tile ? 'ti' : 'i'}:${ipKey}`, tile ? this.limits.tilePerMinute : this.limits.perMinute);
  }

  /** Counts a request against the token bucket (known tokens only). */
  token(tokenKey: string, tile: boolean): LimitDecision {
    return this.hit(`${tile ? 'tt' : 't'}:${tokenKey}`, tile ? this.limits.tilePerMinute : this.limits.perMinute);
  }

  /** An unknown token from this IP; the `unknownPerMinute`-th one locks the IP out for `lockoutMs` (next request → 429). */
  unknown(ipKey: string): void {
    const d = this.hit(`u:${ipKey}`, this.limits.unknownPerMinute - 1);
    if (!d.ok) {
      this.lockedUntil.set(ipKey, this.now() + this.limits.lockoutMs);
      if (this.lockedUntil.size > MAX_KEYS) this.lockedUntil.delete(this.lockedUntil.keys().next().value as string);
    }
  }
}
