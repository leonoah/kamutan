import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { DrawingViewer, type DrawingViewerHandle } from "./DrawingViewer";
import type { OverlayFeature, ViewInfo } from "./types";
import { mmToScreen, pxPerMm } from "./math/coords";

// jsdom has no WebGL: stub deck's React wrapper and force the WebGL check.
const deckProps: { current: Record<string, unknown> | null } = { current: null };
vi.mock("@deck.gl/react", () => ({
  default: (p: Record<string, unknown>) => {
    deckProps.current = p;
    return <div data-testid="deck" />;
  },
}));
vi.mock("./webgl", () => ({ canUseWebGL: () => true }));

const BOX = { width: 800, height: 600 };
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => BOX.width });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => BOX.height });
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
});

const SHEET = { widthMm: 420, heightMm: 297 };
const tiles = { tileSize: 256, dpi: 300, levels: 6, widthPx: 4961, heightPx: 3508, tileUrl: (z: number, x: number, y: number) => `/t/${z}/${x}_${y}.webp` };

function setup(extra: Partial<Parameters<typeof DrawingViewer>[0]> = {}) {
  const ref = createRef<DrawingViewerHandle>();
  const views: ViewInfo[] = [];
  const utils = render(
    <div style={{ width: 800, height: 600 }}>
      <DrawingViewer ref={ref} sheet={SHEET} tiles={tiles} ariaLabel="שרטוט" onViewChange={(v) => views.push(v)} {...extra} />
    </div>,
  );
  const app = screen.getByRole("application", { name: "שרטוט" });
  /** client coords of a paper-mm point under the current view */
  const at = (mm: [number, number]) => {
    const vs = deckProps.current!.viewState as { target: [number, number, number]; zoom: number };
    const [x, y] = mmToScreen(mm, vs, BOX, 300);
    return { clientX: x, clientY: y };
  };
  const click = (mm: [number, number]) => {
    const p = at(mm);
    fireEvent.pointerDown(app, { ...p, button: 0, pointerId: 1 });
    fireEvent.pointerUp(app, { ...p, button: 0, pointerId: 1 });
  };
  return { ...utils, ref, views, app, at, click };
}

