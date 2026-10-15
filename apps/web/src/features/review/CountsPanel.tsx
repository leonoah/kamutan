import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ConfidenceShape } from "@/components/ConfidenceBadge";
import { ConfidenceBadge } from "@/components/ConfidenceBadge";
import { SectionProgress } from "@/components/SectionProgress";
import { Ltr } from "@/components/Ltr";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { uiLevel, type ClassCount } from "@/features/understanding/model";
import { className } from "@/features/understanding/taxonomy";

const stripe = { green: "bg-transparent", yellow: "bg-conf-mid", red: "bg-conf-low", unknown: "bg-conf-unknown" } as const;

/**
 * "ספירה לפי סוג" — the secondary tab of the BOQ panel (Sprint 3): — detections of the current sheet grouped by
 * class, counts by confidence level (● ▲ ◆ ◇). A row is a toggle: selecting it focuses that class on the drawing
 * (everything else dims) and clicking a marker selects its row (bidirectional, spec §הדגשה דו-כיוונית).
 */
export function CountsPanel({
  counts,
  selectedClass,
  onSelectClass,
  legendLabel,
  legendThumb,
  loading,
  error,
  filtered,
  onClearFilters,
}: {
  counts: ClassCount[];
  selectedClass: string | null;
  onSelectClass: (cls: string | null) => void;
  legendLabel: (entryId: string | null) => string | null;
  legendThumb: (entryId: string | null) => string | null;
  loading: boolean;
  error: boolean;
  filtered: boolean;
  onClearFilters: () => void;
}) {
  const { t } = useTranslation();
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const totals = counts.reduce(
    (a, c) => ({ green: a.green + c.green, yellow: a.yellow + c.yellow, red: a.red + c.red, unknown: a.unknown + c.unknown, total: a.total + c.total }),
    { green: 0, yellow: 0, red: 0, unknown: 0, total: 0 },
  );

  // Drawing → row: scroll the selected class into view.
  useEffect(() => {
    if (!selectedClass) return;
    rowRefs.current.get(selectedClass)?.scrollIntoView?.({ block: "nearest" });
  }, [selectedClass]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="sticky top-0 z-10 border-b border-border bg-surface-sunken px-4 py-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-meta text-muted-foreground">{t("understanding.countsNote")}</p>
            <span className="shrink-0 text-meta text-muted-foreground">
              {t("understanding.total")}: <Ltr>{String(totals.total)}</Ltr>
            </span>
          </div>
          <SectionProgress high={totals.green} mid={totals.yellow} low={totals.red + totals.unknown} className="mt-2" />
        </div>
        {error ? (
          <p role="alert" className="p-4 text-dense text-destructive">
            {t("understanding.overlayError")}
          </p>
        ) : loading ? (
          <p role="status" className="p-4 text-dense text-muted-foreground">
            {t("understanding.loading")}
          </p>
        ) : counts.length === 0 ? (
          <div className="flex flex-col items-start gap-2 p-4 text-dense text-muted-foreground">
            <p>{filtered ? t("understanding.noMatches") : t("understanding.noDetections")}</p>
            {filtered ? (
              <Button size="sm" variant="secondary" onClick={onClearFilters}>
                {t("understanding.clearFilters")}
              </Button>
            ) : null}
          </div>
        ) : (
          <table className="w-full table-fixed border-collapse text-dense">
            <caption className="sr-only">{t("understanding.countsCaption")}</caption>
            <thead>
              <tr className="h-8 border-b border-border text-meta text-muted-foreground">
                <th scope="col" className="w-9 ps-3 text-start font-medium">
                  <span className="sr-only">{t("review.columns.conf")}</span>
                </th>
                <th scope="col" className="text-start font-medium">{t("legend.columns.class")}</th>
                {(["green", "yellow", "red", "unknown"] as const).map((k) => (
                  <th key={k} scope="col" className="w-10 text-center font-medium">
                    <ConfidenceShape level={uiLevel(k)} className="size-2.5" />
                    <span className="sr-only">{t(`confidence.${uiLevel(k)}`)}</span>
                  </th>
                ))}
                <th scope="col" className="w-14 pe-4 text-end font-medium">{t("understanding.total")}</th>
              </tr>
            </thead>
            <tbody>
              {counts.map((c) => {
                const sel = selectedClass === c.cls;
                const name = className(c.cls, t("understanding.unknownClass"));
                const label = legendLabel(c.legendEntryId);
                const thumb = legendThumb(c.legendEntryId);
                return (
                  <tr
                    key={c.cls}
                    ref={(el) => {
                      if (el) rowRefs.current.set(c.cls, el);
                      else rowRefs.current.delete(c.cls);
                    }}
                    data-class={c.cls}
                    data-selected={sel || undefined}
                    className={cn("h-11 border-b border-border hover:bg-surface-sunken/70", sel && "bg-highlight outline outline-1 -outline-offset-1 outline-primary")}
                  >
                    <td className="relative ps-3">
                      <span aria-hidden className={cn("absolute inset-y-0 start-0 w-[3px]", stripe[c.worst])} />
                      <ConfidenceBadge level={uiLevel(c.worst)} variant="indicator" />
                    </td>
                    <td className="py-1 pe-2">
                      <button
                        type="button"
                        aria-pressed={sel}
                        onClick={() => onSelectClass(sel ? null : c.cls)}
                        title={t("understanding.selectClass", { name })}
                        className="flex w-full min-w-0 items-center gap-2 rounded-sm text-start"
                      >
                        {thumb ? <img src={thumb} alt="" className="h-7 w-14 shrink-0 rounded-sm border border-border bg-white object-contain" /> : null}
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium text-foreground">{name}</span>
                          {label && label !== name ? <span className="truncate text-meta text-muted-foreground">{label}</span> : null}
                        </span>
                      </button>
                    </td>
                    {(["green", "yellow", "red", "unknown"] as const).map((k) => (
                      <td key={k} className={cn("text-center tabular", c[k] ? "text-foreground" : "text-muted-foreground/60")}>
                        {c[k] || "·"}
                      </td>
                    ))}
                    <td className="pe-4 text-end font-bold tabular text-foreground">{c.total}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
