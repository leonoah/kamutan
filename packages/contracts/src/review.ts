import { z } from 'zod';
import { TimestampSchema } from './common.js';
import { DocIdSchema, UidSchema } from './org.js';

export const CONFIDENCE_LEVELS = ['green', 'yellow', 'red'] as const;
export const ConfidenceLevelSchema = z.enum(CONFIDENCE_LEVELS);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;

export const REVIEW_ITEM_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export const ReviewItemStatusSchema = z.enum(REVIEW_ITEM_STATUSES);
export type ReviewItemStatus = z.infer<typeof ReviewItemStatusSchema>;

/** orgs/{orgId}/projects/{projectId}/reviewItems/{itemId} — yellow/red items and clusters. */
export const ReviewItemSchema = z.object({
  id: DocIdSchema,
  level: ConfidenceLevelSchema,
  reasons: z.array(z.string().max(64)),
  clusterId: z.string().nullable(),
  status: ReviewItemStatusSchema,
  sheetId: DocIdSchema.optional(),
  versionId: DocIdSchema.optional(),
  targetRef: z.string().max(128).optional(),
  riskScore: z.number().optional(),
  resolution: z.string().max(2000).nullable().optional(),
  resolvedBy: UidSchema.nullable().optional(),
  resolvedAt: TimestampSchema.nullable().optional(),
});
export type ReviewItem = z.infer<typeof ReviewItemSchema>;
/** Fields a client may change on a reviewItem (firestore.rules). */
export const REVIEW_ITEM_CLIENT_FIELDS = ['status', 'resolution', 'resolvedBy', 'resolvedAt'] as const;

export const CORRECTION_TARGET_TYPES = ['detection', 'room', 'link', 'legendEntry', 'reviewItem', 'measurement'] as const;
export const CORRECTION_ACTIONS = ['accept', 'reject', 'reclass', 'add', 'move', 'remove', 'setSupply', 'setLifecycle'] as const;

/** orgs/{orgId}/projects/{projectId}/corrections/{correctionId} — client-created, immutable. */
export const CorrectionSchema = z.object({
  id: DocIdSchema,
  authorId: UidSchema,
  createdAt: TimestampSchema,
  targetType: z.enum(CORRECTION_TARGET_TYPES),
  targetId: z.string().min(1).max(128),
  action: z.enum(CORRECTION_ACTIONS),
  sheetId: DocIdSchema.optional(),
  versionId: DocIdSchema.optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  note: z.string().max(2000).optional(),
});
export type Correction = z.infer<typeof CorrectionSchema>;
