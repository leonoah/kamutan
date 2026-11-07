import { randomUUID, createHash } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  BoqLinesSnapshotSchema,
  COMPARE_NO_EXPORT_HE,
  COMPARE_NO_PREVIOUS_HE,
  COMPARE_NO_SNAPSHOT_HE,
  DocIdSchema,
  EXPORT_URL_TTL_SECONDS,
  storagePaths,
  type BoqBuild,
  type BoqCompareExportRequest,
  type BoqCompareExportResponse,
  type BoqCompareQuery,
  type BoqComparison,
  type BoqLinesSnapshot,
  type BoqBuildList,
  type BoqBuildListQuery,
  BOQ_LINES_SNAPSHOT_SCHEMA,
  displayDescription,
} from '@kamutan/contracts';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth-context';
import { ApiException, notFound } from '../common/api-exception';
import { BOQ_REPOSITORY, type BoqRepository } from '../db/boq-repository';
import { REPOSITORY, type Repository } from '../db/repository';
import { ArtifactTooLargeError } from '../understanding/artifact-reader';
import { sanitizeFilename } from '../uploads/filename';
import { BOQ_STORAGE, type BoqStorage } from './boq-storage';
import { buildCompareWorkbook, compareSnapshots } from './compare';
import { priceLines, pricedQty } from './pricing';

const validId = (s: string) => DocIdSchema.safeParse(s).success;
/** Builds looked at when searching the previous one. */
const BUILD_SCAN = 100;

const notReady = (message: string, path: string) => new ApiException(HttpStatus.CONFLICT, 'not_ready', message, [{ path, message: 'not_ready' }]);

/**
 * Sprint 8 "מה השתנה" (docs/agents/SPRINT8_BRIEF.md §2): two build snapshots (`boq/{buildId}/lines.json.gz`, Worker-BOQ)
 * compared on request (viewer+), and the Excel "תוספות ושינויים" (editor+, like every export; audited via the
 * exports record).
 */
@Injectable()
export class CompareService {
  private readonly logger = new Logger('CompareService');
  /** Snapshots are immutable per build → parsed snapshots cached per path (small, per instance). */
  private readonly cache = new Map<string, BoqLinesSnapshot>();

  constructor(
    private readonly access: AccessService,
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Inject(BOQ_REPOSITORY) private readonly boq: BoqRepository,
    @Inject(BOQ_STORAGE) private readonly storage: BoqStorage,
  ) {}

