import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronLeft, Hammer, Loader2, RefreshCw, X } from "lucide-react";
import type { BoqLine, SheetRow } from "@/api/types";
import { Button } from "@/components/ui/button";
import { ConfidenceShape, levelFromDb } from "@/components/ConfidenceBadge";
import { SectionProgress } from "@/components/SectionProgress";
import { Ltr } from "@/components/Ltr";
import { formatQuantity } from "@/lib/format";
import { cn } from "@/lib/utils";
import { effectiveQty, groupByChapter, statsOf } from "@/features/boq/model";
import { isBuildActive, useBoqBuild, useBoqLines, useBoqState, useBuildBoq } from "@/features/boq/queries";
import { sheetName } from "@/features/sheets/model";

/**
 * Project hub — the BOQ column. One bill of quantities per project (that is how builds work), optionally
 * filtered to the sheet selected in the gallery, so "a BOQ per drawing" is one click away.
 */
export function ProjectBoqSummary({
  orgId,
  projectId,
  canBuild,
  readySheets,
  filterSheet,
  onClearFilter,
}: {
  orgId: string | null;
  projectId: string;
  canBuild: boolean;
  readySheets: number;
  filterSheet: SheetRow | null;
  onClearFilter: () => void;
}) {
  const { t } = useTranslation();
  const state = useBoqState(orgId, projectId);
  const buildId = state.data?.latestBuildId ?? null;
  const build = useBoqBuild(orgId, projectId, buildId);
  const linesQ = useBoqLines(projectId, buildId);
  const buildBoq = useBuildBoq(projectId);
  const building = buildBoq.isPending || isBuildActive(build.data);

  const all = linesQ.data?.items ?? [];
  const lines = useMemo<BoqLine[]>(
    () => (filterSheet ? all.filter((l) => l.sourceVersions.some((s) => s.sheetId === filterSheet.sheet.id)) : all),
    [all, filterSheet],
  );
  const chapters = useMemo(() => groupByChapter(lines, linesQ.data?.chapters ?? []), [lines, linesQ.data?.chapters]);
  const total = statsOf(lines);
  const reviewHref = `/projects/${projectId}/review${filterSheet ? `?sheet=${encodeURIComponent(filterSheet.sheet.id)}` : ""}`;

  return (
    <section aria-labelledby="hub-boq-title" className="flex min-h-0 flex-col rounded-lg border border-border bg-surface">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 id="hub-boq-title" className="text-panel text-foreground">
            {t("hub.boq")}
          </h2>
          {buildId && lines.length ? (
            <p className="mt-0.5 text-meta text-muted-foreground">
              {t("hub.boqMeta", { lines: lines.length, pct: total.pct })}
              {state.data?.stale ? ` · ${t("hub.boqStale")}` : ""}
            </p>
          ) : null}
        </div>
        {buildId ? (
          <Button size="sm" variant="secondary" asChild>
            <Link to={reviewHref}>
              {t("hub.openReview")}
              <ChevronLeft className="ltr:rotate-180" aria-hidden />
            </Link>
          </Button>
        ) : null}
      </header>

      {filterSheet ? (
        <div className="flex items-center gap-2 border-b border-border bg-primary/[0.06] px-4 py-1.5 text-dense">
          <span className="text-muted-foreground">{t("hub.filteredBy")}</span>
          <bdi className="min-w-0 truncate font-medium text-foreground">{sheetName(filterSheet)}</bdi>
          <button
            type="button"
            onClick={onClearFilter}
            className="ms-auto inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t("hub.clearFilter")}
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      ) : null}

      {!buildId ? (
        <EmptyBoq canBuild={canBuild} readySheets={readySheets} building={building} onBuild={() => buildBoq.mutate()} />
      ) : linesQ.isLoading ? (
        <p role="status" className="p-6 text-dense text-muted-foreground">
          {t("common.loading")}
        </p>
      ) : linesQ.isError ? (
        <p role="alert" className="p-6 text-dense text-destructive">
          {t("boq.loadError")}
        </p>
      ) : lines.length === 0 ? (
        <p className="p-6 text-dense text-muted-foreground">{filterSheet ? t("hub.noLinesForSheet") : t("hub.noLines")}</p>
      ) : (
        <>
          <div className="px-4 pt-3">
            <SectionProgress high={total.green} mid={total.yellow} low={total.red} />
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {chapters.map((c) => (
              <details key={c.code} open className="group border-b border-border last:border-0">
                <summary className="sticky top-0 z-10 flex cursor-pointer list-none items-center gap-2 bg-surface px-4 py-2 text-dense hover:bg-surface-sunken/60">
                  <span className="font-medium text-foreground">
                    {t("hub.chapter", { code: c.code })} · {c.title}
                  </span>
                  <span className="ms-auto text-meta text-muted-foreground">
                    <Ltr>{`${c.stats.pct}%`}</Ltr> · {t("hub.linesCount", { count: c.lines.length })}
                  </span>
                </summary>
                <table className="w-full table-fixed text-dense">
                  <thead className="sr-only">
                    <tr>
                      <th>{t("boq.columns.conf")}</th>
                      <th>{t("boq.columns.code")}</th>
                      <th>{t("boq.columns.desc")}</th>
                      <th>{t("boq.columns.unit")}</th>
                      <th>{t("boq.columns.qty")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.lines.map((l) => (
                      <tr key={l.id} className="h-8 border-t border-border/60 hover:bg-surface-sunken/50">
                        <td className="w-6 ps-4">
                          <ConfidenceShape level={levelFromDb(l.level)} className="size-2.5" />
                        </td>
                        <td className="w-14 text-muted-foreground">
                          <Ltr>{l.code}</Ltr>
                        </td>
                        <td className="truncate pe-2 text-foreground" title={l.description}>
                          {l.description}
                        </td>
                        <td className="w-12 text-muted-foreground">{l.unit}</td>
                        <td className={cn("w-16 pe-4 text-end font-medium tabular-nums text-foreground", l.qtyOverride != null && "text-manual")}>
                          <Ltr>{formatQuantity(effectiveQty(l), l.unit)}</Ltr>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            ))}
          </div>
          {state.data?.stale && canBuild ? (
            <footer className="flex items-center gap-2 border-t border-border px-4 py-2 text-meta text-muted-foreground">
              <span className="flex-1">{t("hub.boqStaleHint")}</span>
              <Button size="sm" variant="ghost" onClick={() => buildBoq.mutate()} disabled={building}>
                {building ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
                {t("hub.rebuild")}
              </Button>
            </footer>
          ) : null}
        </>
      )}
    </section>
  );
}

function EmptyBoq({ canBuild, readySheets, building, onBuild }: { canBuild: boolean; readySheets: number; building: boolean; onBuild: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Hammer className="size-6" aria-hidden />
      </span>
      <p className="text-body font-medium text-foreground">{readySheets ? t("hub.noBoqTitle") : t("hub.noBoqNoSheets")}</p>
      <p className="max-w-xs text-dense text-muted-foreground">{readySheets ? t("hub.noBoqBody") : t("hub.noBoqNoSheetsBody")}</p>
      {canBuild && readySheets ? (
        <Button onClick={onBuild} disabled={building}>
          {building ? <Loader2 className="animate-spin" aria-hidden /> : <Hammer aria-hidden />}
          {building ? t("hub.building") : t("hub.build")}
        </Button>
      ) : null}
    </div>
  );
}
