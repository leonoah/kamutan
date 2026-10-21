import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BOQ_EVIDENCE_PATH_RE,
  DocIdSchema,
  storagePaths,
  type AuditEvent,
  type AuditPage,
  type AuditQuery,
  type AuditVerifyResponse,
  type LineHistoryItem,
  type LineHistoryResponse,
} from '@kamutan/contracts';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth-context';
import { BOQ_STORAGE, type BoqStorage } from '../boq/boq-storage';
import { notFound } from '../common/api-exception';
import { auditHash } from '../db/audit-chain';
import { BOQ_REPOSITORY, type BoqRepository } from '../db/boq-repository';
import { GOVERNANCE_REPOSITORY, type GovernanceRepository, type StoredAuditEvent } from '../db/governance-repository';
import { REPOSITORY, type Repository } from '../db/repository';
import { REVIEW_REPOSITORY, type ReviewRepository } from '../db/review-repository';
import { ArtifactTooLargeError } from '../understanding/artifact-reader';

const validId = (s: string) => DocIdSchema.safeParse(s).success;

/**
 * Verifies a per-org audit chain by FOLLOWING THE LINKS (prevHash → hash), not by timestamp order: instances with
 * skewed clocks can write `at` out of order, but every event must (1) hash to its stored `hash` and (2) point at the
 * previous event's hash, with exactly one genesis (prevHash null) and no forks. `brokenAt` = the first offending event
 * (in time order) — a tampered/deleted/inserted record or a fork.
 */
export function verifyChain(stored: readonly StoredAuditEvent[]): AuditVerifyResponse {
  if (stored.length === 0) return { ok: true, checked: 0, brokenAt: null, headHash: null };
  const byTime = [...stored].sort((a, b) => a.event.at.localeCompare(b.event.at) || a.event.id.localeCompare(b.event.id));
  // (1) every record hashes correctly
  for (const s of byTime) {
    if (auditHash(s.event.prevHash, s.body) !== s.event.hash) return { ok: false, checked: byTime.indexOf(s), brokenAt: s.event.id, headHash: null };
  }
  // (2) links: one genesis, every prevHash points at an existing event, no two events share a predecessor
  const byPrev = new Map<string, StoredAuditEvent[]>();
  for (const s of byTime) {
    const k = s.event.prevHash ?? '';
    const arr = byPrev.get(k) ?? [];
    arr.push(s);
    byPrev.set(k, arr);
  }
  const visited = new Set<string>();
  let cur: StoredAuditEvent | undefined = byPrev.get('')?.[0];
  let head: string | null = null;
  while (cur) {
    if (visited.has(cur.event.id)) break;
    visited.add(cur.event.id);
    head = cur.event.hash;
    const next: StoredAuditEvent[] = byPrev.get(cur.event.hash) ?? [];
    if (next.length > 1) {
      const fork = next.sort((a, b) => a.event.at.localeCompare(b.event.at))[1] as StoredAuditEvent;
      return { ok: false, checked: visited.size, brokenAt: fork.event.id, headHash: null };
    }
    cur = next[0];
  }
  if ((byPrev.get('')?.length ?? 0) > 1 || visited.size !== byTime.length) {
    const first = byTime.find((s) => !visited.has(s.event.id)) ?? byTime[0];
    return { ok: false, checked: visited.size, brokenAt: first?.event.id ?? null, headHash: null };
  }
  return { ok: true, checked: visited.size, brokenAt: null, headHash: head };
}

