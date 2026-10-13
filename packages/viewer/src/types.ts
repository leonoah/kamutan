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
}

/** An open polyline (switch arc, wall, measured length). Paper mm, y down. */
export interface PathFeature extends FeatureBase {
  kind: "path";
  path: readonly Vec2[];
  widthPx?: number;
}

export type OverlayFeature = PointFeature | PolygonFeature | PathFeature;

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
