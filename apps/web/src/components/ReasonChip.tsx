import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * Reason → plain Hebrew chip (spec §צ'יפים של סיבות). Known codes (NOT_IN_LEGEND…) are translated; Sprint-2
 * artifacts already carry Hebrew chip text, shown verbatim (never fed to i18next as a key: ":" / "." in free
 * text would be parsed as namespace / nesting).
 */
const CODE = /^[A-Z][A-Z0-9_]*$/;
/** Sprint 5: the worker writes "כיול שמרני: אין מספיק נתוני אמת לסוג זה" — chip "כיול שמרני", the rest as the hint. */
const CONSERVATIVE = /^כיול שמרני(?::\s*(.*))?$/;
export function ReasonChip({ code, className }: { code: string; className?: string }) {
  const { t } = useTranslation();
  const cons = code === "CONSERVATIVE_CALIBRATION" ? [code, null] : CONSERVATIVE.exec(code);
  if (cons) {
    return (
      <span
        data-reason="CONSERVATIVE_CALIBRATION"
        title={cons[1] ?? t("reasonHints.CONSERVATIVE_CALIBRATION")}
        className={cn(
          "inline-flex h-5 items-center rounded-sm border border-dashed border-conf-mid/60 bg-surface-sunken px-1.5 text-meta text-muted-foreground",
          className,
        )}
      >
        {t("reasons.CONSERVATIVE_CALIBRATION")}
      </span>
    );
  }
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
