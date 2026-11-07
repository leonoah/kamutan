import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_BOQ_RULES,
  DocIdSchema,
  itemIdFor,
  ruleNeedsReseed,
  JOB_TYPES,
  LIBRARY_IMPORT_CONTENT_TYPE,
  LIBRARY_IMPORT_JOB_SCHEMA_VERSION,
  MAX_LIBRARY_IMPORT_BYTES,
  storagePaths,
  UPLOAD_TTL_SECONDS,
  type BoqRule,
  type BoqRuleList,
  type BoqTemplate,
  type BoqTemplateList,
  type CreateLibraryImportRequest,
  type CreateLibraryImportResponse,
  type CreateLibraryItemRequest,
  type ItemLibraryItem,
  type LibraryImport,
  type LibraryImportKind,
  type LibraryImportView,
  type LibraryItemPage,
  type ListLibraryItemsQuery,
  type PatchBoqRuleRequest,
  type PatchBoqTemplateRequest,
  type PatchLibraryItemRequest,
  type ApplyImportPricesRequest,
  type ApplyImportPricesResponse,
  type BulkLibraryPriceRequest,
  type BulkLibraryPriceResponse,
  DEFAULT_BOQ_TEMPLATE_ID,
  templateNeedsUpgrade,
} from '@kamutan/contracts';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth-context';
import { BOQ_STORAGE, ImportTooLargeError, type BoqStorage } from '../boq/boq-storage';
import { ApiException, notFound } from '../common/api-exception';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { BOQ_REPOSITORY, type BoqRepository } from '../db/boq-repository';
import { REPOSITORY, RepoConflictError, type Repository } from '../db/repository';
import { INGEST_QUEUE, type IngestQueue } from '../queue/ingest-queue';
import { sanitizeFilename } from '../uploads/filename';
import { detectSpreadsheetKind } from './spreadsheet-magic';

const isUuid = (s: string) => z.string().uuid().safeParse(s).success;
const validId = (s: string) => DocIdSchema.safeParse(s).success;

/** Org item library, past-BOQ imports, BOQ templates and rules (Sprint 3). Every method authorizes first. */
@Injectable()
export class LibraryService {
  private readonly logger = new Logger('LibraryService');