  /**
   * Integration: GET …/boq/builds (viewer+) — the compare picker: newest builds first with line count, snapshot flag
   * and the latest BOQ Excel export made from each.
   */
  async builds(user: AuthContext, projectId: string, q: BoqBuildListQuery): Promise<BoqBuildList> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'viewer');
    const project = await this.repo.getProject(orgId, projectId);
    if (!project) throw notFound('project');
    const [builds, exports] = await Promise.all([this.boq.listBuilds(orgId, projectId, q.limit), this.boq.listBoqExports(orgId, projectId, 200)]);
    const lastExport = new Map<string, { id: string; at: string }>();
    for (const e of exports) if (e.buildId && !lastExport.has(e.buildId)) lastExport.set(e.buildId, { id: e.id, at: e.createdAt }); // newest first
    return {
      items: builds.map((b) => ({
        buildId: b.id,
        status: b.status,
        trigger: b.trigger ?? null,
        createdAt: b.createdAt,
        finishedAt: b.finishedAt,
        lineCount: typeof b.stats?.lines === 'number' ? b.stats.lines : null,
        hasSnapshot: b.status === 'succeeded' && typeof b.linesRef === 'string' && b.linesRef === storagePaths.boqLinesSnapshot(orgId, projectId, b.id),
        exportedAt: lastExport.get(b.id)?.at ?? null,
        exportId: lastExport.get(b.id)?.id ?? null,
        latest: b.id === project.boq?.latestBuildId,
      })),
    };
  }

  async compare(user: AuthContext, projectId: string, q: BoqCompareQuery): Promise<BoqComparison> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'viewer');
    return (await this.resolve(orgId, projectId, q)).cmp;
  }

  async exportComparison(user: AuthContext, projectId: string, req: BoqCompareExportRequest): Promise<BoqCompareExportResponse> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'editor');
    const { cmp, projectName } = await this.resolve(orgId, projectId, req);
    const date = new Date();
    const data = await buildCompareWorkbook(cmp, projectName, date);
    const exportId = randomUUID();
    const path = storagePaths.boqExportFile(orgId, projectId, exportId);
    await this.storage.writeExport(path, data);
    const dd = `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;
    const fileName = sanitizeFilename(`תוספות ושינויים - ${projectName} - ${dd}.xlsx`, 'xlsx');
    await this.boq.createExport(orgId, projectId, {
      id: exportId,
      templateId: null,
      split: 'summed',
      markDraft: false,
      storagePath: path,
      buildId: cmp.to.buildId,
      counts: { lines: cmp.items.length, green: 0, yellow: 0, red: 0, draft: 0, reviewed: 0, approved: 0, overridden: 0 },
      sha256: createHash('sha256').update(data).digest('hex'),
      sizeBytes: data.length,
      createdBy: user.uid,
      createdAt: date.toISOString(),
      purpose: 'comparison',
      compare: { fromBuildId: cmp.from.buildId, toBuildId: cmp.to.buildId },
    });
    const signed = await this.storage.signExport(path, fileName, EXPORT_URL_TTL_SECONDS);
    this.logger.log({ orgId, projectId, exportId, from: cmp.from.buildId, to: cmp.to.buildId, items: cmp.items.length }, 'boq comparison exported');
    return { exportId, url: signed.url, expiresAt: signed.expiresAt.toISOString(), fileName, fromBuildId: cmp.from.buildId, toBuildId: cmp.to.buildId };
  }

  /** Picks `to` / `from` (explicit, previous succeeded build, or the build of the latest BOQ export) and diffs them. */
  private async resolve(orgId: string, projectId: string, q: { from?: string | undefined; to?: string | undefined; base: 'previous' | 'export' }) {
    const project = await this.repo.getProject(orgId, projectId);
    if (!project) throw notFound('project');
    const live = q.to === undefined;
    const toId = q.to ?? project.boq?.latestBuildId ?? null;
    if (!toId) throw notReady(COMPARE_NO_PREVIOUS_HE, 'to');
    const toBuild = await this.succeededBuild(orgId, projectId, toId, 'to');

    let fromBuild: BoqBuild;
    let base: BoqComparison['base'] = q.from ? 'explicit' : q.base;
    let fromExport: { exportId: string; exportedAt: string } | null = null;
    if (q.from) {
      fromBuild = await this.succeededBuild(orgId, projectId, q.from, 'from');
    } else if (q.base === 'export') {
      const exp = await this.boq.latestBoqExport(orgId, projectId);
      if (!exp || !exp.buildId) throw notReady(COMPARE_NO_EXPORT_HE, 'base');
      fromBuild = await this.succeededBuild(orgId, projectId, exp.buildId, 'from');
      fromExport = { exportId: exp.id, exportedAt: exp.createdAt };
    } else {
      const builds = await this.boq.listBuilds(orgId, projectId, BUILD_SCAN);
      const toAt = Date.parse(toBuild.createdAt ?? '') || Infinity;
      const prev = builds.find((b) => b.id !== toBuild.id && b.status === 'succeeded' && (Date.parse(b.createdAt ?? '') || 0) < toAt);
      if (!prev) throw notReady(COMPARE_NO_PREVIOUS_HE, 'from');
      fromBuild = prev;
      base = 'previous';
    }
    // Integration: no explicit `to` → the CURRENT lines priced now (today's overrides / prices / renames).
    const [from, to] = await Promise.all([this.snapshot(orgId, projectId, fromBuild.id, 'from'), live ? this.liveSnapshot(orgId, projectId, toBuild.id) : this.snapshot(orgId, projectId, toBuild.id, 'to')]);
    const titles = await this.sheetTitles(orgId, projectId);
    const cmp = compareSnapshots({
      projectId,
      base,
      from,
      to,
      fromAt: fromBuild.finishedAt ?? fromBuild.createdAt,
      toAt: toBuild.finishedAt ?? toBuild.createdAt,
      fromExport,
      titles,
    });
    if (live) cmp.to.live = true;
    return { cmp, projectName: project.name };
  }

  /**
   * The project's current lines as a snapshot (same shape the worker writes): effective qty, effective price
   * (`priceLines`), displayed description. `sheetVersions` = the latest build's snapshot when it has one (the lines come
   * from that build), else the union of the lines' own source versions.
   */
  private async liveSnapshot(orgId: string, projectId: string, buildId: string): Promise<BoqLinesSnapshot> {
    const [lines, items] = await Promise.all([this.boq.listLines(orgId, projectId), this.boq.listLibraryItems(orgId, { active: true })]);
    let sheetVersions: Record<string, string> | undefined;
    try {
      sheetVersions = (await this.snapshot(orgId, projectId, buildId, 'to')).sheetVersions;
    } catch (err) {
      if (!(err instanceof ApiException)) throw err;
    }
    if (!sheetVersions) {
      sheetVersions = {};
      for (const l of lines) for (const s of l.sourceVersions ?? []) sheetVersions[s.sheetId] ??= s.versionId;
    }
    return {
      schema: BOQ_LINES_SNAPSHOT_SCHEMA,
      projectId,
      buildId,
      createdAt: new Date().toISOString(),
      sheetVersions,
      lines: priceLines(lines, items).map((l) => ({
        lineId: l.id,
        chapter: l.chapter,
        code: l.code || '?',
        description: displayDescription(l),
        unit: l.unit,
        qty: pricedQty(l),
        computedQty: l.qty,
        qtyOverride: l.qtyOverride ?? null,
        price: l.unitPrice ?? null,
        priceSource: l.unitPriceSource ?? null,
        priceOverride: l.priceOverride ?? null,
        byFloor: l.byFloor ?? {},
        level: l.level,
        status: l.status,
        ...(l.needsInput ? { needsInput: true } : {}),
        sourceVersions: l.sourceVersions ?? [],
      })),
    };
  }

  private async succeededBuild(orgId: string, projectId: string, id: string, path: string): Promise<BoqBuild> {
    if (!validId(id)) throw notFound('build');
    const b = await this.boq.getBuild(orgId, projectId, id);
    if (!b) throw notFound('build');
    if (b.status !== 'succeeded') throw new ApiException(HttpStatus.CONFLICT, 'not_ready', 'the build has not finished', [{ path, message: b.status }]);
    return b;
  }

  /** The build's snapshot (path DERIVED from the authorized ids, never the stored string). 409 when absent. */
  private async snapshot(orgId: string, projectId: string, buildId: string, which: string): Promise<BoqLinesSnapshot> {
    const path = storagePaths.boqLinesSnapshot(orgId, projectId, buildId);
    const hit = this.cache.get(path);
    if (hit) return hit;
    let raw: unknown = null;
    try {
      raw = await this.storage.readLinesSnapshot(path);
    } catch (err) {
      if (!(err instanceof ArtifactTooLargeError || err instanceof SyntaxError)) throw err;
      this.logger.warn({ path, err: (err as Error).message }, 'lines snapshot rejected');
    }
    const parsed = BoqLinesSnapshotSchema.safeParse(raw);
    if (!parsed.success || parsed.data.buildId !== buildId || parsed.data.projectId !== projectId) {
      if (raw !== null) this.logger.warn({ path }, 'lines snapshot malformed');
      throw notReady(COMPARE_NO_SNAPSHOT_HE, which);
    }
    this.cache.set(path, parsed.data);
    while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value as string);
    return parsed.data;
  }

  private async sheetTitles(orgId: string, projectId: string): Promise<Map<string, string>> {
    const titles = new Map<string, string>();
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await this.repo.listSheets(orgId, projectId, { limit: 200, includeSuperseded: true, ...(cursor ? { cursor } : {}) });
      for (const s of page.items) titles.set(s.id, s.title || s.classification?.sheetTitle || s.id);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return titles;
  }
}
