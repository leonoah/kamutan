import { useTranslation } from "react-i18next";
import { ChevronDown, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfidenceShape } from "@/components/ConfidenceBadge";
import { cn } from "@/lib/utils";
import { EMPTY_FILTERS, LEVEL_KEYS, isFiltered, uiLevel, type LevelKey, type OverlayFilters } from "@/features/understanding/model";

export interface FilterOption {
  value: string;
  label: string;
}

const ALL = "__all";

function FilterMenu({ name, value, options, onChange }: { name: string; value: string | null; options: FilterOption[]; onChange: (v: string | null) => void }) {
  const { t } = useTranslation();
  const current = options.find((o) => o.value === value)?.label ?? t("understanding.all");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={options.length === 0}
        className={cn(
          "inline-flex h-7 max-w-56 items-center gap-1 rounded-sm border px-2 text-foreground hover:bg-muted disabled:opacity-50",
          value ? "border-primary bg-primary/[0.06]" : "border-input bg-surface",
        )}
      >
        <span className="truncate">{t("understanding.filterValue", { name, value: current })}</span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[60vh] overflow-auto">
        <DropdownMenuRadioGroup value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? null : v)}>
          <DropdownMenuRadioItem value={ALL}>{t("understanding.all")}</DropdownMenuRadioItem>
          {options.map((o) => (
            <DropdownMenuRadioItem key={o.value} value={o.value}>
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Filter row of S10 (spec §סינון): תחום / קומה / חדר / ביטחון. Applies to the counts list, the drawing and the
 * queue together; state lives in the URL so a filtered view can be shared.
 */
export function FilterBar({
  filters,
  onChange,
  domains,
  floors,
  rooms,
  levelCounts,
}: {
  filters: OverlayFilters;
  onChange: (f: OverlayFilters) => void;
  domains: FilterOption[];
  floors: FilterOption[];
  rooms: FilterOption[];
  levelCounts: Record<LevelKey, number>;
}) {
  const { t } = useTranslation();
  const toggleLevel = (k: LevelKey) => {
    const has = filters.levels.includes(k);
    onChange({ ...filters, levels: has ? filters.levels.filter((l) => l !== k) : LEVEL_KEYS.filter((l) => l === k || filters.levels.includes(l)) });
  };
  return (
    <div role="toolbar" aria-label={t("review.filters")} className="flex h-11 shrink-0 items-center gap-2 overflow-x-auto border-b border-border bg-surface px-4 text-dense">
      <span className="text-muted-foreground">{t("review.filters")}:</span>
      <FilterMenu name={t("understanding.filterDomain")} value={filters.domains[0] ?? null} options={domains} onChange={(v) => onChange({ ...filters, domains: v ? [v] : [] })} />
      <FilterMenu name={t("understanding.filterFloor")} value={filters.floor} options={floors} onChange={(v) => onChange({ ...filters, floor: v, room: null })} />
      <FilterMenu name={t("understanding.filterRoom")} value={filters.room} options={rooms} onChange={(v) => onChange({ ...filters, room: v })} />
      <div role="group" aria-label={t("review.filterConfidence")} className="flex items-center gap-1 rounded-sm border border-input p-0.5">
        {LEVEL_KEYS.map((k) => {
          const on = filters.levels.includes(k);
          return (
            <button
              key={k}
              type="button"
              aria-pressed={on}
              onClick={() => toggleLevel(k)}
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-sm px-1.5",
                on ? "bg-muted text-foreground" : "text-muted-foreground line-through decoration-1 opacity-70",
              )}
            >
              <ConfidenceShape level={uiLevel(k)} className="size-2.5" />
              {t("understanding.levelCount", { label: t(`confidence.${uiLevel(k)}`), count: levelCounts[k] })}
            </button>
          );
        })}
      </div>
      {isFiltered(filters) ? (
        <button
          type="button"
          onClick={() => onChange(EMPTY_FILTERS)}
          className="ms-auto inline-flex h-7 shrink-0 items-center gap-1 rounded-sm px-2 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
          {t("review.clear")}
        </button>
      ) : null}
    </div>
  );
}
