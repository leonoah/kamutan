import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronDown, Hammer, RefreshCw } from "lucide-react";
import type { BoqBuild, BoqChapter, BoqLine, ProjectBoqState } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ConfidenceBadge, levelFromDb } from "@/components/ConfidenceBadge";
import { SectionProgress } from "@/components/SectionProgress";
import { ReasonChip } from "@/components/ReasonChip";
import { Ltr } from "@/components/Ltr";
import { cn } from "@/lib/utils";
import { StatusPill } from "./StatusPill";
import { fmtQty, floorsOf, groupByChapter, isCompositeLine, isOverridden, receiptOf, effectiveQty, type StatusFilter } from "./model";
import { isBuildActive } from "./queries";

export type PanelTab = "boq" | "counts";

export interface BoqPanelProps {
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  /** The Sprint-2 "ספירה לפי סוג" body (secondary tab). */
  counts: ReactNode;
  state: ProjectBoqState | null;
  build: BoqBuild | null;
  onBuild: () => void;
  buildPending: boolean;
  canBuild: boolean;
  hasReadySheets: boolean;
  /** Lines after the shared filters. */
  lines: BoqLine[];
  totalLines: number;
  chapters: BoqChapter[];
  loading: boolean;
  error: boolean;
  selectedLineId: string | null;
  onSelectLine: (id: string | null) => void;
  /** Extra receipt content (composite lines: the "ק-n" groups), rendered when the receipt opens. */
  renderReceiptExtra?: (line: BoqLine) => ReactNode;
  /** Hover preview (spec: hovering a row flashes its items on the drawing without changing the zoom). */
  onHoverLine?: (id: string | null) => void;
  /** Line to flash (drawing → row): background highlight for 1.2 s, then a steady outline. */
  flashLineId: string | null;
  split: boolean;
  onSplit: (v: boolean) => void;
  /** "כמות להזמנה" column (qty × (1 + waste) for tiling materials). */
  showOrder?: boolean;
  onShowOrder?: (v: boolean) => void;
  statusFilter: StatusFilter;
  onStatusFilter: (s: StatusFilter) => void;
  filtered: boolean;
  onClearFilters: () => void;
}

const stripe = { green: "bg-transparent", yellow: "bg-conf-mid", red: "bg-conf-low" } as const;

/**
 * S10 right pane: "כתב כמויות" (chapters with sticky headers + "% מאומת" bar + collapsible notes; rows = level,
 * code, description + reason chips, unit, [per-floor columns], qty with a hover "receipt", status) and the Sprint-2
 * "ספירה לפי סוג" as a secondary tab. Build / stale / empty states live here too.
 */
export const BoqPanel = memo(function BoqPanel(p: BoqPanelProps) {
  const { t } = useTranslation();
  const tabs: { id: PanelTab; label: string }[] = [
    { id: "boq", label: t("boq.tabBoq") },
    { id: "counts", label: t("boq.tabCounts") },
  ];
  const building = isBuildActive(p.build) || p.buildPending;

  return (
    <section id="boq-panel" tabIndex={-1} aria-label={t("boq.tabBoq")} className="flex min-h-0 flex-col bg-surface">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
        <div role="tablist" aria-label={t("boq.tabsLabel")} className="flex h-full items-stretch">
          {tabs.map((x) => (
            <button
              key={x.id}
              type="button"
              role="tab"
              id={`panel-tab-${x.id}`}
              aria-selected={p.tab === x.id}
              aria-controls={`panel-${x.id}`}
              tabIndex={p.tab === x.id ? 0 : -1}
              onClick={() => p.onTab(x.id)}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") p.onTab(p.tab === "boq" ? "counts" : "boq");
              }}
              className={cn(
                "relative px-2.5 text-dense font-medium text-muted-foreground hover:text-foreground",
                p.tab === x.id && "text-foreground after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary",
              )}
            >
              {x.label}
            </button>
          ))}
        </div>
        {p.tab === "boq" && p.state?.latestBuildId && p.canBuild ? (
          <Button size="sm" variant="ghost" className="ms-auto" onClick={p.onBuild} disabled={building}>
            <RefreshCw aria-hidden className={cn(building && "animate-spin")} />
            {t("boq.rebuild")}
          </Button>
        ) : null}
      </div>

      {p.tab === "counts" ? (
        <div role="tabpanel" id="panel-counts" aria-labelledby="panel-tab-counts" aria-label={t("boq.tabCounts")} className="flex min-h-0 flex-1 flex-col">
          {p.counts}
        </div>
      ) : (
        <div role="tabpanel" id="panel-boq" aria-labelledby="panel-tab-boq" className="flex min-h-0 flex-1 flex-col">
          <BuildStatus {...p} building={building} />
          {p.state?.latestBuildId ? <BoqTable {...p} /> : null}
        </div>
      )}
    </section>
  );
});

