import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  DocIdSchema,
  INGEST_JOB_SCHEMA_VERSION,
  JOB_TYPES,
  storagePaths,
  tileKey,
  tileLevels,
  TILES_MAX_BATCH,
  type ConfirmSheetRequest,
  type ListSheetsQuery,
  type PutRegionsResponse,
  type Region,
  type ReprocessSheetResponse,
  type Sheet,
  type SheetPage,
  type SheetVersion,
  type TilesManifest,
  type TilesManifestQuery,
} from '@kamutan/contracts';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth-context';
import { ApiException, notFound } from '../common/api-exception';
import { RepoConflictError, REPOSITORY, type Repository } from '../db/repository';
import { INGEST_QUEUE, type IngestQueue } from '../queue/ingest-queue';
import { validateRegions } from './region-validation';
import { URL_SIGNER, type UrlSigner } from './url-signer';

const validId = (id: string) => DocIdSchema.safeParse(id).success;

/** Sheets, versions, confirmation, regions, tiles and reprocess. Every method authorizes via AccessService first. */
@Injectable()
export class SheetsService {
  private readonly logger = new Logger('SheetsService');

  constructor(
    private readonly access: AccessService,
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Inject(INGEST_QUEUE) private readonly queue: IngestQueue,
    @Inject(URL_SIGNER) private readonly signer: UrlSigner,
  ) {}

