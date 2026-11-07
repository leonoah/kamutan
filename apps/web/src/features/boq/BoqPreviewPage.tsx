import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronDown, ChevronRight, FileSpreadsheet, Printer } from "lucide-react";
import type { BoqDocumentChapter, BoqDocumentColumn, BoqDocumentModel, BoqDocumentQuery, BoqDocumentRow, BoqLine } from "@/api/types";
import { Button } from "@/components/ui/button";
import { ConfidenceShape, levelFromDb } from "@/components/ConfidenceBadge";
import { ManualPriceMarker, UnpricedChip } from "@/features/prices/PriceParts";
import { formatMoneyDelta, formatPct, round2 } from "@/features/prices/model";
import { Ltr } from "@/components/Ltr";
import { formatDateTime, formatQuantity } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useProject } from "@/features/projects/queries";
import { useCurrentOrg } from "@/features/org/useCurrentOrg";
import { chapterLabel, groupByChapter } from "./model";
import { useBoqDocument, useBoqLines, useBoqState, useTemplates } from "./queries";
import { ExportDialog } from "./ExportDialog";
import { ManualNameMarker } from "./ManualNameMarker";
import {
  chapterSubtotal,
  documentLineCount,
  documentQueryFromSearch,
  documentQueryToSearch,
  formatMoney,
  isDescriptionOverridden,
  isNotesHeading,
  lineRows,
  noteRows,
  warningCounts,
} from "./sprint7";

/** Column widths (the Excel's proportions: description wide, numbers narrow). */
const COL_WIDTH: Record<string, string> = {
  code: "w-[4.5rem] print:w-[3rem]",
  unit: "w-[4.75rem] print:w-[3.4rem]",
  qty: "w-[6.25rem] print:w-[4.6rem]",
  unitPrice: "w-[5.5rem] print:w-[3.8rem]",
  total: "w-[6.5rem] print:w-[4.2rem]",
  confidence: "w-[6rem] print:w-[4.4rem]",
  status: "w-[5rem] print:w-[3.4rem]",
};
const CENTER = new Set(["code", "unit", "qty", "confidence", "status"]);
const NUMERIC = new Set(["qty", "unitPrice", "total"]);

/**
 * Sprint 7 (owner request "תצוגה מקדימה של כתב הכמויות"): the BOQ exactly as the Excel will look, rendered from the
 * API's `BoqDocumentModel` (GET …/boq/document) — the same model the Excel writer consumes, so there is no second
 * layout logic here: title rows, the column set, chapters with numbered notes, line rows, "סה"כ" per chapter, grand
 * totals before / after VAT, the warning banner. Options (summed / by floor, confidence columns, chapters) live in the
 * URL. Row → the line in the review workspace. "ייצוא לאקסל" opens the export dialog with the same split; "הדפסה" =
 * window.print() with the print CSS (A4 portrait, RTL, repeating table header, no app chrome). Phones get a stacked list.
 */
