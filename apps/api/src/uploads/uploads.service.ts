import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  JOB_TYPES,
  KIND_TO_CONTENT_TYPE,
  MAX_UPLOAD_BYTES,
  storagePaths,
  UPLOAD_TTL_SECONDS,
  type CreateUploadRequest,
  type CreateUploadResponse,
  type FinalizeUploadRequest,
  type FinalizeUploadResponse,
} from '@kamutan/contracts';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth-context';
import { ApiException } from '../common/api-exception';
import { autoId } from '../db/in-memory.repository';
import { REPOSITORY, type Repository } from '../db/repository';
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
  ) {}

  /**
   * Step 1: reserve an upload target. The client uploads directly to Cloud
   * Storage (resumable) at orgs/{orgId}/uploads/{uid}/{fileId}; storage.rules
   * allow create-only there for editors of the org. No Firestore writes yet.
   */
  async createUpload(user: AuthContext, projectId: string, req: CreateUploadRequest): Promise<CreateUploadResponse> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'editor');
    const kind = kindFromFilename(req.filename);
    if (!kind) throw new ApiException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'unsupported_file_type', 'unsupported file extension');

    const fileId = autoId();
    const storagePath = storagePaths.upload(orgId, user.uid, fileId);
    const exp = Math.floor(Date.now() / 1000) + UPLOAD_TTL_SECONDS;
    const uploadToken = this.signer.sign({
      v: 2,
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
   * Step 2: verify the uploaded object (size, magic bytes vs. extension), hash
   * it, dedupe by sha256 within the project, copy it to the content-addressed
   * source path, create sheetSet/sheet/version + jobs/{jobId} + audit, publish
   * `ingest`, and delete the upload object.
   */
  async finalize(user: AuthContext, projectId: string, req: FinalizeUploadRequest, traceparent: string): Promise<FinalizeUploadResponse> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'editor');
    const claims = this.verifyToken(req.uploadToken);
    if (claims.prj !== projectId || claims.usr !== user.uid || claims.org !== orgId) {
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
      this.logger.warn({ orgId, projectId, declared: claims.kind, detected }, 'magic-bytes rejection');
      throw new ApiException(
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        'unsupported_file_type',
        'file content does not match an allowed type for its extension',
      );
    }

    const sha256 = inspected.sha256;
    const existing = await this.repo.findSheetSetBySha(orgId, projectId, sha256);
    const sourcePath = existing?.sheetSet.storagePath ?? storagePaths.source(orgId, projectId, sha256, detected);
    if (!existing) {
      await this.storage.copy(claims.path, sourcePath, {
        contentType: KIND_TO_CONTENT_TYPE[detected],
        metadata: { sha256, uploadedBy: user.uid, fileId: claims.fid },
      });
    }

    const { bundle, deduplicated } = existing
      ? { bundle: existing, deduplicated: true }
      : await this.repo.createSheetSetBundle(orgId, projectId, {
          name: req.name ? sanitizeFilename(req.name, detected) : claims.name,
          sha256,
          fileKind: detected,
          storagePath: sourcePath,
          uploadedBy: user.uid,
          sizeBytes: inspected.size,
          jobType: JOB_TYPES.ingestSheetVersion,
        });

    // Publish after the docs exist. A version left `uploaded` (publish failed
    // earlier) is re-published on retry with the same jobId (idempotency key).
    let sheetVersion = bundle.sheetVersion;
    if (sheetVersion.status === 'uploaded') {
      try {
        await this.queue.publish({
          schemaVersion: 2,
          type: JOB_TYPES.ingestSheetVersion,
          jobId: bundle.jobId,
          orgId,
          projectId,
          sheetSetId: bundle.sheetSet.id,
          sheetId: bundle.sheet.id,
          versionId: sheetVersion.id,
          storagePath: bundle.sheetSet.storagePath,
          sha256: bundle.sheetSet.sha256,
          fileKind: bundle.sheetSet.fileKind,
          traceparent,
        });
      } catch (err) {
        // Keep the upload object so the client can simply retry finalize.
        this.logger.error({ err: (err as Error).message, versionId: sheetVersion.id }, 'publish failed');
        throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'service_unavailable', 'could not schedule processing; retry');
      }
      await this.repo.setVersionStatus(orgId, projectId, bundle.sheet.id, sheetVersion.id, 'queued');
      sheetVersion = { ...sheetVersion, status: 'queued' };
    }

    await this.discard(claims.path);
    this.logger.log({ orgId, projectId, versionId: sheetVersion.id, fileKind: detected, deduplicated }, 'upload finalized');
    return { sheetSet: bundle.sheetSet, sheet: bundle.sheet, sheetVersion, deduplicated, jobId: bundle.jobId };
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