function BuildStatus(p: BoqPanelProps & { building: boolean }) {
  const { t } = useTranslation();
  if (p.building) {
    const pct = p.build?.progress ?? 0;
    return (
      <div role="status" className="shrink-0 border-b border-border bg-primary/[0.04] px-4 py-3">
        <div className="mb-1.5 flex items-center justify-between text-dense">
          <span className="font-medium text-foreground">{t("boq.building")}</span>
          <span className="text-meta text-muted-foreground">
            {p.build?.status === "queued" || !p.build ? t("boq.buildQueued") : t("boq.buildStage")}
          </span>
        </div>
        <Progress value={pct} aria-label={t("boq.building")} />
      </div>
    );
  }
  if (p.build?.status === "failed") {
    return (
      <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-border bg-destructive/[0.06] px-4 py-2.5 text-dense text-destructive">
        <AlertTriangle className="size-4 shrink-0" aria-hidden />
        <span className="flex-1">{t("boq.buildFailed")}</span>
        {p.canBuild ? (
          <Button size="sm" variant="secondary" onClick={p.onBuild}>
            {t("boq.rebuild")}
          </Button>
        ) : null}
      </div>
    );
  }
  if (!p.state?.latestBuildId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Hammer className="size-6" aria-hidden />
        </span>
        <p className="text-panel font-bold text-foreground">{t("boq.emptyTitle")}</p>
        <p className="max-w-xs text-dense text-muted-foreground">{p.hasReadySheets ? t("boq.emptyBody") : t("boq.emptyNoSheets")}</p>
        {p.canBuild ? (
          <Button onClick={p.onBuild} disabled={!p.hasReadySheets}>
            <Hammer aria-hidden />
            {t("boq.build")}
          </Button>
        ) : null}
      </div>
    );
  }
  if (p.state.stale) {
    return (
      <div role="status" className="flex shrink-0 items-center gap-2 border-b border-conf-mid/40 bg-conf-mid/[0.1] px-4 py-2 text-dense text-foreground">
        <AlertTriangle className="size-4 shrink-0 text-conf-mid" aria-hidden />
        <span className="flex-1">{t("boq.stale")}</span>
        {p.canBuild ? (
          <Button size="sm" variant="secondary" onClick={p.onBuild}>
            <RefreshCw aria-hidden />
            {t("boq.rebuild")}
          </Button>
        ) : null}
      </div>
    );
  }
  return null;
}

