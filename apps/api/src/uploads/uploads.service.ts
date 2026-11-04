import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  INGEST_JOB_SCHEMA_VERSION,
  JOB_TYPES,
  KIND_TO_CONTENT_TYPE,
  MAX_UPLOAD_BYTES,
  storagePaths,
  UPLOAD_TTL_SECONDS,
  DocIdSchema,
  FILE_INFECTED_ERROR,
  projectQuotaOf,
  quotaExceededMessageHe,
  UPLOAD_ERROR_MESSAGES_HE,
  type SheetSetStatusResponse,
  type CreateUploadRequest,
  type CreateUploadResponse,
  type FinalizeUploadRequest,
  type FinalizeUploadResponse,
  type SheetSet,
} from '@kamutan/contracts';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth-context';
import { ApiException, notFound } from '../common/api-exception';
import { PROJECT_STATE_REPOSITORY, type ProjectStateRepository } from '../db/project-state-repository';
import { QuotaExceededError, RepoConflictError, REPOSITORY, type Repository } from '../db/repository';
import { INGEST_QUEUE, type IngestQueue } from '../queue/ingest-queue';
import { kindFromFilename, sanitizeFilename } from './filename';
import { inspectStream, TooLargeError } from './inspect';
import { detectFileKind } from './magic-bytes';
import { OBJECT_STORAGE, type ObjectStorage } from './storage/object-storage';
import { UploadTokenError, UploadTokenSigner, type UploadTokenClaims } from './upload-token';

export const UPLOAD_TOKEN_SIGNER = Symbol('UPLOAD_TOKEN_SIGNER');

@Injectable()
export class UploadsService {
  private readonly logger = new Logger('UploadsService');

  constructor(
    private readonly access: AccessService,
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Inject(INGEST_QUEUE) private readonly queue: IngestQueue,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(UPLOAD_TOKEN_SIGNER) private readonly signer: UploadTokenSigner,
    @Optional() @Inject(PROJECT_STATE_REPOSITORY) private readonly state?: ProjectStateRepository,
  ) {}

