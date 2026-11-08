import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertCircle, ChevronLeft, Loader2, MoreHorizontal, Trash2 } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { SheetRow } from "@/api/types";
import { Progress } from "@/components/ui/progress";
import { SectionProgress } from "@/components/SectionProgress";
import { Ltr } from "@/components/Ltr";
import { cn } from "@/lib/utils";
import { SheetThumb } from "@/features/sheets/SheetThumb";
import { sheetName, uncertainFields } from "@/features/sheets/model";
import { qualityFlag, qualityOf } from "@/features/quality/model";
import { QualityBadge, QualityIssueList } from "@/features/quality/QualityNotice";

export type SheetState = "processing" | "failed" | "toConfirm" | "ready";

export function sheetState(r: SheetRow): SheetState {
  const s = r.version?.status ?? "queued";
  if (s === "failed") return "failed";
  if (s !== "ready") return "processing";
  return r.sheet.confirmed ? "ready" : "toConfirm";
}

/**
 * Project hub — the drawings gallery. One tile per sheet; a ready tile opens the sheet analysis screen
 * (`/projects/:id/sheets/:sheetId`), an unconfirmed one points at the confirm step.
 */
export function SheetGallery({
  projectId,
  rows,
  selectedId,
  onSelect,
  setName,
  onDeleteSet,
}: {
  projectId: string;
  rows: SheetRow[];
  /** Sheet currently used to filter the BOQ column (hub ↔ BOQ coupling). */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Sprint 8: name of a sheet set (the file) — the tile menu deletes the whole set. */
  setName?: (setId: string) => string;
  /** Sprint 8 (editor+): delete the sheet set this sheet belongs to. */
  onDeleteSet?: ((setId: string) => void) | undefined;
}) {
  const { t } = useTranslation();
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3" aria-label={t("hub.sheets")}>
      {rows.map((r) => (
        <li key={r.sheet.id}>
          <SheetTile projectId={projectId} row={r} selected={selectedId === r.sheet.id} onSelect={onSelect} setName={setName?.(r.sheet.sheetSetId) ?? r.sheet.sheetSetId} onDeleteSet={onDeleteSet} />
        </li>
      ))}
    </ul>
  );
}

