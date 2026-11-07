import { SHEET_SET_DELETE_BUSY_MS } from '@kamutan/contracts';
import type { Doc } from './mappers';
import { countedBytes } from './storage-usage';

export const HOUSEKEEPING_REPOSITORY = Symbol('HOUSEKEEPING_REPOSITORY');

/**
 * Sprint 8 (docs/agents/SPRINT8_BRIEF.md §3): deletes of a sheet set / a project. Same contract as the other
 * repositories: NO authorization here; every path is under orgs/{orgId}/projects/{projectId}/… except
 * `shareTokens/{hash}` of the project's links. Storage objects are removed by the service (GovernanceStorage).
 *
 * Both deletes run in two phases so a retry after a partial failure finishes the job:
 *  1. `begin…` — ONE transaction: the bookkeeping (storage released, links revoked, BOQ stale, audit) + a tombstone
 *     (`deletedAt` on the set / `deletingAt` on the project — the project is invisible to every read from then on);
 *  2. the service deletes the Storage objects, then `finish…` deletes the Firestore docs.
 */
export interface HousekeepingRepository {
  /**
   * Phase 1 of a sheet-set delete. null when the set does not exist; RepoConflictError('busy') while it is being
   * processed (queued / splitting and younger than SHEET_SET_DELETE_BUSY_MS). Idempotent: a set with `deletedAt`
   * returns its sheets again without a second release / audit.
   */
  beginSheetSetDelete(orgId: string, projectId: string, setId: string, actorUid: string): Promise<SheetSetDeleteBegin | null>;
  /** Phase 2: deletes the sheets (+ versions), their corrections / room settings / legend rows / review items /
   * reprocess requests, the marked-PDF export records listed, un-supersedes sheets the set had replaced, recounts
   * `stats.sheets`, deletes the set doc. Returns the number of docs deleted (sheets, versions, others). */
  finishSheetSetDelete(orgId: string, projectId: string, setId: string, plan: SheetSetDeleteBegin): Promise<{ sheets: number; versions: number; docs: number }>;

  /**
   * Phase 1 of a project delete: tombstone `deletingAt`, every active share link revoked (`project_deleted`, ONE
   * `shareLinks/revoke_all` event), audit `projects/delete`. null when the project does not exist (or is deleting).
   */
  beginProjectDelete(orgId: string, projectId: string, actorUid: string): Promise<ProjectDeleteBegin | null>;
  /** Phase 2: the project doc and every sub-collection (recursive) + the shareTokens of its links. Returns docs deleted. */
  finishProjectDelete(orgId: string, projectId: string, linkTokenHashes: readonly string[]): Promise<number>;
}

export interface SheetSetDeleteBegin {
  sheetIds: string[];
  /** Marked-PDF exports that rendered one of the sheets (records + objects are removed). */
  exportIds: string[];
  releasedBytes: number;
  storageBytes: number;
  revokedShareLinks: number;
  /** The set's stored source / infected objects (prefixes). */
  storagePath: string | null;
}

export interface ProjectDeleteBegin {
  name: string;
  releasedBytes: number;
  revokedShareLinks: number;
  /** Token hashes of every link of the project (their shareTokens index docs go in phase 2). */
  tokenHashes: string[];
}

/** Being processed (queued / splitting) and not stuck. */
export function sheetSetBusy(d: Doc, nowMs: number): boolean {
  if (d.status !== 'queued' && d.status !== 'splitting' && d.status !== 'uploaded') return false;
  const at = d.updatedAt ?? d.createdAt;
  const t = at instanceof Date ? at.getTime() : at && typeof (at as { toMillis?: unknown }).toMillis === 'function' ? (at as { toMillis(): number }).toMillis() : typeof at === 'string' ? Date.parse(at) : NaN;
  return Number.isFinite(t) && nowMs - t < SHEET_SET_DELETE_BUSY_MS;
}

/** Bytes a set still holds in the project's usage (0 when already released). */
export const setBytes = (d: Doc): number => countedBytes(d);

/** A share link that shows one of `sheetIds`. */
export const linkTouches = (link: Doc, sheetIds: ReadonlySet<string>): boolean => {
  const lock = link.versionLockBySheet && typeof link.versionLockBySheet === 'object' ? Object.keys(link.versionLockBySheet as Doc) : [];
  return lock.some((s) => sheetIds.has(s));
};

/** A marked-PDF export that rendered one of `sheetIds`. */
export const exportTouches = (e: Doc, sheetIds: ReadonlySet<string>): boolean => {
  if (e.kind !== 'marked_pdf') return false;
  const ids = Array.isArray(e.sheetIds) ? (e.sheetIds as unknown[]) : [];
  const vers = e.versionIds && typeof e.versionIds === 'object' ? Object.keys(e.versionIds as Doc) : [];
  return [...ids, ...vers].some((s) => typeof s === 'string' && sheetIds.has(s));
};
