import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { AlertTriangle, ChevronDown, Eye, Hammer, History, RefreshCw } from "lucide-react";
import { qtyChangedSinceApproval, type BoqBuild, type BoqChapter, type BoqLine, type ProjectBoqState } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ConfidenceBadge, levelFromDb } from "@/components/ConfidenceBadge";
import { SectionProgress } from "@/components/SectionProgress";
import { ReasonChip } from "@/components/ReasonChip";
import { Ltr } from "@/components/Ltr";
import { cn } from "@/lib/utils";
import { StatusPill } from "./StatusPill";
import { chapterLabel, fmtQty, floorsOf, groupByChapter, isCompositeLine, isOverridden, rangeIds, receiptOf, effectiveQty, type StatusFilter } from "./model";
import { coverageOf, lineNeedsInput, originOf, quickActionOf } from "./sprint6";
import { CoverageText, MissingQty, NeedsInputChip, OriginBadge, QuickActionButton } from "./Sprint6Parts";
import { isBuildActive } from "./queries";
import { LineDescription } from "./LineDescription";
import { lineDescription } from "./sprint7";

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
  /** Sprint 5: open the line's change history (S13). */
  onHistory?: (line: BoqLine) => void;
  /** Sprint 5: the calibration badge ("כיול שמרני"), shown in the panel header. */
  calibrationBadge?: ReactNode;
  /** Stage 10: every line before filters (counts of the "הכמות השתנתה" filter). */
  allLines?: readonly BoqLine[];
  /** Stage 10 (A-LIVE-01): default library in use / no library — explained above the table, with an import link. */
  libraryNotice?: ReactNode;
  /** Sprint 6: run a line's quick action (measure / count / confirm, bound to the line and its sheet). */
  onQuickAction?: (line: BoqLine) => void;
  /** Sprint 6: the line whose quick action is running (its button shows pressed). */
  quickLineId?: string | null;
  /** Sprint 6 (owner feedback): multi-select for bulk status — checkbox per row, shift-click range, select all / chapter. */
  selectable?: boolean;
  checkedIds?: ReadonlySet<string>;
  onCheck?: (ids: string[], on: boolean) => void;
  /** The bulk action bar (shown above the table while lines are checked). */
  bulkBar?: ReactNode;
  /** Sprint 7: project id (inline rename) and whether the user may rename lines (editor+). */
  projectId?: string;
  canRename?: boolean;
  /** Sprint 7: link to the BOQ preview ("תצוגה מקדימה"). */
  previewHref?: string;
}

/** Native checkbox with an indeterminate state (chapter / select-all when only some lines are checked). */
function Check({ checked, mixed, label, onToggle, className }: { checked: boolean; mixed?: boolean; label: string; onToggle: (shift: boolean) => void; className?: string }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = Boolean(mixed) && !checked;
      }}
      onChange={() => undefined}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(e.shiftKey);
      }}
      className={cn("size-3.5 cursor-pointer accent-[rgb(var(--primary))]", className)}
    />
  );
}

