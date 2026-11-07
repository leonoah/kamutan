import type {
  BoqBuild,
  BoqExport,
  BoqLine,
  BoqRule,
  BoqTemplate,
  ItemLibraryItem,
  LibraryImport,
  PatchBoqLineRequest,
  PatchBoqRuleRequest,
  PatchBoqTemplateRequest,
  PatchLibraryItemRequest,
  ProcessingError,
  ProjectPricing,
  StaleReason,
} from '@kamutan/contracts';

export const BOQ_REPOSITORY = Symbol('BOQ_REPOSITORY');

/** Hard cap of lines read per project (GET /boq, export). */
export const MAX_BOQ_LINES = 5000;
/** Hard cap of items read per org library list. */
export const MAX_LIBRARY_ITEMS = 5000;

/**
 * Sprint 3 data access (library, templates, rules, imports, builds, lines, exports). Same contract as `Repository`:
 * NO authorization here — every method takes the `orgId` the service authorized and only touches orgs/{orgId}/...
 * (or jobs/* with that orgId). Mutations append to the org's audit hash chain in the same transaction.
 */
export interface BoqRepository {
  // --- library -------------------------------------------------------------
  listLibraryItems(orgId: string, opts: { chapter?: string; active?: boolean }): Promise<ItemLibraryItem[]>;
  getLibraryItem(orgId: string, itemId: string): Promise<ItemLibraryItem | null>;
  /** Transaction: RepoConflictError('exists') when the id is taken; audit `itemLibrary/create`. */
  createLibraryItem(orgId: string, item: Omit<ItemLibraryItem, 'updatedAt' | 'updatedBy'>, actorUid: string): Promise<ItemLibraryItem>;
  patchLibraryItem(orgId: string, itemId: string, patch: PatchLibraryItemRequest, actorUid: string): Promise<ItemLibraryItem | null>;
  /**
   * Sprint 8 bulk price edit: chunks of `BATCH_STATUS_CHUNK` items, one transaction each (items re-read inside it);
   * one `itemLibrary/update {price, batchId}` audit event per changed item. Missing → `not_found`, same price → `unchanged`.
   */
  bulkSetLibraryPrices(orgId: string, entries: ReadonlyArray<{ itemId: string; amount: number | null }>, actorUid: string, batchId: string): Promise<BulkPriceResult>;
  /**
   * Sprint 8: once per succeeded import with `stats.prices` — appends `itemLibrary/import_prices {importId, mode, rows,
   * applied, unchanged, unmatched, conflicts, skippedManual, overwriteManualPrices}` (actor = the uploader) and stamps
   * `pricesAuditedAt` (transaction, idempotent). Returns true when it wrote the event.
   */
  auditImportPrices(orgId: string, importId: string): Promise<boolean>;
  /**
   * Integration (apply-prices): transaction — the import must be `succeeded`, `dryRun`, carry `stats.prices.planned`
   * and not be applied yet (else RepoConflictError 'not_dry_run' | 'not_ready' | 'already_applied'); stamps
   * `pricesAppliedAt/By`. null when the import does not exist.
   */
  claimPriceApply(orgId: string, importId: string, actorUid: string): Promise<LibraryImport | null>;
  /**
   * Integration: writes imported prices (`source: 'import'`, `importId`, by = the applying user), chunked transactions,
   * every item re-read: missing / inactive → not_found; same amount → unchanged; manual price and not `allowManual` →
   * manual_kept. One `itemLibrary/update {code, price {from, to, source}, importId}` audit event per write.
   */
  writeImportedPrices(orgId: string, importId: string, entries: ReadonlyArray<{ itemId: string; amount: number; allowManual: boolean }>, actorUid: string): Promise<ImportedPriceResult>;

  // --- imports ---------------------------------------------------------------
  createLibraryImport(orgId: string, doc: Omit<LibraryImport, 'id'> & { id: string }): Promise<LibraryImport>;
  getLibraryImport(orgId: string, importId: string): Promise<LibraryImport | null>;
  /**
   * Transaction: requires status `awaiting_upload` (else returns the current doc with `created=false`); creates
   * jobs/{jobId} (`library.import`, queued), sets status `queued` + jobId + finalizedAt, audit `libraryImports/finalize`.
   */
  queueLibraryImport(orgId: string, importId: string, actorUid: string): Promise<{ doc: LibraryImport; jobId: string | null; created: boolean } | null>;
  /** Sets a terminal status (`rejected` after failed checks, `failed` after a publish error) + error; fails its job. */
  failLibraryImport(orgId: string, importId: string, status: 'rejected' | 'failed', error: ProcessingError): Promise<void>;

  // --- templates & rules -------------------------------------------------------
  /**
   * Create-if-missing: default template (only `default: true` when the org has no default yet) + default rules
   * (+ reseed of outdated `source: 'default'` rules) + Stage 10: the default item library when the org has NO item.
   */
  seedDefaults(orgId: string): Promise<{ templates: number; rules: number; items: number }>;
  listTemplates(orgId: string): Promise<BoqTemplate[]>;
  getTemplate(orgId: string, templateId: string): Promise<BoqTemplate | null>;
  /** Transaction; `default: true` unsets every other template's default; audit `boqTemplates/update`. */
  patchTemplate(orgId: string, templateId: string, patch: PatchBoqTemplateRequest, actorUid: string): Promise<BoqTemplate | null>;
  listRules(orgId: string): Promise<BoqRule[]>;
  /** Transaction + audit `boqRules/update` (before/after of the changed fields). */
  patchRule(orgId: string, ruleId: string, patch: PatchBoqRuleRequest, actorUid: string): Promise<BoqRule | null>;

