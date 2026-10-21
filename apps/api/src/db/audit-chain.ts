import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';

/** Canonical JSON (sorted keys) so the hash is reproducible by any verifier. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

/** hash = sha256(prevHash || '' + '\n' + canonical(event without hash fields)). */
export function auditHash(prevHash: string | null, event: Record<string, unknown>): string {
  return createHash('sha256').update(`${prevHash ?? ''}\n${canonicalJson(event)}`).digest('hex');
}

const auditLogger = new Logger('Audit');

/**
 * R-A2 (SEC-43): content-free structured line per audit event, so Cloud Monitoring can alert on it (Firestore is not
 * alertable). Ids and action names only — never `after`. Inside a retried Firestore transaction it may repeat.
 */
export function logAuditEvent(orgId: string, e: { entity: string; action: string; actorId: string | null; actorKind?: string; entityId?: string | null }): void {
  auditLogger.log({ event: 'audit', orgId, entity: e.entity, action: e.action, actorType: e.actorKind ?? 'user', actorUid: e.actorKind === 'share_link' ? null : e.actorId, entityId: e.entityId ?? null }, 'audit');
}
