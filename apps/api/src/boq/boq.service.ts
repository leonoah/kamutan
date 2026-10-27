import { createHash, randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  BOQ_BUILD_JOB_SCHEMA_VERSION,
  BOQ_EVIDENCE_PATH_RE,
  BoqEvidenceItemSchema,
  chapterKey,
  compareItemCodes,
  DEFAULT_BOQ_TEMPLATE,
  DocIdSchema,
  EXPORT_URL_TTL_SECONDS,
  JOB_TYPES,
  storagePaths,
  type BoqEvidenceItem,
  type BoqLine,
  type BoqLineEvidenceResponse,
  type BoqSheetEvidenceResponse,
  type BoqTemplate,
  type BoqView,
  type ExportBoqRequest,
  type ExportBoqResponse,
  type GetBoqQuery,
  type PatchBoqLineRequest,
  type PatchBoqLineResponse,
  type Project,
  type RequestBoqBuildResponse,
} from '@kamutan/contracts';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth-context';
import { ApiException, forbidden, notFound } from '../common/api-exception';
import { countLines } from '../db/boq-docs';
import { BOQ_REPOSITORY, type BoqRepository } from '../db/boq-repository';
import { REPOSITORY, RepoConflictError, type Repository } from '../db/repository';
import { INGEST_QUEUE, type IngestQueue } from '../queue/ingest-queue';
import { ARTIFACT_READER, ArtifactTooLargeError, type ArtifactReader } from '../understanding/artifact-reader';
import { sanitizeFilename } from '../uploads/filename';
import { BOQ_STORAGE, type BoqStorage } from './boq-storage';
import { buildBoqWorkbook, floorsOf, type EvidenceGroup } from './excel';

const validId = (s: string) => DocIdSchema.safeParse(s).success;
/** Lenient view of the evidence file: only `lines` is needed; items are validated per line on use. */
const EvidenceView = z.object({ lines: z.record(z.unknown()) });
const LenientItems = z.array(BoqEvidenceItemSchema.strip());
export const EVIDENCE_PAGE_MAX = 2000;

/** Order of lines everywhere (UI, export): chapter (numeric-aware), natural code, id. */
export function compareLines(a: BoqLine, b: BoqLine): number {
  return compareItemCodes(chapterKey(a.chapter), chapterKey(b.chapter)) || compareItemCodes(a.code, b.code) || a.id.localeCompare(b.id);
}

/** Project BOQ: build requests, lines (+ review PATCH), evidence and the Excel export (Sprint 3). */
@Injectable()
export class BoqService {
  private readonly logger = new Logger('BoqService');
  /** Evidence files are immutable per build → parsed `lines` cached per path (small, per instance). */
  private readonly evidenceCache = new Map<string, Record<string, unknown>>();
  private static readonly EVIDENCE_CACHE_MAX = 4;

  constructor(
    private readonly access: AccessService,
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Inject(BOQ_REPOSITORY) private readonly boq: BoqRepository,
    @Inject(BOQ_STORAGE) private readonly storage: BoqStorage,
    @Inject(INGEST_QUEUE) private readonly queue: IngestQueue,
    @Optional() @Inject(ARTIFACT_READER) private readonly artifacts?: ArtifactReader,
  ) {}

  /** Link groups of one sheet version (links.json.gz, immutable → cached per path). Empty map when absent/invalid. */
  private readonly linksCache = new Map<string, Map<string, LinkGroupInfo>>();
  private async linkGroupsOf(orgId: string, projectId: string, sheetId: string, versionId: string): Promise<Map<string, LinkGroupInfo>> {
    if (!validId(sheetId) || !validId(versionId) || !this.artifacts) return new Map();
    const path = storagePaths.links(orgId, projectId, sheetId, versionId);
    const hit = this.linksCache.get(path);
    if (hit) return hit;
    let raw: unknown = null;
    try {
      raw = await this.artifacts.readJson(path);
    } catch (err) {
      if (!(err instanceof ArtifactTooLargeError || err instanceof SyntaxError)) throw err;
    }
    const parsed = LinksView.safeParse(raw);
    const out = new Map<string, LinkGroupInfo>();
    if (parsed.success) for (const g of parsed.data.groups) out.set(g.id, { kind: g.kind ?? null, switchIds: g.switchIds, pointIds: g.pointIds, luminaireIds: g.luminaireIds });
    this.linksCache.set(path, out);
    while (this.linksCache.size > 64) this.linksCache.delete(this.linksCache.keys().next().value as string);
    return out;
  }

