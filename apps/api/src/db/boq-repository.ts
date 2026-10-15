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
  /** Create-if-missing: default template (only `default: true` when the org has no default yet) + default rules. */
  seedDefaults(orgId: string): Promise<{ templates: number; rules: number }>;
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
  /** Merge project.boq.{stale: true, staleReason, staleAt}. No-op when the project does not exist. */
  markStale(orgId: string, projectId: string, reason: StaleReason): Promise<void>;
  /** markStale for every project of the org (rule changes). */
  markOrgStale(orgId: string, reason: StaleReason): Promise<number>;

  // --- lines ------------------------------------------------------------------
  /** All lines of the project (≤ MAX_BOQ_LINES), unsorted. */
  listLines(orgId: string, projectId: string): Promise<BoqLine[]>;
  getLine(orgId: string, projectId: string, lineId: string): Promise<BoqLine | null>;
  /**
   * Transaction: re-reads the line, applies `planLinePatch` (state machine → RepoConflictError), writes, audit
   * `boqLines/update`. null when the line does not exist.
   */
  patchLine(orgId: string, projectId: string, lineId: string, req: PatchBoqLineRequest, actorUid: string): Promise<BoqLine | null>;

  // --- exports ----------------------------------------------------------------
  /** exports/{id} record + audit `exports/create` (one transaction). */
  createExport(orgId: string, projectId: string, doc: BoqExport): Promise<BoqExport>;
}
