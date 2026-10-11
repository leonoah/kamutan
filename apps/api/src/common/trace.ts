import { randomBytes } from 'node:crypto';
import { TraceparentSchema } from '@kamutan/contracts';

/**
 * Returns a W3C `traceparent` for job payloads: the incoming header when valid,
 * otherwise a fresh root context (until OpenTelemetry auto-instrumentation is wired).
 */
export function traceparentFrom(header: unknown): string {
  if (typeof header === 'string' && TraceparentSchema.safeParse(header).success && !/^00-0{32}-/.test(header)) {
    return header;
  }
  return `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
}
