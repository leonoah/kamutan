import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Pencil, Upload } from "lucide-react";
import { useBackend } from "@/api/client";
import type { LibraryImport, LibraryItem, PriceImportReport } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/components/ui/toast";
import { Ltr } from "@/components/Ltr";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { bulkPlanPrices, formatMoney, importApplyCounts, parseMoney, parsePct, type BulkPriceMode } from "./model";
import { useApplyPriceImport, useBulkPrices, useItemPrice } from "./queries";
import { useLibraryItems } from "@/features/boq/queries";

/**
 * Library price cell: the price + where it came from; editors click to edit in place (Enter saves, Esc cancels, an
 * empty value clears the price). Optimistic, one toast.
 */
export function InlinePrice({ orgId, item, canEdit }: { orgId: string; item: LibraryItem; canEdit: boolean }) {
  const { t } = useTranslation();
  const save = useItemPrice(orgId);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const price = item.price ?? null;
  const parsed = parseMoney(value);
  const bad = parsed !== null && Number.isNaN(parsed);
  const commit = () => {
    if (bad) return;
    setEditing(false);
    if ((price?.amount ?? null) === parsed) return;
    save.mutate(
      { itemId: item.id, amount: parsed },
      {
        onSuccess: () => toast({ title: parsed === null ? t("prices.library.cleared", { code: item.code }) : t("prices.library.saved", { code: item.code }), tone: "success" }),
        onError: () => toast({ title: t("prices.library.error"), tone: "error" }),
      },
    );
  };
  if (editing)
    return (
      <span className="flex flex-col items-end gap-0.5" data-price-editor={item.id}>
        <label htmlFor={id} className="sr-only">
          {t("prices.library.editFor", { code: item.code })}
        </label>
        <Input
          ref={input}
          id={id}
          dir="ltr"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setEditing(false);
            }
          }}
          onBlur={() => (bad ? setEditing(false) : commit())}
          aria-invalid={bad}
          aria-describedby={`${id}-h`}
          className="h-8 w-28 text-end tabular"
        />
        <span id={`${id}-h`} className={cn("text-[11px]", bad ? "text-destructive" : "text-muted-foreground")}>
          {bad ? t("prices.library.invalid") : t("prices.library.inlineHint")}
        </span>
      </span>
    );
  const shown = (
    <>
      {price ? (
        <Ltr className="tabular font-medium text-foreground">{formatMoney(price.amount)}</Ltr>
      ) : (
        <span className="text-muted-foreground">
          <span aria-hidden>{t("prices.library.none")}</span>
          <span className="sr-only">{t("prices.library.noneSr")}</span>
        </span>
      )}
      {price ? (
        <span className={cn("text-[11px]", price.source === "manual" ? "text-manual" : "text-muted-foreground")} title={price.updatedAt ? t("prices.library.updated", { date: formatDate(price.updatedAt) }) : undefined}>
          {price.source === "manual" ? `✎ ${t("prices.library.sourceManual")}` : t("prices.library.sourceImport")}
        </span>
      ) : null}
    </>
  );
  if (!canEdit) return <span className="flex flex-col items-end leading-tight" data-item-price={item.id}>{shown}</span>;
  return (
    <button
      type="button"
      data-item-price={item.id}
      onClick={() => {
        setValue(price ? price.amount.toFixed(2) : "");
        setEditing(true);
      }}
      className="group/price inline-flex items-center gap-1.5 rounded-sm px-1 py-0.5 hover:bg-primary/10"
    >
      <span className="flex flex-col items-end leading-tight">{shown}</span>
      <Pencil className="size-3 text-muted-foreground opacity-0 group-hover/price:opacity-100 group-focus-visible/price:opacity-100" aria-hidden />
      <span className="sr-only"> — {t("prices.library.editFor", { code: item.code })}</span>
    </button>
  );
}

