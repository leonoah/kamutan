import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BATCH_ACTION_HE,
  BOQ_EVIDENCE_PATH_RE,
  DocIdSchema,
  storagePaths,
  APPROVAL_INVALIDATED_ACTION,
  qtyChangedReason,
  AUDIT_ACTION_HE,
  AUDIT_ENTITY_HE,
  auditSummaryHe,
  BOQ_STATUS_HE,
  SYMBOL_CLASS_INFO,
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
export function verifyChain(stored: readonly StoredAuditEvent[], head: { hash: string | null; count: number | null } | null = null): AuditVerifyResponse {
  const res = verifyLinks(stored);
  if (!res.ok || !head) return res;
  // F-8: the tip must be the head the API recorded (deleting the newest events leaves a shorter, still-linked chain).
  const tipMismatch = head.hash !== null && head.hash !== res.headHash;
  const countMismatch = head.count !== null && head.count !== res.checked;
  if (!tipMismatch && !countMismatch) return { ...res, headMismatch: false };
  const tip = [...stored].sort((a, b) => b.event.at.localeCompare(a.event.at) || b.event.id.localeCompare(a.event.id))[0];
  return { ok: false, checked: res.checked, brokenAt: tip?.event.id ?? 'auditMeta/head', headHash: res.headHash, headMismatch: true };
}

