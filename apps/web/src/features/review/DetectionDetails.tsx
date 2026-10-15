import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { Detection, LegendArtifactEntry, Room } from "@/api/types";
import { ConfidenceBadge } from "@/components/ConfidenceBadge";
import { ReasonChip } from "@/components/ReasonChip";
import { Ltr } from "@/components/Ltr";
import { levelKeyOf, uiLevel } from "@/features/understanding/model";
import { className } from "@/features/understanding/taxonomy";

export interface DetectionContext {
  room: Room | null;
  legendEntry: LegendArtifactEntry | null;
  legendThumb: string | null;
}

/**
 * Item card (spec §השרטוט "ריחוף על פריט" + click popover): class (Hebrew), legend row + crop, confidence as
 * shape + word + score ("ביטחון 0.83 · סביר"), reason chips, room, floor, lifecycle, annotations ("2X", "H=30").
 */
export function DetectionDetails({ d, ctx, onClose, compact = false }: { d: Detection; ctx: DetectionContext; onClose?: () => void; compact?: boolean }) {
  const { t } = useTranslation();
  const level = d.manual ? "manual" : uiLevel(levelKeyOf(d));
  const name = className(d.class, t("understanding.unknownClass"));
  const roomName = ctx.room ? (ctx.room.name ?? t("understanding.unnamedRoom")) : t("understanding.noRoom");
  const floor = d.floor ? t(`floors.${d.floor}`, { defaultValue: d.floor }) : "—";

  if (compact) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <ConfidenceBadge level={level} size="sm" />
          <span className="font-medium text-foreground">{name}</span>
        </div>
        <span className="text-meta text-muted-foreground">
          {roomName} · {floor}
        </span>
        {d.reasons.length ? (
          <div className="flex flex-wrap gap-1">
            {d.reasons.slice(0, 2).map((r) => (
              <ReasonChip key={r} code={r} />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5 text-dense" data-detection={d.id}>
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="text-body font-bold text-foreground">{name}</h3>
          <div className="flex flex-wrap items-center gap-2">
            <ConfidenceBadge level={level} size="sm" />
            <span className="text-meta text-muted-foreground">
              {t("understanding.score", { score: d.score.toFixed(2) })}
            </span>
          </div>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label={t("understanding.detailsClose")}
            className="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        ) : null}
      </div>

      {ctx.legendEntry ? (
        <div className="flex items-center gap-2 rounded-sm border border-border bg-surface-sunken p-1.5">
          {ctx.legendThumb ? (
            <img src={ctx.legendThumb} alt="" className="h-10 w-24 shrink-0 rounded-sm border border-border bg-white object-contain" />
          ) : null}
          <div className="flex min-w-0 flex-col">
            <span className="text-meta text-muted-foreground">{t("understanding.legendRow")}</span>
            <span className="truncate text-foreground" title={ctx.legendEntry.label}>
              {ctx.legendEntry.label || "—"}
            </span>
          </div>
        </div>
      ) : null}

      {d.reasons.length ? (
        <div className="flex flex-col gap-1">
          <span className="text-meta text-muted-foreground">{t("understanding.reasons")}</span>
          <div className="flex flex-wrap gap-1">
            {d.reasons.map((r) => (
              <ReasonChip key={r} code={r} />
            ))}
          </div>
        </div>
      ) : null}

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">{t("understanding.room")}</dt>
        <dd className="text-foreground">{roomName}</dd>
        <dt className="text-muted-foreground">{t("understanding.floor")}</dt>
        <dd className="text-foreground">{floor}</dd>
        <dt className="text-muted-foreground">{t("understanding.lifecycle")}</dt>
        <dd className="text-foreground">{t(`understanding.lifecycleValue.${d.lifecycle}`)}</dd>
        {d.annotations.length ? (
          <>
            <dt className="text-muted-foreground">{t("understanding.annotations")}</dt>
            <dd className="flex flex-wrap gap-1">
              {d.annotations.map((a) => (
                <Ltr key={a} className="rounded-sm border border-border px-1 text-meta text-foreground">
                  {a}
                </Ltr>
              ))}
            </dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}
