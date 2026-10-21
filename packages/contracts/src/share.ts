import { z } from 'zod';
import { pageOf, Sha256HexSchema, TimestampSchema } from './common.js';
import { BoqLineStatusSchema } from './boq.js';
import { ConfidenceLevelSchema } from './review.js';
import { DocIdSchema, UidSchema } from './org.js';

/**
 * orgs/{orgId}/projects/{projectId}/shareLinks/{linkId} — written only by the API.
 * The raw token is never stored (SHA-256 hex only, SEC-26). NEVER client-readable (firestore.rules), never returned by
 * the API with `tokenHash` (see `ShareLinkViewSchema`).
 *
 * Sprint 5 additions are optional on the doc schema (Sprint-0 docs stay valid); the API view fills the defaults.
 */
export const ShareLinkSchema = z.object({
  id: DocIdSchema,
  tokenHash: Sha256HexSchema,
  /** Version ids locked at creation (values of `versionLockBySheet`). */
  versionLock: z.array(DocIdSchema),
  expiresAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
  allowPdfDownload: z.boolean(),
  createdBy: UidSchema,
  createdAt: TimestampSchema,
  // --- Sprint 5 (additive) ---
  /** sheetId → versionId locked at creation (the external viewer only ever sees these versions). */
  versionLockBySheet: z.record(DocIdSchema, DocIdSchema).optional(),
  label: z.string().min(1).max(100).optional(),
  recipient: z.string().max(200).nullable().optional(),
  /** Mask the title block on tiles / PDF and hide the project address (SEC-28, default true). */
  hideTitleBlock: z.boolean().optional(),
  viewCount: z.number().int().nonnegative().optional(),
  lastViewedAt: TimestampSchema.nullable().optional(),
  revokedBy: UidSchema.nullable().optional(),
  /** Why it was revoked: by a user, by org offboarding, or because the project was deleted. */
  revokeReason: z.enum(['user', 'offboarding', 'project_deleted']).nullable().optional(),
  /** exports/{id} of the per-link watermarked marked PDF (only when allowPdfDownload). */
  pdfExportId: DocIdSchema.nullable().optional(),
});
export type ShareLink = z.infer<typeof ShareLinkSchema>;

export const SHARE_LINK_DEFAULT_DAYS = 14;
export const SHARE_LINK_MAX_DAYS = 90;
/** Raw token = 32 random bytes, base64url without padding (43 chars). */
export const SHARE_TOKEN_BYTES = 32;
export const ShareTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'invalid share token');

export const SHARE_LINK_STATES = ['active', 'expired', 'revoked'] as const;
export const ShareLinkStateSchema = z.enum(SHARE_LINK_STATES);
export type ShareLinkState = z.infer<typeof ShareLinkStateSchema>;

/** API view of a link: never carries `tokenHash`; Sprint 5 fields always present. */
export const ShareLinkViewSchema = ShareLinkSchema.omit({ tokenHash: true }).extend({
  projectId: DocIdSchema,
  versionLockBySheet: z.record(DocIdSchema, DocIdSchema),
  label: z.string().min(1).max(100),
  recipient: z.string().max(200).nullable(),
  hideTitleBlock: z.boolean(),
  viewCount: z.number().int().nonnegative(),
  lastViewedAt: TimestampSchema.nullable(),
  revokedBy: UidSchema.nullable(),
  revokeReason: z.enum(['user', 'offboarding', 'project_deleted']).nullable(),
  pdfExportId: DocIdSchema.nullable(),
  /** Derived: revoked > expired > active. */
  state: ShareLinkStateSchema,
  /** First 6 chars of the id (shown in the watermark). */
  shortId: z.string().min(1).max(16),
});
export type ShareLinkView = z.infer<typeof ShareLinkViewSchema>;

/** POST /v1/projects/:pid/share-links (editor+). */
export const CreateShareLinkRequestSchema = z
  .object({
    days: z.number().int().min(1).max(SHARE_LINK_MAX_DAYS).default(SHARE_LINK_DEFAULT_DAYS),
    label: z.string().trim().min(1).max(100),
    recipient: z.string().trim().max(200).nullable().optional(),
    hideTitleBlock: z.boolean().default(true),
    allowPdfDownload: z.boolean().default(false),
  })
  .strict();
export type CreateShareLinkRequest = z.infer<typeof CreateShareLinkRequestSchema>;

/** The raw token is returned exactly once (in `token` and inside `url`); only its SHA-256 is stored. */
export const CreateShareLinkResponseSchema = z.object({
  link: ShareLinkViewSchema,
  url: z.string().url(),
  token: ShareTokenSchema,
});
export type CreateShareLinkResponse = z.infer<typeof CreateShareLinkResponseSchema>;

export const ShareLinkListSchema = z.object({ items: z.array(ShareLinkViewSchema) });
export type ShareLinkList = z.infer<typeof ShareLinkListSchema>;

export const RevokeShareLinkResponseSchema = z.object({ link: ShareLinkViewSchema });
export type RevokeShareLinkResponse = z.infer<typeof RevokeShareLinkResponseSchema>;

