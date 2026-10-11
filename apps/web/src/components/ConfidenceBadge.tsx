import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * Confidence language (docs/spec/05_ux.md §מצבי ביטחון): every level is shown as
 * COLOR + SHAPE + WORD together, never color alone (WCAG 1.4.1).
 *   high    ● מאומת      mid ▲ סביר      low ◆ לבדיקה
 *   unknown ◇ לא מוכר    manual ✎ אושר ידנית
 */
export type ConfidenceLevel = "high" | "mid" | "low" | "unknown" | "manual";

/** DB enum (`level`: green|yellow|red) → UI level. */
export function levelFromDb(level: "green" | "yellow" | "red"): ConfidenceLevel {
  return level === "green" ? "high" : level === "yellow" ? "mid" : "low";
}

export const CONFIDENCE_GLYPH: Record<ConfidenceLevel, string> = {
  high: "●",
  mid: "▲",
  low: "◆",
  unknown: "◇",
  manual: "✎",
};

const colorClass: Record<ConfidenceLevel, string> = {
  high: "text-conf-high",
  mid: "text-conf-mid",
  low: "text-conf-low",
  unknown: "text-conf-unknown",
  manual: "text-manual",
};

const tintClass: Record<ConfidenceLevel, string> = {
  high: "border-conf-high/35 bg-conf-high/[0.07]",
  mid: "border-conf-mid/40 bg-conf-mid/[0.08]",
  low: "border-conf-low/40 bg-conf-low/[0.07]",
  unknown: "border-conf-unknown/35 bg-conf-unknown/[0.07]",
  manual: "border-manual/35 bg-manual/[0.07]",
};

/** Shapes are SVG (not font glyphs) so they render identically across OS fonts. */
export function ConfidenceShape({ level, className }: { level: ConfidenceLevel; className?: string }) {
  const common = {
    viewBox: "0 0 12 12",
    "aria-hidden": true as const,
    focusable: "false" as const,
    "data-shape": level,
    className: cn("inline-block shrink-0", colorClass[level], className),
  };
  switch (level) {
    case "high":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="5" fill="currentColor" />
          <path d="M3.6 6.2l1.6 1.6 3.2-3.4" fill="none" stroke="rgb(var(--surface))" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "mid":
      return (
        <svg {...common}>
          <path d="M6 1.2 11 10.6H1z" fill="currentColor" />
        </svg>
      );
    case "low":
      return (
        <svg {...common}>
          <path d="M6 .8 11.2 6 6 11.2.8 6z" fill="currentColor" />
          <path d="M6 3.4v3.2" stroke="rgb(var(--surface))" strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="6" cy="8.4" r=".8" fill="rgb(var(--surface))" />
        </svg>
      );
    case "unknown":
      return (
        <svg {...common}>
          <path d="M6 1.2 10.8 6 6 10.8 1.2 6z" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case "manual":
      return (
        <svg {...common}>
          <path d="M2 10l.6-2.6L8 2l2 2-5.4 5.4z" fill="currentColor" />
        </svg>
      );
  }
}

export interface ConfidenceBadgeProps {
  level: ConfidenceLevel;
  /** Calibrated score 0–1. Shown only in the tooltip/title, never as a percentage (spec). */
  score?: number;
  size?: "sm" | "md";
  /** "badge" = pill with word; "indicator" = 24px table column (shape visible, word for screen readers). */
  variant?: "badge" | "indicator";
  className?: string;
}

export function ConfidenceBadge({ level, score, size = "md", variant = "badge", className }: ConfidenceBadgeProps) {
  const { t } = useTranslation();
  const label = t(`confidence.${level}`);
  const scoreText = score !== undefined ? `${t("confidence.score", { score: score.toFixed(2) })} · ${label}` : undefined;

  if (variant === "indicator") {
    return (
      <span
        className={cn("inline-flex size-6 items-center justify-center", className)}
        title={scoreText ?? label}
        data-level={level}
      >
        <ConfidenceShape level={level} className={size === "sm" ? "size-2.5" : "size-3"} />
        <span className="sr-only">{label}</span>
      </span>
    );
  }

  return (
    <span
      data-level={level}
      title={scoreText}
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border font-medium leading-none",
        // Word is in --foreground, not the level color: #B26B00 (סביר) is only 4.2:1 on white,
        // below 4.5:1 for small text. The shape carries the color (≥3:1 for graphics).
        "text-foreground",
        tintClass[level],
        size === "sm" ? "h-5 px-1.5 text-meta" : "h-6 px-2 text-dense",
        className,
      )}
    >
      <ConfidenceShape level={level} className={size === "sm" ? "size-2.5" : "size-3"} />
      {label}
    </span>
  );
}
