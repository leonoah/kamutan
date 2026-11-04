import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/** Brand green of the tape; fixed on purpose so the mark looks the same in light and dark mode. */
const TAPE_GREEN = "#22C55E";

/**
 * Mark: a house with a tape measure inside it, the tape running out through the wall
 * ("we measure the whole building"). Logos are not mirrored in RTL.
 */
export function Logo({ className, withText = true }: { className?: string; withText?: boolean }) {
  const { t } = useTranslation();
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <svg viewBox="0 0 64 64" className="size-7 shrink-0" aria-hidden focusable="false">
        <path
          d="M32 4 61 28v29a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V28Z"
          fill="rgb(var(--primary))"
          stroke="rgb(var(--primary))"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <rect x="13" y="25" width="26" height="26" rx="6" fill="#FFFFFF" />
        <circle cx="26" cy="38" r="6.5" fill="rgb(var(--primary))" />
        <rect x="35" y="39" width="29" height="10" rx="1.5" fill={TAPE_GREEN} />
        <path
          d="M41 39v4M45 39v2.5M49 39v4M53 39v2.5M57 39v4M61 39v2.5"
          stroke="#FFFFFF"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <rect x="61.5" y="37.5" width="2.5" height="13" rx="1" fill="rgb(var(--primary))" />
      </svg>
      {withText ? <span className="text-[19px] font-bold tracking-tight text-foreground">{t("app.name")}</span> : null}
    </span>
  );
}