/**
 * shareTokens/{tokenHash} (top level, API-only, never client-readable): O(1) lookup of a public token → its link.
 * Deleted by the offboarding purge with the org.
 */
export const ShareTokenIndexSchema = z.object({
  orgId: DocIdSchema,
  projectId: DocIdSchema,
  linkId: DocIdSchema,
  createdAt: TimestampSchema,
});
export type ShareTokenIndex = z.infer<typeof ShareTokenIndexSchema>;

// ---------------------------------------------------------------------------
// Public, unauthenticated, read-only API: /v1/public/share/:token/...
// ---------------------------------------------------------------------------

/** Body of every 404 / 410 of the public API (identical for unknown, expired and revoked; status differs). */
export const SHARE_UNAVAILABLE_MESSAGE = 'share link not available';
/** 410 responses carry `x-share-state: expired | revoked` (so the viewer can show "פג תוקף" / "בוטל"). */
export const SHARE_STATE_HEADER = 'x-share-state';

export const PublicShareSheetSchema = z.object({
  sheetId: DocIdSchema,
  versionId: DocIdSchema,
  title: z.string().max(300),
  discipline: z.string().max(64).nullable(),
  floors: z.array(z.string().max(32)),
  page: z.object({ widthMm: z.number().positive(), heightMm: z.number().positive() }).nullable(),
  /** Tile pyramid of the locked version (served by `GET …/sheets/:sheetId/tiles/:z/:x/:y`), null while not ready. */
  tiles: z
    .object({
      tileSize: z.number().int().positive(),
      dpi: z.number().int().positive(),
      levels: z.number().int().positive(),
      widthPx: z.number().int().positive(),
      heightPx: z.number().int().positive(),
    })
    .nullable(),
});
export type PublicShareSheet = z.infer<typeof PublicShareSheetSchema>;

export const PublicShareMetaSchema = z.object({
  link: z.object({
    shortId: z.string(),
    label: z.string(),
    recipient: z.string().nullable(),
    expiresAt: TimestampSchema,
    createdAt: TimestampSchema,
    hideTitleBlock: z.boolean(),
    allowPdfDownload: z.boolean(),
    /** The text burned into tiles / PDF: "שותף עם {recipient|label} • {date} • {shortId}". */
    watermark: z.string(),
  }),
  project: z.object({
    name: z.string(),
    /** null when hideTitleBlock (SEC-28). */
    address: z.string().nullable(),
  }),
  sheets: z.array(PublicShareSheetSchema),
  /** Marked-PDF availability: null = not allowed; else the per-link export status. */
  pdf: z.object({ status: z.enum(['queued', 'running', 'ready', 'failed']) }).nullable(),
});
export type PublicShareMeta = z.infer<typeof PublicShareMetaSchema>;

/** A BOQ line as an external viewer sees it: no notes, no override reasons, no user ids. */
export const PublicShareBoqLineSchema = z.object({
  id: DocIdSchema,
  chapter: z.string(),
  code: z.string(),
  description: z.string(),
  unit: z.string(),
  /** Effective quantity (`qtyOverride ?? qty`). */
  qty: z.number().finite(),
  overridden: z.boolean(),
  level: ConfidenceLevelSchema,
  status: BoqLineStatusSchema,
  reasons: z.array(z.string()),
  floor: z.string().nullable(),
  byFloor: z.record(z.string(), z.number()),
});
export type PublicShareBoqLine = z.infer<typeof PublicShareBoqLineSchema>;

export const PublicShareBoqSchema = z.object({
  lines: z.array(PublicShareBoqLineSchema),
  floors: z.array(z.string()),
  counts: z.object({ lines: z.number().int(), green: z.number().int(), yellow: z.number().int(), red: z.number().int(), approved: z.number().int() }),
});
export type PublicShareBoq = z.infer<typeof PublicShareBoqSchema>;

const MmPoint = z.object({ x: z.number(), y: z.number() });
const MmBox = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

/** Overlay of one LOCKED sheet version (no raw text layer; items inside a hidden title block are dropped). */
export const PublicShareOverlaySchema = z.object({
  sheetId: DocIdSchema,
  versionId: DocIdSchema,
  detections: z.array(
    z.object({ id: z.string(), class: z.string(), centerMm: MmPoint, bboxMm: MmBox, level: ConfidenceLevelSchema, floor: z.string().nullable(), lineIds: z.array(z.string()) }),
  ),
  links: z.array(z.object({ id: z.string(), kind: z.string().nullable(), level: ConfidenceLevelSchema, switchIds: z.array(z.string()), luminaireIds: z.array(z.string()), lineIds: z.array(z.string()) })),
  rooms: z.array(z.object({ id: z.string(), name: z.string().nullable(), type: z.string().nullable(), areaM2: z.number(), level: ConfidenceLevelSchema, bboxMm: MmBox.nullable() })),
  /** The masked rectangle (paper mm) when hideTitleBlock, else null. */
  maskMm: MmBox.nullable(),
});
export type PublicShareOverlay = z.infer<typeof PublicShareOverlaySchema>;

export const ShareLinkPageSchema = pageOf(ShareLinkViewSchema);
