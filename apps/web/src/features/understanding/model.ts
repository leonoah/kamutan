import type { MarkerFeature, MarkerShape, OverlayFeature, PolygonFeature, Rgba } from "@kamutan/viewer";
import type { ConfidenceLevel } from "@/components/ConfidenceBadge";
import type {
  BBoxMm,
  DbLevel,
  Detection,
  DetectionsArtifact,
  LegendArtifact,
  Lifecycle,
  Room,
  RoomsArtifact,
} from "@/api/types";
import { CLASS_INFO, UNKNOWN_CLASS, domainOf } from "./taxonomy";

/**
 * Pure model of the Sprint-2 overlay: detections → viewer markers, rooms → polygons, legend → boxes,
 * filters, counts by class. Shared by the review workspace and the mock backend (cluster resolution).
 */

/** Overlay colours on the WHITE drawing canvas (spec: canvas stays white in dark mode → light tokens). */
export const OVERLAY_RGB = {
  green: [27, 127, 90],
  yellow: [178, 107, 0],
  red: [194, 65, 12],
  unknown: [109, 40, 217],
  existing: [120, 113, 108],
  demolish: [159, 18, 57],
  room: [15, 76, 129],
  legend: [15, 76, 129],
} as const satisfies Record<string, readonly [number, number, number]>;

const rgba = (c: readonly [number, number, number], a = 255): Rgba => [c[0], c[1], c[2], a];

export type LevelKey = DbLevel | "unknown";
export const LEVEL_KEYS: LevelKey[] = ["green", "yellow", "red", "unknown"];

/** A detection's display level: unknown symbols get the ◇ "לא מוכר" language regardless of score. */
export const levelKeyOf = (d: Pick<Detection, "class" | "level">): LevelKey => (d.class === UNKNOWN_CLASS ? "unknown" : d.level);

export const uiLevel = (k: LevelKey): ConfidenceLevel =>
  k === "green" ? "high" : k === "yellow" ? "mid" : k === "red" ? "low" : "unknown";

export const SHAPE: Record<LevelKey, MarkerShape> = {
  green: "circle",
  yellow: "triangle",
  red: "diamond",
  unknown: "diamond-open",
};

export type LifecycleVisibility = Record<"new" | "existing" | "demolish", boolean>;
export const DEFAULT_LIFECYCLES: LifecycleVisibility = { new: true, existing: false, demolish: false };

/** "unknown" lifecycle is treated as new (the default, shown layer). */
const lifecycleKey = (l: Lifecycle): keyof LifecycleVisibility => (l === "existing" || l === "demolish" ? l : "new");

/**
 * Detections → GPU markers. Level = colour + shape (●▲◆◇). Lifecycle:
 *  - existing → dashed frame in the "existing" grey (spec: ◌ אפור, מסגרת מקווקוות),
 *  - demolish → dashed frame + diagonal strike in demolish red (spec: ✕ קו אלכסוני),
 *  - a lifecycle layer toggled OFF is dimmed to 35% (not hidden).
 */
export function detectionMarkers(dets: readonly Detection[], visible: LifecycleVisibility = DEFAULT_LIFECYCLES): MarkerFeature[] {
  return dets.map((d) => {
    const k = levelKeyOf(d);
    const lc = d.lifecycle;
    const color =
      lc === "existing" ? OVERLAY_RGB.existing : lc === "demolish" ? OVERLAY_RGB.demolish : OVERLAY_RGB[k];
    return {
      id: d.id,
      kind: "marker",
      position: [d.centerMm.x, d.centerMm.y],
      sizeMm: Math.max(4, Math.min(30, Math.max(d.bboxMm.w, d.bboxMm.h))),
      shape: SHAPE[k],
      color: rgba(color),
      dashed: lc === "existing" || lc === "demolish",
      strike: lc === "demolish",
      dimmed: !visible[lifecycleKey(lc)],
    } satisfies MarkerFeature;
  });
}

