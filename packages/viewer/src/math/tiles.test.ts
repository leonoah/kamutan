import { deckZoomForLevel, levelForDeckZoom, levelGrid, levelSize, levelsFor, tileCount, tileWorldBounds, type TilePyramid } from "./tiles";
import { clampZoom, fitBBox, fitZoom, minimapTransform, panBy, visibleWorldRect, zoomAround, zoomLimits } from "./view";

const a3: TilePyramid = { tileSize: 256, dpi: 300, levels: 6, widthPx: 4963, heightPx: 3509 };

describe("tile pyramid", () => {
  it("levels: z=0 fits one tile", () => {
    expect(levelsFor(4963, 3509)).toBe(6);
    expect(levelsFor(256, 100)).toBe(1);
    expect(levelsFor(257, 100)).toBe(2);
    // A0 @300dpi = 14043×9933 px → 7 levels
    expect(levelsFor(14043, 9933)).toBe(7);
    expect(levelSize(a3, 0)[0]).toBeLessThanOrEqual(256);
  });
  it("grid per level (matches make_dev_tiles.py: 379 tiles for A3 @300dpi)", () => {
    expect(levelGrid(a3, 5)).toEqual([20, 14]);
    expect(levelGrid(a3, 0)).toEqual([1, 1]);
    expect(tileCount(a3)).toBe(379);
  });
  it("deck zoom ⇄ level", () => {
    expect(deckZoomForLevel(a3, 5)).toBe(0);
    expect(deckZoomForLevel(a3, 0)).toBe(-5);
    expect(levelForDeckZoom(a3, -2)).toBe(3);
  });
  it("tile bounds in world px, edge tiles sized from the decoded image", () => {
    expect(tileWorldBounds(a3, 5, 0, 0, 256, 256)).toEqual([0, 0, 256, 256]);
    expect(tileWorldBounds(a3, 4, 1, 1, 256, 256)).toEqual([512, 512, 1024, 1024]);
    // last column at max level: 4963 - 19*256 = 99 px wide
    expect(tileWorldBounds(a3, 5, 19, 0, 99, 256)).toEqual([4864, 0, 4963, 256]);
    // padded edge tile (256 wide) is clipped to the sheet
    expect(tileWorldBounds(a3, 5, 19, 0, 256, 256)[2]).toBe(4963);
  });
});

describe("view math", () => {
  const box = { width: 1000, height: 700 };
  it("fit-to-sheet", () => {
    const z = fitZoom(box, 4963, 3509, 0);
    // height-bound: 700/3509 < 1000/4963
    expect(2 ** z * 3509).toBeCloseTo(700);
    expect(2 ** z * 4963).toBeLessThanOrEqual(1000);
    const l = zoomLimits(box, 4963, 3509, 300);
    const v = fitBBox(box, { minX: 0, minY: 0, maxX: 4963, maxY: 3509 }, l);
    expect(v.target).toEqual([4963 / 2, 3509 / 2, 0]);
    const r = visibleWorldRect(v, box);
    expect(r.minX).toBeLessThanOrEqual(0);
    expect(r.maxX).toBeGreaterThanOrEqual(4963);
  });
  it("zoomAround keeps the anchor fixed", () => {
    const l = { minZoom: -10, maxZoom: 5 };
    const v = { target: [500, 500, 0] as [number, number, number], zoom: -2, ...l };
    const z = zoomAround(v, 1, [100, 100], box);
    expect(z.zoom).toBe(-1);
    // world point under (100,100) is unchanged
    const before = visibleWorldRect(v, box);
    const after = visibleWorldRect(z, box);
    const wBefore = before.minX + 100 / 2 ** -2;
    const wAfter = after.minX + 100 / 2 ** -1;
    expect(wAfter).toBeCloseTo(wBefore);
  });
  it("clamps zoom and pans in screen px", () => {
    expect(clampZoom(10, { minZoom: -3, maxZoom: 3 })).toBe(3);
    const v = panBy({ target: [0, 0, 0], zoom: 1, minZoom: -5, maxZoom: 5 }, 100, -50);
    expect(v.target).toEqual([50, -25, 0]);
  });
  it("minimap letterboxes the sheet", () => {
    const t = minimapTransform({ width: 180, height: 130 }, 4963, 3509);
    const [x, y] = t.toMini([4963, 3509]);
    expect(x).toBeCloseTo(180 - t.offset[0]);
    expect(y).toBeLessThanOrEqual(130);
    const w = t.toWorld(t.toMini([1000, 2000]));
    expect(w[0]).toBeCloseTo(1000);
    expect(w[1]).toBeCloseTo(2000);
  });
});