  // --- builds ---------------------------------------------------------------
  /**
   * Transaction: when project.boq.pendingBuildId points at a queued/running build younger than BOQ_BUILD_STUCK_MS,
   * returns it (`deduplicated`). Otherwise creates boqBuilds/{id} (queued) + jobs/{jobId} (`boq.build`), sets
   * project.boq.pendingBuildId, audit `boqBuilds/request`. null when the project is gone.
   */
  requestBuild(orgId: string, projectId: string, actorUid: string, jobType: string): Promise<{ build: BoqBuild; jobId: string | null; deduplicated: boolean } | null>;
  /** Publish failure: build + job failed, pendingBuildId cleared. */
  failBuild(orgId: string, projectId: string, buildId: string, jobId: string, error: ProcessingError): Promise<void>;
  getBuild(orgId: string, projectId: string, buildId: string): Promise<BoqBuild | null>;
  /**
   * Stage 10 (A-API-06): transaction — when the build succeeded, lists `approvalsInvalidated` and has no
   * `approvalsAuditedAt` yet, appends one `boqLines/approval_invalidated` audit event per entry and stamps
   * `approvalsAuditedAt` (idempotent). Returns the number of events written.
   */
  auditApprovalsInvalidated(orgId: string, projectId: string, buildId: string): Promise<number>;
  /** Merge project.boq.{stale: true, staleReason, staleAt}. No-op when the project does not exist. */
  markStale(orgId: string, projectId: string, reason: StaleReason): Promise<void>;
  /** markStale for every project of the org (rule changes). */
  markOrgStale(orgId: string, reason: StaleReason): Promise<number>;
  /** Sprint 8: the project's builds, newest first (createdAt desc), ≤ limit. */
  listBuilds(orgId: string, projectId: string, limit: number): Promise<BoqBuild[]>;
  /**
   * Sprint 8: project `pricing.adjustmentPct` (null / 0 → 0) + stale-free audit `projects/update_pricing {from, to}`
   * (transaction). null when the project is gone.
   */
  setProjectPricing(orgId: string, projectId: string, adjustmentPct: number, actorUid: string): Promise<ProjectPricing | null>;

  // --- lines ------------------------------------------------------------------
  /** All lines of the project (≤ MAX_BOQ_LINES), unsorted. */
  listLines(orgId: string, projectId: string): Promise<BoqLine[]>;
  getLine(orgId: string, projectId: string, lineId: string): Promise<BoqLine | null>;
  /**
   * Transaction: re-reads the line, applies `planLinePatch` (state machine → RepoConflictError), writes, audit
   * `boqLines/update`. null when the line does not exist.
   */
  patchLine(orgId: string, projectId: string, lineId: string, req: PatchBoqLineRequest, actorUid: string): Promise<BoqLine | null>;
  /**
   * Sprint 6: bulk status. Chunks of `BATCH_STATUS_CHUNK` lines, one transaction each: every line is re-read and planned
   * with `planBatchStatus` (single-PATCH rules) inside it; one `boqLines/update` audit event per moved line (+ batchId).
   */
  batchLineStatus(
    orgId: string,
    projectId: string,
    lineIds: readonly string[],
    to: 'reviewed' | 'approved',
    opts: { includeRed: boolean; allowed: boolean; batchId: string },
    actorUid: string,
  ): Promise<BatchStatusResult>;

  // --- exports ----------------------------------------------------------------
  /** exports/{id} record + audit `exports/create` (one transaction). */
  createExport(orgId: string, projectId: string, doc: BoqExport): Promise<BoqExport>;
  /** Sprint 8: the newest BOQ Excel export of the project (not marked PDFs, not comparison exports), or null. */
  latestBoqExport(orgId: string, projectId: string): Promise<BoqExport | null>;
  /** Integration: BOQ Excel exports of the project, newest first (≤ limit; no marked PDFs / comparisons). */
  listBoqExports(orgId: string, projectId: string, limit: number): Promise<BoqExport[]>;
}

export interface ImportedPriceResult {
  written: Array<{ itemId: string; overwroteManual: boolean }>;
  skipped: Array<{ itemId: string; reason: 'not_found' | 'unchanged' | 'manual_kept' }>;
}

export interface BulkPriceResult {
  updated: Array<{ itemId: string; code: string; from: number | null; to: number | null }>;
  skipped: Array<{ itemId: string; reason: 'not_found' | 'unchanged' }>;
}

/** Lines per transaction of a bulk status change (each moved line = 1 update + 1 audit event + the audit head). */
export const BATCH_STATUS_CHUNK = 100;
export interface BatchStatusResult {
  updated: Array<{ lineId: string; from: BoqLine['status']; to: BoqLine['status'] }>;
  skipped: Array<{ lineId: string; reason: 'already' | 'forbidden' | 'red' | 'not_found' }>;
}
