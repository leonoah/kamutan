import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";
import { CONSERVATIVE_REASON_CODE, type BoqLine, type CalibrationStats, type SheetRow } from "@/api/types";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ConfidenceShape } from "@/components/ConfidenceBadge";
import { Ltr } from "@/components/Ltr";
import { cn } from "@/lib/utils";

/**
 * Calibration in force: the latest build's (`summary.calibration` / build stats) else the newest version's
 * `stats.calibration`. Until 30 GT projects exist the product runs conservative, so "unknown" is reported as
 * conservative too (honest default — brief §1).
 */
export function resolveCalibration(fromLines: CalibrationStats | null | undefined, rows: readonly SheetRow[] = []): CalibrationStats & { known: boolean } {
  if (fromLines) return { ...fromLines, known: true };
  const v = rows.map((r) => r.version?.stats?.calibration).find(Boolean);
  return v ? { ...v, known: true } : { mode: "conservative", version: "", known: false };
}

export const isConservativeReason = (r: string) => r === CONSERVATIVE_REASON_CODE || r.startsWith("כיול שמרני");

/** Lines whose level was capped by the conservative calibration (they carry its reason). */
export const cappedLines = (lines: readonly BoqLine[]) => lines.filter((l) => (l.reasons ?? []).some(isConservativeReason)).length;

/**
 * Persistent honest badge "כיול שמרני" + explainer popover (copy follows 05_ux "מצבי ביטחון": colour + shape + word,
 * plain Hebrew, no ML terms). Rendered in the review header and the BOQ panel; nothing is shown in full mode.
 */
export function CalibrationBadge({
  calibration,
  greenThreshold,
  capped,
  size = "md",
  className,
}: {
  calibration: CalibrationStats & { known?: boolean };
  greenThreshold?: number | null;
  capped?: number;
  size?: "sm" | "md";
  className?: string;
}) {
  const { t } = useTranslation();
  if (calibration.mode !== "conservative") return null;
  return (
    <Popover>
      <PopoverTrigger
        aria-label={t("calibration.badgeAria")}
        data-calibration="conservative"
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-conf-mid/50 bg-conf-mid/[0.1] font-medium text-foreground hover:bg-conf-mid/[0.18]",
          size === "sm" ? "h-6 px-1.5 text-meta" : "h-7 px-2 text-dense",
          className,
        )}
      >
        <ConfidenceShape level="mid" className="size-2.5" />
        {t("calibration.badge")}
        <Info className="size-3.5 text-muted-foreground" aria-hidden />
      </PopoverTrigger>
      <PopoverContent className="w-[22rem]" aria-label={t("calibration.title")}>
        <div className="flex flex-col gap-2 text-dense">
          <p className="text-body font-bold text-foreground">{t("calibration.title")}</p>
          <p className="text-foreground">{t("calibration.body1")}</p>
          <p className="text-foreground">{t("calibration.body2")}</p>
          <p className="text-muted-foreground">{t("calibration.body3")}</p>
          <p className="rounded-sm bg-surface-sunken p-2 font-medium text-foreground">{t("calibration.meaning")}</p>
          {capped ? <p className="text-foreground">{t("calibration.capped", { count: capped })}</p> : null}
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-meta text-muted-foreground">
            {greenThreshold != null ? (
              <span>
                {t("calibration.threshold", { value: "" })}
                <Ltr>{greenThreshold.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}</Ltr>
              </span>
            ) : null}
            {calibration.version ? (
              <span>
                {t("calibration.version", { version: "" })}
                <Ltr>{calibration.version}</Ltr>
              </span>
            ) : null}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
