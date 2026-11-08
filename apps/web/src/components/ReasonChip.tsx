import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { QTY_CHANGED_REASON, isQtyChangedReason } from "@/api/types";
import { isQualityReason } from "@/features/quality/model";

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
  if (isQualityReason(code)) {
    // Sprint 9: items of a low-quality raster sheet ("איכות קובץ ירודה: רזולוציה נמוכה מדי (כ-30 dpi)") — the
    // short chip + the issue (dpi as an LTR island) and a hint on what it means.
    const detail = code.slice(t("quality.reasonChip").length).replace(/^:\s*/, "");
    return (
      <span
        data-reason="INPUT_QUALITY"
        title={`${code}. ${t("quality.reasonHint")}`}
        className={cn("inline-flex h-5 max-w-full items-center gap-1 rounded-sm border border-conf-mid/60 bg-conf-mid/[0.08] px-1.5 text-meta text-foreground", className)}
      >
        <span className="shrink-0">{t("quality.reasonChip")}</span>
        {detail ? <span className="truncate text-muted-foreground">· {detail}</span> : null}
      </span>
    );
  }
  if (isQtyChangedReason(code)) {
    // Stage 10: an approved line dropped to "נבדק" because its quantity changed. "(15 → 16)" is an LTR island so the
    // arrow reads from the old to the new value in RTL too.
    const change = code.slice(QTY_CHANGED_REASON.length).trim();
    return (
      <span
        data-reason="QTY_CHANGED_SINCE_APPROVAL"
        title={`${code}. ${t("reasonHints.QTY_CHANGED_SINCE_APPROVAL")}`}
        className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-conf-mid/60 bg-conf-mid/[0.08] px-1.5 text-meta text-foreground", className)}
      >
        {/* compact so the numbers survive in a narrow BOQ row; the full sentence is the tooltip */}
        <span className="truncate">
          {t("reasons.QTY_CHANGED_SHORT")}
          <span className="sr-only">{QTY_CHANGED_REASON.slice(t("reasons.QTY_CHANGED_SHORT").length)}</span>
        </span>
        {change ? <bdi dir="ltr" className="shrink-0">{change}</bdi> : null}
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
