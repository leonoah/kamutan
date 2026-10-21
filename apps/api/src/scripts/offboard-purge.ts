/**
 * SEC-52 (3)–(5): hard delete of offboarded orgs past `deleteAfter`, with a deletion certificate and a minimal tombstone.
 *
 *   node dist/scripts/offboard-purge.js [--org <orgId>] [--dry-run] [--out <dir>] [--now <ISO>]
 *
 * For every org with `status == offboarding` and `deleteAfter <= now` (or only `--org`):
 *   1. Storage: delete every object under `orgs/{orgId}/` (sources, artifacts, exports, evidence, the offboarding ZIP);
 *   2. Firestore: recursive delete of `orgs/{orgId}` + `jobs` where orgId + `shareTokens` of the org;
 *   3. write `offboardingCertificates/{orgId}` (ids, counts, inventory hashes, timestamps — no content, no names) and
 *      print / write the same certificate JSON (`kamutan.deletion-certificate/1`) for the customer.
 * Storage goes first so a crashed run is simply re-run (the org doc is still there until step 2). Idempotent.
 * Credentials: ADC only (never a key file in the repo).
 */
import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DELETION_CERTIFICATE_SCHEMA, DeletionCertificateSchema, type DeletionCertificate } from '@kamutan/contracts';
import { loadConfig } from '../config/config';
import { canonicalJson } from '../db/audit-chain';
import { createGovernanceRepository, createRepository } from '../db/database.module';
import type { GovernanceRepository } from '../db/governance-repository';
import { firebaseApp } from '../firebase/firebase-app';
import { FirebaseGovernanceStorage, type GovernanceStorage } from '../governance/governance-storage';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export interface PurgeOptions {
  now: Date;
  orgId?: string;
  dryRun?: boolean;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/** Builds the certificate (+ its own integrity hash). */
export function buildCertificate(input: Omit<DeletionCertificate, 'schema' | 'certificateSha256'>): DeletionCertificate {
  const body = { schema: DELETION_CERTIFICATE_SCHEMA, ...input };
  return DeletionCertificateSchema.parse({ ...body, certificateSha256: sha(canonicalJson(body)) });
}

/** Purges every due org (or `orgId` when due). Returns the certificates written (dry run: the due org ids only). */
export async function runPurge(gov: GovernanceRepository, storage: GovernanceStorage, opts: PurgeOptions): Promise<{ due: string[]; certificates: DeletionCertificate[] }> {
  const log = opts.log ?? (() => undefined);
  let due = await gov.listOrgsDueForPurge(opts.now);
  if (opts.orgId) due = due.filter((o) => o === opts.orgId);
  const certificates: DeletionCertificate[] = [];
  if (opts.dryRun) return { due, certificates };
  for (const orgId of due) {
    log('purging org', { orgId });
    const objects = await storage.deleteOrgObjects(orgId);
    const r = await gov.purgeOrg(orgId);
    const cert = buildCertificate({
      orgId,
      requestedBy: r.requestedBy,
      requestedAt: r.requestedAt,
      deleteAfter: r.deleteAfter ?? opts.now.toISOString(),
      purgedAt: new Date().toISOString(),
      counts: { firestoreDocs: r.docPaths.length, storageObjects: objects.length, jobs: r.jobs, shareTokens: r.shareTokens, members: r.members, projects: r.projects },
      hashes: { auditHead: r.auditHead, firestoreInventory: sha(r.docPaths.join('\n')), storageInventory: sha(objects.join('\n')) },
    });
    await gov.writeCertificate(cert);
    certificates.push(cert);
    log('org purged', { orgId, docs: r.docPaths.length, objects: objects.length });
  }
  return { due, certificates };
}

/** The certificate as ONE log line (R-A9). */
export function certificateLine(c: DeletionCertificate): string {
  return JSON.stringify(c);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  // The script never needs the upload secret; give the config loader a throwaway value when absent.
  const cfg = loadConfig({ UPLOAD_TOKEN_SECRET: 'x'.repeat(48), ...process.env });
  if (cfg.DATA_DRIVER !== 'firestore' || cfg.STORAGE_DRIVER !== 'firebase') throw new Error('offboard-purge needs DATA_DRIVER=firestore and STORAGE_DRIVER=firebase');
  const gov = createGovernanceRepository(createRepository(cfg));
  const storage = new FirebaseGovernanceStorage(firebaseApp(cfg), cfg.FIREBASE_STORAGE_BUCKET);
  const now = arg('--now') ? new Date(arg('--now') as string) : new Date();
  const out = arg('--out');
  const res = await runPurge(gov, storage, {
    now,
    ...(arg('--org') ? { orgId: arg('--org') as string } : {}),
    dryRun: process.argv.includes('--dry-run'),
    log: (msg, meta) => console.error(JSON.stringify({ msg, ...meta })),
  });
  if (out) mkdirSync(out, { recursive: true });
  for (const c of res.certificates) {
    // R-A9: one line on stdout (one Cloud Logging jsonPayload entry); the --out file stays pretty for the customer.
    if (out) writeFileSync(join(out, `deletion-certificate-${c.orgId}.json`), `${JSON.stringify(c, null, 2)}\n`);
    console.log(certificateLine(c));
  }
  console.error(JSON.stringify({ msg: 'done', due: res.due.length, purged: res.certificates.length, dryRun: process.argv.includes('--dry-run') }));
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  main().catch((err: unknown) => {
    console.error(JSON.stringify({ msg: 'offboard-purge failed', error: (err as Error).message }));
    process.exit(1);
  });
}
