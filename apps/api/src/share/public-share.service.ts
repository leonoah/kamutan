import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  DocIdSchema,
  effectiveQty,
  storagePaths,
  tileLevels,
  ShareTokenSchema,
  type BoqLine,
  type PublicShareBoq,
  type PublicShareMeta,
  type PublicShareOverlay,
  type PublicShareSheet,
  type ShareLink,
  type SheetVersion,
} from '@kamutan/contracts';
import { BOQ_STORAGE, type BoqStorage } from '../boq/boq-storage';
import { compareLines } from '../boq/boq.service';
import { floorsOf } from '../boq/excel';
import { ApiException, notFound } from '../common/api-exception';
import { countLines } from '../db/boq-docs';
import { BOQ_REPOSITORY, type BoqRepository } from '../db/boq-repository';
import { GOVERNANCE_REPOSITORY, type GovernanceRepository } from '../db/governance-repository';
import { ipPrefix } from '../db/governance-docs';
import { REPOSITORY, type Repository } from '../db/repository';
import { GOVERNANCE_STORAGE, type GovernanceStorage } from '../governance/governance-storage';
import { ReviewArtifacts } from '../review/artifact-views';
import { ArtifactTooLargeError } from '../understanding/artifact-reader';
import { linkState, linkWatermark, sha256Hex, shortIdOf } from './share-links.service';
import { ShareRateLimiter } from './share-rate-limit';
import { maskToTile, TileWatermarker, type TileRect } from './watermark';

export const SHARE_RATE_LIMITER = Symbol('SHARE_RATE_LIMITER');
export const TILE_WATERMARKER = Symbol('TILE_WATERMARKER');

/** Height (paper mm) of the bottom strip masked when the worker did not write `titleBlockMm`. */
export const TITLE_BLOCK_FALLBACK_MM = 45;
/** One `shareLinks/view` audit event per (link, IP prefix, endpoint) per window and instance. */
export const VIEW_AUDIT_WINDOW_MS = 5 * 60_000;
/** Share PDF redirect: signed URL lifetime (SEC-20 style short download link). */
export const SHARE_PDF_URL_TTL_SECONDS = 120;

/** 404 (unknown) / 410 (expired | revoked): the controller answers both with the same body. */
export class ShareUnavailableError extends Error {
  constructor(
    readonly status: 404 | 410,
    readonly state: 'unknown' | 'expired' | 'revoked',
  ) {
    super('share link not available');
  }
}

export class ShareRateLimitedError extends Error {
  constructor(readonly retryAfterSec: number) {
    super('too many requests');
  }
}

export interface ShareRequestCtx {
  ip: string | undefined;
  userAgent: string | undefined;
}

export interface ResolvedShare {
  orgId: string;
  projectId: string;
  link: ShareLink;
  lock: Record<string, string>;
}

const hashKey = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);
const DUMMY_ID = '_none_';
type Endpoint = 'meta' | 'boq' | 'overlay' | 'tiles' | 'pdf';

/**
 * Sprint 5 (FR-30, SEC-26–29): the public, unauthenticated, READ-ONLY share API. Token lookup by SHA-256 through the
 * `shareTokens/{hash}` index (+ a constant-time compare with the link's stored hash); unknown and expired/revoked
 * tokens cost the same reads. Only the link's locked versions are ever served; tiles are proxied with the watermark
 * burned in and the title block masked.
 */
@Injectable()
export class PublicShareService {
  private readonly logger = new Logger('PublicShareService');
  private readonly lastViewAudit = new Map<string, number>();

  constructor(
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Inject(GOVERNANCE_REPOSITORY) private readonly gov: GovernanceRepository,
    @Inject(BOQ_REPOSITORY) private readonly boq: BoqRepository,
    @Inject(BOQ_STORAGE) private readonly boqStorage: BoqStorage,
    @Inject(GOVERNANCE_STORAGE) private readonly storage: GovernanceStorage,
    @Inject(SHARE_RATE_LIMITER) private readonly limiter: ShareRateLimiter,
    @Inject(TILE_WATERMARKER) private readonly watermarker: TileWatermarker,
    private readonly artifacts: ReviewArtifacts,
  ) {}

