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
  })
  .strict();
export type OrgSettings = z.infer<typeof OrgSettingsSchema>;

export const DEFAULT_ORG_SETTINGS: Readonly<OrgSettings> = Object.freeze({
  llmEnabled: false,
  blockExportOnRed: true,
  greenThreshold: 0.98,
  trainingOptIn: false,
  llmMonthlyBudgetUsd: 30,
  vatRate: 0.18,
  autoRebuild: true,
});

/** orgs/{orgId} (DTO: doc fields + id; timestamps as ISO strings). */
export const OrgSchema = z.object({
  id: DocIdSchema,
  name: z.string().min(1).max(200),
  settings: OrgSettingsSchema,
  createdAt: TimestampSchema,
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

export const MeResponseSchema = z.object({
  uid: UidSchema,
  /** True when the ID token was issued after a second-factor sign-in. */
  mfa: z.boolean(),
  orgs: z.array(MyOrgSchema),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;
