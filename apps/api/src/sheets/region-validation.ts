import { polygonSelfIntersects, polygonSignedArea, type PageGeometry, type Region } from '@kamutan/contracts';
import type { ApiIssue } from '../common/api-exception';

/** Tolerance for points on the page edge (mm). */
const EDGE_TOLERANCE_MM = 0.5;
/** Regions smaller than this are almost certainly mis-clicks (mm²). */
const MIN_AREA_MM2 = 1;

/**
 * Server-side region checks against the page geometry (structure — ≤ 8 regions, 3..256 finite points,
 * unique ids — is enforced by the contract schema): every vertex inside the page, polygon simple
 * (no self-intersection / duplicate vertices) and with a non-trivial area.
 */
export function validateRegions(regions: readonly Region[], page: PageGeometry): ApiIssue[] {
  const issues: ApiIssue[] = [];
  regions.forEach((r, i) => {
    const out = r.polygonMm.findIndex(
      (p) => p.x < -EDGE_TOLERANCE_MM || p.y < -EDGE_TOLERANCE_MM || p.x > page.widthMm + EDGE_TOLERANCE_MM || p.y > page.heightMm + EDGE_TOLERANCE_MM,
    );
    if (out >= 0) {
      issues.push({ path: `regions.${i}.polygonMm.${out}`, message: `point outside the page (${page.widthMm}x${page.heightMm} mm)` });
      return;
    }
    if (polygonSelfIntersects(r.polygonMm)) {
      issues.push({ path: `regions.${i}.polygonMm`, message: 'polygon must not self-intersect' });
      return;
    }
    if (Math.abs(polygonSignedArea(r.polygonMm)) < MIN_AREA_MM2) {
      issues.push({ path: `regions.${i}.polygonMm`, message: 'polygon area is too small' });
    }
  });
  return issues;
}
