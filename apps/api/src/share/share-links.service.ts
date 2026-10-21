import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DocIdSchema,
  effectiveQty,
  JOB_TYPES,
  SHARE_BOQ_SNAPSHOT_SCHEMA,
  SHARE_TOKEN_BYTES,
  storagePaths,
  TITLE_BLOCK_WARNING_EXCLUDED,
  TITLE_BLOCK_WARNING_INCLUDED,
  type BoqLine,
  type ShareBoqSnapshot,
  type ShareLinkSheet,
  type ShareLinkWarning,
  type CreateShareLinkRequest,
  type CreateShareLinkResponse,
  type ShareLink,
  type ShareLinkList,
  type ShareLinkState,
  type ShareLinkView,
} from '@kamutan/contracts';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth-context';
import { notFound } from '../common/api-exception';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { GOVERNANCE_REPOSITORY, type GovernanceRepository } from '../db/governance-repository';
import { autoId } from '../db/in-memory.repository';
import { REPOSITORY, type Repository } from '../db/repository';
import { compareLines } from '../boq/boq.service';
import { floorsOf } from '../boq/excel';
import { countLines } from '../db/boq-docs';
import { BOQ_REPOSITORY, type BoqRepository } from '../db/boq-repository';
import { ExportsService } from '../governance/exports.service';
import { GOVERNANCE_STORAGE, type GovernanceStorage } from '../governance/governance-storage';
import { watermarkText } from './watermark';

const validId = (s: string) => DocIdSchema.safeParse(s).success;
const DAY_MS = 86_400_000;

export const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
export const shortIdOf = (linkId: string) => linkId.slice(0, 6);

export function linkState(link: Pick<ShareLink, 'revokedAt' | 'expiresAt'>, nowMs = Date.now()): ShareLinkState {
  if (link.revokedAt) return 'revoked';
  return Date.parse(link.expiresAt) <= nowMs ? 'expired' : 'active';
}

/** API view of a link: never the token hash. */
export function toView(projectId: string, l: ShareLink, nowMs = Date.now()): ShareLinkView {
  const { tokenHash: _hash, ...rest } = l;
  return {
    ...rest,
    projectId,
    versionLockBySheet: l.versionLockBySheet ?? {},
    label: l.label ?? 'קישור שיתוף',
    recipient: l.recipient ?? null,
    hideTitleBlock: l.hideTitleBlock !== false,
    viewCount: l.viewCount ?? 0,
    lastViewedAt: l.lastViewedAt ?? null,
    revokedBy: l.revokedBy ?? null,
    revokeReason: l.revokeReason ?? null,
    pdfExportId: l.pdfExportId ?? null,
    state: linkState(l, nowMs),
    shortId: shortIdOf(l.id),
    sheets: sheetsOf(l),
    boqLocked: !!l.boqSnapshotPath,
  };
}

/** Included sheets (the version lock) + sheets excluded at creation because their title block was not detected. */
export function sheetsOf(l: ShareLink): ShareLinkSheet[] {
  const lock = l.versionLockBySheet ?? {};
  const masked = l.titleBlockMaskedBySheet ?? {};
  const out: ShareLinkSheet[] = Object.entries(lock).map(([sheetId, versionId]) => ({ sheetId, versionId, titleBlockMasked: masked[sheetId] === true && l.hideTitleBlock !== false, included: true }));
  for (const [sheetId, ex] of Object.entries(l.excludedSheets ?? {})) out.push({ sheetId, versionId: ex, titleBlockMasked: false, included: false });
  return out.sort((a, b) => a.sheetId.localeCompare(b.sheetId));
}

/** F-4: the public view of the BOQ, frozen at creation (no notes / reasons / override marker / user ids). */
export function boqSnapshot(linkId: string, buildId: string | null, all: BoqLine[], at: Date): ShareBoqSnapshot {
  const lines = [...all].sort(compareLines);
  const c = countLines(lines);
  return {
    schema: SHARE_BOQ_SNAPSHOT_SCHEMA,
    linkId,
    buildId,
    snapshotAt: at.toISOString(),
    lines: lines.map((l) => ({ id: l.id, chapter: l.chapter, code: l.code, description: l.description, unit: l.unit, qty: effectiveQty(l), level: l.level, status: l.status, floor: l.floor ?? null, byFloor: l.byFloor ?? {} })),
    floors: floorsOf(lines),
    counts: { lines: c.lines, green: c.green, yellow: c.yellow, red: c.red, approved: c.approved },
  };
}

/** The watermark text of a link (tiles + its PDF). */
export function linkWatermark(l: Pick<ShareLink, 'id' | 'createdAt' | 'label' | 'recipient'>): string {
  return watermarkText(l.recipient || l.label || 'קישור שיתוף', new Date(l.createdAt), shortIdOf(l.id));
}

/**
 * Sprint 5 (FR-30, SEC-26/27): share links of a project — create (raw 256-bit token returned ONCE, only SHA-256 kept),
 * list, revoke. editor+ (SEC-07 "ייצוא ויצירת קישור שיתוף").
 */
@Injectable()
export class ShareLinksService {
  private readonly logger = new Logger('ShareLinksService');

  constructor(
    private readonly access: AccessService,
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Inject(GOVERNANCE_REPOSITORY) private readonly gov: GovernanceRepository,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly exports: ExportsService,
    @Inject(BOQ_REPOSITORY) private readonly boq: BoqRepository,
    @Inject(GOVERNANCE_STORAGE) private readonly storage: GovernanceStorage,
  ) {}

