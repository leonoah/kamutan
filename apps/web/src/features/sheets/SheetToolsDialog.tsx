import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import type { CalibrationResult, LassoResult, ViewerTool } from "@kamutan/viewer";
import type { SheetRegion, SheetRow } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { SheetViewer } from "@/features/viewer/lazy";
import { FLOORS, regionColor, regionOverlays, sheetName, toRegionPolygon, type SheetDraft } from "./model";
import { useSaveRegions } from "./queries";

export type SheetToolsMode = "split" | "calibrate";

/**
 * Opens the real viewer for one sheet:
 *  - "split" (פיצול לקומות): lasso a region per floor plan on a multi-floor sheet → version.regions
 *  - "calibrate" (כייל בשתי לחיצות): 2 clicks + real length → scale denominator for the card draft
 */
export function SheetToolsDialog({
  projectId,
  row,
  mode,
  draft,
  onClose,
  onScale,
}: {
  projectId: string;
  row: SheetRow;
  mode: SheetToolsMode;
  draft: SheetDraft;
  onClose: () => void;
  onScale: (denominator: number) => void;
}) {
  const { t } = useTranslation();
  const name = sheetName(row);
  const scale = Math.round(Number(draft.scale)) || row.sheet.scaleDenominator || 50;
  const [tool, setTool] = useState<ViewerTool>(mode === "split" ? "lasso" : "calibrate");
  const [regions, setRegions] = useState<SheetRegion[]>(() => structuredClone(row.version?.regions ?? []));
  const save = useSaveRegions(projectId);
  const floorLabel = (f: string) => t(`floors.${f}`, { defaultValue: f });

  useEffect(() => setTool(mode === "split" ? "lasso" : "calibrate"), [mode]);

  const overlays = useMemo(() => regionOverlays(regions, floorLabel), [regions, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const onLasso = (r: LassoResult) => {
    const used = new Set(regions.map((x) => x.floor));
    const floor = draft.floors.find((f) => !used.has(f)) ?? draft.floors[0] ?? "ground";
    const nextId = `r${regions.reduce((m, x) => Math.max(m, Number(x.id.replace(/\D/g, "")) || 0), 0) + 1}`;
    setRegions((rs) => [...rs, { id: nextId, floor, polygonMm: toRegionPolygon(r.polygonMm), scaleDenominator: scale }]);
  };

  const onCalibrate = (r: CalibrationResult) => {
    onScale(r.denominator);
    toast({ title: t("sheets.scaleUpdated", { scale: `⁨1:${r.denominator}⁩` }), tone: "success" });
    onClose();
  };

  const onSave = async () => {
    await save.mutateAsync({ sheetId: row.sheet.id, regions });
    toast({ title: t("sheets.regionsSaved"), tone: "success" });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="top-[4vh] flex h-[92vh] max-w-[min(1400px,calc(100vw-2rem))] flex-col p-4">
        <DialogHeader className="mb-3">
          <DialogTitle>{mode === "split" ? t("sheets.splitTitle", { name }) : t("sheets.calibrateTitle", { name })}</DialogTitle>
          <DialogDescription>{mode === "split" ? t("sheets.splitHelp") : t("sheets.calibrateHelp")}</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(220px,260px)_1fr] gap-3">
          {/* RTL: first column = right side */}
          <section aria-label={t("sheets.regions")} className="flex min-h-0 flex-col gap-2 overflow-auto">
            {mode === "split" ? (
              <>
                <h3 className="text-dense font-bold text-foreground">{t("sheets.regions")}</h3>
                {regions.length === 0 ? <p className="text-dense text-muted-foreground">{t("sheets.noRegions")}</p> : null}
                <ol className="flex flex-col gap-2">
                  {regions.map((r, i) => {
                    const label = t("sheets.regionN", { n: i + 1 });
                    return (
                      <li key={r.id} className="flex items-center gap-2 rounded border border-border p-2" data-region={r.id}>
                        <span aria-hidden className="size-3 shrink-0 rounded-sm" style={{ background: regionColor(i) }} />
                        <span className="text-dense text-foreground">{label}</span>
                        <select
                          aria-label={`${t("sheets.regionFloor")} ${label}`}
                          value={r.floor}
                          onChange={(e) => setRegions((rs) => rs.map((x) => (x.id === r.id ? { ...x, floor: e.target.value } : x)))}
                          className="h-8 min-w-0 flex-1 rounded border border-input bg-surface px-1.5 text-dense"
                        >
                          {FLOORS.map((f) => (
                            <option key={f} value={f}>
                              {t(`floors.${f}`)}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          aria-label={t("sheets.removeRegion", { name: label })}
                          onClick={() => setRegions((rs) => rs.filter((x) => x.id !== r.id))}
                          className="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </>
            ) : (
              <p className="text-dense text-muted-foreground">{t("sheets.calibrateHelp")}</p>
            )}
          </section>
          <div className="min-h-0 overflow-hidden rounded border border-border">
            <SheetViewer
              projectId={projectId}
              row={row}
              tool={tool}
              onToolChange={setTool}
              tools={mode === "split" ? ["select", "lasso", "measure"] : ["select", "calibrate", "measure"]}
              overlays={overlays}
              onLasso={onLasso}
              onCalibrate={onCalibrate}
            />
          </div>
        </div>
        <DialogFooter className="mt-3">
          {mode === "split" ? (
            <Button onClick={onSave} disabled={save.isPending}>
              {t("sheets.saveRegions")}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            {t("createProject.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
