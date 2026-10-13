import { useId } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, CheckCircle2, Layers, Loader2, Scaling } from "lucide-react";
import type { SheetRow } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ConfidenceBadge, ConfidenceShape, levelFromDb } from "@/components/ConfidenceBadge";
import { ReasonChip } from "@/components/ReasonChip";
import { Ltr } from "@/components/Ltr";
import { cn } from "@/lib/utils";
import { useTilesManifest } from "@/features/viewer/tiles";
import { DISCIPLINES, FLOORS, isMultiFloor, missingFields, sheetName, uncertainFields, type SheetDraft } from "./model";

export interface SheetCardProps {
  projectId: string;
  row: SheetRow;
  draft: SheetDraft;
  dirty: boolean;
  busy: boolean;
  onChange: (d: SheetDraft) => void;
  onConfirm: () => void;
  onSplit: () => void;
  onCalibrate: () => void;
}

/** One card of S07 "אישור גיליונות": thumbnail, title, discipline, floors, scale, confidence + reasons. */
export function SheetCard({ projectId, row, draft, dirty, busy, onChange, onConfirm, onSplit, onCalibrate }: SheetCardProps) {
  const { t } = useTranslation();
  const id = useId();
  const name = sheetName(row);
  const v = row.version;
  const status = v?.status ?? "queued";

  if (status !== "ready") {
    const failed = status === "failed";
    const stage = v?.progress?.stage;
    const pct = v?.progress?.pct ?? 0;
    const errCode = v?.error?.code ?? "internal";
    return (
      <article
        aria-label={name}
        data-sheet={row.sheet.id}
        data-status={status}
        className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
      >
        <div className="flex aspect-[4/3] items-center justify-center rounded border border-dashed border-border bg-surface-sunken">
          {failed ? (
            <AlertCircle className="size-6 text-destructive" aria-hidden />
          ) : (
            <Loader2 className="size-6 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
          )}
        </div>
        <h2 className="truncate text-body font-medium text-foreground">
          <bdi>{name}</bdi>
        </h2>
        {failed ? (
          <p role="alert" className="text-dense text-destructive">
            {t(`project.errors.${errCode}`, { defaultValue: t("project.errors.internal") })}
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-dense">
              <span className="text-foreground">{stage ? t(`project.stage.${stage}`) : t("project.versionStatus.queued")}</span>
              <Ltr className="text-meta text-muted-foreground">{`${Math.round(pct)}%`}</Ltr>
            </div>
            <Progress value={pct} aria-label={t("project.sheetProgressLabel", { name, stage: stage ? t(`project.stage.${stage}`) : "" })} />
          </div>
        )}
      </article>
    );
  }

  const c = row.sheet.classification;
  const unsure = uncertainFields(row);
  const missing = new Set(missingFields(draft));
  const multi = isMultiFloor(row, draft);
  const regions = v?.regions ?? [];
  const confirmed = Boolean(row.sheet.confirmed) && !dirty;
  const reasons = (c?.reasons ?? []).filter((r) => r !== "SCALE_FROM_TITLE" && r !== "SCALE_MATCHES_DIMS");
  const scaleSourceOk = c?.reasons.includes("SCALE_MATCHES_DIMS");

  const fieldBox = (key: "discipline" | "floors" | "scale") =>
    cn(
      "rounded border px-2 py-1.5",
      unsure.has(key) && !confirmed ? "border-dashed border-conf-low/70" : "border-transparent",
      missing.has(key) && "border-destructive/60",
    );
  const UnsureMark = ({ k }: { k: "discipline" | "floors" | "scale" }) =>
    unsure.has(k) && !confirmed ? (
      <span title={t("sheets.uncertain")} className="inline-flex">
        <ConfidenceShape level="low" className="size-2.5" />
        <span className="sr-only">{t("sheets.uncertain")}</span>
      </span>
    ) : null;

  return (
    <article
      aria-label={name}
      data-sheet={row.sheet.id}
      data-status={confirmed ? "confirmed" : "ready"}
      className={cn(
        "flex flex-col gap-3 rounded-lg border bg-surface p-4",
        confirmed ? "border-conf-high/40" : "border-border",
      )}
    >
      <Thumb projectId={projectId} row={row} name={name} regionsCount={regions.length} />

      <div className="flex items-start justify-between gap-2">
        <h2 className="min-w-0 text-body font-medium text-foreground">
          <bdi className="line-clamp-2">{name}</bdi>
        </h2>
        {confirmed ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-meta font-medium text-conf-high">
            <CheckCircle2 className="size-3.5" aria-hidden />
            {t("sheets.confirmed")}
          </span>
        ) : c ? (
          <ConfidenceBadge level={levelFromDb(c.level)} score={c.confidence} size="sm" className="shrink-0" />
        ) : null}
      </div>

      {reasons.length > 0 && !confirmed ? (
        <ul aria-label={t("sheets.reasons")} className="flex flex-wrap gap-1">
          {reasons.map((r) => (
            <li key={r}>
              <ReasonChip code={r} />
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-col gap-1">
        {/* Discipline */}
        <div className={fieldBox("discipline")}>
          <label htmlFor={`${id}-d`} className="mb-1 flex items-center gap-1.5 text-meta font-medium text-muted-foreground">
            {t("sheets.discipline")}
            <UnsureMark k="discipline" />
          </label>
          <select
            id={`${id}-d`}
            value={draft.discipline}
            onChange={(e) => onChange({ ...draft, discipline: e.target.value })}
            aria-invalid={missing.has("discipline") || undefined}
            className="h-9 w-full rounded border border-input bg-surface px-2 text-dense text-foreground"
          >
            <option value="">{t("sheets.noDiscipline")}</option>
            {DISCIPLINES.map((d) => (
              <option key={d} value={d}>
                {t(`disciplines.${d}`)}
              </option>
            ))}
          </select>
        </div>

        {/* Floors (multi-select as toggle chips) */}
        <fieldset className={fieldBox("floors")}>
          <legend className="sr-only">{t("sheets.floors")}</legend>
          <div aria-hidden className="mb-1 flex items-center gap-1.5 text-meta font-medium text-muted-foreground">
            {t("sheets.floors")}
            <UnsureMark k="floors" />
          </div>
          <div className="flex flex-wrap gap-1">
            {FLOORS.map((f) => {
              const on = draft.floors.includes(f);
              return (
                <label
                  key={f}
                  className={cn(
                    "inline-flex h-7 cursor-pointer items-center gap-1 rounded-sm border px-2 text-dense",
                    on ? "border-primary bg-primary/10 text-foreground" : "border-input text-muted-foreground hover:bg-muted",
                  )}
                >
                  <input
                    type="checkbox"
                    className="size-3 accent-[rgb(var(--primary))]"
                    checked={on}
                    onChange={() =>
                      onChange({ ...draft, floors: on ? draft.floors.filter((x) => x !== f) : [...draft.floors, f] })
                    }
                  />
                  {t(`floors.${f}`)}
                </label>
              );
            })}
          </div>
        </fieldset>

        {/* Scale */}
        <div className={fieldBox("scale")}>
          <label htmlFor={`${id}-s`} className="mb-1 flex items-center gap-1.5 text-meta font-medium text-muted-foreground">
            {t("sheets.scale")}
            <UnsureMark k="scale" />
          </label>
          <div className="flex items-center gap-2">
            <span dir="ltr" className="inline-flex items-center gap-0.5 text-dense text-foreground">
              <span aria-hidden>1:</span>
              <input
                id={`${id}-s`}
                dir="ltr"
                inputMode="decimal"
                aria-label={t("sheets.scaleInput", { name })}
                aria-invalid={missing.has("scale") || undefined}
                value={draft.scale}
                onChange={(e) => onChange({ ...draft, scale: e.target.value })}
                className="h-8 w-16 rounded border border-input bg-surface px-1.5 text-dense tabular"
              />
            </span>
            {c?.scaleText ? (
              <span className="text-meta text-muted-foreground">
                {t("sheets.scaleSource")} {scaleSourceOk ? <>✓ {t("sheets.scaleMatchesDims")}</> : null}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {multi ? (
        <p className="text-meta text-muted-foreground">
          {regions.length ? t("sheets.regionsCount", { count: regions.length }) : t("sheets.multiFloorNote")}
        </p>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant={confirmed ? "secondary" : "primary"}
          disabled={busy || missing.size > 0 || confirmed}
          onClick={onConfirm}
          aria-label={t("sheets.confirmSheet", { name })}
        >
          {confirmed ? t("sheets.confirmed") : t("sheets.confirm")}
        </Button>
        {multi ? (
          <Button size="sm" variant="secondary" onClick={onSplit}>
            <Layers aria-hidden />
            {t("sheets.split")}
          </Button>
        ) : null}
        {unsure.has("scale") ? (
          <Button size="sm" variant="ghost" onClick={onCalibrate}>
            <Scaling aria-hidden />
            {t("sheets.calibrate")}
          </Button>
        ) : null}
      </div>
    </article>
  );
}

function Thumb({ projectId, row, name, regionsCount }: { projectId: string; row: SheetRow; name: string; regionsCount: number }) {
  const { t } = useTranslation();
  const m = useTilesManifest(projectId, row);
  const src = m.data?.thumbnailUrl;
  return (
    <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden rounded border border-border bg-white">
      {src ? (
        <img src={src} alt={t("sheets.thumbnailAlt", { name })} className="size-full object-contain" loading="lazy" />
      ) : (
        <span className="paper-grid size-full" aria-hidden />
      )}
      {regionsCount > 0 ? (
        <span className="absolute bottom-1.5 start-1.5 rounded-sm bg-surface/90 px-1.5 text-meta text-foreground">
          {t("sheets.regionsCount", { count: regionsCount })}
        </span>
      ) : null}
    </div>
  );
}
