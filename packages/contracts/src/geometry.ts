/**
 * Small, dependency-free geometry helpers shared by the API (server-side
 * validation) and the web (client-side feedback). Coordinates are paper
 * millimetres, origin top-left, y down.
 */

/** Point in paper mm. An object (not a tuple) because Firestore cannot store nested arrays. */
export interface PointMm {
  readonly x: number;
  readonly y: number;
}

/** Signed shoelace area (mm²). Sign depends on winding; use Math.abs for size. */
export function polygonSignedArea(points: readonly PointMm[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as PointMm;
    const q = points[(i + 1) % points.length] as PointMm;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

const EPS = 1e-9;

function orient(a: PointMm, b: PointMm, c: PointMm): number {
  const v = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return Math.abs(v) < EPS ? 0 : v > 0 ? 1 : -1;
}

function onSegment(a: PointMm, b: PointMm, p: PointMm): boolean {
  return (
    Math.min(a.x, b.x) - EPS <= p.x &&
    p.x <= Math.max(a.x, b.x) + EPS &&
    Math.min(a.y, b.y) - EPS <= p.y &&
    p.y <= Math.max(a.y, b.y) + EPS
  );
}

/** Closed-segment intersection test (touching counts). */
export function segmentsIntersect(p1: PointMm, p2: PointMm, q1: PointMm, q2: PointMm): boolean {
  const o1 = orient(p1, p2, q1);
  const o2 = orient(p1, p2, q2);
  const o3 = orient(q1, q2, p1);
  const o4 = orient(q1, q2, p2);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, p2, q2)) return true;
  if (o3 === 0 && onSegment(q1, q2, p1)) return true;
  if (o4 === 0 && onSegment(q1, q2, p2)) return true;
  return false;
}

/**
 * True when a closed polygon (implicitly closed: last → first) is not simple:
 * any two non-adjacent edges touch/cross, adjacent edges fold back onto each
 * other, or a vertex repeats. O(n²) — fine for the ≤256 vertices we accept.
 */
export function polygonSelfIntersects(points: readonly PointMm[]): boolean {
  const n = points.length;
  if (n < 3) return true;
  for (let i = 0; i < n; i++) {
    const a = points[i] as PointMm;
    for (let j = i + 1; j < n; j++) {
      const b = points[j] as PointMm;
      if (Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS) return true; // duplicate vertex
    }
  }
  for (let i = 0; i < n; i++) {
    const a1 = points[i] as PointMm;
    const a2 = points[(i + 1) % n] as PointMm;
    for (let j = i + 1; j < n; j++) {
      const b1 = points[j] as PointMm;
      const b2 = points[(j + 1) % n] as PointMm;
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      if (adjacent) {
        // Adjacent edges share exactly one vertex; they must not overlap (fold back).
        const shared = j === i + 1 ? a2 : a1;
        const other1 = j === i + 1 ? a1 : a2;
        const other2 = j === i + 1 ? b2 : b1;
        if (orient(other1, shared, other2) === 0) {
          // Collinear: overlapping if the far ends are on the same side of the shared vertex.
          const dot = (other1.x - shared.x) * (other2.x - shared.x) + (other1.y - shared.y) * (other2.y - shared.y);
          if (dot > 0) return true;
        }
        continue;
      }
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

/** Tile pyramid geometry (shared by worker, API and viewer). */
export interface TileLevel {
  z: number;
  widthPx: number;
  heightPx: number;
  cols: number;
  rows: number;
  /** Paper millimetres per pixel at this level. */
  mmPerPx: number;
}

/**
 * Level z (0 = most zoomed out, `levels - 1` = full resolution at `dpi`) has
 * size ceil(widthPx / 2^(levels-1-z)) × ceil(heightPx / 2^(levels-1-z)) and is
 * cut into ceil(size / tileSize) columns/rows; tile (x, y) covers pixels
 * [x*tileSize, (x+1)*tileSize) of that level (edge tiles are smaller).
 */
export function tileLevels(meta: { widthPx: number; heightPx: number; tileSize: number; levels: number; dpi: number }): TileLevel[] {
  const out: TileLevel[] = [];
  for (let z = 0; z < meta.levels; z++) {
    const f = 2 ** (meta.levels - 1 - z);
    const widthPx = Math.max(1, Math.ceil(meta.widthPx / f));
    const heightPx = Math.max(1, Math.ceil(meta.heightPx / f));
    out.push({
      z,
      widthPx,
      heightPx,
      cols: Math.ceil(widthPx / meta.tileSize),
      rows: Math.ceil(heightPx / meta.tileSize),
      mmPerPx: (25.4 / meta.dpi) * f,
    });
  }
  return out;
}

/** Number of levels so that level 0 fits in a single tile. */
export function levelsFor(widthPx: number, heightPx: number, tileSize: number): number {
  let levels = 1;
  while (Math.ceil(Math.max(widthPx, heightPx) / 2 ** (levels - 1)) > tileSize) levels++;
  return levels;
}