  // ------------------------------------------------------------------ token → link
  async resolve(token: string, ctx: ShareRequestCtx, endpoint: Endpoint): Promise<ResolvedShare> {
    const ipKey = hashKey(ctx.ip ?? 'unknown');
    const tile = endpoint === 'tiles';
    const locked = this.limiter.locked(ipKey);
    if (!locked.ok) throw new ShareRateLimitedError(locked.retryAfterSec);
    const byIp = this.limiter.ip(ipKey, tile);
    if (!byIp.ok) throw new ShareRateLimitedError(byIp.retryAfterSec);

    const wellFormed = ShareTokenSchema.safeParse(token).success;
    const hash = sha256Hex(wellFormed ? token : `invalid:${token.slice(0, 64)}`);
    const idx = wellFormed ? await this.gov.lookupShareToken(hash) : null;
    // Same reads for unknown tokens (a dummy link read) — constant-time-ish lookups.
    const link = idx ? await this.gov.getShareLink(idx.orgId, idx.projectId, idx.linkId) : await this.gov.getShareLink(DUMMY_ID, DUMMY_ID, DUMMY_ID);
    const hashOk = !!link && link.tokenHash.length === hash.length && timingSafeEqual(Buffer.from(link.tokenHash), Buffer.from(hash));
    if (!idx || !link || !hashOk) {
      this.limiter.unknown(ipKey);
      throw new ShareUnavailableError(404, 'unknown');
    }
    const byToken = this.limiter.token(hash.slice(0, 32), tile);
    if (!byToken.ok) throw new ShareRateLimitedError(byToken.retryAfterSec);
    const state = linkState(link);
    if (state !== 'active') throw new ShareUnavailableError(410, state);
    const org = await this.repo.getOrg(idx.orgId);
    if (!org || org.status === 'offboarding') throw new ShareUnavailableError(410, 'revoked');
    return { orgId: idx.orgId, projectId: idx.projectId, link, lock: link.versionLockBySheet ?? {} };
  }

