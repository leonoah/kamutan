/**
 * Sprint 8 — housekeeping (docs/agents/SPRINT8_BRIEF.md §3): delete a sheet set / a project, ≤ 100 sheets per project.
 *
 * Both deletes remove the Firestore docs (sheets + versions, and for a project every sub-collection) and the Storage
 * objects (`uploads/`, `infected/`, version artifacts, BOQ evidence / snapshots, exports, share snapshots), release the
 * storage quota (`project.storageBytes`), revoke the affected share links (`revokeReason`) and write an audit event.
 * The audit log (org level) and `jobs/*` survive.
 */
import { z } from 'zod';
import { DocIdSchema } from './org.js';

// ---------------------------------------------------------------------------
// DELETE /v1/projects/:pid/sheet-sets/:setId (editor+)
// ---------------------------------------------------------------------------

/**
 * Refused with 409 `conflict` while the set is still being processed (queued / processing, updated within
 * `SHEET_SET_DELETE_BUSY_MS`). Revokes every active share link that locks a sheet of the set (`sheet_set_deleted`);
 * marks the BOQ stale (`sheet`). Corrections / room settings / legend rows of the deleted sheets are deleted too.
 */
export const SHEET_SET_DELETE_BUSY_MS = 30 * 60 * 1000;
export const DeleteSheetSetResponseSchema = z.object({
  sheetSetId: DocIdSchema,
  deleted: z.object({
    sheets: z.number().int().nonnegative(),
    versions: z.number().int().nonnegative(),
    /** Other Firestore docs (corrections, room settings, legend entries, review items, reprocess requests). */
    docs: z.number().int().nonnegative(),
    /** Storage objects removed (source, infected copy, artifacts). */
    objects: z.number().int().nonnegative(),
  }),
  /** Bytes released from `project.storageBytes` (0 when the set was not counted / already released). */
  releasedBytes: z.number().int().nonnegative(),
  storageBytes: z.number().int().nonnegative(),
  /** Integration: the project's quota (hub meter "a מתוך b"). */
  storageQuotaBytes: z.number().int().positive(),
  revokedShareLinks: z.number().int().nonnegative(),
});
export type DeleteSheetSetResponse = z.infer<typeof DeleteSheetSetResponseSchema>;

// ---------------------------------------------------------------------------
// DELETE /v1/projects/:pid (admin + MFA + sign-in ≤ 10 min, typed confirmation)
// ---------------------------------------------------------------------------

/** Body of DELETE /v1/projects/:pid: the project's name typed by the admin (compared after NFC + trim). */
export const DeleteProjectRequestSchema = z.object({ confirmName: z.string().max(400) }).strict();
export type DeleteProjectRequest = z.infer<typeof DeleteProjectRequestSchema>;
export const DeleteProjectResponseSchema = z.object({
  projectId: DocIdSchema,
  deleted: z.object({ docs: z.number().int().nonnegative(), objects: z.number().int().nonnegative() }),
  releasedBytes: z.number().int().nonnegative(),
  revokedShareLinks: z.number().int().nonnegative(),
});
export type DeleteProjectResponse = z.infer<typeof DeleteProjectResponseSchema>;

/** The typed confirmation matches (NFC, trimmed, inner whitespace collapsed; case-sensitive). */
export const deleteConfirmationMatches = (typed: string, projectName: string): boolean => {
  const n = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim();
  return n(typed).length > 0 && n(typed) === n(projectName);
};
export const PROJECT_DELETE_PROMPT_HE = 'הפעולה תמחק לצמיתות את כל הגיליונות, כתב הכמויות, הייצואים וקישורי השיתוף של הפרויקט. להמשך הקלידו את שם הפרויקט.';
export const PROJECT_DELETE_MISMATCH_HE = 'השם שהוקלד אינו תואם לשם הפרויקט.';
export const SHEET_SET_DELETE_PROMPT_HE = 'הסט, הגיליונות שלו וכל העיבודים שלהם יימחקו לצמיתות, והשטח יתפנה במכסת האחסון.';
export const SHEET_SET_DELETE_BUSY_HE = 'הקובץ עדיין בעיבוד — אפשר למחוק אותו בסיום העיבוד.';

// ---------------------------------------------------------------------------
// ≤ 100 sheets per project (SEC-14)
// ---------------------------------------------------------------------------

export const MAX_SHEETS_PER_PROJECT = 100;
/** Error code (409) of the API and of the worker's sheet-set error when a split would exceed the limit. */
export const SHEET_LIMIT_ERROR = 'sheet_limit' as const;
/** The 409 `message` (Hebrew, shown as is). */
export const sheetLimitMessageHe = (current: number, max: number = MAX_SHEETS_PER_PROJECT): string =>
  `בפרויקט יש כבר ${current} גיליונות — המגבלה היא ${max} גיליונות לפרויקט. מחקו סט גיליונות שאינו בשימוש או פתחו פרויקט חדש.`;
/** True when adding `adding` sheets to `current` would exceed the limit (`adding` unknown → 1). */
export const exceedsSheetLimit = (current: number, adding = 1, max: number = MAX_SHEETS_PER_PROJECT): boolean => current + Math.max(adding, 1) > max;
