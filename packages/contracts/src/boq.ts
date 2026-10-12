import { z } from 'zod';
import { TimestampSchema } from './common.js';
import { DocIdSchema, UidSchema } from './org.js';
import { ConfidenceLevelSchema } from './review.js';

export const BOQ_LINE_STATUSES = ['draft', 'reviewed', 'approved'] as const;
export const BoqLineStatusSchema = z.enum(BOQ_LINE_STATUSES);
export type BoqLineStatus = z.infer<typeof BoqLineStatusSchema>;

/** Allowed client-side status transitions (reviewer/admin), mirrored in firestore.rules. */
export const BOQ_LINE_TRANSITIONS: Readonly<Record<BoqLineStatus, readonly BoqLineStatus[]>> = Object.freeze({
  draft: ['reviewed'],
  reviewed: ['approved', 'draft'],
  approved: ['reviewed'],
});

export const LIFECYCLES = ['existing', 'new', 'demolish'] as const;
export const SUPPLY_KINDS = ['contractor', 'client', 'existing'] as const;

/** BOQ item code is TEXT ("4.10" !== "4.1") in every layer (decision #9). */
export const ItemCodeSchema = z.string().min(1).max(32).regex(/^[0-9A-Za-z.\-/]+$/, 'invalid item code');

/** orgs/{orgId}/projects/{projectId}/boqLines/{lineId}. */
export const BoqLineSchema = z.object({
  id: DocIdSchema,
  chapter: z.string().max(32),
  code: ItemCodeSchema,
  description: z.string().max(2000),
  qty: z.number(),
  qtyOverride: z.number().nullable().optional(),
  unit: z.string().max(32),
  floor: z.string().max(16).nullable().optional(),
  lifecycle: z.enum(LIFECYCLES).optional(),
  supply: z.enum(SUPPLY_KINDS).optional(),
  /** Min level of its evidence (decision #7). */
  level: ConfidenceLevelSchema,
  reasons: z.array(z.string().max(64)).optional(),
  evidenceRef: z.string().max(1024).nullable().optional(),
  locked: z.boolean().optional(),
  status: BoqLineStatusSchema,
  reviewedBy: UidSchema.nullable().optional(),
  reviewedAt: TimestampSchema.nullable().optional(),
  approvedBy: UidSchema.nullable().optional(),
  approvedAt: TimestampSchema.nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});
export type BoqLine = z.infer<typeof BoqLineSchema>;
export const BOQ_LINE_CLIENT_FIELDS = ['status', 'reviewedBy', 'reviewedAt', 'approvedBy', 'approvedAt', 'note'] as const;
