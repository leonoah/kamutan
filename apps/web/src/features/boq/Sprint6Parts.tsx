import { useTranslation } from "react-i18next";
import { CheckCheck, Hand, Lightbulb, PenLine, Ruler, Shapes, SquareDashed, Type, Hash } from "lucide-react";
import type { BoqLine, BoqLineOrigin, BoqQuickAction, BoqQuickActionKind } from "@/api/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Ltr } from "@/components/Ltr";
import { cn } from "@/lib/utils";
import type { Coverage } from "./sprint6";

const ORIGIN_ICON = { detected: Shapes, text: Type, geometry: Ruler, suggested: Lightbulb, manual: PenLine } as const;
const ORIGIN_STYLE: Record<BoqLineOrigin, string> = {
  detected: "border-border bg-surface",
  text: "border-primary/30 bg-primary/[0.06]",
  geometry: "border-primary/30 bg-primary/[0.06]",
  suggested: "border-conf-mid/60 bg-conf-mid/[0.1] border-dashed",
  manual: "border-manual/40 bg-manual/[0.07]",
};
const ICON_COLOUR: Record<BoqLineOrigin, string> = {
  detected: "text-muted-foreground",
  text: "text-primary",
  geometry: "text-primary",
  suggested: "text-conf-mid",
  manual: "text-manual",
};

/**
 * Where a quantity came from: סמלים / כיתוב / מדידה / מוצע / ידני — icon + word (never colour alone, the word is
 * always in `--foreground`), the full explanation on hover. Keyboard users get the same sentence in the receipt.
 */
export function OriginBadge({ origin, className }: { origin: BoqLineOrigin; className?: string }) {
  const { t } = useTranslation();
  const Icon = ORIGIN_ICON[origin];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-origin={origin}
          className={cn("inline-flex h-[18px] shrink-0 items-center gap-0.5 rounded-sm border px-1 text-[11px] leading-none text-foreground", ORIGIN_STYLE[origin], className)}
        >
          <Icon className={cn("size-3 shrink-0", ICON_COLOUR[origin])} aria-hidden />
          <span className="sr-only">{t("boq.originLabel")}: </span>
          {t(`boq.origin.${origin}`)}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-60 p-2 text-meta">
        {t(`boq.originHint.${origin}`)}
      </TooltipContent>
    </Tooltip>
  );
}

/** "להשלמה ידנית": amber tint, dashed outline, a hand icon (the line waits for a person). */
export function NeedsInputChip({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      data-needs-input
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center gap-1 rounded-sm border border-dashed border-conf-low/60 bg-conf-low/[0.08] px-1 text-[11px] font-medium leading-none text-foreground",
        className,
      )}
    >
      <Hand className="size-3 shrink-0 text-conf-low" aria-hidden />
      {t("boq.needsInput")}
    </span>
  );
}

const QUICK_ICON: Record<BoqQuickActionKind, typeof Ruler> = { measure_area: SquareDashed, measure_length: Ruler, count: Hash, confirm: CheckCheck };

/**
 * The line's one-click action ("מדידת שטח" / "מדידת אורך" / "ספירה" / "אישור כמות"). The accessible name starts with
 * the visible text and adds the line code (WCAG 2.5.3).
 */
export function QuickActionButton({
  line,
  action,
  onRun,
  active,
  size = "sm",
  className,
}: {
  line: Pick<BoqLine, "code" | "id">;
  action: BoqQuickAction;
  onRun: () => void;
  active?: boolean;
  size?: "sm" | "xs";
  className?: string;
}) {
  const { t } = useTranslation();
  const Icon = QUICK_ICON[action.kind];
  return (
    <button
      type="button"
      data-quick-action={action.kind}
      data-quick-for={line.id}
      aria-pressed={active ?? undefined}
      onClick={(e) => {
        e.stopPropagation();
        onRun();
      }}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border border-primary/40 bg-surface font-medium text-primary hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary",
        size === "xs" ? "h-6 px-1.5 text-[11px]" : "h-6 px-2 text-meta",
        active && "bg-primary text-primary-foreground hover:bg-primary/90",
        className,
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {t(`boq.quick.${action.kind}`)}{" "}
      <span className="sr-only">{t("boq.quickFor", { code: line.code })}</span>
    </button>
  );
}

/** "12 מתוך 15 סעיפים חושבו מהשרטוט · 3 להשלמה" (chapter header / hub chapter). */
export function CoverageText({ c, className }: { c: Coverage; className?: string }) {
  const { t } = useTranslation();
  return (
    <span data-coverage className={cn("text-meta text-muted-foreground", className)}>
      {t("boq.coverage", { computed: c.computed, total: c.total })}
      {c.needsInput ? (
        <>
          {" · "}
          <span className="font-medium text-foreground">{t("boq.coverageNeeds", { count: c.needsInput })}</span>
        </>
      ) : null}
    </span>
  );
}

/** The quantity cell of a line that still needs input: "—" + "חסרה כמות" (the estimate, if any, struck soft). */
export function MissingQty({ line }: { line: Pick<BoqLine, "qty" | "unit"> }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex flex-col items-end leading-tight" data-missing-qty>
      {line.qty ? (
        <span className="font-bold tabular text-foreground">
          <Ltr>{String(line.qty)}</Ltr>
          <span className="sr-only"> ({t("boq.needsInput")})</span>
        </span>
      ) : (
        <>
          <span aria-hidden className="font-bold text-muted-foreground">
            —
          </span>
          <span className="text-[11px] text-muted-foreground">{t("boq.noQty")}</span>
        </>
      )}
    </span>
  );
}
