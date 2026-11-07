import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { History, RotateCcw } from "lucide-react";
import type { BoqLine } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import { Ltr } from "@/components/Ltr";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { effectiveQty, fmtQty } from "@/features/boq/model";
import { lineNeedsInput } from "@/features/boq/sprint6";
import type { BoqTotals } from "@/api/types";
import { useCurrentOrg } from "@/features/org/useCurrentOrg";
import { useLibraryItems } from "@/features/boq/queries";
import { effectivePrice, formatMoney, formatMoneyDelta, formatPct, isPriceOverridden, lineTotal, parseMoney, round2 } from "./model";
import { useLinePrice } from "./queries";

/** "ללא מחיר": dashed chip (shape + word, never colour alone); the hint says why it counts 0. */
export function UnpricedChip({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      data-unpriced
      title={t("prices.noPriceHint")}
      className={cn("inline-flex h-[18px] shrink-0 items-center gap-0.5 whitespace-nowrap rounded-sm border border-dashed border-muted-foreground/60 px-1 text-[11px] leading-none text-foreground", className)}
    >
      <span aria-hidden>₪?</span> {t("prices.noPrice")}
    </span>
  );
}

/** "✎ ידני" next to a line's own unit price. */
export function ManualPriceMarker({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span data-manual-price className={cn("inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-[11px] font-medium leading-none text-manual", className)}>
      <span aria-hidden>✎</span> {t("prices.manual")}
    </span>
  );
}

/**
 * Unit price cell of a BOQ row: the effective price (+ "✎ ידני", the list price struck through) or "ללא מחיר"; a
 * button for editors (opens the override dialog), plain text otherwise. Its accessible name holds the visible text.
 */
export function PriceCell({ line: l, canEdit, onEdit, compact = false }: { line: BoqLine; canEdit: boolean; onEdit: (l: BoqLine) => void; compact?: boolean }) {
  const { t } = useTranslation();
  const p = effectivePrice(l);
  const over = isPriceOverridden(l);
  const body = (
    <>
      {p === null ? (
        <UnpricedChip />
      ) : (
        <span className={cn("tabular", compact ? "text-[11px] text-muted-foreground" : "text-foreground", over && "text-manual")}>
          {compact ? <span aria-hidden>× </span> : null}
          <Ltr>{formatMoney(p)}</Ltr>
        </span>
      )}
      {over ? <ManualPriceMarker /> : null}
    </>
  );
  if (!canEdit)
    return (
      <span className="inline-flex flex-col items-end leading-tight" data-price-cell={l.id}>
        {body}
      </span>
    );
  return (
    <button
      type="button"
      data-price-cell={l.id}
      onClick={(e) => {
        e.stopPropagation();
        onEdit(l);
      }}
      className="inline-flex flex-col items-end rounded-sm px-1 leading-tight hover:bg-primary/10"
    >
      {body}
      <span className="sr-only"> — {t("prices.editPriceFor", { code: l.code })}</span>
    </button>
  );
}

/** Line total cell (qty × price): empty while there is no price or no quantity. */
export function LineTotalCell({ line: l }: { line: BoqLine }) {
  const total = lineTotal(l);
  return <span className="tabular font-medium text-foreground" data-line-total={l.id}>{total === null ? <span aria-hidden className="text-muted-foreground">·</span> : <Ltr>{formatMoney(total)}</Ltr>}</span>;
}

/**
 * Totals block: subtotal → discount / markup → before VAT → VAT → after VAT (+ "N שורות ללא מחיר נספרות 0").
 * A `<dl>` so screen readers read label → amount pairs.
 */
export function TotalsSummary({ totals: x, className, filtered = false, compact = false }: { totals: BoqTotals; className?: string; filtered?: boolean; compact?: boolean }) {
  const { t } = useTranslation();
  const row = (k: string, label: string, amount: string, strong = false) => (
    <div key={k} className={cn("flex items-baseline justify-between gap-3", strong && "font-bold")} data-total={k}>
      <dt className={strong ? "text-foreground" : "text-muted-foreground"}>{label}</dt>
      <dd className="tabular text-foreground">
        <Ltr>{amount}</Ltr>
      </dd>
    </div>
  );
  return (
    <section aria-label={t("prices.totals.title")} className={cn("flex flex-col gap-1", compact ? "text-meta" : "text-dense", className)} data-totals>
      <dl className="flex flex-col gap-0.5">
        {x.adjustmentPct ? row("subtotal", t("prices.totals.subtotal"), formatMoney(x.linesTotal)) : null}
        {x.adjustmentPct
          ? row("adjustment", t(x.adjustmentPct < 0 ? "prices.totals.discount" : "prices.totals.markup", { pct: formatPct(Math.abs(x.adjustmentPct)) }), formatMoneyDelta(x.adjustment))
          : null}
        {row("beforeVat", t("prices.totals.beforeVat"), formatMoney(x.beforeVat), true)}
        {row("vat", t("prices.totals.vat", { pct: formatPct(round2(x.vatRate * 100)) }), formatMoney(x.vat))}
        {row("afterVat", t("prices.totals.afterVat"), formatMoney(x.afterVat), true)}
      </dl>
      {x.pricedLines === 0 && x.unpricedLines > 0 ? (
        <p className="text-meta text-muted-foreground" data-unpriced-note>
          {t("prices.totals.allUnpriced")}
        </p>
      ) : x.unpricedLines > 0 ? (
        <p className="text-meta text-muted-foreground" data-unpriced-note>
          {t("prices.totals.unpricedNote", { count: x.unpricedLines })}
        </p>
      ) : null}
      {filtered ? <p className="text-meta text-muted-foreground">{t("prices.totals.filtered")}</p> : null}
    </section>
  );
}

