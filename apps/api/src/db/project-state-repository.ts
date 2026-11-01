import type { SupersedeMatchKind } from '@kamutan/contracts';

export const PROJECT_STATE_REPOSITORY = Symbol('PROJECT_STATE_REPOSITORY');

/** Project card counters (Stage 10, A-LIVE-02), computed from the live collections. */
export interface ProjectCounters {
  /** Current sheets (superseded old sheets excluded). */
  sheets: number;
  boqLines: number;
  green: number;
  yellow: number;
  red: number;
  /** Non-green lines not approved (an approved red/yellow line was handled by a person). */
  reviewOpen: number;
}

/** A sheet as the supersede matcher sees it. */
export interface MatchSheet {
  id: string;
  pageIndex: number;
  title: string | null;
  discipline: string | null;
  floors: string[];
  /** Status of the current version (null = none yet). */
  status: string | null;
}

export interface SupersedePlan {
  /** old sheet id → new sheet id | null */
  sheetMap: Record<string, string | null>;
  match: Record<string, SupersedeMatchKind>;
}

/** A pending revision: the new set and the set it replaces. */
export interface PendingSupersede {
  newSetId: string;
  oldSetId: string;
  newSetStatus: string;
}

/**
 * Stage 10 data access for project-level state the API owns: card counters (count aggregations, no doc reads) and the
 * revised-upload supersede (A-API-05). No authorization here (callers authorized the project's org first).
 */
export interface ProjectStateRepository {
  counters(orgId: string, projectId: string): Promise<ProjectCounters>;
  /**
   * Transaction: marks `newSetId` as a revision of `oldSetId` (`replacesSheetSetId`, `supersede.status = pending`) and
   * the old set `supersededBySetId` / `supersededAt`; audit `sheetSets/supersede {from, to, status: 'pending'}`.
   * Idempotent for the same pair; RepoConflictError('already_superseded') when the old set was replaced by another set,
   * ('not_found') when either set is missing, ('same_set') when they are equal.
   */
  startSupersede(orgId: string, projectId: string, oldSetId: string, newSetId: string, actorUid: string): Promise<void>;
  /** Revisions whose sheets are not matched yet. */
  pendingSupersedes(orgId: string, projectId: string): Promise<PendingSupersede[]>;
  /** Sheets of one set (+ their current version status). */
  setSheets(orgId: string, projectId: string, sheetSetId: string): Promise<MatchSheet[]>;
  /**
   * Transaction: applies a plan — old sheets `superseded: true, supersededBySetId, supersededBy, supersededMatch`, new
   * sheets `supersedes`, new set `supersede {status: matched, matchedAt, sheetMap}`, project BOQ stale (`sheet`), audit
   * `sheetSets/supersede {status: 'matched', matched, unmatched}`. No-op when the set is no longer pending.
   */
  applySupersede(orgId: string, projectId: string, pending: PendingSupersede, plan: SupersedePlan): Promise<boolean>;
}

const norm = (s: string | null) =>
  (s ?? '')
    .normalize('NFC')
    .replace(/[\s"'״׳`.,:;()\[\]\-–—/\\_]+/g, ' ')
    .trim()
    .toLowerCase();
const floorsKey = (f: readonly string[]) => [...f].sort().join(',');

/**
 * A-API-05 matching (decision): an old sheet matches the new sheet with the same title/number + discipline + floors;
 * then the same title alone (when unique on both sides); the rest pair up by page order. Old sheets left over → no
 * match (`supersededBy: null`, still superseded: the revision replaces the whole set).
 */
export function planSupersede(oldSheets: readonly MatchSheet[], newSheets: readonly MatchSheet[]): SupersedePlan {
  const sheetMap: Record<string, string | null> = {};
  const match: SupersedePlan['match'] = {};
  const freeNew = new Set(newSheets.map((s) => s.id));
  const byPage = (a: MatchSheet, b: MatchSheet) => a.pageIndex - b.pageIndex || a.id.localeCompare(b.id);
  const olds = [...oldSheets].sort(byPage);
  const news = [...newSheets].sort(byPage);
  const take = (o: MatchSheet, n: MatchSheet, kind: SupersedeMatchKind) => {
    sheetMap[o.id] = n.id;
    match[o.id] = kind;
    freeNew.delete(n.id);
  };
  // 1. title + discipline + floors
  for (const o of olds) {
    const t = norm(o.title);
    if (!t) continue;
    const n = news.find((x) => freeNew.has(x.id) && norm(x.title) === t && (x.discipline ?? '') === (o.discipline ?? '') && floorsKey(x.floors) === floorsKey(o.floors));
    if (n) take(o, n, 'title');
  }
  // 2. title alone, unique on both sides
  for (const o of olds) {
    if (o.id in sheetMap) continue;
    const t = norm(o.title);
    if (!t || olds.filter((x) => norm(x.title) === t).length !== 1) continue;
    const cands = news.filter((x) => freeNew.has(x.id) && norm(x.title) === t);
    if (cands.length === 1) take(o, cands[0] as MatchSheet, 'title');
  }
  // 3. page order
  const restNew = news.filter((x) => freeNew.has(x.id));
  for (const o of olds) {
    if (o.id in sheetMap) continue;
    const n = restNew.shift();
    if (n) take(o, n, 'page_order');
    else {
      sheetMap[o.id] = null;
      match[o.id] = 'none';
    }
  }
  return { sheetMap, match };
}

/** The revision is processed: the set is split (ready/failed) and every new sheet's current version is terminal. */
export function revisionProcessed(setStatus: string, newSheets: readonly MatchSheet[]): boolean {
  if (setStatus === 'failed') return true;
  if (setStatus !== 'ready' || newSheets.length === 0) return false;
  return newSheets.every((s) => s.status === 'ready' || s.status === 'failed');
}
