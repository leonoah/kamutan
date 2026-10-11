import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";

export const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root ref={ref} className={cn("text-dense font-medium text-foreground", className)} {...props} />
));
Label.displayName = "Label";

/** Label + control + hint/error wiring (aria-describedby / aria-invalid handled by caller via ids). */
export function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: React.ReactNode;
  error?: string | null;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-meta text-destructive" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-meta text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
