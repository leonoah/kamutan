import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  CORRECTION_KIND_MIN_ROLE,
  DocIdSchema,
  roleSatisfies,
  type Correction,
  type CorrectionKind,
  type CorrectionPage,
  type CreateCorrectionBatchRequest,
  type CreateCorrectionBatchResponse,
  type CreateCorrectionRequest,
  type CreateCorrectionResponse,
  type ListCorrectionsQuery,
  type RevertCorrectionBatchResponse,
  type RevertCorrectionResponse,
  type Role,
  type SheetVersion,
} from '@kamutan/contracts';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth-context';
import { ApiException, badRequest, forbidden, notFound, type ApiIssue } from '../common/api-exception';
import { REPOSITORY, RepoConflictError, type Repository } from '../db/repository';
import { REVIEW_REPOSITORY, type ReviewRepository } from '../db/review-repository';
import { RebuildService } from './rebuild.service';

const validId = (s: string) => DocIdSchema.safeParse(s).success;
/** Points of all geometries of one batch (keeps a commit far below Firestore's 10 MiB request limit). */
export const MAX_BATCH_GEOMETRY_POINTS = 20_000;
/** Anchor / geometry may lie this far outside the page (snapping at the border). */
const PAGE_MARGIN_MM = 10;

/** The role needed for a set of kinds (highest of CORRECTION_KIND_MIN_ROLE). */
export function roleForKinds(kinds: Iterable<CorrectionKind>): Role {
  let role: Role = 'reviewer';
  for (const k of kinds) if (CORRECTION_KIND_MIN_ROLE[k] === 'editor') role = 'editor';
  return role;
}

/**
 * Sprint 4: corrections (single, batch ≤ 500 with one batchId, revert, list). Every change is audited (in the repository
 * transaction), marks the BOQ stale and schedules a debounced rebuild (RebuildService).
 * Roles: accept / reject → reviewer+; every other kind → editor+ (decision, see CORRECTION_KIND_MIN_ROLE).
 */
@Injectable()
export class CorrectionsService {
  constructor(
    private readonly access: AccessService,
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Inject(REVIEW_REPOSITORY) private readonly review: ReviewRepository,
    private readonly rebuild: RebuildService,
  ) {}

  private async requireForKinds(user: AuthContext, projectId: string, kinds: Iterable<CorrectionKind>): Promise<string> {
    const { orgId, role } = await this.access.requireProjectRole(user, projectId, 'reviewer');
    const need = roleForKinds(kinds);
    if (!roleSatisfies(role, need)) throw forbidden(`this correction requires the ${need} role`);
    return orgId;
  }

  /** Every item's sheet + version must exist and be ready; anchors / geometry inside the page (± 10 mm). */
  private async validateTargets(orgId: string, projectId: string, items: readonly CreateCorrectionRequest[]): Promise<void> {
    const versions = new Map<string, SheetVersion | null>();
    const issues: ApiIssue[] = [];
    let points = 0;
    for (const [i, it] of items.entries()) {
      const key = `${it.sheetId}/${it.versionId}`;
      if (!versions.has(key)) {
        const sheet = await this.repo.getSheet(orgId, projectId, it.sheetId);
        versions.set(key, sheet ? await this.repo.getVersion(orgId, projectId, it.sheetId, it.versionId) : null);
      }
      const v = versions.get(key);
      if (!v) throw notFound(items.length > 1 ? `sheet version of item ${i}` : 'sheet version');
      if (v.status !== 'ready') throw new ApiException(HttpStatus.CONFLICT, 'not_ready', 'the sheet version is not processed yet', [{ path: `items.${i}.versionId`, message: v.status }]);
      const pts = [it.anchorMm, ...(it.geometry?.mm ?? [])];
      points += it.geometry?.mm.length ?? 0;
      if (v.page) {
        const out = pts.some((p) => p.x < -PAGE_MARGIN_MM || p.y < -PAGE_MARGIN_MM || p.x > v.page!.widthMm + PAGE_MARGIN_MM || p.y > v.page!.heightMm + PAGE_MARGIN_MM);
        if (out) issues.push({ path: items.length > 1 ? `items.${i}` : 'anchorMm', message: 'outside the page' });
      }
    }
    if (points > MAX_BATCH_GEOMETRY_POINTS) issues.push({ path: 'items', message: `too many geometry points (max ${MAX_BATCH_GEOMETRY_POINTS})` });
    if (issues.length) throw new ApiException(HttpStatus.BAD_REQUEST, 'bad_request', 'invalid correction', issues.slice(0, 20));
  }

