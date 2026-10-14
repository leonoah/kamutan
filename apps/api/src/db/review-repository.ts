import {
  BOQ_BUILD_STUCK_MS,
  BOQ_REBUILD_MAX_WAIT_MS,
  CorrectionBatchSchema,
  CorrectionSchema,
  RoomSettingsSchema,
  SimilarCandidateSchema,
  SimilarExemplarSchema,
  type BoqBuild,
  type Correction,
  type CorrectionBatch,
  type CorrectionKind,
  type CreateCorrectionRequest,
  type ProcessingError,
  type RoomSettings,
  type SimilarCandidate,
  type SimilarExemplar,
  type SimilarSearch,
  type StaleReason,
} from '@kamutan/contracts';
import { isoDeep } from './boq-docs';
import type { Doc } from './mappers';

export const REVIEW_REPOSITORY = Symbol('REVIEW_REPOSITORY');

/** Hard cap of corrections read per project (list, queue overlay). */
export const MAX_CORRECTIONS = 10_000;

export interface NewCorrectionBatch {
  source: CorrectionBatch['source'];
  similarSearchId: string | null;
}

export interface ScheduleBuildInput {
  reason: StaleReason;
  actorUid: string;
  jobType: string;
  nowMs: number;
  debounceMs: number;
}

/** Result of `scheduleAutoBuild`: when `publish` is true the caller must publish a `boq.build` message for `jobId`. */
export interface ScheduleBuildResult {
  outcome: 'scheduled' | 'debounced' | 'followup' | 'off';
  build: BoqBuild | null;
  jobId: string | null;
  publish: boolean;
  notBeforeMs: number | null;
}

/**
 * Sprint 4 data access (corrections, room settings, similar searches, debounced rebuilds). Same contract as the other
 * repositories: NO authorization here — callers pass the org they authorized; every path is under orgs/{orgId}/…
 * (or jobs/* with that orgId). Mutations append to the org's audit hash chain in the same transaction.
 */
export interface ReviewRepository {
  // --- corrections ---------------------------------------------------------------
  /** Transaction: all corrections (+ the batch doc when `batch` is set, one batchId) + one audit event. */
  createCorrections(
    orgId: string,
    projectId: string,
    items: readonly CreateCorrectionRequest[],
    batch: NewCorrectionBatch | null,
    actorUid: string,
  ): Promise<{ corrections: Correction[]; batch: CorrectionBatch | null }>;
  getCorrection(orgId: string, projectId: string, correctionId: string): Promise<Correction | null>;
  /** Up to MAX_CORRECTIONS docs matching the equality filter (unordered). */
  listCorrections(orgId: string, projectId: string, filter: { sheetId?: string; batchId?: string }): Promise<Correction[]>;
  /** Transaction: sets revertedAt/revertedBy (RepoConflictError 'already_reverted'); audit `corrections/revert`. */
  revertCorrection(orgId: string, projectId: string, correctionId: string, actorUid: string): Promise<Correction | null>;
  getBatch(orgId: string, projectId: string, batchId: string): Promise<CorrectionBatch | null>;
  /** Transaction: reverts every not-yet-reverted item of the batch + the batch doc; audit `corrections/revert_batch`. */
  revertBatch(orgId: string, projectId: string, batchId: string, actorUid: string): Promise<{ batch: CorrectionBatch; reverted: number } | null>;

  // --- room settings ----------------------------------------------------------------
  getRoomSettings(orgId: string, projectId: string, sheetId: string, roomId: string): Promise<RoomSettings | null>;
  /** Doc ids (`{sheetId}__{roomId}`) of every stored room settings doc of the project. */
  listRoomSettingsIds(orgId: string, projectId: string): Promise<string[]>;
  /** Transaction: replaces the doc; audit `roomSettings/update` (numbers + flags only). */
  putRoomSettings(orgId: string, projectId: string, settings: Omit<RoomSettings, 'by' | 'at'>, actorUid: string): Promise<RoomSettings>;

