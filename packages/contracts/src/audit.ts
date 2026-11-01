import { z } from 'zod';
import { Sha256HexSchema, TimestampSchema } from './common.js';
import { BOQ_STATUS_HE } from './boq.js';
import { DocIdSchema, UidSchema } from './org.js';
import { SYMBOL_CLASS_INFO, type SymbolClass } from './taxonomy.js';

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
  items: z.array(
    AuditEventSchema.extend({
      actorName: z.string().max(200).nullable(),
      /** Stage 10 (A-UI-13): readable Hebrew one-liner of the event (`auditSummaryHe`), e.g. "תיקון על השרטוט · הוספת פריט ידני · שקע כפול". */
      summary: z.string().max(500).optional(),
      /** Stage 10: Hebrew name of the entity / action (`AUDIT_ENTITY_HE`, `AUDIT_ACTION_HE`). */
      entityLabel: z.string().max(100).optional(),
      actionLabel: z.string().max(100).optional(),
    }),
  ),
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
  /**
   * Security gate F-8: the chain tip does not match `auditMeta/head` (hash / count) — the newest events were deleted
   * or the head was rewritten. Absent/false when it matches (or no head doc exists, legacy logs).
   */
  headMismatch: z.boolean().optional(),
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
  /**
   * status: 'draft'|'reviewed'|'approved'; qtyOverride: the effective qty before (previous override, else the computed
   * qty — Stage 10 A-API-08) → number|null; note: null (text never stored); correction: null.
   */
  before: z.unknown(),
  after: z.unknown(),
  reason: z.string().max(500).nullable(),
  /** Stage 10 (A-UI-13 / A-UI-08): readable Hebrew one-liner, e.g. "תיקון על השרטוט · הוספת פריט ידני · שקע כפול". */
  summary: z.string().max(500).optional(),
  /** Stage 10: audit event id / correction id the item came from (stable tie-break key, A-UI-06). */
  sourceId: z.string().max(256).optional(),
});
export type LineHistoryItem = z.infer<typeof LineHistoryItemSchema>;

/**
 * GET /v1/projects/:pid/boq/lines/:lineId/history (viewer+ since Stage 10, A-API-07), newest first. Stage 10 (A-UI-06):
 * the order is total and stable — (at desc, then the later step of one change first: qtyOverride > note > status,
 * then corrections before audit items, then sourceId desc).
 */
export const LineHistoryResponseSchema = z.object({ lineId: DocIdSchema, items: z.array(LineHistoryItemSchema) });
export type LineHistoryResponse = z.infer<typeof LineHistoryResponseSchema>;

// ---------------------------------------------------------------------------
// Stage 10 (A-UI-13): readable Hebrew audit summaries
// ---------------------------------------------------------------------------

export const AUDIT_ENTITY_HE: Readonly<Record<string, string>> = Object.freeze({
  orgs: 'ארגון',
  members: 'חברי צוות',
  invites: 'הזמנות',
  projects: 'פרויקט',
  sheetSets: 'העלאת קובץ',
  sheets: 'גיליון',
  sheetVersions: 'גרסת גיליון',
  legendEntries: 'מקרא',
  unknownClusters: 'סמל לא מזוהה',
  itemLibrary: 'ספריית פריטים',
  libraryImports: 'ייבוא כתב כמויות',
  boqTemplates: 'תבנית כתב כמויות',
  boqRules: 'כללי כתב כמויות',
  boqBuilds: 'חישוב כתב כמויות',
  boqLines: 'שורת כתב כמויות',
  exports: 'ייצוא',
  corrections: 'תיקונים',
  roomSettings: 'הגדרות חדר',
  similarSearches: 'חיפוש דומים',
  shareLinks: 'קישור שיתוף',
  offboardingExports: 'ייצוא נתוני הארגון',
});

export const AUDIT_ACTION_HE: Readonly<Record<string, string>> = Object.freeze({
  create: 'יצירה',
  update: 'עדכון',
  confirm: 'אישור',
  reassign: 'שיוך מחדש',
  ignore: 'סימון כלא רלוונטי',
  resolve: 'זיהוי',
  set_regions: 'עדכון אזורים',
  reprocess: 'עיבוד מחדש',
  supersede: 'החלפה בגרסה מעודכנת',
  finalize: 'העלאה',
  request: 'בקשת חישוב',
  batch: 'החלה קבוצתית',
  revert: 'ביטול',
  revert_batch: 'ביטול קבוצתי',
  download: 'הורדה',
  revoke: 'ביטול',
  revoke_all: 'ביטול כל הקישורים',
  view: 'צפייה',
  update_settings: 'שינוי הגדרות',
  offboard: 'סיום התקשרות',
  revoke_sessions: 'ניתוק כל המשתמשים',
  ready: 'מוכן',
  invite: 'הזמנה',
  accept: 'הצטרפות',
  update_role: 'שינוי תפקיד',
  remove: 'הסרה',
  rebuild: 'חישוב מחדש',
  approval_invalidated: 'האישור בוטל – הכמות השתנתה',
});

const CORRECTION_KIND_HE: Readonly<Record<string, string>> = Object.freeze({
  add: 'הוספת פריט ידני',
  remove: 'הסרת פריט',
  reclassify: 'שינוי סוג',
  move: 'הזזת פריט',
  link: 'קישור מפסק לגוף תאורה',
  unlink: 'ביטול קישור',
  measure: 'מדידה ידנית',
  count: 'ספירה ידנית',
  accept: 'אישור פריט',
  reject: 'דחיית פריט',
});

