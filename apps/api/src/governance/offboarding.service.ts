import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  DEFAULT_BOQ_TEMPLATE,
  DocIdSchema,
  JOB_TYPES,
  OFFBOARDING_EXPORT_JOB_SCHEMA_VERSION,
  OFFBOARDING_EXPORT_URL_TTL_SECONDS,
  OFFBOARDING_GRACE_DAYS,
  OFFBOARDING_RECENT_AUTH_SECONDS,
  PROJECT_UPLOAD_PATH_RE,
  storagePaths,
  type CreateOffboardingExportRequest,
  type CreateOffboardingExportResponse,
  type OffboardingExportJob,
  type OffboardingExportView,
  type OffboardOrgRequest,
  type OffboardOrgResponse,
  type PatchOrgSettingsRequest,
  type PatchOrgSettingsResponse,
} from '@kamutan/contracts';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth-context';
import { compareLines } from '../boq/boq.service';
import { buildBoqWorkbook } from '../boq/excel';
import { ApiException, notFound } from '../common/api-exception';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { BOQ_REPOSITORY, type BoqRepository } from '../db/boq-repository';
import { GOVERNANCE_REPOSITORY, type GovernanceRepository } from '../db/governance-repository';
import { REPOSITORY, type Repository } from '../db/repository';
import { ARTIFACT_READER, ArtifactTooLargeError, type ArtifactReader } from '../understanding/artifact-reader';
import { API_JOBS_QUEUE, type ApiJobsQueue } from './api-jobs-queue';
import { AUTH_ADMIN, type AuthAdmin } from './auth-admin';
import { GOVERNANCE_STORAGE, type GovernanceStorage } from './governance-storage';

const DAY_MS = 86_400_000;
const validId = (s: string) => DocIdSchema.safeParse(s).success;
const utf8 = (s: string) => new TextEncoder().encode(s);

/** Sprint 5 (FR-31, SEC-52): org settings, offboarding export (ZIP), offboarding itself. */
@Injectable()
export class OffboardingService {
  private readonly logger = new Logger('OffboardingService');

  constructor(
    private readonly access: AccessService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Inject(GOVERNANCE_REPOSITORY) private readonly gov: GovernanceRepository,
    @Inject(BOQ_REPOSITORY) private readonly boq: BoqRepository,
    @Inject(GOVERNANCE_STORAGE) private readonly storage: GovernanceStorage,
    @Inject(API_JOBS_QUEUE) private readonly jobs: ApiJobsQueue,
    @Inject(AUTH_ADMIN) private readonly authAdmin: AuthAdmin,
    @Optional() @Inject(ARTIFACT_READER) private readonly artifacts?: ArtifactReader,
  ) {}

  // ------------------------------------------------------------------ settings
  async patchSettings(user: AuthContext, orgId: string, req: PatchOrgSettingsRequest): Promise<PatchOrgSettingsResponse> {
    await this.access.requireRole(user, orgId, 'admin');
    const settings = await this.gov.patchOrgSettings(orgId, req, user.uid);
    if (!settings) throw notFound('org');
    if (req.greenThreshold !== undefined || req.blockExportOnRed !== undefined) {
      // greenThreshold changes what the worker may colour green; the BOQ of every project must be rebuilt to reflect it.
      await this.boq.markOrgStale(orgId, 'rule').catch((err: unknown) => this.logger.warn({ err: (err as Error).message, orgId }, 'markOrgStale failed'));
    }
    return { settings };
  }

  private async requireOffboardingAdmin(user: AuthContext, orgId: string) {
    await this.access.requireRole(user, orgId, 'admin', { requireMfa: this.cfg.OFFBOARDING_REQUIRE_MFA, allowOffboarding: true });
    this.access.requireRecentAuth(user, OFFBOARDING_RECENT_AUTH_SECONDS);
  }

