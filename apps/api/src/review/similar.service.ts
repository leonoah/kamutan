import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  DocIdSchema,
  FIND_SIMILAR_JOB_SCHEMA_VERSION,
  JOB_TYPES,
  OVERLAY_MAX_THUMBS,
  SIMILAR_MAX_CANDIDATES,
  storagePaths,
  type CreateSimilarSearchRequest,
  type CreateSimilarSearchResponse,
  type SimilarSearchView,
} from '@kamutan/contracts';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth-context';
import { ApiException, badRequest, notFound } from '../common/api-exception';
import { REPOSITORY, type Repository } from '../db/repository';
import { REVIEW_REPOSITORY, type ReviewRepository } from '../db/review-repository';
import { INGEST_QUEUE, type IngestQueue } from '../queue/ingest-queue';
import { URL_SIGNER, type UrlSigner } from '../sheets/url-signer';

/**
 * Sprint 4 "learn from correction": POST enqueues `symbols.find_similar` (reviewer+; it only reads drawings — applying
 * the result posts a correction batch, which has its own role check); GET returns the worker's result + signed crops.
 * Crop paths are derived from org/project/search/candidate ids, never from worker strings.
 */
@Injectable()
export class SimilarService {
  private readonly logger = new Logger('SimilarService');

  constructor(
    private readonly access: AccessService,
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Inject(REVIEW_REPOSITORY) private readonly review: ReviewRepository,
    @Inject(INGEST_QUEUE) private readonly queue: IngestQueue,
    @Inject(URL_SIGNER) private readonly signer: UrlSigner,
  ) {}

  async create(user: AuthContext, projectId: string, req: CreateSimilarSearchRequest, traceparent: string): Promise<CreateSimilarSearchResponse> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'reviewer');
    const { sheetId, versionId, bboxMm } = req.exemplar;
    const sheet = await this.repo.getSheet(orgId, projectId, sheetId);
    const version = sheet ? await this.repo.getVersion(orgId, projectId, sheetId, versionId) : null;
    if (!version) throw notFound('sheet version');
    if (version.status !== 'ready') throw new ApiException(HttpStatus.CONFLICT, 'not_ready', 'the sheet version is not processed yet');
    if (version.page && (bboxMm.x < 0 || bboxMm.y < 0 || bboxMm.x + bboxMm.w > version.page.widthMm || bboxMm.y + bboxMm.h > version.page.heightMm)) {
      throw badRequest('the exemplar box is outside the page');
    }
    if (req.correctionId && !(await this.review.getCorrection(orgId, projectId, req.correctionId))) throw notFound('correction');
    const { search, jobId } = await this.review.createSimilarSearch(orgId, projectId, req, user.uid, JOB_TYPES.findSimilar);
    try {
      await this.queue.publish({
        schemaVersion: FIND_SIMILAR_JOB_SCHEMA_VERSION,
        type: JOB_TYPES.findSimilar,
        jobId,
        orgId,
        projectId,
        searchId: search.id,
        exemplar: req.exemplar,
        scope: req.scope,
        maxCandidates: SIMILAR_MAX_CANDIDATES,
        traceparent,
      });
    } catch (err) {
      this.logger.error({ err: (err as Error).message, searchId: search.id }, 'find_similar publish failed');
      await this.review.failSimilarSearch(orgId, projectId, search.id, jobId, { code: 'publish_failed', message: 'could not schedule the search' });
      throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'service_unavailable', 'could not start the search; retry');
    }
    return { search, jobId };
  }

  async get(user: AuthContext, projectId: string, searchId: string): Promise<SimilarSearchView> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'viewer');
    if (!DocIdSchema.safeParse(searchId).success) throw notFound('similar search');
    const search = await this.review.getSimilarSearch(orgId, projectId, searchId);
    if (!search) throw notFound('similar search');
    const withThumb = search.candidates.filter((c) => c.thumb !== null).slice(0, OVERLAY_MAX_THUMBS);
    const paths = withThumb.map((c) => storagePaths.similarThumb(orgId, projectId, searchId, c.id));
    const signed = paths.length ? await this.signer.signRead(paths) : new Map();
    const thumbUrls: Record<string, string> = {};
    let expires: number | null = null;
    withThumb.forEach((c, i) => {
      const u = signed.get(paths[i] as string);
      if (!u) return;
      thumbUrls[c.id] = u.url;
      expires = expires === null ? u.expiresAt.getTime() : Math.min(expires, u.expiresAt.getTime());
    });
    return { search, thumbUrls, expiresAt: expires === null ? null : new Date(expires).toISOString() };
  }
}
