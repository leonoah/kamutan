import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';
import type { AppConfig } from '../config/config';

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;
const SHARE_PATH_RE = /^(\/api\/v1\/public\/share\/)[^/?#]*/;

/**
 * Sprint 5 (R-A1, SEC-26): the raw share token is a bearer secret — never log it. The token segment of
 * /api/v1/public/share/:token/… is replaced by `<redacted>`; the query string is always dropped.
 */
export function logPath(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  return url.split('?')[0]?.replace(SHARE_PATH_RE, '$1<redacted>');
}

/** Accept a well-formed upstream X-Request-Id, otherwise mint one; echo it back. */
export function genReqId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', id);
  return id;
}

/**
 * pino-http config. No PII / customer content (SEC-34, SEC-43): no headers,
 * bodies, query strings or IPs — only method, path, status, timing and ids.
 */
export function loggerParams(cfg: AppConfig): Params {
  return {
    pinoHttp: {
      level: cfg.LOG_LEVEL,
      genReqId,
      // Pretty printing is intentionally not bundled; pipe through pino-pretty locally if wanted.
      redact: { paths: ['req.headers', 'res.headers', '*.authorization', '*.uploadToken', '*.token'], remove: true },
      serializers: {
        req: (req: { id?: unknown; method?: string; url?: string }) => ({
          id: req.id,
          method: req.method,
          path: logPath(req.url),
        }),
        res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      },
      customProps: (req: IncomingMessage) => {
        const r = req as IncomingMessage & { auth?: { uid: string }; orgAccess?: { orgId: string } };
        return { uid: r.auth?.uid, orgId: r.orgAccess?.orgId };
      },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      autoLogging: { ignore: (req) => (req.url ?? '').startsWith('/api/v1/health') },
    },
  };
}