  constructor(
    private readonly access: AccessService,
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Inject(BOQ_REPOSITORY) private readonly boq: BoqRepository,
    @Inject(BOQ_STORAGE) private readonly storage: BoqStorage,
    @Inject(INGEST_QUEUE) private readonly queue: IngestQueue,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  // ------------------------------------------------------------------ items
  async listItems(user: AuthContext, q: ListLibraryItemsQuery): Promise<LibraryItemPage> {
    await this.access.requireRole(user, q.orgId, 'viewer');
    const opts = { ...(q.chapter ? { chapter: q.chapter } : {}), ...(q.active !== undefined ? { active: q.active } : {}) };
    let items = await this.boq.listLibraryItems(q.orgId, opts);
    if (items.length === 0 && !q.chapter && q.active === undefined) {
      // Stage 10 (A-LIVE-01): orgs created before the default library get it on first use (empty library only).
      const seeded = await this.boq.seedDefaults(q.orgId);
      if (seeded.items > 0) items = await this.boq.listLibraryItems(q.orgId, opts);
    }
    // Sprint 8: items with / without a price (the price list view).
    if (q.priced !== undefined) items = items.filter((i) => (i.price != null) === q.priced);
    if (q.q) {
      const needle = q.q.toLowerCase();
      items = items.filter((i) => i.code.toLowerCase().includes(needle) || i.description.toLowerCase().includes(needle));
    }
    const start = q.cursor ? items.filter((i) => i.id <= (q.cursor as string)).length : 0;
    const page = items.slice(start, start + q.limit);
    return { items: page, nextCursor: items.length > start + q.limit && page.length ? (page.at(-1) as ItemLibraryItem).id : null };
  }

  async createItem(user: AuthContext, req: CreateLibraryItemRequest): Promise<ItemLibraryItem> {
    await this.access.requireRole(user, req.orgId, 'editor');
    const id = itemIdFor(req.code, req.description);
    try {
      return await this.boq.createLibraryItem(
        req.orgId,
        {
          id,
          code: req.code,
          chapter: req.chapter,
          chapterTitle: req.chapterTitle ?? '',
          description: req.description,
          unit: req.unit,
          tags: req.tags ?? [],
          source: 'manual',
          sourceRef: null,
          active: true,
        },
        user.uid,
      );
    } catch (err) {
      if (err instanceof RepoConflictError) throw new ApiException(HttpStatus.CONFLICT, 'conflict', 'an item with this code and description already exists');
      throw err;
    }
  }

  async patchItem(user: AuthContext, orgId: string, itemId: string, patch: PatchLibraryItemRequest): Promise<ItemLibraryItem> {
    await this.access.requireRole(user, orgId, 'editor');
    if (!validId(itemId)) throw notFound('item');
    const item = await this.boq.patchLibraryItem(orgId, itemId, patch, user.uid);
    if (!item) throw notFound('item');
    return item;
  }

  /**
   * Sprint 8: POST /v1/library/prices (editor+) — bulk set / clear of item prices (≤ 500), chunked transactions, one
   * audit event per changed item (`itemLibrary/update {price, batchId}`). Unknown ids → `not_found`, same price → `unchanged`.
   */
  async bulkPrices(user: AuthContext, req: BulkLibraryPriceRequest): Promise<BulkLibraryPriceResponse> {
    await this.access.requireRole(user, req.orgId, 'editor');
    const batchId = `bp_${randomUUID().replace(/-/g, '')}`;
    const r = await this.boq.bulkSetLibraryPrices(req.orgId, req.items, user.uid, batchId);
    const order = new Map(req.items.map((x, i) => [x.itemId, i]));
    const byOrder = (a: { itemId: string }, b: { itemId: string }) => (order.get(a.itemId) ?? 0) - (order.get(b.itemId) ?? 0);
    this.logger.log({ orgId: req.orgId, batchId, updated: r.updated.length, skipped: r.skipped.length }, 'library prices updated');
    return { batchId, updated: r.updated.sort(byOrder), skipped: r.skipped.sort(byOrder) };
  }

  // ------------------------------------------------------------------ imports
  /**
   * Reserve an upload slot orgs/{orgId}/imports/{uuid}.{xls|xlsx} (storage.rules: create-only for editors, ≤ 20 MB,
   * spreadsheet content types). The client uploads with the Firebase JS SDK, then calls finalize.
   */
  async createImport(user: AuthContext, req: CreateLibraryImportRequest): Promise<CreateLibraryImportResponse> {
    await this.access.requireRole(user, req.orgId, 'editor');
    if (req.projectId && !(await this.repo.getProject(req.orgId, req.projectId))) throw notFound('project');
    const kind: LibraryImportKind = /\.xlsx\s*$/i.test(req.filename) ? 'xlsx' : 'xls';
    const id = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + UPLOAD_TTL_SECONDS * 1000).toISOString();
    const storagePath = storagePaths.libraryImport(req.orgId, id, kind);
    const doc: LibraryImport = {
      id,
      orgId: req.orgId,
      projectId: req.projectId ?? null,
      sourceKind: kind,
      storagePath,
      originalName: sanitizeFilename(req.filename, kind),
      sizeBytes: req.sizeBytes,
      status: 'awaiting_upload',
      jobId: null,
      createdBy: user.uid,
      createdAt: now.toISOString(),
      expiresAt,
      finalizedAt: null,
      stats: null,
      error: null,
      // Sprint 8: `prices` = fill item prices only; manual prices are replaced only with the explicit flag.
      mode: req.mode ?? 'library',
      overwriteManualPrices: req.overwriteManualPrices === true,
      // Integration: review before writing (the worker computes the report only; apply-prices writes).
      ...(req.dryRun === true ? { dryRun: true } : {}),
    };
    const created = await this.boq.createLibraryImport(req.orgId, doc);
    return { import: created, storagePath, contentType: LIBRARY_IMPORT_CONTENT_TYPE[kind], maxBytes: MAX_LIBRARY_IMPORT_BYTES, expiresAt };
  }

