import type { OverlayFeature } from "../types";
import type { Mutable2, Vec2 } from "./coords";
import { bboxContains, bboxOf, centroid, pointInPolygon } from "./geometry";

/**
 * Representative point used for lasso hit-testing:
 * point → its position; polygon → area centroid; path → middle vertex (or midpoint of a 2-point path).
 */
export function anchorOf(f: OverlayFeature): Mutable2 {
  switch (f.kind) {
    case "point":
    case "marker":
      return [f.position[0], f.position[1]];
    case "polygon":
      return centroid(f.polygon);
    case "path": {
      const n = f.path.length;
      if (n === 0) return [NaN, NaN];
      if (n % 2 === 0) {
        const a = f.path[n / 2 - 1]!;
        const b = f.path[n / 2]!;
        return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      }
      const m = f.path[(n - 1) / 2]!;
      return [m[0], m[1]];
    }
  }
}

/** Ids of the (non-passive) features whose anchor lies inside the lasso polygon (paper mm). */
export function lassoPick(features: readonly OverlayFeature[], lasso: readonly Vec2[]): string[] {
  if (lasso.length < 3) return [];
  const box = bboxOf(lasso);
  const out: string[] = [];
  for (const f of features) {
    if (f.passive) continue;
    const a = anchorOf(f);
    if (bboxContains(box, a) && pointInPolygon(a, lasso)) out.push(f.id);
  }
  return out;
}
