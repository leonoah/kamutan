import { type INestApplication, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { AppConfig } from './config/config';

/** Applies HTTP hardening shared by main.ts and e2e tests. */
export function configureApp(app: NestExpressApplication, cfg: AppConfig): void {
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind Railway's proxy; needed for per-IP throttling
  app.useBodyParser('json', { limit: '256kb' });
  const common = {
    crossOriginResourcePolicy: { policy: 'same-site' as const },
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
    (req.path?.startsWith('/docs') ? docsHelmet : apiHelmet)(req as never, res as never, next),
  );
  app.use((_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.enableCors({
    origin: (origin, cb) => {
      // Non-browser clients send no Origin. Browsers must match the allowlist exactly (SEC-41).
      if (!origin) return cb(null, true);
      cb(null, cfg.CORS_ORIGINS.includes(origin));
    },
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'x-request-id', 'traceparent', 'x-upsert'],
    exposedHeaders: ['x-request-id', 'retry-after'],
    credentials: false,
    maxAge: 600,
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enableShutdownHooks();
}

export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Kamutan API')
    .setDescription('Core API (Sprint 0: auth, orgs, projects, uploads). Contracts: @kamutan/contracts (Zod).')
    .setVersion('0.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .build();
  return SwaggerModule.createDocument(app, config);
}

export async function createApp(cfg: AppConfig): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(cfg), {
    bufferLogs: true,
    bodyParser: false,
  });
  app.useLogger(app.get(Logger));
  configureApp(app, cfg);
  if (cfg.SWAGGER_ENABLED && cfg.NODE_ENV !== 'production') {
    SwaggerModule.setup('docs', app, buildOpenApi(app), { jsonDocumentUrl: 'docs/openapi.json' });
  }
  return app;
}
