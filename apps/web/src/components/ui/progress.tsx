import * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import { cn } from "@/lib/utils";

/**
 * Fills from the inline-start edge, i.e. right→left in RTL (spec §כללי RTL "פס התקדמות מתמלא מימין לשמאל").
 * We size the indicator by width + logical alignment instead of translateX so it mirrors automatically.
 */
export const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & { indicatorClassName?: string }
>(({ className, value, indicatorClassName, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    value={value}
    className={cn("relative flex h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className={cn("h-full rounded-full bg-primary transition-[width] duration-200", indicatorClassName)}
      style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }}
    />
  </ProgressPrimitive.Root>
));
Progress.displayName = "Progress";
