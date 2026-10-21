import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DocIdSchema,
  JOB_TYPES,
  SHARE_TOKEN_BYTES,
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
import { ExportsService } from '../governance/exports.service';
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
  ) {}

  /** sheetId → current version id of every sheet whose current version is ready (the version lock). */
  private async currentReadyVersions(orgId: string, projectId: string): Promise<Record<string, string>> {
    const lock: Record<string, string> = {};
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await this.repo.listSheets(orgId, projectId, { limit: 200, ...(cursor ? { cursor } : {}) });
      for (const s of page.items) if (s.currentVersion?.status === 'ready' && s.currentVersionId) lock[s.id] = s.currentVersionId;
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return lock;
  }

  async create(user: AuthContext, projectId: string, req: CreateShareLinkRequest, traceparent: string): Promise<CreateShareLinkResponse> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'editor');
    const project = await this.repo.getProject(orgId, projectId);
    if (!project) throw notFound('project');
    const lock = await this.currentReadyVersions(orgId, projectId);
    const token = randomBytes(SHARE_TOKEN_BYTES).toString('base64url');
    const id = autoId();
    const now = new Date();
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
    return { link: toView(projectId, link), url, token };
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
