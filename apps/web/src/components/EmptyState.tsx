import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function EmptyState({
  title,
  body,
  action,
  illustration,
  className,
}: {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  illustration?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center gap-3 px-6 py-14 text-center", className)}>
      {illustration}
      <p className="text-panel font-bold text-foreground">{title}</p>
      {body ? <p className="max-w-sm text-body text-muted-foreground">{body}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