/** Bulk edit of the selected items: set one price / change by % / clear — preview count, one request, one toast. */
export function BulkPriceDialog({ orgId, items, open, onOpenChange, onDone }: { orgId: string; items: LibraryItem[]; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const { t } = useTranslation();
  const bulk = useBulkPrices(orgId);
  const [mode, setMode] = useState<"set" | "pct" | "clear">("set");
  const [value, setValue] = useState("");
  const vid = useId();
  useEffect(() => {
    if (open) {
      setMode("set");
      setValue("");
    }
  }, [open]);
  const plan = useMemo((): { itemId: string; amount: number | null }[] | null => {
    let m: BulkPriceMode;
    if (mode === "clear") m = { kind: "clear" };
    else if (mode === "set") {
      const a = parseMoney(value);
      if (a === null || Number.isNaN(a)) return null;
      m = { kind: "set", amount: a };
    } else {
      const p = parsePct(value, -99.99, 1000);
      if (p === null || Number.isNaN(p)) return null;
      m = { kind: "pct", pct: p };
    }
    return bulkPlanPrices(items, m);
  }, [items, mode, value]);
  const skipped = mode === "pct" ? items.filter((i) => !i.price).length : 0;
  const modes: { id: typeof mode; label: string }[] = [
    { id: "set", label: t("prices.library.bulkSet") },
    { id: "pct", label: t("prices.library.bulkPct") },
    { id: "clear", label: t("prices.library.bulkClear") },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-bulk-price-dialog>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!plan?.length) return;
            bulk.mutate(
              { items: plan },
              {
                onSuccess: (r) => {
                  toast({ title: t("prices.library.bulkDone", { count: r.updated.length }), tone: "success" });
                  onOpenChange(false);
                  onDone();
                },
                onError: () => toast({ title: t("prices.library.error"), tone: "error" }),
              },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("prices.library.bulkTitle")}</DialogTitle>
            <DialogDescription>{t("prices.library.selected", { count: items.length })}</DialogDescription>
          </DialogHeader>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-dense font-medium text-foreground">{t("prices.library.bulkMode")}</legend>
            {modes.map((m) => (
              <label key={m.id} className="inline-flex cursor-pointer items-center gap-2 text-dense text-foreground">
                <input type="radio" name="bulk-mode" checked={mode === m.id} onChange={() => setMode(m.id)} className="size-4 accent-[rgb(var(--primary))]" />
                {m.label}
              </label>
            ))}
          </fieldset>
          {mode !== "clear" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={vid}>{mode === "set" ? t("prices.library.bulkAmount") : t("prices.library.bulkPctLabel")}</Label>
              <Input id={vid} dir="ltr" inputMode="decimal" autoFocus value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={value !== "" && !plan} className="w-36 text-end tabular" />
              {value !== "" && !plan ? <p role="alert" className="text-meta text-destructive">{t("prices.library.bulkInvalid")}</p> : null}
            </div>
          ) : null}
          <div role="status" className="text-dense text-foreground" data-bulk-preview>
            {plan ? <p>{t("prices.library.bulkPreview", { count: plan.length })}</p> : null}
            {skipped ? <p className="text-meta text-muted-foreground">{t("prices.library.bulkSkipped", { count: skipped })}</p> : null}
          </div>
          <p className="text-meta text-muted-foreground">{t("prices.library.historyNote")}</p>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              {t("prices.override.cancel")}
            </Button>
            <Button type="submit" disabled={!plan?.length || bulk.isPending}>
              {t("prices.library.bulkApply")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const MAX_BYTES = 20 * 1024 * 1024;
type Phase = { kind: "pick"; error?: string } | { kind: "uploading"; pct: number; name: string } | { kind: "processing"; importId: string; name: string } | { kind: "done"; applied: number; overwritten: number; kept: number };
type Tab = "matched" | "conflicts" | "unmatched";
type Reason = PriceImportReport["conflictRows"][number]["reason"];

/** One review row, built from the contracts PriceImportReport (`planned` / `conflictRows` / `unmatchedRows`). */
export interface ReviewRow {
  key: string;
  code: string;
  itemId: string | null;
  description: string | null;
  current: number | null;
  currentManual: boolean;
  incoming: number;
  reason?: Reason;
}

/** Review rows per tab: matched = the dry run's `planned` writes; conflicts = every conflict row; unmatched = not in the library. */
export function reviewRows(r: PriceImportReport, describe: (itemId: string | null) => string | null = () => null): Record<Tab, ReviewRow[]> {
  return {
    matched: (r.planned ?? []).map((p) => ({ key: `p-${p.itemId}`, code: p.code, itemId: p.itemId, description: describe(p.itemId), current: p.current, currentManual: p.currentSource === "manual", incoming: p.amount })),
    conflicts: r.conflictRows.map((c) => ({ key: `c-${c.row}-${c.itemId ?? c.code}`, code: c.code, itemId: c.itemId, description: describe(c.itemId), current: c.current, currentManual: c.reason === "manual_price", incoming: c.incoming, reason: c.reason })),
    unmatched: r.unmatchedRows.map((u) => ({ key: `u-${u.row}`, code: u.code, itemId: null, description: u.description, current: null, currentManual: false, incoming: u.amount })),
  };
}

/**
 * Import prices from a priced past BOQ: upload (`mode: prices`, `dryRun: true` — nothing is written yet) → progress →
 * REVIEW of the report (matched / conflicts / not in the library) → `apply-prices` with the manual prices the user chose
 * to replace (`overwriteItemIds`). A manual price is replaced only by an explicit choice per item (or "החלף הכל").
 */
export function PriceImportDialog({ orgId, open, onOpenChange }: { orgId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const { api, uploads } = useBackend();
  const apply = useApplyPriceImport(orgId);
  const input = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [tab, setTab] = useState<Tab>("matched");
  const [overwrite, setOverwrite] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (open) {
      setPhase({ kind: "pick" });
      setTab("matched");
      setOverwrite(new Set());
    }
  }, [open]);
  const importId = phase.kind === "processing" ? phase.importId : null;
  const status = useQuery({
    queryKey: ["price-import", orgId, importId],
    enabled: Boolean(importId),
    queryFn: () => api.getLibraryImport(orgId, importId!),
    refetchInterval: (q) => {
      const s = (q.state.data as LibraryImport | undefined)?.status;
      return s === "succeeded" || s === "failed" || s === "rejected" ? false : 400;
    },
  });
  const im = phase.kind === "processing" ? status.data : undefined;
  const report: PriceImportReport | null = im?.status === "succeeded" ? (im.result?.prices ?? null) : null;
  // descriptions for the review (the report carries codes / ids only)
  const library = useLibraryItems(orgId, {});
  const byId = useMemo(() => new Map((library.data?.items ?? []).map((i) => [i.id, i.description])), [library.data]);
  const rows = useMemo(() => (report ? reviewRows(report, (id) => (id ? (byId.get(id) ?? null) : null)) : null), [report, byId]);
  useEffect(() => {
    if (rows && rows.matched.length === 0 && rows.conflicts.length > 0) setTab("conflicts");
  }, [rows]);

  const start = async (file: File) => {
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".xls") && !lower.endsWith(".xlsx")) return setPhase({ kind: "pick", error: t("library.importBadType") });
    if (file.size > MAX_BYTES) return setPhase({ kind: "pick", error: t("library.importTooBig") });
    try {
      setPhase({ kind: "uploading", pct: 0, name: file.name });
      const slot = await api.createLibraryImport(orgId, { filename: file.name, sizeBytes: file.size, mode: "prices", overwriteManualPrices: false, dryRun: true });
      const h = uploads.start(slot.storagePath, file, slot.contentType, (sent, total) => setPhase({ kind: "uploading", pct: Math.round((sent / Math.max(total, 1)) * 100), name: file.name }));
      await h.done;
      const started = await api.startLibraryImport(orgId, slot.importId, slot.uploadToken);
      setPhase({ kind: "processing", importId: started.id, name: file.name });
    } catch (e) {
      setPhase({ kind: "pick", error: t("library.importFailed", { message: (e as Error).message }) });
    }
  };
  const counts = report ? importApplyCounts(report, overwrite) : null;
  const toApply = counts ? counts.fill + counts.overwrite : 0;
  const manualIds = rows ? rows.conflicts.flatMap((r) => (r.reason === "manual_price" && r.itemId ? [r.itemId] : [])) : [];
  const tabs: { id: Tab; label: string }[] = rows
    ? [
        { id: "matched", label: t("prices.import.tabMatched", { count: rows.matched.length }) },
        { id: "conflicts", label: t("prices.import.tabConflicts", { count: rows.conflicts.length }) },
        { id: "unmatched", label: t("prices.import.tabUnmatched", { count: rows.unmatched.length }) },
      ]
    : [];
  const setChoice = (itemId: string, use: boolean) =>
    setOverwrite((s) => {
      const n = new Set(s);
      if (use) n.add(itemId);
      else n.delete(itemId);
      return n;
    });
  const empty = !rows || rows.matched.length + rows.conflicts.length + rows.unmatched.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[5vh] max-h-[90vh] max-w-3xl overflow-y-auto" data-price-import>
        <DialogHeader>
          <DialogTitle>{report ? t("prices.import.reviewTitle") : t("prices.import.title")}</DialogTitle>
          <DialogDescription>{t("prices.import.body")}</DialogDescription>
        </DialogHeader>

        {phase.kind === "pick" ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col items-center gap-3 rounded-md border-2 border-dashed border-input px-6 py-8 text-center">
              <FileSpreadsheet className="size-9 text-primary" aria-hidden />
              <p className="text-body text-foreground">{t("library.importDrop")}</p>
              <Button variant="secondary" onClick={() => input.current?.click()}>
                <Upload aria-hidden />
                {t("library.importPick")}
              </Button>
              <input
                ref={input}
                type="file"
                accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="sr-only"
                aria-label={t("prices.import.open")}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void start(f);
                }}
              />
            </div>
            {phase.error ? <p role="alert" className="text-dense text-destructive">{phase.error}</p> : null}
          </div>
        ) : phase.kind === "done" ? (
          <div role="status" className="flex flex-col gap-2 text-body" data-price-import-done>
            <p className="flex items-center gap-2 font-bold text-foreground">
              <CheckCircle2 className="size-5 text-conf-high" aria-hidden />
              {t("prices.import.done")}
            </p>
            <ul className="flex flex-col gap-1 ps-7 text-foreground">
              <li>{t("prices.import.doneApplied", { count: phase.applied })}</li>
              {phase.overwritten ? <li>{t("prices.import.doneOverwritten", { count: phase.overwritten })}</li> : null}
              {phase.kept ? <li>{t("prices.import.doneKept", { count: phase.kept })}</li> : null}
            </ul>
          </div>
        ) : phase.kind === "uploading" || !im || im.status === "queued" || im.status === "running" || im.status === "uploaded" ? (
          <div role="status" className="flex flex-col gap-2">
            <p className="flex items-center gap-2 text-body text-foreground">
              <FileSpreadsheet className="size-4 text-primary" aria-hidden />
              <bdi className="truncate">{phase.name}</bdi>
            </p>
            <Progress value={phase.kind === "uploading" ? phase.pct : (im?.progress ?? 0)} aria-label={phase.name} />
            <p className="text-meta text-muted-foreground">
              {phase.kind === "uploading" ? t("library.importUploading", { pct: phase.pct }) : t("library.importProcessing", { pct: im?.progress ?? 0 })}
            </p>
          </div>
        ) : im.status !== "succeeded" ? (
          <p role="alert" className="flex items-start gap-2 text-body text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {t("library.importFailed", { message: im.error?.message ?? "" })}
          </p>
        ) : empty || !rows || !report ? (
          <p role="status" className="text-body text-foreground">{report?.unchanged ? t("prices.import.unchanged", { count: report.unchanged }) : t("prices.import.nothing")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div role="status">
              <ul className="grid gap-1 text-dense text-foreground sm:grid-cols-2" data-price-review-summary>
                <li className="flex items-center gap-1.5">
                  <CheckCircle2 className="size-4 text-conf-high" aria-hidden />
                  {t("prices.import.matched", { count: rows.matched.length })}
                </li>
                <li className="flex items-center gap-1.5">
                  <AlertTriangle className="size-4 text-conf-mid" aria-hidden />
                  {t("prices.import.conflicts", { count: manualIds.length })}
                </li>
                {counts?.other ? <li className="text-muted-foreground">{t("prices.import.otherConflicts", { count: counts.other })}</li> : null}
                <li className="flex items-center gap-1.5 text-muted-foreground">
                  <span aria-hidden>◇</span>
                  {t("prices.import.unmatched", { count: report.unmatched })}
                </li>
                {report.unchanged ? <li className="text-muted-foreground">{t("prices.import.unchanged", { count: report.unchanged })}</li> : null}
              </ul>
            </div>
            <div role="tablist" aria-label={t("prices.import.tabsLabel")} className="flex flex-wrap gap-1 border-b border-border">
              {tabs.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  role="tab"
                  id={`pi-tab-${x.id}`}
                  aria-selected={tab === x.id}
                  aria-controls="pi-panel"
                  tabIndex={tab === x.id ? 0 : -1}
                  onClick={() => setTab(x.id)}
                  className={cn(
                    "relative px-3 pb-2 pt-1 text-dense font-medium text-muted-foreground hover:text-foreground",
                    tab === x.id && "text-foreground after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary",
                  )}
                >
                  {x.label}
                </button>
              ))}
            </div>
            <div role="tabpanel" id="pi-panel" aria-labelledby={`pi-tab-${tab}`} className="flex flex-col gap-2">
              {tab === "conflicts" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="flex-1 text-meta text-muted-foreground">{t("prices.import.conflictsHint")}</p>
                  {manualIds.length > 1 ? (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setOverwrite(new Set())}>
                        {t("prices.import.keepAll")}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setOverwrite(new Set(manualIds))}>
                        {t("prices.import.useFileAll")}
                      </Button>
                    </>
                  ) : null}
                </div>
              ) : tab === "unmatched" ? (
                <p className="text-meta text-muted-foreground">{t("prices.import.unmatchedHint")}</p>
              ) : null}
              <ReviewTable rows={rows[tab]} tab={tab} overwrite={overwrite} onChoice={setChoice} />
              {tab === "unmatched" && report.unmatched > rows.unmatched.length ? (
                <p className="text-meta text-muted-foreground">{t("prices.import.moreRows", { count: report.unmatched - rows.unmatched.length })}</p>
              ) : null}
            </div>
          </div>
        )}

        <DialogFooter>
          {report?.dryRun && phase.kind === "processing" ? (
            <Button
              disabled={toApply === 0 || apply.isPending}
              data-apply-prices
              onClick={() =>
                apply.mutate(
                  { importId: phase.importId, req: { overwriteItemIds: [...overwrite] } },
                  {
                    onSuccess: (r) => setPhase({ kind: "done", applied: r.applied, overwritten: r.overwritten, kept: r.kept }),
                    onError: (e) => toast({ title: e instanceof Error && /[֐-׿]/.test(e.message) ? e.message : t("prices.import.error"), tone: "error" }),
                  },
                )
              }
            >
              {apply.isPending ? t("prices.import.applying") : t("prices.import.apply", { count: toApply })}
            </Button>
          ) : null}
          {phase.kind === "done" || (im && im.status !== "queued" && im.status !== "running" && im.status !== "uploaded") ? (
            <Button variant="secondary" onClick={() => setPhase({ kind: "pick" })}>
              {t("library.importAnother")}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("library.importClose")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReviewTable({ rows, tab, overwrite, onChoice }: { rows: ReviewRow[]; tab: Tab; overwrite: ReadonlySet<string>; onChoice: (itemId: string, use: boolean) => void }) {
  const { t } = useTranslation();
  if (!rows.length) return null;
  return (
    <div className="max-h-[45vh] overflow-auto rounded-md border border-border">
      <table className="w-full border-collapse text-dense" data-review-tab={tab}>
        <caption className="sr-only">{t("prices.import.reviewTitle")}</caption>
        <thead className="sticky top-0 bg-surface-sunken">
          <tr className="h-8 text-meta text-muted-foreground">
            <th scope="col" className="w-16 px-2 text-start font-medium">{t("prices.import.colCode")}</th>
            <th scope="col" className="px-2 text-start font-medium">{t("prices.import.colDesc")}</th>
            {tab !== "unmatched" ? <th scope="col" className="w-28 px-2 text-end font-medium">{t("prices.import.colCurrent")}</th> : null}
            <th scope="col" className="w-28 px-2 text-end font-medium">{t("prices.import.colFile")}</th>
            {tab === "conflicts" ? <th scope="col" className="w-56 px-2 text-start font-medium">{t("prices.import.colChoice")}</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const use = Boolean(r.itemId && overwrite.has(r.itemId));
            return (
              <tr key={r.key} data-review-row={r.code} className="border-t border-border align-top">
                <td className="px-2 py-1.5 font-mono text-meta">
                  <Ltr>{r.code}</Ltr>
                </td>
                <td className="px-2 py-1.5 text-foreground">
                  <span className="line-clamp-2">{r.description ?? "—"}</span>
                </td>
                {tab !== "unmatched" ? (
                  <td className="px-2 py-1.5 text-end tabular text-muted-foreground">
                    {r.current != null ? (
                      <span className={cn(r.currentManual && "text-manual")}>
                        {r.currentManual ? "✎ " : null}
                        <Ltr>{formatMoney(r.current)}</Ltr>
                      </span>
                    ) : (
                      t("prices.import.none")
                    )}
                  </td>
                ) : null}
                <td className="px-2 py-1.5 text-end font-medium tabular text-foreground">
                  <Ltr>{formatMoney(r.incoming)}</Ltr>
                </td>
                {tab === "conflicts" ? (
                  <td className="px-2 py-1.5">
                    {r.reason === "manual_price" && r.itemId ? (
                      <fieldset className="flex flex-col gap-0.5" data-conflict={r.itemId}>
                        <legend className="sr-only">{t("prices.import.choiceFor", { code: r.code })}</legend>
                        <label className="inline-flex cursor-pointer items-center gap-1.5 text-meta text-foreground">
                          <input type="radio" name={`c-${r.itemId}`} checked={!use} onChange={() => onChoice(r.itemId!, false)} className="size-3.5 accent-[rgb(var(--primary))]" />
                          {t("prices.import.keep")}
                        </label>
                        <label className="inline-flex cursor-pointer items-center gap-1.5 text-meta text-foreground">
                          <input type="radio" name={`c-${r.itemId}`} checked={use} onChange={() => onChoice(r.itemId!, true)} className="size-3.5 accent-[rgb(var(--primary))]" />
                          {t("prices.import.useFile")}
                        </label>
                      </fieldset>
                    ) : (
                      <span className="text-meta text-muted-foreground" data-conflict-reason={r.reason}>
                        {t(`prices.import.reason.${r.reason ?? "ambiguous_item"}`)}
                      </span>
                    )}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
