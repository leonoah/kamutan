import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  JOB_TYPES,
  MAX_UPLOAD_BYTES,
  UPLOAD_TTL_SECONDS,
  type CreateUploadRequest,
  type CreateUploadResponse,
  type FinalizeUploadRequest,
  type FinalizeUploadResponse,
} from '@kamutan/contracts';
import type { AuthContext, OrgAccess } from '../auth/auth-context';
import { ApiException } from '../common/api-exception';
import { REPOSITORY, type Repository, type SheetSetWithVersion } from '../db/repository';
import { INGEST_QUEUE, type IngestQueue } from '../queue/ingest-queue';
import { kindFromFilename, sanitizeFilename } from './filename';
import { inspectStream, TooLargeError } from './inspect';
import { detectFileKind } from './magic-bytes';
import { OBJECT_STORAGE, type ObjectStorage } from './storage/object-storage';
import { UploadTokenError, UploadTokenSigner } from './upload-token';

export const UPLOAD_TOKEN_SIGNER = Symbol('UPLOAD_TOKEN_SIGNER');

@Injectable()
export class UploadsService {
  private readonly logger = new Logger('UploadsService');

  constructor(
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Inject(INGEST_QUEUE) private readonly queue: IngestQueue,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(UPLOAD_TOKEN_SIGNER) private readonly signer: UploadTokenSigner,
  ) {}

  /** Step 1: issue a signed, short-lived upload target. No DB rows are written yet. */
  async createUpload(
    user: AuthContext,
    access: OrgAccess,
    projectId: string,
    req: CreateUploadRequest,
  ): Promise<CreateUploadResponse> {
    const kind = kindFromFilename(req.filename);
    if (!kind) throw new ApiException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'unsupported_file_type', 'unsupported file extension');

    const uploadId = randomUUID();
    const storagePath = `${access.orgId}/upload/${uploadId}`;
    const expSec = Math.floor(Date.now() / 1000) + UPLOAD_TTL_SECONDS;
    const signed = await this.storage.createSignedUpload(storagePath, {
      expiresInSec: UPLOAD_TTL_SECONDS,
      maxBytes: MAX_UPLOAD_BYTES,
    });
    const uploadToken = this.signer.sign({
      v: 1,
      uid: uploadId,
      org: access.orgId,
      prj: projectId,
      usr: user.userId,
      path: storagePath,
      name: sanitizeFilename(req.filename, kind),
      kind,
      size: req.sizeBytes,
      exp: expSec,
    });
    return {
      uploadId,
      uploadToken,
      uploadUrl: signed.url,
      method: signed.method,
      headers: signed.headers,
      storagePath,
      fileKind: kind,
      maxBytes: MAX_UPLOAD_BYTES,
      expiresAt: new Date(expSec * 1000).toISOString(),
    };
  }

  /**
   * Step 2: verify the uploaded bytes (size, magic bytes vs. extension), hash
   * them, dedupe by sha256 within the project, create sheet_set/sheet/sheet_version
   * + jobs rows, and enqueue `ingest.sheet_version`.
   */
  async finalize(
    user: AuthContext,
    access: OrgAccess,
    projectId: string,
    req: FinalizeUploadRequest,
    traceparent: string,
  ): Promise<FinalizeUploadResponse> {
    const claims = this.verifyToken(req.uploadToken);
    if (claims.prj !== projectId || claims.usr !== user.userId || claims.org !== access.orgId) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'bad_request', 'upload token does not match this project');
    }

    const stream = await this.storage.openRead(claims.path);
    if (!stream) throw new ApiException(HttpStatus.CONFLICT, 'upload_missing', 'uploaded object not found');

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
      this.logger.warn({ orgId: access.orgId, projectId, declared: claims.kind, detected }, 'magic-bytes rejection');
      throw new ApiException(
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        'unsupported_file_type',
        'file content does not match an allowed type for its extension',
      );
    }

    const name = req.name ? sanitizeFilename(req.name, detected) : claims.name;
    const sha256 = inspected.sha256;

    const outcome = await this.repo.run(user, async (tx) => {
      await tx.lockProjectFile(projectId, sha256);
      const existing = await tx.findSheetSetBySha(projectId, sha256);
      if (existing) {
        let jobId = await tx.findJobId(existing.sheetVersion.id, JOB_TYPES.ingestSheetVersion);
        if (!jobId) {
          jobId = await tx.createJob({
            orgId: access.orgId,
            projectId,
            sheetVersionId: existing.sheetVersion.id,
            type: JOB_TYPES.ingestSheetVersion,
            inputHash: sha256,
          });
        }
        return { ...existing, jobId, deduplicated: true };
      }
      const created: SheetSetWithVersion = await tx.createSheetSetWithVersion({
        orgId: access.orgId,
        projectId,
        name,
        storagePath: claims.path,
        sha256,
        fileKind: detected,
      });
      const jobId = await tx.createJob({
        orgId: access.orgId,
        projectId,
        sheetVersionId: created.sheetVersion.id,
        type: JOB_TYPES.ingestSheetVersion,
        inputHash: sha256,
      });
      await tx.writeAudit({
        orgId: access.orgId,
        entity: 'sheet_sets',
        entityId: created.sheetSet.id,
        action: 'upload',
        after: { project_id: projectId, file_kind: detected, sha256, size_bytes: inspected.size },
      });
      return { ...created, jobId, deduplicated: false };
    });

    if (outcome.deduplicated && outcome.sheetVersion.storagePath !== claims.path) {
      await this.discard(claims.path); // identical bytes already stored
    }

    // Enqueue after commit. A version left in `uploaded` (enqueue failed earlier)
    // is re-enqueued on retry; the job id makes this idempotent.
    let sheetVersion = outcome.sheetVersion;
    if (sheetVersion.status === 'uploaded') {
      try {
        await this.queue.enqueueIngest(
          {
            schemaVersion: 1,
            sheetVersionId: sheetVersion.id,
            orgId: access.orgId,
            projectId,
            storagePath: sheetVersion.storagePath,
            sha256: sheetVersion.sourceSha256,
            fileKind: outcome.sheetSet.fileKind,
            traceparent,
          },
          { jobId: outcome.jobId },
        );
      } catch (err) {
        this.logger.error({ err: (err as Error).message, sheetVersionId: sheetVersion.id }, 'enqueue failed');
        throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'service_unavailable', 'could not schedule processing; retry');
      }
      await this.repo.run(user, (tx) => tx.setSheetVersionStatus(sheetVersion.id, 'queued'));
      sheetVersion = { ...sheetVersion, status: 'queued' };
    }

    this.logger.log(
      { orgId: access.orgId, projectId, sheetVersionId: sheetVersion.id, fileKind: detected, deduplicated: outcome.deduplicated },
      'upload finalized',
    );
    return { sheetSet: outcome.sheetSet, sheetVersion, deduplicated: outcome.deduplicated, jobId: outcome.jobId };
  }

  private verifyToken(token: string) {
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
      this.logger.warn({ err: (err as Error).message }, 'failed to remove rejected object');
    });
  }
}
