import {
  MM_PER_INCH,
  mmToPx,
  mmToScreen,
  percentToZoom,
  pointMmToPx,
  pointPxToMm,
  pxToMm,
  screenToMm,
  screenToWorld,
  sheetSizePx,
  worldToScreen,
  zoomToPercent,
} from "./coords";

describe("mm ↔ px", () => {
  it("converts by dpi (25.4 mm per inch)", () => {
    expect(mmToPx(25.4, 300)).toBeCloseTo(300);
    expect(pxToMm(300, 300)).toBeCloseTo(MM_PER_INCH);
    expect(mmToPx(420, 300)).toBeCloseTo(4960.63, 2);
  });
  it("round-trips points", () => {
    const p = pointPxToMm(pointMmToPx([123.4, 56.7], 300), 300);
    expect(p[0]).toBeCloseTo(123.4, 9);
    expect(p[1]).toBeCloseTo(56.7, 9);
  });
  it("A3 landscape at 300 dpi ≈ 4961×3508 px (pdfium rounding: nearest)", () => {
    expect(sheetSizePx(420, 297, 300)).toEqual([4961, 3508]);
  });
});

describe("screen ↔ world (ortho, flipY → y down)", () => {
  const box = { width: 800, height: 600 };
  it("maps the box centre to the target", () => {
    const v = { target: [1000, 2000, 0] as [number, number, number], zoom: -2 };
    expect(screenToWorld([400, 300], v, box)).toEqual([1000, 2000]);
  });
  it("one screen px = 2^-zoom world px, y grows downward", () => {
    const v = { target: [0, 0, 0] as [number, number, number], zoom: -1 };
    expect(screenToWorld([401, 301], v, box)).toEqual([2, 2]);
  });
  it("worldToScreen is the inverse", () => {
    const v = { target: [512.5, -40, 0] as [number, number, number], zoom: 1.37 };
    const s = worldToScreen(screenToWorld([17, 589], v, box), v, box);
    expect(s[0]).toBeCloseTo(17, 9);
    expect(s[1]).toBeCloseTo(589, 9);
  });
  it("screen ↔ mm composes with dpi", () => {
    const v = { target: [0, 0, 0] as [number, number, number], zoom: 0 };
    const mm = screenToMm([400 + 300, 300], v, box, 300); // 300 world px right of centre
    expect(mm[0]).toBeCloseTo(25.4);
    const back = mmToScreen(mm, v, box, 300);
    expect(back[0]).toBeCloseTo(700);
  });
});

describe("zoom percent (100% = physical paper size at 96 css dpi)", () => {
  it("is 100% at zoom log2(96/dpi)", () => {
    expect(zoomToPercent(Math.log2(96 / 300), 300)).toBeCloseTo(100);
    expect(percentToZoom(100, 300)).toBeCloseTo(Math.log2(96 / 300));
    expect(zoomToPercent(percentToZoom(250, 150), 150)).toBeCloseTo(250);
  });
});
