import { HttpStatus } from '@nestjs/common';
import { exportBlockingLines, type BoqLine, type Org } from '@kamutan/contracts';
import { ApiException } from '../common/api-exception';

/**
 * FR-31 export gate (Stage 10, A-API-04 / A-API-06): with the org's `blockExportOnRed` on (default), EVERY way of
 * handing quantities out — xlsx export, marked PDF, share link — is refused (409 `export_blocked`, `issues: [{path:
 * 'red', message: '<n>'}]`) while lines need a human: red lines not approved, and approved lines whose quantity changed
 * since the approval (`needsReapproval`).
 */
export function assertExportAllowed(org: Pick<Org, 'settings'> | null, lines: readonly BoqLine[], what = 'export'): void {
  if (!(org?.settings.blockExportOnRed ?? true)) return;
  const open = exportBlockingLines(lines).length;
  if (open > 0) {
    throw new ApiException(HttpStatus.CONFLICT, 'export_blocked', `${what} blocked by org policy: ${open} line(s) need review`, [{ path: 'red', message: String(open) }]);
  }
}