/** Sprint 5 (SEC-35, FR-26): admin audit log, chain verification, BOQ line history. */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('AuditService');

  constructor(
    private readonly access: AccessService,
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Inject(GOVERNANCE_REPOSITORY) private readonly gov: GovernanceRepository,
    @Inject(BOQ_REPOSITORY) private readonly boq: BoqRepository,
    @Inject(REVIEW_REPOSITORY) private readonly review: ReviewRepository,
    @Inject(BOQ_STORAGE) private readonly boqStorage: BoqStorage,
  ) {}

  /** uid → display name (member displayName, else email) for the org's members. */
  private async names(orgId: string): Promise<Map<string, string | null>> {
    const members = await this.gov.listMembers(orgId);
    return new Map(members.map((m) => [m.uid, m.displayName ?? m.email ?? null]));
  }

  async list(user: AuthContext, orgId: string, q: AuditQuery): Promise<AuditPage> {
    await this.access.requireRole(user, orgId, 'admin');
    const page = await this.gov.listAudit(orgId, { limit: q.limit, ...(q.cursor ? { cursor: q.cursor } : {}), ...(q.entity ? { entity: q.entity } : {}), ...(q.action ? { action: q.action } : {}), ...(q.entityId ? { entityId: q.entityId } : {}) });
    const names = await this.names(orgId);
    return { items: page.items.map((e) => ({ ...e, actorName: e.actorKind === 'user' && e.actorId ? (names.get(e.actorId) ?? null) : null })), nextCursor: page.nextCursor };
  }

  async verify(user: AuthContext, orgId: string): Promise<AuditVerifyResponse> {
    await this.access.requireRole(user, orgId, 'admin');
    const res = verifyChain(await this.gov.auditForVerify(orgId));
    if (!res.ok) this.logger.error({ orgId, brokenAt: res.brokenAt, checked: res.checked }, 'audit chain verification FAILED'); // SEC-43 alert
    return res;
  }

  /**
   * History of one BOQ line, newest first: its audit events (`boqLines/update` → status / qtyOverride / note items,
   * `boqLines/rebuild` when the worker writes one) + corrections that affect its evidence (same item code, or a
   * detection that is evidence of the line in the line's build).
   */
  async lineHistory(user: AuthContext, projectId: string, lineId: string): Promise<LineHistoryResponse> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'reviewer');
    if (!validId(lineId)) throw notFound('line');
    const [line, project] = await Promise.all([this.boq.getLine(orgId, projectId, lineId), this.repo.getProject(orgId, projectId)]);
    if (!line || !project) throw notFound('line');
    const [events, names, corrections, evidenceIds] = await Promise.all([
      this.gov.auditForEntity(orgId, 'boqLines', lineId),
      this.names(orgId),
      this.review.listCorrections(orgId, projectId, {}),
      this.evidenceDetectionIds(orgId, projectId, line.evidenceRef ?? null, line.buildId ?? project.boq?.latestBuildId ?? null, lineId),
    ]);
    const by = (uid: string | null) => (uid ? { uid, displayName: names.get(uid) ?? null } : null);
    const items: LineHistoryItem[] = [];
    for (const e of events) items.push(...historyItemsOf(e, by));
    for (const c of corrections) {
      const affects = (c.itemCode !== null && c.itemCode === line.code) || (c.detectionId !== null && evidenceIds.has(c.detectionId));
      if (!affects) continue;
      items.push({
        at: c.at,
        by: by(c.by),
        action: 'correction',
        before: null,
        after: { correctionId: c.id, kind: c.kind, class: c.class, itemCode: c.itemCode, quantity: c.quantity, reverted: c.revertedAt !== null },
        reason: c.reason,
      });
    }
    items.sort((a, b) => b.at.localeCompare(a.at));
    return { lineId, items };
  }

  private async evidenceDetectionIds(orgId: string, projectId: string, evidenceRef: string | null, buildId: string | null, lineId: string): Promise<Set<string>> {
    const m = evidenceRef ? BOQ_EVIDENCE_PATH_RE.exec(evidenceRef) : null;
    const path = m && m[1] === orgId && m[2] === projectId ? evidenceRef : buildId && validId(buildId) ? storagePaths.boqEvidence(orgId, projectId, buildId) : null;
    if (!path) return new Set();
    try {
      const raw = (await this.boqStorage.readEvidence(path)) as { lines?: Record<string, unknown> } | null;
      const items = raw?.lines?.[lineId];
      if (!Array.isArray(items)) return new Set();
      return new Set(items.map((it) => (it as { detectionId?: unknown })?.detectionId).filter((x): x is string => typeof x === 'string' && x.length <= 128));
    } catch (err) {
      if (err instanceof ArtifactTooLargeError || err instanceof SyntaxError) return new Set();
      throw err;
    }
  }
}

/** One `boqLines` audit event → 0..3 history items. */
export function historyItemsOf(e: AuditEvent, by: (uid: string | null) => LineHistoryItem['by']): LineHistoryItem[] {
  const a = e.after ?? {};
  const out: LineHistoryItem[] = [];
  const who = e.actorKind === 'user' ? by(e.actorId) : null;
  if (e.action === 'update') {
    if ('to' in a) out.push({ at: e.at, by: who, action: 'status', before: a.from ?? null, after: a.to ?? null, reason: null });
    if ('qtyOverride' in a) {
      const reason = typeof a.reason === 'string' ? a.reason.slice(0, 500) : null;
      out.push({ at: e.at, by: who, action: 'qtyOverride', before: a.prevQtyOverride ?? null, after: a.qtyOverride ?? null, reason });
    }
    if (a.noteChanged === true) out.push({ at: e.at, by: who, action: 'note', before: null, after: null, reason: null });
  } else if (e.action === 'rebuild') {
    out.push({ at: e.at, by: who, action: 'rebuild', before: a.from ?? a.prevQty ?? null, after: a.to ?? a.qty ?? null, reason: null });
  }
  return out;
}
