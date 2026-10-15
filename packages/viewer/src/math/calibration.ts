import type { Vec2 } from "./coords";
import { distance } from "./geometry";

/** Common architectural/engineering scales (1:n). */
export const STANDARD_SCALES = [1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 200, 250, 500, 1000, 1250, 2000, 2500, 5000] as const;

/**
 * Scale denominator from a calibration: the user clicked two points `paperMm` apart on the sheet
 * and says the real length between them is `realMm`. 1:n with n = real / paper.
 */
export function scaleDenominatorFrom(paperMm: number, realMm: number): number {
  if (!(paperMm > 0) || !(realMm > 0) || !Number.isFinite(paperMm) || !Number.isFinite(realMm)) {
    throw new RangeError("calibration lengths must be positive finite numbers");
  }
  return realMm / paperMm;
}

export interface ScaleSuggestion {
  /** Raw measured denominator (e.g. 49.6). */
  measured: number;
  /** Nearest standard scale (e.g. 50). */
  nearest: number;
  /** |measured − nearest| / nearest. */
  relError: number;
  /** True when the nearest standard scale is within `tolerance` → offer "use 1:50?". */
  snap: boolean;
}

export function suggestStandardScale(measured: number, tolerance = 0.03): ScaleSuggestion {
  let nearest: number = STANDARD_SCALES[0];
  for (const s of STANDARD_SCALES) {
    if (Math.abs(Math.log(s / measured)) < Math.abs(Math.log(nearest / measured))) nearest = s;
  }
  const relError = Math.abs(measured - nearest) / nearest;
  return { measured, nearest, relError, snap: relError <= tolerance };
}

export interface CalibrationResult extends ScaleSuggestion {
  a: [number, number];
  b: [number, number];
  paperMm: number;
  realMm: number;
  /** The denominator to store: the snapped standard scale if `snap`, else the measured value rounded to 0.1. */
  denominator: number;
}

/** Full 2-click calibration: points in paper mm + the real length in mm. */
export function calibrate(a: Vec2, b: Vec2, realMm: number, tolerance = 0.03): CalibrationResult {
  const paperMm = distance(a, b);
  const measured = scaleDenominatorFrom(paperMm, realMm);
  const s = suggestStandardScale(measured, tolerance);
  return {
    ...s,
    a: [a[0], a[1]],
    b: [b[0], b[1]],
    paperMm,
    realMm,
    denominator: s.snap ? s.nearest : Math.round(measured * 10) / 10,
  };
}

/** Real-world length (mm) of a paper distance at 1:denominator. */
export const realLengthMm = (paperMm: number, denominator: number): number => paperMm * denominator;

/** Format "1:50" / "1:49.6". */
export const formatScale = (denominator: number): string =>
  `1:${Number.isInteger(denominator) ? denominator : denominator.toFixed(1)}`;
