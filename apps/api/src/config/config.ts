import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');
const csv = z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /**
     * Exact origins allowed by CORS. Empty (default) = same-origin only: in
     * production the web app calls /api/** on the same Hosting origin (ADR 0008).
     */
    CORS_ORIGINS: csv.default(''),
    SWAGGER_ENABLED: bool.default('true'),

    // --- Firebase / Google Cloud (credentials via ADC / GOOGLE_APPLICATION_CREDENTIALS only) ---
    GOOGLE_CLOUD_PROJECT: z.string().min(1).default('kamutan-fba67'),
    FIREBASE_STORAGE_BUCKET: z.string().min(1).default('kamutan-fba67.firebasestorage.app'),

    // --- Drivers (memory = tests / offline dev; refused in production) ---
    DATA_DRIVER: z.enum(['firestore', 'memory']).default('firestore'),
    STORAGE_DRIVER: z.enum(['firebase', 'memory']).default('firebase'),
    QUEUE_DRIVER: z.enum(['pubsub', 'memory']).default('pubsub'),
    INGEST_TOPIC: z.string().min(1).default('ingest'),

    /** HMAC secret for upload tokens (>= 32 chars). Secret Manager in Functions. */
    UPLOAD_TOKEN_SECRET: z.string().min(32).optional(),

    // --- Rate limiting (SEC-42), per instance ---
    THROTTLE_TTL_MS: z.coerce.number().int().positive().default(60_000),
    THROTTLE_LIMIT: z.coerce.number().int().positive().default(120),
    UPLOAD_THROTTLE_LIMIT: z.coerce.number().int().positive().default(20),
    /** tiles-manifest calls per user per THROTTLE_TTL_MS (each call signs up to 256 URLs). */
    TILES_THROTTLE_LIMIT: z.coerce.number().int().positive().default(60),
    /** Sprint 3: Excel exports per user per THROTTLE_TTL_MS (SEC-42 "stricter limit on exports"). */
    EXPORT_THROTTLE_LIMIT: z.coerce.number().int().positive().default(10),

    /** Lifetime of signed artifact read URLs (tiles, thumbnail). 15 minutes per the Sprint 1 brief. */
    SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),

    // --- Sprint 5 ---
    /** Topic of the API's own background jobs (offboarding export), consumed by the `apiJobs` function. */
    API_JOBS_TOPIC: z.string().min(1).default('api-jobs'),
    /** Origin of the web app (share URLs `{origin}/s/{token}`). */
    PUBLIC_APP_ORIGIN: z.string().url().default('https://kamutan-fba67.web.app'),
    /** Public share API: requests per minute per IP and per token (SEC-29), tiles excluded. */
    SHARE_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(60),
    /** Public share tiles: requests per minute per IP and per token (a viewport is dozens of tiles). */
    SHARE_TILE_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(600),
    /** Unknown-token hits per minute per IP before the IP is locked out of the public share API. */
    SHARE_UNKNOWN_TOKEN_LIMIT: z.coerce.number().int().positive().default(10),
    SHARE_LOCKOUT_MS: z.coerce.number().int().positive().default(15 * 60_000),
    /** Offboarding (export + offboard) requires an MFA session in addition to a recent sign-in (SEC-07). */
    OFFBOARDING_REQUIRE_MFA: bool.default('true'),
    /** TTF/OTF with Hebrew glyphs for share watermarks (default: bundled assets/fonts/DejaVuSans.ttf). */
    WATERMARK_FONT_FILE: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    const req = (cond: boolean, path: string, message: string) => {
      if (!cond) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };
    req(Boolean(env.UPLOAD_TOKEN_SECRET), 'UPLOAD_TOKEN_SECRET', 'required (>= 32 chars)');
    req(!env.CORS_ORIGINS.includes('*'), 'CORS_ORIGINS', 'wildcard origin is not allowed');
    if (env.NODE_ENV === 'production') {
      req(env.DATA_DRIVER === 'firestore', 'DATA_DRIVER', 'memory driver is not allowed in production');
      req(env.STORAGE_DRIVER === 'firebase', 'STORAGE_DRIVER', 'memory storage is not allowed in production');
      req(env.QUEUE_DRIVER === 'pubsub', 'QUEUE_DRIVER', 'memory queue is not allowed in production');
      // R-A7: SEC-02 / SEC-52 — the MFA requirement of offboarding cannot be switched off in production.
      req(env.OFFBOARDING_REQUIRE_MFA, 'OFFBOARDING_REQUIRE_MFA', 'must be true in production');
    }
  });

export type AppConfig = z.infer<typeof EnvSchema>;

export const APP_CONFIG = Symbol('APP_CONFIG');

/** Parses env vars; throws with a list of problems (never echoes values). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
  return parsed.data;
}