export function BoqPreviewPage() {
  const { projectId = "" } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  // local state (instant controls) mirrored to the URL (shareable / back button)
  const [q, setQ] = useState<BoqDocumentQuery>(() => documentQueryFromSearch(sp));
  const project = useProject(projectId);
  const { org } = useCurrentOrg();
  const orgId = project.data?.orgId ?? org?.id ?? null;
  const state = useBoqState(orgId, projectId);
  const buildId = state.data?.latestBuildId ?? null;
  const linesQ = useBoqLines(projectId, buildId);
  const templates = useTemplates(orgId ?? "");
  const noChapters = Boolean(q.chapters && q.chapters.length === 0);
  const doc = useBoqDocument(projectId, q, noChapters ? null : buildId);
  const [exportOpen, setExportOpen] = useState(false);

  const lines = useMemo(() => linesQ.data?.items ?? [], [linesQ.data]);
  const byId = useMemo(() => new Map(lines.map((l) => [l.id, l])), [lines]);
  const chapterOptions = useMemo(
    () => groupByChapter(lines, linesQ.data?.chapters ?? []).map((g) => ({ code: g.code, label: chapterLabel(g.code, g.title) })),
    [lines, linesQ.data?.chapters],
  );
  const setQuery = (next: Partial<BoqDocumentQuery>) => {
    const merged = { ...q, ...next };
    // every chapter ticked = "all"
    if (merged.chapters && chapterOptions.length && chapterOptions.every((c) => merged.chapters!.includes(c.code))) merged.chapters = null;
    setQ(merged);
    setSp(documentQueryToSearch(merged), { replace: true });
  };
  const openLine = (lineId: string) => navigate(`/projects/${projectId}/review?line=${encodeURIComponent(lineId)}`);

  const d = doc.data;
  const notBuilt = state.data !== undefined && !buildId;

  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 py-5 sm:px-6 print:max-w-none print:p-0" data-boq-preview>
      {/* Toolbar (screen only) */}
      <div className="mb-4 flex flex-col gap-3 print:hidden" data-preview-toolbar>
        <nav aria-label={t("app.breadcrumbs")}>
          <Link to={`/projects/${projectId}`} className="inline-flex items-center gap-1 rounded text-dense text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-4 ltr:rotate-180" aria-hidden />
            {project.data?.name ?? t("boq.preview.back")}
          </Link>
        </nav>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-screen text-foreground">{t("boq.preview.title")}</h1>
            <p className="mt-1 text-dense text-muted-foreground">{t("boq.preview.intro")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => window.print()} disabled={!d}>
              <Printer aria-hidden />
              {t("boq.preview.print")}
            </Button>
            <Button onClick={() => setExportOpen(true)} disabled={!buildId}>
              <FileSpreadsheet aria-hidden />
              {t("boq.preview.export")}
            </Button>
          </div>
        </div>
        <PreviewOptions q={q} chapters={chapterOptions} onChange={setQuery} />
      </div>

      {notBuilt ? (
        <div className="rounded-lg border border-border bg-surface p-6 text-body text-foreground print:hidden">
          <p role="status">{t("boq.preview.notBuilt")}</p>
          <Link to={`/projects/${projectId}`} className="mt-2 inline-block text-primary hover:underline">
            {t("boq.preview.back")}
          </Link>
        </div>
      ) : noChapters ? (
        <p role="alert" className="rounded-lg border border-border bg-surface p-6 text-body text-foreground print:hidden">
          {t("boq.preview.chaptersNone")}
        </p>
      ) : doc.isError ? (
        <p role="alert" className="rounded-lg border border-border bg-surface p-6 text-body text-destructive">
          {t("boq.preview.loadError")}
        </p>
      ) : !d ? (
        <p role="status" className="rounded-lg border border-border bg-surface p-6 text-body text-muted-foreground">
          {t("boq.preview.loading")}
        </p>
      ) : (
        <BoqDocumentView doc={d} lines={byId} onOpenLine={openLine} projectId={projectId} busy={doc.isFetching} />
      )}

      <ExportDialog
        projectId={projectId}
        open={exportOpen}
        onOpenChange={setExportOpen}
        lines={lines}
        templates={templates.data ?? []}
        blockOnRed={Boolean(org?.settings?.blockExportOnRed || linesQ.data?.blockExportOnRed)}
        built={Boolean(buildId)}
        canMarkedPdf={org?.role === "admin" || org?.role === "editor"}
        initialSplit={q.split === "floor" ? "byFloor" : "summed"}
        showPreviewLink={false}
        previewOptions={{ includeConfidence: q.confidence, chapters: q.chapters }}
        onGoToItems={() => navigate(`/projects/${projectId}/review?lvl=red`)}
      />
    </div>
  );
}