/**
 * The line's own unit price (S10 / hub): number (≥ 0, 2 decimals, "₪" and thousands separators tolerated), optional
 * reason, "חזרה למחיר המחירון" when overridden, link to the line's history. One toast on save.
 */
export function PriceOverrideDialog({
  projectId,
  line,
  onClose,
  onHistory,
}: {
  projectId: string;
  line: BoqLine | null;
  onClose: () => void;
  onHistory?: ((l: BoqLine) => void) | undefined;
}) {
  const { t } = useTranslation();
  const save = useLinePrice(projectId);
  const priceId = useId();
  const reasonId = useId();
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!line) return;
    const p = effectivePrice(line);
    setValue(p === null ? "" : p.toFixed(2));
    setReason(line.priceOverrideReason ?? "");
    setTouched(false);
  }, [line]);
  // the line carries only its EFFECTIVE price: the org library price of the code comes from the library list
  const { org } = useCurrentOrg();
  const lib = useLibraryItems(org?.id ?? "", line ? { q: line.code } : {});
  const listPrice = (() => {
    const xs = (lib.data?.items ?? []).filter((i) => line && i.code === line.code && i.active && i.price);
    xs.sort((a, b) => (b.price?.updatedAt ?? "").localeCompare(a.price?.updatedAt ?? ""));
    return xs[0]?.price?.amount ?? null;
  })();
  const amount = parseMoney(value);
  const invalid = amount === null || Number.isNaN(amount);
  const over = line ? isPriceOverridden(line) : false;
  const run = (lineId: string, code: string, a: number | null) =>
    save.mutate(
      { lineId, amount: a, reason: reason.trim() || null },
      {
        onSuccess: () => toast({ title: a === null ? t("prices.override.restored", { code }) : t("prices.override.saved", { code, price: formatMoney(a) }), tone: "success" }),
        onError: () => toast({ title: t("prices.override.error"), tone: "error" }),
      },
    );

  return (
    <Dialog open={line !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" data-price-dialog>
        {line ? (
          <form
            noValidate
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              setTouched(true);
              if (invalid) return;
              run(line.id, line.code, amount);
              onClose();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {t("prices.override.title", { code: "" })}
                <Ltr>{line.code}</Ltr>
              </DialogTitle>
              <DialogDescription>{t("prices.override.body")}</DialogDescription>
            </DialogHeader>
            <p className="line-clamp-2 text-dense text-foreground">{line.descriptionOverride ?? line.description}</p>
            <p className="text-meta text-muted-foreground">
              {listPrice !== null ? t("prices.override.listPrice", { price: formatMoney(listPrice) }) : lib.isLoading ? "\u00a0" : t("prices.override.noListPrice")}
            </p>
            {over && line.priceOverrideAt ? (
              <p className="text-meta text-manual" data-price-since>
                ✎{" "}
                {line.priceOverrideReason
                  ? t("prices.override.currentBy", { date: formatDate(line.priceOverrideAt), reason: line.priceOverrideReason })
                  : t("prices.override.current", { date: formatDate(line.priceOverrideAt) })}
              </p>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={priceId}>{t("prices.override.label")}</Label>
              <Input
                id={priceId}
                inputMode="decimal"
                dir="ltr"
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                aria-invalid={touched && invalid}
                aria-describedby={touched && invalid ? `${priceId}-e` : undefined}
                className="w-40 text-end tabular"
              />
              {touched && invalid ? (
                <p id={`${priceId}-e`} role="alert" className="text-meta text-destructive">
                  {t("prices.override.invalid")}
                </p>
              ) : !lineNeedsInput(line) && amount !== null && !Number.isNaN(amount) ? (
                <p className="text-meta text-muted-foreground" data-price-preview>
                  <Ltr>{t("prices.override.total", { qty: fmtQty(effectiveQty(line)), price: formatMoney(amount), total: formatMoney(round2(effectiveQty(line) * amount)) })}</Ltr>
                </p>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={reasonId}>{t("prices.override.reason")}</Label>
              <Input id={reasonId} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder={t("prices.override.reasonPlaceholder")} />
            </div>
            <DialogFooter className="flex-wrap gap-2">
              {over ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="me-auto"
                  onClick={() => {
                    run(line.id, line.code, null);
                    onClose();
                  }}
                >
                  <RotateCcw aria-hidden />
                  {t("prices.override.restore")}
                </Button>
              ) : null}
              {onHistory ? (
                <Button
                  type="button"
                  variant="ghost"
                  className={over ? undefined : "me-auto"}
                  onClick={() => {
                    onClose();
                    onHistory(line);
                  }}
                >
                  <History aria-hidden />
                  {t("prices.override.history")}
                </Button>
              ) : null}
              <Button type="button" variant="secondary" onClick={onClose}>
                {t("prices.override.cancel")}
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {t("prices.override.save")}
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