function verifyLinks(stored: readonly StoredAuditEvent[]): AuditVerifyResponse {
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
    return {
      items: page.items.map((e) => ({
        ...e,
        actorName: e.actorKind === 'user' && e.actorId ? (names.get(e.actorId) ?? null) : null,
        // Stage 10 (A-UI-13): readable Hebrew details instead of raw `after`.
        summary: auditSummaryHe(e),
        entityLabel: AUDIT_ENTITY_HE[e.entity] ?? e.entity,
        actionLabel: AUDIT_ACTION_HE[e.action] ?? e.action,
      })),
      nextCursor: page.nextCursor,
    };
  }

  async verify(user: AuthContext, orgId: string): Promise<AuditVerifyResponse> {
    await this.access.requireRole(user, orgId, 'admin');
    const [events, head] = await Promise.all([this.gov.auditForVerify(orgId), this.gov.getAuditHead(orgId)]);
    const res = verifyChain(events, head);
    if (!res.ok) this.logger.error({ orgId, brokenAt: res.brokenAt, checked: res.checked }, 'audit chain verification FAILED'); // SEC-43 alert
    return res;
  }

  /**
   * History of one BOQ line, newest first: its audit events (`boqLines/update` → status / qtyOverride / note items,
   * `boqLines/rebuild` when the worker writes one) + corrections that affect its evidence (same item code, or a
   * detection that is evidence of the line in the line's build).
   */
  async lineHistory(user: AuthContext, projectId: string, lineId: string): Promise<LineHistoryResponse> {
    // Stage 10 (A-API-07, SEC-07 "צפייה"): history is a read → every member role.
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'viewer');
    if (!validId(lineId)) throw notFound('line');
    const [line, project] = await Promise.all([this.boq.getLine(orgId, projectId, lineId), this.repo.getProject(orgId, projectId)]);
    if (!line || !project) throw notFound('line');
    // A-API-06: the audit events of the latest build's invalidated approvals exist before the history is read.
    const latest = project.boq?.latestBuildId;
    if (latest && validId(latest)) await this.boq.auditApprovalsInvalidated(orgId, projectId, latest).catch((err: unknown) => this.logger.warn({ err: (err as Error).message }, 'approval audit sync failed'));
    const [events, names, corrections, evidence] = await Promise.all([
      this.gov.auditForEntity(orgId, 'boqLines', lineId),
      this.names(orgId),
      this.review.listCorrections(orgId, projectId, {}),
      this.evidenceRefs(orgId, projectId, line.evidenceRef ?? null, line.buildId ?? project.boq?.latestBuildId ?? null, lineId),
    ]);
    const by = (uid: string | null) => (uid ? { uid, displayName: names.get(uid) ?? null } : null);
    const items: LineHistoryItem[] = [];
    // F-9: line ids are deterministic per code (`ln_4_01`) → the same id exists in every project of the org. Only
    // events of THIS project count (every boqLines audit payload carries projectId since Sprint 3).
    for (const e of events) if (e.after?.projectId === projectId) items.push(...historyItemsOf(e, by));
    for (const c of corrections) {
      // A-UI-08: a manual add / count / measure has no detection id of the build; it is evidence of the line through
      // its correction id (evidence item `correctionId`, or the worker's `m_<correctionId>` detection id).
      const affects =
        (c.itemCode !== null && c.itemCode === line.code) ||
        (c.detectionId !== null && evidence.detectionIds.has(c.detectionId)) ||
        evidence.correctionIds.has(c.id) ||
        evidence.detectionIds.has(`m_${c.id}`) ||
        c.lineId === lineId; // Sprint 6: quick-measure corrections are bound to the line
      if (!affects) continue;
      const after = { correctionId: c.id, kind: c.kind, class: c.class, itemCode: c.itemCode, quantity: c.quantity, reverted: c.revertedAt !== null };
      items.push({
        at: c.at,
        by: by(c.by),
        action: 'correction',
        before: null,
        after,
        reason: c.reason,
        summary: correctionSummaryHe(c.kind, c.class, c.itemCode, c.quantity, c.revertedAt !== null),
        sourceId: c.id,
      });
    }
    items.sort(compareHistoryItems);
    return { lineId, items };
  }

  /** Detection ids + correction ids of the line's evidence in its build (lenient: malformed → empty). */
  private async evidenceRefs(orgId: string, projectId: string, evidenceRef: string | null, buildId: string | null, lineId: string): Promise<{ detectionIds: Set<string>; correctionIds: Set<string> }> {
    const empty = { detectionIds: new Set<string>(), correctionIds: new Set<string>() };
    const m = evidenceRef ? BOQ_EVIDENCE_PATH_RE.exec(evidenceRef) : null;
    const path = m && m[1] === orgId && m[2] === projectId ? evidenceRef : buildId && validId(buildId) ? storagePaths.boqEvidence(orgId, projectId, buildId) : null;
    if (!path) return empty;
    try {
      const raw = (await this.boqStorage.readEvidence(path)) as { lines?: Record<string, unknown> } | null;
      const items = raw?.lines?.[lineId];
      if (!Array.isArray(items)) return empty;
      const ids = (k: 'detectionId' | 'correctionId') =>
        new Set(items.map((it) => (it as Record<string, unknown> | null)?.[k]).filter((x): x is string => typeof x === 'string' && x.length <= 128));
      return { detectionIds: ids('detectionId'), correctionIds: ids('correctionId') };
    } catch (err) {
      if (err instanceof ArtifactTooLargeError || err instanceof SyntaxError) return empty;
      throw err;
    }
  }
}

const CORRECTION_KIND_HE: Readonly<Record<string, string>> = {
  add: 'הוספת פריט ידני',
  remove: 'הסרת פריט',
  reclassify: 'שינוי סוג',
  move: 'הזזת פריט',
  link: 'קישור מפסק לגוף תאורה',
  unlink: 'ביטול קישור',
  measure: 'מדידה ידנית',
  count: 'ספירה ידנית',
  accept: 'אישור פריט',
  reject: 'דחיית פריט',
};

/** "תיקון על השרטוט · הוספת פריט ידני · שקע כפול" (A-UI-08 line history entry of a drawing correction). */
export function correctionSummaryHe(kind: string, cls: string | null, itemCode: string | null, quantity: number | null, reverted: boolean): string {
  const parts = ['תיקון על השרטוט', CORRECTION_KIND_HE[kind] ?? kind];
  if (cls) parts.push(cls in SYMBOL_CLASS_INFO ? SYMBOL_CLASS_INFO[cls as keyof typeof SYMBOL_CLASS_INFO].he : cls);
  if (itemCode) parts.push(`סעיף ${itemCode}`);
  if (quantity !== null && quantity !== undefined) parts.push(`כמות ${quantity}`);
  if (reverted) parts.push('בוטל');
  return parts.join(' · ');
}

