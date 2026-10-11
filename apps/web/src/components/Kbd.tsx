import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Keyboard hint (ShortcutHint). Keys are Latin and always LTR-isolated. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      dir="ltr"
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-input bg-surface px-1 font-mono text-[11px] leading-none text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
