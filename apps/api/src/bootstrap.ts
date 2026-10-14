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
  const apiHelmet = helmet({
    ...common,
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
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
