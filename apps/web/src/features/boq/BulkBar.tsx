import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, Eye, X } from "lucide-react";
import type { BoqLine, BoqLineStatus, Role } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/Kbd";
import { bulkPlan, roleCanReach, skipCounts } from "./model";
import { lineNeedsInput } from "./sprint6";

export type BulkTarget = Extract<BoqLineStatus, "reviewed" | "approved">;

/**
 * Bulk status bar (owner feedback: "a way to approve everything at once"): shown while BOQ lines are checked.
 * "סמן כנבדק (N)" / "אשר (N)" are role-aware (hidden when the role can never reach the status, the count is what the
 * server is expected to move). Red lines are left out unless "כולל N שורות אדומות" is ticked, with a warning.
 */
export function BulkBar({
  lines,
  role,
  includeRed,
  onIncludeRed,
  onRun,
  onClear,
  pending,
}: {
  lines: readonly BoqLine[];
  role: Role | null | undefined;
  includeRed: boolean;
  onIncludeRed: (v: boolean) => void;
  onRun: (to: BulkTarget) => void;
  onClear: () => void;
  pending: boolean;
}) {
  const { t } = useTranslation();
  if (!lines.length) return null;
  // red lines the opt-in would actually add (lines still "להשלמה ידנית" are never marked, red or not)
  const reds = lines.filter((l) => l.level === "red" && l.status !== "approved" && !lineNeedsInput(l)).length;
  const review = bulkPlan(lines, "reviewed", role, includeRed).eligible.length;
  const approve = bulkPlan(lines, "approved", role, includeRed).eligible.length;
  return (
    <div
      role="region"
      aria-label={t("boq.bulk.region")}
      data-bulk-bar
      className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-primary/30 bg-primary/[0.06] px-3 py-2 text-dense"
    >
      <span className="font-medium text-foreground">{t("boq.bulk.selected", { count: lines.length })}</span>
      {roleCanReach(role, "reviewed") ? (
        <Button size="sm" variant="secondary" disabled={pending || review === 0} onClick={() => onRun("reviewed")}>
          <Eye aria-hidden />
          {t("boq.bulk.markReviewed", { count: review })}
        </Button>
      ) : null}
      {roleCanReach(role, "approved") ? (
        <Button size="sm" disabled={pending || approve === 0} onClick={() => onRun("approved")} aria-keyshortcuts="Shift+A">
          <Check aria-hidden />
          {t("boq.bulk.approve", { count: approve })}
          <Kbd className="border-primary-foreground/40 bg-transparent text-primary-foreground">⇧A</Kbd>
        </Button>
      ) : null}
      {reds ? (
        <label className="inline-flex items-center gap-1 text-foreground" data-include-red>
          <input
            type="checkbox"
            checked={includeRed}
            onChange={(e) => onIncludeRed(e.target.checked)}
            className="size-3.5 accent-[rgb(var(--conf-low))]"
          />
          {t("boq.bulk.includeRed", { count: reds })}
        </label>
      ) : null}
      <Button size="sm" variant="ghost" className="ms-auto" onClick={onClear}>
        <X aria-hidden />
        {t("boq.bulk.clear")}
      </Button>
      {includeRed && reds ? (
        <p role="note" className="flex w-full items-center gap-1.5 text-meta text-foreground">
          <AlertTriangle className="size-3.5 shrink-0 text-conf-low" aria-hidden />
          {t("boq.bulk.redWarning", { count: reds })}
        </p>
      ) : null}
    </div>
  );
}

/** "לאשר 23 שורות?" — states the count, what is left out and (with red lines) the warning. Enter confirms. */
export function BulkConfirmDialog({
  open,
  onOpenChange,
  to,
  lines,
  role,
  includeRed,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  to: BulkTarget;
  lines: readonly BoqLine[];
  role: Role | null | undefined;
  includeRed: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const plan = bulkPlan(lines, to, role, includeRed);
  const reds = plan.eligible.filter((l) => l.level === "red").length;
  const skip = skipCounts(plan.skipped);
  const parts = skipList(t, skip, to);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onConfirm();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t(to === "approved" ? "boq.bulk.confirmApprove" : "boq.bulk.confirmReview", { count: plan.eligible.length })}</DialogTitle>
            <DialogDescription>{t("boq.bulk.confirmBody")}</DialogDescription>
          </DialogHeader>
          {parts.length ? <p className="text-dense text-muted-foreground">{t("boq.bulk.willSkip", { list: parts })}</p> : null}
          {reds ? (
            <p role="alert" className="mt-3 flex items-start gap-2 rounded-md border border-conf-low/40 bg-conf-low/[0.08] p-2.5 text-dense text-foreground">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-conf-low" aria-hidden />
              {t("boq.bulk.confirmRed", { count: reds })}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              {t("boq.bulk.cancel")}
            </Button>
            <Button type="submit" autoFocus disabled={!plan.eligible.length}>
              {t(to === "approved" ? "boq.bulk.doApprove" : "boq.bulk.doReview", { count: plan.eligible.length })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "2 אדומות, 2 כבר אושרו" — skip reasons in a fixed order (the summary toast and the confirm dialog). */
export function skipList(t: (k: string, o?: Record<string, unknown>) => string, counts: Record<string, number>, to: BoqLineStatus): string {
  const order = ["red", "already", "needs_input", "forbidden", "invalid_transition", "not_found"];
  const keys = [...order.filter((k) => counts[k]), ...Object.keys(counts).filter((k) => !order.includes(k))];
  return keys
    .map((k) =>
      k === "already"
        ? t(`boq.bulk.skipAlready.${to === "approved" ? "approved" : "reviewed"}`, { count: counts[k] })
        : t(`boq.bulk.skip.${k}`, { count: counts[k], defaultValue: `${counts[k]} ${k}` }),
    )
    .join(", ");
}
