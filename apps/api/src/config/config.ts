import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /** Public base URL of this API (used to build local-storage upload URLs). */
    PUBLIC_API_URL: z.string().url().default('http://localhost:3001'),
    /** Comma-separated exact origins allowed by CORS (SEC-41). */
    CORS_ORIGINS: csv.default('http://localhost:5173'),
    SWAGGER_ENABLED: bool.default('true'),

    // --- Auth (Firebase ID tokens) ---
    /** Firebase project id. Tokens are verified against Google's public keys; iss/aud derive from it. */
    FIREBASE_PROJECT_ID: z.string().optional(),
    /** Dev/test only: HS256 shared secret for locally minted tokens. Rejected in production. */
    DEV_JWT_SECRET: z.string().min(32).optional(),
    /** Expected `aud` when FIREBASE_PROJECT_ID is not set (tests with DEV_JWT_SECRET). */
    JWT_AUDIENCE: z.string().default('authenticated'),

    // --- Data ---
    DATA_DRIVER: z.enum(['firestore', 'memory']).default('firestore'),

    // --- Queue ---
    QUEUE_DRIVER: z.enum(['bullmq', 'memory']).default('memory'),
    REDIS_URL: z.string().optional(),

    // --- Storage ---
    STORAGE_DRIVER: z.enum(['firebase', 'local']).default('local'),
    STORAGE_LOCAL_DIR: z.string().default('.local-storage'),
    /** Firebase Storage bucket (e.g. `my-project.firebasestorage.app`). Object names start with '{orgId}/'. */
    STORAGE_BUCKET: z.string().optional(),
    /** HMAC secret for upload tokens (>= 32 chars). */
    UPLOAD_TOKEN_SECRET: z.string().min(32).optional(),

    // --- Rate limiting (SEC-42) ---
    THROTTLE_TTL_MS: z.coerce.number().int().positive().default(60_000),
    THROTTLE_LIMIT: z.coerce.number().int().positive().default(120),
    UPLOAD_THROTTLE_LIMIT: z.coerce.number().int().positive().default(20),
  })
  .superRefine((env, ctx) => {
    const req = (cond: boolean, path: string, message: string) => {
      if (!cond) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };
    req(
      Boolean(env.FIREBASE_PROJECT_ID) || Boolean(env.DEV_JWT_SECRET),
      'FIREBASE_PROJECT_ID',
      'set FIREBASE_PROJECT_ID (or DEV_JWT_SECRET for local development only)',
    );
    if (env.QUEUE_DRIVER === 'bullmq') req(Boolean(env.REDIS_URL), 'REDIS_URL', 'required when QUEUE_DRIVER=bullmq');
    if (env.STORAGE_DRIVER === 'firebase') {
      req(Boolean(env.STORAGE_BUCKET), 'STORAGE_BUCKET', 'required when STORAGE_DRIVER=firebase');
      req(Boolean(env.FIREBASE_PROJECT_ID), 'FIREBASE_PROJECT_ID', 'required when STORAGE_DRIVER=firebase');
    }
    if (env.DATA_DRIVER === 'firestore') {
      req(Boolean(env.FIREBASE_PROJECT_ID), 'FIREBASE_PROJECT_ID', 'required when DATA_DRIVER=firestore');
    }
    req(Boolean(env.UPLOAD_TOKEN_SECRET), 'UPLOAD_TOKEN_SECRET', 'required (>= 32 chars)');
    if (env.NODE_ENV === 'production') {
      req(env.DATA_DRIVER === 'firestore', 'DATA_DRIVER', 'memory driver is not allowed in production');
      req(!env.DEV_JWT_SECRET, 'DEV_JWT_SECRET', 'dev tokens are not allowed in production');
      req(env.QUEUE_DRIVER === 'bullmq', 'QUEUE_DRIVER', 'memory queue is not allowed in production');
      req(env.STORAGE_DRIVER === 'firebase', 'STORAGE_DRIVER', 'local storage is not allowed in production');
      req(!env.CORS_ORIGINS.includes('*'), 'CORS_ORIGINS', 'wildcard origin is not allowed');
      req(Boolean(env.REDIS_URL?.startsWith('rediss://')), 'REDIS_URL', 'rediss:// (TLS) is required in production');
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

/** Google's public keys for Firebase ID tokens (RS256). */
export const FIREBASE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

export function jwksUrl(cfg: AppConfig): string | undefined {
  return cfg.FIREBASE_PROJECT_ID ? FIREBASE_JWKS_URL : undefined;
}

export function jwtIssuer(cfg: AppConfig): string | undefined {
  return cfg.FIREBASE_PROJECT_ID ? `https://securetoken.google.com/${cfg.FIREBASE_PROJECT_ID}` : undefined;
}

/** Firebase tokens carry the project id as `aud`. */
export function jwtAudience(cfg: AppConfig): string {
  return cfg.FIREBASE_PROJECT_ID ?? cfg.JWT_AUDIENCE;
}
