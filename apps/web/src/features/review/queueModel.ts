import type { BBoxMm, BoqLine, Correction, DbLevel, Detection, LinkGroup, ReviewQueueItem, Room, RoomSettings, UnknownCluster } from "@/api/types";
import { UNKNOWN_CLASS } from "@/features/understanding/taxonomy";
import { needsTilingSettings, settingsDocId } from "@/features/tiling/model";
import { isCompositeLine } from "@/features/boq/model";

/**
 * Review queue (brief §Review queue): items of all kinds ranked by risk = |qty impact on the BOQ line| × (1 − score)
 * × level weight. Similar detections (same sheet + class + level + first reason) are grouped into cluster cards so a
 * reviewer handles them with one key press. Shared by the mock backend and tests; the real API computes the same.
 */

export const LEVEL_WEIGHT: Record<DbLevel | "unknown", number> = { red: 3, unknown: 3, yellow: 1, green: 0 };
export const MIN_CLUSTER = 3;
/** Human-time budget used for "נותרו N · כ-X דק'" (spec: ≈3 s per item, ≈5 s per cluster card). */
export const SECONDS_PER_ITEM = 3;
export const SECONDS_PER_CLUSTER = 5;

export interface QueueSheetInput {
  sheetId: string;
  versionId: string;
  /** Effective detections (corrections applied). */
  detections: readonly Detection[];
  unknownClusters: readonly UnknownCluster[];
  linkGroups: readonly LinkGroup[];
  rooms: readonly Room[];
  thumbs?: Record<string, string>;
}
export interface QueueInput {
  sheets: readonly QueueSheetInput[];
  lines: readonly BoqLine[];
  /** settingsDocId → settings (rooms that a human already set up). */
  roomSettings: ReadonlyMap<string, RoomSettings>;
  unmatched: readonly Correction[];
  /** Detection → line ids per sheet (`${sheetId}/${detectionId}`), for the qty impact. */
  lineOf?: ReadonlyMap<string, string[]>;
}

export function unionBBox(boxes: readonly BBoxMm[], pad = 0): BBoxMm {
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
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
}

const polyBBox = (r: Room): BBoxMm => {
  const xs = r.polygonMm.map((p) => p.x);
  const ys = r.polygonMm.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};

const needsLook = (d: Detection) => !d.rejected && !d.manual && d.level !== "green";

