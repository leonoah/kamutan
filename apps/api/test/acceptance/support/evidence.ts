import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Stage-10 acceptance evidence. Written only when ACCEPTANCE_EVIDENCE_DIR is set (the tester sets it to
 * /home/claude/kamutan-data/acceptance/api); CI runs never write outside the repo.
 */
export function writeEvidence(name: string, data: unknown): void {
  const dir = process.env.ACCEPTANCE_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  writeFileSync(join(dir, name), body);
}
