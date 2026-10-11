import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const badgeVariants = cva(
  "inline-flex items-center gap-1 whitespace-nowrap rounded-sm border px-1.5 py-0.5 text-meta font-medium leading-none",
  {
    variants: {
      variant: {
        neutral: "border-border bg-muted text-foreground",
        outline: "border-input bg-transparent text-foreground",
        primary: "border-transparent bg-primary/10 text-primary",
        warning: "border-conf-mid/40 bg-conf-mid/10 text-foreground",
        destructive: "border-destructive/40 bg-destructive/10 text-destructive",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