const EMPTY_SET: ReadonlySet<string> = new Set();
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
      {/* heading outline under the page's sr-only <h1> (A-UI-16): h1 → h2 per pane → h3 in details */}
      <h2 className="sr-only">{t("boq.tabBoq")}</h2>
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
        {p.calibrationBadge ? <span className="ms-auto">{p.calibrationBadge}</span> : null}
        {p.tab === "boq" && p.state?.latestBuildId && p.canBuild ? (
          <Button size="sm" variant="ghost" className={p.calibrationBadge ? undefined : "ms-auto"} onClick={p.onBuild} disabled={building}>
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
          {p.libraryNotice}
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

  const statuses: StatusFilter[] = ["all", "draft", "reviewed", "approved", "qtyChanged", "needsInput"];
  const qtyChangedCount = useMemo(() => p.allLines?.filter(qtyChangedSinceApproval).length ?? 0, [p.allLines]);
  const needsInputCount = useMemo(() => (p.allLines ?? p.lines).filter(lineNeedsInput).length, [p.allLines, p.lines]);
  const hasOrder = useMemo(() => p.lines.some((l) => l.orderQty != null), [p.lines]);
  const order = Boolean(p.showOrder) && hasOrder;
  const sel = Boolean(p.selectable && p.onCheck);
  const checked = p.checkedIds ?? EMPTY_SET;
  const cols = 6 + floors.length + (order ? 1 : 0) + (sel ? 1 : 0);
  const orderedIds = useMemo(() => groups.flatMap((g) => g.lines.map((l) => l.id)), [groups]);
  const anchor = useRef<string | null>(null);
  const toggleOne = (id: string, shift: boolean) => {
    const on = !checked.has(id);
    const ids = shift ? rangeIds(orderedIds, anchor.current, id) : [id];
    anchor.current = id;
    p.onCheck?.(ids, shift ? true : on);
  };
  const allOn = sel && orderedIds.length > 0 && orderedIds.every((id) => checked.has(id));
  const someOn = sel && orderedIds.some((id) => checked.has(id));

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
                {s === "qtyChanged"
                  ? t("boq.status.qtyChangedCount", { count: qtyChangedCount })
                  : s === "needsInput"
                    ? t("boq.needsInputCount", { count: needsInputCount })
                    : t(`boq.status.${s}`)}
              </option>
            ))}
          </select>
        </label>
        {needsInputCount ? (
          <button
            type="button"
            aria-pressed={p.statusFilter === "needsInput"}
            title={t("boq.needsInputFilter")}
            data-filter-needs-input
            onClick={() => p.onStatusFilter(p.statusFilter === "needsInput" ? "all" : "needsInput")}
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded-sm border border-dashed border-conf-low/60 px-1.5 text-foreground hover:bg-conf-low/10",
              p.statusFilter === "needsInput" && "border-solid bg-conf-low/[0.12] font-medium",
            )}
          >
            {t("boq.needsInputCount", { count: needsInputCount })}
          </button>
        ) : null}
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
        {sel && orderedIds.length ? (
          <label className="inline-flex items-center gap-1 text-foreground" data-select-all>
            <Check
              checked={allOn}
              mixed={someOn}
              label={t("boq.bulk.selectAllLabel", { count: orderedIds.length })}
              onToggle={() => p.onCheck?.(orderedIds, !allOn)}
            />
            <span aria-hidden>{t("boq.bulk.selectAll")}</span>
          </label>
        ) : null}
        {p.previewHref ? (
          <Link
            to={p.previewHref}
            data-preview-link
            title={t("hub.previewFull")}
            className="ms-auto inline-flex h-6 items-center gap-1 rounded-sm px-1 font-medium text-primary hover:bg-primary/10"
          >
            <Eye className="size-3.5" aria-hidden />
            {t("hub.preview")}
          </Link>
        ) : null}
        <span className={cn("text-muted-foreground", !p.previewHref && "ms-auto")}>
          {p.lines.length === p.totalLines ? t("boq.lines", { count: p.totalLines }) : `${p.lines.length} / ${t("boq.lines", { count: p.totalLines })}`}
        </span>
      </div>
      {p.bulkBar}
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
              {sel ? <col className="w-6" /> : null}
              <col className="w-8" />
              <col className="w-12" />
              <col />
              <col className={floors.length ? "w-10" : "w-12"} />
              {floors.map((f) => (
                <col key={f} className="w-11" />
              ))}
              <col className="w-[4.25rem]" />
              {order ? <col className="w-[4.25rem]" /> : null}
              <col className={floors.length ? "w-10" : "w-[5.75rem]"} />
            </colgroup>
            <thead>
              <tr className="text-meta text-muted-foreground">
                {sel ? (
                  <th scope="col" className="sticky top-0 z-20 h-8 border-b border-border bg-surface ps-2">
                    <span className="sr-only">{t("boq.bulk.column")}</span>
                  </th>
                ) : null}
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
              const cov = coverageOf(g.lines);
              const chIds = g.lines.map((l) => l.id);
              const chAll = sel && chIds.every((id) => checked.has(id));
              const chSome = sel && chIds.some((id) => checked.has(id));
              return (
                <tbody key={g.code}>
                  <tr>
                    <th
                      scope="colgroup"
                      colSpan={cols}
                      className="sticky top-8 z-10 border-b border-border bg-surface-sunken px-3 py-2 text-start font-normal"
                    >
                      <div className="flex items-center gap-2">
                        {sel ? (
                          <Check
                            checked={chAll}
                            mixed={chSome}
                            label={t("boq.bulk.selectChapter", { chapter: chapterLabel(g.code, g.title) })}
                            onToggle={() => p.onCheck?.(chIds, !chAll)}
                            className="shrink-0"
                          />
                        ) : null}
                        <span className="min-w-0 flex-1 truncate font-bold text-foreground">{chapterLabel(g.code, g.title)}</span>
                        <span className="shrink-0 text-meta text-muted-foreground">{t("boq.chapterVerified", { pct: g.stats.pct })}</span>
                      </div>
                      <CoverageText c={cov} className="mt-0.5 block" />
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
                      onHistory={p.onHistory}
                      onQuickAction={p.onQuickAction}
                      quickActive={p.quickLineId === l.id}
                      projectId={p.projectId}
                      canRename={Boolean(p.canRename && p.projectId)}
                      check={sel ? { on: checked.has(l.id), toggle: (shift) => toggleOne(l.id, shift) } : null}
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
  onHistory,
  onQuickAction,
  quickActive,
  check,
  rowRef,
  projectId,
  canRename,
}: {
  projectId?: string | undefined;
  canRename?: boolean;
  check?: { on: boolean; toggle: (shift: boolean) => void } | null;
  onQuickAction?: ((line: BoqLine) => void) | undefined;
  quickActive?: boolean;
  receiptExtra?: ((line: BoqLine) => ReactNode) | undefined;
  onHistory?: ((line: BoqLine) => void) | undefined;
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
  const origin = originOf(l);
  const waiting = lineNeedsInput(l);
  const quick = quickActionOf(l);
  return (
    <tr
      ref={rowRef}
      data-line={l.id}
      data-code={l.code}
      data-selected={selected || undefined}
      data-origin={origin}
      data-needs-input={waiting || undefined}
      data-checked={check?.on || undefined}
      onClick={onSelect}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      className={cn(
        "group group/line cursor-pointer transition-colors hover:bg-surface-sunken/70",
        check?.on && "bg-primary/[0.05]",
        selected && "bg-highlight/60 outline outline-1 -outline-offset-1 outline-primary",
        flash && "bg-highlight",
      )}
    >
      {check ? (
        <td className={cn(cell, "ps-2 pt-2")}>
          <Check checked={check.on} label={t("boq.bulk.selectLine", { code: l.code })} onToggle={check.toggle} />
        </td>
      ) : null}
      <td className={cn(cell, "relative ps-2")}>
        <span aria-hidden className={cn("absolute inset-y-0 start-0 w-[3px]", stripe[l.level])} />
        <ConfidenceBadge level={levelFromDb(l.level)} variant="indicator" />
      </td>
      <td className={cn(cell, "pt-2 font-mono text-meta text-foreground")}>
        <Ltr>{l.code}</Ltr>
      </td>
      <td className={cell}>
        <LineDescription
          projectId={projectId ?? ""}
          line={l}
          canEdit={Boolean(canRename && projectId)}
          variant="panel"
          selected={selected}
          onSelect={onSelect}
          selectLabel={t("boq.selectLine", { code: l.code, desc: lineDescription(l) })}
          extra={
            <>
              <OriginBadge origin={origin} />
              {waiting ? <NeedsInputChip /> : null}
              {reasons.length ? (
                <span className="flex min-w-0 items-center gap-1">
                  <ReasonChip code={reasons[0]!} className={cn("h-[18px] min-w-0", waiting ? "h-auto min-h-[18px] whitespace-normal py-px" : "truncate")} />
                  {reasons.length > 1 ? (
                    <span className="shrink-0 text-meta text-muted-foreground" title={reasons.slice(1).join(" · ")}>
                      +{reasons.length - 1}
                    </span>
                  ) : null}
                </span>
              ) : null}
              {quick && onQuickAction && waiting ? <QuickActionButton line={l} action={quick} active={quickActive} onRun={() => onQuickAction(l)} /> : null}
            </>
          }
        />
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
        <span className="flex items-center gap-0.5">
          {/* keyed by status: a change replays the pop-in (the inline confirmation instead of a toast per line) */}
          <StatusPill key={l.status} status={l.status} compact={floors.length > 0} className="duration-300 animate-in fade-in-0 zoom-in-75" />
          {onHistory ? (
            <button
              type="button"
              data-history-for={l.id}
              aria-label={t("history.openFor", { code: l.code })}
              title={t("history.open")}
              onClick={(e) => {
                e.stopPropagation();
                onHistory(l);
              }}
              className={cn(
                "rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100",
                selected ? "opacity-100" : "opacity-0",
              )}
            >
              <History className="size-3.5" aria-hidden />
            </button>
          ) : null}
        </span>
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
          // Name = the visible content + a hidden suffix, so it always contains what is shown (axe
          // label-content-name-mismatch), also when an override adds the original qty + "✎ ידני".
          className="inline-flex flex-col items-end rounded-sm px-1 leading-tight hover:bg-primary/10"
        >
          {lineNeedsInput(l) ? (
            <MissingQty line={l} />
          ) : (
            <span className="font-bold tabular text-foreground underline decoration-dotted decoration-muted-foreground/60 underline-offset-4">
              {fmtQty(effectiveQty(l))}
            </span>
          )}{" "}
          {over ? (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <s className="tabular">{fmtQty(l.qty)}</s>{" "}
              <span className="text-manual">✎ {t("boq.manualTag")}</span>
            </span>
          ) : null}
          <span className="sr-only"> — {t("boq.receiptFor", { code: l.code })}</span>
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
      {lineNeedsInput(l) ? (
        <p className="font-bold text-foreground">{t("boq.needsInput")}</p>
      ) : (
      <p className="font-bold text-foreground">
        {/* "16 = 14 שזוהו + 2 ידני" */}
        {t(composite ? "boq.receiptGroups" : "boq.receiptDetected", { total: fmtQty(r.total), detected: fmtQty(r.detected) })}
        {r.manual > 0 ? t("boq.receiptManualPlus", { n: fmtQty(r.manual) }) : r.manual < 0 ? t("boq.receiptManualMinus", { n: fmtQty(-r.manual) }) : null}
      </p>
      )}
      <p className="text-meta text-foreground" data-receipt-origin>
        {t("boq.originOf", { origin: t(`boq.origin.${originOf(l)}`) })}
        <span className="text-muted-foreground"> · {t(`boq.originHint.${originOf(l)}`)}</span>
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
