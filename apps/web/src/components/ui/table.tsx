import * as React from "react";
import { cn } from "@/lib/utils";

export const Table = React.forwardRef<HTMLTableElement, React.TableHTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <div className="relative w-full overflow-x-auto">
      <table ref={ref} className={cn("w-full caption-bottom border-collapse text-body", className)} {...props} />
    </div>
  ),
);
Table.displayName = "Table";

export const TableHeader = (p: React.HTMLAttributes<HTMLTableSectionElement>) => (
  <thead {...p} className={cn("bg-surface-sunken", p.className)} />
);
export const TableBody = (p: React.HTMLAttributes<HTMLTableSectionElement>) => (
  <tbody {...p} className={cn("[&_tr:last-child]:border-0", p.className)} />
);
export const TableRow = ({ className, ...p }: React.HTMLAttributes<HTMLTableRowElement>) => (
  <tr className={cn("h-12 border-b border-border transition-colors", className)} {...p} />
);
export const TableHead = ({ className, ...p }: React.ThHTMLAttributes<HTMLTableCellElement>) => (
  <th
    className={cn("h-9 px-3 text-start align-middle text-meta font-medium text-muted-foreground", className)}
    {...p}
  />
);
export const TableCell = ({ className, ...p }: React.TdHTMLAttributes<HTMLTableCellElement>) => (
  <td className={cn("px-3 align-middle", className)} {...p} />
);
export const TableCaption = ({ className, ...p }: React.HTMLAttributes<HTMLTableCaptionElement>) => (
  <caption className={cn("sr-only", className)} {...p} />
);
