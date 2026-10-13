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

    /** Lifetime of signed artifact read URLs (tiles, thumbnail). 15 minutes per the Sprint 1 brief. */
    SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
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
