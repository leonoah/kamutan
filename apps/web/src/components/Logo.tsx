import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/** Wordmark: three "rows" (a BOQ) with one verified dot. Logos are not mirrored in RTL. */
export function Logo({ className, withText = true }: { className?: string; withText?: boolean }) {
  const { t } = useTranslation();
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <svg viewBox="0 0 32 32" className="size-7 shrink-0" aria-hidden focusable="false">
        <rect width="32" height="32" rx="7" fill="rgb(var(--primary))" />
        <path d="M9 10h14M9 16h14M9 22h8" stroke="rgb(var(--primary-foreground))" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="22.5" cy="22" r="2.5" fill="rgb(var(--conf-high))" />
      </svg>
      {withText ? <span className="text-[19px] font-bold tracking-tight text-foreground">{t("app.name")}</span> : null}
    </span>
  );
}
