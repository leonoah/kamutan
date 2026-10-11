import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.js';
import { RoleSchema } from './roles.js';

export const OrgSettingsSchema = z
  .object({
    green_threshold: z.number().min(0).max(1).optional(),
    block_export_on_red: z.boolean().optional(),
    llm_enabled: z.boolean().optional(),
    llm_provider: z.string().max(64).optional(),
    llm_monthly_budget_usd: z.number().min(0).optional(),
    training_opt_in: z.boolean().optional(),
    default_waste_pct: z.number().min(0).max(100).optional(),
  })
  .strict();
export type OrgSettings = z.infer<typeof OrgSettingsSchema>;

export const OrgSlugSchema = z
  .string()
  .min(2)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lowercase letters, digits and dashes');

export const OrgSchema = z.object({
  id: UuidSchema,
  name: z.string().min(1).max(200),
  slug: OrgSlugSchema,
  settings: OrgSettingsSchema.default({}),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Org = z.infer<typeof OrgSchema>;

export const CreateOrgRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug: OrgSlugSchema,
  })
  .strict();
export type CreateOrgRequest = z.infer<typeof CreateOrgRequestSchema>;

export const MembershipSchema = z.object({
  id: UuidSchema,
  orgId: UuidSchema,
  userId: UuidSchema,
  role: RoleSchema,
  createdAt: TimestampSchema,
});
export type Membership = z.infer<typeof MembershipSchema>;

/** An org as seen by the current user (with their role). */
export const MyOrgSchema = OrgSchema.extend({ role: RoleSchema });
export type MyOrg = z.infer<typeof MyOrgSchema>;

export const MeResponseSchema = z.object({
  userId: UuidSchema,
  aal: z.enum(['aal1', 'aal2']).nullable(),
  orgs: z.array(MyOrgSchema),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;
