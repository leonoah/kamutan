/**
 * Coordinate systems of the viewer.
 *
 * - **Paper mm** (canonical, docs/spec/04_architecture.md): origin top-left of the sheet, x right, y DOWN.
 *   All overlay geometry, lasso polygons and measurements are exchanged in paper mm.
 * - **World px**: pixels of the most detailed tile level (rendered at `dpi`). Deck.gl's OrthographicView
 *   (flipY = true, y down) runs in world px so that tile level `z` maps to deck zoom `z - maxLevel`
 *   with no fractional offset.
 * - **Screen px**: CSS pixels relative to the viewer's top-left corner.
 */
export type Vec2 = readonly [number, number];
export type Mutable2 = [number, number];

export const MM_PER_INCH = 25.4;
/** CSS reference resolution: 100% zoom = paper shown at its physical size on a 96-dpi screen. */
export const CSS_DPI = 96;
export const DEFAULT_DPI = 300;

export const pxPerMm = (dpi: number): number => dpi / MM_PER_INCH;
export const mmToPx = (mm: number, dpi: number): number => (mm * dpi) / MM_PER_INCH;
export const pxToMm = (px: number, dpi: number): number => (px * MM_PER_INCH) / dpi;

export const pointMmToPx = (p: Vec2, dpi: number): Mutable2 => [mmToPx(p[0], dpi), mmToPx(p[1], dpi)];
export const pointPxToMm = (p: Vec2, dpi: number): Mutable2 => [pxToMm(p[0], dpi), pxToMm(p[1], dpi)];

/** Pixel size of a sheet rendered at `dpi` (same rounding as pdfium: nearest pixel). */
export const sheetSizePx = (widthMm: number, heightMm: number, dpi: number): Mutable2 => [
  Math.round(mmToPx(widthMm, dpi)),
  Math.round(mmToPx(heightMm, dpi)),
];

/** Orthographic view state (deck.gl OrthographicView, flipY = true). `target` is in world px. */
export interface OrthoViewState {
  target: [number, number, number];
  zoom: number;
  minZoom: number;
  maxZoom: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Screen px (relative to the viewer box) → world px. Exact inverse of deck's ortho projection with flipY. */
export function screenToWorld(screen: Vec2, view: Pick<OrthoViewState, "target" | "zoom">, box: Size): Mutable2 {
  const k = 2 ** view.zoom;
  return [view.target[0] + (screen[0] - box.width / 2) / k, view.target[1] + (screen[1] - box.height / 2) / k];
}

/** World px → screen px (relative to the viewer box). */
export function worldToScreen(world: Vec2, view: Pick<OrthoViewState, "target" | "zoom">, box: Size): Mutable2 {
  const k = 2 ** view.zoom;
  return [(world[0] - view.target[0]) * k + box.width / 2, (world[1] - view.target[1]) * k + box.height / 2];
}

export const screenToMm = (s: Vec2, view: Pick<OrthoViewState, "target" | "zoom">, box: Size, dpi: number): Mutable2 =>
  pointPxToMm(screenToWorld(s, view, box), dpi);
export const mmToScreen = (p: Vec2, view: Pick<OrthoViewState, "target" | "zoom">, box: Size, dpi: number): Mutable2 =>
  worldToScreen(pointMmToPx(p, dpi), view, box);

/** Zoom percentage where 100% = paper at physical size (96 CSS px per inch). */
export const zoomToPercent = (zoom: number, dpi: number): number => (2 ** zoom * dpi * 100) / CSS_DPI;
export const percentToZoom = (pct: number, dpi: number): number => Math.log2((pct / 100) * (CSS_DPI / dpi));
