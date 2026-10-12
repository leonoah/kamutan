import { z } from 'zod';
import { Sha256HexSchema, TimestampSchema } from './common.js';
import { DocIdSchema, UidSchema } from './org.js';

/**
 * orgs/{orgId}/projects/{projectId}/shareLinks/{linkId} — written only by the API.
 * The raw token is never stored (SHA-256 hex only, SEC-26). Not returned to clients as-is.
 */
export const ShareLinkSchema = z.object({
  id: DocIdSchema,
  tokenHash: Sha256HexSchema,
  versionLock: z.array(DocIdSchema),
  expiresAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
  allowPdfDownload: z.boolean(),
  createdBy: UidSchema,
  createdAt: TimestampSchema,
});
export type ShareLink = z.infer<typeof ShareLinkSchema>;

export const SHARE_LINK_DEFAULT_DAYS = 14;
export const SHARE_LINK_MAX_DAYS = 90;
