import { type INestApplication, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter, type NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import type { Express } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { AppConfig } from './config/config';

/** All routes live under /api/v1/... (Hosting rewrite `/api/**` → function `api`). */
export const GLOBAL_PREFIX = 'api';

/** Path prefix of the public (unauthenticated, read-only) share API. */
export const PUBLIC_SHARE_PREFIX = `/${GLOBAL_PREFIX}/v1/public/`;

type MiniReq = { path?: string; method?: string };
type MiniRes = { setHeader: (k: string, v: string) => void; status: (n: number) => { json: (b: unknown) => void } };

/** Headers on every public response + 405 for anything but GET/HEAD (before routing, so no handler ever sees a write). */
export function publicShareMiddleware(req: MiniReq, res: MiniRes, next: () => void): void {
  if (!req.path?.startsWith(PUBLIC_SHARE_PREFIX)) return next();
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'the share API is read-only', requestId: null } });
    return;
  }
  next();
}

/** Applies HTTP hardening shared by main.ts, function.ts and e2e tests. */
export function configureApp(app: NestExpressApplication, cfg: AppConfig): void {
  app.disable('x-powered-by');
  app.set('trust proxy', true); // behind Google Front End / Hosting; needed for per-IP throttling
  // In Cloud Functions the body is already parsed by the functions framework (body-parser skips it then).
  // Sprint 4: 2 MB — a correction batch (≤ 500 items, ≤ 20 000 geometry points) must fit.
  app.useBodyParser('json', { limit: '2mb' });
  const common = {
    crossOriginResourcePolicy: { policy: 'same-origin' as const },
    referrerPolicy: { policy: 'no-referrer' as const },
    hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
  };
  // JSON API: lock everything down (SEC-40).
  // R-A5: no helmet CSP defaults on JSON responses (they add font-src/style-src … that a JSON API never needs).
  const apiHelmet = helmet({
    ...common,
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
    xFrameOptions: { action: 'deny' },
  });
  // Swagger UI (non-production only) needs its own scripts/styles.
  const docsHelmet = helmet({
    ...common,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        frameAncestors: ["'none'"],
      },
    },
  });
  app.use((req: { path?: string }, res: unknown, next: () => void) =>
    (req.path?.startsWith(`/${GLOBAL_PREFIX}/docs`) ? docsHelmet : apiHelmet)(req as never, res as never, next),
  );
  app.use((_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // Sprint 5 (SEC-29): public share API — never indexed, never leaks the URL (token) as a referrer, read-only (405).
  app.use(publicShareMiddleware);
  // Same-origin by default (ADR 0008). CORS only when origins are explicitly allow-listed (e.g. local Vite).
  if (cfg.CORS_ORIGINS.length > 0) {
    app.enableCors({
      origin: (origin, cb) => cb(null, !origin || cfg.CORS_ORIGINS.includes(origin)),
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['authorization', 'content-type', 'x-request-id', 'traceparent'],
      exposedHeaders: ['x-request-id', 'retry-after'],
      credentials: false,
      maxAge: 600,
    });
  }
  app.setGlobalPrefix(GLOBAL_PREFIX);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enableShutdownHooks();
}

export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Kamutan API')
    .setDescription('Core API (Sprint 0: auth, orgs, projects, uploads). Firebase ID tokens. Contracts: @kamutan/contracts (Zod).')
    .setVersion('0.2.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'Firebase ID token' })
    .build();
  return SwaggerModule.createDocument(app, config);
}

/** Creates the Nest app; pass an Express instance to mount it (Cloud Functions). */
export async function createApp(cfg: AppConfig, server?: Express): Promise<NestExpressApplication> {
  const opts = { bufferLogs: true, bodyParser: false } as const;
  const app = server
    ? await NestFactory.create<NestExpressApplication>(AppModule.forRoot(cfg), new ExpressAdapter(server), opts)
    : await NestFactory.create<NestExpressApplication>(AppModule.forRoot(cfg), opts);
  app.useLogger(app.get(Logger));
  configureApp(app, cfg);
  if (cfg.SWAGGER_ENABLED && cfg.NODE_ENV !== 'production') {
    SwaggerModule.setup(`${GLOBAL_PREFIX}/docs`, app, buildOpenApi(app), { jsonDocumentUrl: `${GLOBAL_PREFIX}/docs/openapi.json` });
  }
  return app;
}
