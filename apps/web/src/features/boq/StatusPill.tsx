import { useTranslation } from "react-i18next";
import { Check, CircleDashed, Eye } from "lucide-react";
import type { BoqLineStatus } from "@/api/types";
import { cn } from "@/lib/utils";

const STYLE: Record<BoqLineStatus, string> = {
  draft: "border-input bg-surface text-muted-foreground",
  reviewed: "border-primary/35 bg-primary/[0.08] text-foreground",
  approved: "border-conf-high/40 bg-conf-high/[0.1] text-foreground",
};
const ICON = { draft: CircleDashed, reviewed: Eye, approved: Check } as const;

/** טיוטה / נבדק / אושר — icon + word (never colour alone). */
export function StatusPill({ status, compact, className }: { status: BoqLineStatus; compact?: boolean; className?: string }) {
  const { t } = useTranslation();
  const Icon = ICON[status];
  const label = t(`boq.status.${status}`);
  return (
    <span
      data-status={status}
      title={compact ? label : undefined}
      className={cn(
        "inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full border text-meta font-medium",
        compact ? "w-5 justify-center" : "px-1.5",
        STYLE[status],
        className,
      )}
    >
      <Icon className={cn("size-3 shrink-0", status === "approved" ? "text-conf-high" : status === "reviewed" ? "text-primary" : "")} aria-hidden />
      {compact ? <span className="sr-only">{label}</span> : label}
    </span>
  );
}
