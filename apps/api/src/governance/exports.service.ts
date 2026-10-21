import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  DocIdSchema,
  EXPORT_URL_TTL_SECONDS,
  JOB_TYPES,
  MARKED_PDF_JOB_SCHEMA_VERSION,
  MARKED_PDF_URL_TTL_SECONDS,
  MarkedPdfOptionsSchema,
  storagePaths,
  type CreateMarkedPdfRequest,
  type CreateMarkedPdfResponse,
  type ExportStatusResponse,
  type MarkedPdfOptions,
} from '@kamutan/contracts';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth-context';
import { BOQ_STORAGE, type BoqStorage } from '../boq/boq-storage';
import { ApiException, notFound } from '../common/api-exception';
import { GOVERNANCE_REPOSITORY, type GovernanceRepository } from '../db/governance-repository';
import { REPOSITORY, type Repository } from '../db/repository';
import { INGEST_QUEUE, type IngestQueue } from '../queue/ingest-queue';
import { sanitizeFilename } from '../uploads/filename';
import { GOVERNANCE_STORAGE, type GovernanceStorage } from './governance-storage';

const validId = (s: string) => DocIdSchema.safeParse(s).success;

/** "PDF מסומן - <project> - dd.mm.yyyy.pdf" (sanitised; never part of a storage path). */
export function markedPdfFileName(projectName: string, d: Date): string {
  const date = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  return sanitizeFilename(`PDF מסומן - ${projectName} - ${date}.pdf`, 'pdf');
}

/** Sprint 5 (FR-29, E2E-13): marked-PDF export requests + export status / download for both kinds. */
@Injectable()
export class ExportsService {
  private readonly logger = new Logger('ExportsService');

  constructor(
    private readonly access: AccessService,
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Inject(GOVERNANCE_REPOSITORY) private readonly gov: GovernanceRepository,
    @Inject(INGEST_QUEUE) private readonly queue: IngestQueue,
    @Inject(GOVERNANCE_STORAGE) private readonly storage: GovernanceStorage,
    @Inject(BOQ_STORAGE) private readonly boqStorage: BoqStorage,
  ) {}

  /** Creates exports/{id} (queued) + job + audit, publishes `export.marked_pdf`. 409 when the project has no BOQ lines/sheets. */
  async createMarkedPdf(user: AuthContext, projectId: string, req: CreateMarkedPdfRequest, traceparent: string): Promise<CreateMarkedPdfResponse> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'editor');
    const project = await this.repo.getProject(orgId, projectId);
    if (!project) throw notFound('project');
    if (!project.boq?.latestBuildId) throw new ApiException(HttpStatus.CONFLICT, 'not_ready', 'build the BOQ before exporting a marked PDF');
    if (req.sheetIds) {
      for (const sid of req.sheetIds) {
        const sheet = await this.repo.getSheet(orgId, projectId, sid);
        if (!sheet) throw notFound('sheet');
      }
    }
    const options: MarkedPdfOptions = MarkedPdfOptionsSchema.parse({ legend: true, ...req.options });
    const { record, jobId } = await this.gov.createMarkedPdfExport(orgId, projectId, { sheetIds: req.sheetIds, versionIds: null, options, shareLinkId: null }, user.uid, JOB_TYPES.exportMarkedPdf);
    try {
      await this.publish(orgId, projectId, record.id, jobId, req.sheetIds, null, options, traceparent);
    } catch (err) {
      this.logger.error({ err: (err as Error).message, exportId: record.id }, 'export.marked_pdf publish failed');
      await this.gov.failExport(orgId, projectId, record.id, jobId, { code: 'publish_failed', message: 'could not schedule the export' });
      throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'service_unavailable', 'could not schedule the marked PDF export; retry');
    }
    return { exportId: record.id, jobId };
  }

  /** Publishes the worker job (also used for the per-link PDF of share links). */
  publish(orgId: string, projectId: string, exportId: string, jobId: string, sheetIds: string[] | null, versionIds: Record<string, string> | null, options: MarkedPdfOptions, traceparent: string | null) {
    return this.queue.publish({
      schemaVersion: MARKED_PDF_JOB_SCHEMA_VERSION,
      type: JOB_TYPES.exportMarkedPdf,
      jobId,
      orgId,
      projectId,
      exportId,
      sheetIds,
      versionIds,
      options,
      storagePath: storagePaths.markedPdf(orgId, projectId, exportId),
      traceparent,
    });
  }

  /** Status of an export (both kinds) + a signed download URL when ready (marked PDF 15 min, xlsx 2 min). */
  async get(user: AuthContext, projectId: string, exportId: string): Promise<ExportStatusResponse> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'viewer');
    if (!validId(exportId)) throw notFound('export');
    const [record, project] = await Promise.all([this.gov.getExport(orgId, projectId, exportId), this.repo.getProject(orgId, projectId)]);
    if (!record || !project) throw notFound('export');
    if (record.status !== 'ready') return { export: record, url: null, expiresAt: null, fileName: null };
    const created = new Date(record.createdAt);
    if (record.kind === 'marked_pdf') {
      // Path derived from ids, never from the stored (worker-writable) string.
      const path = storagePaths.markedPdf(orgId, projectId, exportId);
      const fileName = markedPdfFileName(project.name, created);
      const signed = await this.storage.signMarkedPdf(path, fileName, MARKED_PDF_URL_TTL_SECONDS);
      await this.repo.appendAudit(orgId, { actorId: user.uid, entity: 'exports', entityId: exportId, action: 'download', after: { projectId, kind: 'marked_pdf' } });
      return { export: { ...record, storagePath: path }, url: signed.url, expiresAt: signed.expiresAt.toISOString(), fileName };
    }
    const path = storagePaths.boqExportFile(orgId, projectId, exportId);
    const fileName = sanitizeFilename(`כתב כמויות - ${project.name}.xlsx`, 'xlsx');
    const signed = await this.boqStorage.signExport(path, fileName, EXPORT_URL_TTL_SECONDS);
    await this.repo.appendAudit(orgId, { actorId: user.uid, entity: 'exports', entityId: exportId, action: 'download', after: { projectId, kind: 'xlsx' } });
    return { export: { ...record, storagePath: path }, url: signed.url, expiresAt: signed.expiresAt.toISOString(), fileName };
  }
}