function PreviewOptions({
  q,
  chapters,
  onChange,
}: {
  q: BoqDocumentQuery;
  chapters: { code: string; label: string }[];
  onChange: (next: Partial<BoqDocumentQuery>) => void;
}) {
  const { t } = useTranslation();
  const picked = q.chapters ? new Set(q.chapters) : null;
  const isOn = (code: string) => !picked || picked.has(code);
  const toggle = (code: string, on: boolean) => {
    const cur = picked ? new Set(picked) : new Set(chapters.map((c) => c.code));
    if (on) cur.add(code);
    else cur.delete(code);
    onChange({ chapters: chapters.map((c) => c.code).filter((c) => cur.has(c)) });
  };
  const summary = !picked ? t("boq.preview.chaptersAll") : t("boq.preview.chaptersSome", { n: chapters.filter((c) => picked.has(c.code)).length, count: chapters.length });
  return (
    <div role="group" aria-label={t("boq.preview.options")} className="flex flex-wrap items-start gap-x-5 gap-y-2 rounded-lg border border-border bg-surface px-3 py-2.5 text-dense">
      <div className="flex items-center gap-2">
        <span id="pv-split" className="text-muted-foreground">
          {t("boq.preview.split")}
        </span>
        <div role="radiogroup" aria-labelledby="pv-split" className="inline-flex rounded-sm border border-input p-0.5">
          {(["none", "floor"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={q.split === v}
              onClick={() => onChange({ split: v })}
              className={cn("rounded-[3px] px-2.5 py-0.5 text-foreground", q.split === v ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
            >
              {v === "floor" ? t("boq.preview.byFloor") : t("boq.preview.summed")}
            </button>
          ))}
        </div>
      </div>
      <label className="inline-flex cursor-pointer items-center gap-1.5 self-center text-foreground">
        <input type="checkbox" checked={q.confidence} onChange={(e) => onChange({ confidence: e.target.checked })} className="size-4 accent-[rgb(var(--primary))]" />
        {t("boq.preview.confidence")}
      </label>
      {chapters.length ? (
        <details className="group relative self-center" data-chapter-picker>
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm border border-input px-2 py-0.5 text-foreground hover:bg-muted">
            <span className="text-muted-foreground">{t("boq.preview.chapters")}:</span> {summary}
            <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden />
          </summary>
          <fieldset className="absolute start-0 top-full z-20 mt-1 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-1 rounded-md border border-border bg-surface p-2.5 shadow-float">
            <legend className="sr-only">{t("boq.preview.chapters")}</legend>
            <label className="inline-flex cursor-pointer items-center gap-2 font-medium text-foreground">
              <input
                type="checkbox"
                checked={!picked}
                onChange={(e) => onChange({ chapters: e.target.checked ? null : [] })}
                className="size-4 accent-[rgb(var(--primary))]"
              />
              {t("boq.preview.chaptersAll")}
            </label>
            {chapters.map((c) => (
              <label key={c.code} className="inline-flex cursor-pointer items-center gap-2 text-foreground">
                <input type="checkbox" checked={isOn(c.code)} onChange={(e) => toggle(c.code, e.target.checked)} className="size-4 shrink-0 accent-[rgb(var(--primary))]" />
                <span className="truncate">{c.label}</span>
              </label>
            ))}
          </fieldset>
        </details>
      ) : null}
    </div>
  );
}

/** The warning banner (same rules as the export gate): red / not approved / waiting for a manual quantity. */
export function PreviewWarning({ doc }: { doc: BoqDocumentModel }) {
  const { t } = useTranslation();
  const parts = warningCounts(doc.warnings);
  if (!parts.length) return null;
  const words = parts.map((p) =>
    t(
      p.kind === "red"
        ? "boq.preview.warnRed"
        : p.kind === "reapproval"
          ? "boq.preview.warnReapproval"
          : p.kind === "unapproved"
            ? "boq.preview.warnUnapproved"
            : "boq.preview.warnNeedsInput",
      { count: p.count },
    ),
  );
  const joined = words.length > 1 ? `${words.slice(0, -1).join(", ")} ו${words[words.length - 1]}` : words[0]!;
  return (
    <div data-preview-warning className="mb-3 flex gap-2.5 rounded-md border border-conf-mid/50 bg-conf-mid/[0.09] px-3 py-2.5 text-dense text-foreground print:hidden">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-conf-mid print:text-black" aria-hidden />
      <div className="flex flex-col gap-0.5">
        <p className="font-bold">{t("boq.preview.warnTitle")}</p>
        <p>{t("boq.preview.warnBody", { parts: joined })}</p>
        {doc.blocked ? <p className="font-medium">{t("boq.preview.warnBlocked")}</p> : null}
      </div>
    </div>
  );
}

/** Sprint 8: lines without a price are not a gate (the export still works) — one quiet line, screen only. */
function UnpricedNote({ doc }: { doc: BoqDocumentModel }) {
  const { t } = useTranslation();
  const n = doc.warnings.find((w) => w.kind === "unpriced")?.count ?? 0;
  if (!n) return null;
  return (
    <p data-preview-unpriced className="mb-3 flex items-center gap-2 text-dense text-foreground print:hidden">
      <UnpricedChip />
      {t("prices.totals.unpricedNote", { count: n })}
    </p>
  );
}

function BoqDocumentView({
  doc,
  lines,
  onOpenLine,
  projectId,
  busy,
}: {
  doc: BoqDocumentModel;
  lines: ReadonlyMap<string, BoqLine>;
  onOpenLine: (lineId: string) => void;
  projectId: string;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const count = documentLineCount(doc);
  return (
    <article
      aria-label={t("boq.preview.caption")}
      aria-busy={busy || undefined}
      data-boq-document
      className="boq-doc rounded-lg border border-border bg-surface p-4 shadow-sm sm:p-6 print:rounded-none print:border-0 print:p-0 print:shadow-none"
    >
      <PreviewWarning doc={doc} />
      <UnpricedNote doc={doc} />
      {/* Title rows (merged + centred in the Excel; the first one larger) */}
      <header className="mb-3 flex flex-col items-center gap-0.5 text-center" data-title-rows>
        {doc.titleRows.map((r, i) =>
          r.kind === "warning" ? (
            // the xlsx warning row (merged, amber fill) — printed; the gate banner above is screen-only
            <p key={i} data-title-kind="warning" className="mb-1 w-full rounded-sm bg-conf-mid/[0.14] px-2 py-1 text-dense font-bold text-foreground print:bg-neutral-200">
              {r.text}
            </p>
          ) : (
            <p
              key={i}
              data-title-kind={r.kind}
              className={cn("font-bold text-foreground", r.kind === "draft" ? "text-body text-conf-low" : i === doc.titleRows.findIndex((x) => x.kind === "title") ? "text-[1.15rem]" : "text-body")}
            >
              {r.text}
            </p>
          ),
        )}
      </header>
      {doc.chapters.length === 0 ? (
        <p className="text-body text-muted-foreground">{t("boq.preview.empty")}</p>
      ) : (
        <>
          <DocTable doc={doc} lines={lines} onOpenLine={onOpenLine} projectId={projectId} />
          <DocList doc={doc} lines={lines} projectId={projectId} />
        </>
      )}
      <p className="mt-3 break-before-avoid text-meta text-muted-foreground" data-generated>
        {t("boq.preview.generated", { at: formatDateTime(doc.generatedAt), lines: t("boq.preview.lines", { count }) })}
      </p>
    </article>
  );
}

const lineHref = (projectId: string, lineId: string) => `/projects/${projectId}/review?line=${encodeURIComponent(lineId)}`;

function Description({ row, line, projectId, linked }: { row: BoqDocumentRow; line: BoqLine | undefined; projectId: string; linked: boolean }) {
  const { t } = useTranslation();
  const renamed = Boolean(row.descriptionOverridden) || (line ? isDescriptionOverridden(line) : false);
  const text = <span className="break-words">{row.description}</span>;
  return (
    <span className="flex flex-col items-start gap-0.5">
      {linked && row.lineId ? (
        <Link
          to={lineHref(projectId, row.lineId)}
          onClick={(e) => e.stopPropagation()}
          className="rounded-sm text-foreground hover:underline print:no-underline"
          aria-label={`${row.description} — ${t("boq.preview.openLine", { code: row.code })}`}
        >
          {text}
        </Link>
      ) : (
        text
      )}
      {renamed ? <ManualNameMarker original={line?.description ?? null} className="print:hidden" /> : null}
    </span>
  );
}

function Qty({ row }: { row: BoqDocumentRow }) {
  const { t } = useTranslation();
  if (row.qty === null)
    return (
      <span data-needs-input className="inline-block whitespace-nowrap rounded-sm border border-dashed border-conf-low/60 px-1 text-[11px] leading-tight text-foreground print:border-black">
        {row.cellNote ?? t("boq.preview.needsInput")}
      </span>
    );
  return <Ltr>{formatQuantity(row.qty, row.unit)}</Ltr>;
}

function ConfidenceCell({ row }: { row: BoqDocumentRow }) {
  const { t } = useTranslation();
  if (!row.level) return null;
  const lv = levelFromDb(row.level);
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-foreground">
      <ConfidenceShape level={lv} className="size-2.5" />
      {t(`confidence.${lv}`)}
    </span>
  );
}

function cellOf(col: BoqDocumentColumn, row: BoqDocumentRow, line: BoqLine | undefined, projectId: string): ReactNode {
  switch (col.key) {
    case "code":
      return <Ltr className="font-mono text-meta">{row.code}</Ltr>;
    case "description":
      return <Description row={row} line={line} projectId={projectId} linked />;
    case "unit":
      return row.unit;
    case "qty":
      return <Qty row={row} />;
    case "unitPrice":
      // Sprint 8: "ללא מחיר" (screen only; the printed / Excel cell stays empty) and "✎ ידני" for the line's own price
      return row.unpriced || row.price === null ? (
        <span className="print:hidden">
          <UnpricedChip />
        </span>
      ) : (
        <span className="inline-flex flex-col items-end">
          <Ltr>{formatMoney(row.price)}</Ltr>
          {row.priceSource === "override" ? <ManualPriceMarker className="print:hidden" /> : null}
        </span>
      );
    case "total":
      return <Ltr>{formatMoney(row.total)}</Ltr>;
    case "confidence":
      return <ConfidenceCell row={row} />;
    case "status":
      return row.status ? <StatusText status={row.status} /> : null;
    default:
      return null;
  }
}

function StatusText({ status }: { status: NonNullable<BoqDocumentRow["status"]> }) {
  const { t } = useTranslation();
  return <span className="whitespace-nowrap">{t(`boq.status.${status}`)}</span>;
}

/** Desktop / tablet / print: the Excel grid. */
function DocTable({ doc, lines, onOpenLine, projectId }: { doc: BoqDocumentModel; lines: ReadonlyMap<string, BoqLine>; onOpenLine: (id: string) => void; projectId: string }) {
  const { t } = useTranslation();
  const cols = doc.columns;
  const n = cols.length;
  const descIdx = Math.max(0, cols.findIndex((c) => c.key === "description"));
  const totalIdx = cols.findIndex((c) => c.key === "total");
  const cell = "border border-[rgb(var(--border-strong))] px-1.5 py-1 align-top print:border-neutral-500";
  /** A label in the description column + an amount in the total column (chapter / grand totals). */
  const sumRow = (key: string, label: string, amount: number | null, opts: { strong?: boolean; data?: string } = {}) => (
    <tr key={key} className={cn("break-inside-avoid", opts.strong && "font-bold")} {...(opts.data ? { [opts.data]: "" } : {})}>
      {cols.map((c, i) => (
        <td key={c.key} className={cn(cell, "border-x-0", i === descIdx && "font-bold", i === totalIdx && "text-end font-bold tabular")}>
          {i === descIdx ? label : i === totalIdx ? <Ltr>{formatMoney(amount ?? 0)}</Ltr> : null}
        </td>
      ))}
    </tr>
  );
  return (
    <div className="hidden overflow-x-auto md:block print:block print:overflow-visible">
      <table className="w-full table-fixed border-collapse text-dense text-foreground" data-boq-table>
        <caption className="sr-only">{t("boq.preview.caption")}</caption>
        <colgroup>
          {cols.map((c) => (
            <col key={c.key} className={COL_WIDTH[c.key]} />
          ))}
        </colgroup>
        <thead className="[display:table-header-group]">
          <tr>
            {cols.map((c) => (
              <th key={c.key} scope="col" className={cn(cell, "bg-surface-sunken py-1.5 text-center font-bold print:bg-neutral-200")}>
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        {doc.chapters.map((ch) => (
          <tbody key={ch.code} data-chapter={ch.code}>
            <tr className="break-after-avoid">
              <th scope="colgroup" colSpan={n} className="border-0 px-1.5 pb-1 pt-4 text-start text-body font-bold underline underline-offset-4">
                {ch.title}
              </th>
            </tr>
            {ch.notes.length && !noteRows(ch).length ? (
              <tr className="break-inside-avoid break-after-avoid">
                <td colSpan={n} className="border-0 px-1.5 pb-2">
                  <p className="font-bold">{t("boq.preview.notes")}</p>
                  <ol className="list-decimal space-y-0.5 ps-5 text-meta">
                    {ch.notes.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ol>
                </td>
              </tr>
            ) : null}
            {ch.rows.map((r, i) =>
              r.kind === "line" ? (
                <tr
                  key={`${r.lineId}-${i}`}
                  data-row-line={r.lineId ?? undefined}
                  data-code={r.code}
                  data-needs-input={r.qty === null || undefined}
                  onClick={() => r.lineId && onOpenLine(r.lineId)}
                  className="cursor-pointer break-inside-avoid hover:bg-primary/[0.05] print:cursor-auto"
                >
                  {cols.map((c) => (
                    <td key={c.key} className={cn(cell, CENTER.has(c.key) && "text-center", NUMERIC.has(c.key) && c.key !== "qty" && "text-end tabular", c.key === "qty" && "tabular")}>
                      {cellOf(c, r, r.lineId ? lines.get(r.lineId) : undefined, projectId)}
                    </td>
                  ))}
                </tr>
              ) : r.kind === "note" ? (
                <tr key={`note-${i}`} className="break-inside-avoid break-after-avoid" data-note-row>
                  <td colSpan={n} className={cn("border-0 px-1.5", isNotesHeading(r) ? "pb-0.5 pt-1 font-bold" : "py-0.5 ps-4 text-meta")}>
                    {r.description}
                  </td>
                </tr>
              ) : null,
            )}
            {sumRow(`sub-${ch.code}`, t("boq.preview.subtotal"), chapterSubtotal(ch), { data: "data-subtotal" })}
          </tbody>
        ))}
        <tbody data-grand-totals className="break-inside-avoid">
          <tr aria-hidden>
            <td colSpan={n} className="h-3 border-0" />
          </tr>
          {doc.totals.adjustmentPct && doc.totals.linesTotal !== undefined ? sumRow("subtotal", t("prices.totals.subtotal"), doc.totals.linesTotal, { data: "data-doc-subtotal" }) : null}
          {doc.totals.adjustmentPct ? (
            <tr className="break-inside-avoid" data-adjustment>
              {cols.map((c, i) => (
                <td key={c.key} className={cn(cell, "border-x-0", i === descIdx && "font-bold", i === totalIdx && "text-end font-bold tabular")}>
                  {i === descIdx
                    ? t(doc.totals.adjustmentPct! < 0 ? "prices.totals.discount" : "prices.totals.markup", { pct: formatPct(Math.abs(doc.totals.adjustmentPct!)) })
                    : i === totalIdx
                      ? <Ltr>{formatMoneyDelta(doc.totals.adjustment ?? 0)}</Ltr>
                      : null}
                </td>
              ))}
            </tr>
          ) : null}
          {sumRow("grand", t("boq.preview.grandTotal"), doc.totals.beforeVat, { strong: true })}
          {doc.vatRate !== undefined ? sumRow("vat", t("boq.preview.vat", { pct: round2(doc.vatRate * 100) }), doc.totals.vat) : null}
          {sumRow("grand-vat", t("boq.preview.grandTotalVat"), doc.totals.afterVat, { strong: true })}
        </tbody>
      </table>
    </div>
  );
}

/** Phones: one readable card per line, grouped by chapter (no horizontal scroll). */
function DocList({ doc, lines, projectId }: { doc: BoqDocumentModel; lines: ReadonlyMap<string, BoqLine>; projectId: string }) {
  const { t } = useTranslation();
  const has = (k: string) => doc.columns.some((c) => c.key === k);
  return (
    <div className="flex flex-col gap-4 md:hidden print:hidden" data-boq-list>
      {doc.chapters.map((ch: BoqDocumentChapter) => (
        <section key={ch.code} aria-labelledby={`pv-ch-${ch.code}`} data-chapter={ch.code}>
          <h2 id={`pv-ch-${ch.code}`} className="mb-1.5 text-body font-bold text-foreground underline underline-offset-4">
            {ch.title}
          </h2>
          {ch.notes.length ? (
            <details className="mb-2 text-meta text-muted-foreground">
              <summary className="cursor-pointer">{t("boq.chapterNotes", { count: ch.notes.length })}</summary>
              <ol className="mt-1 list-decimal space-y-0.5 ps-5">
                {ch.notes.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ol>
            </details>
          ) : null}
          <ul className="divide-y divide-border rounded-md border border-border">
            {lineRows(ch).map((r, i) => (
              <li key={`${r.lineId}-${i}`} data-row-line={r.lineId ?? undefined} data-code={r.code} className="flex flex-col gap-1 px-3 py-2 text-dense">
                <div className="flex items-start gap-2">
                  <Ltr className="shrink-0 pt-px font-mono text-meta text-muted-foreground">{r.code}</Ltr>
                  <div className="min-w-0 flex-1">
                    <Description row={r} line={r.lineId ? lines.get(r.lineId) : undefined} projectId={projectId} linked />
                  </div>
                </div>
                <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 ps-10 text-meta">
                  <div className="flex items-center gap-1">
                    <dt className="text-muted-foreground">{t("boq.preview.cardQty")}</dt>
                    <dd className="font-medium tabular text-foreground">
                      <Qty row={r} /> {r.qty !== null ? <span className="font-normal text-muted-foreground">{r.unit}</span> : null}
                    </dd>
                  </div>
                  {has("total") && r.total !== null ? (
                    <div className="flex items-center gap-1">
                      <dt className="text-muted-foreground">{t("boq.preview.cardTotal")}</dt>
                      <dd className="tabular text-foreground">
                        <Ltr>{formatMoney(r.total)}</Ltr>
                      </dd>
                    </div>
                  ) : null}
                  {r.level ? (
                    <div>
                      <dt className="sr-only">{t("boq.columns.conf")}</dt>
                      <dd>
                        <ConfidenceCell row={r} />
                      </dd>
                    </div>
                  ) : null}
                  {r.status ? (
                    <div>
                      <dt className="sr-only">{t("boq.columns.status")}</dt>
                      <dd className="text-muted-foreground">
                        <StatusText status={r.status} />
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 flex justify-between px-1 text-dense font-bold text-foreground" data-subtotal>
            <span>{t("boq.preview.subtotal")}</span>
            <Ltr>{formatMoney(chapterSubtotal(ch) ?? 0)}</Ltr>
          </p>
        </section>
      ))}
      <dl className="flex flex-col gap-1 border-t border-border pt-3 text-dense text-foreground" data-grand-totals>
        {doc.totals.adjustmentPct ? (
          <>
            <div className="flex justify-between">
              <dt>{t("prices.totals.subtotal")}</dt>
              <dd>
                <Ltr>{formatMoney(doc.totals.linesTotal ?? 0)}</Ltr>
              </dd>
            </div>
            <div className="flex justify-between" data-adjustment>
              <dt>{t(doc.totals.adjustmentPct < 0 ? "prices.totals.discount" : "prices.totals.markup", { pct: formatPct(Math.abs(doc.totals.adjustmentPct)) })}</dt>
              <dd>
                <Ltr>{formatMoneyDelta(doc.totals.adjustment ?? 0)}</Ltr>
              </dd>
            </div>
          </>
        ) : null}
        <div className="flex justify-between font-bold">
          <dt>{t("boq.preview.grandTotal")}</dt>
          <dd>
            <Ltr>{formatMoney(doc.totals.beforeVat)}</Ltr>
          </dd>
        </div>
        {doc.vatRate !== undefined ? (
          <div className="flex justify-between">
            <dt>{t("boq.preview.vat", { pct: round2(doc.vatRate * 100) })}</dt>
            <dd>
              <Ltr>{formatMoney(doc.totals.vat)}</Ltr>
            </dd>
          </div>
        ) : null}
        <div className="flex justify-between font-bold">
          <dt>{t("boq.preview.grandTotalVat")}</dt>
          <dd>
            <Ltr>{formatMoney(doc.totals.afterVat)}</Ltr>
          </dd>
        </div>
      </dl>
    </div>
  );
}