  // ------------------------------------------------------------------ export ZIP
  async requestExport(user: AuthContext, orgId: string, req: CreateOffboardingExportRequest, traceparent: string): Promise<CreateOffboardingExportResponse> {
    await this.requireOffboardingAdmin(user, orgId);
    const { export: exp, jobId } = await this.gov.createOffboardingExport(orgId, req.includeSources, user.uid, JOB_TYPES.offboardingExport);
    try {
      await this.jobs.publish({ schemaVersion: OFFBOARDING_EXPORT_JOB_SCHEMA_VERSION, type: JOB_TYPES.offboardingExport, jobId, orgId, exportId: exp.id, includeSources: req.includeSources, traceparent });
    } catch (err) {
      this.logger.error({ err: (err as Error).message, orgId, exportId: exp.id }, 'offboarding.export publish failed');
      await this.gov.updateOffboardingExport(orgId, exp.id, { status: 'failed', error: { code: 'publish_failed', message: 'could not schedule the export' } });
      throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'service_unavailable', 'could not schedule the export; retry');
    }
    return { export: exp, jobId };
  }

  /** Allowed while offboarding (the one thing that still works). Signed URL 24 h when ready. */
  async getExport(user: AuthContext, orgId: string, exportId: string): Promise<OffboardingExportView> {
    await this.access.requireRole(user, orgId, 'admin', { allowOffboarding: true });
    if (!validId(exportId)) throw notFound('export');
    const exp = await this.gov.getOffboardingExport(orgId, exportId);
    if (!exp) throw notFound('export');
    if (exp.status !== 'ready') return { export: exp, url: null, expiresAt: null };
    const path = storagePaths.offboardingZip(orgId, exportId);
    const signed = await this.storage.signZip(path, `kamutan-export-${orgId}-${exp.createdAt.slice(0, 10)}.zip`, OFFBOARDING_EXPORT_URL_TTL_SECONDS);
    await this.repo.appendAudit(orgId, { actorId: user.uid, entity: 'offboardingExports', entityId: exportId, action: 'download', after: { sha256: exp.sha256 } });
    return { export: { ...exp, storagePath: path }, url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  }

  // ------------------------------------------------------------------ offboard
  async offboard(user: AuthContext, orgId: string, req: OffboardOrgRequest): Promise<OffboardOrgResponse> {
    await this.requireOffboardingAdmin(user, orgId);
    const org = await this.repo.getOrg(orgId);
    if (!org) throw notFound('org');
    if (req.confirm.trim() !== org.name.trim()) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'validation_failed', 'type the organization name exactly to confirm', [{ path: 'confirm', message: 'does not match the organization name' }]);
    }
    const deleteAfter = new Date(Date.now() + OFFBOARDING_GRACE_DAYS * DAY_MS);
    const r = await this.gov.startOffboarding(orgId, user.uid, deleteAfter, req.reason ?? null);
    if (!r) throw notFound('org');
    // Idempotent: a second call re-runs the revocations (cheap) but keeps the first deleteAfter.
    const revokedShareLinks = await this.gov.revokeAllShareLinks(orgId, user.uid);
    const members = await this.gov.listMembers(orgId);
    let revokedSessions = 0;
    for (const m of members) {
      try {
        await this.authAdmin.revokeRefreshTokens(m.uid);
        revokedSessions++;
      } catch (err) {
        this.logger.error({ err: (err as Error).message, orgId, uid: m.uid }, 'revokeRefreshTokens failed');
      }
    }
    await this.repo.appendAudit(orgId, { actorId: user.uid, entity: 'orgs', entityId: orgId, action: 'revoke_sessions', after: { members: members.length, revoked: revokedSessions } });
    this.logger.warn({ orgId, deleteAfter: r.org.deleteAfter, revokedShareLinks, revokedSessions }, 'org offboarding started');
    return { orgId, status: 'offboarding', deleteAfter: r.org.deleteAfter ?? deleteAfter.toISOString(), revokedShareLinks, revokedSessions };
  }

  // ------------------------------------------------------------------ export runner (topic api-jobs)
  /**
   * Builds the ZIP (streaming; sources passed through, JSON/xlsx deflated) into orgs/{o}/offboarding/{id}.zip.
   * Idempotent per export: a `ready` export is not rebuilt (Pub/Sub is at-least-once).
   */
  async runExport(job: OffboardingExportJob): Promise<void> {
    const { orgId, exportId } = job;
    const exp = await this.gov.getOffboardingExport(orgId, exportId);
    if (!exp || exp.status === 'ready') return;
    await this.gov.updateOffboardingExport(orgId, exportId, { status: 'running', startedAt: new Date().toISOString(), error: null });
    const path = storagePaths.offboardingZip(orgId, exportId);
    const out = this.storage.createZipWriter(path);
    const hash = createHash('sha256');
    let size = 0;
    let pressure: Promise<unknown> | null = null;
    let zipErr: Error | null = null;
    const zip = new Zip((err, chunk, final) => {
      if (err) {
        zipErr = err;
        return;
      }
      hash.update(chunk);
      size += chunk.length;
      if (!out.write(Buffer.from(chunk)) && !pressure) pressure = once(out, 'drain').finally(() => (pressure = null));
      if (final) out.end();
    });
    const drain = async () => {
      if (pressure) await pressure;
      if (zipErr) throw zipErr;
    };
    const addBytes = async (name: string, data: Uint8Array) => {
      const f = new ZipDeflate(name, { level: 6 });
      zip.add(f);
      f.push(data, true);
      await drain();
    };
    const addJson = (name: string, v: unknown) => addBytes(name, utf8(JSON.stringify(v, null, 2)));
    try {
      const counts = { projects: 0, sources: 0, files: 0 };
      const org = await this.repo.getOrg(orgId);
      const manifest: Record<string, unknown> = { schema: 'kamutan.offboarding-export/1', orgId, orgName: org?.name ?? null, exportId, createdAt: new Date().toISOString(), projects: [] as unknown[] };
      const templates = await this.boq.listTemplates(orgId);
      const template = templates.find((t) => t.default) ?? { ...DEFAULT_BOQ_TEMPLATE, updatedAt: null };
      for (const projectId of await this.gov.listProjectIds(orgId)) {
        const project = await this.repo.getProject(orgId, projectId);
        if (!project) continue;
        counts.projects++;
        const base = `projects/${projectId}`;
        const [sheetSets, sheets, corrections, roomSettings] = await Promise.all([
          this.gov.dumpProjectCollection(orgId, projectId, 'sheetSets'),
          this.gov.dumpProjectCollection(orgId, projectId, 'sheets'),
          this.gov.dumpProjectCollection(orgId, projectId, 'corrections'),
          this.gov.dumpProjectCollection(orgId, projectId, 'roomSettings'),
        ]);
        const lines = (await this.boq.listLines(orgId, projectId)).sort(compareLines);
        await addJson(`${base}/project.json`, project);
        await addJson(`${base}/boq-lines.json`, lines);
        await addJson(`${base}/corrections.json`, corrections);
        await addJson(`${base}/room-settings.json`, roomSettings);
        await addJson(`${base}/sheets.json`, sheets);
        counts.files += 5;
        if (lines.length) {
          const xlsx = await buildBoqWorkbook({ projectName: project.name, ...(org?.name ? { orgName: org.name } : {}), date: new Date(), template, lines, split: 'byFloor', markDraft: false, evidence: new Map(), vatRate: org?.settings.vatRate ?? 0.18, floorNames: Object.fromEntries(project.floors.map((f) => [f.code, f.name])) });
          await addBytes(`${base}/boq.xlsx`, xlsx);
          counts.files++;
        }
        // rooms of every current version (kamutan.rooms/1 as the worker wrote it)
        for (const s of sheets) {
          const vId = typeof s.data.currentVersionId === 'string' ? s.data.currentVersionId : null;
          if (!vId || !validId(s.id) || !validId(vId) || !this.artifacts) continue;
          let rooms: unknown = null;
          try {
            rooms = await this.artifacts.readJson(storagePaths.rooms(orgId, projectId, s.id, vId));
          } catch (err) {
            if (!(err instanceof ArtifactTooLargeError || err instanceof SyntaxError)) throw err;
          }
          if (rooms) {
            await addJson(`${base}/rooms/${s.id}.json`, rooms);
            counts.files++;
          }
        }
        const sources: Array<{ sheetSetId: string; name: unknown; file: string }> = [];
        if (job.includeSources) {
          for (const set of sheetSets) {
            const sp = typeof set.data.storagePath === 'string' ? set.data.storagePath : '';
            const m = PROJECT_UPLOAD_PATH_RE.exec(sp);
            if (!m || m[1] !== orgId || m[2] !== projectId) continue;
            const stream = await this.storage.openSource(sp);
            if (!stream) continue;
            const file = `${base}/sources/${set.id}.${m[4]}`;
            const f = new ZipPassThrough(file);
            zip.add(f);
            for await (const chunk of stream) {
              f.push(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk as string));
              await drain();
            }
            f.push(new Uint8Array(0), true);
            await drain();
            sources.push({ sheetSetId: set.id, name: set.data.name ?? null, file });
            counts.sources++;
            counts.files++;
          }
        }
        (manifest.projects as unknown[]).push({ id: projectId, name: project.name, lines: lines.length, corrections: corrections.length, sheets: sheets.length, sources });
      }
      manifest.counts = counts;
      await addJson('manifest.json', manifest);
      counts.files++;
      const finished = once(out, 'finish');
      const failed = once(out, 'error').then(([e]) => {
        throw e;
      });
      zip.end();
      await drain();
      await Promise.race([finished, failed]);
      await this.gov.updateOffboardingExport(orgId, exportId, { status: 'ready', finishedAt: new Date().toISOString(), sizeBytes: size, sha256: hash.digest('hex'), counts });
    } catch (err) {
      this.logger.error({ err: (err as Error).message, orgId, exportId }, 'offboarding export failed');
      (out as Writable).destroy();
      await this.gov.updateOffboardingExport(orgId, exportId, { status: 'failed', finishedAt: new Date().toISOString(), error: { code: 'export_failed', message: 'the export could not be built; retry' } });
      throw err;
    }
  }
}
