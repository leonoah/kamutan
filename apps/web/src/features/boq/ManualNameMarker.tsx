import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/** "✎ ידני" next to a renamed line's wording (everywhere the description appears). The original is in the tooltip. */
export function ManualNameMarker({ original, className }: { original?: string | null; className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      data-manual-name
      title={original ? t("boq.preview.manualTitle", { original }) : t("boq.preview.manualShort")}
      className={cn("inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-[11px] font-medium leading-none text-manual", className)}
    >
      <span aria-hidden>✎</span> {t("boq.preview.manual")}
      <span className="sr-only"> — {t("boq.preview.manualShort")}</span>
    </span>
  );
}
