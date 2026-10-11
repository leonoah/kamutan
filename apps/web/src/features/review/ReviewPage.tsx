import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronLeft, Download, Search, Share2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/components/ui/toast";
import { Logo } from "@/components/Logo";
import { UserMenu } from "@/components/AppShell";
import { ConfidenceBadge, ConfidenceShape, type ConfidenceLevel } from "@/components/ConfidenceBadge";
import { SectionProgress } from "@/components/SectionProgress";
import { ReasonChip } from "@/components/ReasonChip";
import { Kbd } from "@/components/Kbd";
import { Ltr } from "@/components/Ltr";
import { formatQuantity } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useProject } from "@/features/projects/queries";
import { DrawingPlaceholder } from "./DrawingPlaceholder";
import { sampleChapter, sampleQueue, sampleRows, type SampleQueueItem } from "./sampleData";

const stripe: Record<ConfidenceLevel, string> = {
  high: "bg-transparent",
  mid: "bg-conf-mid",
  low: "bg-conf-low",
  unknown: "bg-conf-unknown",
  manual: "bg-manual",
};

/**
 * S10 "סביבת הבדיקה" — Sprint-0 static skeleton.
 * Panel order in RTL reading order: BOQ (right, ~38%) · drawing (center, ~47%, LTR) · review queue (left, ~15%).
 */
export function ReviewPage() {
  const { projectId = "" } = useParams();
  const { t } = useTranslation();
  const project = useProject(projectId);
  const name = project.data?.name ?? "…";
  const notYet = () => toast({ title: t("review.placeholderNote") });

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <nav aria-label={t("review.skipNav")} className="contents">
        <a href="#boq-panel" className="skip-link">{t("review.skipBoq")}</a>
        <a href="#drawing-panel" className="skip-link">{t("review.skipDrawing")}</a>
        <a href="#queue-panel" className="skip-link">{t("review.skipQueue")}</a>
      </nav>

      {/* Header */}
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border bg-surface px-4">
        <Link to="/projects" className="rounded" aria-label={t("app.name")}>
          <Logo withText={false} />
        </Link>
        <nav aria-label={t("app.breadcrumbs")} className="min-w-0">
          <ol className="flex items-center gap-1.5 text-dense">
            <li>
              <Link to="/projects" className="text-muted-foreground hover:text-foreground">{t("app.name")}</Link>
            </li>
            <li aria-hidden className="text-muted-foreground">‹</li>
            <li>
              <Link to={`/projects/${projectId}`} className="truncate text-muted-foreground hover:text-foreground">{name}</Link>
            </li>
            <li aria-hidden className="text-muted-foreground">‹</li>
            <li aria-current="page" className="font-medium text-foreground">{t("review.title")}</li>
          </ol>
        </nav>
        <div className="flex flex-1 items-center justify-end gap-3">
          <button
            type="button"
            onClick={notYet}
            className="hidden h-8 w-56 items-center gap-2 rounded border border-input bg-surface-sunken px-2.5 text-dense text-muted-foreground hover:border-foreground/30 md:inline-flex"
          >
            <Search className="size-3.5" aria-hidden />
            <span className="flex-1 text-start">{t("review.search")}</span>
            <Kbd>⌘K</Kbd>
          </button>
          <div className="hidden w-48 flex-col gap-1 lg:flex">
            <div className="flex items-center justify-between text-meta">
              <span className="font-medium text-foreground">{t("review.verifiedTotal", { pct: 87 })}</span>
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <ConfidenceShape level="low" className="size-2.5" />
                {t("review.toReview", { count: 23 })}
              </span>
            </div>
            <Progress value={87} aria-label={t("review.verifiedTotal", { pct: 87 })} indicatorClassName="bg-conf-high" />
          </div>
          <Button size="sm" variant="secondary" onClick={notYet}>
            <Share2 aria-hidden />
            {t("review.share")}
          </Button>
          <Button size="sm" onClick={notYet}>
            <Download aria-hidden />
            {t("review.export")}
          </Button>
          <UserMenu />
        </div>
      </header>

      {/* Filters */}
      <div role="toolbar" aria-label={t("review.filters")} className="flex h-11 shrink-0 items-center gap-2 overflow-x-auto border-b border-border bg-surface px-4 text-dense">
        <span className="text-muted-foreground">{t("review.filters")}:</span>
        {[t("review.filterDomain"), t("review.filterFloor"), t("review.filterRoom")].map((f) => (
          <button key={f} type="button" onClick={notYet} className="inline-flex h-7 items-center gap-1 rounded-sm border border-input bg-surface px-2 text-foreground hover:bg-muted">
            {f}
            <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
          </button>
        ))}
        <div role="group" aria-label={t("review.filterConfidence")} className="flex items-center gap-1 rounded-sm border border-input p-0.5">
          {(["high", "mid", "low"] as const).map((l) => (
            <button key={l} type="button" aria-pressed="true" onClick={notYet} className="inline-flex h-6 items-center gap-1 rounded-sm bg-muted px-1.5 text-foreground">
              <ConfidenceShape level={l} className="size-2.5" />
              {t(`confidence.${l}`)}
            </button>
          ))}
        </div>
        <button type="button" onClick={notYet} className="inline-flex h-7 items-center gap-1 rounded-sm border border-input bg-surface px-2 text-foreground hover:bg-muted">
          {t("review.filterStatus")}
          <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
        </button>
        <button type="button" onClick={notYet} className="ms-auto inline-flex h-7 items-center gap-1 rounded-sm px-2 text-muted-foreground hover:text-foreground">
          <X className="size-3.5" aria-hidden />
          {t("review.clear")}
        </button>
      </div>

      {/* Three panes: grid columns follow inline direction → first column is on the right in RTL */}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(340px,38fr)_minmax(0,47fr)_minmax(240px,15fr)]">
        <BoqPanel />
        <section id="drawing-panel" tabIndex={-1} aria-label={t("review.drawingPanel")} className="flex min-h-0 flex-col border-x border-border">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 text-dense">
            <button type="button" onClick={notYet} className="inline-flex h-7 items-center gap-1 rounded-sm border border-input px-2 text-foreground hover:bg-muted">
              {t("review.sheet")}: ת.תאורה
              <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
            </button>
            <button type="button" onClick={notYet} className="inline-flex h-7 items-center gap-1 rounded-sm border border-input px-2 text-foreground hover:bg-muted">
              {t("review.layers")}
              <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
            </button>
            <span className="ms-auto text-meta text-muted-foreground">
              {t("review.drawingPanel")} · <Ltr>LTR</Ltr>
            </span>
          </div>
          <div className="min-h-0 flex-1">
            <DrawingPlaceholder sheetName="ת.תאורה" />
          </div>
        </section>
        <QueuePanel />
      </div>

      {/* Selection / action bar */}
      <footer className="flex h-12 shrink-0 items-center gap-3 border-t border-border bg-surface px-4 text-dense">
        <span className="text-muted-foreground">{t("review.selected")}:</span>
        <span className="font-medium text-foreground">
          <Ltr>4.10</Ltr> · {t("review.selectionSummary", { groups: 2, items: 4 })}
        </span>
        <div className="ms-auto flex items-center gap-1.5">
          {[
            { k: "A", label: t("review.approve"), primary: true },
            { k: "R", label: t("review.reject") },
            { k: "E", label: t("review.edit") },
            { k: "N", label: t("review.next") },
            { k: "?", label: t("review.shortcuts") },
          ].map((a) => (
            <Button key={a.k} size="sm" variant={a.primary ? "primary" : "secondary"} onClick={notYet} aria-keyshortcuts={a.k === "?" ? "Shift+Slash" : a.k}>
              <Kbd className={cn(a.primary && "border-primary-foreground/40 bg-transparent text-primary-foreground")}>{a.k}</Kbd>
              {a.label}
            </Button>
          ))}
        </div>
      </footer>
    </div>
  );
}

