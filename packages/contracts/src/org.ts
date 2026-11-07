import { z } from 'zod';
import { TimestampSchema } from './common.js';
import { RoleSchema } from './roles.js';

/** Firestore document id (auto ids are 20 chars; we also accept UUIDs and hashes). */
export const DocIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'invalid document id');
export type DocId = z.infer<typeof DocIdSchema>;

/** Firebase Auth uid. */
export const UidSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, 'invalid uid');

/** orgs/{orgId}.settings (ADR 0008). */
export const OrgSettingsSchema = z
  .object({
    llmEnabled: z.boolean(),
    blockExportOnRed: z.boolean(),
    greenThreshold: z.number().min(0).max(1),
    trainingOptIn: z.boolean().optional(),
    llmMonthlyBudgetUsd: z.number().min(0).optional(),
    /** Sprint 3: VAT of the export's "כולל מע\"מ" total (0.18 = 18%). */
    vatRate: z.number().min(0).max(1).optional(),
    /** Sprint 4: corrections / room settings schedule a debounced BOQ rebuild (default true). */
    autoRebuild: z.boolean().optional(),
    /** Sprint 7: storage quota per project in bytes (uploaded source files; default `DEFAULT_PROJECT_QUOTA_BYTES` = 2 GB). */
    projectQuotaBytes: z.number().int().positive().optional(),
  })
  .strict();
export type OrgSettings = z.infer<typeof OrgSettingsSchema>;

/** Sprint 7: default per-project storage quota (2 GB = 2 × 1024³ bytes) and the range an admin may set. */
export const DEFAULT_PROJECT_QUOTA_BYTES = 2 * 1024 ** 3;
export const PROJECT_QUOTA_MIN_BYTES = 100 * 1024 * 1024;
export const PROJECT_QUOTA_MAX_BYTES = 1024 ** 4;
/** Effective quota of an org (setting, else the default). */
export const projectQuotaOf = (settings: { projectQuotaBytes?: number | undefined } | null | undefined): number =>
  typeof settings?.projectQuotaBytes === 'number' && settings.projectQuotaBytes > 0 ? settings.projectQuotaBytes : DEFAULT_PROJECT_QUOTA_BYTES;

/** Sprint 8: default VAT (18%) and the highest rate an admin may set. */
export const DEFAULT_VAT_RATE = 0.18;
export const VAT_RATE_MAX = 0.5;
/** Effective VAT of an org (setting, else 18%). */
export const vatRateOf = (settings: { vatRate?: number | undefined } | null | undefined): number =>
  typeof settings?.vatRate === 'number' && Number.isFinite(settings.vatRate) && settings.vatRate >= 0 && settings.vatRate <= 1 ? settings.vatRate : DEFAULT_VAT_RATE;

export const DEFAULT_ORG_SETTINGS: Readonly<OrgSettings> = Object.freeze({
  llmEnabled: false,
  blockExportOnRed: true,
  greenThreshold: 0.98,
  trainingOptIn: false,
  llmMonthlyBudgetUsd: 30,
  vatRate: 0.18,
  autoRebuild: true,
});

/**
 * Sprint 5 (FR-31): what `PATCH /v1/orgs/:orgId/settings` (admin, audited) may change. Ranges are validated here;
 * the stored `OrgSettingsSchema` stays wider for backwards compatibility.
 */
export const GREEN_THRESHOLD_MIN = 0.9;
export const GREEN_THRESHOLD_MAX = 0.995;
export const PatchOrgSettingsRequestSchema = z
  .object({
    /** Reported against the calibration table's Wilson lower bound; never makes green MORE permissive than the table. */
    greenThreshold: z.number().finite().min(GREEN_THRESHOLD_MIN).max(GREEN_THRESHOLD_MAX).optional(),
    blockExportOnRed: z.boolean().optional(),
    llmEnabled: z.boolean().optional(),
    /** Opt-in: corrections may be used to train models (SEC: never without opt-in). */
    trainingOptIn: z.boolean().optional(),
    /** Sprint 7: per-project storage quota in bytes (100 MB … 1 TB). Lowering it below a project's usage blocks new uploads only. */
    projectQuotaBytes: z.number().int().min(PROJECT_QUOTA_MIN_BYTES).max(PROJECT_QUOTA_MAX_BYTES).optional(),
    /** Sprint 8: VAT of every BOQ total (fraction: 0.18 = 18%; 0 … 0.5). */
    vatRate: z.number().finite().min(0).max(VAT_RATE_MAX).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one setting is required' });
export type PatchOrgSettingsRequest = z.infer<typeof PatchOrgSettingsRequestSchema>;

/** Sprint 5 (SEC-52): `offboarding` = every access blocked except the offboarding export download; hard delete at `deleteAfter`. */
export const ORG_STATUSES = ['active', 'offboarding'] as const;
export const OrgStatusSchema = z.enum(ORG_STATUSES);
export type OrgStatus = z.infer<typeof OrgStatusSchema>;

/** orgs/{orgId} (DTO: doc fields + id; timestamps as ISO strings). */
export const OrgSchema = z.object({
  id: DocIdSchema,
  name: z.string().min(1).max(200),
  settings: OrgSettingsSchema,
  createdAt: TimestampSchema,
  /** Sprint 5 (absent = `active`). */
  status: OrgStatusSchema.optional(),
  /** Sprint 5: offboarding requested → hard delete after this time (requestedAt + 30 days). */
  deleteAfter: TimestampSchema.nullable().optional(),
  offboardingRequestedAt: TimestampSchema.nullable().optional(),
  offboardingRequestedBy: UidSchema.nullable().optional(),
});
export type Org = z.infer<typeof OrgSchema>;

export const CreateOrgRequestSchema = z.object({ name: z.string().trim().min(1).max(200) }).strict();
export type CreateOrgRequest = z.infer<typeof CreateOrgRequestSchema>;

/** orgs/{orgId}/members/{uid} — doc id == uid; `uid` duplicated for collection-group queries. */
export const MemberSchema = z.object({
  uid: UidSchema,
  role: RoleSchema,
  email: z.string().max(320).optional(),
  displayName: z.string().max(200).optional(),
  addedBy: UidSchema.optional(),
  createdAt: TimestampSchema,
});
export type Member = z.infer<typeof MemberSchema>;

/** An org as seen by the current user (with their role). */
export const MyOrgSchema = OrgSchema.extend({ role: RoleSchema });
export type MyOrg = z.infer<typeof MyOrgSchema>;

export const PatchOrgSettingsResponseSchema = z.object({ settings: OrgSettingsSchema });
export type PatchOrgSettingsResponse = z.infer<typeof PatchOrgSettingsResponseSchema>;

export const MeResponseSchema = z.object({
  uid: UidSchema,
  /** True when the ID token was issued after a second-factor sign-in. */
  mfa: z.boolean(),
  orgs: z.array(MyOrgSchema),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;