  async list(user: AuthContext, projectId: string, q: ListSheetsQuery): Promise<SheetPage> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'viewer');
    const page = await this.repo.listSheets(orgId, projectId, { limit: q.limit, cursor: q.cursor, sheetSetId: q.sheetSetId });
    // Doc ids sort "p10" before "p2"; order each page by (set, pageIndex) for display.
    const items = [...page.items].sort((a, b) => (a.sheetSetId === b.sheetSetId ? a.pageIndex - b.pageIndex : a.sheetSetId < b.sheetSetId ? -1 : 1));
    return { items, nextCursor: page.nextCursor };
  }

  async getVersion(user: AuthContext, projectId: string, sheetId: string, versionId: string): Promise<SheetVersion> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'viewer');
    if (!validId(sheetId) || !validId(versionId)) throw notFound('version');
    const v = await this.repo.getVersion(orgId, projectId, sheetId, versionId);
    if (!v) throw notFound('version');
    return v;
  }

  async confirm(user: AuthContext, projectId: string, sheetId: string, body: ConfirmSheetRequest): Promise<Sheet> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'editor');
    const sheet = await this.requireSheet(orgId, projectId, sheetId);
    if (body.regions) await this.checkRegions(orgId, projectId, sheet, body.regions);
    const updated = await this.mapConflict(() =>
      this.repo.confirmSheet(
        orgId,
        projectId,
        sheetId,
        {
          discipline: body.discipline,
          floors: body.floors,
          scaleDenominator: body.scaleDenominator,
          expectedVersionId: sheet.currentVersionId,
          ...(body.regions ? { regions: body.regions } : {}),
        },
        user.uid,
      ),
    );
    if (!updated) throw notFound('sheet');
    return updated;
  }

  async putRegions(user: AuthContext, projectId: string, sheetId: string, regions: Region[]): Promise<PutRegionsResponse> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'editor');
    const sheet = await this.requireSheet(orgId, projectId, sheetId);
    const version = await this.checkRegions(orgId, projectId, sheet, regions);
    const updated = await this.mapConflict(() => this.repo.setRegions(orgId, projectId, sheetId, version.id, regions, user.uid));
    if (!updated) throw notFound('sheet');
    return { sheetId, versionId: updated.id, regions: updated.regions };
  }

  async tilesManifest(user: AuthContext, projectId: string, sheetId: string, versionId: string, q: TilesManifestQuery): Promise<TilesManifest> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'viewer');
    if (!validId(sheetId) || !validId(versionId)) throw notFound('version');
    const v = await this.repo.getVersion(orgId, projectId, sheetId, versionId);
    if (!v) throw notFound('version');
    const tiles = v.artifacts.tiles;
    if (v.status !== 'ready' || !tiles) throw new ApiException(HttpStatus.CONFLICT, 'not_ready', 'tiles are not ready for this version');

    const grid = tileLevels(tiles);
    // Paths are derived from the ids (never from the worker-written prefix), so only this org's
    // artifacts can ever be signed.
    const paths = new Map<string, string>();
    if (q.z !== undefined) {
      const level = grid[q.z];
      if (!level) throw new ApiException(HttpStatus.BAD_REQUEST, 'validation_failed', `z must be < ${grid.length}`, [{ path: 'z', message: 'out of range' }]);
      const x0 = Math.min(q.x0 ?? 0, level.cols - 1);
      const x1 = Math.min(q.x1 ?? level.cols - 1, level.cols - 1);
      const y0 = Math.min(q.y0 ?? 0, level.rows - 1);
      const y1 = Math.min(q.y1 ?? level.rows - 1, level.rows - 1);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      if (count > TILES_MAX_BATCH) {
        throw new ApiException(HttpStatus.BAD_REQUEST, 'validation_failed', `at most ${TILES_MAX_BATCH} tiles per request (asked ${count})`, [
          { path: 'x1', message: 'range too large' },
        ]);
      }
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) paths.set(tileKey(q.z, x, y), storagePaths.tile(orgId, projectId, sheetId, versionId, q.z, x, y));
      }
    }
    const thumbPath = v.artifacts.thumbnail ? storagePaths.thumbnail(orgId, projectId, sheetId, versionId) : null;
    const signed = await this.signer.signRead([...paths.values(), ...(thumbPath ? [thumbPath] : [])]);

    const urls: Record<string, string> = {};
    let expires = Number.POSITIVE_INFINITY;
    for (const [key, path] of paths) {
      const s = signed.get(path);
      if (!s) continue;
      urls[key] = s.url;
      expires = Math.min(expires, s.expiresAt.getTime());
    }
    const thumb = thumbPath ? signed.get(thumbPath) : undefined;
    if (thumb) expires = Math.min(expires, thumb.expiresAt.getTime());
    if (!Number.isFinite(expires)) expires = Date.now();

    return {
      sheetId,
      versionId,
      page: v.page,
      tiles: { format: tiles.format, tileSize: tiles.tileSize, dpi: tiles.dpi, levels: tiles.levels, widthPx: tiles.widthPx, heightPx: tiles.heightPx },
      levelGrid: grid,
      thumbnailUrl: thumb?.url ?? null,
      urls,
      expiresAt: new Date(expires).toISOString(),
      maxBatch: TILES_MAX_BATCH,
    };
  }

  async reprocess(user: AuthContext, projectId: string, sheetId: string, traceparent: string): Promise<ReprocessSheetResponse> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'editor');
    if (!validId(sheetId)) throw notFound('sheet');
    const res = await this.mapConflict(() => this.repo.createReprocessVersion(orgId, projectId, sheetId, user.uid, JOB_TYPES.ingestSheetVersion));
    if (!res) throw notFound('sheet');
    try {
      await this.queue.publish({
        schemaVersion: INGEST_JOB_SCHEMA_VERSION,
        type: JOB_TYPES.ingestSheetVersion,
        jobId: res.jobId,
        orgId,
        projectId,
        sheetSetId: res.sheetSet.id,
        sheetId,
        pageIndex: res.sheet.pageIndex,
        versionId: res.version.id,
        storagePath: res.sheetSet.storagePath,
        sha256: res.sheetSet.sha256,
        fileKind: res.sheetSet.fileKind,
        traceparent,
      });
    } catch (err) {
      // The new version must not stay `queued` forever (it would block further reprocess requests).
      this.logger.error({ err: (err as Error).message, jobId: res.jobId }, 'publish failed');
      await this.repo
        .failJob(orgId, res.jobId, { code: 'publish_failed', message: 'could not schedule processing' }, { projectId, sheetId, versionId: res.version.id })
        .catch(() => undefined);
      throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'service_unavailable', 'could not schedule processing; retry');
    }
    return { sheet: res.sheet, sheetVersion: res.version, jobId: res.jobId };
  }

  private async requireSheet(orgId: string, projectId: string, sheetId: string): Promise<Sheet> {
    if (!validId(sheetId)) throw notFound('sheet');
    const sheet = await this.repo.getSheet(orgId, projectId, sheetId);
    if (!sheet) throw notFound('sheet');
    return sheet;
  }

  /** Regions belong to the current version and need its page geometry. */
  private async checkRegions(orgId: string, projectId: string, sheet: Sheet, regions: Region[]): Promise<SheetVersion> {
    const version = sheet.currentVersionId ? await this.repo.getVersion(orgId, projectId, sheet.id, sheet.currentVersionId) : null;
    if (!version?.page) throw new ApiException(HttpStatus.CONFLICT, 'not_ready', 'page geometry is not known yet for this sheet');
    const issues = validateRegions(regions, version.page);
    if (issues.length) throw new ApiException(HttpStatus.BAD_REQUEST, 'validation_failed', 'invalid regions', issues);
    return version;
  }

  private async mapConflict<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof RepoConflictError) {
        const msg = err.reason === 'in_progress' ? 'this sheet is already being processed' : 'the sheet changed; reload and retry';
        throw new ApiException(HttpStatus.CONFLICT, 'conflict', msg);
      }
      throw err;
    }
  }
}
