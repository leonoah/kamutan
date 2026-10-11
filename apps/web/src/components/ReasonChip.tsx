import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/** Reason code → plain Hebrew chip (spec §צ'יפים של סיבות). */
export function ReasonChip({ code, className }: { code: string; className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      data-reason={code}
      className={cn(
        "inline-flex h-5 items-center rounded-sm border border-border bg-surface-sunken px-1.5 text-meta text-muted-foreground",
        className,
      )}
    >
      {t(`reasons.${code}`, { defaultValue: code })}
    </span>
  );
}
