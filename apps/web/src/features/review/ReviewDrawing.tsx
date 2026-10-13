import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import type { ViewerTool } from "@kamutan/viewer";
import type { SheetRow } from "@/api/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { Ltr } from "@/components/Ltr";
import { useLiveSheets } from "@/features/realtime/hooks";
import { regionOverlays, sheetName } from "@/features/sheets/model";
import { SheetViewer } from "@/features/viewer/lazy";

/** "x0,y0,x1,y1" (paper mm) → bbox, for deep links like ?sheet=…&bbox=12,197,103,250 */
function parseBBox(s: string | null): [number, number, number, number] | null {
  const n = s?.split(",").map(Number);
  return n && n.length === 4 && n.every(Number.isFinite) && n[2]! > n[0]! && n[3]! > n[1]! ? (n as [number, number, number, number]) : null;
}

/** Order for the picker: electrical first (the S10 sample chapter is "עבודות חשמל"), then the rest. */
const rank = (r: SheetRow) => (r.sheet.discipline === "electrical" ? 0 : r.sheet.discipline === "lighting" ? 1 : 2);

/**
 * Center pane of S10: sheet selector + the real tiled viewer for the selected sheet.
 * Selected sheet and view box are kept in the URL (?sheet=&bbox=) so a view can be shared internally.
 */
export function ReviewDrawing({ orgId, projectId }: { orgId: string | null; projectId: string }) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const sheets = useLiveSheets(orgId, projectId);
  const [tool, setTool] = useState<ViewerTool>("select");
  const [selected, setSelected] = useState<string[]>([]);

  const ready = useMemo(
    () =>
      (sheets.data ?? [])
        .filter((r) => r.version?.status === "ready")
        .sort((a, b) => rank(a) - rank(b) || sheetName(a).localeCompare(sheetName(b), "he")),
    [sheets.data],
  );
  const wanted = params.get("sheet");
  const row = ready.find((r) => r.sheet.id === wanted) ?? ready[0] ?? null;
  const bbox = row && row.sheet.id === wanted ? parseBBox(params.get("bbox")) : null;
  const floorLabel = (f: string) => t(`floors.${f}`, { defaultValue: f });
  const overlays = useMemo(() => regionOverlays(row?.version?.regions ?? [], floorLabel), [row, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("sheet", id);
    next.delete("bbox");
    setParams(next, { replace: true });
    setSelected([]);
  };

  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 text-dense">
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={ready.length === 0}
            aria-label={t("viewer.sheetPicker")}
            className="inline-flex h-7 max-w-[60%] items-center gap-1 rounded-sm border border-input px-2 text-foreground hover:bg-muted disabled:opacity-50"
          >
            <span className="shrink-0">{t("review.sheet")}:</span>
            <bdi className="truncate">{row ? sheetName(row) : "—"}</bdi>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-[60vh] overflow-auto">
            <DropdownMenuRadioGroup value={row?.sheet.id ?? ""} onValueChange={pick}>
              {ready.map((r) => (
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
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="ms-auto text-meta text-muted-foreground">
          {t("review.drawingPanel")} · <Ltr>LTR</Ltr>
        </span>
      </div>
      <div dir="ltr" className="min-h-0 flex-1">
        {row ? (
          <SheetViewer
            key={row.sheet.id}
            projectId={projectId}
            row={row}
            tool={tool}
            onToolChange={setTool}
            overlays={overlays}
            selectedIds={selected}
            onSelect={(ids, { additive }) => setSelected((cur) => (additive ? [...new Set([...cur, ...ids])] : ids))}
            onLasso={(r) => {
              setSelected(r.ids);
              toast({ title: t("viewer.lassoResult", { count: r.ids.length }) });
            }}
            onCalibrate={(r) => toast({ title: t("sheets.scaleUpdated", { scale: `⁨1:${r.denominator}⁩` }), tone: "success" })}
            initialViewMm={bbox}
            footerExtra={<LifecycleToggle />}
          />
        ) : (
          <div dir="rtl" role="status" className="paper-grid flex h-full items-center justify-center p-6 text-center text-dense text-muted-foreground">
            {sheets.isLoading ? t("common.loading") : t("viewer.notReady")}
          </div>
        )}
      </div>
    </>
  );
}

/** קיים / חדש / להריסה toggle (spec §שכבות). Visual only until detections land (Sprint 2). */
function LifecycleToggle() {
  const { t } = useTranslation();
  return (
    <fieldset dir="rtl" className="flex items-center gap-3">
      <legend className="sr-only">{t("review.layers")}</legend>
      {[
        { id: "new", label: t("review.stateNew"), checked: true },
        { id: "existing", label: t("review.stateExisting"), checked: false },
        { id: "demolish", label: t("review.stateDemolish"), checked: false },
      ].map((s) => (
        <label key={s.id} className="inline-flex cursor-pointer items-center gap-1.5 text-foreground">
          <input type="checkbox" defaultChecked={s.checked} className="size-3.5 accent-[rgb(var(--primary))]" />
          {s.label}
        </label>
      ))}
    </fieldset>
  );
}