function BoqTable(p: BoqPanelProps) {
  const { t } = useTranslation();
  const groups = useMemo(() => groupByChapter(p.lines, p.chapters), [p.lines, p.chapters]);
  const floors = useMemo(() => (p.split ? floorsOf(p.lines) : []), [p.split, p.lines]);
  const [openNotes, setOpenNotes] = useState<Set<string>>(new Set());
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const [flash, setFlash] = useState<string | null>(null);

  // Drawing → row: scroll into view and flash the background for 1.2 s (then the steady selected outline).
  useEffect(() => {
    if (!p.flashLineId) return;
    rowRefs.current.get(p.flashLineId)?.scrollIntoView?.({ block: "nearest" });
    setFlash(p.flashLineId);
    const id = setTimeout(() => setFlash(null), 1200);
    return () => clearTimeout(id);
  }, [p.flashLineId]);
  useEffect(() => {
    if (p.selectedLineId) rowRefs.current.get(p.selectedLineId)?.scrollIntoView?.({ block: "nearest" });
  }, [p.selectedLineId]);

  const statuses: StatusFilter[] = ["all", "draft", "reviewed", "approved"];
  const hasOrder = useMemo(() => p.lines.some((l) => l.orderQty != null), [p.lines]);
  const order = Boolean(p.showOrder) && hasOrder;
  const cols = 6 + floors.length + (order ? 1 : 0);

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-3 py-2 text-meta">
        <div role="radiogroup" aria-label={t("boq.floorToggle")} className="inline-flex rounded-sm border border-input p-0.5">
          {[false, true].map((v) => (
            <button
              key={String(v)}
              type="button"
              role="radio"
              aria-checked={p.split === v}
              onClick={() => p.onSplit(v)}
              className={cn("rounded-[3px] px-2 py-0.5 text-foreground", p.split === v ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
            >
              {v ? t("boq.byFloor") : t("boq.summed")}
            </button>
          ))}
        </div>
        <label className="inline-flex items-center gap-1 text-muted-foreground">
          {t("boq.statusFilter")}:
          <select
            value={p.statusFilter}
            onChange={(e) => p.onStatusFilter(e.target.value as StatusFilter)}
            className="h-6 rounded-sm border border-input bg-surface px-1 text-foreground"
          >
            {statuses.map((s) => (
              <option key={s} value={s}>
                {t(`boq.status.${s}`)}
              </option>
            ))}
          </select>
        </label>
        {hasOrder && p.onShowOrder ? (
          <label className="inline-flex items-center gap-1 text-foreground" title={t("boq.orderQtyToggle")}>
            <input
              type="checkbox"
              checked={Boolean(p.showOrder)}
              onChange={(e) => p.onShowOrder?.(e.target.checked)}
              className="size-3.5 accent-[rgb(var(--primary))]"
            />
            {t("boq.orderQty")}
          </label>
        ) : null}
        <span className="ms-auto text-muted-foreground">
          {p.lines.length === p.totalLines ? t("boq.lines", { count: p.totalLines }) : `${p.lines.length} / ${t("boq.lines", { count: p.totalLines })}`}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {p.error ? (
          <p role="alert" className="p-4 text-dense text-destructive">{t("boq.loadError")}</p>
        ) : p.loading && !p.totalLines ? (
          <p role="status" className="p-4 text-dense text-muted-foreground">{t("common.loading")}</p>
        ) : groups.length === 0 ? (
          <div className="flex flex-col items-start gap-2 p-4 text-dense text-muted-foreground">
            <p>{t("boq.noMatches")}</p>
            {p.filtered ? (
              <Button size="sm" variant="secondary" onClick={p.onClearFilters}>
                {t("understanding.clearFilters")}
              </Button>
            ) : null}
          </div>
        ) : (
          <table className="w-full table-fixed border-separate border-spacing-0 text-dense">
            <caption className="sr-only">{t("boq.caption")}</caption>
            <colgroup>
              <col className="w-8" />
              <col className="w-12" />
              <col />
              <col className={floors.length ? "w-10" : "w-12"} />
              {floors.map((f) => (
                <col key={f} className="w-11" />
              ))}
              <col className="w-[4.25rem]" />
              {order ? <col className="w-[4.25rem]" /> : null}
              <col className={floors.length ? "w-10" : "w-[4.5rem]"} />
            </colgroup>
            <thead>
              <tr className="text-meta text-muted-foreground">
                {[
                  { k: "conf", sr: true },
                  { k: "code" },
                  { k: "desc" },
                  { k: "unit" },
                ].map((c) => (
                  <th key={c.k} scope="col" className="sticky top-0 z-20 h-8 border-b border-border bg-surface px-1 text-start font-medium first:ps-3">
                    {c.sr ? <span className="sr-only">{t(`boq.columns.${c.k}`)}</span> : t(`boq.columns.${c.k}`)}
                  </th>
                ))}
                {floors.map((f) => (
                  <th key={f} scope="col" className="sticky top-0 z-20 h-8 truncate border-b border-border bg-surface px-1 text-end font-medium">
                    {t(`floors.${f}`, { defaultValue: f })}
                  </th>
                ))}
                <th scope="col" className="sticky top-0 z-20 h-8 border-b border-border bg-surface px-1 text-end font-medium">
                  {floors.length ? t("boq.columns.total") : t("boq.columns.qty")}
                </th>
                {order ? (
                  <th scope="col" className="sticky top-0 z-20 h-8 border-b border-border bg-surface px-1 text-end font-medium">
                    {t("boq.orderQtyShort")}
                  </th>
                ) : null}
                <th scope="col" className="sticky top-0 z-20 h-8 border-b border-border bg-surface pe-3 ps-1 text-start font-medium">
                  {floors.length ? <span className="sr-only">{t("boq.columns.status")}</span> : t("boq.columns.status")}
                </th>
              </tr>
            </thead>
            {groups.map((g) => {
              const notesOpen = openNotes.has(g.code);
              return (
                <tbody key={g.code}>
                  <tr>
                    <th
                      scope="colgroup"
                      colSpan={cols}
                      className="sticky top-8 z-10 border-b border-border bg-surface-sunken px-3 py-2 text-start font-normal"
                    >
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-bold text-foreground">{g.title}</span>
                        <span className="shrink-0 text-meta text-muted-foreground">{t("boq.chapterVerified", { pct: g.stats.pct })}</span>
                      </div>
                      <SectionProgress high={g.stats.green} mid={g.stats.yellow} low={g.stats.red} className="mt-1.5" />
                      {g.notes.length ? (
                        <button
                          type="button"
                          aria-expanded={notesOpen}
                          onClick={() =>
                            setOpenNotes((s) => {
                              const n = new Set(s);
                              if (n.has(g.code)) n.delete(g.code);
                              else n.add(g.code);
                              return n;
                            })
                          }
                          className="mt-1.5 inline-flex items-center gap-1 rounded-sm text-meta text-muted-foreground hover:text-foreground"
                        >
                          <ChevronDown className={cn("size-3 transition-transform", !notesOpen && "rtl:rotate-90 ltr:-rotate-90")} aria-hidden />
                          {t("boq.chapterNotes", { count: g.notes.length })}
                        </button>
                      ) : null}
                    </th>
                  </tr>
                  {notesOpen ? (
                    <tr>
                      <td colSpan={cols} className="border-b border-border bg-surface-sunken/50 px-4 py-2">
                        <ol className="list-decimal space-y-1 ps-4 text-meta text-muted-foreground">
                          {g.notes.map((n, i) => (
                            <li key={i}>{n.replace(/^\s*\d+\.\s*/, "")}</li>
                          ))}
                        </ol>
                      </td>
                    </tr>
                  ) : null}
                  {g.lines.map((l) => (
                    <LineRow
                      key={l.id}
                      line={l}
                      floors={floors}
                      order={order}
                      selected={p.selectedLineId === l.id}
                      flash={flash === l.id}
                      onSelect={() => p.onSelectLine(p.selectedLineId === l.id ? null : l.id)}
                      onHover={(h) => p.onHoverLine?.(h ? l.id : null)}
                      receiptExtra={p.renderReceiptExtra}
                      rowRef={(el) => {
                        if (el) rowRefs.current.set(l.id, el);
                        else rowRefs.current.delete(l.id);
                      }}
                    />
                  ))}
                </tbody>
              );
            })}
          </table>
        )}
      </div>
    </TooltipProvider>
  );
}

function LineRow({
  line: l,
  floors,
  order,
  selected,
  flash,
  onSelect,
  onHover,
  receiptExtra,
  rowRef,
}: {
  receiptExtra?: ((line: BoqLine) => ReactNode) | undefined;
  line: BoqLine;
  floors: string[];
  order: boolean;
  selected: boolean;
  flash: boolean;
  onSelect: () => void;
  onHover: (h: boolean) => void;
  rowRef: (el: HTMLTableRowElement | null) => void;
}) {
  const { t } = useTranslation();
  const reasons = l.reasons ?? [];
  const cell = "border-b border-border px-1 py-1.5 align-top";
  return (
    <tr
      ref={rowRef}
      data-line={l.id}
      data-code={l.code}
      data-selected={selected || undefined}
      onClick={onSelect}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      className={cn(
        "group cursor-pointer transition-colors hover:bg-surface-sunken/70",
        selected && "bg-highlight/60 outline outline-1 -outline-offset-1 outline-primary",
        flash && "bg-highlight",
      )}
    >
      <td className={cn(cell, "relative ps-2")}>
        <span aria-hidden className={cn("absolute inset-y-0 start-0 w-[3px]", stripe[l.level])} />
        <ConfidenceBadge level={levelFromDb(l.level)} variant="indicator" />
      </td>
      <td className={cn(cell, "pt-2 font-mono text-meta text-foreground")}>
        <Ltr>{l.code}</Ltr>
      </td>
      <td className={cell}>
        <button
          type="button"
          aria-pressed={selected}
          aria-label={t("boq.selectLine", { code: l.code, desc: l.description })}
          onClick={(e) => {
            e.stopPropagation();
            onSelect();
          }}
          className="block w-full rounded-sm text-start"
        >
          <span className="line-clamp-2 text-foreground">{l.description}</span>
        </button>
        {reasons.length ? (
          <span className="mt-1 flex min-w-0 items-center gap-1">
            <ReasonChip code={reasons[0]!} className="h-[18px] min-w-0 truncate" />
            {reasons.length > 1 ? (
              <span className="shrink-0 text-meta text-muted-foreground" title={reasons.slice(1).join(" · ")}>
                +{reasons.length - 1}
              </span>
            ) : null}
          </span>
        ) : null}
      </td>
      <td className={cn(cell, "pt-2 text-meta text-muted-foreground")}>
        <span className="line-clamp-1">{l.unit}</span>
      </td>
      {floors.map((f) => (
        <td key={f} className={cn(cell, "pt-2 text-end tabular text-muted-foreground")}>
          {l.byFloor?.[f] ? fmtQty(l.byFloor[f]!) : "·"}
        </td>
      ))}
      <td className={cn(cell, "pt-1.5 text-end")}>
        <QtyWithReceipt line={l} onShow={onSelect} extra={receiptExtra} />
      </td>
      {order ? (
        <td className={cn(cell, "pt-2 text-end tabular text-muted-foreground")} data-order-qty>
          {l.orderQty != null ? fmtQty(l.orderQty) : "·"}
        </td>
      ) : null}
      <td className={cn(cell, "pe-3 pt-1.5")}>
        <StatusPill status={l.status} compact={floors.length > 0} />
      </td>
    </tr>
  );
}

/** "לכל מספר יש קבלה": the qty is a button; hover/focus shows how it was computed, click shows it on the drawing. */
function QtyWithReceipt({ line: l, onShow, extra }: { line: BoqLine; onShow: () => void; extra?: ((line: BoqLine) => ReactNode) | undefined }) {
  const { t } = useTranslation();
  const r = receiptOf(l);
  const over = isOverridden(l);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onShow();
          }}
          aria-label={`${fmtQty(effectiveQty(l))} — ${t("boq.receiptFor", { code: l.code })}`}
          className="inline-flex flex-col items-end rounded-sm px-1 leading-tight hover:bg-primary/10"
        >
          <span className="font-bold tabular text-foreground underline decoration-dotted decoration-muted-foreground/60 underline-offset-4">
            {fmtQty(effectiveQty(l))}
          </span>
          {over ? (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <s className="tabular">{fmtQty(l.qty)}</s>
              <span className="text-manual">✎ {t("boq.manualTag")}</span>
            </span>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" align="start">
        <Receipt line={l} receipt={r} extra={extra?.(l)} />
      </TooltipContent>
    </Tooltip>
  );
}