  /**
   * Verify the uploaded object (≤ 20 MB; xls = OLE CFB D0CF11E0…, xlsx = ZIP with [Content_Types].xml +
   * xl/workbook.xml; must match the declared kind — else the object is deleted and the import `rejected`), then
   * create the `library.import` job (+ audit) and publish it. Idempotent once queued.
   */
  async finalizeImport(user: AuthContext, orgId: string, importId: string, traceparent: string): Promise<LibraryImportView> {
    await this.access.requireRole(user, orgId, 'editor');
    if (!isUuid(importId)) throw notFound('import');
    const doc = await this.boq.getLibraryImport(orgId, importId);
    if (!doc) throw notFound('import');
    if (doc.createdBy !== user.uid) throw new ApiException(HttpStatus.FORBIDDEN, 'forbidden', 'only the uploader can finalize this import');
    if (doc.status !== 'awaiting_upload') return this.view(orgId, doc);
    const path = storagePaths.libraryImport(orgId, importId, doc.sourceKind); // derived, never the stored string

    const reject = async (status: HttpStatus, code: 'upload_expired' | 'payload_too_large' | 'unsupported_file_type', message: string) => {
      await this.storage.removeImport(path).catch((err: unknown) => this.logger.warn({ err: (err as Error).message }, 'failed to remove import object'));
      await this.boq.failLibraryImport(orgId, importId, 'rejected', { code, message });
      throw new ApiException(status, code, message);
    };
    if (Date.parse(doc.expiresAt) < Date.now()) await reject(HttpStatus.GONE, 'upload_expired', 'upload slot expired; start a new import');

    let buf: Buffer | null;
    try {
      buf = await this.storage.readImport(path, MAX_LIBRARY_IMPORT_BYTES);
    } catch (err) {
      if (err instanceof ImportTooLargeError) return reject(HttpStatus.PAYLOAD_TOO_LARGE, 'payload_too_large', 'file exceeds 20MB');
      throw err;
    }
    if (!buf) throw new ApiException(HttpStatus.CONFLICT, 'upload_missing', 'uploaded object not found');
    const detected = detectSpreadsheetKind(buf);
    if (detected !== doc.sourceKind) {
      this.logger.warn({ orgId, importId, declared: doc.sourceKind, detected }, 'import magic-bytes rejection');
      return reject(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'unsupported_file_type', 'file content is not a spreadsheet of the declared type');
    }

    const queued = await this.boq.queueLibraryImport(orgId, importId, user.uid);
    if (!queued) throw notFound('import');
    if (queued.created && queued.jobId) {
      try {
        await this.queue.publish({
          schemaVersion: LIBRARY_IMPORT_JOB_SCHEMA_VERSION,
          type: JOB_TYPES.libraryImport,
          jobId: queued.jobId,
          orgId,
          projectId: doc.projectId,
          importId,
          storagePath: path,
          sourceKind: doc.sourceKind,
          traceparent,
          mode: doc.mode ?? 'library',
          overwriteManualPrices: doc.overwriteManualPrices === true,
          ...(doc.dryRun === true ? { dryRun: true } : {}),
        });
      } catch (err) {
        this.logger.error({ err: (err as Error).message, importId }, 'library.import publish failed');
        await this.boq.failLibraryImport(orgId, importId, 'failed', { code: 'publish_failed', message: 'could not schedule the import' });
        throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'service_unavailable', 'could not schedule the import; start a new import');
      }
    }
    return this.view(orgId, queued.doc);
  }

  /**
   * Integration: POST /library/imports/:id/apply-prices (editor+) — writes a reviewed dry-run price import: every
   * `planned` item + the `manual_price` conflicts listed in `overwriteItemIds` (explicit per-item choice). Claimed once
   * (`pricesAppliedAt`, 409 otherwise); items re-checked at write time; one audit event per write + one
   * `itemLibrary/import_prices {apply: true, …}` summary.
   */
  async applyPrices(user: AuthContext, importId: string, req: ApplyImportPricesRequest): Promise<ApplyImportPricesResponse> {
    await this.access.requireRole(user, req.orgId, 'editor');
    if (!isUuid(importId)) throw notFound('import');
    let imp: LibraryImport | null;
    try {
      imp = await this.boq.claimPriceApply(req.orgId, importId, user.uid);
    } catch (err) {
      if (err instanceof RepoConflictError) {
        const msg = { not_dry_run: 'the import was not a dry run (its prices are already written)', already_applied: 'the prices of this import were already applied', not_ready: 'the import has not finished' }[err.reason] ?? err.reason;
        throw new ApiException(HttpStatus.CONFLICT, err.reason === 'not_ready' ? 'not_ready' : 'conflict', msg, [{ path: 'importId', message: err.reason }]);
      }
      throw err;
    }
    if (!imp) throw notFound('import');
    const report = imp.stats?.prices;
    const overwrite = new Set(req.overwriteItemIds);
    const manual = (report?.conflictRows ?? []).filter((c) => c.reason === 'manual_price' && c.itemId);
    const entries = new Map<string, { itemId: string; amount: number; allowManual: boolean }>();
    for (const p of report?.planned ?? []) entries.set(p.itemId, { itemId: p.itemId, amount: p.amount, allowManual: false });
    for (const c of manual) if (overwrite.has(c.itemId as string)) entries.set(c.itemId as string, { itemId: c.itemId as string, amount: c.incoming, allowManual: true });
    const r = await this.boq.writeImportedPrices(req.orgId, importId, [...entries.values()], user.uid);
    const overwritten = r.written.filter((w) => w.overwroteManual).length;
    const kept = manual.filter((c) => !overwrite.has(c.itemId as string)).length + r.skipped.filter((s) => s.reason === 'manual_kept').length;
    await this.repo.appendAudit(req.orgId, {
      actorId: user.uid,
      entity: 'itemLibrary',
      entityId: null,
      action: 'import_prices',
      after: { importId, mode: imp.mode ?? 'prices', apply: true, applied: r.written.length, overwritten, kept, unmatched: report?.unmatched ?? 0, conflicts: report?.conflicts ?? 0, skipped: r.skipped.length },
    });
    this.logger.log({ orgId: req.orgId, importId, applied: r.written.length, overwritten, kept }, 'import prices applied');
    return { importId, applied: r.written.length, overwritten, kept, skipped: r.skipped, appliedAt: imp.pricesAppliedAt ?? new Date().toISOString() };
  }

  async getImport(user: AuthContext, orgId: string, importId: string): Promise<LibraryImportView> {
    await this.access.requireRole(user, orgId, 'viewer');
    if (!isUuid(importId)) throw notFound('import');
    const doc = await this.boq.getLibraryImport(orgId, importId);
    if (!doc) throw notFound('import');
    return this.view(orgId, doc);
  }

  private async view(orgId: string, doc0: LibraryImport): Promise<LibraryImportView> {
    let doc = doc0;
    // Sprint 8: the worker cannot append to the audit chain — the first read of a finished price import audits it once.
    if (doc.status === 'succeeded' && doc.stats?.prices && !doc.pricesAuditedAt) {
      const wrote = await this.boq.auditImportPrices(orgId, doc.id).catch((err: unknown) => {
        this.logger.warn({ err: (err as Error).message, orgId, importId: doc.id }, 'import price audit failed');
        return false;
      });
      if (wrote) doc = (await this.boq.getLibraryImport(orgId, doc.id)) ?? doc;
    }
    const job = doc.jobId ? await this.repo.getJob(doc.jobId) : null;
    return {
      ...doc,
      job: job && job.orgId === orgId ? { status: job.status, progress: job.progress, error: job.error ?? null } : null,
    };
  }

  // ------------------------------------------------------------------ templates
  async listTemplates(user: AuthContext, orgId: string): Promise<BoqTemplateList> {
    await this.access.requireRole(user, orgId, 'viewer');
    let items = await this.boq.listTemplates(orgId);
    // Sprint 6: also when the stored generic default is an older unedited seed (template v3 upgrade + library top-up).
    if (!items.some((t) => t.default) || items.some((t) => t.id === DEFAULT_BOQ_TEMPLATE_ID && templateNeedsUpgrade(t))) {
      await this.boq.seedDefaults(orgId);
      items = await this.boq.listTemplates(orgId);
    }
    return { items };
  }

  /** Admin + MFA + sign-in ≤ 10 min (Stage 10, A-API-02 / SEC-02). */
  async patchTemplate(user: AuthContext, orgId: string, templateId: string, patch: PatchBoqTemplateRequest): Promise<BoqTemplate> {
    await this.access.requireSensitiveAdmin(user, orgId, this.cfg.OFFBOARDING_REQUIRE_MFA);
    if (!validId(templateId)) throw notFound('template');
    const t = await this.boq.patchTemplate(orgId, templateId, patch, user.uid);
    if (!t) throw notFound('template');
    return t;
  }

  // ------------------------------------------------------------------ rules
  async listRules(user: AuthContext, orgId: string): Promise<BoqRuleList> {
    await this.access.requireRole(user, orgId, 'viewer');
    let items = await this.boq.listRules(orgId);
    const byId = new Map(items.map((r) => [r.id, r]));
    if (DEFAULT_BOQ_RULES.some((d) => ruleNeedsReseed(byId.get(d.id)))) {
      await this.boq.seedDefaults(orgId);
      items = await this.boq.listRules(orgId);
    }
    return { items };
  }

  /** enabled / priority / itemCode (admin + MFA + sign-in ≤ 10 min, audited); every project's BOQ becomes stale. */
  async patchRule(user: AuthContext, orgId: string, ruleId: string, patch: PatchBoqRuleRequest): Promise<BoqRule> {
    await this.access.requireSensitiveAdmin(user, orgId, this.cfg.OFFBOARDING_REQUIRE_MFA);
    if (!validId(ruleId)) throw notFound('rule');
    let rule: BoqRule | null;
    try {
      rule = await this.boq.patchRule(orgId, ruleId, patch, user.uid);
    } catch (err) {
      if (err instanceof RepoConflictError) {
        throw new ApiException(HttpStatus.BAD_REQUEST, 'validation_failed', 'the change makes the rule invalid', [{ path: 'itemCode', message: 'required for this rule kind' }]);
      }
      throw err;
    }
    if (!rule) throw notFound('rule');
    await this.boq.markOrgStale(orgId, 'rule').catch((err: unknown) => this.logger.warn({ err: (err as Error).message, orgId }, 'markOrgStale failed'));
    return rule;
  }
}
