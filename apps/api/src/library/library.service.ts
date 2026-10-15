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
} from '@kamutan/contracts';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth-context';
import { BOQ_STORAGE, ImportTooLargeError, type BoqStorage } from '../boq/boq-storage';
import { ApiException, notFound } from '../common/api-exception';
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
  ) {}

  // ------------------------------------------------------------------ items
  async listItems(user: AuthContext, q: ListLibraryItemsQuery): Promise<LibraryItemPage> {
    await this.access.requireRole(user, q.orgId, 'viewer');
    let items = await this.boq.listLibraryItems(q.orgId, { ...(q.chapter ? { chapter: q.chapter } : {}), ...(q.active !== undefined ? { active: q.active } : {}) });
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
        });
      } catch (err) {
        this.logger.error({ err: (err as Error).message, importId }, 'library.import publish failed');
        await this.boq.failLibraryImport(orgId, importId, 'failed', { code: 'publish_failed', message: 'could not schedule the import' });
        throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'service_unavailable', 'could not schedule the import; start a new import');
      }
    }
    return this.view(orgId, queued.doc);
  }

  async getImport(user: AuthContext, orgId: string, importId: string): Promise<LibraryImportView> {
    await this.access.requireRole(user, orgId, 'viewer');
    if (!isUuid(importId)) throw notFound('import');
    const doc = await this.boq.getLibraryImport(orgId, importId);
    if (!doc) throw notFound('import');
    return this.view(orgId, doc);
  }

  private async view(orgId: string, doc: LibraryImport): Promise<LibraryImportView> {
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
    if (!items.some((t) => t.default)) {
      await this.boq.seedDefaults(orgId);
      items = await this.boq.listTemplates(orgId);
    }
    return { items };
  }

  async patchTemplate(user: AuthContext, orgId: string, templateId: string, patch: PatchBoqTemplateRequest): Promise<BoqTemplate> {
    await this.access.requireRole(user, orgId, 'admin');
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

  /** enabled / priority / itemCode (admin, audited); every project's BOQ becomes stale. */
  async patchRule(user: AuthContext, orgId: string, ruleId: string, patch: PatchBoqRuleRequest): Promise<BoqRule> {
    await this.access.requireRole(user, orgId, 'admin');
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
