import { createHash } from 'node:crypto';
import {
  effectiveQty,
  REVIEW_CLUSTER_MIN,
  REVIEW_DEFAULT_SCORE,
  REVIEW_LEVEL_WEIGHT,
  REVIEW_QUEUE_KINDS,
  roomSettingsId,
  SYMBOL_CLASS_INFO,
  type BBoxMm,
  type BoqLine,
  type ConfidenceLevel,
  type Correction,
  type ReviewQueueItem,
  type ReviewQueueKind,
} from '@kamutan/contracts';
import type { VersionArtifacts } from './artifact-views';

/**
 * Review queue (brief): risk = |qty impact on the BOQ line| × (1 − score) × level weight (red 3, yellow 1).
 * `computeQueueBase` is the expensive, build-derived part (cached per build id + current versions); `applyOverlay`
 * removes what corrections already handled and adds per-request state (room settings, unmatched corrections) — it
 * runs on every request. Both are pure and deterministic: ties are broken by kind order, sheet id, then item id.
 */

export interface EvidenceRef {
  sheetId: string;
  versionId: string;
  detectionId: string;
  linkGroupId: string | null;
  verified: boolean;
}

export interface UnmatchedRef {
  correctionId: string;
  sheetId: string;
  versionId: string;
  reason: string;
}

export interface QueueInput {
  buildId: string | null;
  lines: readonly BoqLine[];
  /** lineId → evidence items of the build (lenient). */
  evidence: ReadonlyMap<string, readonly EvidenceRef[]>;
  unmatched: readonly UnmatchedRef[];
  /** Current, ready sheet versions with their artifact views. */
  versions: ReadonlyArray<{ sheetId: string; versionId: string; artifacts: VersionArtifacts }>;
}

interface Member {
  id: string;
  centerMm: { x: number; y: number };
  bboxMm: BBoxMm;
  score: number;
  risk: number;
}

/** Internal item: the public shape minus the signed URL, plus what the overlay needs. */
export interface BaseItem extends Omit<ReviewQueueItem, 'thumbUrl'> {
  thumbPath: string | null;
  members: Member[];
  /** Rooms only: issues independent of settings, and whether tiling settings are expected. */
  roomIssues?: string[];
  needsSettings?: boolean;
  /** Unmatched corrections: kept until the overlay knows whether the correction is still active. */
  unmatched?: UnmatchedRef;
}

export interface QueueBase {
  buildId: string | null;
  items: BaseItem[];
}

const KIND_ORDER = new Map<ReviewQueueKind, number>(REVIEW_QUEUE_KINDS.map((k, i) => [k, i]));
const weight = (l: ConfidenceLevel) => REVIEW_LEVEL_WEIGHT[l];
const riskOf = (impact: number, score: number, level: ConfidenceLevel) => Math.abs(impact) * (1 - score) * weight(level);
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const shortHash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const he = (cls: string): string => (SYMBOL_CLASS_INFO as Record<string, { he: string } | undefined>)[cls]?.he ?? cls;
const TILING_TYPES = new Set(['bathroom', 'wc', 'kitchen', 'courtyard']);
export const ROOM_SETTINGS_MISSING_REASON = 'חסרות הגדרות ריצוף/חיפוי';
export const ROOM_UNNAMED_REASON = 'חדר ללא שם';
export const UNMATCHED_TITLE = 'תיקון לא הותאם';