function SheetTile({
  projectId,
  row,
  selected,
  onSelect,
  setName,
  onDeleteSet,
}: {
  projectId: string;
  row: SheetRow;
  selected: boolean;
  onSelect: (id: string | null) => void;
  setName: string;
  onDeleteSet?: ((setId: string) => void) | undefined;
}) {
  const { t } = useTranslation();
  const name = sheetName(row);
  const state = sheetState(row);
  const v = row.version;
  // Sprint 9: input-quality gate — a rejected sheet shows no counts (the drawing still opens); warn shows the issue.
  const qFlag = state === "ready" || state === "toConfirm" ? qualityFlag(v) : null;
  const quality = qFlag ? qualityOf(v) : null;
  const det = qFlag === "reject" ? undefined : v?.stats?.detections;
  const floors = row.sheet.floors ?? [];
  const discipline = row.sheet.discipline ? t(`disciplines.${row.sheet.discipline}`, { defaultValue: row.sheet.discipline }) : null;
  const analyzeHref = `/projects/${projectId}/sheets/${row.sheet.id}`;
  // A sheet can be analysed before it is confirmed; the footer action still nudges to the confirm step first.
  const ctaHref = state === "toConfirm" ? `/projects/${projectId}/sheets` : analyzeHref;
  const openable = state === "ready" || state === "toConfirm";
  // A-UI-19: floors the system is unsure about (e.g. they contradict the title) are marked until the sheet is confirmed.
  const floorsUnsure = !row.sheet.confirmed && uncertainFields(row).has("floors") && floors.length > 0;
  const floorHint = floorsUnsure
    ? row.sheet.classification?.reasons.includes("FLOOR_TITLE_MISMATCH")
      ? t("reasons.FLOOR_TITLE_MISMATCH")
      : t("hub.floorsUnsure")
    : undefined;

  return (
    <article
      aria-label={name}
      data-sheet={row.sheet.id}
      data-state={state}
      data-quality={qFlag ?? undefined}
      className={cn(
        "group flex h-full flex-col overflow-hidden rounded-lg border bg-surface transition-colors",
        selected ? "border-primary ring-2 ring-primary/30" : "border-border hover:border-foreground/30",
      )}
    >
      {/* Thumbnail: click = filter the BOQ by this sheet; the title link = open the analysis. */}
      <div className="relative">
      <button
        type="button"
        onClick={() => onSelect(selected ? null : row.sheet.id)}
        aria-pressed={selected}
        aria-label={t("hub.filterBySheetState", { state: t(`hub.sheetState.${state}`), name })}
        className="relative block w-full border-b border-border text-start outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {state === "processing" || state === "failed" ? (
          <div className="flex aspect-[4/3] items-center justify-center bg-surface-sunken">
            {state === "failed" ? (
              <AlertCircle className="size-6 text-destructive" aria-hidden />
            ) : (
              <Loader2 className="size-6 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
            )}
          </div>
        ) : (
          <SheetThumb projectId={projectId} row={row} name={name} />
        )}
        <span
          title={state === "failed" ? t(`project.errors.${v?.error?.code ?? "internal"}`, { defaultValue: t("project.errors.internal") }) : undefined}
          className={cn(
            "absolute top-1.5 start-1.5 rounded-sm px-1.5 py-0.5 text-meta font-medium",
            state === "ready" && "bg-conf-high/15 text-conf-high",
            state === "toConfirm" && "bg-conf-mid/15 text-foreground",
            state === "processing" && "bg-surface/90 text-muted-foreground",
            state === "failed" && "bg-destructive/10 text-destructive",
          )}
        >
          {t(`hub.sheetState.${state}`)}
        </span>
      </button>
      {/* Sprint 9: outside the button (its accessible name is the filter action), above the thumbnail. */}
      {qFlag ? <QualityBadge status={qFlag} className="pointer-events-none absolute bottom-1.5 start-1.5 shadow-sm" /> : null}
      </div>

      <div className="relative flex flex-1 flex-col gap-2 p-3">
        {onDeleteSet ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-tile-menu={row.sheet.id}
                aria-label={t("deletes.setMenu", { name })}
                className="absolute end-1.5 top-1.5 inline-flex size-7 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <MoreHorizontal className="size-4" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onDeleteSet(row.sheet.sheetSetId)} className="text-destructive" data-delete-set={row.sheet.sheetSetId}>
                <Trash2 className="size-4" aria-hidden />
                {t("deletes.deleteSet")}
                <span className="sr-only"> · {setName}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <h3 className={cn("min-w-0 text-body font-medium text-foreground", onDeleteSet && "pe-7")}>
          {openable ? (
            <Link to={analyzeHref} className="rounded outline-none hover:text-primary hover:underline focus-visible:ring-2 focus-visible:ring-primary">
              <bdi className="line-clamp-2">{name}</bdi>
            </Link>
          ) : (
            <bdi className="line-clamp-2">{name}</bdi>
          )}
        </h3>
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-meta text-muted-foreground">
          {discipline ? <span>{discipline}</span> : null}
          {floors.length ? (
            <span data-floors-unsure={floorsUnsure || undefined} title={floorHint}>
              · {floors.map((f) => t(`floors.${f}`, { defaultValue: f })).join(", ")}
              {floorsUnsure ? (
                <>
                  {" "}
                  <span aria-hidden className="text-conf-mid">◆</span>
                  <span className="sr-only">({floorHint})</span>
                </>
              ) : null}
            </span>
          ) : null}
          {row.sheet.scaleDenominator ? (
            <span>
              · <Ltr>{`1:${row.sheet.scaleDenominator}`}</Ltr>
            </span>
          ) : null}
        </p>

        {state === "processing" && v?.progress ? (
          <div className="flex flex-col gap-1">
            <span className="text-meta text-muted-foreground">{t(`project.stage.${v.progress.stage}`, { defaultValue: t("project.versionStatus.processing") })}</span>
            <Progress value={v.progress.pct} aria-label={t("project.sheetProgressLabel", { name, stage: "" })} />
          </div>
        ) : null}
        {quality ? (
          <div className="flex flex-col gap-0.5" data-tile-quality>
            {qFlag === "reject" ? <span className="text-meta font-medium text-destructive">{t("quality.tileNotCounted")}</span> : null}
            <QualityIssueList quality={quality} compact className="text-muted-foreground" />
          </div>
        ) : null}
        {state === "ready" && det ? (
          <div className="mt-auto flex flex-col gap-1">
            <div className="flex items-center justify-between text-meta text-muted-foreground">
              <span>{t("hub.itemsCount", { count: det.total })}</span>
              {det.red + det.unknown > 0 ? <span className="text-conf-low">{t("projects.toReview", { count: det.red + det.unknown })}</span> : null}
            </div>
            <SectionProgress high={det.green} mid={det.yellow} low={det.red + det.unknown} />
          </div>
        ) : null}
        {openable ? (
          <Link
            to={ctaHref}
            className="mt-auto inline-flex items-center gap-1 self-end rounded text-dense font-medium text-primary hover:underline"
          >
            {state === "toConfirm" ? t("hub.confirmSheet") : t("hub.analyze")}
            <ChevronLeft className="size-4 ltr:rotate-180" aria-hidden />
          </Link>
        ) : null}
      </div>
    </article>
  );
}
