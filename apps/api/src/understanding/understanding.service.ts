import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  ClusterIdSchema,
  DocIdSchema,
  LegendEntryIdSchema,
  OVERLAY_MAX_THUMBS,
  storagePaths,
  SYMBOL_CLASS_INFO,
  SymbolClassSchema,
  SymbolSignatureSchema,
  type LegendEntry,
  type LegendEntryItem,
  type LegendEntryPage,
  type ListLegendEntriesQuery,
  type OverlayManifest,
  type PatchLegendEntryRequest,
  type PatchLegendEntryResponse,
  type ReprocessOutcome,
  type ResolveUnknownClusterRequest,
  type ResolveUnknownClusterResponse,
  type SymbolClass,
} from '@kamutan/contracts';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth-context';
import { ApiException, notFound } from '../common/api-exception';
import { BOQ_REPOSITORY, type BoqRepository } from '../db/boq-repository';
import { REPOSITORY, type LegendDecision, type Repository } from '../db/repository';
import { SheetsService } from '../sheets/sheets.service';
import { URL_SIGNER, type SignedUrl, type UrlSigner } from '../sheets/url-signer';
import { ARTIFACT_READER, ArtifactTooLargeError, type ArtifactReader } from './artifact-reader';

const validId = (id: string) => DocIdSchema.safeParse(id).success;

/**
 * Lenient views of the worker artifacts: the API only needs the crop ids (overlay) and one cluster (resolve), so it
 * does not validate 50k detections per request. Full validation is the worker's job (contracts JSON Schema).
 */
const LegendThumbsView = z.object({
  entries: z.array(z.object({ id: LegendEntryIdSchema, thumb: z.string().nullable() })).max(1000),
});
const ClustersView = z.object({
  unknownClusters: z.array(z.object({ id: ClusterIdSchema, signature: z.string(), thumb: z.string().nullable() })).max(2000),
});

/** Overlay, legend confirmation and unknown-symbol resolution (Sprint 2). Every method authorizes first. */
@Injectable()
export class UnderstandingService {
  private readonly logger = new Logger('UnderstandingService');
  /** Artifacts are immutable per version → crop ids cached per version prefix (bounded, per instance). */
  private readonly thumbIds = new Map<string, { legend: string[]; clusters: string[] }>();
  private static readonly THUMB_CACHE_MAX = 1000;

  constructor(
    private readonly access: AccessService,
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Inject(URL_SIGNER) private readonly signer: UrlSigner,
    @Inject(ARTIFACT_READER) private readonly artifacts: ArtifactReader,
    private readonly sheets: SheetsService,
    @Optional() @Inject(BOQ_REPOSITORY) private readonly boq?: BoqRepository,
  ) {}

  /** Sprint 3: a mapping decision changes what the BOQ counts → project BOQ stale (never fails the request). */
  private async markStale(orgId: string, projectId: string, reason: 'legend' | 'cluster'): Promise<void> {
    await this.boq?.markStale(orgId, projectId, reason).catch((err: unknown) => this.logger.warn({ err: (err as Error).message, projectId }, 'markStale failed'));
  }