  // --- similar searches ----------------------------------------------------------------
  /** Transaction: similarSearches/{id} (queued) + jobs/{jobId} (`symbols.find_similar`) + audit `similarSearches/request`. */
  createSimilarSearch(
    orgId: string,
    projectId: string,
    input: { exemplar: SimilarExemplar; scope: SimilarSearch['scope']; correctionId: string | null },
    actorUid: string,
    jobType: string,
  ): Promise<{ search: SimilarSearch; jobId: string }>;
  getSimilarSearch(orgId: string, projectId: string, searchId: string): Promise<SimilarSearch | null>;
  failSimilarSearch(orgId: string, projectId: string, searchId: string, jobId: string, error: ProcessingError): Promise<void>;

  // --- debounced rebuild ----------------------------------------------------------------
  /**
   * Transaction: marks project.boq stale (`reason`) and, unless org `settings.autoRebuild === false`:
   *  - an active QUEUED build exists (project.boq.pendingBuildId or .autoBuildId) → push its `debounceUntil` (no new build);
   *  - only a RUNNING build exists → create one follow-up build (`afterBuildId` = the running one);
   *  - nothing active → create a build (`trigger: auto`, `debounceUntil` = now + debounce) + jobs/{jobId} + audit.
   * Never more than one queued build per project → no double builds.
   */
  scheduleAutoBuild(orgId: string, projectId: string, input: ScheduleBuildInput): Promise<ScheduleBuildResult | null>;
}

// ---------------------------------------------------------------------------
// Shared, pure helpers (both implementations)
// ---------------------------------------------------------------------------

export interface ActiveBuildInfo {
  id: string;
  status: unknown;
  createdAtMs: number | null;
}

export type SchedulePlan =
  | { kind: 'off' }
  | { kind: 'debounce'; buildId: string; untilMs: number }
  | { kind: 'create'; afterBuildId: string | null; untilMs: number };

const isActiveBuild = (b: ActiveBuildInfo | null, nowMs: number): b is ActiveBuildInfo =>
  !!b && (b.status === 'queued' || b.status === 'running') && (b.createdAtMs === null || nowMs - b.createdAtMs < BOQ_BUILD_STUCK_MS);

/** Decision table of `scheduleAutoBuild` (see the port). */
export function planAutoBuild(autoRebuild: boolean, candidates: ReadonlyArray<ActiveBuildInfo | null>, nowMs: number, debounceMs: number): SchedulePlan {
  if (!autoRebuild) return { kind: 'off' };
  const active = candidates.filter((b): b is ActiveBuildInfo => isActiveBuild(b, nowMs));
  const queued = active.find((b) => b.status === 'queued');
  if (queued) {
    const cap = queued.createdAtMs === null ? Number.POSITIVE_INFINITY : queued.createdAtMs + BOQ_REBUILD_MAX_WAIT_MS;
    return { kind: 'debounce', buildId: queued.id, untilMs: Math.max(nowMs, Math.min(nowMs + debounceMs, cap)) };
  }
  const running = active.find((b) => b.status === 'running');
  return { kind: 'create', afterBuildId: running?.id ?? null, untilMs: nowMs + debounceMs };
}

const dropUndefined = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** Stored correction doc (without id); timestamps are added by the implementation. */
export function correctionDoc(c: CreateCorrectionRequest, batchId: string | null, actorUid: string): Doc {
  return dropUndefined({ ...c, batchId, by: actorUid, revertedAt: null, revertedBy: null });
}

/** API-written doc → DTO (null when malformed: never break a list on one bad doc). */
export function toCorrection(id: string, d: Doc): Correction | null {
  const r = CorrectionSchema.safeParse({ ...(isoDeep(d) as Doc), id });
  return r.success ? r.data : null;
}

export function toBatch(id: string, d: Doc): CorrectionBatch | null {
  const r = CorrectionBatchSchema.safeParse({ ...(isoDeep(d) as Doc), id });
  return r.success ? r.data : null;
}

export function toRoomSettings(d: Doc): RoomSettings | null {
  const r = RoomSettingsSchema.safeParse(isoDeep(d));
  return r.success ? r.data : null;
}

