import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useApi } from "@/api/client";
import type { BoqLine, LineHistoryItem } from "@/api/types";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Ltr } from "@/components/Ltr";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { fmtQty } from "@/features/boq/model";

export function useLineHistory(projectId: string, lineId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ["line-history", projectId, lineId],
    queryFn: () => api.getLineHistory(projectId, lineId!),
    enabled: Boolean(lineId),
    staleTime: 0,
  });
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Before / after of one history entry as plain Hebrew (statuses, quantities, notes, correction kinds). */
export function describeChange(item: LineHistoryItem, t: TFunction): { before: string | null; after: string | null; note: string | null } {
  // contracts: status before/after are the raw statuses, qtyOverride number|null, note null (text never stored);
  // the mock sends objects ({status}, {qty, override}, {note}). Both are accepted.
  const b = obj(item.before);
  const a = obj(item.after);
  const status = (v: unknown) => (typeof v === "string" ? t(`boq.status.${v}`, { defaultValue: v }) : null);
  const qty = (v: Record<string, unknown>) => (typeof v.qty === "number" ? fmtQty(v.qty) : typeof v.override === "number" ? fmtQty(v.override) : null);
  const num = (v: unknown) => (typeof v === "number" ? fmtQty(v) : null);
  switch (item.action) {
    case "status":
      return {
        before: typeof item.before === "string" ? status(item.before) : status(b.status),
        after: typeof item.after === "string" ? status(item.after) : status(a.status),
        note: item.reason === "override_reopened" ? t("history.reopened") : null,
      };
    case "qtyOverride":
      if (typeof item.after !== "object" || item.after === null)
        return { before: num(item.before), after: item.after === null ? t("history.overrideCleared") : num(item.after), note: null };
      return {
        before: qty(b),
        after: a.override === null ? `${qty(a) ?? ""} (${t("history.overrideCleared")})` : qty(a),
        note: null,
      };
    case "note":
      return { before: typeof b.note === "string" ? b.note : null, after: typeof a.note === "string" ? a.note : null, note: null };
    case "rebuild":
      return { before: qty(b), after: qty(a), note: null };
    case "correction": {
      const kind = typeof a.kind === "string" ? t(`history.correctionKind.${a.kind}`, { defaultValue: a.kind }) : null;
      return { before: null, after: kind, note: null };
    }
    default:
      return { before: null, after: null, note: null };
  }
}

/**
 * S13 for one BOQ line (FR-26, E2E-11): newest first — what changed (Hebrew action label), before → after, who
 * and when, and the reason (mandatory for a quantity override).
 */
export function LineHistoryDialog({
  projectId,
  line,
  open,
  onOpenChange,
}: {
  projectId: string;
  line: Pick<BoqLine, "id" | "code" | "description"> | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation();
  const q = useLineHistory(projectId, open ? (line?.id ?? null) : null);
  const items = q.data?.items ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t("history.title")} · <Ltr>{line?.code ?? ""}</Ltr>
          </DialogTitle>
          <DialogDescription>{line?.description}</DialogDescription>
        </DialogHeader>
        {q.isError ? (
          <p role="alert" className="text-dense text-destructive">{t("history.loadError")}</p>
        ) : q.isLoading ? (
          <p role="status" className="text-dense text-muted-foreground">{t("common.loading")}</p>
        ) : items.length === 0 ? (
          <p className="text-dense text-muted-foreground">{t("history.empty")}</p>
        ) : (
          <ol className="flex max-h-[60vh] flex-col overflow-y-auto" aria-label={t("history.title")} data-history>
            {items.map((it, i) => {
              const c = describeChange(it, t);
              const who = it.by ? (it.by.displayName ?? t("history.unknownUser")) : t("history.system");
              return (
                <li key={i} data-action={it.action} className="relative flex gap-3 border-b border-border py-2.5 last:border-b-0">
                  <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", it.action === "rebuild" ? "bg-muted-foreground" : it.action === "correction" ? "bg-manual" : "bg-primary")} />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="font-bold text-foreground">{t(`history.action.${it.action}`, { defaultValue: it.action })}</span>
                      <span className="text-meta text-muted-foreground">
                        {who} · <Ltr>{formatDateTime(it.at)}</Ltr>
                      </span>
                    </div>
                    {c.before !== null || c.after !== null ? (
                      <p className="flex flex-wrap items-center gap-x-2 text-dense">
                        {c.before !== null ? (
                          <span>
                            <span className="text-muted-foreground">{t("history.before")}: </span>
                            <s className="tabular text-muted-foreground">{c.before}</s>
                          </span>
                        ) : null}
                        {c.before !== null && c.after !== null ? (
                          <span aria-hidden className="text-muted-foreground">
                            ←
                          </span>
                        ) : null}
                        {c.after !== null ? (
                          <span>
                            <span className="text-muted-foreground">{t("history.after")}: </span>
                            <span className="font-medium tabular text-foreground">{c.after}</span>
                          </span>
                        ) : null}
                      </p>
                    ) : null}
                    {it.reason && it.reason !== "override_reopened" ? (
                      <p className="text-meta text-foreground">
                        <span className="text-muted-foreground">{t("history.reason")}: </span>
                        {it.reason}
                      </p>
                    ) : null}
                    {c.note ? <p className="text-meta text-manual">{c.note}</p> : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}
