import { forwardRef, type SelectHTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { CLASS_INFO, SYMBOL_CLASS_GROUPS } from "./taxonomy";

export interface ClassSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange"> {
  value: string;
  onValueChange: (cls: string) => void;
  placeholder: string;
  /** Extra options at the end (e.g. "לא רלוונטי"). */
  extra?: { value: string; label: string }[];
}

/** Hebrew class picker grouped by domain (native <select>: keyboard + screen-reader friendly, RTL by default). */
export const ClassSelect = forwardRef<HTMLSelectElement, ClassSelectProps>(function ClassSelect(
  { value, onValueChange, placeholder, extra, className, ...rest },
  ref,
) {
  const { t } = useTranslation();
  return (
    <select
      ref={ref}
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
      className={cn("h-9 w-full min-w-0 rounded border border-input bg-surface px-2 text-dense text-foreground disabled:opacity-60", className)}
      {...rest}
    >
      <option value="">{placeholder}</option>
      {SYMBOL_CLASS_GROUPS.map((g) => (
        <optgroup key={g.domain} label={t(`disciplines.${g.domain}`, { defaultValue: g.domain })}>
          {g.classes.map((c) => (
            <option key={c} value={c}>
              {CLASS_INFO[c]!.he}
            </option>
          ))}
        </optgroup>
      ))}
      {extra?.length ? (
        <optgroup label="—">
          {extra.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </optgroup>
      ) : null}
    </select>
  );
});

/** Confidence (0..1) → DB level with the brief's thresholds (green ≥ 0.85, red < 0.5). */
export const levelOfConfidence = (c: number): "green" | "yellow" | "red" => (c >= 0.85 ? "green" : c < 0.5 ? "red" : "yellow");
