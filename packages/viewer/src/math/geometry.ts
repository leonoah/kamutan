import type { Mutable2, Vec2 } from "./coords";

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const distance = (a: Vec2, b: Vec2): number => Math.hypot(b[0] - a[0], b[1] - a[1]);

export function pathLength(path: readonly Vec2[]): number {
  let len = 0;
  for (let i = 1; i < path.length; i++) len += distance(path[i - 1]!, path[i]!);
  return len;
}

export function bboxOf(points: readonly Vec2[]): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export const bboxContains = (b: BBox, p: Vec2): boolean => p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minY && p[1] <= b.maxY;

/**
 * Even-odd ray casting. The polygon may be open or closed (first == last); orientation does not matter.
 * Points exactly on an edge may fall either way (fine for lasso selection).
 */
export function pointInPolygon(p: Vec2, polygon: readonly Vec2[]): boolean {
  const [x, y] = p;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Signed shoelace area (positive = clockwise on a y-down page). */
export function signedArea(polygon: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    a += polygon[j]![0] * polygon[i]![1] - polygon[i]![0] * polygon[j]![1];
  }
  return a / 2;
}

export const polygonArea = (polygon: readonly Vec2[]): number => Math.abs(signedArea(polygon));

/** Area centroid; falls back to the vertex mean for degenerate (zero-area) polygons. */
export function centroid(polygon: readonly Vec2[]): Mutable2 {
  const a = signedArea(polygon);
  if (polygon.length === 0) return [NaN, NaN];
  if (Math.abs(a) < 1e-12) {
    const sx = polygon.reduce((s, p) => s + p[0], 0);
    const sy = polygon.reduce((s, p) => s + p[1], 0);
    return [sx / polygon.length, sy / polygon.length];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    const f = xj * yi - xi * yj;
    cx += (xj + xi) * f;
    cy += (yj + yi) * f;
  }
  return [cx / (6 * a), cy / (6 * a)];
}

/** Drop consecutive points closer than `minDist` (freehand lasso sampling). Keeps first and last. */
export function simplifyByDistance(points: readonly Vec2[], minDist: number): Mutable2[] {
  const out: Mutable2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || distance(last, p) >= minDist) out.push([p[0], p[1]]);
  }
  const tail = points[points.length - 1];
  const lastOut = out[out.length - 1];
  if (tail && lastOut && (lastOut[0] !== tail[0] || lastOut[1] !== tail[1])) out.push([tail[0], tail[1]]);
  return out;
}