  async create(user: AuthContext, projectId: string, req: CreateCorrectionRequest, traceparent: string): Promise<CreateCorrectionResponse> {
    const orgId = await this.requireForKinds(user, projectId, [req.kind]);
    await this.validateTargets(orgId, projectId, [req]);
    const { corrections } = await this.review.createCorrections(orgId, projectId, [req], null, user.uid);
    const rebuild = await this.rebuild.afterChange(orgId, projectId, 'correction', user.uid, traceparent);
    return { correction: corrections[0] as Correction, rebuild };
  }

  async createBatch(user: AuthContext, projectId: string, req: CreateCorrectionBatchRequest, traceparent: string): Promise<CreateCorrectionBatchResponse> {
    const orgId = await this.requireForKinds(user, projectId, new Set(req.items.map((i) => i.kind)));
    await this.validateTargets(orgId, projectId, req.items);
    if (req.similarSearchId && !(await this.review.getSimilarSearch(orgId, projectId, req.similarSearchId))) throw notFound('similar search');
    const { corrections, batch } = await this.review.createCorrections(orgId, projectId, req.items, { source: req.source, similarSearchId: req.similarSearchId }, user.uid);
    const rebuild = await this.rebuild.afterChange(orgId, projectId, 'correction', user.uid, traceparent);
    if (!batch) throw new Error('batch not created');
    return { batch, items: corrections, rebuild };
  }

  async revert(user: AuthContext, projectId: string, correctionId: string, traceparent: string): Promise<RevertCorrectionResponse> {
    const { orgId, role } = await this.access.requireProjectRole(user, projectId, 'reviewer');
    if (!validId(correctionId)) throw notFound('correction');
    const cur = await this.review.getCorrection(orgId, projectId, correctionId);
    if (!cur) throw notFound('correction');
    if (!roleSatisfies(role, CORRECTION_KIND_MIN_ROLE[cur.kind])) throw forbidden(`reverting a ${cur.kind} correction requires the ${CORRECTION_KIND_MIN_ROLE[cur.kind]} role`);
    let correction: Correction | null;
    try {
      correction = await this.review.revertCorrection(orgId, projectId, correctionId, user.uid);
    } catch (err) {
      if (err instanceof RepoConflictError) throw new ApiException(HttpStatus.CONFLICT, 'conflict', 'the correction is already reverted');
      throw err;
    }
    if (!correction) throw notFound('correction');
    const rebuild = await this.rebuild.afterChange(orgId, projectId, 'correction', user.uid, traceparent);
    return { correction, rebuild };
  }

  async revertBatch(user: AuthContext, projectId: string, batchId: string, traceparent: string): Promise<RevertCorrectionBatchResponse> {
    const { orgId, role } = await this.access.requireProjectRole(user, projectId, 'reviewer');
    if (!validId(batchId)) throw notFound('batch');
    const cur = await this.review.getBatch(orgId, projectId, batchId);
    if (!cur) throw notFound('batch');
    const need = roleForKinds(Object.keys(cur.kinds) as CorrectionKind[]);
    if (!roleSatisfies(role, need)) throw forbidden(`reverting this batch requires the ${need} role`);
    let r;
    try {
      r = await this.review.revertBatch(orgId, projectId, batchId, user.uid);
    } catch (err) {
      if (err instanceof RepoConflictError) throw new ApiException(HttpStatus.CONFLICT, 'conflict', 'the batch is already reverted');
      throw err;
    }
    if (!r) throw notFound('batch');
    const rebuild = await this.rebuild.afterChange(orgId, projectId, 'correction', user.uid, traceparent);
    return { batch: r.batch, reverted: r.reverted, rebuild };
  }

  /** Newest first (at desc, id desc); cursor = last correction id of the page. */
  async list(user: AuthContext, projectId: string, q: ListCorrectionsQuery): Promise<CorrectionPage> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'viewer');
    const all = await this.review.listCorrections(orgId, projectId, { ...(q.sheetId ? { sheetId: q.sheetId } : {}), ...(q.batchId ? { batchId: q.batchId } : {}) });
    const items = all
      .filter((c) => (!q.kind || c.kind === q.kind) && (q.includeReverted || c.revertedAt === null) && (!q.batchId || c.batchId === q.batchId))
      .sort(compareNewestFirst);
    let start = 0;
    if (q.cursor) {
      const idx = items.findIndex((c) => c.id === q.cursor);
      if (idx < 0) throw badRequest('unknown cursor');
      start = idx + 1;
    }
    const page = items.slice(start, start + q.limit);
    return { items: page, nextCursor: items.length > start + q.limit && page.length ? (page.at(-1) as Correction).id : null };
  }
}

export const compareNewestFirst = (a: Correction, b: Correction): number => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