  /** Every sheet whose current version is ready: version id + whether a title block box is known (F-3). */
  private async currentReadyVersions(orgId: string, projectId: string): Promise<Array<{ sheetId: string; versionId: string; hasTitleBlock: boolean }>> {
    const out: Array<{ sheetId: string; versionId: string; hasTitleBlock: boolean }> = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await this.repo.listSheets(orgId, projectId, { limit: 200, ...(cursor ? { cursor } : {}) });
      for (const s of page.items) {
        if (s.currentVersion?.status !== 'ready' || !s.currentVersionId) continue;
        const v = await this.repo.getVersion(orgId, projectId, s.id, s.currentVersionId);
        out.push({ sheetId: s.id, versionId: s.currentVersionId, hasTitleBlock: !!v?.titleBlockMm });
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return out;
  }

  async create(user: AuthContext, projectId: string, req: CreateShareLinkRequest, traceparent: string): Promise<CreateShareLinkResponse> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'editor');
    const project = await this.repo.getProject(orgId, projectId);
    if (!project) throw notFound('project');
    // F-3: with hideTitleBlock, a sheet whose title block was not detected cannot be masked → excluded (fail closed)
    // unless the editor explicitly opts in. No guessed fallback strip anywhere.
    const ready = await this.currentReadyVersions(orgId, projectId);
    const lock: Record<string, string> = {};
    const excluded: Record<string, string> = {};
    const masked: Record<string, boolean> = {};
    const unmaskedIncluded: string[] = [];
    for (const r of ready) {
      masked[r.sheetId] = r.hasTitleBlock;
      if (req.hideTitleBlock && !r.hasTitleBlock && !req.includeUnmaskedSheets) {
        excluded[r.sheetId] = r.versionId;
        continue;
      }
      if (req.hideTitleBlock && !r.hasTitleBlock) unmaskedIncluded.push(r.sheetId);
      lock[r.sheetId] = r.versionId;
    }
    const warnings: ShareLinkWarning[] = [];
    if (Object.keys(excluded).length) warnings.push({ code: 'title_block_not_detected', message: TITLE_BLOCK_WARNING_EXCLUDED, sheetIds: Object.keys(excluded).sort() });
    if (unmaskedIncluded.length) warnings.push({ code: 'title_block_not_detected_included', message: TITLE_BLOCK_WARNING_INCLUDED, sheetIds: unmaskedIncluded.sort() });

    const token = randomBytes(SHARE_TOKEN_BYTES).toString('base64url');
    const id = autoId();
    const now = new Date();
    // F-4: freeze the BOQ now; the public API serves only this snapshot.
    const snapshotPath = storagePaths.shareBoqSnapshot(orgId, projectId, id);
    await this.storage.writeShareSnapshot(snapshotPath, boqSnapshot(id, project.boq?.latestBuildId ?? null, await this.boq.listLines(orgId, projectId), now));
    const base: Omit<ShareLink, 'pdfExportId'> = {
      id,
      tokenHash: sha256Hex(token),
      versionLock: Object.values(lock),
      versionLockBySheet: lock,
      expiresAt: new Date(now.getTime() + req.days * DAY_MS).toISOString(),
      revokedAt: null,
      allowPdfDownload: req.allowPdfDownload,
      createdBy: user.uid,
      createdAt: now.toISOString(),
      label: req.label,
      recipient: req.recipient ?? null,
      hideTitleBlock: req.hideTitleBlock,
      titleBlockMaskedBySheet: masked,
      includeUnmaskedSheets: req.includeUnmaskedSheets,
      excludedSheets: excluded,
      boqSnapshotPath: snapshotPath,
    };
    const wantPdf = req.allowPdfDownload && Object.keys(lock).length > 0 && !!project.boq?.latestBuildId;
    const options = { legend: true as const, floorSplit: false, watermark: linkWatermark(base), hideTitleBlock: req.hideTitleBlock };
    const { link, pdf } = await this.gov.createShareLink(orgId, projectId, base, wantPdf ? { options, versionIds: lock, jobType: JOB_TYPES.exportMarkedPdf } : null);
    if (pdf) {
      try {
        await this.exports.publish(orgId, projectId, pdf.exportId, pdf.jobId, Object.keys(lock), lock, options, traceparent);
      } catch (err) {
        // The link itself is fine; only its PDF is unavailable (meta shows pdf.status = failed).
        this.logger.error({ err: (err as Error).message, linkId: link.id }, 'share pdf publish failed');
        await this.gov.failExport(orgId, projectId, pdf.exportId, pdf.jobId, { code: 'publish_failed', message: 'could not schedule the export' });
      }
    }
    const url = `${this.cfg.PUBLIC_APP_ORIGIN.replace(/\/+$/, '')}/s/${token}`;
    return { link: toView(projectId, link), url, token, warnings };
  }

  async list(user: AuthContext, projectId: string): Promise<ShareLinkList> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'editor');
    const links = await this.gov.listShareLinks(orgId, projectId);
    const now = Date.now();
    return { items: links.map((l) => toView(projectId, l, now)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)) };
  }

  /** Immediate; idempotent (a second DELETE returns the revoked link, no second audit event). */
  async revoke(user: AuthContext, projectId: string, linkId: string): Promise<{ link: ShareLinkView }> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'editor');
    if (!validId(linkId)) throw notFound('share link');
    const r = await this.gov.revokeShareLink(orgId, projectId, linkId, user.uid);
    if (!r) throw notFound('share link');
    return { link: toView(projectId, r.link) };
  }
}