  private async linkGroupList(orgId: string, projectId: string, groups: readonly EvidenceSheetGroup[]) {
    const out: NonNullable<BoqLineEvidenceResponse['linkGroups']> = [];
    for (const g of groups) {
      if (!g.linkGroupIds.length) continue;
      const info = await this.linkGroupsOf(orgId, projectId, g.sheetId, g.versionId);
      for (const id of g.linkGroupIds) {
        const i = info.get(id);
        out.push({ sheetId: g.sheetId, versionId: g.versionId, linkGroupId: id, floor: g.floor, kind: i?.kind ?? null, switchIds: i?.switchIds ?? [], pointIds: i?.pointIds ?? [], luminaireIds: i?.luminaireIds ?? [] });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ build
  async requestBuild(user: AuthContext, projectId: string, traceparent: string): Promise<RequestBoqBuildResponse> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'editor');
    await this.boq.seedDefaults(orgId); // the worker needs the org's rules + template
    const r = await this.boq.requestBuild(orgId, projectId, user.uid, JOB_TYPES.boqBuild);
    if (!r) throw notFound('project');
    if (!r.deduplicated && r.jobId) {
      try {
        await this.queue.publish({ schemaVersion: BOQ_BUILD_JOB_SCHEMA_VERSION, type: JOB_TYPES.boqBuild, jobId: r.jobId, orgId, projectId, buildId: r.build.id, traceparent });
      } catch (err) {
        this.logger.error({ err: (err as Error).message, buildId: r.build.id }, 'boq.build publish failed');
        await this.boq.failBuild(orgId, projectId, r.build.id, r.jobId, { code: 'publish_failed', message: 'could not schedule the build' });
        throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'service_unavailable', 'could not schedule the BOQ build; retry');
      }
    }
    return { build: r.build, deduplicated: r.deduplicated, jobId: r.jobId };
  }

