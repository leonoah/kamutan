import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, ChevronRight, FileSpreadsheet, Minus, Plus } from "lucide-react";
import { useApi } from "@/api/client";
import { ApiError, type BoqCompareItem, type BoqCompareQuery, type BoqComparison, type BoqBuildSummary } from "@/api/types";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { Ltr } from "@/components/Ltr";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { fmtQty } from "@/features/boq/model";
import { useBoqState } from "@/features/boq/queries";
import { useProject } from "@/features/projects/queries";
import { formatMoney, formatMoneyDelta } from "@/features/prices/model";

type Mode = "previous" | "export" | "pick";
type Kind = BoqCompareItem["kind"];
type Show = "all" | Kind;

/** Signed quantity: "+3", "−2", "0" (true minus sign; shown inside an LTR island). */
export const fmtDeltaQty = (n: number): string => (n === 0 ? "0" : `${n > 0 ? "+" : "−"}${fmtQty(Math.abs(n))}`);

/**
 * URL state → contracts BoqCompareQuery: `?base=export` ("מאז הייצוא האחרון"), `?from=<build>[&to=<build>]` (explicit;
 * without `to` the "to" side is the LIVE BOQ), nothing = latest vs the build before it.
 */
export function compareQueryOf(params: URLSearchParams): { mode: Mode; query: BoqCompareQuery } {
  const from = params.get("from");
  const to = params.get("to");
  if (from) return { mode: "pick", query: { from, ...(to ? { to } : {}) } };
  return params.get("base") === "export" ? { mode: "export", query: { base: "export" } } : { mode: "previous", query: { base: "previous" } };
}

const KIND_ICON = { added: Plus, removed: Minus, changed: ArrowLeftRight } as const;
const KIND_TONE = {
  added: "border-conf-high/50 bg-conf-high/[0.08]",
  removed: "border-destructive/40 bg-destructive/[0.06]",
  changed: "border-conf-mid/50 bg-conf-mid/[0.1]",
} as const;

/**
 * "מה השתנה" (SPRINT8_BRIEF §2, contracts compare.ts `kamutan.boq-compare/1`): two BOQ versions — added / removed /
 * changed lines with Δqty, Δ₪ and their causes (sheet versions → links to the sheet analysis, manual quantity / price,
 * library price). Default: the LIVE BOQ vs the build before the latest; "מאז הייצוא האחרון"; or any build (picker from
 * `GET …/boq/builds`). Exports "תוספות ושינויים" to Excel.
 */
