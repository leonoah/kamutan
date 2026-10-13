import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Lasso, Maximize, Minus, MousePointer2, Plus, Ruler, Scaling } from "lucide-react";
import {
  DrawingViewer,
  defaultLabels,
  formatScale,
  type CalibrationResult,
  type DrawingViewerHandle,
  type LassoResult,
  type MeasureResult,
  type OverlayFeature,
  type ViewerLabels,
  type ViewerTool,
  type ViewInfo,
} from "@kamutan/viewer";
import type { SheetRow } from "@/api/types";
import { useApi } from "@/api/client";
import { Kbd } from "@/components/Kbd";
import { cn } from "@/lib/utils";
import { paperSize, toTileSource, useTilesManifest } from "./tiles";

export interface SheetViewerProps {
  projectId: string;
  row: SheetRow;
  tool: ViewerTool;
  onToolChange: (tool: ViewerTool) => void;
  tools?: ViewerTool[];
  overlays?: readonly OverlayFeature[];
  selectedIds?: readonly string[];
  /** Focused ids (e.g. a selected class): everything else is dimmed to 30%. */
  focusIds?: readonly string[];
  /** Details popover anchored to a paper-mm point. */
  popover?: { anchorMm: readonly [number, number]; content: ReactNode; label: string } | null;
  renderTooltip?: (id: string) => ReactNode;
  /** Zoom to a paper-mm box whenever `seq` changes (jump to a marker / a class / a cluster). */
  zoomRequest?: { bboxMm: readonly [number, number, number, number]; seq: number } | null;
  onSelect?: (ids: string[], opts: { additive: boolean }) => void;
  onLasso?: (r: LassoResult) => void;
  onMeasure?: (r: MeasureResult) => void;
  onCalibrate?: (r: CalibrationResult) => void;
  /** Deep link: initial view in paper mm [x0, y0, x1, y1]. */
  initialViewMm?: readonly [number, number, number, number] | null;
  /** Extra controls rendered at the end of the bottom strip (e.g. the review lifecycle toggle). */
  footerExtra?: React.ReactNode;
  className?: string;
}

const TOOL_META: Record<ViewerTool, { key: string; code: string; icon: typeof Lasso; label: string }> = {
  select: { key: "V", code: "KeyV", icon: MousePointer2, label: "viewer.select" },
  pan: { key: "H", code: "KeyH", icon: MousePointer2, label: "viewer.select" },
  lasso: { key: "L", code: "KeyL", icon: Lasso, label: "viewer.lasso" },
  measure: { key: "D", code: "KeyD", icon: Ruler, label: "viewer.measure" },
  calibrate: { key: "S", code: "KeyS", icon: Scaling, label: "viewer.calibrate" },
};

/**
 * The drawing canvas as used by the app: Deck.gl viewer + tool rail + scale/zoom strip.
 * Everything here is LTR and never mirrored (spec §כללי RTL); floating text returns to RTL.
 * Physical left/right utilities are allowed ONLY inside this subtree (logical-props guard).
 * Default export → loaded through ./lazy.tsx in its own chunk.
 */
