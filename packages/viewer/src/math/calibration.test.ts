import { calibrate, formatScale, realLengthMm, scaleDenominatorFrom, suggestStandardScale } from "./calibration";

describe("scale calibration (2 clicks + real length)", () => {
  it("denominator = real / paper", () => {
    expect(scaleDenominatorFrom(40, 2000)).toBe(50); // 40 mm on paper = 200 cm → 1:50
    expect(() => scaleDenominatorFrom(0, 2000)).toThrow(RangeError);
    expect(() => scaleDenominatorFrom(10, -1)).toThrow(RangeError);
  });
  it("suggests the nearest standard scale within tolerance (spec: '1:49.6 — קרוב ל-1:50')", () => {
    const s = suggestStandardScale(49.6);
    expect(s.nearest).toBe(50);
    expect(s.snap).toBe(true);
    expect(s.relError).toBeCloseTo(0.008, 3);
    expect(suggestStandardScale(37).snap).toBe(false);
    expect(suggestStandardScale(98).nearest).toBe(100);
  });
  it("calibrate() from two paper points", () => {
    const r = calibrate([10, 10], [10 + 24, 10 + 32], 2000); // 40 mm apart, 200 cm real
    expect(r.paperMm).toBeCloseTo(40);
    expect(r.measured).toBeCloseTo(50);
    expect(r.denominator).toBe(50);
    const off = calibrate([0, 0], [40, 0], 1480); // 1:37 → no snap, keep 0.1 precision
    expect(off.snap).toBe(false);
    expect(off.denominator).toBe(37);
    const near = calibrate([0, 0], [40.32, 0], 2000); // 1:49.6 → snaps to 50
    expect(near.denominator).toBe(50);
  });
  it("real length from paper length", () => {
    expect(realLengthMm(86, 50)).toBe(4300); // 4.30 מ"א
  });
  it("formats 1:n in LTR form", () => {
    expect(formatScale(50)).toBe("1:50");
    expect(formatScale(49.63)).toBe("1:49.6");
  });
});
