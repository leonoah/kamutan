import type { Vec2 } from "./math/coords";

/** RGBA 0..255. */
export type Rgba = [number, number, number, number] | readonly [number, number, number, number];

interface FeatureBase {
  /** Stable id returned by picking, lasso and selection callbacks. */
  id: string;
  /** Stroke/fill colour. Defaults per kind. */
  color?: Rgba;
  /** Not pickable / not lasso-selectable (e.g. floor-region outlines, evidence). */
  passive?: boolean;
  /** Drawn at reduced opacity (e.g. a lifecycle layer that is toggled off — spec: dimmed to 35%, not hidden). */
  dimmed?: boolean;
}

/** A point marker (symbol anchor). Paper mm, y down. */
export interface PointFeature extends FeatureBase {
  kind: "point";
  position: Vec2;
  /** Marker radius in CSS px (default 6). */
  radiusPx?: number;
  /** Short chip drawn next to the point (e.g. the running number of a manual count "3"). */
  label?: string;
}

/** A closed polygon (room, region, symbol bbox). Paper mm, y down. */
export interface PolygonFeature extends FeatureBase {
  kind: "polygon";
  polygon: readonly Vec2[];
  fillColor?: Rgba;
  /** Outline width in CSS px (default 1.5). */
  lineWidthPx?: number;
  /** Optional label rendered as an HTML chip at the polygon centroid (RTL-safe). */
  label?: string;
  /** Second line: an LTR-isolated number (rendered in <bdi dir="ltr">, e.g. an area "12.4")… */
  labelLtr?: string;
  /** …followed by a Hebrew unit after it in reading order (e.g. "מ״ר" → "12.4 מ״ר" read right-to-left). */
  labelSuffix?: string;
  /** Hide the label while the polygon is narrower than this on screen (px). Default 0 (always). */
  labelMinPx?: number;
  /** Dashed outline (e.g. legend boxes, demolished rooms). */
  dashed?: boolean;
}

/**
 * Confidence marker shape (spec §מצבי ביטחון): ● high, ▲ mid, ◆ low, ◇ unknown (hollow).
 * Shape always travels with the colour so the level never relies on colour alone (WCAG 1.4.1).
 */
export type MarkerShape = "circle" | "triangle" | "diamond" | "diamond-open";

/**
 * A detected symbol instance: a GPU-drawn marker sized in PAPER mm, so it scales with the drawing when
 * zooming (with a small pixel minimum so far-out views still show a dot). Paper mm, y down.
 */
export interface MarkerFeature extends FeatureBase {
  kind: "marker";
  position: Vec2;
  /** Marker diameter in paper mm (≈ the symbol size; default 6). */
  sizeMm?: number;
  shape: MarkerShape;
  /** Dashed outline (existing / demolish lifecycle, unknown symbols). */
  dashed?: boolean;
  /** Diagonal strike (demolish: "✕ קו אלכסוני"). */
  strike?: boolean;
}

/** An open polyline (switch arc, wall, measured length). Paper mm, y down. */
export interface PathFeature extends FeatureBase {
  kind: "path";
  path: readonly Vec2[];
  widthPx?: number;
  /**
   * Line style: "dashed" (e.g. a switch↔luminaire arc as drawn on the sheet) or "dotted" (a segment the system
   * completed itself — spec §סעיפים מורכבים: "קווים שהמערכת השלימה מוצגים בקו נקודות"). Default solid.
   */
  dash?: "dashed" | "dotted";
}

export type OverlayFeature = PointFeature | MarkerFeature | PolygonFeature | PathFeature;

/**
 * Tools (spec §כלי תיקון על השרטוט): select, pan, lasso, measure (2-click length), calibrate (2-click scale) and the
 * Sprint-4 correction tools: add (click-to-add, snaps to a nearby symbol), remove (click a symbol), move (drag a
 * symbol), link (drag from a switch to a point), count (numbered clicks, Enter saves), area (polygon with snapping,
 * double-click / Enter closes) and length (polyline, Enter finishes).
 */
export type ViewerTool = "select" | "pan" | "lasso" | "measure" | "calibrate" | "add" | "remove" | "move" | "link" | "count" | "area" | "length";

export interface PointToolEvent {
  tool: "add" | "remove";
  /** Click position (snapped onto a nearby symbol for `add`), paper mm. */
  mm: [number, number];
  /** Nearest pickable marker/point within the snap radius, if any. */
  hitId: string | null;
}
export interface MoveResult {
  id: string;
  fromMm: [number, number];
  toMm: [number, number];
}
export interface LinkResult {
  fromId: string;
  toId: string;
}
export interface CountResult {
  pointsMm: [number, number][];
}
export interface AreaResult {
  polygonMm: [number, number][];
  /** Paper mm² / mm and, at the sheet scale, real m² / m (null when the scale is unknown). */
  paperMm2: number;
  paperPerimeterMm: number;
  areaM2: number | null;
  perimeterM: number | null;
}
export interface LengthResult {
  pathMm: [number, number][];
  paperMm: number;
  lengthM: number | null;
}

/** Tiles of one sheet version + a URL builder (signed URLs from the API, or static files in dev). */
export interface TileSource {
  tileSize: number;
  dpi: number;
  levels: number;
  widthPx: number;
  heightPx: number;
  /**
   * URL of tile (z, x, y), z = pyramid level (0 = one tile). Return null for "no tile".
   * May be async (e.g. batched short-lived signed URLs fetched on demand from the API).
   */
  tileUrl: (z: number, x: number, y: number, signal?: AbortSignal) => string | null | Promise<string | null>;
  /** Optional thumbnail for the minimap (defaults to tile 0/0_0). */
  thumbnailUrl?: string | null;
  /** Changes whenever URLs change (e.g. re-signed) so cached tiles are refetched. */
  cacheKey?: string;
}

export interface LassoResult {
  polygonMm: [number, number][];
  ids: string[];
}

export interface MeasureResult {
  a: [number, number];
  b: [number, number];
  paperMm: number;
  /** Real length in mm at the sheet's scale, or null when the scale is unknown. */
  realMm: number | null;
}

export interface ViewInfo {
  zoom: number;
  /** 100% = paper at physical size. */
  percent: number;
  /** Visible paper rect in mm [x0, y0, x1, y1]. */
  visibleMm: [number, number, number, number];
}

/** UI strings of the floating (RTL) parts. Hebrew defaults; the app passes i18n strings. */
export interface ViewerLabels {
  minimap: string;
  minimapToggle: string;
  measureHint: string;
  calibrateHint: string;
  lassoHint: string;
  realLength: string;
  unitCm: string;
  apply: string;
  cancel: string;
  /** "{{measured}} — close to {{nearest}}. Use {{nearest}}?" */
  scaleSuggestion: (measured: string, nearest: string) => string;
  scaleResult: (measured: string) => string;
  formatLength: (realMm: number | null, paperMm: number) => string;
  /* Sprint 4 tools */
  addHint: string;
  removeHint: string;
  moveHint: string;
  linkHint: string;
  countHint: string;
  areaHint: string;
  lengthHint: string;
  /** "12.4 מ״ר · היקף 14.2 מ״א" */
  formatArea: (areaM2: number | null, perimeterM: number | null, paperMm2: number) => string;
  /** Running count chip ("3 נספרו · Enter לשמירה"). */
  formatCount: (n: number) => string;
}
