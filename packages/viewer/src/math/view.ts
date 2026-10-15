import { CSS_DPI, type Mutable2, type OrthoViewState, type Size, screenToWorld, worldToScreen, type Vec2 } from "./coords";
import type { BBox } from "./geometry";

export interface ZoomLimits {
  minZoom: number;
  maxZoom: number;
}

/** Zoom that fits a world-px box into the viewer with `padding` CSS px on each side. */
export function fitZoom(box: Size, worldW: number, worldH: number, padding = 24): number {
  const w = Math.max(1, box.width - 2 * padding);
  const h = Math.max(1, box.height - 2 * padding);
  return Math.log2(Math.min(w / Math.max(worldW, 1e-9), h / Math.max(worldH, 1e-9)));
}

/**
 * Limits: zoom out to half of "fit sheet", zoom in to 8× the max tile level
 * (or 400% of physical size, whichever is larger).
 */
export function zoomLimits(box: Size, sheetW: number, sheetH: number, dpi: number): ZoomLimits {
  const fit = fitZoom(box, sheetW, sheetH);
  const physical400 = Math.log2(4 * (CSS_DPI / dpi));
  return { minZoom: Math.min(fit - 1, 0), maxZoom: Math.max(3, physical400) };
}

export const clampZoom = (z: number, l: ZoomLimits): number => Math.min(l.maxZoom, Math.max(l.minZoom, z));

/** View state that fits world bbox (px) into the box. */
export function fitBBox(box: Size, b: BBox, limits: ZoomLimits, padding = 24): OrthoViewState {
  const zoom = clampZoom(fitZoom(box, b.maxX - b.minX, b.maxY - b.minY, padding), limits);
  return { target: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, 0], zoom, ...limits };
}

/** Zoom by `delta` (log2 steps) keeping the world point under `anchor` (screen px) fixed. */
export function zoomAround(view: OrthoViewState, delta: number, anchor: Vec2, box: Size): OrthoViewState {
  const zoom = clampZoom(view.zoom + delta, view);
  const before = screenToWorld(anchor, view, box);
  const k = 2 ** zoom;
  const target: [number, number, number] = [
    before[0] - (anchor[0] - box.width / 2) / k,
    before[1] - (anchor[1] - box.height / 2) / k,
    0,
  ];
  return { ...view, zoom, target };
}

export function panBy(view: OrthoViewState, dxScreen: number, dyScreen: number): OrthoViewState {
  const k = 2 ** view.zoom;
  return { ...view, target: [view.target[0] + dxScreen / k, view.target[1] + dyScreen / k, 0] };
}

/** Visible world rect [minX, minY, maxX, maxY]. */
export function visibleWorldRect(view: OrthoViewState, box: Size): BBox {
  const [minX, minY] = screenToWorld([0, 0], view, box);
  const [maxX, maxY] = screenToWorld([box.width, box.height], view, box);
  return { minX, minY, maxX, maxY };
}

/** Minimap ⇄ world mapping: the sheet (world px) is letterboxed into the minimap box. */
export function minimapTransform(mini: Size, sheetW: number, sheetH: number) {
  const s = Math.min(mini.width / sheetW, mini.height / sheetH);
  const ox = (mini.width - sheetW * s) / 2;
  const oy = (mini.height - sheetH * s) / 2;
  return {
    scale: s,
    offset: [ox, oy] as Mutable2,
    toMini: (p: Vec2): Mutable2 => [ox + p[0] * s, oy + p[1] * s],
    toWorld: (p: Vec2): Mutable2 => [(p[0] - ox) / s, (p[1] - oy) / s],
  };
}

export { worldToScreen };