export function batchDoc(items: readonly CreateCorrectionRequest[], batch: NewCorrectionBatch, actorUid: string): Doc {
  const kinds: Partial<Record<CorrectionKind, number>> = {};
  for (const it of items) kinds[it.kind] = (kinds[it.kind] ?? 0) + 1;
  return {
    count: items.length,
    kinds,
    sheetIds: [...new Set(items.map((i) => i.sheetId))].sort(),
    source: batch.source,
    similarSearchId: batch.similarSearchId,
    by: actorUid,
    revertedAt: null,
    revertedBy: null,
  };
}

/** Audit payload of a correction create: ids / classes / codes only, never the free-text reason. */
export function correctionAudit(projectId: string, c: Correction): Record<string, unknown> {
  return {
    projectId,
    kind: c.kind,
    sheetId: c.sheetId,
    versionId: c.versionId,
    detectionId: c.detectionId,
    linkGroupId: c.linkGroupId,
    roomId: c.roomId,
    class: c.class,
    itemCode: c.itemCode,
    quantity: c.quantity,
    hasReason: c.reason !== null,
  };
}

export function batchAudit(projectId: string, b: CorrectionBatch, ids: readonly string[]): Record<string, unknown> {
  return { projectId, count: b.count, kinds: b.kinds, source: b.source, similarSearchId: b.similarSearchId, sheetIds: b.sheetIds, correctionIds: ids };
}

export function roomSettingsAudit(projectId: string, s: Omit<RoomSettings, 'by' | 'at'>, before: Doc | null): Record<string, unknown> {
  return {
    projectId,
    sheetId: s.sheetId,
    roomId: s.roomId,
    created: before === null,
    claddingHeightM: s.claddingHeightM,
    floorTiled: s.floorTiled,
    floorMaterialItemCode: s.floorMaterialItemCode,
    wallMaterialItemCode: s.wallMaterialItemCode,
    partialCladding: s.partialCladding.length,
    wasteFactor: s.wasteFactor,
    includeInWaterproofing: s.includeInWaterproofing,
    keepOpenings: s.keepOpenings?.length ?? 0,
    type: s.type ?? null,
  };
}

/**
 * Worker-written result doc → DTO, tolerant: malformed / duplicate candidates are dropped, a bad exemplar or status
 * makes the doc unreadable (null).
 */
export function toSimilarSearch(id: string, d: Doc): SimilarSearch | null {
  const x = isoDeep(d) as Doc;
  const ex = SimilarExemplarSchema.safeParse(x.exemplar);
  if (!ex.success) return null;
  const status = ['queued', 'running', 'succeeded', 'failed'].includes(x.status as string) ? (x.status as SimilarSearch['status']) : null;
  if (!status) return null;
  const seen = new Set<string>();
  const candidates: SimilarCandidate[] = [];
  for (const raw of Array.isArray(x.candidates) ? (x.candidates as unknown[]).slice(0, 500) : []) {
    const c = SimilarCandidateSchema.safeParse(raw);
    if (!c.success || seen.has(c.data.id) || (c.data.thumb !== null && c.data.thumb !== `${c.data.id}.webp`)) continue;
    seen.add(c.data.id);
    candidates.push(c.data);
  }
  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const e = x.error as { code?: unknown; message?: unknown } | null | undefined;
  return {
    id,
    status,
    exemplar: ex.data,
    scope: x.scope === 'sheet' ? 'sheet' : 'project',
    correctionId: typeof x.correctionId === 'string' ? x.correctionId : null,
    jobId: typeof x.jobId === 'string' ? x.jobId : null,
    requestedBy: String(x.requestedBy ?? ''),
    createdAt: typeof x.createdAt === 'string' ? x.createdAt : new Date(0).toISOString(),
    finishedAt: typeof x.finishedAt === 'string' ? x.finishedAt : null,
    candidates,
    thumbs: typeof x.thumbs === 'number' && Number.isInteger(x.thumbs) && x.thumbs >= 0 ? x.thumbs : candidates.filter((c) => c.thumb).length,
    error: e && typeof e.code === 'string' ? { code: e.code.slice(0, 64), message: String(e.message ?? '').slice(0, 500) } : null,
  };
}