export function Receipt({ line: l, receipt: r, extra }: { line: BoqLine; receipt: ReturnType<typeof receiptOf>; extra?: ReactNode }) {
  const composite = isCompositeLine(l);
  const { t } = useTranslation();
  return (
    <div className="flex min-w-48 flex-col gap-1.5" data-receipt={l.id}>
      <p className="text-meta text-muted-foreground">
        {t("boq.receiptTitle")} · <Ltr>{l.code}</Ltr>
      </p>
      <p className="font-bold text-foreground">
        {/* "16 = 14 שזוהו + 2 ידני" */}
        {t(composite ? "boq.receiptGroups" : "boq.receiptDetected", { total: fmtQty(r.total), detected: fmtQty(r.detected) })}
        {r.manual > 0 ? t("boq.receiptManualPlus", { n: fmtQty(r.manual) }) : r.manual < 0 ? t("boq.receiptManualMinus", { n: fmtQty(-r.manual) }) : null}
      </p>
      <p className="text-meta text-muted-foreground">
        {r.evidenceCount
          ? `${t("boq.receiptItems", { count: r.evidenceCount })} · ${t("boq.receiptSheets", { count: r.sheets })}`
          : t("boq.receiptNoEvidence")}
      </p>
      {composite ? extra : null}
      {r.byFloor.length ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-meta">
          <dt className="col-span-2 text-muted-foreground">{t("boq.receiptByFloor")}</dt>
          {r.byFloor.map(([f, n]) => (
            <Fragment key={f}>
              <dt className="text-foreground">{t(`floors.${f}`, { defaultValue: f })}</dt>
              <dd className="text-end tabular text-foreground">{fmtQty(n)}</dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
      {l.breakdown?.length ? (
        <dl className="grid max-w-72 grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-meta" data-receipt-breakdown>
          <dt className="col-span-2 text-muted-foreground">{t("boq.receiptBreakdown")}</dt>
          {l.breakdown.slice(0, 12).map((b, i) => (
            <Fragment key={i}>
              <dt className={cn("min-w-0 truncate text-foreground", b.manual && "text-manual")} title={b.formula ?? undefined}>
                {b.manual ? "✎ " : null}
                {b.label}
                {b.formula ? (
                  <span className="block text-[11px] text-muted-foreground">
                    <Ltr>{b.formula}</Ltr>
                  </span>
                ) : null}
              </dt>
              <dd className="text-end tabular text-foreground">{fmtQty(b.qty)}</dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
      {l.orderQty != null && l.wasteFactor != null ? (
        <p className="text-meta text-muted-foreground">{t("boq.receiptOrder", { pct: Math.round(l.wasteFactor * 100), qty: fmtQty(l.orderQty) })}</p>
      ) : null}
      {r.overridden && r.note ? <p className="text-meta text-manual">{t("boq.receiptOverride", { note: r.note })}</p> : null}
      {(l.reasons ?? []).length ? (
        <span className="flex flex-wrap gap-1">
          {(l.reasons ?? []).map((x) => (
            <ReasonChip key={x} code={x} />
          ))}
        </span>
      ) : null}
    </div>
  );
}