export default function SheetViewer({
  projectId,
  row,
  tool,
  onToolChange,
  tools = ["select", "lasso", "measure", "calibrate"],
  overlays,
  selectedIds,
  focusIds,
  popover,
  renderTooltip,
  zoomRequest,
  onSelect,
  onLasso,
  onMeasure,
  onCalibrate,
  initialViewMm,
  footerExtra,
  className,
}: SheetViewerProps) {
  const { t } = useTranslation();
  const ref = useRef<DrawingViewerHandle>(null);
  const [view, setView] = useState<ViewInfo | null>(null);
  const manifest = useTilesManifest(projectId, row);
  const api = useApi();
  const sheetId = row.sheet.id;
  const versionId = row.version?.id ?? "";
  // Built once per version (thumbnail refreshes don't reset the tile cache).
  const hasMeta = Boolean(manifest.data);
  const tiles = useMemo(
    () =>
      manifest.data
        ? toTileSource(manifest.data, (q) => api.getTilesManifest(projectId, sheetId, versionId, q), `${sheetId}/${versionId}`)
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasMeta, api, projectId, sheetId, versionId],
  );
  const paper = paperSize(row);
  useEffect(() => {
    if (zoomRequest) ref.current?.zoomToMm(zoomRequest.bboxMm, 48);
    // only when a new request is issued
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomRequest?.seq]);
  const name = row.sheet.title ?? row.sheet.classification?.sheetTitle ?? row.sheet.id;
  const scale = row.sheet.scaleDenominator ?? null;

  const labels = useMemo<Partial<ViewerLabels>>(
    () => ({
      minimap: t("review.minimap"),
      formatLength: (realMm, paperMm) => defaultLabels.formatLength(realMm, paperMm),
    }),
    [t],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.target as HTMLElement).closest("input, textarea, select")) return;
    const hit = tools.find((k) => TOOL_META[k].code === e.code);
    if (hit) {
      e.preventDefault();
      onToolChange(hit);
    }
  };

  const ready = row.version?.status === "ready" && paper;
  const fallback = (
    <div dir="rtl" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-dense text-muted-foreground">
      {manifest.data?.thumbnailUrl ? (
        <img src={manifest.data.thumbnailUrl} alt="" className="max-h-[70%] max-w-full rounded border border-border bg-white object-contain" />
      ) : null}
      <p>{t("viewer.noWebgl")}</p>
    </div>
  );

  return (
    <div dir="ltr" className={cn("relative flex h-full min-h-0 flex-col", className)} onKeyDown={onKeyDown}>
      <div className="relative min-h-0 flex-1">
        {ready ? (
          <DrawingViewer
            ref={ref}
            sheet={paper}
            tiles={tiles}
            sheetKey={`${row.sheet.id}/${row.version?.id}`}
            overlays={overlays}
            selectedIds={selectedIds}
            focusIds={focusIds}
            popover={popover}
            renderTooltip={renderTooltip}
            tool={tool}
            onToolChange={onToolChange}
            onSelect={onSelect}
            onLasso={onLasso}
            onMeasure={onMeasure}
            onCalibrate={onCalibrate}
            scaleDenominator={scale}
            onViewChange={setView}
            initialViewMm={initialViewMm ?? null}
            ariaLabel={t("viewer.region", { sheet: name })}
            labels={labels}
            fallback={fallback}
          />
        ) : (
          <div dir="rtl" role="status" className="paper-grid flex h-full items-center justify-center p-6 text-center text-dense text-muted-foreground">
            {row.version?.status === "failed" ? t("viewer.tilesError") : t("viewer.notReady")}
          </div>
        )}
        {manifest.isError ? (
          <p dir="rtl" role="alert" className="absolute right-3 top-3 rounded border border-destructive/30 bg-surface px-3 py-2 text-meta text-destructive">
            {t("viewer.tilesError")}
          </p>
        ) : null}

        {/* Tool rail — left edge of the canvas, not mirrored */}
        <div
          dir="rtl"
          role="toolbar"
          aria-label={t("review.tools")}
          aria-orientation="vertical"
          className="absolute left-3 top-3 z-10 flex flex-col gap-0.5 rounded border border-border bg-surface p-1 shadow-float"
        >
          {tools.map((k) => {
            const { key, icon: Icon, label } = TOOL_META[k];
            const active = tool === k;
            return (
              <button
                key={k}
                type="button"
                aria-label={`${t(label)} (${key})`}
                title={`${t(label)} · ${key}`}
                aria-pressed={active}
                aria-keyshortcuts={key}
                onClick={() => onToolChange(k)}
                className={cn(
                  "flex size-8 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground",
                  active && "bg-primary/10 text-primary",
                )}
              >
                <Icon className="size-4" aria-hidden />
              </button>
            );
          })}
        </div>
      </div>

      {/* Bottom strip: scale/zoom (labels Hebrew, layout LTR like the canvas) */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-t border-border bg-surface px-3 text-meta text-muted-foreground">
        <div className="flex items-center gap-2">
          <span className="tabular" data-testid="viewer-scale">
            {scale ? formatScale(scale) : "—"}
          </span>
          <span className="tabular" aria-live="polite" aria-label={t("viewer.zoom")} data-testid="viewer-zoom">
            {view ? `${Math.round(view.percent)}%` : "—"}
          </span>
          <button type="button" className="flex size-7 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground" aria-label={t("viewer.zoomOut")} aria-keyshortcuts="Minus" onClick={() => ref.current?.zoomBy(-1)}>
            <Minus className="size-3.5" aria-hidden />
          </button>
          <button type="button" className="flex size-7 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground" aria-label={t("viewer.zoomIn")} aria-keyshortcuts="Equal" onClick={() => ref.current?.zoomBy(1)}>
            <Plus className="size-3.5" aria-hidden />
          </button>
          <button type="button" className="inline-flex h-7 items-center gap-1 rounded-sm px-1.5 hover:bg-muted hover:text-foreground" aria-keyshortcuts="0" onClick={() => ref.current?.fit()}>
            <Maximize className="size-3.5" aria-hidden />
            <Kbd>0</Kbd>
            <span dir="rtl">{t("viewer.fit")}</span>
          </button>
        </div>
        {footerExtra}
      </div>
    </div>
  );
}

