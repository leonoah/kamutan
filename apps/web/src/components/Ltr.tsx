import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Isolates a Latin/numeric fragment inside Hebrew text so the bidi algorithm never
 * reorders it: item codes ("4.10"), ratings ("16A"), scales ("1:50"), "H=65", file names.
 * Spec 05_ux §כללי RTL. Item codes are always TEXT — never pass them through Number().
 */
export function Ltr({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <bdi dir="ltr" className={cn("tabular", className)}>
      {children}
    </bdi>
  );
}
