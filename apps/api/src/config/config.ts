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

    // --- Auth (Supabase JWT) ---
    SUPABASE_URL: z.string().url().optional(),
    /** Legacy HS256 shared secret. */
    SUPABASE_JWT_SECRET: z.string().min(32).optional(),
    /** JWKS for asymmetric Supabase signing keys; defaults to `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` when JWT_USE_JWKS=true. */
    SUPABASE_JWKS_URL: z.string().url().optional(),
    JWT_USE_JWKS: bool.default('false'),
    JWT_AUDIENCE: z.string().default('authenticated'),
    /** Expected `iss`; defaults to `${SUPABASE_URL}/auth/v1` when SUPABASE_URL is set. */
    JWT_ISSUER: z.string().optional(),

    // --- Data ---
    DATA_DRIVER: z.enum(['pg', 'memory']).default('pg'),
    DATABASE_URL: z.string().optional(),
    DATABASE_SSL: z.enum(['disable', 'require', 'verify-full']).default('disable'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    // --- Queue ---
    QUEUE_DRIVER: z.enum(['bullmq', 'memory']).default('memory'),
    REDIS_URL: z.string().optional(),

    // --- Storage ---
    STORAGE_DRIVER: z.enum(['supabase', 'local']).default('local'),
    STORAGE_LOCAL_DIR: z.string().default('.local-storage'),
    /** Private bucket for drawings (supabase/migrations 0008). Object names start with '{orgId}/'. */
    STORAGE_BUCKET: z.string().default('drawings'),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
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
      Boolean(env.SUPABASE_JWT_SECRET) || env.JWT_USE_JWKS || Boolean(env.SUPABASE_JWKS_URL),
      'SUPABASE_JWT_SECRET',
      'configure SUPABASE_JWT_SECRET and/or JWKS (JWT_USE_JWKS / SUPABASE_JWKS_URL)',
    );
    if (env.JWT_USE_JWKS && !env.SUPABASE_JWKS_URL) {
      req(Boolean(env.SUPABASE_URL), 'SUPABASE_URL', 'SUPABASE_URL is required to derive the JWKS URL');
    }
    if (env.DATA_DRIVER === 'pg') req(Boolean(env.DATABASE_URL), 'DATABASE_URL', 'required when DATA_DRIVER=pg');
    if (env.QUEUE_DRIVER === 'bullmq') req(Boolean(env.REDIS_URL), 'REDIS_URL', 'required when QUEUE_DRIVER=bullmq');
    if (env.STORAGE_DRIVER === 'supabase') {
      req(Boolean(env.SUPABASE_URL), 'SUPABASE_URL', 'required when STORAGE_DRIVER=supabase');
      req(Boolean(env.SUPABASE_SERVICE_ROLE_KEY), 'SUPABASE_SERVICE_ROLE_KEY', 'required when STORAGE_DRIVER=supabase');
    }
    req(Boolean(env.UPLOAD_TOKEN_SECRET), 'UPLOAD_TOKEN_SECRET', 'required (>= 32 chars)');
    if (env.NODE_ENV === 'production') {
      req(env.DATA_DRIVER === 'pg', 'DATA_DRIVER', 'memory driver is not allowed in production');
      req(env.QUEUE_DRIVER === 'bullmq', 'QUEUE_DRIVER', 'memory queue is not allowed in production');
      req(env.STORAGE_DRIVER === 'supabase', 'STORAGE_DRIVER', 'local storage is not allowed in production');
      req(env.DATABASE_SSL !== 'disable', 'DATABASE_SSL', 'TLS is required in production (SEC-21)');
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

export function jwksUrl(cfg: AppConfig): string | undefined {
  if (cfg.SUPABASE_JWKS_URL) return cfg.SUPABASE_JWKS_URL;
  if (cfg.JWT_USE_JWKS && cfg.SUPABASE_URL) {
    return `${cfg.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`;
  }
  return undefined;
}

export function jwtIssuer(cfg: AppConfig): string | undefined {
  if (cfg.JWT_ISSUER) return cfg.JWT_ISSUER;
  if (cfg.SUPABASE_URL) return `${cfg.SUPABASE_URL.replace(/\/$/, '')}/auth/v1`;
  return undefined;
}