  // ------------------------------------------------------------------ overlay
  async overlay(user: AuthContext, projectId: string, sheetId: string, versionId: string): Promise<OverlayManifest> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'viewer');
    if (!validId(sheetId) || !validId(versionId)) throw notFound('version');
    const v = await this.repo.getVersion(orgId, projectId, sheetId, versionId);
    if (!v) throw notFound('version');
    if (v.status !== 'ready') throw new ApiException(HttpStatus.CONFLICT, 'not_ready', 'this version is not processed yet');

    // Paths are derived from the authorized ids — the worker-written strings only say "it exists".
    const a = v.artifacts;
    const legendPath = a.legend ? storagePaths.legend(orgId, projectId, sheetId, versionId) : null;
    const detectionsPath = a.detections ? storagePaths.detections(orgId, projectId, sheetId, versionId) : null;
    const roomsPath = a.rooms ? storagePaths.rooms(orgId, projectId, sheetId, versionId) : null;
    const linksPath = a.links ? storagePaths.links(orgId, projectId, sheetId, versionId) : null;

    const ids = await this.thumbIdsOf(storagePaths.versionArtifacts(orgId, projectId, sheetId, versionId), legendPath, detectionsPath);
    const thumbPaths = new Map<string, string>();
    for (const id of ids.legend) thumbPaths.set(id, storagePaths.legendThumb(orgId, projectId, sheetId, versionId, id));
    for (const id of ids.clusters) thumbPaths.set(id, storagePaths.unknownThumb(orgId, projectId, sheetId, versionId, id));

    const all = [legendPath, detectionsPath, roomsPath, linksPath, ...thumbPaths.values()].filter((p): p is string => p !== null);
    const signed = all.length ? await this.signer.signRead(all) : new Map<string, SignedUrl>();
    let expires = Number.POSITIVE_INFINITY;
    const ref = (p: string | null) => {
      const s = p ? signed.get(p) : undefined;
      if (!s) return null;
      expires = Math.min(expires, s.expiresAt.getTime());
      return { url: s.url };
    };
    const thumbs: Record<string, string> = {};
    for (const [id, p] of thumbPaths) {
      const r = ref(p);
      if (r) thumbs[id] = r.url;
    }
    const legend = ref(legendPath);
    const detections = ref(detectionsPath);
    const rooms = ref(roomsPath);
    const links = ref(linksPath);
    return {
      sheetId,
      versionId,
      legend,
      detections,
      rooms,
      links,
      thumbs,
      stats: v.stats,
      expiresAt: new Date(Number.isFinite(expires) ? expires : Date.now()).toISOString(),
    };
  }

  private async thumbIdsOf(prefix: string, legendPath: string | null, detectionsPath: string | null) {
    const key = `${prefix}|${legendPath ? 'L' : ''}${detectionsPath ? 'D' : ''}`;
    const hit = this.thumbIds.get(key);
    if (hit) return hit;
    const legend: string[] = [];
    const clusters: string[] = [];
    if (legendPath) {
      const parsed = LegendThumbsView.safeParse(await this.readArtifact(legendPath));
      if (parsed.success) {
        for (const e of parsed.data.entries) if (e.thumb !== null) legend.push(e.id);
      } else {
        this.logger.warn({ path: legendPath }, 'legend artifact unreadable; no crops');
      }
    }
    if (detectionsPath) {
      const parsed = ClustersView.safeParse(await this.readArtifact(detectionsPath));
      if (parsed.success) {
        for (const c of parsed.data.unknownClusters) if (c.thumb !== null) clusters.push(c.id);
      } else {
        this.logger.warn({ path: detectionsPath }, 'detections artifact unreadable; no crops');
      }
    }
    // Legend rows first (the confirmation screen needs all of them), then clusters; capped (each URL = 1 signBlob).
    const room = Math.max(0, OVERLAY_MAX_THUMBS - legend.length);
    if (legend.length > OVERLAY_MAX_THUMBS || clusters.length > room) {
      this.logger.warn({ prefix, legend: legend.length, clusters: clusters.length }, 'overlay crops capped');
    }
    const out = { legend: legend.slice(0, OVERLAY_MAX_THUMBS), clusters: clusters.slice(0, room) };
    this.thumbIds.set(key, out);
    while (this.thumbIds.size > UnderstandingService.THUMB_CACHE_MAX) this.thumbIds.delete(this.thumbIds.keys().next().value as string);
    return out;
  }

  private async readArtifact(path: string): Promise<unknown> {
    try {
      return await this.artifacts.readJson(path);
    } catch (err) {
      if (err instanceof ArtifactTooLargeError || err instanceof SyntaxError) {
        this.logger.warn({ path, err: (err as Error).message }, 'artifact rejected');
        return null;
      }
      throw err;
    }
  }

  // ------------------------------------------------------------------ legend entries
  async listLegendEntries(user: AuthContext, projectId: string, q: ListLegendEntriesQuery): Promise<LegendEntryPage> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'viewer');
    const page = await this.repo.listLegendEntries(orgId, projectId, {
      limit: q.limit,
      ...(q.cursor ? { cursor: q.cursor } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.sheetId ? { sheetId: q.sheetId } : {}),
    });
    const thumbOf = new Map<string, string>();
    for (const e of page.items) {
      const p = this.entryThumbPath(orgId, projectId, e);
      if (p) thumbOf.set(e.id, p);
    }
    const signed = thumbOf.size ? await this.signer.signRead([...thumbOf.values()]) : new Map<string, SignedUrl>();
    let expires = Number.POSITIVE_INFINITY;
    const items: LegendEntryItem[] = page.items.map((e) => {
      const p = thumbOf.get(e.id);
      const s = p ? signed.get(p) : undefined;
      if (s) expires = Math.min(expires, s.expiresAt.getTime());
      return { ...e, thumbUrl: s?.url ?? null };
    });
    return { items, nextCursor: page.nextCursor, expiresAt: Number.isFinite(expires) ? new Date(expires).toISOString() : null };
  }

  /**
   * The crop of an entry, only when the worker-written `thumbPath` equals a path derived from the authorized
   * org/project and the entry's own sheet/version/id (legend crop, or the cluster crop of an API-created entry).
   */
  private entryThumbPath(orgId: string, projectId: string, e: LegendEntry): string | null {
    if (!e.thumbPath || !validId(e.sheetId) || !validId(e.versionId)) return null;
    const candidates = [storagePaths.legendThumb(orgId, projectId, e.sheetId, e.versionId, e.id)];
    const cluster = /_(u_[A-Za-z0-9-]+)$/.exec(e.id)?.[1];
    if (cluster && e.id === clusterEntryId(e.sheetId, cluster)) {
      candidates.push(storagePaths.unknownThumb(orgId, projectId, e.sheetId, e.versionId, cluster));
    }
    return candidates.includes(e.thumbPath) ? e.thumbPath : null;
  }

  async patchLegendEntry(user: AuthContext, projectId: string, entryId: string, body: PatchLegendEntryRequest): Promise<PatchLegendEntryResponse> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'editor');
    if (!LegendEntryIdSchema.safeParse(entryId).success || !validId(entryId)) throw notFound('legend entry');
    const entry = await this.repo.getLegendEntry(orgId, projectId, entryId);
    if (!entry) throw notFound('legend entry');
    if (!SymbolSignatureSchema.safeParse(entry.signature).success) {
      throw new ApiException(HttpStatus.CONFLICT, 'conflict', 'this legend entry has no valid symbol signature; reprocess the sheet');
    }

    let decision: LegendDecision;
    if (body.action === 'ignore') {
      decision = { action: 'ignore' };
    } else {
      const cls: SymbolClass | undefined = body.class ?? suggestedTaxonomyClass(entry);
      if (!cls) {
        throw new ApiException(HttpStatus.BAD_REQUEST, 'validation_failed', 'class is required: the entry has no taxonomy suggestion', [
          { path: 'class', message: 'required' },
        ]);
      }
      decision = {
        action: body.action,
        class: cls,
        ...(body.itemCode !== undefined ? { itemCode: body.itemCode } : {}),
        ...(body.label !== undefined ? { label: body.label } : {}),
      };
    }
    const res = await this.repo.decideLegendEntry(orgId, projectId, entryId, decision, user.uid);
    if (!res) throw notFound('legend entry');
    await this.markStale(orgId, projectId, 'legend');
    return res;
  }

  // ------------------------------------------------------------------ unknown clusters
  async resolveUnknownCluster(
    user: AuthContext,
    projectId: string,
    clusterId: string,
    body: ResolveUnknownClusterRequest,
    traceparent: string,
  ): Promise<ResolveUnknownClusterResponse> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'editor');
    if (!ClusterIdSchema.safeParse(clusterId).success) throw notFound('cluster');
    const sheet = await this.repo.getSheet(orgId, projectId, body.sheetId);
    if (!sheet) throw notFound('sheet');
    const v = await this.repo.getVersion(orgId, projectId, body.sheetId, body.versionId);
    if (!v) throw notFound('version');
    if (v.status !== 'ready' || !v.artifacts.detections) {
      throw new ApiException(HttpStatus.CONFLICT, 'not_ready', 'detections are not available for this version');
    }
    const detections = await this.readArtifact(storagePaths.detections(orgId, projectId, body.sheetId, body.versionId));
    const parsed = ClustersView.safeParse(detections);
    if (!parsed.success) throw new ApiException(HttpStatus.CONFLICT, 'not_ready', 'detections artifact is missing or invalid');
    const cluster = parsed.data.unknownClusters.find((c) => c.id === clusterId);
    if (!cluster) throw notFound('cluster');
    const signature = SymbolSignatureSchema.safeParse(cluster.signature);
    if (!signature.success) throw new ApiException(HttpStatus.CONFLICT, 'conflict', 'the cluster has no valid symbol signature');

    const ignored = body.ignore === true; // the contract guarantees exactly one of class / ignore
    const entryId = clusterEntryId(body.sheetId, clusterId);
    if (body.createLegendEntry && !(LegendEntryIdSchema.safeParse(entryId).success && validId(entryId))) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'validation_failed', 'sheet id too long for a legend entry id', [{ path: 'sheetId', message: 'too long' }]);
    }
    const { mapping, legendEntry } = await this.repo.resolveUnknownCluster(
      orgId,
      projectId,
      {
        clusterId,
        signature: signature.data,
        sheetId: body.sheetId,
        versionId: body.versionId,
        class: ignored ? null : (body.class as SymbolClass),
        ignored,
        itemCode: ignored ? null : (body.itemCode ?? null),
        label: ignored ? IGNORED_LABEL : SYMBOL_CLASS_INFO[body.class as SymbolClass].he,
        legendEntry: body.createLegendEntry
          ? { id: entryId, thumbPath: cluster.thumb !== null ? storagePaths.unknownThumb(orgId, projectId, body.sheetId, body.versionId, clusterId) : null }
          : null,
      },
      user.uid,
    );

    await this.markStale(orgId, projectId, 'cluster');
    // The worker reads symbolMappings while spotting symbols, so a reprocess of this sheet applies the answer to
    // every instance of the cluster. Other sheets pick it up on their next run (NOTES.md: gap).
    const reprocess: ReprocessOutcome[] = [await this.reprocessSheet(user, projectId, body.sheetId, body.versionId, sheet.currentVersionId, traceparent)];
    return { clusterId, signature: signature.data, mapping, legendEntry, reprocess };
  }

  private async reprocessSheet(
    user: AuthContext,
    projectId: string,
    sheetId: string,
    versionId: string,
    currentVersionId: string | null,
    traceparent: string,
  ): Promise<ReprocessOutcome> {
    const skipped = (reason: string): ReprocessOutcome => ({ sheetId, status: 'skipped', reason, versionId: null, jobId: null });
    if (currentVersionId !== versionId) return skipped('not_current');
    try {
      const r = await this.sheets.reprocess(user, projectId, sheetId, traceparent);
      return { sheetId, status: 'queued', reason: null, versionId: r.sheetVersion.id, jobId: r.jobId };
    } catch (err) {
      if (err instanceof ApiException && err.getStatus() === HttpStatus.CONFLICT) return skipped('in_progress');
      if (err instanceof ApiException && err.getStatus() === HttpStatus.SERVICE_UNAVAILABLE) return skipped('publish_failed');
      throw err;
    }
  }
}

/** Label of a signature resolved as "not relevant". */
export const IGNORED_LABEL = 'לא רלוונטי';

/** Id of the confirmed legend entry created from a resolved unknown cluster. */
export const clusterEntryId = (sheetId: string, clusterId: string) => `le_${sheetId}_${clusterId}`;

function suggestedTaxonomyClass(e: LegendEntry): SymbolClass | undefined {
  const p = SymbolClassSchema.safeParse(e.suggestedClass);
  return p.success ? p.data : undefined;
}