export function formatArea(m2: number): string {
  return new Intl.NumberFormat("he-IL", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(m2);
}

/** Rooms → translucent passive polygons with "name" + "<bdi>12.4</bdi> מ״ר" label. */
export function roomPolygons(rooms: readonly Room[], opts: { unnamed: string; areaUnit: string; dimIds?: ReadonlySet<string> | null }): PolygonFeature[] {
  return rooms.map((r) => ({
    id: r.id,
    kind: "polygon",
    passive: true,
    polygon: r.polygonMm.map((p) => [p.x, p.y] as [number, number]),
    color: rgba(OVERLAY_RGB.room, 170),
    fillColor: rgba(OVERLAY_RGB.room, 16),
    lineWidthPx: 1.25,
    label: r.name ?? opts.unnamed,
    labelLtr: formatArea(r.areaM2),
    labelSuffix: opts.areaUnit,
    labelMinPx: 70,
    dashed: r.level === "red",
    dimmed: opts.dimIds ? opts.dimIds.has(r.id) : false,
  }));
}

/**
 * Legend blocks → dashed outlined boxes. No centroid label: it would sit on a legend symbol (the sheet's own
 * "מקרא" title is right above the box anyway).
 */
export function legendBoxes(legend: LegendArtifact | null): PolygonFeature[] {
  if (!legend) return [];
  return legend.legends.map((l) => ({
    id: l.id,
    kind: "polygon",
    passive: true,
    polygon: bboxPolygon(l.bboxMm),
    color: rgba(OVERLAY_RGB.legend, 220),
    fillColor: rgba(OVERLAY_RGB.legend, 8),
    lineWidthPx: 2,
    dashed: true,
  }));
}

export const bboxPolygon = (b: BBoxMm): [number, number][] => [
  [b.x, b.y],
  [b.x + b.w, b.y],
  [b.x + b.w, b.y + b.h],
  [b.x, b.y + b.h],
];

/** Union bbox [x0, y0, x1, y1] (paper mm) of detections, padded; null for none. */
export function boundsOf(dets: readonly Pick<Detection, "bboxMm">[], padMm = 6): [number, number, number, number] | null {
  if (dets.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const { bboxMm: b } of dets) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return [x0 - padMm, y0 - padMm, x1 + padMm, y1 + padMm];
}

/* ---------------- filters ---------------- */

export interface OverlayFilters {
  /** Domains (electrical/lighting/plumbing/unknown); empty = all. */
  domains: string[];
  floor: string | null;
  room: string | null;
  levels: LevelKey[];
}
export const EMPTY_FILTERS: OverlayFilters = { domains: [], floor: null, room: null, levels: [...LEVEL_KEYS] };

export function filtersFromParams(p: URLSearchParams): OverlayFilters {
  const list = (k: string) => (p.get(k) ?? "").split(",").filter(Boolean);
  const lv = list("lvl").filter((l): l is LevelKey => (LEVEL_KEYS as string[]).includes(l));
  return { domains: list("dom"), floor: p.get("floor") || null, room: p.get("room") || null, levels: p.has("lvl") ? lv : [...LEVEL_KEYS] };
}

export function filtersToParams(f: OverlayFilters, base: URLSearchParams): URLSearchParams {
  const p = new URLSearchParams(base);
  const set = (k: string, v: string | null) => (v ? p.set(k, v) : p.delete(k));
  set("dom", f.domains.join(",") || null);
  set("floor", f.floor);
  set("room", f.room);
  set("lvl", f.levels.length === LEVEL_KEYS.length ? null : f.levels.join(",") || "none");
  return p;
}

export const isFiltered = (f: OverlayFilters) =>
  f.domains.length > 0 || f.floor !== null || f.room !== null || f.levels.length !== LEVEL_KEYS.length;

export function applyFilters(dets: readonly Detection[], f: OverlayFilters): Detection[] {
  const lv = new Set(f.levels);
  const dom = new Set(f.domains);
  return dets.filter(
    (d) =>
      lv.has(levelKeyOf(d)) &&
      (dom.size === 0 || dom.has(domainOf(d.class))) &&
      (f.floor === null || d.floor === f.floor) &&
      (f.room === null || (f.room === "none" ? d.roomId === null : d.roomId === f.room)),
  );
}

/* ---------------- counts by class ---------------- */

export interface ClassCount {
  cls: string;
  domain: string;
  green: number;
  yellow: number;
  red: number;
  unknown: number;
  total: number;
  /** Representative legend entry (most frequent) for the label/thumbnail. */
  legendEntryId: string | null;
  /** Lowest level present (row confidence = lowest level of its items). */
  worst: LevelKey;
}

const DOMAIN_ORDER = ["electrical", "lighting", "plumbing", "other", "unknown"];
const WORST_ORDER: LevelKey[] = ["unknown", "red", "yellow", "green"];

export function countsByClass(dets: readonly Detection[]): ClassCount[] {
  const map = new Map<string, ClassCount & { le: Map<string, number> }>();
  for (const d of dets) {
    let c = map.get(d.class);
    if (!c) {
      c = { cls: d.class, domain: domainOf(d.class), green: 0, yellow: 0, red: 0, unknown: 0, total: 0, legendEntryId: null, worst: "green", le: new Map() };
      map.set(d.class, c);
    }
    c[levelKeyOf(d)] += 1;
    c.total += 1;
    if (d.legendEntryId) c.le.set(d.legendEntryId, (c.le.get(d.legendEntryId) ?? 0) + 1);
  }
  return [...map.values()]
    .map(({ le, ...c }) => ({
      ...c,
      legendEntryId: [...le.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      worst: WORST_ORDER.find((k) => c[k] > 0) ?? "green",
    }))
    .sort(
      (a, b) =>
        DOMAIN_ORDER.indexOf(a.domain) - DOMAIN_ORDER.indexOf(b.domain) ||
        b.total - a.total ||
        (CLASS_INFO[a.cls]?.he ?? a.cls).localeCompare(CLASS_INFO[b.cls]?.he ?? b.cls, "he"),
    );
}

/** Verified share = green / all detections (0..100). */
export function verifiedPct(dets: readonly Detection[]): number {
  if (dets.length === 0) return 0;
  return Math.round((dets.filter((d) => levelKeyOf(d) === "green").length / dets.length) * 100);
}

/** Review queue: non-green, known-class items, lowest score first (unknowns are asked per cluster). */
export function reviewQueue(dets: readonly Detection[]): Detection[] {
  return dets.filter((d) => d.class !== UNKNOWN_CLASS && d.level !== "green").sort((a, b) => a.score - b.score);
}

/* ---------------- mutations (optimistic UI + mock backend) ---------------- */

/**
 * Apply a "מה זה?" answer to a detections artifact: every detection of the cluster takes the chosen class
 * (yellow until re-run: the class is human-given but the instances were never matched to a legend symbol);
 * `cls = null` ("לא רלוונטי") drops them. The cluster leaves `unknownClusters`.
 */
export function applyClusterResolution(doc: DetectionsArtifact, clusterId: string, cls: string | null): DetectionsArtifact {
  const detections: Detection[] = [];
  for (const d of doc.detections) {
    if (d.clusterId !== clusterId) {
      detections.push(d);
      continue;
    }
    if (cls === null) continue;
    detections.push({
      ...d,
      class: cls,
      clusterId: null,
      level: d.level === "red" ? "yellow" : d.level,
      reasons: d.reasons.length ? d.reasons : ["סמל חדש לארגון"],
    });
  }
  return { ...doc, detections, unknownClusters: doc.unknownClusters.filter((c) => c.id !== clusterId) };
}

/** Reassigning a legend entry re-labels every detection matched to it. */
export function applyLegendClass(doc: DetectionsArtifact, entryId: string, cls: string): DetectionsArtifact {
  return { ...doc, detections: doc.detections.map((d) => (d.legendEntryId === entryId ? { ...d, class: cls } : d)) };
}

/** Rooms by id (for labels in lists / popovers). */
export const roomsById = (rooms: RoomsArtifact | null): Map<string, Room> => new Map((rooms?.rooms ?? []).map((r) => [r.id, r]));

/** Overlay features in draw order: rooms (bottom), legend boxes, markers (top). */
export function overlayFeatures(parts: { rooms: PolygonFeature[]; legend: PolygonFeature[]; markers: MarkerFeature[] }): OverlayFeature[] {
  return [...parts.rooms, ...parts.legend, ...parts.markers];
}
