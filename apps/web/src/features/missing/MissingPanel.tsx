import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Crosshair, RotateCcw } from "lucide-react";
import type { MissingItem, MissingItemFilter } from "@/api/types";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { Ltr } from "@/components/Ltr";
import { cn } from "@/lib/utils";
import { canMarkItem, filterCounter, groupMissingByChapter } from "./model";
import { useMissingItems, useSetExclusion } from "./queries";

const FILTERS: MissingItemFilter[] = ["all", "in_project", "not_relevant"];

export interface MissingPanelProps {
  projectId: string;
  latestBuildId: string | null | undefined;
  /** editor / admin: may mark a line "לא רלוונטי" and restore it. */
  canExclude: boolean;
  /** editor / reviewer / admin: may save a manual quantity from the drawing. */
  canMark: boolean;
  /** Start the count / measure tool bound to the item ("סמן בשרטוט"). */
  onMark: (item: MissingItem) => void;
  /** The item whose tool is running (its button shows pressed). */
  markingCode?: string | null;
}

/**
 * "סעיפים שלא זוהו": library lines with quantity 0 (or no line at all) for this project, grouped by chapter
 * (the server sorts chapter order, then code), with the filter "הכל / בפרויקט / לא רלוונטי" and a counter.
 * Per row: "לא רלוונטי בפרויקט הזה" (reversible, toast with undo) and "סמן בשרטוט" (the existing count / measure tool).
 */
export function MissingPanel(p: MissingPanelProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<MissingItemFilter>("all");
  const q = useMissingItems(p.projectId, filter, p.latestBuildId);
  const setEx = useSetExclusion(p.projectId);
  const view = q.data;

  const setExcluded = (it: MissingItem, excluded: boolean) => {
    setEx.mutate(
      { code: it.code, excluded },
      {
        onSuccess: () =>
          toast({
            title: t(excluded ? "missing.notRelevantDone" : "missing.restoredDone", { code: it.code }),
            tone: "success",
            action: { label: t("missing.undo"), onClick: () => setEx.mutate({ code: it.code, excluded: !excluded }) },
          }),
        onError: () => toast({ title: t("missing.error"), tone: "error" }),
      },
    );
  };

  if (q.isError && !view)
    return (
      <div role="alert" className="flex flex-col items-start gap-2 p-4 text-dense">
        <span>{t("missing.loadError")}</span>
        <Button size="sm" variant="secondary" onClick={() => void q.refetch()}>
          {t("missing.retry")}
        </Button>
      </div>
    );
  if (!view) return <div role="status" className="p-4 text-dense text-muted-foreground">{t("common.loading")}</div>;
  if (!view.built) return <p className="p-4 text-dense text-muted-foreground" data-missing-not-built>{t("missing.notBuilt")}</p>;

  const groups = groupMissingByChapter(view.items);
  const emptyKey = filter === "all" ? "missing.emptyAll" : filter === "in_project" ? "missing.emptyOpen" : "missing.emptyHidden";

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-missing-panel>
      <div className="shrink-0 border-b border-border px-3 py-2">
        <p className="text-meta text-muted-foreground">{t("missing.intro")}</p>
        <div role="group" aria-label={t("missing.filtersLabel")} className="mt-2 flex flex-wrap items-center gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              data-missing-filter={f}
              onClick={() => setFilter(f)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-meta font-medium",
                filter === f ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`missing.filter.${f}`)}
              <span className="tabular-nums" data-missing-count={f}>
                {filterCounter(f, view.counts)}
              </span>
            </button>
          ))}
          <span role="status" className="ms-auto text-meta text-muted-foreground" data-missing-counter>
            {t("missing.counter", { count: view.items.length })}
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {groups.length === 0 ? (
          <p className="p-4 text-dense text-muted-foreground" data-missing-empty>
            {t(emptyKey)}
          </p>
        ) : (
          groups.map((g) => (
            <section key={g.chapter} aria-label={g.title} data-missing-chapter={g.chapter}>
              <h3 className="sticky top-0 z-10 border-b border-border bg-surface-2 px-3 py-1.5 text-meta font-semibold text-foreground">
                {g.title}
              </h3>
              <ul>
                {g.items.map((it) => (
                  <MissingRow
                    key={it.id}
                    item={it}
                    canExclude={p.canExclude}
                    canMark={p.canMark}
                    pending={setEx.isPending}
                    marking={p.markingCode === it.code}
                    onExclude={(on) => setExcluded(it, on)}
                    onMark={() => p.onMark(it)}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function MissingRow({
  item,
  canExclude,
  canMark,
  pending,
  marking,
  onExclude,
  onMark,
}: {
  item: MissingItem;
  canExclude: boolean;
  canMark: boolean;
  pending: boolean;
  marking: boolean;
  onExclude: (on: boolean) => void;
  onMark: () => void;
}) {
  const { t } = useTranslation();
  const hidden = item.state === "not_relevant";
  const markable = canMarkItem(item);
  return (
    <li data-missing-item={item.code} data-state={item.state} className={cn("flex items-start gap-2 border-b border-border px-3 py-2", hidden && "bg-muted/40")}>
      <span className="w-14 shrink-0 pt-0.5 text-meta tabular-nums text-muted-foreground">
        <Ltr>{item.code}</Ltr>
      </span>
      <div className="min-w-0 flex-1">
        <div className={cn("text-dense text-foreground", hidden && "text-muted-foreground")}>{item.description}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-meta text-muted-foreground">
          <span>{item.unit}</span>
          <span>{item.origin === "no_line" ? t("missing.originNoLine") : t("missing.originZero")}</span>
          {hidden ? <span>{t("missing.hiddenBy")}{item.exclusion?.reason ? ` · ${t("missing.hiddenReasonPrefix")} ${item.exclusion.reason}` : ""}</span> : null}
          {!hidden && !markable ? <span>{t("missing.lumpSum")}</span> : null}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {hidden ? (
            canExclude ? (
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => onExclude(false)} data-action="restore">
                <RotateCcw aria-hidden />
                {t("missing.actions.restore")}
              </Button>
            ) : null
          ) : (
            <>
              {markable && canMark ? (
                <Button size="sm" variant={marking ? "primary" : "secondary"} aria-pressed={marking} onClick={onMark} data-action="mark" title={t(`missing.markHint.${item.markKind}`)}>
                  <Crosshair aria-hidden />
                  {t("missing.actions.mark")}
                </Button>
              ) : null}
              {canExclude ? (
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => onExclude(true)} data-action="exclude">
                  {t("missing.actions.notRelevant")}
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </li>
  );
}