  /** `shareLinks/view` audit (deduplicated per window) and viewCount++ on meta. Never fails the request. */
  private async recordView(r: ResolvedShare, ctx: ShareRequestCtx, endpoint: Endpoint): Promise<void> {
    const prefix = ipPrefix(ctx.ip);
    const key = `${r.link.id}|${prefix}|${endpoint}`;
    const now = Date.now();
    const last = this.lastViewAudit.get(key);
    const audit = !last || now - last >= VIEW_AUDIT_WINDOW_MS;
    if (audit) {
      this.lastViewAudit.set(key, now);
      while (this.lastViewAudit.size > 20_000) this.lastViewAudit.delete(this.lastViewAudit.keys().next().value as string);
    }
    if (!audit && endpoint !== 'meta') return;
    try {
      await this.gov.recordShareView(r.orgId, r.projectId, r.link.id, {
        count: endpoint === 'meta',
        audit: audit
          ? {
              actorId: r.link.id,
              actorKind: 'share_link',
              entity: 'shareLinks',
              entityId: r.link.id,
              action: 'view',
              after: { projectId: r.projectId, linkId: r.link.id, endpoint, ipPrefix: prefix, userAgent: (ctx.userAgent ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, 200) },
            }
          : null,
      });
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, linkId: r.link.id }, 'share view not recorded');
    }
  }

  private maskOf(link: ShareLink, v: SheetVersion | null): TileRect | null {
    if (link.hideTitleBlock === false || !v?.page) return null;
    if (v.titleBlockMm) return v.titleBlockMm;
    const h = Math.min(TITLE_BLOCK_FALLBACK_MM, v.page.heightMm);
    return { x: 0, y: v.page.heightMm - h, w: v.page.widthMm, h };
  }

  private async lockedVersion(r: ResolvedShare, sheetId: string): Promise<SheetVersion> {
    const versionId = DocIdSchema.safeParse(sheetId).success ? r.lock[sheetId] : undefined;
    if (!versionId) throw notFound('sheet');
    const v = await this.repo.getVersion(r.orgId, r.projectId, sheetId, versionId);
    if (!v || v.status !== 'ready') throw notFound('sheet');
    return v;
  }

  // ------------------------------------------------------------------ endpoints
  async meta(token: string, ctx: ShareRequestCtx): Promise<PublicShareMeta> {
    const r = await this.resolve(token, ctx, 'meta');
    const project = await this.repo.getProject(r.orgId, r.projectId);
    if (!project) throw new ShareUnavailableError(410, 'revoked');
    const sheets: PublicShareSheet[] = [];
    for (const [sheetId, versionId] of Object.entries(r.lock).slice(0, 500)) {
      const [sheet, v] = await Promise.all([this.repo.getSheet(r.orgId, r.projectId, sheetId), this.repo.getVersion(r.orgId, r.projectId, sheetId, versionId)]);
      if (!sheet || !v) continue;
      const t = v.status === 'ready' ? v.artifacts.tiles : undefined;
      sheets.push({
        sheetId,
        versionId,
        title: sheet.title || sheet.classification?.sheetTitle || sheetId,
        discipline: sheet.discipline ?? null,
        floors: sheet.floors ?? [],
        page: v.page ? { widthMm: v.page.widthMm, heightMm: v.page.heightMm } : null,
        tiles: t ? { tileSize: t.tileSize, dpi: t.dpi, levels: t.levels, widthPx: t.widthPx, heightPx: t.heightPx } : null,
      });
    }
    let pdf: PublicShareMeta['pdf'] = null;
    if (r.link.allowPdfDownload) {
      const rec = r.link.pdfExportId ? await this.gov.getExport(r.orgId, r.projectId, r.link.pdfExportId) : null;
      pdf = { status: rec ? rec.status : 'failed' };
    }
    await this.recordView(r, ctx, 'meta');
    return {
      link: {
        shortId: shortIdOf(r.link.id),
        label: r.link.label ?? 'קישור שיתוף',
        recipient: r.link.recipient ?? null,
        expiresAt: r.link.expiresAt,
        createdAt: r.link.createdAt,
        hideTitleBlock: r.link.hideTitleBlock !== false,
        allowPdfDownload: r.link.allowPdfDownload,
        watermark: linkWatermark(r.link),
      },
      project: { name: project.name, address: r.link.hideTitleBlock === false ? (project.address ?? null) : null },
      sheets,
      pdf,
    };
  }

  /** Current BOQ lines (the reviewed state) — no notes, no override reasons, no user ids. */
  async boqView(token: string, ctx: ShareRequestCtx): Promise<PublicShareBoq> {
    const r = await this.resolve(token, ctx, 'boq');
    const lines = (await this.boq.listLines(r.orgId, r.projectId)).sort(compareLines);
    await this.recordView(r, ctx, 'boq');
    return {
      lines: lines.map((l: BoqLine) => ({
        id: l.id,
        chapter: l.chapter,
        code: l.code,
        description: l.description,
        unit: l.unit,
        qty: effectiveQty(l),
        overridden: l.qtyOverride !== null && l.qtyOverride !== undefined,
        level: l.level,
        status: l.status,
        reasons: (l.reasons ?? []).slice(0, 32),
        floor: l.floor ?? null,
        byFloor: l.byFloor ?? {},
      })),
      floors: floorsOf(lines),
      counts: (({ lines: n, green, yellow, red, approved }) => ({ lines: n, green, yellow, red, approved }))(countLines(lines)),
    };
  }

  async overlay(token: string, sheetId: string, ctx: ShareRequestCtx): Promise<PublicShareOverlay> {
    const r = await this.resolve(token, ctx, 'overlay');
    const v = await this.lockedVersion(r, sheetId);
    const mask = this.maskOf(r.link, v);
    const inMask = (p: { x: number; y: number }) => !!mask && p.x >= mask.x && p.x <= mask.x + mask.w && p.y >= mask.y && p.y <= mask.y + mask.h;
    const art = await this.artifacts.of(r.orgId, r.projectId, sheetId, v.id);
    const { detections, links } = await this.lineIndex(r, sheetId, v.id);
    await this.recordView(r, ctx, 'overlay');
    return {
      sheetId,
      versionId: v.id,
      detections: art.detections
        .filter((d) => !inMask(d.centerMm))
        .map((d) => ({ id: d.id, class: d.class, centerMm: d.centerMm, bboxMm: d.bboxMm, level: d.level, floor: d.floor, lineIds: detections.get(d.id) ?? [] })),
      links: art.links.map((g) => ({ id: g.id, kind: g.kind, level: g.level, switchIds: g.switchIds, luminaireIds: g.luminaireIds, lineIds: links.get(g.id) ?? [] })),
      rooms: art.rooms
        .filter((rm) => !rm.bboxMm || !inMask({ x: rm.bboxMm.x + rm.bboxMm.w / 2, y: rm.bboxMm.y + rm.bboxMm.h / 2 }))
        .map((rm) => ({ id: rm.id, name: rm.name, type: rm.type, areaM2: rm.areaM2, level: rm.level, bboxMm: rm.bboxMm })),
      maskMm: mask,
    };
  }

  /** detectionId / linkGroupId → line ids for one LOCKED version, from the latest build's evidence. */
  private async lineIndex(r: ResolvedShare, sheetId: string, versionId: string) {
    const detections = new Map<string, string[]>();
    const links = new Map<string, string[]>();
    const project = await this.repo.getProject(r.orgId, r.projectId);
    const buildId = project?.boq?.latestBuildId;
    if (!buildId || !DocIdSchema.safeParse(buildId).success) return { detections, links };
    let raw: unknown = null;
    try {
      raw = await this.boqStorage.readEvidence(storagePaths.boqEvidence(r.orgId, r.projectId, buildId));
    } catch (err) {
      if (!(err instanceof ArtifactTooLargeError || err instanceof SyntaxError)) throw err;
    }
    const lines = raw && typeof raw === 'object' ? (raw as { lines?: unknown }).lines : null;
    if (!lines || typeof lines !== 'object') return { detections, links };
    const add = (m: Map<string, string[]>, k: string, lineId: string) => {
      const arr = m.get(k) ?? [];
      if (!arr.includes(lineId)) arr.push(lineId);
      m.set(k, arr);
    };
    for (const [lineId, items] of Object.entries(lines as Record<string, unknown>)) {
      if (!DocIdSchema.safeParse(lineId).success || !Array.isArray(items)) continue;
      for (const it of items.slice(0, 50_000) as Array<Record<string, unknown>>) {
        if (!it || it.sheetId !== sheetId || it.versionId !== versionId) continue;
        if (typeof it.detectionId === 'string' && it.detectionId.length <= 128) add(detections, it.detectionId, lineId);
        if (typeof it.linkGroupId === 'string' && it.linkGroupId.length <= 128) add(links, it.linkGroupId, lineId);
      }
    }
    return { detections, links };
  }

  /** Tile of a LOCKED version, watermark burned in, title block masked. */
  async tile(token: string, sheetId: string, z: number, x: number, y: number, ctx: ShareRequestCtx): Promise<Buffer> {
    const r = await this.resolve(token, ctx, 'tiles');
    const v = await this.lockedVersion(r, sheetId);
    const t = v.artifacts.tiles;
    if (!t) throw notFound('tile');
    const level = tileLevels(t)[z];
    if (!level || x >= level.cols || y >= level.rows) throw notFound('tile');
    const raw = await this.storage.readTile(storagePaths.tile(r.orgId, r.projectId, sheetId, v.id, z, x, y));
    if (!raw) throw notFound('tile');
    const mask = this.maskOf(r.link, v);
    const out = await this.watermarker.apply(raw, {
      text: linkWatermark(r.link),
      origin: { x: x * t.tileSize, y: y * t.tileSize },
      masks: mask ? [maskToTile(mask, level.mmPerPx, x, y, t.tileSize)] : [],
    });
    await this.recordView(r, ctx, 'tiles');
    return out;
  }

  /** Watermarked per-link marked PDF → short signed URL (302). 404 when not allowed, 409 while it is being produced. */
  async pdf(token: string, ctx: ShareRequestCtx): Promise<{ url: string; expiresAt: string }> {
    const r = await this.resolve(token, ctx, 'pdf');
    if (!r.link.allowPdfDownload) throw notFound('pdf');
    const rec = r.link.pdfExportId ? await this.gov.getExport(r.orgId, r.projectId, r.link.pdfExportId) : null;
    if (!rec) throw notFound('pdf');
    if (rec.status !== 'ready') throw new ApiException(HttpStatus.CONFLICT, 'not_ready', 'the PDF is being prepared');
    const project = await this.repo.getProject(r.orgId, r.projectId);
    const name = `${project?.name ?? 'project'} - ${shortIdOf(r.link.id)}.pdf`;
    const signed = await this.storage.signMarkedPdf(storagePaths.markedPdf(r.orgId, r.projectId, rec.id), name, SHARE_PDF_URL_TTL_SECONDS);
    await this.recordView(r, ctx, 'pdf');
    return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  }
}