/** Later step of ONE change first (an override that re-opened an approved line is listed above that status change). */
const ACTION_RANK: Readonly<Record<string, number>> = { qtyOverride: 4, note: 3, status: 2, rebuild: 1, correction: 0 };

/**
 * Stage 10 (A-UI-06): total, stable order — newest first; equal timestamps: the later step of one change first
 * (qtyOverride > note > status > rebuild), corrections after audit items, then sourceId desc (deterministic).
 */
export function compareHistoryItems(a: LineHistoryItem, b: LineHistoryItem): number {
  const t = b.at.localeCompare(a.at);
  if (t !== 0) return t;
  const r = (ACTION_RANK[b.action] ?? 0) - (ACTION_RANK[a.action] ?? 0);
  if (r !== 0) return r;
  return (b.sourceId ?? '').localeCompare(a.sourceId ?? '');
}

/** One `boqLines` audit event → 0..3 history items. */
export function historyItemsOf(e: AuditEvent, by: (uid: string | null) => LineHistoryItem['by']): LineHistoryItem[] {
  const a = e.after ?? {};
  const out: LineHistoryItem[] = [];
  const who = e.actorKind === 'user' ? by(e.actorId) : null;
  const he = (v: unknown) => (typeof v === 'string' ? ((BOQ_STATUS_HE as Record<string, string>)[v] ?? v) : String(v ?? '—'));
  const src = e.id;
  if (e.action === 'update') {
    if ('to' in a) {
      // Sprint 6: a bulk change reads "אושר (פעולה קבוצתית) · טיוטה → אושר".
      const summary = typeof a.batchId === 'string' ? `${he(a.to)} (${BATCH_ACTION_HE}) · ${he(a.from)} → ${he(a.to)}` : `שינוי סטטוס · ${he(a.from)} → ${he(a.to)}`;
      out.push({ at: e.at, by: who, action: 'status', before: a.from ?? null, after: a.to ?? null, reason: null, summary, sourceId: src });
    }
    if ('qtyOverride' in a) {
      const reason = typeof a.reason === 'string' ? a.reason.slice(0, 500) : null;
      // A-API-08: "before" = the quantity the user saw before the change (previous override, else the computed qty).
      const before = a.prevQtyOverride ?? (typeof a.qty === 'number' ? a.qty : null);
      const summary = a.qtyOverride === null ? `ביטול כמות ידנית · ${he(before)} → ${he(a.qty)}` : `שינוי כמות ידני · ${he(before)} → ${he(a.qtyOverride)}`;
      out.push({ at: e.at, by: who, action: 'qtyOverride', before, after: a.qtyOverride ?? null, reason, summary, sourceId: src });
    }
    if (a.noteChanged === true) out.push({ at: e.at, by: who, action: 'note', before: null, after: null, reason: null, summary: 'הערה עודכנה', sourceId: src });
  } else if (e.action === APPROVAL_INVALIDATED_ACTION) {
    // Stage 10 (A-API-06): the rebuild dropped an approved line to "נבדק" because its quantity changed.
    const from = a.fromQty ?? a.prevQty ?? null;
    const to = a.toQty ?? a.qty ?? null;
    const reason = typeof from === 'number' && typeof to === 'number' ? qtyChangedReason(from, to) : null;
    out.push({ at: e.at, by: who, action: 'rebuild', before: from, after: to, reason, summary: `חישוב מחדש · הכמות השתנתה ${he(from)} → ${he(to)}`, sourceId: src });
    out.push({ at: e.at, by: who, action: 'status', before: a.from ?? 'approved', after: a.to ?? 'reviewed', reason, summary: `האישור בוטל · ${he(a.from ?? 'approved')} → ${he(a.to ?? 'reviewed')}`, sourceId: src });
  } else if (e.action === 'rebuild') {
    out.push({ at: e.at, by: who, action: 'rebuild', before: a.from ?? a.prevQty ?? null, after: a.to ?? a.qty ?? null, reason: null, summary: `חישוב מחדש · ${he(a.from ?? a.prevQty)} → ${he(a.to ?? a.qty)}`, sourceId: src });
  }
  return out;
}
