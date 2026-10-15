import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DocIdSchema,
  REVIEW_QUEUE_KINDS,
  REVIEW_QUEUE_MAX_THUMBS,
  storagePaths,
  type Correction,
  type ReviewQueueItem,
  type ReviewQueueKind,
  type ReviewQueuePage,
  type ReviewQueueQuery,
} from '@kamutan/contracts';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth-context';
import { notFound } from '../common/api-exception';
import { BOQ_STORAGE, type BoqStorage } from '../boq/boq-storage';
import { BOQ_REPOSITORY, type BoqRepository } from '../db/boq-repository';
import { REPOSITORY, type Repository } from '../db/repository';
import { REVIEW_REPOSITORY, type ReviewRepository } from '../db/review-repository';
import { URL_SIGNER, type UrlSigner } from '../sheets/url-signer';
import { ArtifactTooLargeError } from '../understanding/artifact-reader';
import { ReviewArtifacts } from './artifact-views';
import { applyOverlay, computeQueueBase, type BaseItem, type EvidenceRef, type QueueBase, type UnmatchedRef } from './queue';

const validId = (s: unknown): s is string => typeof s === 'string' && DocIdSchema.safeParse(s).success;
const MAX_SHEETS = 2000;

/**
 * GET /v1/projects/:pid/review-queue. The build-derived base (lines + evidence + every current version's detections /
 * rooms / links) is cached per (project, latest build id, current versions) — artifacts are immutable per version — so
 * a request costs: project + sheets list + corrections + room-settings ids, then an in-memory overlay, sort and page.
 */
@Injectable()
export class ReviewQueueService {
  private readonly logger = new Logger('ReviewQueueService');
  private readonly cache = new Map<string, Promise<QueueBase>>();
  private static readonly CACHE_MAX = 32;
  /** Exposed for tests: number of base computations. */
  computations = 0;

  constructor(
    private readonly access: AccessService,
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Inject(BOQ_REPOSITORY) private readonly boq: BoqRepository,
    @Inject(BOQ_STORAGE) private readonly storage: BoqStorage,
    @Inject(REVIEW_REPOSITORY) private readonly review: ReviewRepository,
    @Inject(URL_SIGNER) private readonly signer: UrlSigner,
    private readonly artifacts: ReviewArtifacts,
  ) {}

