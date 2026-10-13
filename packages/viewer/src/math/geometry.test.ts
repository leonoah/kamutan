import { bboxOf, centroid, distance, pathLength, pointInPolygon, polygonArea, simplifyByDistance } from "./geometry";
import { anchorOf, lassoPick } from "./lasso";
import type { OverlayFeature } from "../types";

const square = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
] as const;

describe("pointInPolygon (lasso hit-testing)", () => {
  it("inside / outside a square", () => {
    expect(pointInPolygon([5, 5], square)).toBe(true);
    expect(pointInPolygon([15, 5], square)).toBe(false);
    expect(pointInPolygon([-0.01, 5], square)).toBe(false);
  });
  it("works for closed rings and either orientation", () => {
    const closedCcw = [...square, square[0]].reverse();
    expect(pointInPolygon([5, 5], closedCcw)).toBe(true);
    expect(pointInPolygon([11, 11], closedCcw)).toBe(false);
  });
  it("handles concave (U-shaped) freehand lassos", () => {
    // U shape: the notch (4..6, 3..10) is outside.
    const u = [
      [0, 0],
      [10, 0],
      [10, 10],
      [6, 10],
      [6, 3],
      [4, 3],
      [4, 10],
      [0, 10],
    ] as const;
    expect(pointInPolygon([5, 8], u)).toBe(false);
    expect(pointInPolygon([5, 1], u)).toBe(true);
    expect(pointInPolygon([2, 8], u)).toBe(true);
    expect(pointInPolygon([8, 8], u)).toBe(true);
  });
  it("self-intersecting bow-tie uses even-odd", () => {
    const bow = [
      [0, 0],
      [10, 10],
      [10, 0],
      [0, 10],
    ] as const;
    expect(pointInPolygon([2, 5], bow)).toBe(true);
    expect(pointInPolygon([5, 2], bow)).toBe(false);
  });
  it("degenerate polygons contain nothing", () => {
    expect(pointInPolygon([0, 0], [])).toBe(false);
    expect(pointInPolygon([1, 1], [[0, 0], [2, 2]])).toBe(false);
  });
});

describe("geometry helpers", () => {
  it("area, centroid, bbox, lengths", () => {
    expect(polygonArea(square)).toBe(100);
    expect(centroid(square)).toEqual([5, 5]);
    expect(centroid([[0, 0], [4, 0], [0, 0]])).toEqual([4 / 3, 0]); // degenerate → vertex mean
    expect(bboxOf(square)).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    expect(distance([0, 0], [3, 4])).toBe(5);
    expect(pathLength([[0, 0], [3, 4], [3, 10]])).toBe(11);
  });
  it("simplifyByDistance keeps endpoints", () => {
    const s = simplifyByDistance([[0, 0], [0.1, 0], [0.2, 0], [5, 0], [5.05, 0]], 1);
    expect(s).toEqual([[0, 0], [5, 0], [5.05, 0]]);
  });
});

describe("lassoPick", () => {
  const features: OverlayFeature[] = [
    { id: "p-in", kind: "point", position: [2, 2] },
    { id: "p-out", kind: "point", position: [20, 2] },
    { id: "room", kind: "polygon", polygon: [[1, 1], [5, 1], [5, 5], [1, 5]] }, // centroid (3,3) inside
    { id: "room-out", kind: "polygon", polygon: [[8, 8], [30, 8], [30, 30], [8, 30]] }, // centroid (19,19) outside
    { id: "arc", kind: "path", path: [[0, 0], [4, 4], [40, 40]] }, // middle vertex (4,4) inside
    { id: "region", kind: "polygon", polygon: [[0, 0], [1, 0], [1, 1]], passive: true },
  ];
  it("returns ids whose anchor is inside, skipping passive features", () => {
    expect(lassoPick(features, square)).toEqual(["p-in", "room", "arc"]);
  });
  it("needs at least 3 vertices", () => {
    expect(lassoPick(features, [[0, 0], [10, 10]])).toEqual([]);
  });
  it("anchors", () => {
    expect(anchorOf({ id: "x", kind: "path", path: [[0, 0], [2, 2]] })).toEqual([1, 1]);
  });
  it("is fast enough for 20k markers", () => {
    const many: OverlayFeature[] = Array.from({ length: 20_000 }, (_, i) => ({
      id: `m${i}`,
      kind: "point",
      position: [(i % 200) * 2, Math.floor(i / 200) * 3],
    }));
    const t0 = performance.now();
    const ids = lassoPick(many, [[0, 0], [100, 0], [100, 100], [0, 100]]);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(ids.length).toBeGreaterThan(0);
  });
});