function unionBox(boxes: readonly BBoxMm[]): BBoxMm | null {
  if (!boxes.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function computeQueueBase(input: QueueInput): QueueBase {
  const lineById = new Map(input.lines.map((l) => [l.id, l]));
  const detLines = new Map<string, string[]>();
  const groupLines = new Map<string, string[]>();
  const verified = new Set<string>();
  const add = (m: Map<string, string[]>, k: string, v: string) => {
    const a = m.get(k);
    if (!a) m.set(k, [v]);
    else if (!a.includes(v)) a.push(v);
  };
  for (const [lineId, items] of input.evidence) {
    for (const e of items) {
      const vk = `${e.sheetId}/${e.versionId}`;
      add(detLines, `${vk}/${e.detectionId}`, lineId);
      if (e.linkGroupId) add(groupLines, `${vk}/${e.linkGroupId}`, lineId);
      if (e.verified) verified.add(`${vk}/${e.detectionId}`);
    }
  }
  const codeOf = (lineIds: readonly string[]) => (lineIds.length ? (lineById.get(lineIds[0] as string)?.code ?? null) : null);

  const items: BaseItem[] = [];
  const linesWithCause = new Set<string>();

  for (const { sheetId, versionId, artifacts } of input.versions) {
    const vk = `${sheetId}/${versionId}`;
    // --- detections → single items or clusters (same sheet version, signature|legend entry, class, level, reason, line)
    const groups = new Map<string, Array<{ d: VersionArtifacts['detections'][number]; lineIds: string[] }>>();
    for (const d of artifacts.detections) {
      if (d.level === 'green' || d.class === 'unknown' || verified.has(`${vk}/${d.id}`)) continue;
      const lineIds = (detLines.get(`${vk}/${d.id}`) ?? []).slice(0, 32);
      lineIds.forEach((l) => linesWithCause.add(l));
      const key = [d.signature ?? d.legendEntryId ?? '-', d.class, d.level, d.reasons[0] ?? '', lineIds[0] ?? ''].join('\u0000');
      const g = groups.get(key);
      if (g) g.push({ d, lineIds });
      else groups.set(key, [{ d, lineIds }]);
    }
    for (const [key, members] of groups) {
      const first = members[0] as (typeof members)[number];
      const ms: Member[] = members
        .map(({ d }) => ({ id: d.id, centerMm: d.centerMm, bboxMm: d.bboxMm, score: d.score, risk: riskOf(1, d.score, d.level) }))
        .sort((a, b) => a.score - b.score || (a.id < b.id ? -1 : 1));
      const code = codeOf(first.lineIds);
      const level = first.d.level;
      const common = {
        level,
        sheetId,
        versionId,
        floor: first.d.floor,
        class: first.d.class,
        itemCode: code,
        lineIds: first.lineIds,
        thumbPath: null,
      };
      if (members.length >= REVIEW_CLUSTER_MIN) {
        const risk = ms.reduce((s, m) => s + m.risk, 0);
        items.push({
          ...common,
          id: `cl:${sheetId}:${versionId}:${shortHash(key)}`,
          kind: 'cluster',
          risk: round(risk),
          score: ms[0]?.score ?? null,
          qtyImpact: ms.length,
          title: `${he(first.d.class)}${code ? ` (${code})` : ''} · ${ms.length} מופעים`,
          reasons: [...new Set(members.flatMap((m) => m.d.reasons))].slice(0, 32),
          suggestedAction: 'accept',
          bboxMm: unionBox(ms.map((m) => m.bboxMm)),
          detectionIds: ms.slice(0, 500).map((m) => m.id),
          memberBboxesMm: ms.slice(0, 500).map((m) => m.bboxMm),
          count: ms.length,
          ref: { ...(first.d.signature ? { signature: first.d.signature } : {}) },
          members: ms,
        });
      } else {
        for (const { d, lineIds } of members) {
          const c = codeOf(lineIds);
          items.push({
            ...common,
            id: `det:${sheetId}:${versionId}:${d.id}`,
            kind: 'detection',
            level: d.level,
            floor: d.floor,
            itemCode: c,
            lineIds,
            risk: round(riskOf(1, d.score, d.level)),
            score: d.score,
            qtyImpact: 1,
            title: `${he(d.class)}${c ? ` (${c})` : ''}`,
            reasons: d.reasons,
            suggestedAction: d.level === 'red' && lineIds.length === 0 ? 'reclassify' : 'accept',
            bboxMm: d.bboxMm,
            detectionIds: [d.id],
            count: 1,
            ref: { detectionId: d.id, ...(d.signature ? { signature: d.signature } : {}) },
            members: [{ id: d.id, centerMm: d.centerMm, bboxMm: d.bboxMm, score: d.score, risk: riskOf(1, d.score, d.level) }],
          });
        }
      }
    }
    // --- unknown symbol clusters (purple card "סמל לא מוכר × n")
    for (const u of artifacts.clusters) {
      const dets = artifacts.detections.filter((d) => d.clusterId === u.id);
      const ms: Member[] = dets.map((d) => ({ id: d.id, centerMm: d.centerMm, bboxMm: d.bboxMm, score: 0, risk: riskOf(1, 0, 'red') }));
      items.push({
        id: `uc:${sheetId}:${versionId}:${u.id}`,
        kind: 'unknown_cluster',
        level: 'red',
        risk: round(riskOf(u.count, 0, 'red')),
        score: 0,
        qtyImpact: u.count,
        title: `סמל לא מוכר × ${u.count}`,
        reasons: ['סמל לא במקרא'],
        suggestedAction: 'resolve_unknown',
        sheetId,
        versionId,
        floor: dets[0]?.floor ?? null,
        bboxMm: u.exemplarBboxMm,
        thumbPath: u.thumb ? `unknown:${u.id}` : null,
        class: 'unknown',
        itemCode: null,
        lineIds: [],
        detectionIds: ms.slice(0, 500).map((m) => m.id),
        memberBboxesMm: ms.slice(0, 500).map((m) => m.bboxMm),
        count: u.count,
        ref: { clusterId: u.id, ...(u.signature ? { signature: u.signature } : {}) },
        members: ms,
      });
    }
    // --- switch ↔ luminaire groups that are not green
    const detById = new Map(artifacts.detections.map((d) => [d.id, d]));
    for (const g of artifacts.links) {
      if (g.level === 'green') continue;
      const lineIds = (groupLines.get(`${vk}/${g.id}`) ?? []).slice(0, 32);
      lineIds.forEach((l) => linesWithCause.add(l));
      const ids = [...g.switchIds, ...g.luminaireIds];
      const boxes = ids.map((id) => detById.get(id)?.bboxMm).filter((b): b is BBoxMm => !!b);
      items.push({
        id: `lg:${sheetId}:${versionId}:${g.id}`,
        kind: 'link_group',
        level: g.level,
        risk: round(riskOf(1, g.confidence, g.level)),
        score: g.confidence,
        qtyImpact: 1,
        title: `קבוצת מפסק↔גוף תאורה${codeOf(lineIds) ? ` (${codeOf(lineIds)})` : ''}`,
        reasons: g.reasons,
        suggestedAction: 'review_link',
        sheetId,
        versionId,
        floor: g.floor,
        bboxMm: unionBox(boxes),
        thumbPath: null,
        class: null,
        itemCode: codeOf(lineIds),
        lineIds,
        detectionIds: ids.slice(0, 500),
        count: 1,
        ref: { linkGroupId: g.id },
        members: [],
      });
    }
    // --- rooms (unclosed / unnamed / settings missing — the last one is decided by the overlay)
    for (const r of artifacts.rooms) {
      const issues: string[] = [];
      if (r.level !== 'green') issues.push(...(r.reasons.length ? r.reasons : ['חדר לבדיקה']));
      if (!r.name) issues.push(ROOM_UNNAMED_REASON);
      const needsSettings = r.wet === true || (r.type !== null && TILING_TYPES.has(r.type));
      if (!issues.length && !needsSettings) continue;
      const impact = needsSettings ? Math.max(r.areaM2, 1) : 1;
      const level: ConfidenceLevel = r.level === 'green' ? 'yellow' : r.level;
      const score = r.level === 'green' ? REVIEW_DEFAULT_SCORE.yellow : r.confidence;
      items.push({
        id: `room:${sheetId}:${r.id}`,
        kind: 'room',
        level,
        risk: round(riskOf(impact, score, level)),
        score,
        qtyImpact: round(impact),
        title: r.name ?? ROOM_UNNAMED_REASON,
        reasons: issues,
        suggestedAction: r.level === 'red' ? 'close_room' : !r.name ? 'name_room' : 'room_settings',
        sheetId,
        versionId,
        floor: r.floor,
        bboxMm: r.bboxMm,
        thumbPath: null,
        class: null,
        itemCode: null,
        lineIds: [],
        detectionIds: [],
        count: 1,
        ref: { roomId: r.id },
        members: [],
        roomIssues: issues,
        needsSettings,
      });
    }
  }

  // --- lines that are red / yellow without any per-item cause (rule default, one-off suggestion, …)
  for (const l of input.lines) {
    if (l.level === 'green' || l.status !== 'draft' || linesWithCause.has(l.id)) continue;
    const score = REVIEW_DEFAULT_SCORE[l.level];
    const qty = effectiveQty(l);
    items.push({
      id: `line:${l.id}`,
      kind: 'line',
      level: l.level,
      risk: round(riskOf(qty, score, l.level)),
      score: null,
      qtyImpact: Math.abs(qty),
      title: `${l.code} ${l.description}`.slice(0, 300),
      reasons: (l.reasons ?? []).slice(0, 32),
      suggestedAction: 'review_line',
      sheetId: null,
      versionId: null,
      floor: l.floor ?? null,
      bboxMm: null,
      thumbPath: null,
      class: null,
      itemCode: l.code,
      lineIds: [l.id],
      detectionIds: [],
      count: 1,
      ref: { lineId: l.id },
      members: [],
    });
  }

  // --- unmatched corrections (resolved against the live corrections in the overlay)
  for (const u of input.unmatched) {
    items.push({
      id: `corr:${u.correctionId}`,
      kind: 'unmatched_correction',
      level: 'red',
      risk: 0,
      score: 0,
      qtyImpact: 1,
      title: UNMATCHED_TITLE,
      reasons: [u.reason],
      suggestedAction: 'redo_correction',
      sheetId: u.sheetId,
      versionId: u.versionId,
      floor: null,
      bboxMm: null,
      thumbPath: null,
      class: null,
      itemCode: null,
      lineIds: [],
      detectionIds: [],
      count: 1,
      ref: { correctionId: u.correctionId },
      members: [],
      unmatched: u,
    });
  }
  return { buildId: input.buildId, items };
}

const DET_KINDS = new Set(['accept', 'reject', 'remove', 'reclassify', 'move']);
const GROUP_KINDS = new Set(['accept', 'reject', 'remove', 'unlink', 'link']);

/** Applies live state: active corrections remove what they handled; room settings; unmatched corrections. Sorted. */
export function applyOverlay(base: QueueBase, active: readonly Correction[], roomSettingsIds: ReadonlySet<string>): BaseItem[] {
  const handledDet = new Set<string>();
  const anchors = new Map<string, Array<{ versionId: string; x: number; y: number; r: number }>>();
  const handledGroups = new Set<string>();
  const handledRooms = new Set<string>();
  const byId = new Map(active.map((c) => [c.id, c]));
  for (const c of active) {
    if (DET_KINDS.has(c.kind) && c.detectionId) {
      handledDet.add(`${c.sheetId}/${c.versionId}/${c.detectionId}`);
      const a = anchors.get(c.sheetId) ?? [];
      a.push({ versionId: c.versionId, x: c.anchorMm.x, y: c.anchorMm.y, r: c.radiusMm });
      anchors.set(c.sheetId, a);
    }
    if (GROUP_KINDS.has(c.kind) && c.linkGroupId) handledGroups.add(`${c.sheetId}/${c.versionId}/${c.linkGroupId}`);
    if ((c.kind === 'accept' || c.kind === 'reject') && c.roomId) handledRooms.add(`${c.sheetId}/${c.roomId}`);
  }
  /** A member is handled by a correction on the same version + id, or (other version) within the correction's radius. */
  const memberHandled = (sheetId: string | null, versionId: string | null, m: Member): boolean => {
    if (!sheetId || !versionId) return false;
    if (handledDet.has(`${sheetId}/${versionId}/${m.id}`)) return true;
    for (const a of anchors.get(sheetId) ?? []) {
      if (a.versionId !== versionId && Math.hypot(a.x - m.centerMm.x, a.y - m.centerMm.y) <= a.r) return true;
    }
    return false;
  };

  const out: BaseItem[] = [];
  for (const it of base.items) {
    switch (it.kind) {
      case 'detection':
      case 'cluster':
      case 'unknown_cluster': {
        if (it.kind === 'unknown_cluster' && !it.members.length) {
          out.push(it);
          break;
        }
        const left = it.members.filter((m) => !memberHandled(it.sheetId, it.versionId, m));
        if (!left.length) break;
        if (left.length === it.members.length) {
          out.push(it);
          break;
        }
        const risk = it.kind === 'unknown_cluster' ? riskOf(left.length, 0, 'red') : left.reduce((s, m) => s + m.risk, 0);
        out.push({
          ...it,
          members: left,
          count: left.length,
          qtyImpact: left.length,
          risk: round(risk),
          score: it.kind === 'cluster' ? (left[0]?.score ?? null) : it.score,
          detectionIds: left.slice(0, 500).map((m) => m.id),
          memberBboxesMm: left.slice(0, 500).map((m) => m.bboxMm),
          bboxMm: unionBox(left.map((m) => m.bboxMm)) ?? it.bboxMm,
          ...(it.kind === 'cluster' ? { title: it.title.replace(/· \d+ מופעים$/, `· ${left.length} מופעים`) } : {}),
          ...(it.kind === 'unknown_cluster' ? { title: `סמל לא מוכר × ${left.length}` } : {}),
        });
        break;
      }
      case 'link_group':
        if (!handledGroups.has(`${it.sheetId}/${it.versionId}/${it.ref.linkGroupId}`)) out.push(it);
        break;
      case 'room': {
        if (handledRooms.has(`${it.sheetId}/${it.ref.roomId}`)) break;
        const hasSettings = roomSettingsIds.has(roomSettingsId(it.sheetId as string, it.ref.roomId as string));
        const issues = [...(it.roomIssues ?? [])];
        if (it.needsSettings && !hasSettings) issues.push(ROOM_SETTINGS_MISSING_REASON);
        if (!issues.length) break;
        out.push({
          ...it,
          reasons: issues,
          suggestedAction: issues.length === 1 && issues[0] === ROOM_SETTINGS_MISSING_REASON ? 'room_settings' : it.suggestedAction,
        });
        break;
      }
      case 'unmatched_correction': {
        const c = it.unmatched ? byId.get(it.unmatched.correctionId) : undefined;
        if (!c) break; // reverted (or deleted) since the build
        const q = c.quantity ?? (c.geometry?.type === 'point' ? c.geometry.mm.length : 1);
        const r = Math.max(c.radiusMm, 3);
        out.push({
          ...it,
          qtyImpact: q,
          risk: round(riskOf(q, 0, 'red')),
          floor: c.floor,
          class: c.class,
          itemCode: c.itemCode,
          bboxMm: { x: c.anchorMm.x - r, y: c.anchorMm.y - r, w: 2 * r, h: 2 * r },
          title: `${UNMATCHED_TITLE} (${c.kind})`,
        });
        break;
      }
      default:
        out.push(it);
    }
  }
  return out.sort(compareQueueItems);
}

/** Risk desc, then kind order, sheet id, item id (stable across requests). */
export function compareQueueItems(a: BaseItem, b: BaseItem): number {
  return (
    b.risk - a.risk ||
    (KIND_ORDER.get(a.kind) ?? 0) - (KIND_ORDER.get(b.kind) ?? 0) ||
    (a.sheetId ?? '').localeCompare(b.sheetId ?? '') ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