  private async currentVersions(orgId: string, projectId: string): Promise<Array<{ sheetId: string; versionId: string }>> {
    const out: Array<{ sheetId: string; versionId: string }> = [];
    let cursor: string | undefined;
    while (out.length < MAX_SHEETS) {
      const page = await this.repo.listSheets(orgId, projectId, { limit: 200, ...(cursor ? { cursor } : {}) });
      for (const s of page.items) if (s.currentVersion?.status === 'ready' && validId(s.currentVersion.id)) out.push({ sheetId: s.id, versionId: s.currentVersion.id });
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return out.sort((a, b) => (a.sheetId < b.sheetId ? -1 : 1));
  }

  private async evidence(orgId: string, projectId: string, buildId: string | null): Promise<{ lines: Map<string, EvidenceRef[]>; unmatched: UnmatchedRef[] }> {
    const lines = new Map<string, EvidenceRef[]>();
    const unmatched: UnmatchedRef[] = [];
    if (!validId(buildId)) return { lines, unmatched };
    let raw: unknown = null;
    try {
      raw = await this.storage.readEvidence(storagePaths.boqEvidence(orgId, projectId, buildId));
    } catch (err) {
      if (!(err instanceof ArtifactTooLargeError || err instanceof SyntaxError)) throw err;
      this.logger.warn({ buildId }, 'evidence rejected');
    }
    if (!raw || typeof raw !== 'object') return { lines, unmatched };
    const r = raw as { lines?: unknown; corrections?: { unmatched?: unknown } };
    if (r.lines && typeof r.lines === 'object') {
      for (const [lineId, items] of Object.entries(r.lines as Record<string, unknown>)) {
        if (!validId(lineId) || !Array.isArray(items)) continue;
        const refs: EvidenceRef[] = [];
        for (const it of items.slice(0, 5000) as Array<Record<string, unknown>>) {
          if (!it || !validId(it.sheetId) || !validId(it.versionId) || typeof it.detectionId !== 'string' || it.detectionId.length > 128) continue;
          refs.push({
            sheetId: it.sheetId,
            versionId: it.versionId,
            detectionId: it.detectionId,
            linkGroupId: typeof it.linkGroupId === 'string' && it.linkGroupId.length <= 128 ? it.linkGroupId : null,
            verified: it.verified === true,
          });
        }
        lines.set(lineId, refs);
      }
    }
    const um = r.corrections?.unmatched;
    if (Array.isArray(um)) {
      for (const u of um.slice(0, 20_000) as Array<Record<string, unknown>>) {
        if (u && validId(u.correctionId) && validId(u.sheetId) && validId(u.versionId)) {
          unmatched.push({ correctionId: u.correctionId, sheetId: u.sheetId, versionId: u.versionId, reason: typeof u.reason === 'string' && u.reason ? u.reason.slice(0, 200) : 'לא נמצא פריט תואם' });
        }
      }
    }
    return { lines, unmatched };
  }

  private base(orgId: string, projectId: string, buildId: string | null, versions: Array<{ sheetId: string; versionId: string }>): Promise<QueueBase> {
    const key = `${orgId}/${projectId}/${buildId ?? '-'}/${versions.map((v) => `${v.sheetId}:${v.versionId}`).join(',')}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit); // LRU touch
      return hit;
    }
    const p = (async () => {
      this.computations++;
      const [lines, ev, arts] = await Promise.all([
        buildId ? this.boq.listLines(orgId, projectId) : Promise.resolve([]),
        this.evidence(orgId, projectId, buildId),
        Promise.all(versions.map(async (v) => ({ ...v, artifacts: await this.artifacts.of(orgId, projectId, v.sheetId, v.versionId) }))),
      ]);
      return computeQueueBase({ buildId, lines, evidence: ev.lines, unmatched: ev.unmatched, versions: arts });
    })();
    this.cache.set(key, p);
    p.catch(() => this.cache.delete(key));
    while (this.cache.size > ReviewQueueService.CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
    return p;
  }

  async queue(user: AuthContext, projectId: string, q: ReviewQueueQuery): Promise<ReviewQueuePage> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'viewer');
    const project = await this.repo.getProject(orgId, projectId);
    if (!project) throw notFound('project');
    const buildId = project.boq?.latestBuildId ?? null;
    const [versions, corrections, settingsIds] = await Promise.all([
      this.currentVersions(orgId, projectId),
      this.review.listCorrections(orgId, projectId, {}),
      this.review.listRoomSettingsIds(orgId, projectId),
    ]);
    const base = await this.base(orgId, projectId, buildId, versions);
    const active = corrections.filter((c: Correction) => c.revertedAt === null);
    const all = applyOverlay(base, active, new Set(settingsIds));

    const byKind = Object.fromEntries(REVIEW_QUEUE_KINDS.map((k) => [k, 0])) as Record<ReviewQueueKind, number>;
    const byLevel = { yellow: 0, red: 0 };
    for (const it of all) {
      byKind[it.kind]++;
      if (it.level === 'red' || it.level === 'yellow') byLevel[it.level]++;
    }
    const filtered = all.filter(
      (it) => (!q.kind || it.kind === q.kind) && (!q.sheetId || it.sheetId === q.sheetId) && (!q.floor || it.floor === q.floor) && (!q.level || it.level === q.level),
    );
    const start = q.cursor ? Math.min(Number(q.cursor), filtered.length) : 0;
    const page = filtered.slice(start, start + q.limit);
    const { items, expiresAt } = await this.withThumbs(orgId, projectId, page);
    return {
      items,
      nextCursor: start + q.limit < filtered.length ? String(start + q.limit) : null,
      total: filtered.length,
      counts: { byKind, byLevel },
      buildId,
      stale: project.boq?.stale ?? false,
      generatedAt: new Date().toISOString(),
      expiresAt,
    };
  }

  private async withThumbs(orgId: string, projectId: string, page: readonly BaseItem[]): Promise<{ items: ReviewQueueItem[]; expiresAt: string | null }> {
    const paths = new Map<string, string>();
    for (const it of page) {
      if (paths.size >= REVIEW_QUEUE_MAX_THUMBS) break;
      const clusterId = it.thumbPath?.startsWith('unknown:') ? it.thumbPath.slice('unknown:'.length) : null;
      if (clusterId && it.sheetId && it.versionId) paths.set(it.id, storagePaths.unknownThumb(orgId, projectId, it.sheetId, it.versionId, clusterId));
    }
    const signed = paths.size ? await this.signer.signRead([...paths.values()]) : new Map();
    let exp: number | null = null;
    const items = page.map((it): ReviewQueueItem => {
      const { thumbPath: _t, members: _m, roomIssues: _r, needsSettings: _n, unmatched: _u, ...pub } = it;
      const p = paths.get(it.id);
      const u = p ? signed.get(p) : undefined;
      if (u) exp = exp === null ? u.expiresAt.getTime() : Math.min(exp, u.expiresAt.getTime());
      return { ...pub, thumbUrl: u?.url ?? null };
    });
    return { items, expiresAt: exp === null ? null : new Date(exp).toISOString() };
  }
}
