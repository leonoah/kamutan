import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { CLASS_INFO, SYMBOL_CLASS_GROUPS } from "@/features/understanding/taxonomy";

export interface PickerOption {
  value: string;
  label: string;
  hint?: string;
  group: string;
}

/**
 * Combobox in a dialog (spec `E` "שיוך לסעיף": ⌘K-style search, recent first, filtered by the sheet's domain).
 * Arrow keys move, Enter picks, typing filters; the list is a listbox with aria-activedescendant.
 */
export function OptionPicker({
  open,
  onOpenChange,
  title,
  description,
  options,
  recent = [],
  onPick,
  searchLabel,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  options: PickerOption[];
  recent?: string[];
  onPick: (value: string) => void;
  searchLabel: string;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (open) {
      setQ("");
      setI(0);
    }
  }, [open]);
  const shown = useMemo(() => {
    const needle = q.trim();
    const match = (o: PickerOption) => !needle || o.label.includes(needle) || o.value.includes(needle) || (o.hint ?? "").includes(needle);
    const rec = recent
      .map((v) => options.find((o) => o.value === v))
      .filter((o): o is PickerOption => Boolean(o) && match(o!))
      .map((o) => ({ ...o, group: t("tools.pickerRecent") }));
    const recSet = new Set(rec.map((o) => o.value));
    return [...rec, ...options.filter((o) => match(o) && !recSet.has(o.value))];
  }, [q, options, recent, t]);
  const active = shown[Math.min(i, shown.length - 1)];
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${i}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [i]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-4" {...(description ? {} : { "aria-describedby": undefined })}>
        <DialogHeader className="mb-3">
          <DialogTitle className="text-panel">{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={active ? `${listId}-${active.value}` : undefined}
          aria-label={searchLabel}
          placeholder={searchLabel}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setI(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setI((x) => Math.min(x + 1, shown.length - 1));
            else if (e.key === "ArrowUp") setI((x) => Math.max(0, x - 1));
            else if (e.key === "Enter" && active) onPick(active.value);
            else return;
            e.preventDefault();
          }}
          className="h-9 w-full rounded border border-input bg-surface px-2.5 text-body text-foreground"
        />
        <ul ref={listRef} id={listId} role="listbox" aria-label={title} className="mt-2 max-h-[45vh] overflow-auto">
          {shown.length === 0 ? <li className="p-2 text-dense text-muted-foreground">{t("tools.pickerEmpty")}</li> : null}
          {shown.map((o, idx) => {
            const head = idx === 0 || shown[idx - 1]!.group !== o.group;
            return (
              <li key={`${o.group}-${o.value}`} role="presentation">
                {head ? <div className="px-2 pb-0.5 pt-2 text-meta font-medium text-muted-foreground">{o.group}</div> : null}
                <div
                  id={`${listId}-${o.value}`}
                  role="option"
                  data-index={idx}
                  aria-selected={idx === i}
                  onMouseEnter={() => setI(idx)}
                  onClick={() => onPick(o.value)}
                  className={cn(
                    "flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-dense text-foreground",
                    idx === i && "bg-primary/10",
                  )}
                >
                  <span>{o.label}</span>
                  {o.hint ? (
                    <bdi dir="ltr" className="text-meta text-muted-foreground">
                      {o.hint}
                    </bdi>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

/** Symbol classes grouped by domain (the sheet's domain first). */
export function classOptions(t: (k: string, o?: Record<string, unknown>) => string, preferDomain?: string | null): PickerOption[] {
  const groups = [...SYMBOL_CLASS_GROUPS].sort((a, b) => Number(b.domain === preferDomain) - Number(a.domain === preferDomain));
  return groups.flatMap((g) =>
    g.classes.map((c) => ({ value: c, label: CLASS_INFO[c]!.he, group: t(`disciplines.${g.domain}`, { defaultValue: g.domain }) })),
  );
}