export function buildReviewQueue(input: QueueInput): ReviewQueueItem[] {
  const items: ReviewQueueItem[] = [];
  const codeOfLine = new Map(input.lines.map((l) => [l.id, l]));
  for (const s of input.sheets) {
    const impactOf = (d: Detection) => {
      const lids = input.lineOf?.get(`${s.sheetId}/${d.id}`) ?? [];
      return Math.max(1, lids.length);
    };
    const lineInfo = (d: Detection) => {
      const lid = input.lineOf?.get(`${s.sheetId}/${d.id}`)?.[0] ?? null;
      const l = lid ? codeOfLine.get(lid) : undefined;
      return { lineId: lid, itemCode: l?.code ?? null };
    };
    /* detections + clusters */
    const groups = new Map<string, Detection[]>();
    for (const d of s.detections) {
      if (!needsLook(d) || d.class === UNKNOWN_CLASS || d.clusterId) continue;
      const k = `${d.class}|${d.level}|${d.reasons[0] ?? ""}`;
      groups.set(k, [...(groups.get(k) ?? []), d]);
    }
    for (const [k, ds] of groups) {
      const sorted = [...ds].sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
      const first = sorted[0]!;
      if (sorted.length >= MIN_CLUSTER) {
        const risk = sorted.reduce((sum, d) => sum + impactOf(d) * (1 - d.score) * LEVEL_WEIGHT[d.level], 0);
        items.push({
          id: `cl:${s.sheetId}:${k}`,
          kind: "cluster",
          sheetId: s.sheetId,
          versionId: s.versionId,
          bboxMm: unionBBox(
            sorted.map((d) => d.bboxMm),
            6,
          ),
          thumbUrl: null,
          level: first.level,
          reasons: first.reasons,
          risk,
          suggestedAction: "accept",
          class: first.class,
          ...lineInfo(first),
          detectionIds: sorted.map((d) => d.id),
          members: sorted.map((d) => ({ detectionId: d.id, bboxMm: d.bboxMm, score: d.score, thumbUrl: null })),
          score: first.score,
        });
      } else
        for (const d of sorted)
          items.push({
            id: `det:${s.sheetId}:${d.id}`,
            kind: "detection",
            sheetId: s.sheetId,
            versionId: s.versionId,
            bboxMm: d.bboxMm,
            thumbUrl: null,
            level: d.level,
            reasons: d.reasons,
            risk: impactOf(d) * (1 - d.score) * LEVEL_WEIGHT[d.level],
            suggestedAction: "accept",
            class: d.class,
            ...lineInfo(d),
            detectionIds: [d.id],
            score: d.score,
          });
    }
    /* unknown clusters ("מה זה?") */
    for (const c of s.unknownClusters) {
      const members = s.detections.filter((d) => d.clusterId === c.id && !d.rejected);
      if (!members.length && c.count === 0) continue;
      items.push({
        id: `uc:${s.sheetId}:${c.id}`,
        kind: "unknown_cluster",
        sheetId: s.sheetId,
        versionId: s.versionId,
        bboxMm: members.length
          ? unionBBox(
              members.map((d) => d.bboxMm),
              6,
            )
          : c.exemplarBboxMm,
        thumbUrl: s.thumbs?.[c.id] ?? null,
        level: "unknown",
        reasons: ["סמל לא במקרא"],
        risk: Math.max(members.length, c.count) * LEVEL_WEIGHT.unknown,
        suggestedAction: "resolve",
        clusterId: c.id,
        detectionIds: members.map((d) => d.id),
        members: members.map((d) => ({ detectionId: d.id, bboxMm: d.bboxMm, score: d.score, thumbUrl: null })),
        score: 0,
      });
    }
    /* link groups */
    const byId = new Map(s.detections.map((d) => [d.id, d]));
    for (const g of s.linkGroups) {
      if (g.level === "green") continue;
      const ms = [...g.switchIds, ...g.luminaireIds].map((id) => byId.get(id)).filter((d): d is Detection => Boolean(d));
      if (!ms.length) continue;
      items.push({
        id: `lg:${s.sheetId}:${g.id}`,
        kind: "link_group",
        sheetId: s.sheetId,
        versionId: s.versionId,
        bboxMm: unionBBox(
          ms.map((d) => d.bboxMm),
          8,
        ),
        thumbUrl: null,
        level: g.level,
        reasons: g.reasons.length ? g.reasons : ["קישור מפסק לא ודאי"],
        risk: 1 * (1 - g.confidence) * LEVEL_WEIGHT[g.level] * 1.5,
        suggestedAction: "accept",
        linkGroupId: g.id,
        detectionIds: ms.map((d) => d.id),
        score: g.confidence,
      });
    }
    /* rooms: unnamed / not closed / wet room without settings */
    for (const r of s.rooms) {
      const saved = input.roomSettings.has(settingsDocId(s.sheetId, r.id));
      const reasons: string[] = [];
      if (!saved && !r.name) reasons.push("חדר ללא שם");
      if (!saved && r.level === "red") reasons.push("חדר לא סגור");
      if (!saved && needsTilingSettings(r)) reasons.push("הגדרות חיפוי חסרות");
      if (!reasons.length) continue;
      const level: DbLevel = r.level === "red" ? "red" : "yellow";
      items.push({
        id: `room:${s.sheetId}:${r.id}`,
        kind: "room",
        sheetId: s.sheetId,
        versionId: s.versionId,
        bboxMm: polyBBox(r),
        thumbUrl: null,
        level,
        reasons,
        // Wet rooms drive chapter 05 quantities (m²): weigh by area.
        risk: (needsTilingSettings(r) ? Math.max(2, r.areaM2) : 0.5) * (1 - r.confidence) * LEVEL_WEIGHT[level],
        suggestedAction: "settings",
        roomId: r.id,
        title: r.name,
        score: r.confidence,
      });
    }
  }
  /* corrections that no longer match the current version */
  for (const c of input.unmatched)
    items.push({
      id: `uc-corr:${c.id}`,
      kind: "unmatched_correction",
      sheetId: c.sheetId,
      versionId: c.versionId,
      bboxMm: { x: c.anchorMm.x - 10, y: c.anchorMm.y - 10, w: 20, h: 20 },
      thumbUrl: null,
      level: "red",
      reasons: ["תיקון לא הותאם"],
      risk: 10,
      suggestedAction: "open",
      correctionId: c.id,
      class: c.class,
      score: 0,
    });
  /* BOQ lines red without a per-item cause (rule default, template suggestion) */
  const itemLines = new Set(items.map((i) => i.lineId).filter(Boolean));
  for (const l of input.lines) {
    if (l.level === "green" || l.status !== "draft" || itemLines.has(l.id)) continue;
    // Tiling lines are reviewed through their rooms; template suggestions / rule defaults have no item to look at.
    const noItems = l.evidenceCount === 0 && !(l.breakdown?.length ?? 0);
    if (!noItems && !isCompositeLine(l)) continue;
    if (isCompositeLine(l) && l.level !== "red") continue;
    items.push({
      id: `line:${l.id}`,
      kind: "line",
      sheetId: l.sourceVersions[0]?.sheetId ?? "",
      versionId: l.sourceVersions[0]?.versionId ?? "",
      bboxMm: { x: 0, y: 0, w: 0, h: 0 },
      thumbUrl: null,
      level: l.level,
      reasons: l.reasons ?? [],
      risk: Math.max(1, Math.min(20, l.qtyOverride ?? l.qty)) * 0.5 * LEVEL_WEIGHT[l.level],
      suggestedAction: "accept",
      lineId: l.id,
      itemCode: l.code,
      title: l.description,
      score: 0.5,
    });
  }
  return items.sort((a, b) => b.risk - a.risk || a.id.localeCompare(b.id));
}

/** Seconds of human time a set of queue items needs (spec budget). */
export const estimateSeconds = (items: readonly Pick<ReviewQueueItem, "kind">[]) =>
  items.reduce((s, i) => s + (i.kind === "cluster" || i.kind === "unknown_cluster" ? SECONDS_PER_CLUSTER : SECONDS_PER_ITEM), 0);
export const estimateMinutes = (items: readonly Pick<ReviewQueueItem, "kind">[]) =>
  Math.max(items.length ? 1 : 0, Math.ceil(estimateSeconds(items) / 60));