function BoqPanel() {
  const { t } = useTranslation();
  return (
    <section id="boq-panel" tabIndex={-1} aria-label={t("review.boqPanel")} className="flex min-h-0 flex-col bg-surface">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="text-panel text-foreground">{t("review.boqPanel")}</h2>
        <Button size="sm" variant="ghost" className="text-primary">{t("review.addManual")}</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="sticky top-0 z-10 border-b border-border bg-surface-sunken px-4 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-dense font-bold text-foreground">{sampleChapter.title}</h3>
            <span className="text-meta font-medium text-foreground">
              <Ltr>{`${sampleChapter.verifiedPct}%`}</Ltr> {t("confidence.high")}
            </span>
          </div>
          <SectionProgress {...sampleChapter.split} className="mt-2" />
        </div>
        <table className="w-full table-fixed border-collapse text-dense">
          <caption className="sr-only">{sampleChapter.title}</caption>
          <thead>
            <tr className="h-8 border-b border-border text-meta text-muted-foreground">
              <th scope="col" className="w-10 ps-3 text-start font-medium"><span className="sr-only">{t("review.columns.conf")}</span></th>
              <th scope="col" className="w-14 text-start font-medium">{t("review.columns.code")}</th>
              <th scope="col" className="text-start font-medium">{t("review.columns.desc")}</th>
              <th scope="col" className="w-14 text-start font-medium">{t("review.columns.unit")}</th>
              <th scope="col" className="w-20 pe-4 text-end font-medium">{t("review.columns.qty")}</th>
            </tr>
          </thead>
          <tbody>
            {sampleRows.map((r, i) => (
              <tr
                key={r.code}
                data-selected={i === 3 || undefined}
                className={cn("h-11 border-b border-border hover:bg-surface-sunken/70", i === 3 && "bg-highlight")}
              >
                {/* 3px level stripe at the row's inline-start (right in RTL). Lives inside the cell:
                    a ::before on <tr> would become an anonymous table cell and shift the columns. */}
                <td className="relative ps-3">
                  <span aria-hidden className={cn("absolute inset-y-0 start-0 w-[3px]", stripe[r.level])} />
                  <ConfidenceBadge level={r.level} variant="indicator" />
                </td>
                <td className="text-muted-foreground"><Ltr>{r.code}</Ltr></td>
                <td className="py-1.5 pe-2">
                  <span className="text-foreground">
                    {r.expandable ? <span aria-hidden className="me-1 text-muted-foreground">▸</span> : null}
                    <MixedText text={r.desc} />
                  </span>
                  {r.meta ? <span className="block text-meta text-muted-foreground"><MixedText text={r.meta} /></span> : null}
                </td>
                <td className="text-muted-foreground">{r.unit}</td>
                <td className="pe-4 text-end font-medium text-foreground"><Ltr>{formatQuantity(r.qty, r.unit === "יח'" ? "יח'" : "מ\"א")}</Ltr></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Wraps Latin/numeric tokens ("16A", "H=180", "25") in <bdi dir="ltr"> per spec RTL rules. */
export function MixedText({ text }: { text: string }) {
  const parts = text.split(/([A-Za-z0-9][A-Za-z0-9.:=×/+-]*)/g);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <Ltr key={i}>{p}</Ltr> : p))}
    </>
  );
}

function QueuePanel() {
  const { t } = useTranslation();
  return (
    <section id="queue-panel" tabIndex={-1} aria-label={t("review.queuePanel")} className="flex min-h-0 flex-col bg-surface">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
        <h2 className="text-panel text-foreground">{t("review.queuePanel")}</h2>
        <span className="text-meta text-muted-foreground">{t("review.queueCount", { count: 23 })}</span>
      </div>
      <ol className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2">
        {sampleQueue.map((q, i) => (
          <li key={i}>
            <QueueCard item={q} active={i === 0} />
          </li>
        ))}
      </ol>
      <p className="shrink-0 border-t border-border px-3 py-2 text-meta text-muted-foreground">
        {t("review.remaining", { count: 23, min: 2 })}
      </p>
    </section>
  );
}

function QueueCard({ item, active }: { item: SampleQueueItem; active: boolean }) {
  const { t } = useTranslation();
  return (
    <article
      className={cn(
        "flex flex-col gap-2 rounded border bg-surface p-2.5",
        active ? "border-primary ring-1 ring-primary" : "border-border",
        item.kind === "cluster" && "border-conf-unknown/40",
      )}
    >
      <div className="flex items-center gap-1.5">
        <ConfidenceBadge level={item.level} size="sm" />
        {item.code ? <Ltr className="text-dense font-medium text-foreground">{item.code}</Ltr> : null}
        {item.count ? (
          <span className="ms-auto text-meta text-muted-foreground">{t("review.occurrences", { count: item.count })}</span>
        ) : null}
      </div>
      <p className="text-dense text-foreground">
        <MixedText text={item.title} />
      </p>
      {item.kind === "cluster" ? (
        <div aria-hidden className="grid grid-cols-4 gap-1">
          {Array.from({ length: 4 }).map((_, i) => (
            <span key={i} className="paper-grid flex aspect-square items-center justify-center rounded-sm border border-border">
              <svg viewBox="0 0 20 20" className="size-4 text-foreground"><path d="M4 14h12M10 4v10M6 8h8" stroke="currentColor" fill="none" strokeWidth="1.2" /></svg>
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <ReasonChip code={item.reasonCode} />
        {item.impact ? (
          <span className="text-meta text-muted-foreground">
            {t("review.impact")}: {item.impact === "high" ? t("review.impactHigh") : t("review.impactMid")}
          </span>
        ) : null}
      </div>
      {active ? (
        <div className="flex items-center gap-1 text-meta text-muted-foreground">
          <Kbd>A</Kbd> {t("review.approve")}
          <Kbd className="ms-2">R</Kbd> {t("review.reject")}
          <ChevronLeft className="ms-auto size-3.5 ltr:rotate-180" aria-hidden />
        </div>
      ) : null}
    </article>
  );
}
