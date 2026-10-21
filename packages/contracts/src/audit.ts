import { z } from 'zod';
import { Sha256HexSchema, TimestampSchema } from './common.js';
import { DocIdSchema, UidSchema } from './org.js';

/**
 * orgs/{orgId}/auditLog/{eventId} — append-only, per-org SHA-256 hash chain (SEC-35), written by the API in the same
 * transaction as the change. `hash = sha256((prevHash ?? '') + '\n' + canonicalJson(body))` where body =
 * {actorId, actorKind, entity, entityId, action, after, at (ISO)} — see apps/api/src/db/audit-chain.ts.
 * Admin-readable only (firestore.rules + `GET /v1/orgs/:orgId/audit`).
 */
export const AUDIT_ACTOR_KINDS = ['user', 'share_link', 'system'] as const;
export const AuditActorKindSchema = z.enum(AUDIT_ACTOR_KINDS);
export type AuditActorKind = z.infer<typeof AuditActorKindSchema>;

export const AuditEventSchema = z.object({
  id: DocIdSchema,
  actorId: z.string().max(128).nullable(),
  actorKind: z.string().max(32),
  /** Collection-style entity (`boqLines`, `shareLinks`, `orgs`, `exports`, …). */
  entity: z.string().max(64),
  entityId: z.string().max(256).nullable(),
  action: z.string().max(64),
  /** Ids / numbers / flags only — never file content, OCR text or free-text notes. */
  after: z.record(z.unknown()).nullable(),
  at: TimestampSchema,
  prevHash: Sha256HexSchema.nullable(),
  hash: Sha256HexSchema,
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/** GET /v1/orgs/:orgId/audit (admin). Newest first; cursor = last event id of the previous page. */
export const AuditQuerySchema = z
  .object({
    cursor: z.string().max(128).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    entity: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
    action: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
    /** Optional: only events of this entity id (e.g. one BOQ line). */
    entityId: z.string().regex(/^[A-Za-z0-9_.-]{1,256}$/).optional(),
  })
  .strict();
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

export const AuditPageSchema = z.object({
  items: z.array(AuditEventSchema.extend({ actorName: z.string().max(200).nullable() })),
  nextCursor: z.string().nullable(),
});
export type AuditPage = z.infer<typeof AuditPageSchema>;

/** GET /v1/orgs/:orgId/audit/verify (admin): recomputes every hash and link of the org's chain. */
export const AuditVerifyResponseSchema = z.object({
  ok: z.boolean(),
  checked: z.number().int().nonnegative(),
  /** Id of the first event whose hash or prevHash link does not verify; null when ok. */
  brokenAt: z.string().nullable(),
  /** Hash of the newest event (null for an empty log). */
  headHash: Sha256HexSchema.nullable(),
});
export type AuditVerifyResponse = z.infer<typeof AuditVerifyResponseSchema>;

// ---------------------------------------------------------------------------
// BOQ line history (FR-26, E2E-11)
// ---------------------------------------------------------------------------

export const LINE_HISTORY_ACTIONS = ['status', 'qtyOverride', 'note', 'rebuild', 'correction'] as const;
export const LineHistoryActionSchema = z.enum(LINE_HISTORY_ACTIONS);
export type LineHistoryAction = z.infer<typeof LineHistoryActionSchema>;

export const LineHistoryItemSchema = z.object({
  at: TimestampSchema,
  /** null for system actions (worker rebuilds). */
  by: z.object({ uid: UidSchema, displayName: z.string().max(200).nullable() }).nullable(),
  action: LineHistoryActionSchema,
  /** status: 'draft'|'reviewed'|'approved'; qtyOverride: number|null; note: null (text never stored); correction: null. */
  before: z.unknown(),
  after: z.unknown(),
  reason: z.string().max(500).nullable(),
});
export type LineHistoryItem = z.infer<typeof LineHistoryItemSchema>;

/** GET /v1/projects/:pid/boq/lines/:lineId/history (reviewer+), newest first. */
export const LineHistoryResponseSchema = z.object({ lineId: DocIdSchema, items: z.array(LineHistoryItemSchema) });
export type LineHistoryResponse = z.infer<typeof LineHistoryResponseSchema>;