export function ComparePage() {
  const { projectId = "" } = useParams();
  const { t } = useTranslation();
  const api = useApi();
  const project = useProject(projectId);
  const [params, setParams] = useSearchParams();
  const { mode, query } = compareQueryOf(params);
  const [show, setShow] = useState<Show>("all");
  // keyed by the latest build: a (re)build finished elsewhere refreshes the comparison
  const latest = useBoqState(project.data?.orgId ?? null, projectId).data?.latestBuildId ?? null;
  const builds = useQuery({ queryKey: ["boq-builds", projectId, latest], queryFn: () => api.listBoqBuilds(projectId), staleTime: 10_000, retry: false });
  const comparable = useMemo(() => (builds.data ?? []).filter((b) => b.status === "succeeded" && b.hasSnapshot), [builds.data]);
  const cmp = useQuery({
    queryKey: ["boq-compare", projectId, latest, query],
    queryFn: () => api.compareBoqBuilds(projectId, query),
    enabled: !(query.from && query.to && query.from === query.to),
    retry: false,
    placeholderData: (prev) => prev,
  });
  const exp = useMutation({ mutationFn: () => api.exportBoqComparison(projectId, query) });
  const setQuery = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const k of ["base", "from", "to"]) p.delete(k);
    for (const [k, v] of Object.entries(next)) if (v !== null) p.set(k, v);
    setParams(p, { replace: true });
  };
  const setMode = (m: Mode) => {
    if (m === "previous") setQuery({});
    else if (m === "export") setQuery({ base: "export" });
    else setQuery({ from: comparable.find((b) => !b.latest)?.buildId ?? comparable[0]?.buildId ?? null });
  };
  const data: BoqComparison | undefined = cmp.data;
  const items = useMemo(() => (data?.items ?? []).filter((l) => show === "all" || l.kind === show), [data, show]);
  const err = cmp.error instanceof ApiError ? cmp.error : null;
  const download = async () => {
    try {
      const r = await exp.mutateAsync();
      const a = document.createElement("a");
      a.href = r.url;
      a.download = r.fileName;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast({ title: t("compare.exportDone", { name: r.fileName }), tone: "success" });
    } catch (e) {
      toast({ title: e instanceof ApiError && /[֐-׿]/.test(e.message) ? e.message : t("compare.exportError"), tone: "error" });
    }
  };
  const buildLabel = (b: BoqBuildSummary) => {
    const date = formatDateTime(b.finishedAt ?? b.createdAt ?? "");
    const base = !b.hasSnapshot
      ? t("compare.buildNoSnapshot", { date })
      : t(b.exportedAt ? "compare.buildOptionExported" : "compare.buildOption", { date, lines: b.lineCount ?? "—" });
    return b.latest ? `${base} (${t("compare.latest")})` : base;
  };
  const modes: { id: Mode; label: string }[] = [
    { id: "previous", label: t("compare.pickPrevious") },
    { id: "export", label: t("compare.pickLastExport") },
    ...(comparable.length > 1 ? [{ id: "pick" as const, label: t("compare.pickBuild") }] : []),
  ];
  const count = (k: Show) => (k === "all" ? (data?.items.length ?? 0) : (data?.items.filter((l) => l.kind === k).length ?? 0));

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-6 sm:px-6" data-compare-page>
      <nav aria-label={t("app.breadcrumbs")}>
        <Link to={`/projects/${projectId}`} className="inline-flex items-center gap-1 rounded text-dense text-muted-foreground hover:text-foreground">
          <ChevronRight className="size-4 ltr:rotate-180" aria-hidden />
          {project.data?.name ?? t("compare.back")}
        </Link>
      </nav>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-screen text-foreground">{t("compare.title")}</h1>
          <p className="mt-1 max-w-2xl text-dense text-muted-foreground">{t("compare.subtitle")}</p>
        </div>
        <Button onClick={() => void download()} disabled={!data || exp.isPending || data.items.length === 0}>
          <FileSpreadsheet aria-hidden />
          {exp.isPending ? t("compare.exporting") : t("compare.export")}
        </Button>
      </div>

      <section className="flex flex-wrap items-end gap-x-5 gap-y-3 rounded-lg border border-border bg-surface p-4" aria-label={t("compare.pickLabel")}>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-dense font-medium text-foreground">{t("compare.pickLabel")}</legend>
          <div role="radiogroup" aria-label={t("compare.pickLabel")} className="inline-flex flex-wrap rounded-sm border border-input p-0.5">
            {modes.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={mode === m.id}
                onClick={() => setMode(m.id)}
                className={cn("rounded-[3px] px-2.5 py-1 text-dense text-foreground", mode === m.id ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
              >
                {m.label}
              </button>
            ))}
          </div>
        </fieldset>
        {mode === "pick" && comparable.length ? (
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-dense text-foreground">
              {t("compare.buildFrom")}
              <select value={query.from ?? ""} onChange={(e) => setQuery({ from: e.target.value, to: query.to ?? null })} className="h-9 max-w-80 rounded border border-input bg-surface px-2 text-dense text-foreground" data-build-select="from">
                {comparable.map((b) => (
                  <option key={b.buildId} value={b.buildId}>
                    {buildLabel(b)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-dense text-foreground">
              {t("compare.buildTo")}
              <select value={query.to ?? ""} onChange={(e) => setQuery({ from: query.from ?? null, to: e.target.value || null })} className="h-9 max-w-80 rounded border border-input bg-surface px-2 text-dense text-foreground" data-build-select="to">
                <option value="">{t("compare.buildCurrent")}</option>
                {comparable.map((b) => (
                  <option key={b.buildId} value={b.buildId}>
                    {buildLabel(b)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}
        {data ? (
          <div className="flex flex-col gap-0.5">
            <p className="text-meta text-muted-foreground" data-compare-range>
              <Ltr>{data.from.at ? formatDateTime(data.from.at) : "—"}</Ltr> ← <Ltr>{data.to.at ? formatDateTime(data.to.at) : "—"}</Ltr>
            </p>
            {data.to.live ? <p className="text-meta text-muted-foreground" data-compare-live>{t("compare.live")}</p> : null}
          </div>
        ) : null}
      </section>

      {query.from && query.to && query.from === query.to ? (
        <p role="alert" className="text-body text-foreground">{t("compare.sameBuild")}</p>
      ) : cmp.isLoading ? (
        <p role="status" className="text-body text-muted-foreground">{t("common.loading")}</p>
      ) : cmp.isError ? (
        // 409 not_ready: the API's Hebrew text (contracts COMPARE_NO_PREVIOUS_HE / _NO_EXPORT_HE / _NO_SNAPSHOT_HE)
        <p role={err?.status === 409 ? "status" : "alert"} className="rounded-lg border border-border bg-surface p-6 text-center text-body text-foreground" data-compare-empty={err?.code ?? "error"}>
          {err && err.status === 409 && /[֐-׿]/.test(err.message) ? err.message : t("compare.loadError")}
        </p>
      ) : data ? (
        <>
          <ul className="flex flex-wrap gap-2 text-dense" aria-label={t("compare.title")} data-compare-summary>
            <SummaryChip kind="added" text={t("compare.summaryAdded", { count: data.summary.added })} />
            <SummaryChip kind="removed" text={t("compare.summaryRemoved", { count: data.summary.removed })} />
            <SummaryChip kind="changed" text={t("compare.summaryChanged", { count: data.summary.changed })} />
            <li className="inline-flex h-8 items-center rounded-sm border border-border px-2.5 text-muted-foreground">{t("compare.summaryUnchanged", { count: data.summary.unchanged })}</li>
            {data.summary.deltaTotal !== null ? (
              <li className="inline-flex h-8 items-center rounded-sm border border-border px-2.5 font-bold text-foreground" data-compare-delta>
                {t("compare.summaryDelta", { amount: "" })}
                <Ltr className="ms-1">{formatMoneyDelta(data.summary.deltaTotal)}</Ltr>
              </li>
            ) : null}
          </ul>
          {data.sheetChanges.length ? (
            <details className="rounded-lg border border-border bg-surface px-4 py-2 text-dense" data-sheet-changes>
              <summary className="cursor-pointer text-foreground">
                {t("compare.sheetChanges")} ({data.sheetChanges.length})
              </summary>
              <ul className="mt-1.5 flex flex-col gap-1">
                {data.sheetChanges.map((c) => (
                  <li key={c.sheetId} className="flex flex-wrap gap-x-2">
                    <span className="text-muted-foreground">{t(`compare.sheetChangeKind.${c.kind}`)}</span>
                    {c.kind !== "removed" ? (
                      <Link to={`/projects/${projectId}/sheets/${encodeURIComponent(c.sheetId)}`} className="text-primary hover:underline">
                        <bdi>{c.title ?? c.sheetId}</bdi>
                      </Link>
                    ) : (
                      <bdi>{c.title ?? c.sheetId}</bdi>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {data.items.length === 0 ? (
            <p className="rounded-lg border border-border bg-surface p-6 text-center text-body text-muted-foreground">{t("compare.noChanges")}</p>
          ) : (
            <>
              <div role="radiogroup" aria-label={t("compare.filterLabel")} className="inline-flex flex-wrap self-start rounded-sm border border-input p-0.5 text-dense">
                {(["all", "added", "removed", "changed"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={show === k}
                    onClick={() => setShow(k)}
                    className={cn("rounded-[3px] px-2.5 py-1 text-foreground", show === k ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
                  >
                    {t(`compare.filter${k === "all" ? "All" : k === "added" ? "Added" : k === "removed" ? "Removed" : "Changed"}`, { count: count(k) })}
                  </button>
                ))}
              </div>
              <CompareTable projectId={projectId} items={items} />
              <CompareList projectId={projectId} items={items} />
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

function SummaryChip({ kind, text }: { kind: Kind; text: string }) {
  const Icon = KIND_ICON[kind];
  return (
    <li className={cn("inline-flex h-8 items-center gap-1.5 rounded-sm border px-2.5 text-foreground", KIND_TONE[kind])} data-summary={kind}>
      <Icon className="size-3.5" aria-hidden />
      {text}
    </li>
  );
}

function KindBadge({ kind }: { kind: Kind }) {
  const { t } = useTranslation();
  const Icon = KIND_ICON[kind];
  return (
    <span className={cn("inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-sm border px-1.5 text-meta font-medium text-foreground", KIND_TONE[kind])} data-kind={kind}>
      <Icon className="size-3" aria-hidden />
      {t(`compare.kind.${kind}`)}
    </span>
  );
}

function Side({ qty, price, unit }: { qty: number | null; price: number | null; unit: string }) {
  const { t } = useTranslation();
  if (qty === null) return <span className="text-muted-foreground" aria-hidden>—</span>;
  return (
    <span className="flex flex-col items-end leading-tight">
      <span className="tabular text-foreground">
        <Ltr>{fmtQty(qty)}</Ltr> <span className="text-meta text-muted-foreground">{unit}</span>
      </span>
      <span className="text-[11px] text-muted-foreground">{price === null ? t("compare.noPrice") : <Ltr>{`× ${formatMoney(price)}`}</Ltr>}</span>
    </span>
  );
}

function Causes({ projectId, item }: { projectId: string; item: BoqCompareItem }) {
  const { t } = useTranslation();
  return (
    <ul className="flex flex-col gap-1">
      {item.kind === "changed" && item.changes.length ? (
        <li className="text-meta text-muted-foreground" data-changed-fields>
          {t("compare.changedFields", { list: item.changes.map((c) => t(`compare.changeField.${c}`)).join(", ") })}
        </li>
      ) : null}
      {item.causes.map((c, i) => {
        if (c.kind !== "sheet")
          return (
            <li key={`${c.kind}-${i}`} className="text-meta text-foreground" data-cause={c.kind}>
              {t(`compare.causeKind.${c.kind}`)}
            </li>
          );
        const name = c.title ?? c.sheetId;
        const kind = c.fromVersionId === null ? "added" : c.toVersionId === null ? "removed" : "revised";
        return (
          <li key={`${c.sheetId}-${i}`} className="text-meta" data-cause="sheet">
            <span className="text-muted-foreground">{t(`compare.causeKind.${kind}`)}</span>
            {kind !== "removed" ? (
              <Link to={`/projects/${projectId}/sheets/${encodeURIComponent(c.sheetId)}`} className="block truncate text-primary hover:underline" data-cause-link={c.sheetId}>
                <bdi>{name}</bdi>
                <span className="sr-only"> — {t("compare.causeLink", { name })}</span>
              </Link>
            ) : (
              <bdi className="block truncate text-foreground">{name}</bdi>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Description({ projectId, item: l }: { projectId: string; item: BoqCompareItem }) {
  const { t } = useTranslation();
  return l.kind !== "removed" ? (
    <Link to={`/projects/${projectId}/review?line=${encodeURIComponent(l.lineId)}`} className="line-clamp-2 text-foreground hover:text-primary hover:underline">
      {l.description}
      <span className="sr-only"> — {t("compare.openLine", { code: l.code })}</span>
    </Link>
  ) : (
    <span className="line-clamp-2 text-muted-foreground line-through">{l.description}</span>
  );
}

const delta = (n: number | null, money = false) =>
  n === null ? <span className="text-muted-foreground">—</span> : <Ltr className={cn("tabular font-medium", n > 0 ? "text-foreground" : n < 0 ? "text-destructive" : "text-muted-foreground")}>{money ? formatMoneyDelta(n) : fmtDeltaQty(n)}</Ltr>;

function CompareTable({ projectId, items }: { projectId: string; items: BoqCompareItem[] }) {
  const { t } = useTranslation();
  const th = "sticky top-0 z-10 h-9 border-b border-border bg-surface-sunken px-2 text-start font-medium";
  return (
    <div className="hidden overflow-x-auto rounded-lg border border-border bg-surface md:block">
      <table className="w-full border-collapse text-dense" data-compare-table>
        <caption className="sr-only">{t("compare.caption")}</caption>
        <thead>
          <tr className="text-meta text-muted-foreground">
            <th scope="col" className={cn(th, "w-24")}>{t("compare.columns.change")}</th>
            <th scope="col" className={cn(th, "w-16")}>{t("compare.columns.code")}</th>
            <th scope="col" className={th}>{t("compare.columns.desc")}</th>
            <th scope="col" className={cn(th, "w-32 text-end")}>{t("compare.columns.before")}</th>
            <th scope="col" className={cn(th, "w-32 text-end")}>{t("compare.columns.after")}</th>
            <th scope="col" className={cn(th, "w-20 text-end")}>{t("compare.columns.dQty")}</th>
            <th scope="col" className={cn(th, "w-28 text-end")}>{t("compare.columns.dTotal")}</th>
            <th scope="col" className={cn(th, "w-56")}>{t("compare.columns.causes")}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((l) => (
            <tr key={`${l.kind}-${l.lineId}`} data-compare-line={l.code} data-change={l.kind} className="border-b border-border align-top last:border-0 hover:bg-surface-sunken/50">
              <td className="px-2 py-2">
                <KindBadge kind={l.kind} />
              </td>
              <td className="px-2 py-2 font-mono text-meta text-foreground">
                <Ltr>{l.code}</Ltr>
              </td>
              <td className="px-2 py-2">
                <Description projectId={projectId} item={l} />
              </td>
              <td className="px-2 py-2 text-end">
                <Side qty={l.fromQty} price={l.fromPrice} unit={l.unit} />
              </td>
              <td className="px-2 py-2 text-end">
                <Side qty={l.toQty} price={l.toPrice} unit={l.unit} />
              </td>
              <td className="px-2 py-2 text-end">{delta(l.deltaQty)}</td>
              <td className="px-2 py-2 text-end" data-delta-total>
                {delta(l.deltaTotal, true)}
              </td>
              <td className="px-2 py-2">
                <Causes projectId={projectId} item={l} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Phones: one card per changed line. */
function CompareList({ projectId, items }: { projectId: string; items: BoqCompareItem[] }) {
  const { t } = useTranslation();
  return (
    <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface md:hidden" data-compare-list>
      {items.map((l) => (
        <li key={`${l.kind}-${l.lineId}`} className="flex flex-col gap-1.5 px-3 py-2.5 text-dense" data-compare-line={l.code}>
          <div className="flex items-start gap-2">
            <KindBadge kind={l.kind} />
            <Ltr className="pt-1 font-mono text-meta text-muted-foreground">{l.code}</Ltr>
            <div className="min-w-0 flex-1 pt-0.5">
              <Description projectId={projectId} item={l} />
            </div>
          </div>
          <dl className="flex flex-wrap gap-x-4 gap-y-1 text-meta">
            <div className="flex gap-1">
              <dt className="text-muted-foreground">{t("compare.columns.dQty")}</dt>
              <dd>{delta(l.deltaQty)}</dd>
            </div>
            <div className="flex gap-1">
              <dt className="text-muted-foreground">{t("compare.columns.dTotal")}</dt>
              <dd>{delta(l.deltaTotal, true)}</dd>
            </div>
          </dl>
          <Causes projectId={projectId} item={l} />
        </li>
      ))}
    </ul>
  );
}
