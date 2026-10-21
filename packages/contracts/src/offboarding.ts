import { z } from 'zod';
import { Sha256HexSchema, TimestampSchema } from './common.js';
import { DocIdSchema, OrgStatusSchema, UidSchema } from './org.js';
import { ProcessingErrorSchema } from './sheets.js';

/** Sprint 5 (SEC-52). Recent sign-in required for offboarding actions (ID token `auth_time`). */
export const OFFBOARDING_RECENT_AUTH_SECONDS = 10 * 60;
/** Hard delete happens this long after the offboarding request. */
export const OFFBOARDING_GRACE_DAYS = 30;
/** Offboarding ZIP download URL lifetime. */
export const OFFBOARDING_EXPORT_URL_TTL_SECONDS = 24 * 60 * 60;

export const OFFBOARDING_EXPORT_STATUSES = ['queued', 'running', 'ready', 'failed'] as const;
export const OffboardingExportStatusSchema = z.enum(OFFBOARDING_EXPORT_STATUSES);

/**
 * orgs/{orgId}/offboardingExports/{exportId} — API-only. ZIP at orgs/{orgId}/offboarding/{exportId}.zip:
 * `manifest.json`, `projects/{projectId}/sources/{sheetSetId}.{ext}`, `projects/{projectId}/boq.xlsx`,
 * `projects/{projectId}/boq-lines.json`, `corrections.json`, `room-settings.json`, `rooms/{sheetId}.json`.
 */
export const OffboardingExportSchema = z.object({
  id: DocIdSchema,
  status: OffboardingExportStatusSchema,
  storagePath: z.string().max(1024),
  jobId: DocIdSchema.nullable(),
  createdBy: UidSchema,
  createdAt: TimestampSchema,
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  sha256: Sha256HexSchema.nullable(),
  counts: z
    .object({ projects: z.number().int().nonnegative(), sources: z.number().int().nonnegative(), files: z.number().int().nonnegative() })
    .nullable(),
  error: ProcessingErrorSchema.nullable(),
});
export type OffboardingExport = z.infer<typeof OffboardingExportSchema>;

/** POST /v1/orgs/:orgId/offboarding/export (admin + MFA + recent auth). */
export const CreateOffboardingExportRequestSchema = z.object({ includeSources: z.boolean().default(true) }).strict();
export type CreateOffboardingExportRequest = z.infer<typeof CreateOffboardingExportRequestSchema>;
export const CreateOffboardingExportResponseSchema = z.object({ export: OffboardingExportSchema, jobId: DocIdSchema });
export type CreateOffboardingExportResponse = z.infer<typeof CreateOffboardingExportResponseSchema>;

/** GET /v1/orgs/:orgId/offboarding/export/:exportId (admin; allowed while offboarding). */
export const OffboardingExportViewSchema = z.object({
  export: OffboardingExportSchema,
  url: z.string().url().nullable(),
  expiresAt: TimestampSchema.nullable(),
});
export type OffboardingExportView = z.infer<typeof OffboardingExportViewSchema>;

/** POST /v1/orgs/:orgId/offboarding (admin + MFA + recent auth + typed confirmation = the org name, exact after trim). */
export const OffboardOrgRequestSchema = z
  .object({
    confirm: z.string().trim().min(1).max(200),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();
export type OffboardOrgRequest = z.infer<typeof OffboardOrgRequestSchema>;

export const OffboardOrgResponseSchema = z.object({
  orgId: DocIdSchema,
  status: OrgStatusSchema,
  deleteAfter: TimestampSchema,
  revokedShareLinks: z.number().int().nonnegative(),
  revokedSessions: z.number().int().nonnegative(),
});
export type OffboardOrgResponse = z.infer<typeof OffboardOrgResponseSchema>;

/**
 * offboardingCertificates/{orgId} (top level, API/script-only, never client-readable) — the minimal tombstone kept
 * after the hard delete (SEC-52 (4)+(5)): ids, counts, hashes and timestamps only, no content, no names.
 */
export const DELETION_CERTIFICATE_SCHEMA = 'kamutan.deletion-certificate/1' as const;
export const DeletionCertificateSchema = z.object({
  schema: z.literal(DELETION_CERTIFICATE_SCHEMA),
  orgId: DocIdSchema,
  requestedBy: UidSchema.nullable(),
  requestedAt: TimestampSchema.nullable(),
  deleteAfter: TimestampSchema,
  purgedAt: TimestampSchema,
  counts: z.object({
    firestoreDocs: z.number().int().nonnegative(),
    storageObjects: z.number().int().nonnegative(),
    jobs: z.number().int().nonnegative(),
    shareTokens: z.number().int().nonnegative(),
    members: z.number().int().nonnegative(),
    projects: z.number().int().nonnegative(),
  }),
  hashes: z.object({
    /** Last audit-chain hash before deletion (proves which log was destroyed). */
    auditHead: Sha256HexSchema.nullable(),
    /** sha256 of the sorted list of deleted Firestore doc paths. */
    firestoreInventory: Sha256HexSchema,
    /** sha256 of the sorted list of deleted Storage object names. */
    storageInventory: Sha256HexSchema,
  }),
  /** sha256 of the canonical certificate without this field (integrity of the certificate itself). */
  certificateSha256: Sha256HexSchema,
});
export type DeletionCertificate = z.infer<typeof DeletionCertificateSchema>;
