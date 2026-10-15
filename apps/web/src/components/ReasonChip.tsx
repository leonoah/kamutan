import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * Reason → plain Hebrew chip (spec §צ'יפים של סיבות). Known codes (NOT_IN_LEGEND…) are translated; Sprint-2
 * artifacts already carry Hebrew chip text, shown verbatim (never fed to i18next as a key: ":" / "." in free
 * text would be parsed as namespace / nesting).
 */
const CODE = /^[A-Z][A-Z0-9_]*$/;
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
      {CODE.test(code) ? t(`reasons.${code}`, { defaultValue: code }) : code}
    </span>
  );
}
