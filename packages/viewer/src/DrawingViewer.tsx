import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import DeckGL from "@deck.gl/react";
import { OrthographicView, type Layer, type PickingInfo } from "@deck.gl/core";
import { BitmapLayer, IconLayer, PathLayer, PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import { PathStyleExtension } from "@deck.gl/extensions";
import { TileLayer } from "@deck.gl/geo-layers";
import {
  DEFAULT_DPI,
  mmToScreen,
  percentToZoom,
  pointMmToPx,
  pxPerMm,
  screenToMm,
  zoomToPercent,
  type Mutable2,
  type OrthoViewState,
  type Size,
  type Vec2,
} from "./math/coords";
import { calibrate, formatScale, realLengthMm, scaleDenominatorFrom, suggestStandardScale, type CalibrationResult } from "./math/calibration";
import { bboxOf, centroid, distance, pointInPolygon, simplifyByDistance } from "./math/geometry";
import { lassoPick } from "./math/lasso";
import { tileWorldBounds, type TilePyramid } from "./math/tiles";
import { clampZoom, fitBBox, panBy, visibleWorldRect, zoomAround, zoomLimits } from "./math/view";
import { Minimap } from "./Minimap";
import { markerAtlas, markerIconKey, markerIconMapping } from "./markers";
import { defaultLabels } from "./labels";
import type {
  LassoResult,
  MarkerFeature,
  MeasureResult,
  OverlayFeature,
  PathFeature,
  PointFeature,
  PolygonFeature,
  Rgba,
  TileSource,
  ViewerLabels,
  ViewerTool,
  ViewInfo,
} from "./types";
import { canUseWebGL } from "./webgl";

export interface DrawingViewerProps {
  /** Paper size of the sheet in mm (version.page). */
  sheet: { widthMm: number; heightMm: number };
  /** Tiles of the current version; null while processing (the page outline is still shown). */
  tiles?: TileSource | null;
  /** Vector overlays in paper mm (y down). */
  overlays?: readonly OverlayFeature[];
  selectedIds?: readonly string[];
  /** External "preview highlight" (e.g. hovering a BOQ row). */
  highlightedIds?: readonly string[];
  /**
   * Focus set (e.g. a selected class / BOQ row): when non-empty, every other marker is dimmed to 30% and the
   * focused ones get a blue halo (spec §הדגשה דו-כיוונית).
   */
  focusIds?: readonly string[];
  /** Floating RTL card anchored to a paper-mm point (e.g. the details popover of a clicked marker). */
  popover?: { anchorMm: Vec2; content: ReactNode; label: string } | null;
  /** Hover card for a pickable feature id (return null for none). Rendered RTL near the pointer. */
  renderTooltip?: (id: string) => ReactNode;
  tool?: ViewerTool;
  onToolChange?: (tool: ViewerTool) => void;
  onSelect?: (ids: string[], opts: { additive: boolean }) => void;
  onHover?: (hit: { id: string; x: number; y: number } | null) => void;
  onLasso?: (r: LassoResult) => void;
  onMeasure?: (r: MeasureResult) => void;
  /** Called when the user confirms a 2-click calibration. */
  onCalibrate?: (r: CalibrationResult) => void;
  /** Scale denominator of the sheet (1:n) for measurements; null = unknown. */
  scaleDenominator?: number | null;
  onViewChange?: (info: ViewInfo) => void;
  /** Initial view in paper mm [x0, y0, x1, y1] instead of fit-to-sheet (deep links). */
  initialViewMm?: readonly [number, number, number, number] | null;
  /** Changing this key re-fits the view (e.g. sheet switch). Defaults to the tiles cacheKey / sheet size. */
  sheetKey?: string;
  showMinimap?: boolean;
  /** Accessible name of the canvas region. */
  ariaLabel: string;
  labels?: Partial<ViewerLabels>;
  className?: string;
  style?: CSSProperties;
  /** Rendered instead of the canvas when WebGL is unavailable (tests, old browsers). */
  fallback?: ReactNode;
}

export interface DrawingViewerHandle {
  fit(): void;
  zoomToMm(bbox: readonly [number, number, number, number], paddingPx?: number): void;
  zoomBy(delta: number): void;
  setPercent(pct: number): void;
  getViewInfo(): ViewInfo | null;
}

const BLUE: Rgba = [37, 99, 235, 255];
const DEFAULT_POINT: Rgba = [194, 65, 12, 255];
const DEFAULT_POLY: Rgba = [15, 76, 129, 255];
const DEFAULT_PATH: Rgba = [209, 31, 31, 255];
const TOOL_INK: Rgba = [37, 99, 235, 255];
const CLICK_SLOP = 4; // px: pointer travel below this is a click
const LASSO_SAMPLE = 3; // px between freehand samples
const CLOSE_RADIUS = 10; // px: click near the first vertex closes a click-lasso

const withAlpha = (c: Rgba, a: number): [number, number, number, number] => [c[0], c[1], c[2], a];

const VIEW = new OrthographicView({ id: "sheet", flipY: true });

type Draft =
  | { tool: "measure"; pts: Mutable2[] }
  | { tool: "calibrate"; pts: Mutable2[]; input: string }
  | { tool: "lasso"; pts: Mutable2[]; mode: "free" | "click" }
  | null;

export const DrawingViewer = forwardRef<DrawingViewerHandle, DrawingViewerProps>(function DrawingViewer(props, ref) {
  const {
    sheet,
    tiles = null,
    overlays = EMPTY,
    selectedIds = EMPTY_IDS,
    highlightedIds = EMPTY_IDS,
    focusIds = EMPTY_IDS,
    popover = null,
    renderTooltip,
    tool = "select",
    onToolChange,
    onSelect,
    onHover,
    onLasso,
    onMeasure,
    onCalibrate,
    scaleDenominator = null,
    onViewChange,
    initialViewMm = null,
    showMinimap = true,
    ariaLabel,
    className,
    style,
    fallback,
  } = props;
  const labels = useMemo(() => ({ ...defaultLabels, ...props.labels }), [props.labels]);
  const [webgl] = useState(canUseWebGL);

  const dpi = tiles?.dpi ?? DEFAULT_DPI;
  const k = pxPerMm(dpi);
  const worldW = tiles?.widthPx ?? sheet.widthMm * k;
  const worldH = tiles?.heightPx ?? sheet.heightMm * k;
  const sheetKey = props.sheetKey ?? tiles?.cacheKey ?? `${sheet.widthMm}x${sheet.heightMm}`;

  const wrapRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const [view, setView] = useState<OrthoViewState | null>(null);
  const [draft, setDraft] = useState<Draft>(null);
  const [cursorMm, setCursorMm] = useState<Mutable2 | null>(null);
  const [lastMeasure, setLastMeasure] = useState<MeasureResult | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [hoverAt, setHoverAt] = useState<{ x: number; y: number } | null>(null);
  // While panning/zooming, hover picking is pointless and its synchronous GPU readback (readPixels) is the main
  // per-frame cost with thousands of markers → pickable layers are switched off during the interaction.
  const [interacting, setInteracting] = useState(false);
  const down = useRef<{ x: number; y: number; moved: boolean; id: number } | null>(null);
  const fittedFor = useRef<string | null>(null);
  const [minimapUrl, setMinimapUrl] = useState<string | null>(null);

  // Minimap image: thumbnail, else the single z=0 tile (tileUrl may be async → resolve once per sheet).
  useEffect(() => {
    let alive = true;
    if (!tiles) {
      setMinimapUrl(null);
      return;
    }
    if (tiles.thumbnailUrl) {
      setMinimapUrl(tiles.thumbnailUrl);
      return;
    }
    void Promise.resolve(tiles.tileUrl(0, 0, 0)).then((u) => alive && setMinimapUrl(u ?? null), () => alive && setMinimapUrl(null));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiles?.thumbnailUrl, tiles?.cacheKey, Boolean(tiles)]);

  /* ---------- box size ---------- */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setBox({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const limits = useMemo(() => zoomLimits(box, worldW, worldH, dpi), [box, worldW, worldH, dpi]);

  const fitView = useCallback(
    (bboxMm?: readonly [number, number, number, number] | null, padding = 24): OrthoViewState => {
      const b = bboxMm
        ? { minX: bboxMm[0] * k, minY: bboxMm[1] * k, maxX: bboxMm[2] * k, maxY: bboxMm[3] * k }
        : { minX: 0, minY: 0, maxX: worldW, maxY: worldH };
      return fitBBox(box, b, limits, padding);
    },
    [box, k, limits, worldW, worldH],
  );

  // Fit on first layout and whenever the sheet changes.
  useEffect(() => {
    if (box.width === 0 || box.height === 0) return;
    if (fittedFor.current === sheetKey) {
      // Box resized: keep the view, refresh limits.
      setView((v) => (v ? { ...v, ...limits, zoom: clampZoom(v.zoom, limits) } : v));
      return;
    }
    fittedFor.current = sheetKey;
    setView(fitView(initialViewMm, initialViewMm ? 8 : 24));
    setDraft(null);
    setLastMeasure(null);
    // initialViewMm only matters for the first fit of a sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box, sheetKey, limits]);

  const viewInfo = useCallback((): ViewInfo | null => {
    if (!view || box.width === 0) return null;
    const r = visibleWorldRect(view, box);
    return {
      zoom: view.zoom,
      percent: zoomToPercent(view.zoom, dpi),
      visibleMm: [r.minX / k, r.minY / k, r.maxX / k, r.maxY / k],
    };
  }, [view, box, dpi, k]);

  useEffect(() => {
    const info = viewInfo();
    if (info) onViewChange?.(info);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  useImperativeHandle(
    ref,
    () => ({
      fit: () => setView(fitView()),
      zoomToMm: (bbox, padding = 24) => setView(fitView(bbox, padding)),
      zoomBy: (delta) => setView((v) => (v ? zoomAround(v, delta, [box.width / 2, box.height / 2], box) : v)),
      setPercent: (pct) => setView((v) => (v ? { ...v, zoom: clampZoom(percentToZoom(pct, dpi), v) } : v)),
      getViewInfo: viewInfo,
    }),
    [fitView, box, dpi, viewInfo],
  );

  /* ---------- tool changes reset drafts ---------- */
  useEffect(() => {
    setDraft(null);
    setCursorMm(null);
    if (tool !== "measure") setLastMeasure(null);
  }, [tool]);

  const toMm = useCallback(
    (clientX: number, clientY: number): Mutable2 | null => {
      const el = wrapRef.current;
      if (!el || !view) return null;
      const r = el.getBoundingClientRect();
      return screenToMm([clientX - r.left, clientY - r.top], view, box, dpi);
    },
    [view, box, dpi],
  );
  const toScreen = useCallback((p: Vec2): Mutable2 => (view ? mmToScreen(p, view, box, dpi) : [0, 0]), [view, box, dpi]);

  /* ---------- lasso completion ---------- */
  const finishLasso = useCallback(
    (pts: Mutable2[]) => {
      setDraft(null);
      if (pts.length < 3) return;
      const polygonMm = pts.map((p) => [p[0], p[1]] as [number, number]);
      onLasso?.({ polygonMm, ids: lassoPick(overlays, polygonMm) });
    },
    [onLasso, overlays],
  );

  /* ---------- pointer handling (tools) ---------- */
  const isDrawingTool = tool === "lasso" || tool === "measure" || tool === "calibrate";

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !isDrawingTool) return;
    if ((e.target as HTMLElement).closest("[data-viewer-ui]")) return;
    down.current = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
    if (tool === "lasso" && !(draft?.tool === "lasso" && draft.mode === "click")) {
      const p = toMm(e.clientX, e.clientY);
      if (p) setDraft({ tool: "lasso", pts: [p], mode: "free" });
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* jsdom / synthetic events */
      }
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!isDrawingTool) return;
    const p = toMm(e.clientX, e.clientY);
    const d = down.current;
    if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP) d.moved = true;
    if (tool === "lasso" && d && d.moved && draft?.tool === "lasso" && draft.mode === "free" && p) {
      const last = draft.pts[draft.pts.length - 1];
      const lastS = last ? toScreen(last) : null;
      const el = wrapRef.current!.getBoundingClientRect();
      if (!lastS || Math.hypot(e.clientX - el.left - lastS[0], e.clientY - el.top - lastS[1]) >= LASSO_SAMPLE) {
        setDraft({ ...draft, pts: [...draft.pts, p] });
      }
    }
    setCursorMm(p);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = down.current;
    down.current = null;
    if (!d || !isDrawingTool) return;
    const p = toMm(e.clientX, e.clientY);
    if (!p) return;
    if (tool === "lasso") {
      if (draft?.tool === "lasso" && draft.mode === "free" && d.moved) {
        const k2 = view ? 2 ** view.zoom * k : 1; // screen px per mm
        finishLasso(simplifyByDistance([...draft.pts, p], LASSO_SAMPLE / k2));
        return;
      }
      // Click → polygon vertex mode.
      const prev = draft?.tool === "lasso" && draft.mode === "click" ? draft.pts : [];
      const first = prev[0];
      if (first && prev.length >= 3) {
        const fs = toScreen(first);
        const el = wrapRef.current!.getBoundingClientRect();
        if (Math.hypot(e.clientX - el.left - fs[0], e.clientY - el.top - fs[1]) <= CLOSE_RADIUS) {
          finishLasso(prev);
          return;
        }
      }
      setDraft({ tool: "lasso", pts: [...prev, p], mode: "click" });
      return;
    }
    if (d.moved) return; // a pan, not a click
    if (tool === "measure") {
      const prev = draft?.tool === "measure" && draft.pts.length === 1 ? draft.pts : [];
      if (prev.length === 0) {
        setLastMeasure(null);
        setDraft({ tool: "measure", pts: [p] });
      } else {
        const a = prev[0]!;
        const paperMm = distance(a, p);
        const r: MeasureResult = {
          a: [a[0], a[1]],
          b: [p[0], p[1]],
          paperMm,
          realMm: scaleDenominator ? realLengthMm(paperMm, scaleDenominator) : null,
        };
        setLastMeasure(r);
        setDraft(null);
        onMeasure?.(r);
      }
    } else if (tool === "calibrate") {
      const prev = draft?.tool === "calibrate" ? draft.pts : [];
      if (prev.length >= 2) return; // waiting for the length input
      const pts = [...prev, p];
      setDraft({ tool: "calibrate", pts, input: draft?.tool === "calibrate" ? draft.input : "" });
    }
  };

  const onDoubleClick = () => {
    if (draft?.tool === "lasso" && draft.mode === "click") finishLasso(draft.pts.slice(0, -1).length >= 3 ? draft.pts.slice(0, -1) : draft.pts);
  };

  /* ---------- keyboard (event.code → works on a Hebrew layout too) ---------- */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.target as HTMLElement).closest("input, textarea, select, [data-viewer-ui='form']")) return;
    const center: Vec2 = [box.width / 2, box.height / 2];
    let handled = true;
    switch (e.code) {
      case "Equal":
      case "NumpadAdd":
        setView((v) => (v ? zoomAround(v, 1, center, box) : v));
        break;
      case "Minus":
      case "NumpadSubtract":
        setView((v) => (v ? zoomAround(v, -1, center, box) : v));
        break;
      case "Digit0":
      case "Numpad0":
        setView(fitView());
        break;
      case "Digit1":
      case "Numpad1":
        setView((v) => (v ? { ...v, zoom: clampZoom(percentToZoom(100, dpi), v) } : v));
        break;
      case "ArrowLeft":
        setView((v) => (v ? panBy(v, -80, 0) : v));
        break;
      case "ArrowRight":
        setView((v) => (v ? panBy(v, 80, 0) : v));
        break;
      case "ArrowUp":
        setView((v) => (v ? panBy(v, 0, -80) : v));
        break;
      case "ArrowDown":
        setView((v) => (v ? panBy(v, 0, 80) : v));
        break;
      case "Enter":
        if (draft?.tool === "lasso" && draft.mode === "click") finishLasso(draft.pts);
        else handled = false;
        break;
      case "Escape":
        if (draft) setDraft(null);
        else if (lastMeasure) setLastMeasure(null);
        else if (tool !== "select") onToolChange?.("select");
        else handled = false;
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  /* ---------- layers ---------- */
  const pyramid: TilePyramid | null = tiles
    ? { tileSize: tiles.tileSize, dpi: tiles.dpi, levels: tiles.levels, widthPx: tiles.widthPx, heightPx: tiles.heightPx }
    : null;
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const highlighted = useMemo(() => new Set(highlightedIds), [highlightedIds]);
  const focused = useMemo(() => new Set(focusIds), [focusIds]);

  const split = useMemo(() => {
    const out = {
      points: [] as PointFeature[],
      markers: [] as MarkerFeature[],
      polys: [] as PolygonFeature[],
      paths: [] as PathFeature[],
      passivePolys: [] as PolygonFeature[],
      passivePaths: [] as PathFeature[],
      passivePoints: [] as PointFeature[],
    };
    for (const f of overlays) {
      if (f.kind === "point") (f.passive ? out.passivePoints : out.points).push(f);
      else if (f.kind === "marker") out.markers.push(f);
      else if (f.kind === "polygon") (f.passive ? out.passivePolys : out.polys).push(f);
      else (f.passive ? out.passivePaths : out.paths).push(f);
    }
    return out;
  }, [overlays]);

  const layers = useMemo(() => {
    const L: Layer[] = [];
    const mm = (p: Vec2) => pointMmToPx(p, dpi);
    const isSel = (id: string) => selected.has(id) || highlighted.has(id);
    const trig = [selectedIds, highlightedIds];

    // Paper underlay: white page + outline, visible while tiles stream in.
    L.push(
      new PolygonLayer({
        id: "page",
        data: [[[0, 0], [worldW, 0], [worldW, worldH], [0, worldH]]],
        getPolygon: (d: number[][]) => d,
        getFillColor: [255, 255, 255, 255],
        getLineColor: [120, 113, 108, 255],
        lineWidthUnits: "pixels",
        getLineWidth: 1,
        stroked: true,
        filled: true,
        pickable: false,
      }),
    );

    if (tiles && pyramid) {
      const maxZ = pyramid.levels - 1;
      L.push(
        new TileLayer<ImageBitmap | null>({
          id: `tiles-${sheetKey}`,
          data: [""],
          tileSize: pyramid.tileSize,
          minZoom: -maxZ,
          maxZoom: 0,
          extent: [0, 0, pyramid.widthPx, pyramid.heightPx],
          // Crisper tiles on HiDPI screens: fetch one level deeper (clamped at maxZoom).
          zoomOffset: typeof window !== "undefined" && window.devicePixelRatio > 1.5 ? 1 : 0,
          maxCacheSize: 256,
          maxRequests: 8,
          refinementStrategy: "best-available",
          pickable: false,
          getTileData: async ({ index, signal }) => {
            const url = await tiles.tileUrl(index.z + maxZ, index.x, index.y, signal);
            if (!url) return null;
            const res = await fetch(url, signal ? { signal } : undefined);
            if (!res.ok) return null;
            const blob = await res.blob();
            if (signal?.aborted) return null;
            return createImageBitmap(blob);
          },
          onTileUnload: (tile) => {
            const c = tile.content as ImageBitmap | null;
            c?.close?.();
          },
          onTileError: () => {
            /* missing tile → page underlay shows through */
          },
          renderSubLayers: (sub) => {
            const img = sub.data;
            if (!img) return null;
            const { x, y, z } = sub.tile.index;
            const [left, top, right, bottom] = tileWorldBounds(pyramid, z + maxZ, x, y, img.width, img.height);
            return new BitmapLayer({
              id: `${sub.id}-bmp`,
              image: img,
              bounds: [left, bottom, right, top],
              pickable: false,
              textureParameters: { minFilter: "linear", magFilter: "linear", mipmapFilter: "linear" },
            });
          },
          updateTriggers: { getTileData: tiles.cacheKey ?? sheetKey },
        }),
      );
    }

    const color = (f: OverlayFeature, fallbackColor: Rgba) => f.color ?? fallbackColor;
    // Dashed outlines (legend boxes, demolished rooms): PathStyleExtension, dash in screen px.
    const dashProps = {
      getDashArray: (f: PolygonFeature) => (f.dashed ? [6, 4] : [0, 0]),
      dashJustified: true,
      dashGapPickable: false,
      extensions: [DASH_EXT],
    };

    // Switch↔luminaire arcs: dashed as drawn, dotted where the system completed a broken arc.
    const pathDashProps = {
      getDashArray: (f: PathFeature) => (f.dash === "dashed" ? [7, 4] : f.dash === "dotted" ? [1.5, 3] : [0, 0]),
      dashJustified: false,
      dashGapPickable: false,
      extensions: [DASH_EXT],
    };

    // Passive geometry (floor regions, evidence) — under the pickable layers, never picked.
    if (split.passivePolys.length)
      L.push(
        new PolygonLayer<PolygonFeature>({
          id: "passive-polygons",
          data: split.passivePolys,
          getPolygon: (f) => f.polygon.map(mm),
          getFillColor: (f) => dimFill(f.fillColor ? ([...f.fillColor] as [number, number, number, number]) : withAlpha(color(f, DEFAULT_POLY), 28), f.dimmed),
          getLineColor: (f) => withAlpha(color(f, DEFAULT_POLY), f.dimmed ? 90 : 230),
          lineWidthUnits: "pixels",
          getLineWidth: (f) => f.lineWidthPx ?? 2,
          stroked: true,
          filled: true,
          pickable: false,
          ...dashProps,
        }),
      );
    if (split.passivePaths.length)
      L.push(
        new PathLayer<PathFeature>({
          id: "passive-paths",
          data: split.passivePaths,
          getPath: (f) => f.path.map(mm),
          getColor: (f) => withAlpha(color(f, DEFAULT_PATH), f.dimmed ? 90 : (color(f, DEFAULT_PATH)[3] ?? 200)),
          widthUnits: "pixels",
          getWidth: (f) => f.widthPx ?? 1.5,
          capRounded: true,
          jointRounded: true,
          pickable: false,
          ...pathDashProps,
        }),
      );

    const common = {
      pickable: !interacting,
      autoHighlight: true,
      highlightColor: withAlpha(BLUE, 110),
    } as const;

    if (split.polys.length)
      L.push(
        new PolygonLayer<PolygonFeature>({
          id: "polygons",
          data: split.polys,
          ...common,
          getPolygon: (f) => f.polygon.map(mm),
          getFillColor: (f) =>
            isSel(f.id)
              ? withAlpha(BLUE, 50)
              : dimFill(f.fillColor ? ([...f.fillColor] as [number, number, number, number]) : withAlpha(color(f, DEFAULT_POLY), 24), f.dimmed),
          getLineColor: (f) => (isSel(f.id) ? BLUE : withAlpha(color(f, DEFAULT_POLY), f.dimmed ? 90 : (color(f, DEFAULT_POLY)[3] ?? 255))),
          lineWidthUnits: "pixels",
          getLineWidth: (f) => (isSel(f.id) ? 3 : (f.lineWidthPx ?? 1.5)),
          stroked: true,
          filled: true,
          ...dashProps,
          updateTriggers: { getFillColor: trig, getLineColor: trig, getLineWidth: trig },
        }),
      );
    if (split.paths.length)
      L.push(
        new PathLayer<PathFeature>({
          id: "paths",
          data: split.paths,
          ...common,
          getPath: (f) => f.path.map(mm),
          getColor: (f) => (isSel(f.id) ? BLUE : color(f, DEFAULT_PATH)) as [number, number, number, number],
          widthUnits: "pixels",
          widthMinPixels: 1,
          getWidth: (f) => (isSel(f.id) ? 3 : (f.widthPx ?? 1.5)),
          ...pathDashProps,
          updateTriggers: { getColor: trig, getWidth: trig },
        }),
      );
    const allPoints = [...split.passivePoints, ...split.points];
    if (allPoints.length)
      L.push(
        new ScatterplotLayer<PointFeature>({
          id: "points",
          data: allPoints,
          ...common,
          getPosition: (f) => mm(f.position),
          radiusUnits: "pixels",
          getRadius: (f) => (isSel(f.id) ? (f.radiusPx ?? 6) + 3 : (f.radiusPx ?? 6)),
          stroked: true,
          filled: true,
          lineWidthUnits: "pixels",
          getLineWidth: (f) => (isSel(f.id) ? 3 : 1.5),
          getFillColor: (f) => withAlpha(isSel(f.id) ? BLUE : color(f, DEFAULT_POINT), isSel(f.id) ? 90 : 60),
          getLineColor: (f) => (isSel(f.id) ? BLUE : color(f, DEFAULT_POINT)) as [number, number, number, number],
          updateTriggers: { getRadius: trig, getLineWidth: trig, getFillColor: trig, getLineColor: trig },
        }),
      );

    // Detected symbols: GPU icon markers sized in paper mm (scale with zoom), min 8 px so far views keep a dot.
    // Geometry (positions/icons/sizes) only depends on `split.markers`; selection/focus only re-run the colour
    // and halo accessors (updateTriggers) — no re-tessellation, so 2,000+ markers stay at 60 fps.
    if (split.markers.length) {
      const anyFocus = focused.size > 0;
      const markerAlpha = (f: MarkerFeature) => {
        const base = f.color?.[3] ?? 255;
        if (anyFocus && !focused.has(f.id) && !isSel(f.id)) return Math.round(base * 0.3);
        if (f.dimmed && !isSel(f.id)) return Math.round(base * 0.35);
        return base;
      };
      const halo = split.markers.filter((f) => isSel(f.id) || focused.has(f.id));
      if (halo.length)
        L.push(
          new ScatterplotLayer<MarkerFeature>({
            id: "marker-halo",
            data: halo,
            getPosition: (f) => mm(f.position),
            radiusUnits: "common",
            getRadius: (f) => ((f.sizeMm ?? 6) * k) * 0.78,
            radiusMinPixels: 8,
            stroked: true,
            filled: true,
            lineWidthUnits: "pixels",
            getLineWidth: (f) => (isSel(f.id) ? 3 : 2),
            getFillColor: withAlpha(BLUE, 40),
            getLineColor: (f) => withAlpha(BLUE, isSel(f.id) ? 255 : 200),
            pickable: false,
            updateTriggers: { getLineWidth: trig, getLineColor: trig },
          }),
        );
      L.push(
        new IconLayer<MarkerFeature>({
          id: "markers",
          data: split.markers,
          ...common,
          iconAtlas: markerAtlas() as never,
          iconMapping: MARKER_MAPPING,
          getIcon: (f) => markerIconKey(f),
          getPosition: (f) => mm(f.position),
          sizeUnits: "common",
          getSize: (f) => (f.sizeMm ?? 6) * k * 1.25,
          sizeMinPixels: 13,
          getColor: (f) => withAlpha(color(f, DEFAULT_POINT), markerAlpha(f)),
          alphaCutoff: 0.02,
          updateTriggers: { getColor: [...trig, focusIds] },
        }),
      );
    }

    // Tool drafts (rubber band follows the cursor).
    const toolPts: Mutable2[] = [];
    if (draft) toolPts.push(...draft.pts);
    const rubber =
      cursorMm && draft && ((draft.tool === "measure" && draft.pts.length === 1) || (draft.tool === "calibrate" && draft.pts.length === 1) || (draft.tool === "lasso" && draft.mode === "click"))
        ? [...draft.pts, cursorMm]
        : draft?.pts ?? [];
    if (draft?.tool === "lasso" && rubber.length >= 2) {
      L.push(
        new PolygonLayer({
          id: "lasso",
          data: [rubber.map(mm)],
          getPolygon: (d: Mutable2[]) => d,
          getFillColor: withAlpha(TOOL_INK, 30),
          getLineColor: TOOL_INK as [number, number, number, number],
          lineWidthUnits: "pixels",
          getLineWidth: 1.5,
          stroked: true,
          filled: true,
          pickable: false,
        }),
      );
    } else if (rubber.length >= 2) {
      L.push(
        new PathLayer({
          id: "tool-line",
          data: [rubber.map(mm)],
          getPath: (d: Mutable2[]) => d,
          getColor: (draft?.tool === "calibrate" ? [194, 65, 12, 255] : TOOL_INK) as [number, number, number, number],
          widthUnits: "pixels",
          getWidth: 2,
          pickable: false,
        }),
      );
    }
    const measured = lastMeasure ? [lastMeasure.a, lastMeasure.b] : [];
    if (measured.length) {
      L.push(
        new PathLayer({
          id: "measure-result",
          data: [measured.map((p) => mm(p))],
          getPath: (d: Mutable2[]) => d,
          getColor: TOOL_INK as [number, number, number, number],
          widthUnits: "pixels",
          getWidth: 2,
          pickable: false,
        }),
      );
    }
    const handles = [...toolPts, ...measured];
    if (handles.length)
      L.push(
        new ScatterplotLayer({
          id: "tool-handles",
          data: handles,
          getPosition: (p: Vec2) => mm(p),
          radiusUnits: "pixels",
          getRadius: 4,
          getFillColor: [255, 255, 255, 255],
          getLineColor: TOOL_INK as [number, number, number, number],
          lineWidthUnits: "pixels",
          getLineWidth: 2,
          stroked: true,
          pickable: false,
        }),
      );
    return L;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiles, sheetKey, worldW, worldH, dpi, split, selected, highlighted, focused, draft, cursorMm, lastMeasure, interacting]);

  /* ---------- deck callbacks ---------- */
  const handleClick = useCallback(
    (info: PickingInfo, ev: { srcEvent?: { shiftKey?: boolean } }) => {
      if (tool !== "select" && tool !== "pan") return;
      const f = info.object as OverlayFeature | undefined;
      if (f && !f.passive) onSelect?.([f.id], { additive: Boolean(ev?.srcEvent?.shiftKey) });
      else if (!ev?.srcEvent?.shiftKey) onSelect?.([], { additive: false });
    },
    [tool, onSelect],
  );
  const handleHover = useCallback(
    (info: PickingInfo) => {
      const f = info.object as OverlayFeature | undefined;
      const id = f && !f.passive ? f.id : null;
      setHoverId(id);
      setHoverAt(id ? { x: info.x, y: info.y } : null);
      onHover?.(id ? { id, x: info.x, y: info.y } : null);
    },
    [onHover],
  );

  const controller = useMemo(
    () => ({
      dragPan: tool !== "lasso",
      scrollZoom: { speed: 0.01, smooth: false },
      doubleClickZoom: tool === "select" || tool === "pan",
      touchZoom: true,
      touchRotate: false,
      keyboard: false,
      inertia: false,
    }),
    [tool],
  );

  /* ---------- floating HTML (RTL) ---------- */
  const labelPolys = useMemo(() => overlays.filter((f): f is PolygonFeature => f.kind === "polygon" && Boolean(f.label)), [overlays]);
  const polygonLabels = view
    ? labelPolys
        .filter((f) => {
          if (!f.labelMinPx) return true;
          const b = bboxOf(f.polygon);
          return (b.maxX - b.minX) * k * 2 ** view.zoom >= f.labelMinPx;
        })
        .map((f) => ({ id: f.id, label: f.label!, ltr: f.labelLtr, suffix: f.labelSuffix, dimmed: f.dimmed, at: toScreen(labelPoint(f.polygon)) }))
    : [];
  const tooltip = renderTooltip && hoverId && hoverAt && !draft ? renderTooltip(hoverId) : null;

  const minimapMarkers = useMemo<PointFeature[]>(
    () => [
      ...split.points,
      ...split.markers.map((m) => ({ id: m.id, kind: "point" as const, position: m.position, ...(m.color ? { color: m.color } : {}) })),
    ],
    [split],
  );

  const calib = draft?.tool === "calibrate" && draft.pts.length === 2 ? draft : null;
  const calibPaperMm = calib ? distance(calib.pts[0]!, calib.pts[1]!) : 0;
  const calibCm = calib ? Number(calib.input.replace(",", ".")) : NaN;
  const calibSuggestion =
    calib && calibCm > 0 && calibPaperMm > 0 ? suggestStandardScale(scaleDenominatorFrom(calibPaperMm, calibCm * 10)) : null;

  const hint =
    tool === "lasso" ? labels.lassoHint : tool === "measure" ? labels.measureHint : tool === "calibrate" && !calib ? labels.calibrateHint : null;

  if (!webgl) {
    return (
      <div
        dir="ltr"
        role="img"
        aria-label={ariaLabel}
        className={className}
        style={{ position: "relative", width: "100%", height: "100%", background: "rgb(var(--canvas-bg, 255 255 255))", ...style }}
        data-viewer-fallback
      >
        {fallback ?? null}
      </div>
    );
  }

  return (
    <div
      ref={wrapRef}
      dir="ltr"
      role="application"
      aria-label={ariaLabel}
      aria-roledescription="drawing viewer"
      tabIndex={0}
      className={className}
      data-tool={tool}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        background: "rgb(var(--surface-sunken, 245 245 244))",
        outline: "none",
        touchAction: "none",
        ...style,
      }}
      onKeyDown={onKeyDown}
      onPointerDownCapture={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setCursorMm(null)}
      onDoubleClick={onDoubleClick}
    >
      {view ? (
        <DeckGL
          views={VIEW}
          viewState={view as never}
          onViewStateChange={({ viewState }) => {
            const v = viewState as unknown as OrthoViewState;
            setView({ target: [v.target[0], v.target[1], 0], zoom: clampZoom(v.zoom as number, limits), ...limits });
          }}
          controller={controller}
          onInteractionStateChange={(s: { isDragging?: boolean; isPanning?: boolean; isZooming?: boolean }) => {
            const busy = Boolean(s.isDragging || s.isPanning || s.isZooming);
            setInteracting((cur) => (cur === busy ? cur : busy));
          }}
          layers={layers}
          onClick={handleClick as never}
          onHover={handleHover}
          pickingRadius={5}
          getCursor={({ isDragging }) =>
            isDrawingTool ? "crosshair" : hoverId ? "pointer" : isDragging ? "grabbing" : "grab"
          }
          style={{ position: "absolute", inset: "0" }}
        />
      ) : null}

      {polygonLabels.map((l) => (
        <span
          key={l.id}
          dir="rtl"
          data-room-label
          style={{
            ...chip,
            position: "absolute",
            left: l.at[0],
            top: l.at[1],
            transform: "translate(-50%, -50%)",
            pointerEvents: "none",
            opacity: l.dimmed ? 0.55 : 1,
            textAlign: "center",
            lineHeight: 1.25,
          }}
        >
          {l.label}
          {l.ltr ? (
            <>
              <br />
              <bdi dir="ltr" style={{ fontVariantNumeric: "tabular-nums", color: "rgb(var(--muted-foreground, 87 83 78))" }}>
                {l.ltr}
              </bdi>
              {l.suffix ? ` ${l.suffix}` : null}
            </>
          ) : null}
        </span>
      ))}

      {tooltip && hoverAt ? (
        <div
          dir="rtl"
          role="tooltip"
          data-viewer-ui
          style={{
            ...panel,
            position: "absolute",
            left: Math.min(hoverAt.x + 14, Math.max(8, box.width - 280)),
            top: Math.min(hoverAt.y + 14, Math.max(8, box.height - 140)),
            maxWidth: 270,
            background: "rgb(var(--surface, 255 255 255))",
            pointerEvents: "none",
            zIndex: 3,
          }}
        >
          {tooltip}
        </div>
      ) : null}

      {popover && view ? (
        <PopoverAt at={toScreen(popover.anchorMm)} box={box} label={popover.label}>
          {popover.content}
        </PopoverAt>
      ) : null}

      {lastMeasure && view ? (
        <MeasureChip
          at={toScreen([(lastMeasure.a[0] + lastMeasure.b[0]) / 2, (lastMeasure.a[1] + lastMeasure.b[1]) / 2])}
          text={labels.formatLength(lastMeasure.realMm, lastMeasure.paperMm)}
        />
      ) : null}

      {hint ? (
        <div dir="rtl" role="status" data-viewer-ui style={{ ...chip, position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)" }}>
          {hint}
        </div>
      ) : null}

      {calib && view ? (
        <form
          dir="rtl"
          data-viewer-ui="form"
          aria-label={labels.realLength}
          onSubmit={(e) => {
            e.preventDefault();
            if (!(calibCm > 0)) return;
            const r = calibrate(calib.pts[0]!, calib.pts[1]!, calibCm * 10);
            onCalibrate?.(r);
            setDraft(null);
          }}
          style={{
            ...panel,
            position: "absolute",
            left: Math.min(Math.max(8, toScreen(calib.pts[1]!)[0] + 12), Math.max(8, box.width - 260)),
            top: Math.min(Math.max(8, toScreen(calib.pts[1]!)[1] + 12), Math.max(8, box.height - 150)),
            width: 240,
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span>{labels.realLength}</span>
            <input
              autoFocus
              inputMode="decimal"
              dir="ltr"
              value={calib.input}
              onChange={(e) => setDraft({ ...calib, input: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setDraft(null);
                }
              }}
              style={{ width: 72, padding: "2px 6px", border: "1px solid rgb(var(--border-strong, 214 211 209))", borderRadius: 4, font: "inherit" }}
            />
            <span>{labels.unitCm}</span>
          </label>
          {calibSuggestion ? (
            <p role="status" style={{ margin: "6px 0 0" }}>
              {calibSuggestion.snap
                ? labels.scaleSuggestion(formatScale(Math.round(calibSuggestion.measured * 10) / 10), formatScale(calibSuggestion.nearest))
                : labels.scaleResult(formatScale(Math.round(calibSuggestion.measured * 10) / 10))}
            </p>
          ) : null}
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <button type="submit" disabled={!(calibCm > 0)} style={button(true)}>
              {labels.apply}
            </button>
            <button type="button" onClick={() => setDraft(null)} style={button(false)}>
              {labels.cancel}
            </button>
          </div>
        </form>
      ) : null}

      {showMinimap && view && box.width > 0 ? (
        <Minimap
          worldW={worldW}
          worldH={worldH}
          view={view}
          box={box}
          imageUrl={minimapUrl}
          markers={minimapMarkers}
          dpi={dpi}
          label={labels.minimap}
          toggleLabel={labels.minimapToggle}
          onCenter={(w) => setView((v) => (v ? { ...v, target: [w[0], w[1], 0] } : v))}
        />
      ) : null}
    </div>
  );
});

const EMPTY: readonly OverlayFeature[] = [];
const MARKER_MAPPING = markerIconMapping();
const DASH_EXT = new PathStyleExtension({ dash: true });
const dimFill = (c: [number, number, number, number], dimmed?: boolean): [number, number, number, number] =>
  dimmed ? [c[0], c[1], c[2], Math.round(c[3] * 0.35)] : c;

/** Label anchor: the area centroid, or the bbox centre when the centroid falls outside (L-shaped rooms). */
function labelPoint(poly: readonly Vec2[]): Vec2 {
  const c = centroid(poly);
  if (pointInPolygon(c, poly)) return c;
  const b = bboxOf(poly);
  return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
}

/** Floating card anchored to a screen point, flipped/clamped to stay inside the viewer box. */
function PopoverAt({ at, box, label, children }: { at: Mutable2; box: Size; label: string; children: ReactNode }) {
  const W = 300;
  const left = at[0] + 16 + W > box.width ? Math.max(8, at[0] - 16 - W) : at[0] + 16;
  const top = Math.min(Math.max(8, at[1] - 40), Math.max(8, box.height - 320));
  return (
    <div
      dir="rtl"
      role="dialog"
      aria-label={label}
      data-viewer-ui="form"
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        ...panel,
        background: "rgb(var(--surface, 255 255 255))",
        boxShadow: "0 8px 28px rgb(0 0 0 / 0.18)",
        position: "absolute",
        left,
        top,
        width: W,
        maxHeight: Math.max(160, box.height - 16),
        overflow: "auto",
        zIndex: 4,
      }}
    >
      {children}
    </div>
  );
}
const EMPTY_IDS: readonly string[] = [];

const chip: CSSProperties = {
  font: "500 12px/1.4 Heebo, system-ui, sans-serif",
  background: "rgb(var(--surface, 255 255 255) / 0.95)",
  color: "rgb(var(--foreground, 28 25 23))",
  border: "1px solid rgb(var(--border, 231 229 228))",
  borderRadius: 4,
  padding: "2px 8px",
  boxShadow: "0 2px 8px rgb(0 0 0 / 0.08)",
  whiteSpace: "nowrap",
};
const panel: CSSProperties = { ...chip, padding: 10, font: "400 13px/1.5 Heebo, system-ui, sans-serif", whiteSpace: "normal", zIndex: 2 };
const button = (primary: boolean): CSSProperties => ({
  font: "500 13px/1 Heebo, system-ui, sans-serif",
  padding: "6px 10px",
  borderRadius: 4,
  border: primary ? "1px solid rgb(var(--primary, 15 76 129))" : "1px solid rgb(var(--border-strong, 214 211 209))",
  background: primary ? "rgb(var(--primary, 15 76 129))" : "rgb(var(--surface, 255 255 255))",
  color: primary ? "rgb(var(--primary-foreground, 255 255 255))" : "rgb(var(--foreground, 28 25 23))",
  cursor: "pointer",
});

function MeasureChip({ at, text }: { at: Mutable2; text: string }) {
  return (
    <span
      role="status"
      dir="rtl"
      style={{ ...chip, position: "absolute", left: at[0], top: at[1] - 14, transform: "translate(-50%, -100%)", pointerEvents: "none" }}
    >
      {text}
    </span>
  );
}

