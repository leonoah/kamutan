import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Layers } from "lucide-react";
import type { LassoResult, OverlayFeature, ViewerTool } from "@kamutan/viewer";
import type { SheetRow } from "@/api/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Ltr } from "@/components/Ltr";
import { sheetName } from "@/features/sheets/model";
import { SheetViewer } from "@/features/viewer/lazy";
import type { LifecycleVisibility } from "@/features/understanding/model";

/** "x0,y0,x1,y1" (paper mm) → bbox, for deep links like ?sheet=…&bbox=12,197,103,250 */
export function parseBBox(s: string | null): [number, number, number, number] | null {
  const n = s?.split(",").map(Number);
  return n && n.length === 4 && n.every(Number.isFinite) && n[2]! > n[0]! && n[3]! > n[1]! ? (n as [number, number, number, number]) : null;
}

export interface LayerVisibility {
  symbols: boolean;
  rooms: boolean;
  legend: boolean;
}

export interface ReviewDrawingProps {
  projectId: string;
  rows: SheetRow[];
  row: SheetRow | null;
  loading: boolean;
  onPick: (sheetId: string) => void;
  overlays: readonly OverlayFeature[];
  selectedIds: readonly string[];
  focusIds: readonly string[];
  onSelect: (ids: string[], opts: { additive: boolean }) => void;
  onLasso: (r: LassoResult) => void;
  popover: { anchorMm: readonly [number, number]; content: ReactNode; label: string } | null;
  renderTooltip: (id: string) => ReactNode;
  zoomRequest: { bboxMm: readonly [number, number, number, number]; seq: number } | null;
  initialViewMm: [number, number, number, number] | null;
  lifecycles: LifecycleVisibility;
  onLifecycles: (v: LifecycleVisibility) => void;
  layers: LayerVisibility;
  onLayers: (v: LayerVisibility) => void;
  /** Per-sheet open-item counts for the picker (spec: "מונה פריטים פתוחים לכל גיליון"). */
  openCount: (row: SheetRow) => number | null;
}

/**
 * Center pane of S10: sheet selector + layer toggles + the tiled viewer with the Sprint-2 overlay
 * (detections ●▲◆◇, rooms, legend boxes) and the קיים / חדש / להריסה toggle.
 */
export function ReviewDrawing(p: ReviewDrawingProps) {
  const { t } = useTranslation();
  const [tool, setTool] = useState<ViewerTool>("select");
  const { row } = p;

  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 text-dense">
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={p.rows.length === 0}
            aria-label={t("viewer.sheetPicker")}
            className="inline-flex h-7 max-w-[55%] items-center gap-1 rounded-sm border border-input px-2 text-foreground hover:bg-muted disabled:opacity-50"
          >
            <span className="shrink-0">{t("review.sheet")}:</span>
            <bdi className="truncate">{row ? sheetName(row) : "—"}</bdi>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-[60vh] overflow-auto">
            <DropdownMenuRadioGroup value={row?.sheet.id ?? ""} onValueChange={p.onPick}>
              {p.rows.map((r) => {
                const open = p.openCount(r);
                return (
                  <DropdownMenuRadioItem key={r.sheet.id} value={r.sheet.id}>
                    <span className="flex flex-col">
                      <bdi>{sheetName(r)}</bdi>
                      <span className="text-meta text-muted-foreground">
                        {r.sheet.discipline ? t(`disciplines.${r.sheet.discipline}`, { defaultValue: r.sheet.discipline }) : "—"}
                        {r.sheet.scaleDenominator ? (
                          <>
                            {" · "}
                            <Ltr>{`1:${r.sheet.scaleDenominator}`}</Ltr>
                          </>
                        ) : null}
                        {open ? ` · ${t("review.toReview", { count: open })}` : null}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                );
              })}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <fieldset className="ms-auto flex items-center gap-2.5 text-meta">
          <legend className="sr-only">{t("understanding.layers")}</legend>
          <Layers className="size-3.5 text-muted-foreground" aria-hidden />
          {(["symbols", "rooms", "legend"] as const).map((k) => (
            <label key={k} className="inline-flex cursor-pointer items-center gap-1 text-foreground">
              <input
                type="checkbox"
                checked={p.layers[k]}
                onChange={(e) => p.onLayers({ ...p.layers, [k]: e.target.checked })}
                className="size-3.5 accent-[rgb(var(--primary))]"
              />
              {t(`understanding.layer${k[0]!.toUpperCase()}${k.slice(1)}`)}
            </label>
          ))}
        </fieldset>
      </div>
      <div dir="ltr" className="min-h-0 flex-1">
        {row ? (
          <SheetViewer
            key={row.sheet.id}
            projectId={p.projectId}
            row={row}
            tool={tool}
            onToolChange={setTool}
            overlays={p.overlays}
            selectedIds={p.selectedIds}
            focusIds={p.focusIds}
            popover={p.popover}
            renderTooltip={p.renderTooltip}
            zoomRequest={p.zoomRequest}
            onSelect={p.onSelect}
            onLasso={p.onLasso}
            initialViewMm={p.initialViewMm}
            footerExtra={<LifecycleToggle value={p.lifecycles} onChange={p.onLifecycles} />}
          />
        ) : (
          <div dir="rtl" role="status" className="paper-grid flex h-full items-center justify-center p-6 text-center text-dense text-muted-foreground">
            {p.loading ? t("common.loading") : t("viewer.notReady")}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * קיים / חדש / להריסה (spec §שכבות קיים / חדש / להריסה): default "חדש" on; a layer that is off is dimmed to
 * 35%, not hidden. Each state also has its own line style on the markers (dashed grey / dashed red + strike).
 */
function LifecycleToggle({ value, onChange }: { value: LifecycleVisibility; onChange: (v: LifecycleVisibility) => void }) {
  const { t } = useTranslation();
  const items = [
    { id: "existing", label: t("review.stateExisting"), swatch: "border-dashed border-state-existing" },
    { id: "new", label: t("review.stateNew"), swatch: "border-solid border-conf-high" },
    { id: "demolish", label: t("review.stateDemolish"), swatch: "border-dashed border-state-demolish" },
  ] as const;
  return (
    <fieldset dir="rtl" className="flex items-center gap-3">
      <legend className="sr-only">{t("review.layers")}</legend>
      {items.map((s) => (
        <label key={s.id} className="inline-flex cursor-pointer items-center gap-1.5 text-foreground">
          <input
            type="checkbox"
            checked={value[s.id]}
            onChange={(e) => onChange({ ...value, [s.id]: e.target.checked })}
            className="size-3.5 accent-[rgb(var(--primary))]"
          />
          <span aria-hidden className={`inline-block size-3 rounded-full border-2 ${s.swatch}`} />
          {s.label}
        </label>
      ))}
    </fieldset>
  );
}
