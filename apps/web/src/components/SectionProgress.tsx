import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { CONFIDENCE_GLYPH } from "./ConfidenceBadge";

/** Split bar ● ▲ ◆ (spec §התקדמות לפי פרק). Fills from inline-start (right in RTL). */
export function SectionProgress({
  high,
  mid,
  low,
  className,
}: {
  high: number;
  mid: number;
  low: number;
  className?: string;
}) {
  const { t } = useTranslation();
  const total = Math.max(high + mid + low, 1);
  const pct = (n: number) => `${(n / total) * 100}%`;
  const label = `${CONFIDENCE_GLYPH.high} ${high} ${t("confidence.high")} · ${CONFIDENCE_GLYPH.mid} ${mid} ${t(
    "confidence.mid",
  )} · ${CONFIDENCE_GLYPH.low} ${low} ${t("confidence.low")}`;
  return (
    <div role="img" aria-label={label} title={label} className={cn("flex h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      <span className="h-full bg-conf-high" style={{ width: pct(high) }} />
      <span className="h-full bg-conf-mid" style={{ width: pct(mid) }} />
      <span className="h-full bg-conf-low" style={{ width: pct(low) }} />
    </div>
  );
}
