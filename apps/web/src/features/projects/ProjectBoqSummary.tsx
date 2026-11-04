import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronLeft, Eye, Hammer, Loader2, RefreshCw, X } from "lucide-react";
import type { BoqLine, SheetRow } from "@/api/types";
import { Button } from "@/components/ui/button";
import { ConfidenceShape, levelFromDb } from "@/components/ConfidenceBadge";
import { SectionProgress } from "@/components/SectionProgress";
import { Ltr } from "@/components/Ltr";
import { formatQuantity } from "@/lib/format";
import { cn } from "@/lib/utils";
import { canEditQty, chapterLabel, effectiveQty, groupByChapter, statsOf } from "@/features/boq/model";
import { coverageOf, lineNeedsInput, quickActionOf } from "@/features/boq/sprint6";
import { CoverageText, NeedsInputChip } from "@/features/boq/Sprint6Parts";
import { isBuildActive, useBoqBuild, useBoqLines, useBoqState, useBuildBoq } from "@/features/boq/queries";
import { sheetName } from "@/features/sheets/model";
import { LibraryNotice } from "@/features/boq/LibraryNotice";
import { useCurrentOrg } from "@/features/org/useCurrentOrg";
import { LineDescription } from "@/features/boq/LineDescription";
import { canRenameLine, lineDescription } from "@/features/boq/sprint7";

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
  const role = useCurrentOrg().org?.role ?? "viewer";
  const state = useBoqState(orgId, projectId);
  const buildId = state.data?.latestBuildId ?? null;
  const build = useBoqBuild(orgId, projectId, buildId);
  const linesQ = useBoqLines(projectId, buildId);
  const buildBoq = useBuildBoq(projectId);
  const building = buildBoq.isPending || isBuildActive(build.data);

  const all = linesQ.data?.items ?? [];
  // Sprint 6: "להשלמה ידנית" filter (suggested lines waiting for a measure / count / confirm)
  const [onlyNeeds, setOnlyNeeds] = useState(false);
  const bySheet = useMemo<BoqLine[]>(
    () => (filterSheet ? all.filter((l) => l.sourceVersions.some((s) => s.sheetId === filterSheet.sheet.id)) : all),
    [all, filterSheet],
  );
  const needsCount = useMemo(() => bySheet.filter(lineNeedsInput).length, [bySheet]);
  const lines = useMemo(() => (onlyNeeds && needsCount ? bySheet.filter(lineNeedsInput) : bySheet), [bySheet, onlyNeeds, needsCount]);
  const canQuick = canEditQty(role);
  const canRename = canRenameLine(role);
  const chapters = useMemo(() => groupByChapter(lines, linesQ.data?.chapters ?? []), [lines, linesQ.data?.chapters]);
  const total = statsOf(lines);
  const reviewHref = `/projects/${projectId}/review${filterSheet ? `?sheet=${encodeURIComponent(filterSheet.sheet.id)}` : ""}`;

  return (
    <section aria-labelledby="hub-boq-title" className="flex min-h-0 flex-col rounded-lg border border-border bg-surface">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
        <div className="min-w-[9rem] flex-1">
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
        {buildId && needsCount ? (
          <button
            type="button"
            aria-pressed={onlyNeeds}
            data-filter-needs-input
            title={t("boq.needsInputFilter")}
            onClick={() => setOnlyNeeds((v) => !v)}
            className={cn(
              "inline-flex h-7 shrink-0 items-center rounded-sm border border-dashed border-conf-low/60 px-2 text-meta text-foreground hover:bg-conf-low/10",
              onlyNeeds && "border-solid bg-conf-low/[0.12] font-medium",
            )}
          >
            {t("hub.needsInputOnly", { count: needsCount })}
          </button>
        ) : null}
        {buildId ? (
          <Button size="sm" variant="ghost" asChild>
            <Link to={`/projects/${projectId}/boq/preview`} data-preview-link aria-label={t("hub.previewFull")} title={t("hub.previewFull")}>
              <Eye aria-hidden />
              <span className="max-sm:sr-only">{t("hub.preview")}</span>
            </Link>
          </Button>
        ) : null}
        {buildId ? (
          <Button size="sm" variant="secondary" asChild>
            <Link to={reviewHref}>
              {t("hub.openReview")}
              <ChevronLeft className="ltr:rotate-180" aria-hidden />
            </Link>
          </Button>
        ) : null}
      </header>

      <LibraryNotice orgId={orgId} canImport={role === "admin" || role === "editor"} variant="card" />

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
                    {chapterLabel(c.code, c.title)}
                  </span>
                  <span className="ms-auto text-meta text-muted-foreground">
                    <Ltr>{`${c.stats.pct}%`}</Ltr> · {t("hub.linesCount", { count: c.lines.length })}
                  </span>
                </summary>
                <CoverageText c={coverageOf(c.lines)} className="block px-4 pb-1.5" />
                <table className="w-full table-fixed text-dense">
                  {/* explicit widths: table-fixed takes them from the first row, which is the sr-only header */}
                  <colgroup>
                    <col className="w-8" />
                    <col className="w-14" />
                    <col />
                    <col className="w-14" />
                    <col className="w-16" />
                  </colgroup>
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
                    {c.lines.map((l) => {
                      const waiting = lineNeedsInput(l);
                      const qa = waiting && canQuick ? quickActionOf(l) : null;
                      return (
                      <tr key={l.id} data-code={l.code} data-line={l.id} data-needs-input={waiting || undefined} className="group/line h-8 border-t border-border/60 align-top hover:bg-surface-sunken/50">
                        <td className="w-6 ps-4 pt-2.5">
                          <ConfidenceShape level={levelFromDb(l.level)} className="size-2.5" />
                        </td>
                        <td className="w-14 py-1.5 text-muted-foreground">
                          <Ltr>{l.code}</Ltr>
                        </td>
                        {/* Two lines, not one: lines like 3.02 / 3.03 / 3.11 differ only after the shared prefix (A-UI-17). */}
                        <td className="py-1.5 pe-2 text-foreground" title={lineDescription(l)}>
                          <LineDescription projectId={projectId} line={l} canEdit={canRename} variant="hub" />
                          {waiting ? (
                            <span className="mt-1 flex flex-wrap items-center gap-1">
                              <NeedsInputChip />
                              {l.reasons?.[0] ? <span className="text-[11px] leading-tight text-muted-foreground">{l.reasons[0]}</span> : null}
                              {qa ? (
                                <Link
                                  to={`/projects/${projectId}/review?line=${encodeURIComponent(l.id)}&quick=1`}
                                  data-quick-action={qa.kind}
                                  data-quick-for={l.id}
                                  className="inline-flex h-6 items-center whitespace-nowrap rounded-sm border border-primary/40 px-1.5 text-[11px] font-medium text-primary hover:bg-primary/10"
                                >
                                  {t(`boq.quick.${qa.kind}`)}{" "}
                                  <span className="sr-only">{t("boq.quickFor", { code: l.code })}</span>
                                </Link>
                              ) : null}
                            </span>
                          ) : null}
                        </td>
                        <td className="w-12 py-1.5 text-muted-foreground">{l.unit}</td>
                        <td className={cn("w-16 py-1.5 pe-4 text-end font-medium tabular-nums text-foreground", l.qtyOverride != null && "text-manual")}>
                          {waiting && !l.qty ? (
                            <span className="text-muted-foreground">
                              <span aria-hidden>—</span>
                              <span className="sr-only">{t("boq.noQty")}</span>
                            </span>
                          ) : (
                            <Ltr>{formatQuantity(effectiveQty(l), l.unit)}</Ltr>
                          )}
                        </td>
                      </tr>
                      );
                    })}
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