describe("DrawingViewer", () => {
  it("is an LTR application region and fits the sheet on mount", () => {
    const { app, views } = setup();
    expect(app).toHaveAttribute("dir", "ltr");
    const vs = deckProps.current!.viewState as { target: number[]; zoom: number };
    expect(vs.target.slice(0, 2)).toEqual([4961 / 2, 3508 / 2]);
    const last = views.at(-1)!;
    expect(last.visibleMm[0]).toBeLessThanOrEqual(0);
    expect(last.visibleMm[2]).toBeGreaterThanOrEqual(420);
    // layers: page underlay + tiles
    const ids = (deckProps.current!.layers as { id: string }[]).map((l) => l.id);
    expect(ids[0]).toBe("page");
    expect(ids.some((i) => i.startsWith("tiles-"))).toBe(true);
  });

  it("keyboard: + / - zoom by one step, 0 fits, 1 = 100% (event.code, layout-independent)", () => {
    const { app, views } = setup();
    const fit = views.at(-1)!.zoom;
    fireEvent.keyDown(app, { code: "Equal", key: "ז" }); // Hebrew layout still works
    expect(views.at(-1)!.zoom).toBeCloseTo(fit + 1);
    fireEvent.keyDown(app, { code: "NumpadSubtract" });
    fireEvent.keyDown(app, { code: "Minus" });
    expect(views.at(-1)!.zoom).toBeCloseTo(fit - 1);
    fireEvent.keyDown(app, { code: "Digit1" });
    expect(views.at(-1)!.percent).toBeCloseTo(100);
    fireEvent.keyDown(app, { code: "Digit0" });
    expect(views.at(-1)!.zoom).toBeCloseTo(fit);
  });

  it("imperative zoomToMm frames a paper-mm box (e.g. the legend)", () => {
    const { ref, views } = setup();
    act(() => ref.current!.zoomToMm([12, 197, 103, 250], 0));
    const v = views.at(-1)!.visibleMm;
    expect(v[0]).toBeLessThanOrEqual(12.01);
    expect(v[2]).toBeGreaterThanOrEqual(102.99);
    expect((v[0] + v[2]) / 2).toBeCloseTo(57.5);
  });

  it("measure: two clicks → paper and real length at the sheet scale", () => {
    const onMeasure = vi.fn();
    const { click } = setup({ tool: "measure", scaleDenominator: 50, onMeasure });
    click([100, 100]);
    click([186, 100]);
    expect(onMeasure).toHaveBeenCalledTimes(1);
    const r = onMeasure.mock.calls[0]![0];
    expect(r.paperMm).toBeCloseTo(86, 0);
    expect(r.realMm).toBeCloseTo(4300, -1);
    expect(screen.getByText(/מ״א/)).toBeInTheDocument();
  });

  it("calibrate: two clicks + real length → snapped scale denominator", () => {
    const onCalibrate = vi.fn();
    const { click } = setup({ tool: "calibrate", onCalibrate });
    expect(screen.getByRole("status")).toHaveTextContent("כיול קנה מידה");
    click([50, 50]);
    click([90, 50]); // 40 mm on paper
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "198" } }); // 1:49.5
    expect(screen.getByText(/קרוב ל-/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "החל" }));
    expect(onCalibrate).toHaveBeenCalledTimes(1);
    expect(onCalibrate.mock.calls[0]![0].denominator).toBe(50);
    expect(onCalibrate.mock.calls[0]![0].measured).toBeCloseTo(49.5, 0);
  });

  it("lasso (click-polygon): Enter closes and returns picked ids + polygon in mm", () => {
    const overlays: OverlayFeature[] = [
      { id: "a", kind: "point", position: [60, 60] },
      { id: "b", kind: "point", position: [200, 200] },
      { id: "region", kind: "polygon", polygon: [[55, 55], [65, 55], [65, 65]], passive: true },
    ];
    const onLasso = vi.fn();
    const { click, app } = setup({ tool: "lasso", overlays, onLasso });
    click([50, 50]);
    click([120, 50]);
    click([120, 120]);
    click([50, 120]);
    fireEvent.keyDown(app, { code: "Enter" });
    expect(onLasso).toHaveBeenCalledTimes(1);
    const r = onLasso.mock.calls[0]![0];
    expect(r.ids).toEqual(["a"]);
    expect(r.polygonMm).toHaveLength(4);
    expect(r.polygonMm[1][0]).toBeCloseTo(120, 0);
  });

  it("lasso (freehand drag) and Escape returns to the select tool", () => {
    const overlays: OverlayFeature[] = [{ id: "a", kind: "point", position: [60, 60] }];
    const onLasso = vi.fn();
    const onToolChange = vi.fn();
    const { app, at } = setup({ tool: "lasso", overlays, onLasso, onToolChange });
    const path: [number, number][] = [[40, 40], [100, 40], [100, 100], [40, 100], [41, 45]];
    fireEvent.pointerDown(app, { ...at(path[0]!), button: 0, pointerId: 1 });
    for (const p of path.slice(1)) fireEvent.pointerMove(app, { ...at(p), pointerId: 1 });
    fireEvent.pointerUp(app, { ...at(path.at(-1)!), button: 0, pointerId: 1 });
    expect(onLasso.mock.calls[0]![0].ids).toEqual(["a"]);
    fireEvent.keyDown(app, { code: "Escape" });
    expect(onToolChange).toHaveBeenCalledWith("select");
  });

  it("selection highlight: picking a feature calls onSelect, shift adds", () => {
    const onSelect = vi.fn();
    setup({ overlays: [{ id: "a", kind: "point", position: [1, 1] }], onSelect });
    const onClick = deckProps.current!.onClick as (i: unknown, e: unknown) => void;
    onClick({ object: { id: "a", kind: "point" } }, { srcEvent: { shiftKey: true } });
    expect(onSelect).toHaveBeenLastCalledWith(["a"], { additive: true });
    onClick({ object: undefined }, { srcEvent: {} });
    expect(onSelect).toHaveBeenLastCalledWith([], { additive: false });
  });

  it("minimap shows the viewport and recentres on click", async () => {
    setup();
    await screen.findByRole("img", { name: "מיני-מפה" });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId("viewer-minimap")).toBeInTheDocument();
    const img = screen.getByRole("img", { name: "מיני-מפה" });
    expect(img.querySelector("img")?.getAttribute("src")).toBe("/t/0/0_0.webp");
    fireEvent.pointerDown(img, { clientX: 10, clientY: 65, pointerId: 2 });
    const vs = deckProps.current!.viewState as { target: number[] };
    expect(vs.target[0]).toBeLessThan(4961 / 2);
  });

  it("resolves async tile URLs (batched signed URLs) for tiles and the minimap", async () => {
    const tileUrl = vi.fn(async (z: number, x: number, y: number) => `https://signed/${z}/${x}_${y}?sig=1`);
    render(
      <div>
        <DrawingViewer sheet={SHEET} tiles={{ ...tiles, tileUrl }} ariaLabel="שרטוט" />
      </div>,
    );
    const img = await screen.findByRole("img", { name: "מיני-מפה" });
    await vi.waitFor(() => expect(img.querySelector("img")?.getAttribute("src")).toBe("https://signed/0/0_0?sig=1"));
    const layer = (deckProps.current!.layers as { id: string; props: { getTileData: (t: unknown) => Promise<unknown> } }[]).find((l) =>
      l.id.startsWith("tiles-"),
    )!;
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(layer.props.getTileData({ index: { x: 3, y: 2, z: -1 } })).resolves.toBeNull();
    expect(tileUrl).toHaveBeenCalledWith(4, 3, 2, undefined);
    expect(fetchMock).toHaveBeenCalledWith("https://signed/4/3_2?sig=1", undefined);
    vi.unstubAllGlobals();
  });

  it("converts mm overlays to world px by dpi", () => {
    setup({ overlays: [{ id: "a", kind: "point", position: [25.4, 0] }] });
    const pts = (deckProps.current!.layers as { id: string; props: { getPosition: (f: unknown) => number[]; data: unknown[] } }[]).find(
      (l) => l.id === "points",
    )!;
    expect(pts.props.getPosition(pts.props.data[0])).toEqual([300, 0]);
    expect(pxPerMm(300) * 25.4).toBeCloseTo(300);
  });
});
