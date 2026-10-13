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
}

export type OverlayFeature = PointFeature | MarkerFeature | PolygonFeature | PathFeature;

export type ViewerTool = "select" | "pan" | "lasso" | "measure" | "calibrate";

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
}
