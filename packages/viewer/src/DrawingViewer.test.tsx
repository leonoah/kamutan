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

type AnyLayer = { id: string; props: Record<string, unknown> & { data: unknown[] } };
const layersOf = () => deckProps.current!.layers as AnyLayer[];
const layer = (id: string) => layersOf().find((l) => l.id === id);

function makeMarkers(n: number): OverlayFeature[] {
  const shapes = ["circle", "triangle", "diamond", "diamond-open"] as const;
  return Array.from({ length: n }, (_, i) => ({
    id: `d_${i}`,
    kind: "marker" as const,
    position: [10 + (i % 50) * 8, 10 + Math.floor(i / 50) * 7] as [number, number],
    sizeMm: 5,
    shape: shapes[i % 4]!,
    color: [27, 127, 90, 255] as [number, number, number, number],
    dashed: i % 7 === 0,
    strike: i % 11 === 0,
  }));
}

describe("DrawingViewer overlay layers (Sprint 2)", () => {
  it("draws detections as GPU icon markers sized in paper mm (scale with zoom) with a pixel minimum", () => {
    setup({ overlays: makeMarkers(4) });
    const m = layer("markers")!;
    expect(m).toBeDefined();
    expect(m.props.sizeUnits).toBe("common");
    expect(m.props.sizeMinPixels).toBeGreaterThan(0);
    const getSize = m.props.getSize as (f: unknown) => number;
    // 5 mm at 300 dpi = 59.05 world px (× 1.25 frame margin)
    expect(getSize(m.props.data[0])).toBeCloseTo(5 * pxPerMm(300) * 1.25, 3);
    const getIcon = m.props.getIcon as (f: unknown) => string;
    expect(m.props.data.map((f) => getIcon(f))).toEqual(["circle-d-x", "triangle", "diamond", "diamond-open"]);
    const mapping = m.props.iconMapping as Record<string, { mask: boolean }>;
    expect(Object.keys(mapping)).toHaveLength(16);
    expect(mapping["diamond-open-d-x"]!.mask).toBe(true);
    expect(m.props.pickable).toBe(true);
  });

  it("2,000 markers: layers build fast, and selection/focus changes reuse the same geometry data", () => {
    const overlays = makeMarkers(2000);
    const t0 = performance.now();
    const { rerender } = setup({ overlays });
    const buildMs = performance.now() - t0;
    const first = layer("markers")!;
    expect(first.props.data).toHaveLength(2000);
    expect(buildMs).toBeLessThan(1500); // jsdom incl. React mount; the GPU side is measured in Playwright
    const t1 = performance.now();
    for (let i = 0; i < 20; i++) {
      rerender(
        <div style={{ width: 800, height: 600 }}>
          <DrawingViewer sheet={SHEET} tiles={tiles} ariaLabel="שרטוט" overlays={overlays} selectedIds={[`d_${i}`]} focusIds={[`d_${i + 1}`]} />
        </div>,
      );
    }
    const perUpdate = (performance.now() - t1) / 20;
    expect(perUpdate).toBeLessThan(50);
    const after = layer("markers")!;
    // Same data array → deck.gl keeps the attribute buffers; only getColor is re-evaluated (updateTriggers).
    expect(after.props.data).toBe(first.props.data);
    expect((after.props.updateTriggers as { getColor: unknown[] }).getColor).toContainEqual(["d_19"]);
  });

  it("focus dims all other markers to 30% and halos the focused ones; dimmed lifecycle → 35%", () => {
    const overlays: OverlayFeature[] = [
      { id: "a", kind: "marker", position: [10, 10], shape: "circle", color: [0, 0, 0, 200] },
      { id: "b", kind: "marker", position: [20, 10], shape: "triangle", color: [0, 0, 0, 200] },
      { id: "c", kind: "marker", position: [30, 10], shape: "diamond", color: [0, 0, 0, 200], dimmed: true },
    ];
    const { rerender } = setup({ overlays });
    let m = layer("markers")!;
    let getColor = m.props.getColor as (f: unknown) => number[];
    expect(m.props.data.map((f) => getColor(f)[3])).toEqual([200, 200, 70]);
    rerender(
      <div>
        <DrawingViewer sheet={SHEET} tiles={tiles} ariaLabel="שרטוט" overlays={overlays} focusIds={["b"]} />
      </div>,
    );
    m = layer("markers")!;
    getColor = m.props.getColor as (f: unknown) => number[];
    expect(m.props.data.map((f) => getColor(f)[3])).toEqual([60, 200, 60]);
    expect(layer("marker-halo")!.props.data.map((f) => (f as { id: string }).id)).toEqual(["b"]);
  });

  it("rooms: translucent polygons with an RTL name chip + LTR-isolated area; dashed outlines via PathStyleExtension", () => {
    const overlays: OverlayFeature[] = [
      { id: "r_1", kind: "polygon", polygon: [[10, 10], [110, 10], [110, 80], [10, 80]], label: "סלון", labelLtr: "24.5", labelSuffix: "מ״ר", passive: true, dashed: true },
      { id: "lg0", kind: "polygon", polygon: [[200, 200], [260, 200], [260, 260], [200, 260]], passive: true },
    ];
    const { container } = setup({ overlays });
    const label = container.querySelector("[data-room-label]")!;
    expect(label).toHaveAttribute("dir", "rtl");
    expect(label.textContent).toContain("סלון");
    const bdi = label.querySelector("bdi")!;
    expect(bdi).toHaveAttribute("dir", "ltr");
    expect(bdi).toHaveTextContent(/^24\.5$/);
    expect(label.textContent).toContain("24.5 מ״ר");
    const poly = layer("passive-polygons")!;
    const dash = poly.props.getDashArray as (f: unknown) => number[];
    expect(poly.props.data.map((f) => dash(f))).toEqual([[6, 4], [0, 0]]);
    expect((poly.props.extensions as unknown[]).length).toBe(1);
  });

  it("switch↔luminaire arcs: dashed / dotted / solid paths (PathStyleExtension), passive arcs not pickable", () => {
    const overlays: OverlayFeature[] = [
      { id: "a1", kind: "path", path: [[10, 10], [60, 30]], dash: "dashed", widthPx: 2, color: [178, 107, 0, 235], passive: true },
      { id: "a2", kind: "path", path: [[60, 30], [90, 30]], dash: "dotted", widthPx: 2, passive: true },
      { id: "w1", kind: "path", path: [[0, 0], [5, 5]] },
    ];
    setup({ overlays });
    const passive = layer("passive-paths")!;
    const dash = passive.props.getDashArray as (f: unknown) => number[];
    expect(passive.props.data.map((f) => dash(f))).toEqual([[7, 4], [1.5, 3]]);
    expect(passive.props.pickable).toBe(false);
    expect((passive.props.getColor as (f: unknown) => number[])(passive.props.data[0])).toEqual([178, 107, 0, 235]);
    const pickable = layer("paths")!;
    expect((pickable.props.getDashArray as (f: unknown) => number[])(pickable.props.data[0])).toEqual([0, 0]);
  });

  it("hides small room labels below labelMinPx", () => {
    const overlays: OverlayFeature[] = [
      { id: "r_s", kind: "polygon", polygon: [[10, 10], [12, 10], [12, 12], [10, 12]], label: "שירותים", labelMinPx: 80, passive: true },
    ];
    const { container } = setup({ overlays });
    expect(container.querySelector("[data-room-label]")).toBeNull();
  });

  it("hover shows the RTL tooltip from renderTooltip; popover is anchored to a paper-mm point", () => {
    const overlays: OverlayFeature[] = [{ id: "a", kind: "marker", position: [50, 50], shape: "circle" }];
    const { rerender } = setup({ overlays, renderTooltip: (id) => <span>פריט {id}</span> });
    const onHover = deckProps.current!.onHover as (i: unknown) => void;
    act(() => onHover({ object: overlays[0], x: 100, y: 120 }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("פריט a");
    expect(screen.getByRole("tooltip")).toHaveAttribute("dir", "rtl");
    rerender(
      <div>
        <DrawingViewer sheet={SHEET} tiles={tiles} ariaLabel="שרטוט" overlays={overlays} popover={{ anchorMm: [50, 50], label: "פרטי פריט", content: <p>שקע כפול</p> }} />
      </div>,
    );
    const dlg = screen.getByRole("dialog", { name: "פרטי פריט" });
    expect(dlg).toHaveAttribute("dir", "rtl");
    expect(dlg).toHaveTextContent("שקע כפול");
  });

  it("lasso picks markers too", () => {
    const overlays: OverlayFeature[] = [
      { id: "m1", kind: "marker", position: [100, 60], shape: "triangle" },
      { id: "m2", kind: "marker", position: [300, 200], shape: "diamond" },
    ];
    const onLasso = vi.fn();
    const { click, app } = setup({ tool: "lasso", overlays, onLasso });
    click([50, 50]);
    click([120, 50]);
    click([120, 120]);
    fireEvent.keyDown(app, { code: "Enter" });
    expect(onLasso.mock.calls[0]![0].ids).toEqual(["m1"]);
  });

  it("switches picking off while panning/zooming (no GPU readback per frame) and back on after", () => {
    setup({ overlays: makeMarkers(10) });
    expect(layer("markers")!.props.pickable).toBe(true);
    const onInter = deckProps.current!.onInteractionStateChange as (s: unknown) => void;
    act(() => onInter({ isDragging: true, isPanning: true }));
    expect(layer("markers")!.props.pickable).toBe(false);
    act(() => onInter({ isDragging: false, isPanning: false, isZooming: false }));
    expect(layer("markers")!.props.pickable).toBe(true);
  });
});