const ROLE_HE: Readonly<Record<string, string>> = Object.freeze({ admin: 'מנהל', editor: 'עורך', reviewer: 'בודק', viewer: 'צופה' });
const SETTING_HE: Readonly<Record<string, string>> = Object.freeze({
  greenThreshold: 'סף "מאומת"',
  blockExportOnRed: 'חסימת ייצוא עם פריטים לבדיקה',
  llmEnabled: 'שימוש במודל שפה',
  trainingOptIn: 'שימוש בתיקונים לאימון',
  enabled: 'פעיל',
  priority: 'עדיפות',
  itemCode: 'סעיף',
});

const fmt = (v: unknown): string => {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'כן' : 'לא';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  if (typeof v === 'string') return (BOQ_STATUS_HE as Record<string, string>)[v] ?? ROLE_HE[v] ?? v;
  return '…';
};
const classHe = (c: unknown): string | null => (typeof c === 'string' && c in SYMBOL_CLASS_INFO ? SYMBOL_CLASS_INFO[c as SymbolClass].he : typeof c === 'string' ? c : null);
const changesHe = (changes: unknown): string[] =>
  changes && typeof changes === 'object'
    ? Object.entries(changes as Record<string, { from?: unknown; to?: unknown }>).map(([k, ch]) => `${SETTING_HE[k] ?? k}: ${fmt(ch?.from)} → ${fmt(ch?.to)}`)
    : [];

/**
 * Readable Hebrew one-liner of an audit event (ids/numbers only — the payload never holds free text except the
 * override justification, which is shown). Unknown entities/actions fall back to their raw names.
 */
export function auditSummaryHe(e: Pick<AuditEvent, 'entity' | 'action' | 'entityId' | 'after'>): string {
  const a = (e.after ?? {}) as Record<string, unknown>;
  const ent = AUDIT_ENTITY_HE[e.entity] ?? e.entity;
  const act = AUDIT_ACTION_HE[e.action] ?? e.action;
  const parts: string[] = [];
  switch (e.entity) {
    case 'corrections': {
      if (e.action === 'create') {
        parts.push('תיקון על השרטוט', CORRECTION_KIND_HE[String(a.kind)] ?? String(a.kind ?? ''));
        const c = classHe(a.class);
        if (c) parts.push(c);
        if (typeof a.itemCode === 'string') parts.push(`סעיף ${a.itemCode}`);
        if (typeof a.quantity === 'number') parts.push(`כמות ${fmt(a.quantity)}`);
      } else if (e.action === 'batch') {
        parts.push('תיקון קבוצתי', `${Array.isArray(a.correctionIds) ? a.correctionIds.length : fmt(a.count)} פריטים`);
      } else if (e.action === 'revert') {
        parts.push('ביטול תיקון', CORRECTION_KIND_HE[String(a.kind)] ?? '');
      } else if (e.action === 'revert_batch') {
        parts.push('ביטול תיקון קבוצתי', `${fmt(a.reverted)} פריטים`);
      }
      break;
    }
    case 'boqLines': {
      parts.push(typeof a.code === 'string' ? `שורה ${a.code}` : ent);
      if ('to' in a) parts.push(`סטטוס ${fmt(a.from)} → ${fmt(a.to)}`);
      if ('qtyOverride' in a) {
        const before = a.prevQtyOverride ?? a.qty;
        parts.push(a.qtyOverride === null ? `ביטול כמות ידנית (חזרה ל-${fmt(a.qty)})` : `כמות ידנית ${fmt(before)} → ${fmt(a.qtyOverride)}`);
        if (typeof a.reason === 'string' && a.reason) parts.push(`סיבה: ${a.reason.slice(0, 200)}`);
      }
      if (a.noteChanged === true) parts.push('הערה עודכנה');
      if (e.action === 'approval_invalidated') parts.push(`הכמות השתנתה ${fmt(a.fromQty ?? a.prevQty)} → ${fmt(a.toQty ?? a.qty)}`, 'האישור בוטל, נדרש אישור מחדש');
      if (e.action === 'rebuild') parts.push(`חישוב מחדש ${fmt(a.prevQty ?? a.from)} → ${fmt(a.qty ?? a.to)}`);
      break;
    }
    case 'orgs':
      parts.push(e.action === 'update_settings' ? 'שינוי הגדרות ארגון' : `${ent} · ${act}`, ...changesHe(a.changes));
      break;
    case 'boqRules':
      parts.push(`כלל ${e.entityId ?? ''}`.trim(), ...changesHe(a.changes ?? a));
      break;
    case 'members':
      parts.push(ent, act);
      if (typeof a.email === 'string') parts.push(a.email);
      if ('from' in a || 'to' in a) parts.push(`${fmt(a.from)} → ${fmt(a.to)}`);
      else if (typeof a.role === 'string') parts.push(fmt(a.role));
      break;
    case 'invites':
      parts.push(ent, act);
      if (typeof a.email === 'string') parts.push(a.email);
      if (typeof a.role === 'string') parts.push(fmt(a.role));
      break;
    case 'exports':
      parts.push(ent, act, a.kind === 'marked_pdf' ? 'PDF מסומן' : 'Excel');
      break;
    case 'shareLinks':
      parts.push(ent, act);
      if (typeof a.days === 'number') parts.push(`${a.days} ימים`);
      break;
    case 'sheets':
    case 'sheetVersions':
    case 'sheetSets':
      parts.push(ent, act);
      if (typeof a.discipline === 'string') parts.push(a.discipline);
      break;
    case 'legendEntries':
    case 'unknownClusters': {
      parts.push(ent, act);
      const c = classHe(a.class ?? a.to);
      if (c) parts.push(c);
      break;
    }
    default:
      parts.push(ent, act);
  }
  return parts.filter((p) => p && p.trim()).join(' · ').slice(0, 500);
}