  /**
   * Step 1: reserve an upload target. The client uploads directly to Cloud
   * Storage (resumable) at orgs/{orgId}/quarantine/{uuid} (SEC-13: no user
   * filename in the path; storage.rules allow create-only there for editors of
   * the org). No Firestore writes yet.
   */
  async createUpload(user: AuthContext, projectId: string, req: CreateUploadRequest): Promise<CreateUploadResponse> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'editor');
    const kind = kindFromFilename(req.filename);
    if (!kind) throw new ApiException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'unsupported_file_type', 'unsupported file extension');
    // Sprint 7: refuse early when the declared size cannot fit the project's quota (finalize re-checks atomically).
    const [project, org] = await Promise.all([this.repo.getProject(orgId, projectId), this.repo.getOrg(orgId)]);
    const quota = projectQuotaOf(org?.settings);
    const used = project?.storageBytes ?? 0;
    if (used + req.sizeBytes > quota) throw quotaExceeded(used, quota, req.sizeBytes);

    const fileId = randomUUID();
    const storagePath = storagePaths.quarantine(orgId, fileId);
    const exp = Math.floor(Date.now() / 1000) + UPLOAD_TTL_SECONDS;
    const uploadToken = this.signer.sign({
      v: 3,
      fid: fileId,
      org: orgId,
      prj: projectId,
      usr: user.uid,
      path: storagePath,
      name: sanitizeFilename(req.filename, kind),
      kind,
      size: req.sizeBytes,
      exp,
    });
    return {
      fileId,
      storagePath,
      uploadToken,
      contentType: KIND_TO_CONTENT_TYPE[kind],
      fileKind: kind,
      maxBytes: MAX_UPLOAD_BYTES,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  /**
   * Step 2 (SEC-13/14/15): stream the quarantined object once (size ≤ 100MB, sha256, magic bytes must match
   * the declared kind — else it is deleted and 413/415 returned). Only then: create sheetSets/{sha256} +
   * jobs/{jobId} + audit (dedupe by sha256 within the project), move the object to
   * orgs/{orgId}/projects/{projectId}/uploads/{sheetSetId}/source.{ext}, publish `ingest` and mark the set
   * `queued`. Idempotent per upload token: a retry after a failed publish re-publishes the same jobId.
   */
  async finalize(user: AuthContext, projectId: string, req: FinalizeUploadRequest, traceparent: string): Promise<FinalizeUploadResponse> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'editor');
    const claims = this.verifyToken(req.uploadToken);
    if (claims.prj !== projectId || claims.usr !== user.uid || claims.org !== orgId) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'bad_request', 'upload token does not match this project');
    }
    // Stage 10 (A-API-05): the set this revision replaces must exist in THIS project (404 like any foreign id).
    if (req.replacesSheetSetId) {
      const old = await this.repo.getSheetSet(orgId, projectId, req.replacesSheetSetId);
      if (!old) throw new ApiException(HttpStatus.NOT_FOUND, 'not_found', 'sheet set not found');
    }

    const stream = await this.storage.openRead(claims.path);
    if (!stream) {
      // Already moved by an earlier call with this token (e.g. publish failed afterwards): resume.
      const prior = await this.repo.findSheetSetByUploadFileId(orgId, projectId, claims.fid);
      if (!prior) throw new ApiException(HttpStatus.CONFLICT, 'upload_missing', 'uploaded object not found');
      if (req.replacesSheetSetId) await this.supersede(orgId, projectId, req.replacesSheetSetId, prior.id, user.uid);
      return this.publishIfNeeded(orgId, projectId, prior, true, traceparent);
    }

    let inspected;
    try {
      inspected = await inspectStream(stream, MAX_UPLOAD_BYTES);
    } catch (err) {
      if (err instanceof TooLargeError) {
        await this.discard(claims.path);
        throw new ApiException(HttpStatus.PAYLOAD_TOO_LARGE, 'payload_too_large', 'file exceeds 100MB');
      }
      throw err;
    }

    const detected = detectFileKind(inspected.head);
    if (!detected || detected !== claims.kind) {
      await this.discard(claims.path);
      this.logger.warn({ orgId, projectId, declared: claims.kind, detected }, 'magic-bytes rejection');
      throw new ApiException(
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        'unsupported_file_type',
        'file content does not match an allowed type for its extension',
      );
    }

    const sha256 = inspected.sha256;
    if (req.replacesSheetSetId && req.replacesSheetSetId === sha256) {
      await this.discard(claims.path);
      throw new ApiException(HttpStatus.CONFLICT, 'conflict', 'the revised file is identical to the set it replaces', [{ path: 'replacesSheetSetId', message: 'same_set' }]);
    }
    const destPath = storagePaths.projectUpload(orgId, projectId, sha256, detected);
    const existing = await this.repo.getSheetSet(orgId, projectId, sha256);
    let created: { sheetSet: SheetSet; deduplicated: boolean };
    try {
      created = existing
        ? { sheetSet: existing, deduplicated: true }
        : await this.repo.createSheetSetIngest(orgId, projectId, {
            name: req.name ? sanitizeFilename(req.name, detected) : claims.name,
            sha256,
            fileKind: detected,
            storagePath: destPath,
            uploadedBy: user.uid,
            uploadFileId: claims.fid,
            sizeBytes: inspected.size,
            jobType: JOB_TYPES.ingestSheetVersion,
            // Sprint 7: counted + checked against the org's per-project quota inside the create transaction.
            quotaBytes: projectQuotaOf((await this.repo.getOrg(orgId))?.settings),
          });
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        await this.discard(claims.path);
        this.logger.warn({ orgId, projectId, used: err.usedBytes, quota: err.quotaBytes, size: err.requestedBytes }, 'project storage quota exceeded');
        throw quotaExceeded(err.usedBytes, err.quotaBytes, err.requestedBytes);
      }
      throw err;
    }
    const { sheetSet, deduplicated } = created;

    // Checks passed → leave quarantine. Identical bytes already stored → just drop the duplicate.
    if (await this.storage.exists(sheetSet.storagePath)) {
      await this.discard(claims.path);
    } else {
      await this.storage.move(claims.path, sheetSet.storagePath, {
        contentType: KIND_TO_CONTENT_TYPE[detected],
        metadata: { sha256, uploadedBy: user.uid, fileId: claims.fid, originalName: claims.name },
      });
    }
    if (req.replacesSheetSetId) await this.supersede(orgId, projectId, req.replacesSheetSetId, sheetSet.id, user.uid);
    return this.publishIfNeeded(orgId, projectId, sheetSet, deduplicated, traceparent);
  }

  /**
   * A-API-05: links the revision to the set it replaces (pending until the revision is processed; then the old sheets
   * become superseded versions of the matching new sheets — ProjectStateService.reconcileSupersedes).
   */
  private async supersede(orgId: string, projectId: string, oldSetId: string, newSetId: string, actorUid: string): Promise<void> {
    if (!this.state) return;
    try {
      await this.state.startSupersede(orgId, projectId, oldSetId, newSetId, actorUid);
    } catch (err) {
      if (err instanceof RepoConflictError) {
        const msg = err.reason === 'already_superseded' ? 'that sheet set was already replaced by another revision' : err.reason === 'same_set' ? 'the revised file is identical to the set it replaces' : 'sheet set not found';
        throw new ApiException(err.reason === 'not_found' ? HttpStatus.NOT_FOUND : HttpStatus.CONFLICT, err.reason === 'not_found' ? 'not_found' : 'conflict', msg, [{ path: 'replacesSheetSetId', message: err.reason }]);
      }
      throw err;
    }
  }

  /** Publishes the initial ingest of a set that is still `uploaded` (never published), then marks it `queued`. */
  private async publishIfNeeded(
    orgId: string,
    projectId: string,
    sheetSet: SheetSet,
    deduplicated: boolean,
    traceparent: string,
  ): Promise<FinalizeUploadResponse> {
    const jobId = sheetSet.ingestJobId;
    const versionId = sheetSet.versionId;
    if (!jobId || !versionId) throw new ApiException(HttpStatus.CONFLICT, 'conflict', 'sheet set predates Sprint 1; re-upload it');
    let current = sheetSet;
    if (sheetSet.status === 'uploaded') {
      try {
        await this.queue.publish({
          schemaVersion: INGEST_JOB_SCHEMA_VERSION,
          type: JOB_TYPES.ingestSheetVersion,
          jobId,
          orgId,
          projectId,
          sheetSetId: sheetSet.id,
          sheetId: null,
          pageIndex: null,
          versionId,
          storagePath: sheetSet.storagePath,
          sha256: sheetSet.sha256,
          fileKind: sheetSet.fileKind,
          traceparent,
        });
      } catch (err) {
        // The object is already in uploads/; retrying finalize with the same token resumes here.
        this.logger.error({ err: (err as Error).message, jobId }, 'publish failed');
        throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'service_unavailable', 'could not schedule processing; retry');
      }
      await this.repo.setSheetSetStatus(orgId, projectId, sheetSet.id, 'queued');
      current = { ...sheetSet, status: 'queued' };
    }
    this.logger.log({ orgId, projectId, sheetSetId: sheetSet.id, jobId, fileKind: sheetSet.fileKind, deduplicated }, 'upload finalized');
    return { sheetSet: current, deduplicated, jobId, versionId };
  }

  /**
   * Sprint 7: GET …/sheet-sets/:setId (viewer+) — the upload's status: set + ingest job + the effective error with its
   * Hebrew text. An infected set (worker `file_infected`: quarantined, never processed) releases its bytes from the
   * project's storage usage (idempotent).
   */
  async sheetSetStatus(user: AuthContext, projectId: string, setId: string): Promise<SheetSetStatusResponse> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'viewer');
    if (!DocIdSchema.safeParse(setId).success) throw notFound('sheet set');
    let set = await this.repo.getSheetSet(orgId, projectId, setId);
    if (!set) throw notFound('sheet set');
    const job = set.ingestJobId ? await this.repo.getJob(set.ingestJobId) : null;
    const ownJob = job && job.orgId === orgId && job.projectId === projectId ? job : null;
    const e = set.error ?? ownJob?.error ?? null;
    const infected = e?.code === FILE_INFECTED_ERROR;
    if (infected && set.error?.code === FILE_INFECTED_ERROR) {
      await this.repo.releaseInfectedStorage(orgId, projectId, setId).catch((err: unknown) => this.logger.warn({ err: (err as Error).message, orgId, setId }, 'storage release failed'));
      set = (await this.repo.getSheetSet(orgId, projectId, setId)) ?? set;
    }
    return {
      sheetSet: set,
      job: ownJob ? { id: ownJob.id, status: ownJob.status, progress: ownJob.progress } : null,
      error: e ? { code: e.code, message: e.message, messageHe: UPLOAD_ERROR_MESSAGES_HE[e.code] ?? null } : null,
      infected,
    };
  }

  private verifyToken(token: string): UploadTokenClaims {
    try {
      return this.signer.verify(token);
    } catch (err) {
      if (err instanceof UploadTokenError && err.reason === 'expired') {
        throw new ApiException(HttpStatus.GONE, 'upload_expired', 'upload token expired; start a new upload');
      }
      throw new ApiException(HttpStatus.BAD_REQUEST, 'bad_request', 'invalid upload token');
    }
  }

  private async discard(path: string): Promise<void> {
    await this.storage.remove(path).catch((err: unknown) => {
      this.logger.warn({ err: (err as Error).message }, 'failed to remove upload object');
    });
  }
}

/** 413 `quota_exceeded` with the Hebrew message (contracts `quotaExceededMessageHe`) and the numbers as issues. */
export function quotaExceeded(used: number, quota: number, requested: number): ApiException {
  return new ApiException(HttpStatus.PAYLOAD_TOO_LARGE, 'quota_exceeded', quotaExceededMessageHe(used, quota, requested), [
    { path: 'usedBytes', message: String(used) },
    { path: 'quotaBytes', message: String(quota) },
    { path: 'requestedBytes', message: String(requested) },
  ]);
}