  // ------------------------------------------------------------------ view
  async view(user: AuthContext, projectId: string, q: GetBoqQuery): Promise<BoqView> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'viewer');
    const [project, org, all] = await Promise.all([this.repo.getProject(orgId, projectId), this.repo.getOrg(orgId), this.boq.listLines(orgId, projectId)]);
    if (!project) throw notFound('project');
    const lines = all.sort(compareLines);
    const filtered = lines.filter(
      (l) => (!q.chapter || chapterKey(l.chapter) === chapterKey(q.chapter)) && (!q.level || l.level === q.level) && (!q.status || l.status === q.status),
    );
    let start = 0;
    if (q.cursor) {
      const idx = filtered.findIndex((l) => l.id === q.cursor);
      start = idx >= 0 ? idx + 1 : filtered.length;
    }
    const items = filtered.slice(start, start + q.limit);
    const boq = project.boq;
    const buildId = boq?.pendingBuildId ?? boq?.latestBuildId ?? null;
    const build = buildId ? await this.boq.getBuild(orgId, projectId, buildId) : null;
    return {
      summary: {
        latestBuildId: boq?.latestBuildId ?? null,
        builtAt: boq?.builtAt ?? null,
        stale: boq?.stale ?? false,
        staleReason: boq?.staleReason ?? null,
        build,
        counts: countLines(lines),
        floors: floorsOf(lines),
        blockExportOnRed: org?.settings.blockExportOnRed ?? true,
      },
      items,
      nextCursor: filtered.length > start + q.limit && items.length ? (items.at(-1) as BoqLine).id : null,
    };
  }

  // ------------------------------------------------------------------ PATCH line
  /**
   * status / note: reviewer+ (SEC-07 "שינוי סטטוס ואישור שורה"); qtyOverride: editor+ with a reason.
   * The transition itself is validated against the current doc inside the transaction (409 on conflict).
   */
  async patchLine(user: AuthContext, projectId: string, lineId: string, req: PatchBoqLineRequest): Promise<PatchBoqLineResponse> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'reviewer');
    if (req.qtyOverride !== undefined) {
      const role = await this.access.roleIn(user, orgId);
      if (!role || !['admin', 'editor'].includes(role)) throw forbidden('overriding a quantity requires the editor role');
    }
    if (!validId(lineId)) throw notFound('line');
    try {
      const line = await this.boq.patchLine(orgId, projectId, lineId, req, user.uid);
      if (!line) throw notFound('line');
      return { line };
    } catch (err) {
      if (err instanceof RepoConflictError) {
        const msg = err.reason === 'approved_locked' ? 'the line is approved; un-approve it (status "reviewed") before changing it' : 'status transition not allowed';
        throw new ApiException(HttpStatus.CONFLICT, 'conflict', msg, [{ path: 'status', message: err.reason }]);
      }
      throw err;
    }
  }

  // ------------------------------------------------------------------ evidence
  async evidence(user: AuthContext, projectId: string, lineId: string): Promise<BoqLineEvidenceResponse> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'viewer');
    if (!validId(lineId)) throw notFound('line');
    const [line, project] = await Promise.all([this.boq.getLine(orgId, projectId, lineId), this.repo.getProject(orgId, projectId)]);
    if (!line || !project) throw notFound('line');
    const { path, buildId } = this.evidencePathOf(orgId, projectId, project, line);
    if (!path) return { lineId, buildId: null, items: [], bySheet: [], truncated: false };
    const all = await this.evidenceItems(path, lineId);
    const items = all.slice(0, EVIDENCE_PAGE_MAX);
    const groups = groupEvidence(all);
    return {
      lineId,
      buildId,
      items,
      bySheet: groups.map(({ sheetId, versionId, floor, count }) => ({ sheetId, versionId, floor, count })),
      linkGroups: await this.linkGroupList(orgId, projectId, groups),
      truncated: all.length > items.length,
    };
  }

  /** Marker → line lookup for one sheet version, from the latest build's evidence (web: click a marker → its line). */
  async sheetEvidence(user: AuthContext, projectId: string, sheetId: string, versionId: string): Promise<BoqSheetEvidenceResponse> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'viewer');
    const project = await this.repo.getProject(orgId, projectId);
    if (!project) throw notFound('project');
    const latest = project.boq?.latestBuildId ?? null;
    const empty = { sheetId, versionId, buildId: latest, detections: {}, linkGroups: {} };
    if (!latest || !validId(latest)) return { ...empty, buildId: null };
    const lines = await this.evidenceLines(storagePaths.boqEvidence(orgId, projectId, latest));
    if (!lines) return empty;
    const detections: Record<string, string[]> = {};
    const linkGroups: Record<string, string[]> = {};
    const add = (m: Record<string, string[]>, k: string, lineId: string) => {
      const arr = (m[k] ??= []);
      if (!arr.includes(lineId)) arr.push(lineId);
    };
    for (const [lineId, raw] of Object.entries(lines)) {
      if (!validId(lineId) || !Array.isArray(raw)) continue;
      for (const it of raw as Array<Record<string, unknown>>) {
        if (!it || it.sheetId !== sheetId || it.versionId !== versionId) continue;
        if (typeof it.detectionId === 'string' && it.detectionId.length <= 128) add(detections, it.detectionId, lineId);
        if (typeof it.linkGroupId === 'string' && it.linkGroupId.length <= 128) add(linkGroups, it.linkGroupId, lineId);
      }
    }
    return { ...empty, detections, linkGroups };
  }

  /** The line's own evidenceRef when it is THIS org/project's evidence path; else the latest build's. */
  private evidencePathOf(orgId: string, projectId: string, project: Project, line: BoqLine): { path: string | null; buildId: string | null } {
    const m = line.evidenceRef ? BOQ_EVIDENCE_PATH_RE.exec(line.evidenceRef) : null;
    if (m && m[1] === orgId && m[2] === projectId) return { path: line.evidenceRef as string, buildId: m[3] as string };
    const latest = line.buildId ?? project.boq?.latestBuildId ?? null;
    return latest && validId(latest) ? { path: storagePaths.boqEvidence(orgId, projectId, latest), buildId: latest } : { path: null, buildId: null };
  }

  private async evidenceLines(path: string): Promise<Record<string, unknown> | null> {
    const hit = this.evidenceCache.get(path);
    if (hit) return hit;
    let raw: unknown;
    try {
      raw = await this.storage.readEvidence(path);
    } catch (err) {
      if (err instanceof ArtifactTooLargeError || err instanceof SyntaxError) {
        this.logger.warn({ path, err: (err as Error).message }, 'evidence rejected');
        return null;
      }
      throw err;
    }
    const parsed = EvidenceView.safeParse(raw);
    if (!parsed.success) return null;
    this.evidenceCache.set(path, parsed.data.lines);
    while (this.evidenceCache.size > BoqService.EVIDENCE_CACHE_MAX) this.evidenceCache.delete(this.evidenceCache.keys().next().value as string);
    return parsed.data.lines;
  }

  private async evidenceItems(path: string, lineId: string): Promise<BoqEvidenceItem[]> {
    const lines = await this.evidenceLines(path);
    const parsed = LenientItems.safeParse(lines?.[lineId] ?? []);
    if (!parsed.success) {
      this.logger.warn({ path, lineId }, 'evidence items malformed');
      return [];
    }
    return parsed.data;
  }

  // ------------------------------------------------------------------ export
  async export(user: AuthContext, projectId: string, req: ExportBoqRequest): Promise<ExportBoqResponse> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'editor');
    const [project, org, all] = await Promise.all([this.repo.getProject(orgId, projectId), this.repo.getOrg(orgId), this.boq.listLines(orgId, projectId)]);
    if (!project) throw notFound('project');
    if (all.length === 0) throw new ApiException(HttpStatus.CONFLICT, 'not_ready', 'the project has no BOQ lines yet; build the BOQ first');
    const lines = all.sort(compareLines);
    const counts = countLines(lines);
    // A red line a human has approved is handled (spec: "לבדיקה" = still needs a person); only unapproved red lines block.
    const openRed = lines.filter((l) => l.level === 'red' && l.status !== 'approved').length;
    if ((org?.settings.blockExportOnRed ?? true) && openRed > 0) {
      throw new ApiException(HttpStatus.CONFLICT, 'export_blocked', `export blocked by org policy: ${openRed} line(s) need review`, [{ path: 'red', message: String(openRed) }]);
    }
    const template = await this.templateFor(orgId, req.templateId);

    const latest = project.boq?.latestBuildId ?? null;
    const evidence = latest && validId(latest) ? await this.evidenceGroups(orgId, projectId, storagePaths.boqEvidence(orgId, projectId, latest), lines) : new Map();
    const floorNames = Object.fromEntries(project.floors.map((f) => [f.code, f.name]));
    const date = new Date();
    const data = await buildBoqWorkbook({
      projectName: project.name,
      ...(org?.name ? { orgName: org.name } : {}),
      date,
      template,
      lines,
      split: req.split,
      markDraft: req.markDraft,
      evidence,
      vatRate: org?.settings.vatRate ?? template.vatRate ?? 0.18,
      floorNames,
    });
    const exportId = randomUUID();
    const path = storagePaths.boqExportFile(orgId, projectId, exportId);
    await this.storage.writeExport(path, data);
    const fileName = exportFileName(project.name, date);
    await this.boq.createExport(orgId, projectId, {
      id: exportId,
      templateId: template.id,
      split: req.split,
      markDraft: req.markDraft,
      storagePath: path,
      buildId: latest,
      counts,
      sha256: createHash('sha256').update(data).digest('hex'),
      sizeBytes: data.length,
      createdBy: user.uid,
      createdAt: date.toISOString(),
    });
    const signed = await this.storage.signExport(path, fileName, EXPORT_URL_TTL_SECONDS);
    this.logger.log({ orgId, projectId, exportId, lines: counts.lines, red: counts.red, yellow: counts.yellow }, 'boq exported');
    return { exportId, url: signed.url, expiresAt: signed.expiresAt.toISOString(), fileName, counts, hasWarnings: counts.red + counts.yellow > 0 };
  }

  private async templateFor(orgId: string, templateId: string | undefined): Promise<BoqTemplate> {
    if (templateId) {
      const t = await this.boq.getTemplate(orgId, templateId);
      if (!t) throw notFound('template');
      return t;
    }
    let list = await this.boq.listTemplates(orgId);
    if (!list.some((t) => t.default)) {
      await this.boq.seedDefaults(orgId);
      list = await this.boq.listTemplates(orgId);
    }
    return list.find((t) => t.default) ?? { ...DEFAULT_BOQ_TEMPLATE, updatedAt: null };
  }

  /** lineId → (sheet title, floor, count) for the "ראיות" sheet. */
  private async evidenceGroups(orgId: string, projectId: string, path: string, lines: readonly BoqLine[]): Promise<Map<string, EvidenceGroup[]>> {
    const evLines = await this.evidenceLines(path);
    const out = new Map<string, EvidenceGroup[]>();
    if (!evLines) return out;
    const titles = await this.sheetTitles(orgId, projectId);
    for (const l of lines) {
      const parsed = LenientItems.safeParse(evLines[l.id] ?? []);
      if (!parsed.success || parsed.data.length === 0) continue;
      const groups = groupEvidence(parsed.data);
      const out2: EvidenceGroup[] = [];
      for (const g of groups) {
        const info = g.linkGroupIds.length ? await this.linkGroupsOf(orgId, projectId, g.sheetId, g.versionId) : new Map<string, LinkGroupInfo>();
        out2.push({
          sheet: titles.get(g.sheetId) ?? g.sheetId,
          floor: g.floor,
          count: g.count,
          detectionIds: g.detectionIds,
          linkGroups: g.linkGroupIds.map((id) => ({ id, switchIds: info.get(id)?.switchIds ?? [], pointIds: info.get(id)?.pointIds ?? [] })),
        });
      }
      out.set(l.id, out2);
    }
    return out;
  }

  private async sheetTitles(orgId: string, projectId: string): Promise<Map<string, string>> {
    const titles = new Map<string, string>();
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await this.repo.listSheets(orgId, projectId, { limit: 200, ...(cursor ? { cursor } : {}) });
      for (const s of page.items) titles.set(s.id, s.title || s.classification?.sheetTitle || s.id);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return titles;
  }
}

