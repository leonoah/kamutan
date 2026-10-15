import { createHash } from 'node:crypto';

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
