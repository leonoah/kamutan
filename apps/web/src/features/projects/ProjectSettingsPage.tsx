import { useEffect, useId, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronRight, MapPin, Pencil, Percent } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { useCurrentOrg } from "@/features/org/useCurrentOrg";
import { canEditPrices, formatPct, parsePct } from "@/features/prices/model";
import { DeleteProjectSection } from "@/features/deletes/DeleteParts";
import { EditProjectDialog } from "./EditProjectDialog";
import { useProject } from "./queries";
import { useProjectPricing } from "@/features/prices/queries";
import { ApiError } from "@/api/types";

/**
 * Sprint 8 — project settings (`/projects/:id/settings`): details (name / address / archive, the existing dialog),
 * the project's discount / markup % on the BOQ totals, and the admin "אזור מסוכן" (delete the project).
 */
export function ProjectSettingsPage() {
  const { projectId = "" } = useParams();
  const { t } = useTranslation();
  const project = useProject(projectId);
  const { org } = useCurrentOrg();
  const role = org?.role ?? null;
  const [editOpen, setEditOpen] = useState(false);
  if (project.isLoading) return <p role="status" className="mx-auto max-w-3xl px-6 py-10 text-muted-foreground">{t("common.loading")}</p>;
  if (project.isError || !project.data)
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <p role="alert" className="text-body text-foreground">{t("project.notFound")}</p>
        <Link to="/projects" className="mt-3 inline-block text-primary hover:underline">{t("project.back")}</Link>
      </div>
    );
  const p = project.data;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6 sm:px-6" data-project-settings>
      <nav aria-label={t("app.breadcrumbs")}>
        <Link to={`/projects/${p.id}`} className="inline-flex items-center gap-1 rounded text-dense text-muted-foreground hover:text-foreground">
          <ChevronRight className="size-4 ltr:rotate-180" aria-hidden />
          {p.name}
        </Link>
      </nav>
      <h1 className="text-screen text-foreground">{t("projectSettings.title")}</h1>

      <section aria-labelledby="ps-details" className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="ps-details" className="text-panel font-bold text-foreground">{t("projectSettings.details")}</h2>
            <p className="text-dense text-muted-foreground">{t("projectSettings.detailsHint")}</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setEditOpen(true)}>
            <Pencil aria-hidden />
            {t("projectSettings.editDetails")}
          </Button>
        </div>
        <p className="text-body font-medium text-foreground">{p.name}</p>
        {p.address ? (
          <p className="inline-flex items-center gap-1 text-dense text-muted-foreground">
            <MapPin className="size-3.5" aria-hidden />
            {p.address}
          </p>
        ) : null}
      </section>

      <AdjustmentForm projectId={p.id} value={p.pricing?.adjustmentPct ? p.pricing.adjustmentPct : null} canEdit={canEditPrices(role)} />
      <DeleteProjectSection project={p} role={role} />
      <EditProjectDialog open={editOpen} onOpenChange={setEditOpen} project={p} />
    </div>
  );
}

function AdjustmentForm({ projectId, value, canEdit }: { projectId: string; value: number | null; canEdit: boolean }) {
  const { t } = useTranslation();
  const update = useProjectPricing(projectId);
  const id = useId();
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => setText(value === null ? "" : String(value)), [value]);
  const parsed = parsePct(text);
  const bad = parsed !== null && Number.isNaN(parsed);
  const next = parsed === 0 ? null : parsed;
  const dirty = !bad && (next ?? null) !== value;
  return (
    <section aria-labelledby={`${id}-t`} className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-5" data-adjustment-form>
      <h2 id={`${id}-t`} className="flex items-center gap-2 text-panel font-bold text-foreground">
        <Percent className="size-4 text-primary" aria-hidden />
        {t("prices.adjustment.title")}
      </h2>
      <p className="text-dense text-muted-foreground">{t("prices.adjustment.hint")}</p>
      <form
        noValidate
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (bad || !dirty) return;
          update.mutate(
            next,
            {
              onSuccess: () => toast({ title: next === null ? t("prices.adjustment.cleared") : t("prices.adjustment.saved"), tone: "success" }),
              onError: (e) => toast({ title: e instanceof ApiError && e.status === 400 && /[\u0590-\u05FF]/.test(e.message) ? e.message : t("prices.adjustment.error"), tone: "error" }),
            },
          );
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={id} className="text-dense font-medium text-foreground">{t("prices.adjustment.label")}</label>
          <div className="flex items-center gap-2">
            <Input
              id={id}
              dir="ltr"
              inputMode="decimal"
              value={text}
              disabled={!canEdit}
              placeholder="0"
              onChange={(e) => setText(e.target.value)}
              aria-invalid={bad}
              aria-describedby={`${id}-h`}
              className="w-28 text-end tabular"
            />
            <span aria-hidden className="text-body text-muted-foreground">%</span>
          </div>
        </div>
        {canEdit ? (
          <Button type="submit" disabled={bad || !dirty || update.isPending}>
            {t("prices.adjustment.save")}
          </Button>
        ) : null}
      </form>
      <p id={`${id}-h`} className={cn("text-meta", bad ? "text-destructive" : "text-muted-foreground")} role={bad ? "alert" : undefined}>
        {bad ? t("prices.adjustment.invalid") : canEdit ? t("prices.adjustment.example") : t("prices.adjustment.readOnly")}
      </p>
      {value ? (
        <p className="text-dense text-foreground" data-adjustment-current>
          {t(value < 0 ? "prices.totals.discount" : "prices.totals.markup", { pct: formatPct(Math.abs(value)) })}
        </p>
      ) : null}
    </section>
  );
}