/** Evidence items grouped by (sheet, version, floor), in first-seen order. */
export interface EvidenceSheetGroup {
  sheetId: string;
  versionId: string;
  floor: string | null;
  /** Units: distinct (sheet, version, linkGroupId) for composite evidence, else one per item (or its `quantity`) → sums to the line qty. */
  count: number;
  detectionIds: string[];
  linkGroupIds: string[];
}

/**
 * Evidence grouped by (sheet, version, floor) in first-seen order. A link group (switches + luminaires of one composite
 * unit) is ONE unit, attributed to the floor of its first item; items without a linkGroupId are one unit each.
 */
export function groupEvidence(items: readonly BoqEvidenceItem[]): EvidenceSheetGroup[] {
  const unitFloor = new Map<string, string | null>();
  const groups = new Map<string, EvidenceSheetGroup>();
  for (const it of items) {
    const unit = it.linkGroupId ? `${it.sheetId}\u0000${it.versionId}\u0000${it.linkGroupId}` : null;
    if (unit && !unitFloor.has(unit)) unitFloor.set(unit, it.floor);
    const floor = unit ? (unitFloor.get(unit) ?? null) : it.floor;
    const k = `${it.sheetId}\u0000${it.versionId}\u0000${floor ?? ''}`;
    let g = groups.get(k);
    if (!g) {
      g = { sheetId: it.sheetId, versionId: it.versionId, floor, count: 0, detectionIds: [], linkGroupIds: [] };
      groups.set(k, g);
    }
    g.detectionIds.push(it.detectionId);
    // Sprint 4: measured items (rooms m², measures) contribute their `quantity`, everything else one unit.
    if (!it.linkGroupId) g.count = Math.round((g.count + (typeof it.quantity === 'number' ? it.quantity : 1)) * 1e6) / 1e6;
    else if (!g.linkGroupIds.includes(it.linkGroupId)) {
      g.linkGroupIds.push(it.linkGroupId);
      g.count++;
    }
  }
  return [...groups.values()];
}

/** Lenient view of links.json.gz: only what the evidence listing needs. */
const LinksView = z.object({
  groups: z
    .array(
      z.object({
        id: z.string().max(128),
        kind: z.string().max(32).optional(),
        switchIds: z.array(z.string().max(128)).max(64).default([]),
        pointIds: z.array(z.string().max(128)).max(256).default([]),
        luminaireIds: z.array(z.string().max(128)).max(512).default([]),
      }),
    )
    .max(5000),
});
export type LinkGroupInfo = { kind: string | null; switchIds: string[]; pointIds: string[]; luminaireIds: string[] };

/** "כתב כמויות - <project> - dd.mm.yyyy.xlsx" (sanitised; never part of a storage path). */
export function exportFileName(projectName: string, d: Date): string {
  const date = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  return sanitizeFilename(`כתב כמויות - ${projectName} - ${date}.xlsx`, 'xlsx');
}
